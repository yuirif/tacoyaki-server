// 세션 로그 저장소 — 사용자가 방 채팅 로그를 로비에 백업한 자기완결 HTML 스냅샷(게시판·태그·대표이미지·공개범위).
// 단일 파일 영속(<dataDir>/sessionlogs.json, 원자적 tmp→rename) — 블로그(posts.ts)와 동일 패턴.
//
// 블로그와 다른 점: 본문 HTML 을 화이트리스트로 정규화하지 않는다. 채팅 카드·꾸미기·테마 그래픽을 그대로 보존해야 하므로
// 전체 문서(<style> 포함)를 보관하고, 열람은 클라이언트가 sandbox iframe(스크립트·내비게이션 차단)으로 격리 렌더한다 —
// 저장형 콘텐츠의 보안 경계는 그 sandbox 다. 여기서는 스크립트성 요소만 미리 제거(심층 방어)하고 크기를 캡한다.
// 본문 이미지는 클라이언트가 저장 전 asset 참조로 외부화하므로 본문 자체는 작다(인라인 data 폭주 방지 + 교차 로그 중복제거).
import { readFileSync, writeFileSync, mkdirSync, renameSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { collectAssetRefs as scanAssetRefs } from './assets'

// ===== 한도(작은 서버 보호) =====
const MAX_LOGS_PER_USER = 300
const MAX_BOARDS = 40
const MAX_BOARD_NAME = 40
const MAX_TITLE = 200
// 외부화 후 자기완결 문서 길이 상한. 서버 본문 한도(3MB)에서 token·메타 JSON 오버헤드 여유를 남긴다.
const MAX_HTML = 2_700_000
const MAX_TAGS = 12
const MAX_TAG = 30
const MAX_COVER = 1_400_000 // 대표 이미지 data URL 상한(보통은 asset 참조라 작음)

// 외부 리소스/스크립트를 유발하는 위험 블록 — 여는~닫는째 제거(채팅 그래픽인 <style>·<img> 는 보존).
const DROP_BLOCKS = ['script', 'iframe', 'object', 'embed', 'form', 'noscript']

/** 본문 HTML 경량 방어 — 실제 보안 경계는 열람 측 sandbox iframe + 주입 CSP 지만, 저장형이므로 스크립트/외부로딩 요소를 미리 제거한다.
 *  화이트리스트로 깎지 않는다(채팅 그래픽 보존). 위험 블록·외부 로딩 단일 태그·인라인 핸들러만 제거하고 크기를 캡한다. */
function sanitizeLogHtml(input: unknown): string {
  if (typeof input !== 'string') return ''
  let html = input.slice(0, MAX_HTML)
  // 1) 위험 블록 통째 제거(여는~닫는) + 닫힘 없는 잔여 여는/닫는 태그.
  for (const t of DROP_BLOCKS) {
    html = html.replace(new RegExp(`<${t}\\b[\\s\\S]*?<\\/${t}\\s*>`, 'gi'), '')
    html = html.replace(new RegExp(`<${t}\\b[^>]*>`, 'gi'), '')
    html = html.replace(new RegExp(`<\\/${t}\\s*>`, 'gi'), '')
  }
  // 2) 외부 리소스·리다이렉트 유발 단일 태그 제거 — link(스타일/프리페치)·base(상대경로 하이재킹)·meta http-equiv(refresh 등).
  //    <meta charset> 은 http-equiv 가 없어 보존된다.
  html = html.replace(/<link\b[^>]*>/gi, '')
  html = html.replace(/<base\b[^>]*>/gi, '')
  html = html.replace(/<meta\b[^>]*\bhttp-equiv\b[^>]*>/gi, '')
  // 3) 인라인 이벤트 핸들러 제거(on*=) — 공백뿐 아니라 '/'(태그 경계) 구분자도 차단(<img/onerror=…> 우회 방지).
  html = html.replace(/[\s/]on[a-z]+\s*=\s*("[^"]*"|'[^']*'|[^\s>]+)/gi, '')
  // 4) 외부 리소스 자동 로드 차단(공개 로그의 외부 트래킹 비콘 방지) — 이미지 src·srcset·CSS url()·@import 의 http(s) 무력화.
  //    정상 채팅 본문의 이미지는 외부화로 'asset:<해시>'(http 아님)라 영향 없고, 본문 <a href> 링크는 보존된다.
  //    (열람 측 sandbox iframe + 주입 CSP 와 함께 이중 방어 — CSP meta 의 문서순서 한계를 서버 정규화로 메운다.)
  html = html.replace(/\bsrc\s*=\s*("https?:\/\/[^"]*"|'https?:\/\/[^']*'|https?:\/\/[^\s>]+)/gi, '')
  html = html.replace(/\bsrcset\s*=\s*("[^"]*"|'[^']*'|[^\s>]+)/gi, '')
  html = html.replace(/url\(\s*['"]?\s*https?:\/\/[^)]*\)/gi, 'url()')
  html = html.replace(/@import\b[^;]*;?/gi, '')
  return html.slice(0, MAX_HTML)
}

/** 이미지 src — asset 참조·data:image 만(대표 이미지). 외부 http(s) 는 거부 — 공개 로그 카드/본문이 외부 트래킹 비콘을 싣지 못하게. */
function safeImgUrl(v: string): string | null {
  const s = v.trim()
  if (/^asset:[a-f0-9]{64}$/i.test(s)) return s
  if (/^data:image\/[a-z0-9.+-]+[;,]/i.test(s)) return s.slice(0, MAX_COVER)
  return null
}

// ===== 모델 =====
export interface Board {
  id: string
  name: string
}
export interface SessionLog {
  id: string
  authorId: string
  boardId: string
  tags: string[]
  title: string
  /** 외부화된 자기완결 채팅 로그 HTML(이미지는 asset 참조). */
  html: string
  cover?: string
  visibility: 'public' | 'private'
  createdAt: number
  updatedAt: number
  /** 백업 시점 본문 바이트 근사치(목록 용량 표시용). */
  size: number
}
/** 목록 표시용 요약(본문 제외 — 가벼움). */
export interface SessionLogSummary {
  id: string
  authorId: string
  boardId: string
  tags: string[]
  title: string
  cover?: string
  visibility: 'public' | 'private'
  createdAt: number
  updatedAt: number
  size: number
}
/** 상세(본문 포함) — 열람 측 iframe 으로 렌더. */
export interface SessionLogDetail extends SessionLogSummary {
  html: string
}
/** 작성/수정 입력. id 없으면 새 백업(html 필요), id 있으면 수정 — html 은 보낼 때만 본문 교체(로비 편집기). */
export interface SessionLogInput {
  id?: string
  boardId?: string
  tags?: unknown
  title?: string
  html?: string
  cover?: string
  visibility?: string
}

export type SessionLogSaveResult = { ok: true; log: SessionLogDetail } | { ok: false; error: string }

export interface SessionLogStore {
  /** target 의 로그 목록 + 게시판. viewerId===target 이면 비공개 포함, 아니면 공개만. */
  listFor(viewerId: string | null, targetId: string): { logs: SessionLogSummary[]; boards: Board[] }
  /** 로그 상세 — 비공개는 작성자만. 권한 없으면 null. */
  get(viewerId: string | null, logId: string): { log: SessionLogDetail } | null
  /** 백업 생성(html 필요) 또는 수정(id 소유 — html 은 보낼 때만 본문 교체). */
  save(authorId: string, input: SessionLogInput): SessionLogSaveResult
  /** 삭제(작성자). */
  remove(authorId: string, logId: string): boolean
  /** 게시판 목록 교체(작성자) — 사라진 게시판의 로그는 미분류('')로. */
  setBoards(userId: string, boards: unknown): Board[]
  /** 계정 탈퇴 연쇄 — 그 사용자의 로그·게시판 제거. */
  removeAll(userId: string): void
  /** 관리자 용량 산출 — 그 사용자의 로그·게시판 직렬화 바이트 + 참조 자산 해시(로그 개수 포함). */
  usageFor(userId: string): { count: number; bytes: number; refs: Set<string> }
  /** 멤버 본인 이전 — 그 사용자의 로그·게시판 전체를 깊은 복사로 내보낸다. */
  exportFor(accountId: string): { logs: SessionLog[]; boards: Board[] }
  /** 멤버 본인 이전(가져오기) — 내보낸 로그·게시판을 이 계정 소유로 복원(새 id·본문 재정리). 복원 로그 수 반환. */
  importFor(accountId: string, logs: unknown, boards: unknown): number
  /** 자산 GC 라이브 집합 수집(본문·대표이미지의 'asset:<해시>'). */
  collectAssetRefs(into: Set<string>): void
}

interface PersistShape {
  logs: SessionLog[]
  boards: Record<string, Board[]>
}

/** 태그 배열 정규화 — 트림·중복 제거·길이/개수 캡. */
function sanitizeTags(v: unknown): string[] {
  if (!Array.isArray(v)) return []
  const out: string[] = []
  const seen = new Set<string>()
  for (const t of v) {
    if (typeof t !== 'string') continue
    const tag = t.trim().replace(/^#/, '').slice(0, MAX_TAG)
    if (!tag || seen.has(tag.toLowerCase())) continue
    seen.add(tag.toLowerCase())
    out.push(tag)
    if (out.length >= MAX_TAGS) break
  }
  return out
}

/** 게시판 입력 정규화(이름 필수·id 형식 검증·개수 캡) — 저장·가져오기 공용. */
function normalizeBoards(input: unknown): Board[] {
  const out: Board[] = []
  const seen = new Set<string>()
  if (!Array.isArray(input)) return out
  for (const b of input as Record<string, unknown>[]) {
    if (out.length >= MAX_BOARDS) break
    if (!b || typeof b !== 'object') continue
    const name = typeof b.name === 'string' ? b.name.trim().slice(0, MAX_BOARD_NAME) : ''
    if (!name) continue
    const id = typeof b.id === 'string' && /^[\w-]{1,64}$/.test(b.id) ? b.id : randomUUID()
    if (seen.has(id)) continue
    seen.add(id)
    out.push({ id, name })
  }
  return out
}

/** persist:false 면 인메모리(테스트). dataDir 기본 = <cwd>/data. */
export function createSessionLogStore(opts?: { dataDir?: string; persist?: boolean }): SessionLogStore {
  const persist = opts?.persist !== false
  const dataDir = opts?.dataDir ?? join(process.cwd(), 'data')
  const filePath = join(dataDir, 'sessionlogs.json')

  let logs: SessionLog[] = []
  let boards: Record<string, Board[]> = {}

  if (persist) {
    try {
      if (existsSync(filePath)) {
        const data = JSON.parse(readFileSync(filePath, 'utf8')) as PersistShape
        if (Array.isArray(data.logs)) logs = data.logs
        if (data.boards && typeof data.boards === 'object') boards = data.boards
      }
    } catch (e) {
      console.error('[sessionlogs] sessionlogs.json 로드 실패 — 빈 목록으로 시작:', e)
    }
  }

  function save(): void {
    if (!persist) return
    try {
      mkdirSync(dataDir, { recursive: true })
      const tmp = filePath + '.tmp'
      writeFileSync(tmp, JSON.stringify({ logs, boards }), 'utf8')
      renameSync(tmp, filePath)
    } catch (e) {
      console.error('[sessionlogs] 저장 실패:', e)
    }
  }

  const findLog = (id: string): SessionLog | undefined => logs.find((l) => l.id === id)
  const boardsOf = (userId: string): Board[] => boards[userId] ?? []

  /** viewer 가 로그를 열람할 수 있는지(공개이거나 작성자). */
  const canView = (viewerId: string | null, l: SessionLog): boolean =>
    viewerId === l.authorId || l.visibility === 'public'

  const summarize = (l: SessionLog): SessionLogSummary => ({
    id: l.id,
    authorId: l.authorId,
    boardId: l.boardId,
    tags: l.tags,
    title: l.title,
    cover: l.cover,
    visibility: l.visibility,
    createdAt: l.createdAt,
    updatedAt: l.updatedAt,
    size: l.size
  })
  const detail = (l: SessionLog): SessionLogDetail => ({ ...summarize(l), html: l.html })

  /** 작성자 게시판 목록에 있는 id 만 인정(없으면 미분류). */
  const resolveBoardId = (userId: string, boardId: unknown): string =>
    typeof boardId === 'string' && boardsOf(userId).some((b) => b.id === boardId) ? boardId : ''

  return {
    listFor(viewerId, targetId) {
      if (!targetId) return { logs: [], boards: [] }
      const isOwner = viewerId === targetId
      const list = logs
        .filter((l) => l.authorId === targetId && (isOwner || l.visibility === 'public'))
        .sort((a, b) => b.createdAt - a.createdAt)
        .map(summarize)
      return { logs: list, boards: boardsOf(targetId) }
    },

    get(viewerId, logId) {
      const l = findLog(logId)
      if (!l || !canView(viewerId, l)) return null
      return { log: detail(l) }
    },

    save(authorId, input) {
      if (!authorId) return { ok: false, error: '로그인이 필요합니다.' }
      const title = typeof input.title === 'string' ? input.title.trim().slice(0, MAX_TITLE) : ''
      const tags = sanitizeTags(input.tags)
      const visibility = input.visibility === 'public' ? 'public' : 'private' // 기본 비공개(공유는 명시적 opt-in)
      const cover = typeof input.cover === 'string' && input.cover ? safeImgUrl(input.cover) ?? undefined : undefined
      const boardId = resolveBoardId(authorId, input.boardId)
      const now = Date.now()

      // 수정 — 제목·게시판·태그·대표이미지·공개범위 갱신 + (로비 편집기가 html 을 보내면) 본문도 교체.
      if (input.id) {
        const l = findLog(input.id)
        if (!l) return { ok: false, error: '세션 로그를 찾을 수 없습니다.' }
        if (l.authorId !== authorId) return { ok: false, error: '수정 권한이 없습니다.' }
        // 본문 편집(로비 편집기 — 문구 수정·행 삭제·이미지/꾸밈 삽입). 새 백업과 동일한 새니타이저를
        // 재통과시키고 목록 용량 표시(size)도 재계산한다. html 미포함(메타만 수정)이면 본문 불변.
        if (typeof input.html === 'string') {
          const h = sanitizeLogHtml(input.html)
          if (!h) return { ok: false, error: '본문이 비어 있습니다.' }
          l.html = h
          l.size = h.length
        }
        l.title = title || l.title // 제목을 비우면 기존 제목 유지(무제 백업 방지)
        l.tags = tags
        l.visibility = visibility
        l.cover = cover
        l.boardId = boardId
        l.updatedAt = now
        save()
        return { ok: true, log: detail(l) }
      }

      // 새 백업 — 본문 필요.
      const html = sanitizeLogHtml(input.html)
      if (!html) return { ok: false, error: '백업할 로그 본문이 없습니다.' }

      // 사용자별 보관 상한(초과 시 가장 오래된 본인 로그 제거).
      const mine = logs.filter((l) => l.authorId === authorId)
      if (mine.length >= MAX_LOGS_PER_USER) {
        const oldest = mine.sort((a, b) => a.createdAt - b.createdAt)[0]
        logs = logs.filter((l) => l.id !== oldest.id)
      }
      const log: SessionLog = {
        id: randomUUID(),
        authorId,
        boardId,
        tags,
        title: title || '세션 로그',
        html,
        cover,
        visibility,
        createdAt: now,
        updatedAt: now,
        size: html.length
      }
      logs.push(log)
      save()
      return { ok: true, log: detail(log) }
    },

    remove(authorId, logId) {
      const l = findLog(logId)
      if (!l || l.authorId !== authorId) return false
      logs = logs.filter((x) => x.id !== logId)
      save()
      return true
    },

    setBoards(userId, input) {
      if (!userId) return []
      const out = normalizeBoards(input)
      boards[userId] = out
      // 사라진 게시판을 참조하던 로그는 미분류로.
      const validIds = new Set(out.map((b) => b.id))
      for (const l of logs) {
        if (l.authorId === userId && l.boardId && !validIds.has(l.boardId)) l.boardId = ''
      }
      save()
      return out
    },

    removeAll(userId) {
      if (!userId) return
      let changed = false
      const before = logs.length
      logs = logs.filter((l) => l.authorId !== userId)
      if (logs.length !== before) changed = true
      if (boards[userId]) {
        delete boards[userId]
        changed = true
      }
      if (changed) save()
    },

    usageFor(userId) {
      const mine = logs.filter((l) => l.authorId === userId)
      const payload = { logs: mine, boards: boards[userId] ?? [] }
      const json = JSON.stringify(payload)
      const refs = new Set<string>()
      scanAssetRefs(json, refs)
      return { count: mine.length, bytes: Buffer.byteLength(json, 'utf8'), refs }
    },

    exportFor(accountId) {
      if (!accountId) return { logs: [], boards: [] }
      return {
        logs: logs.filter((l) => l.authorId === accountId).map((l) => ({ ...l, tags: [...l.tags] })),
        boards: boardsOf(accountId).map((b) => ({ ...b }))
      }
    },

    importFor(accountId, inLogs, inBoards) {
      if (!accountId) return 0
      // 게시판 먼저 복원(원본 id 유지 — 로그의 boardId 매칭). 빈 배열로 기존 게시판을 지우지 않게(부분 번들 보호).
      const nb = normalizeBoards(inBoards)
      if (nb.length > 0) boards[accountId] = nb

      let imported = 0
      if (Array.isArray(inLogs)) {
        for (const raw of inLogs as Record<string, unknown>[]) {
          if (logs.filter((l) => l.authorId === accountId).length >= MAX_LOGS_PER_USER) break
          if (!raw || typeof raw !== 'object') continue
          const now = Date.now()
          const html = sanitizeLogHtml(raw.html)
          if (!html) continue
          const log: SessionLog = {
            id: randomUUID(), // 새 id(충돌 회피)
            authorId: accountId, // 가져오는 계정으로 재귀속
            boardId: typeof raw.boardId === 'string' ? raw.boardId.slice(0, 64) : '',
            tags: sanitizeTags(raw.tags),
            title: typeof raw.title === 'string' ? raw.title.slice(0, MAX_TITLE) || '세션 로그' : '세션 로그',
            html,
            cover: typeof raw.cover === 'string' ? (safeImgUrl(raw.cover) ?? undefined) : undefined,
            visibility: raw.visibility === 'public' ? 'public' : 'private',
            createdAt: typeof raw.createdAt === 'number' ? raw.createdAt : now,
            updatedAt: typeof raw.updatedAt === 'number' ? raw.updatedAt : now,
            size: typeof raw.size === 'number' ? raw.size : html.length
          }
          logs.push(log)
          imported++
        }
      }
      save()
      return imported
    },

    collectAssetRefs(into) {
      scanAssetRefs(JSON.stringify(logs), into)
    }
  }
}
