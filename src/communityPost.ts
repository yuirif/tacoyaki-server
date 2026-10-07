// 커뮤니티 글·댓글·신고 저장소.
//
// 영속 구조가 이 파일의 핵심이다. 하나의 큰 파일에 전부 담고 매번 다시 쓰면, 좋아요 한 번에
// 저장소 전체를 재직렬화하게 되어 이벤트 루프가 멈춘다. 그래서 두 층으로 나눈다.
//   board/<게시판>.json  목록에 필요한 요약만. 상주하며 목록·검색·자산 참조를 여기서 해결한다.
//   post/<글>.json       본문과 댓글. 그 글을 열 때만 읽고 최근 것만 메모리에 둔다.
// ⚠자산 참조(refs)는 요약에 사본을 둔다 — 자산 GC 수집이 동기이므로 본문 파일을 여는 순간
//   GC 전체를 비동기로 바꿔야 하고, 그 리팩터는 미완성 라이브셋으로 청소가 도는 레이스를 만든다.
import { readFileSync, writeFileSync, mkdirSync, renameSync, existsSync, readdirSync, unlinkSync } from 'node:fs'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { collectAssetRefs as scanAssetRefs } from './assets'
import { htmlToText } from './htmlText'
import { sanitizePostHtml } from './posts'
import { MAIN_CID, isEntityId, stripControl, type Rating, type Result } from './community'

// ===== 한도 =====
const MAX_TITLE = 200
const MAX_HTML = 400_000
const MAX_TAGS = 12
const MAX_TAG = 30
const MAX_CAST = 20
const MAX_GALLERY = 60
/** 링크 칸 하나에 담을 수 있는 주소 수와 각 칸의 길이. 프로필 링크와 같은 한도로 맞춘다. */
const MAX_LINKS = 8
const MAX_LINK_LABEL = 30
const MAX_LINK_URL = 400
const MAX_COMMENTS = 300
const MAX_COMMENT = 2000
const MAX_COMMENT_IMAGES = 4
const MAX_POSTS_PER_BOARD = 5000
const MAX_WARNINGS = 8
/** 한 글이 실어 보낼 수 있는 양식 칸 이름 개수 — 게시판 양식 상한(MAX_FORM_FIELDS)과 같은 크기로 둔다. */
const MAX_FORM_KEYS = 40
const MAX_REPORTS = 1000
const MAX_REPORT_DETAIL = 500
/** 본문 캐시 상한 — 넘으면 오래 안 쓴 것부터 내보낸다(더러운 것은 먼저 저장). */
const BODY_CACHE_MAX = 200
/** 삭제 글 보관 기간. 이 안에는 되살릴 수 있다. */
const TRASH_KEEP_MS = 30 * 24 * 60 * 60 * 1000

/** 링크 칸의 한 줄 — 보일 이름과 주소. 화면은 이 짝을 그대로 <a> 로 그린다. */
export interface FieldLink {
  label: string
  url: string
}

export type Visibility = 'all' | 'member' | 'secret'
export type NoticeLevel = 0 | 1 | 2
export type ThreadStatus = 'recruit' | 'running' | 'closed'

export interface PostBgm {
  kind: 'file' | 'yt'
  /** 파일이면 asset:<해시>, 영상이면 id. */
  src: string
  loop: boolean
  volume: number
}

/** 목록에 필요한 것만. 상주하므로 여기에 본문을 넣지 않는다. */
export interface PostSummary {
  id: string
  boardId: string
  authorId: string
  authorNick: string
  authorAvatar: string
  /** 캐입 — 이 캐릭터로 쓴 글. 없으면 오입. */
  charId: string
  charName: string
  title: string
  excerpt: string
  prefix: string
  tags: string[]
  cast: string[]
  cover: string
  hasBgm: boolean
  rating: Rating
  warnings: string[]
  visibility: Visibility
  notice: NoticeLevel
  status: ThreadStatus | ''
  draft: boolean
  publishAt: number
  views: number
  likeCount: number
  commentCount: number
  /** 본문·댓글·표지·음원이 참조하는 자산(GC 수집용 사본). */
  refs: string[]
  createdAt: number
  updatedAt: number
  deletedAt: number
}

export interface Post extends PostSummary {
  /** 글쓴이가 댓글을 닫았는가. 이미 달린 댓글은 그대로 남고 새 댓글만 막힌다. */
  commentsClosed: boolean
  html: string
  fields: Record<string, unknown>
  gallery: string[]
  bgm: PostBgm | null
  likes: string[]
  deletedBy: string
}

export interface Comment {
  id: string
  postId: string
  authorId: string
  authorNick: string
  authorAvatar: string
  charId: string
  charName: string
  text: string
  images: string[]
  parentId: string
  secret: boolean
  createdAt: number
  updatedAt: number
  deletedAt: number
}

export interface Report {
  id: string
  targetType: 'post' | 'comment'
  targetId: string
  postId: string
  reporterId: string
  reason: 'spam' | 'abuse' | 'rating' | 'copyright' | 'etc'
  detail: string
  status: 'open' | 'resolved' | 'dismissed'
  handledBy: string
  handledAt: number
  note: string
  createdAt: number
}

export interface ListOpts {
  page?: number
  perPage?: number
  prefix?: string
  tag?: string
  authorId?: string
  charId?: string
  /** 제목·태그·작성자·말머리 + 최근 글 본문. */
  q?: string
  includeDrafts?: string
}

export interface ListResult {
  items: PostSummary[]
  notices: PostSummary[]
  page: number
  pages: number
  total: number
}

export interface SaveInput {
  postId?: string
  boardId: string
  title?: unknown
  html?: unknown
  fields?: unknown
  prefix?: unknown
  tags?: unknown
  cast?: unknown
  cover?: unknown
  gallery?: unknown
  bgm?: unknown
  rating?: unknown
  warnings?: unknown
  visibility?: unknown
  status?: unknown
  draft?: unknown
  publishAt?: unknown
  charId?: unknown
  charName?: unknown
  /** 게시판 양식에서 '본문(서식)' 으로 선언된 칸 이름들. 그 칸 값만 새니타이저를 통과시킨다. */
  richFieldKeys?: unknown
  /** 게시판 양식에서 '링크' 로 선언된 칸 이름들. 그 칸 값만 주소 짝의 목록으로 받는다. */
  linkFieldKeys?: unknown
  /** 게시판 양식의 첫 '태그' 칸 이름. 그 칸은 글의 태그 목록(tags)이 맡으므로 fields 에 남기지 않는다. */
  tagsKey?: unknown
  /** 게시판 양식이 지금 쓰는 칸 이름 전부. 양식에서 사라진 칸의 값을 걷는 데 쓴다. */
  formKeys?: unknown
}

/** 게시판 삭제 시 소속 글을 어떻게 할지 — 부르는 쪽이 반드시 정한다. */
export type BoardRemoveMode = 'move' | 'trash' | 'purge'

interface BoardIndex {
  summaries: PostSummary[]
  dirty: boolean
}
interface PostDoc {
  post: Post
  comments: Comment[]
  dirty: boolean
  usedAt: number
}

// ===== 입력 정규화 =====
const ASSET_RE = /^asset:[a-f0-9]{64}$/
const YT_ID_RE = /^[\w-]{6,20}$/
/** 한 줄 값 — 줄바꿈까지 포함해 제어문자를 전부 걷어낸다(제목·태그가 목록 표시를 깨지 않게). */
function line(v: unknown, max: number): string {
  return typeof v === 'string' ? stripControl(v, false).trim().slice(0, max) : ''
}
function assetRef(v: unknown): string {
  return typeof v === 'string' && ASSET_RE.test(v.trim()) ? v.trim() : ''
}
/** 새니타이저를 통과한 본문에서 첫 그림의 자산 참조를 집는다(표지를 안 고른 글의 폴백). */
function firstImageRef(html: string): string {
  const m = /<img[^>]+src="(asset:[a-f0-9]{64})"/i.exec(html)
  return m ? m[1] : ''
}
function num(v: unknown, lo: number, hi: number, def: number): number {
  if (typeof v !== 'number' || !Number.isFinite(v)) return def
  return Math.min(hi, Math.max(lo, Math.round(v)))
}
function bool(v: unknown, def = false): boolean {
  return typeof v === 'boolean' ? v : def
}
function strList(v: unknown, maxLen: number, maxItems: number): string[] {
  if (!Array.isArray(v)) return []
  const out: string[] = []
  for (const raw of v) {
    const s = line(raw, maxLen).replace(/^#/, '')
    if (s && !out.includes(s)) out.push(s)
    if (out.length >= maxItems) break
  }
  return out
}
/** 태그 칸에 남아 있던 값 — 이 칸이 글의 태그를 맡기 전에는 쉼표로 이은 한 줄로 담겼다. */
function tagCell(v: unknown): unknown[] {
  if (Array.isArray(v)) return v
  return typeof v === 'string' ? v.split(',') : []
}
function assetList(v: unknown, maxItems: number): string[] {
  if (!Array.isArray(v)) return []
  const out: string[] = []
  for (const raw of v) {
    const a = assetRef(raw)
    if (a && !out.includes(a)) out.push(a)
    if (out.length >= maxItems) break
  }
  return out
}
function normBgm(v: unknown): PostBgm | null {
  if (!v || typeof v !== 'object') return null
  const r = v as Record<string, unknown>
  const loop = bool(r.loop, true)
  const volume = num(r.volume, 0, 100, 70) / 100
  if (r.kind === 'file') {
    const src = assetRef(r.src)
    return src ? { kind: 'file', src, loop, volume } : null
  }
  if (r.kind === 'yt') {
    const src = line(r.src, 20)
    return YT_ID_RE.test(src) ? { kind: 'yt', src, loop, volume } : null
  }
  return null
}
/**
 * 링크 칸 값 정규화. 주소는 http(s) 만 받는다 — 이 값은 화면에서 <a href> 로 그려지므로
 * javascript: 같은 스킴이 그대로 들어가면 누르는 사람이 위험해진다.
 */
function normLinks(v: unknown): FieldLink[] {
  if (!Array.isArray(v)) return []
  const out: FieldLink[] = []
  for (const raw of v) {
    if (!raw || typeof raw !== 'object') continue
    const o = raw as Record<string, unknown>
    let url = line(o.url, MAX_LINK_URL)
    if (!url) continue
    if (!/^https?:\/\//i.test(url)) {
      // 스킴을 안 적은 주소는 https 로 본다. 그 밖의 스킴은 아예 버린다.
      if (/^[\w.-]+\.[a-z]{2,}/i.test(url)) url = 'https://' + url
      else continue
    }
    const label = line(o.label, MAX_LINK_LABEL)
    out.push({ label: label || url, url })
    if (out.length >= MAX_LINKS) break
  }
  return out
}
function normRating(v: unknown): Rating {
  return v === 'r15' || v === 'r19' ? v : 'all'
}
function normVisibility(v: unknown): Visibility {
  return v === 'member' || v === 'secret' ? v : 'all'
}

/**
 * 글이 실제로 참조하는 자산 해시 — 요약에 사본으로 남겨 GC 가 본문 파일을 열지 않게 한다.
 * ⚠담기는 값은 'asset:' 접두가 없는 해시다(수집기가 그렇게 뽑는다). 쓰는 쪽에서 다시 패턴으로 훑지 말 것.
 */
function refsOf(post: Post, comments: Comment[]): string[] {
  const set = new Set<string>()
  scanAssetRefs(post.html, set)
  scanAssetRefs(JSON.stringify(post.fields), set)
  scanAssetRefs(post.authorAvatar, set)
  for (const g of post.gallery) scanAssetRefs(g, set)
  scanAssetRefs(post.cover, set)
  if (post.bgm?.kind === 'file') scanAssetRefs(post.bgm.src, set)
  for (const c of comments) {
    scanAssetRefs(c.authorAvatar, set)
    for (const im of c.images) scanAssetRefs(im, set)
  }
  return [...set]
}

function toSummary(p: Post): PostSummary {
  const { html: _h, fields: _f, gallery: _g, bgm: _b, likes: _l, deletedBy: _d, ...rest } = p
  return { ...rest }
}

export interface CommunityPostStore {
  list(boardId: string, opts: ListOpts): ListResult
  get(postId: string): { post: Post; comments: Comment[] } | null
  summary(postId: string): PostSummary | null
  save(author: { id: string; nick: string; avatar: string }, input: SaveInput, now: number): Result<Post>
  remove(postId: string, actorId: string, now: number): Result<PostSummary>
  restore(postId: string, actorId: string, ownOnly: boolean): Result<PostSummary>
  trashList(): PostSummary[]
  /** 삭제함 비우기 — 요약과 본문 파일을 함께 없앤다. 목록을 비우면 삭제함 전체. 돌이킬 수 없다. */
  purgeTrash(postIds?: string[]): number
  /**
   * 게시판마다 가장 최근에 올라온 글의 시각.
   * 목록의 ●NEW 는 '내가 마지막으로 본 때'와 이 값을 견줘야 참말이 된다 —
   * 한 번도 안 봤는지만 보면, 다 읽은 게시판에 새 글이 와도 조용하다.
   */
  lastPostAt(now: number): Record<string, number>
  purgeExpired(now: number): number
  setNotice(postId: string, level: NoticeLevel, noticeMax: number): Result<PostSummary>
  setStatus(postId: string, status: ThreadStatus): Result<PostSummary>
  /**
   * 글 하나를 다른 게시판으로 옮긴다(카테고리 변경). 옮긴 뒤의 요약을 돌려준다.
   * 공지는 내려간다 — 게시판마다 공지 자리 수가 따로라, 옮긴 글이 남의 자리를 밀어낼 수 없다.
   */
  move(postId: string, toBoardId: string, now: number): Result<PostSummary>
  /** 글쓴이·운영진이 댓글을 닫거나 다시 연다. 달려 있던 댓글은 건드리지 않는다. */
  setCommentsClosed(postId: string, closed: boolean): Result<Post>
  like(postId: string, accountId: string): Result<{ liked: boolean; count: number }>
  addView(postId: string): void

  comments(postId: string): Comment[]
  addComment(postId: string, author: { id: string; nick: string; avatar: string }, input: unknown, now: number): Result<Comment>
  editComment(commentId: string, postId: string, actorId: string, text: unknown, now: number): Result<Comment>
  removeComment(commentId: string, postId: string, actorId: string, canDeleteAny: boolean, now: number): Result<Comment>

  report(reporterId: string, input: unknown, now: number): Result<Report>
  reports(status?: string): Report[]
  resolveReport(reportId: string, actorId: string, action: 'resolved' | 'dismissed', note: string, now: number): Result<Report>

  /** 게시판이 사라질 때 소속 글 처리 — 이동/보관/삭제 중 하나를 반드시 고른다. */
  boardRemoved(boardId: string, mode: BoardRemoveMode, moveTo: string, now: number): number
  countsFor(accountId: string): { posts: number; comments: number; received: number }

  collectAssetRefs(into: Set<string>): void
  removeAll(accountId: string): void
  usageFor(accountId: string): { bytes: number; refs: Set<string> }
  usage(): { posts: number; bytes: number }
  flush(): void
}

export function createCommunityPostStore(opts?: { dataDir?: string; persist?: boolean }): CommunityPostStore {
  const persist = opts?.persist !== false
  const root = join(opts?.dataDir ?? join(process.cwd(), 'data'), 'community', MAIN_CID)
  const boardDir = join(root, 'board')
  const postDir = join(root, 'post')
  const reportsPath = join(root, 'reports.json')

  const boards = new Map<string, BoardIndex>()
  const bodies = new Map<string, PostDoc>()
  let reports: Report[] = []
  let flushTimer: NodeJS.Timeout | null = null

  if (persist) {
    try {
      if (existsSync(boardDir)) {
        for (const f of readdirSync(boardDir)) {
          if (!f.endsWith('.json')) continue
          const bid = f.slice(0, -5)
          if (!isEntityId(bid)) continue
          const d = JSON.parse(readFileSync(join(boardDir, f), 'utf8')) as { summaries?: PostSummary[] }
          boards.set(bid, { summaries: Array.isArray(d?.summaries) ? d.summaries : [], dirty: false })
        }
      }
      if (existsSync(reportsPath)) {
        const d = JSON.parse(readFileSync(reportsPath, 'utf8'))
        if (Array.isArray(d)) reports = d as Report[]
      }
    } catch (e) {
      console.error('[community/post] 로드 실패. 빈 상태로 시작:', e)
    }
  }

  function writeAtomic(dir: string, path: string, data: string): void {
    if (!persist) return
    try {
      mkdirSync(dir, { recursive: true })
      const tmp = path + '.tmp'
      writeFileSync(tmp, data, 'utf8')
      renameSync(tmp, path)
    } catch (e) {
      console.error('[community/post] 저장 실패:', path, e)
    }
  }

  function idx(boardId: string): BoardIndex {
    let b = boards.get(boardId)
    if (!b) {
      b = { summaries: [], dirty: false }
      boards.set(boardId, b)
    }
    return b
  }

  function saveBoard(boardId: string): void {
    const b = boards.get(boardId)
    if (!b) return
    b.dirty = false
    writeAtomic(boardDir, join(boardDir, `${boardId}.json`), JSON.stringify({ summaries: b.summaries }))
  }

  function savePost(postId: string): void {
    const d = bodies.get(postId)
    if (!d) return
    d.dirty = false
    writeAtomic(postDir, join(postDir, `${postId}.json`), JSON.stringify({ post: d.post, comments: d.comments }))
  }

  function saveReports(): void {
    writeAtomic(root, reportsPath, JSON.stringify(reports))
  }

  /** 목록 인덱스는 갱신이 잦아 뭉쳐서 쓴다. 본문·댓글은 잃으면 안 되므로 바로 쓴다. */
  function markBoard(boardId: string): void {
    idx(boardId).dirty = true
    if (!persist || flushTimer) return
    flushTimer = setTimeout(() => {
      flushTimer = null
      for (const [bid, b] of boards) if (b.dirty) saveBoard(bid)
    }, 8_000)
    flushTimer.unref?.()
  }

  /** 오래 안 쓴 본문을 메모리에서 내보낸다. 더러운 것은 반드시 먼저 저장한다. */
  function evict(): void {
    if (bodies.size <= BODY_CACHE_MAX) return
    const sorted = [...bodies.entries()].sort((a, b) => a[1].usedAt - b[1].usedAt)
    for (const [pid, doc] of sorted.slice(0, bodies.size - BODY_CACHE_MAX)) {
      if (doc.dirty) savePost(pid)
      bodies.delete(pid)
    }
  }

  function loadDoc(postId: string): PostDoc | null {
    if (!isEntityId(postId)) return null
    const hit = bodies.get(postId)
    if (hit) {
      hit.usedAt = Date.now()
      return hit
    }
    if (!persist) return null
    const p = join(postDir, `${postId}.json`)
    if (!existsSync(p)) return null
    try {
      const d = JSON.parse(readFileSync(p, 'utf8')) as { post: Post; comments: Comment[] }
      if (!d?.post) return null
      const doc: PostDoc = { post: d.post, comments: Array.isArray(d.comments) ? d.comments : [], dirty: false, usedAt: Date.now() }
      bodies.set(postId, doc)
      evict()
      return doc
    } catch {
      return null
    }
  }

  /** 요약을 본문 상태에 맞춘다. 요약과 본문이 어긋나면 목록이 거짓말을 하고 자산이 지워진다. */
  function syncSummary(doc: PostDoc): void {
    doc.post.refs = refsOf(doc.post, doc.comments)
    doc.post.commentCount = doc.comments.filter((c) => !c.deletedAt).length
    doc.post.likeCount = doc.post.likes.length
    doc.post.excerpt = htmlToText(doc.post.html, 140)
    const b = idx(doc.post.boardId)
    const s = toSummary(doc.post)
    const i = b.summaries.findIndex((x) => x.id === doc.post.id)
    if (i >= 0) b.summaries[i] = s
    else b.summaries.push(s)
    markBoard(doc.post.boardId)
  }

  function findSummary(postId: string): { board: BoardIndex; s: PostSummary } | null {
    for (const b of boards.values()) {
      const s = b.summaries.find((x) => x.id === postId)
      if (s) return { board: b, s }
    }
    return null
  }

  /** 목록·검색에서 쓰는 정렬 — 공지가 먼저, 그다음 최신순. */
  function byRecent(a: PostSummary, b: PostSummary): number {
    return b.createdAt - a.createdAt
  }

  function matches(s: PostSummary, o: ListOpts, q: string): boolean {
    if (o.prefix && s.prefix !== o.prefix) return false
    if (o.tag && !s.tags.includes(o.tag)) return false
    if (o.authorId && s.authorId !== o.authorId) return false
    if (o.charId && s.charId !== o.charId && !s.cast.includes(o.charId)) return false
    if (!q) return true
    const hay = `${s.title} ${s.prefix} ${s.authorNick} ${s.charName} ${s.tags.join(' ')} ${s.excerpt}`.toLowerCase()
    return hay.includes(q)
  }

  return {
    list(boardId, o) {
      const b = boards.get(boardId)
      const perPage = num(o.perPage, 5, 50, 20)
      const page = num(o.page, 1, 10_000, 1)
      if (!b) return { items: [], notices: [], page: 1, pages: 1, total: 0 }
      const q = line(o.q, 60).toLowerCase()
      const live = b.summaries.filter((s) => {
        if (s.deletedAt) return false
        // 임시저장은 쓴 사람에게만 보인다.
        if (s.draft) return o.includeDrafts === s.authorId
        // 예약 발행 — 시각이 되기 전에는 쓴 사람에게만.
        if (s.publishAt && s.publishAt > Date.now() && o.includeDrafts !== s.authorId) return false
        return true
      })
      const notices = live.filter((s) => s.notice > 0).sort((a, b2) => b2.notice - a.notice || byRecent(a, b2))
      const rest = live.filter((s) => s.notice === 0 && matches(s, o, q)).sort(byRecent)
      const total = rest.length
      const pages = Math.max(1, Math.ceil(total / perPage))
      const p = Math.min(page, pages)
      return { items: rest.slice((p - 1) * perPage, p * perPage), notices, page: p, pages, total }
    },

    get(postId) {
      const doc = loadDoc(postId)
      return doc ? { post: doc.post, comments: doc.comments.slice() } : null
    },

    summary: (postId) => findSummary(postId)?.s ?? null,

    save(author, input, now) {
      const boardId = typeof input.boardId === 'string' ? input.boardId : ''
      if (!isEntityId(boardId)) return { ok: false, error: '게시판이 올바르지 않습니다.' }
      const title = line(input.title, MAX_TITLE)
      if (!title) return { ok: false, error: '제목을 입력해 주세요.' }
      const html = sanitizePostHtml(typeof input.html === 'string' ? input.html.slice(0, MAX_HTML) : '')

      // 수정 권한(내 글인지·남의 글도 되는지)은 라우트가 판정한다. 여기서는 작성자 정보를 덮어쓰지 않는 것만 지킨다.
      let doc = input.postId ? loadDoc(input.postId) : null
      if (input.postId && !doc) return { ok: false, error: '글을 찾을 수 없습니다.' }
      // 임시저장이었다가 이번 저장으로 발행되는지 — 아래에서 draft 를 덮어쓰기 전에 봐 둔다.
      const wasDraft = doc ? doc.post.draft : false
      if (!doc) {
        const b = idx(boardId)
        if (b.summaries.filter((s) => !s.deletedAt).length >= MAX_POSTS_PER_BOARD) {
          return { ok: false, error: `한 게시판에 글은 ${MAX_POSTS_PER_BOARD}개까지입니다.` }
        }
      }

      const post: Post = doc
        ? doc.post
        : {
            id: randomUUID(),
            boardId,
            authorId: author.id,
            authorNick: line(author.nick, 20),
            authorAvatar: assetRef(author.avatar),
            charId: '',
            charName: '',
            title: '',
            excerpt: '',
            prefix: '',
            tags: [],
            cast: [],
            cover: '',
            hasBgm: false,
            rating: 'all',
            warnings: [],
            visibility: 'all',
            notice: 0,
            status: '',
            draft: false,
            publishAt: 0,
            views: 0,
            likeCount: 0,
            commentCount: 0,
            refs: [],
            createdAt: now,
            updatedAt: now,
            deletedAt: 0,
            commentsClosed: false,
            html: '',
            fields: {},
            gallery: [],
            bgm: null,
            likes: [],
            deletedBy: ''
          }

      post.title = title
      // 본문을 아예 안 실어 보낸 요청(메타만 고치는 저장)은 있던 본문을 지우지 않는다.
      // 양식의 본문 칸 이름이 바뀌어 값이 비어 오는 경우가 여기 걸린다 — 안 거르면 전문이 통째로 날아간다.
      if (typeof input.html === 'string') post.html = html
      post.prefix = line(input.prefix, 20)
      post.tags = strList(input.tags, MAX_TAG, MAX_TAGS)
      post.cast = strList(input.cast, 64, MAX_CAST)
      // 표지를 안 골랐으면 본문·모음의 첫 그림을 대신 세운다 — 목록 타일이 빈칸으로 남지 않게.
      // 단 '표지 없음'을 명시해 보냈으면(빈 문자열) 그 뜻을 지킨다 — 안 그러면 지운 표지가 곧바로 되살아난다.
      const wantsCover = typeof input.cover === 'string' ? !!input.cover.trim() : true
      post.cover = wantsCover ? assetRef(input.cover) || firstImageRef(post.html) || assetList(input.gallery, 1)[0] || '' : ''
      post.gallery = assetList(input.gallery, MAX_GALLERY)
      post.bgm = normBgm(input.bgm)
      post.hasBgm = !!post.bgm
      post.rating = normRating(input.rating)
      post.warnings = strList(input.warnings, 20, MAX_WARNINGS)
      post.visibility = normVisibility(input.visibility)
      post.status = input.status === 'recruit' || input.status === 'running' || input.status === 'closed' ? input.status : ''
      post.draft = bool(input.draft)
      post.publishAt = num(input.publishAt, 0, Number.MAX_SAFE_INTEGER, 0)
      post.charId = line(input.charId, 64)
      post.charName = line(input.charName, 40)
      // 구조화 칸은 게시판 양식이 정하므로 여기서는 형태만 지킨다(문자열·문자열 배열·불리언·숫자).
      // 보낸 칸만 덮어쓴다 — 통째로 비우면 양식에서 칸 이름이 바뀌었을 때 예전 값이 영영 사라진다.
      const rich = new Set(strList(input.richFieldKeys, 40, MAX_FORM_KEYS))
      const linkKeys = new Set(strList(input.linkFieldKeys, 40, MAX_FORM_KEYS))
      // 다만 양식에서 아주 빠진 칸은 걷는다. 안 걷으면 화면에 안 보이는 값이 글에 영원히 쌓이고,
      // 그 값이 붙잡은 그림도 자산 회수에서 살아남아 영영 안 지워진다.
      const known = strList(input.formKeys, 40, MAX_FORM_KEYS)
      if (known.length) {
        const keep = new Set([...known, ...Object.keys(input.fields && typeof input.fields === 'object' ? input.fields : {})])
        for (const k of Object.keys(post.fields)) if (!keep.has(k)) delete post.fields[k]
      }
      if (input.fields && typeof input.fields === 'object') {
        for (const [k, v] of Object.entries(input.fields as Record<string, unknown>)) {
          const key = line(k, 40)
          if (!key) continue
          // 링크 칸은 이름·주소 짝의 목록이다. 주소는 여기서 한 번 거른다 — 화면은 이 값을 그대로 눌러 갈 자리로 그린다.
          if (linkKeys.has(key)) {
            post.fields[key] = normLinks(v)
            continue
          }
          // 서식 칸은 본문과 같은 화이트리스트를 거쳐야 한다 — 이 값도 화면에서 HTML 로 그려진다.
          if (typeof v === 'string') post.fields[key] = rich.has(key) ? sanitizePostHtml(v.slice(0, MAX_HTML)) : v.slice(0, 4000)
          else if (typeof v === 'number' || typeof v === 'boolean') post.fields[key] = v
          else if (Array.isArray(v)) post.fields[key] = v.slice(0, 60).map((x) => (typeof x === 'string' ? x.slice(0, 500) : '')).filter(Boolean)
        }
      }
      // 양식의 첫 태그 칸은 글의 태그 목록이 맡는다 — 같은 값을 칸에도 남기면 글에 두 번 보이고,
      // 예전 판에서 글씨로 저장된 값이 그 자리에 유령처럼 남는다.
      const tagsKey = line(input.tagsKey, 40)
      if (tagsKey) {
        // 이 칸이 태그를 맡기 전에 쓴 글은 값이 아직 칸에 있다 — 지우기 전에 태그로 옮긴다.
        if (!post.tags.length) post.tags = strList(tagCell(post.fields[tagsKey]), MAX_TAG, MAX_TAGS)
        delete post.fields[tagsKey]
      }
      // 발행되는 순간이 글이 처음 목록에 서는 때다 — 담아 둔 시각이 남으면 목록·정렬이 전부
      // createdAt 기준이라 새로 낸 글이 옛 날짜 자리로 밀려난다. 발행 글의 일반 재저장은 그대로.
      if (wasDraft && !post.draft) post.createdAt = now
      post.updatedAt = now
      if (!doc) {
        doc = { post, comments: [], dirty: true, usedAt: Date.now() }
        bodies.set(post.id, doc)
        evict()
      } else {
        doc.dirty = true
      }
      syncSummary(doc)
      savePost(post.id)
      return { ok: true, value: post }
    },

    remove(postId, actorId, now) {
      const doc = loadDoc(postId)
      const found = findSummary(postId)
      if (!doc || !found) return { ok: false, error: '글을 찾을 수 없습니다.' }
      if (doc.post.deletedAt) return { ok: false, error: '이미 삭제된 글입니다.' }
      doc.post.deletedAt = now
      doc.post.deletedBy = actorId
      doc.post.notice = 0
      doc.dirty = true
      syncSummary(doc)
      savePost(postId)
      return { ok: true, value: found.s }
    },

    restore(postId, actorId, ownOnly) {
      const doc = loadDoc(postId)
      if (!doc || !doc.post.deletedAt) return { ok: false, error: '되살릴 글이 없습니다.' }
      // 운영진은 자기가 지운 것만 되살린다 — 권한이 한 사람에게 몰리지 않게.
      if (ownOnly && doc.post.deletedBy !== actorId) return { ok: false, error: '직접 삭제한 글만 되살릴 수 있습니다.' }
      doc.post.deletedAt = 0
      doc.post.deletedBy = ''
      doc.dirty = true
      syncSummary(doc)
      savePost(postId)
      return { ok: true, value: toSummary(doc.post) }
    },

    lastPostAt(now) {
      const out: Record<string, number> = {}
      for (const [boardId, idx] of boards) {
        let at = 0
        for (const p of idx.summaries) {
          // 임시저장과 예약된 글은 아직 남에게 보이지 않으므로 세지 않는다.
          if (p.deletedAt || p.draft) continue
          const shown = p.publishAt || p.createdAt
          // 예약된 글은 그때가 오기 전까지 남에게 보이지 않으므로 새 글로 세지 않는다.
          if (shown > now) continue
          if (shown > at) at = shown
        }
        out[boardId] = at
      }
      return out
    },

    trashList() {
      const out: PostSummary[] = []
      for (const b of boards.values()) for (const s of b.summaries) if (s.deletedAt) out.push(s)
      return out.sort((a, b) => b.deletedAt - a.deletedAt)
    },

    purgeTrash(postIds) {
      // 지정한 것만 지운다. 빈 목록이 오면 삭제함에 있는 것 전부.
      const only = postIds && postIds.length ? new Set(postIds) : null
      let n = 0
      for (const [bid, b] of boards) {
        const keep: PostSummary[] = []
        for (const s of b.summaries) {
          if (s.deletedAt && (!only || only.has(s.id))) {
            bodies.delete(s.id)
            if (persist) {
              try {
                unlinkSync(join(postDir, `${s.id}.json`))
              } catch {
                /* 이미 없음 */
              }
            }
            n++
          } else keep.push(s)
        }
        if (keep.length !== b.summaries.length) {
          b.summaries = keep
          saveBoard(bid)
        }
      }
      return n
    },

    purgeExpired(now) {
      let n = 0
      for (const [bid, b] of boards) {
        const keep: PostSummary[] = []
        for (const s of b.summaries) {
          if (s.deletedAt && now - s.deletedAt > TRASH_KEEP_MS) {
            bodies.delete(s.id)
            if (persist) {
              try {
                unlinkSync(join(postDir, `${s.id}.json`))
              } catch {
                /* 이미 없음 */
              }
            }
            n++
          } else keep.push(s)
        }
        if (keep.length !== b.summaries.length) {
          b.summaries = keep
          saveBoard(bid)
        }
      }
      return n
    },

    setNotice(postId, level, noticeMax) {
      const doc = loadDoc(postId)
      if (!doc || doc.post.deletedAt) return { ok: false, error: '글을 찾을 수 없습니다.' }
      const lv = (level === 1 || level === 2 ? level : 0) as NoticeLevel
      if (lv > 0) {
        const b = idx(doc.post.boardId)
        const cur = b.summaries.filter((s) => s.notice > 0 && !s.deletedAt && s.id !== postId).length
        if (cur >= noticeMax) return { ok: false, error: `공지는 ${noticeMax}개까지입니다.` }
      }
      doc.post.notice = lv
      doc.dirty = true
      syncSummary(doc)
      savePost(postId)
      return { ok: true, value: toSummary(doc.post) }
    },

    setStatus(postId, status) {
      const doc = loadDoc(postId)
      if (!doc || doc.post.deletedAt) return { ok: false, error: '글을 찾을 수 없습니다.' }
      doc.post.status = status
      doc.dirty = true
      syncSummary(doc)
      savePost(postId)
      return { ok: true, value: toSummary(doc.post) }
    },

    move(postId, toBoardId, now) {
      const doc = loadDoc(postId)
      if (!doc || doc.post.deletedAt) return { ok: false, error: '글을 찾을 수 없습니다.' }
      const from = doc.post.boardId
      if (!isEntityId(toBoardId)) return { ok: false, error: '게시판이 올바르지 않습니다.' }
      if (from === toBoardId) return { ok: false, error: '이미 그 게시판에 있는 글입니다.' }
      const dest = idx(toBoardId)
      if (dest.summaries.filter((s) => !s.deletedAt).length >= MAX_POSTS_PER_BOARD) {
        return { ok: false, error: `한 게시판에 글은 ${MAX_POSTS_PER_BOARD}개까지입니다.` }
      }
      // 공지는 게시판마다 자리 수가 따로다 — 옮기면서 남의 자리를 밀어내지 않도록 내려 둔다.
      doc.post.notice = 0
      doc.post.boardId = toBoardId
      doc.post.updatedAt = now
      doc.dirty = true
      // 반드시 새 게시판에 먼저 넣고 옛 게시판에서 뺀다. 순서를 뒤집으면 그 사이에 자산 회수가 돌 때
      // 이 글의 그림이 어느 색인에도 없어 고아로 잡혀 지워진다.
      syncSummary(doc)
      const old = boards.get(from)
      if (old) {
        const keep = old.summaries.filter((s) => s.id !== postId)
        if (keep.length !== old.summaries.length) {
          old.summaries = keep
          markBoard(from)
        }
      }
      savePost(postId)
      return { ok: true, value: toSummary(doc.post) }
    },

    setCommentsClosed(postId, closed) {
      const doc = loadDoc(postId)
      if (!doc || doc.post.deletedAt) return { ok: false, error: '글을 찾을 수 없습니다.' }
      doc.post.commentsClosed = closed
      doc.dirty = true
      savePost(postId)
      return { ok: true, value: doc.post }
    },

    like(postId, accountId) {
      const doc = loadDoc(postId)
      if (!doc || doc.post.deletedAt) return { ok: false, error: '글을 찾을 수 없습니다.' }
      const i = doc.post.likes.indexOf(accountId)
      if (i >= 0) doc.post.likes.splice(i, 1)
      else doc.post.likes.push(accountId)
      doc.dirty = true
      syncSummary(doc)
      savePost(postId)
      return { ok: true, value: { liked: i < 0, count: doc.post.likes.length } }
    },

    addView(postId) {
      const doc = loadDoc(postId)
      if (!doc || doc.post.deletedAt) return
      doc.post.views++
      doc.dirty = true
      // 조회수는 목록에만 쓰이므로 요약만 갱신하고 본문 저장은 뭉쳐서 한다(조회마다 파일을 쓰지 않는다).
      const found = findSummary(postId)
      if (found) {
        found.s.views = doc.post.views
        markBoard(doc.post.boardId)
      }
    },

    comments: (postId) => loadDoc(postId)?.comments.slice() ?? [],

    addComment(postId, author, input, now) {
      const doc = loadDoc(postId)
      if (!doc || doc.post.deletedAt) return { ok: false, error: '글을 찾을 수 없습니다.' }
      if (doc.post.commentsClosed) return { ok: false, error: '댓글이 닫힌 글입니다.' }
      const r = (input && typeof input === 'object' ? input : {}) as Record<string, unknown>
      const text = typeof r.text === 'string' ? stripControl(r.text, true).trim().slice(0, MAX_COMMENT) : ''
      const images = assetList(r.images, MAX_COMMENT_IMAGES)
      if (!text && !images.length) return { ok: false, error: '내용을 입력해 주세요.' }
      if (doc.comments.filter((c) => !c.deletedAt).length >= MAX_COMMENTS) {
        return { ok: false, error: `댓글은 ${MAX_COMMENTS}개까지입니다.` }
      }
      // 부모는 자유 깊이로 저장한다(이어가기 체인이 이 게시판의 본체다). 화면에서만 단계를 접는다.
      const parentId = typeof r.parentId === 'string' && doc.comments.some((c) => c.id === r.parentId) ? r.parentId : ''
      const c: Comment = {
        id: randomUUID(),
        postId,
        authorId: author.id,
        authorNick: line(author.nick, 20),
        authorAvatar: assetRef(author.avatar),
        charId: line(r.charId, 64),
        charName: line(r.charName, 40),
        text,
        images,
        parentId,
        secret: bool(r.secret),
        createdAt: now,
        updatedAt: 0,
        deletedAt: 0
      }
      doc.comments.push(c)
      doc.dirty = true
      syncSummary(doc)
      savePost(postId)
      return { ok: true, value: c }
    },

    editComment(commentId, postId, actorId, text, now) {
      const doc = loadDoc(postId)
      const c = doc?.comments.find((x) => x.id === commentId)
      if (!doc || !c || c.deletedAt) return { ok: false, error: '댓글을 찾을 수 없습니다.' }
      if (c.authorId !== actorId) return { ok: false, error: '내 댓글만 수정할 수 있습니다.' }
      const t = typeof text === 'string' ? stripControl(text, true).trim().slice(0, MAX_COMMENT) : ''
      if (!t && !c.images.length) return { ok: false, error: '내용을 입력해 주세요.' }
      c.text = t
      c.updatedAt = now
      doc.dirty = true
      savePost(postId)
      return { ok: true, value: c }
    },

    removeComment(commentId, postId, actorId, canDeleteAny, now) {
      const doc = loadDoc(postId)
      const c = doc?.comments.find((x) => x.id === commentId)
      if (!doc || !c || c.deletedAt) return { ok: false, error: '댓글을 찾을 수 없습니다.' }
      if (c.authorId !== actorId && !canDeleteAny) return { ok: false, error: '삭제할 수 없습니다.' }
      // 답글이 달린 댓글을 통째로 지우면 이어가기 체인이 끊긴다 — 자리는 남기고 내용만 비운다.
      c.deletedAt = now
      c.text = ''
      c.images = []
      doc.dirty = true
      syncSummary(doc)
      savePost(postId)
      return { ok: true, value: c }
    },

    report(reporterId, input, now) {
      const r = (input && typeof input === 'object' ? input : {}) as Record<string, unknown>
      const targetType = r.targetType === 'comment' ? 'comment' : 'post'
      const targetId = line(r.targetId, 64)
      const postId = line(r.postId, 64) || targetId
      if (!isEntityId(targetId)) return { ok: false, error: '신고 대상이 올바르지 않습니다.' }
      const reason =
        r.reason === 'spam' || r.reason === 'abuse' || r.reason === 'rating' || r.reason === 'copyright' ? r.reason : 'etc'
      if (reports.some((x) => x.reporterId === reporterId && x.targetId === targetId && x.status === 'open')) {
        return { ok: false, error: '이미 신고한 대상입니다.' }
      }
      if (reports.length >= MAX_REPORTS) reports = reports.filter((x) => x.status === 'open').slice(-MAX_REPORTS)
      const rep: Report = {
        id: randomUUID(),
        targetType,
        targetId,
        postId,
        reporterId,
        reason,
        detail: typeof r.detail === 'string' ? r.detail.trim().slice(0, MAX_REPORT_DETAIL) : '',
        status: 'open',
        handledBy: '',
        handledAt: 0,
        note: '',
        createdAt: now
      }
      reports.push(rep)
      saveReports()
      return { ok: true, value: rep }
    },

    reports(status) {
      const list = status ? reports.filter((r) => r.status === status) : reports
      return list.slice().sort((a, b) => b.createdAt - a.createdAt)
    },

    resolveReport(reportId, actorId, action, note, now) {
      const rep = reports.find((r) => r.id === reportId)
      if (!rep) return { ok: false, error: '신고를 찾을 수 없습니다.' }
      if (rep.status !== 'open') return { ok: false, error: '이미 처리된 신고입니다.' }
      rep.status = action
      rep.handledBy = actorId
      rep.handledAt = now
      rep.note = line(note, 200)
      saveReports()
      return { ok: true, value: rep }
    },

    boardRemoved(boardId, mode, moveTo, now) {
      const b = boards.get(boardId)
      if (!b) return 0
      const n = b.summaries.length
      if (mode === 'move' && isEntityId(moveTo)) {
        const dest = idx(moveTo)
        for (const s of b.summaries) {
          s.boardId = moveTo
          const doc = loadDoc(s.id)
          if (doc) {
            doc.post.boardId = moveTo
            doc.post.notice = 0
            doc.dirty = true
            savePost(s.id)
          }
          s.notice = 0
          dest.summaries.push(s)
        }
        saveBoard(moveTo)
      } else if (mode === 'trash') {
        for (const s of b.summaries) {
          if (s.deletedAt) continue
          const doc = loadDoc(s.id)
          if (doc) {
            doc.post.deletedAt = now
            doc.dirty = true
            savePost(s.id)
          }
          s.deletedAt = now
        }
        // 보관은 원래 게시판에 남겨 둔다 — 되살릴 자리가 없어지면 복구가 불가능해진다.
        saveBoard(boardId)
        return n
      } else {
        for (const s of b.summaries) {
          bodies.delete(s.id)
          if (persist) {
            try {
              unlinkSync(join(postDir, `${s.id}.json`))
            } catch {
              /* 이미 없음 */
            }
          }
        }
      }
      boards.delete(boardId)
      if (persist) {
        try {
          unlinkSync(join(boardDir, `${boardId}.json`))
        } catch {
          /* 이미 없음 */
        }
      }
      return n
    },

    countsFor(accountId) {
      let posts = 0
      let received = 0
      for (const b of boards.values()) {
        for (const s of b.summaries) {
          if (s.deletedAt || s.draft) continue
          if (s.authorId === accountId) {
            posts++
            received += s.commentCount
          }
        }
      }
      // 내가 쓴 댓글 수는 본문 파일에 있어 세려면 전부 열어야 한다. 멤버 통계 쪽 누적값을 쓴다.
      return { posts, comments: 0, received }
    },

    collectAssetRefs(into) {
      // 상주 요약의 refs 만 본다 — 본문 파일을 열지 않으므로 수집이 동기로 끝난다.
      // refs 는 이미 해시라 그대로 넣는다(패턴으로 다시 훑으면 접두가 없어 하나도 걸리지 않는다).
      for (const b of boards.values()) for (const s of b.summaries) for (const r of s.refs) into.add(r)
    },

    removeAll(accountId) {
      // 글·댓글은 남긴다 — 지우면 남의 역극 스레드에 구멍이 뚫린다. 표시 이름은 작성 시점 사본이 이미 있다.
      // 회수하는 것은 좋아요와 신고뿐이다(계정이 사라지면 그 표는 의미가 없다).
      // 메모리에 올라와 있지 않은 글의 좋아요는 그 글을 다음에 열 때까지 남는다 — 표시상 무해하다.
      for (const doc of bodies.values()) {
        const i = doc.post.likes.indexOf(accountId)
        if (i >= 0) {
          doc.post.likes.splice(i, 1)
          doc.dirty = true
          syncSummary(doc)
          savePost(doc.post.id)
        }
      }
      const before = reports.length
      reports = reports.filter((r) => r.reporterId !== accountId)
      if (reports.length !== before) saveReports()
    },

    usageFor(accountId) {
      const refs = new Set<string>()
      let bytes = 0
      for (const b of boards.values()) {
        for (const s of b.summaries) {
          if (s.authorId !== accountId) continue
          bytes += Buffer.byteLength(JSON.stringify(s), 'utf8')
          for (const r of s.refs) refs.add(r)
        }
      }
      return { bytes, refs }
    },

    usage() {
      let posts = 0
      let bytes = 0
      for (const b of boards.values()) {
        posts += b.summaries.filter((s) => !s.deletedAt).length
        bytes += Buffer.byteLength(JSON.stringify(b.summaries), 'utf8')
      }
      return { posts, bytes }
    },

    flush() {
      if (flushTimer) {
        clearTimeout(flushTimer)
        flushTimer = null
      }
      for (const [bid, b] of boards) if (b.dirty) saveBoard(bid)
      for (const [pid, d] of bodies) if (d.dirty) savePost(pid)
    }
  }
}
