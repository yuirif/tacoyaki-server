// Socket.IO 릴레이 조립 (listen 은 하지 않음 → 테스트에서 임의 포트로 재사용).
import { createServer, type Server as HttpServer, type ServerResponse } from 'node:http'
import {
  createReadStream,
  statSync,
  readdirSync,
  readFileSync,
  writeFileSync,
  mkdirSync,
  renameSync,
  type Dirent
} from 'node:fs'
import { join, relative, sep } from 'node:path'
import { randomUUID } from 'node:crypto'
import { Server } from 'socket.io'
import type {
  ChatChannel,
  ChatMessage,
  ClientToServerEvents,
  GameMap,
  Handout,
  PresenceStatus,
  ProfileLink,
  ProfileTheme,
  PublicPresenceStatus,
  RoomState,
  ServerToClientEvents,
  SocketData,
  Token
} from './protocol'
import { GLOBAL_MAP_ID, SERVER_VERSION } from './protocol'
import type { IncomingMessage } from 'node:http'
import type { Server as HttpsServer } from 'node:https'
import { createServer as createHttpsServer } from 'node:https'
import { RoomStore, canViewHandout, canSeeToken, tokenForViewer, tokenVisibility, type Room } from './rooms'
import { parseCommand, resolveInlineRolls, diceCardKeywords } from './dice/engine'
import { createAuthStore, type AuthStore, type PublicAccount } from './auth'
import { createCharacterStore, type CharacterStore } from './characters'
import { createAssetStore, collectAssetRefs as scanAssetRefs, type AssetStore } from './assets'
import { createDmStore, MAX_GROUP_MEMBERS, type DmStore } from './dm'
import { createNotifStore, type NotifStore, type NotifInput } from './notifications'
import { createPostStore, type PostStore } from './posts'
import { createSessionLogStore, type SessionLogStore } from './sessionlogs'
import { createDottownStore, type DottownStore } from './dottown'
import { createEconomyStore, type EconStore } from './dottownEconomy'
import { createEstateStore, type EstateStore } from './dottownEstate'
import { createMarketStore, type MarketStore } from './market'
import { createCommunityStore, type CommunityStore } from './community'
import { createCommunityPostStore, type CommunityPostStore } from './communityPost'
import { createCommunityCharStore, type CommunityCharStore } from './communityChar'
import { createCommunityCatalog, type CommunityCatalog } from './communityCatalog'
import { createCommunityLedger, type CommunityLedger } from './communityLedger'
import { createCommunityGiftStore, type CommunityGiftStore } from './communityGift'
import { createCommunityEcon, type CommunityEcon } from './communityEcon'
import { createCommunityGames, type CommunityGames } from './communityGame'
import { createCommunityQuest, type CommunityQuest } from './communityQuest'
import { createCommunitySurvey, type CommunitySurvey } from './communitySurvey'
import { createCommunityRoutes } from './communityRoutes'
import { createPlazaHub, PLAZA_ID } from './plaza'
import { createRoomPresenceHub } from './roomPresence'
import { isFiniteCoord, clampCoord, MAX_CHAT_CHARS, isOversizedInline } from './limits'

/** PNG 시그니처 검증 + IHDR 폭·높이 파싱(sharp 없이). PNG 가 아니거나 손상 시 null. 마켓 업로드 검증용. */
function pngDimensions(bytes: Buffer): { w: number; h: number } | null {
  // 8바이트 시그니처 + IHDR(len4+type4+w4+h4) → 최소 24바이트.
  if (bytes.length < 24) return null
  const SIG = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]
  for (let i = 0; i < 8; i++) if (bytes[i] !== SIG[i]) return null
  if (bytes.toString('ascii', 12, 16) !== 'IHDR') return null
  const w = bytes.readUInt32BE(16)
  const h = bytes.readUInt32BE(20)
  if (w <= 0 || h <= 0 || w > 4096 || h > 4096) return null
  return { w, h }
}

export interface Relay {
  httpServer: HttpServer | HttpsServer
  io: Server<ClientToServerEvents, ServerToClientEvents, Record<string, never>, SocketData>
  store: RoomStore
  auth: AuthStore
  characters: CharacterStore
  assets: AssetStore
  dm: DmStore
  notif: NotifStore
  posts: PostStore
  sessionlogs: SessionLogStore
  dottown: DottownStore
  economy: EconStore
  market: MarketStore
}

/** POST 본문을 바이너리 버퍼로 읽음(자산 업로드). maxBytes 초과 시 연결 끊고 null. */
function readRawBody(req: IncomingMessage, maxBytes: number): Promise<Buffer | null> {
  return new Promise((resolve) => {
    const chunks: Buffer[] = []
    let total = 0
    req.on('data', (c: Buffer) => {
      total += c.length
      if (total > maxBytes) {
        req.destroy()
        resolve(null)
        return
      }
      chunks.push(c)
    })
    req.on('end', () => resolve(Buffer.concat(chunks)))
    req.on('error', () => resolve(null))
  })
}

/** 프레즌스 프로필 링크 방어적 정규화 — 라벨·URL 캡, http(s) 만 허용, 최대 6개. (계정 업데이트는 auth 가 별도 정규화) */
function coerceProfileLinks(arr: unknown): ProfileLink[] | undefined {
  if (!Array.isArray(arr)) return undefined
  const out: ProfileLink[] = []
  for (const v of arr) {
    if (!v || typeof v !== 'object') continue
    const o = v as Record<string, unknown>
    const label = typeof o.label === 'string' ? o.label.trim().slice(0, 30) : ''
    const url = typeof o.url === 'string' ? o.url.trim().slice(0, 400) : ''
    if (!/^https?:\/\//i.test(url)) continue // http(s) 만(javascript: 등 차단)
    out.push({ label: label || url, url })
    if (out.length >= 6) break
  }
  return out.length ? out : undefined
}

/** 프레즌스 프로필 색 테마 방어적 정규화 — 값은 hex 만(CSS 주입 방지). 전부 비면 undefined. */
function coerceProfileTheme(v: unknown): ProfileTheme | undefined {
  if (!v || typeof v !== 'object') return undefined
  const o = v as Record<string, unknown>
  const hex = (x: unknown): string | undefined =>
    typeof x === 'string' && /^#[0-9a-fA-F]{3,8}$/.test(x) ? x : undefined
  const t: ProfileTheme = {
    accent: hex(o.accent),
    nameColor: hex(o.nameColor),
    bioColor: hex(o.bioColor),
    bg: hex(o.bg)
  }
  return t.accent || t.nameColor || t.bioColor || t.bg ? t : undefined
}

/** POST 본문을 JSON 으로 파싱(최대 3MB — 프로필 아바타+배너 이미지 수용). 실패 시 빈 객체. */
function readJsonBody(req: IncomingMessage): Promise<Record<string, unknown>> {
  return new Promise((resolve) => {
    let body = ''
    req.on('data', (c: Buffer) => {
      body += c
      if (body.length > 3_000_000) req.destroy()
    })
    req.on('end', () => {
      try {
        // JSON.parse('null')→null, '[...]'→배열, '5'→숫자 — 객체가 아닌 본문을 그대로 주면 핸들러의
        //   body.x 접근이 throw 하므로, 객체가 아니면 빈 객체로 강제.
        const parsed = JSON.parse(body || '{}')
        resolve(parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : {})
      } catch {
        resolve({})
      }
    })
    req.on('error', () => resolve({}))
  })
}

/** 서버 데이터 내보내기 상한(원시 바이트) — 초과 시 거부하고 data/ 폴더 직접 복사를 안내(인메모리 번들 메모리 보호). */
const SERVER_EXPORT_MAX_BYTES = 100 * 1024 * 1024
/** 멤버 본인 데이터(게시글·세션방·참조 자산) 내보내기 상한 — 인메모리 base64 번들 메모리 보호. */
const MEMBER_EXPORT_MAX_BYTES = 80 * 1024 * 1024

/** dir 이하 모든 파일의 절대경로를 재귀 수집(없는 디렉터리·접근 불가는 건너뜀). 서버 데이터 백업용. */
function listFilesRec(root: string): string[] {
  const out: string[] = []
  const walk = (dir: string): void => {
    let entries: Dirent[]
    try {
      entries = readdirSync(dir, { withFileTypes: true })
    } catch {
      return
    }
    for (const e of entries) {
      const full = join(dir, e.name)
      if (e.isDirectory()) walk(full)
      else if (e.isFile()) out.push(full)
    }
  }
  walk(root)
  return out
}

/** 가져오기 상대경로 안전성 — 빈 값·절대경로·상위(..) 탈출 차단. dataDir 안에만 기록하도록. */
function isSafeRelPath(rel: string): boolean {
  if (!rel || rel.startsWith('/') || rel.startsWith('\\') || /^[a-zA-Z]:/.test(rel)) return false
  return !rel.split(/[/\\]/).some((seg) => seg === '..' || seg === '')
}

/**
 * 발화 정체성 프레즌스의 현재 표정 두상 — headshots[currentExpression] 우선, 없으면 단일 headshot.
 * 서버가 메시지에 각인해 두면 서버 재시작·새 참가자에게도 채팅 두상이 그대로 보존된다(라이브 roster 조회 불필요).
 */
function presenceHeadshot(
  ch: { headshot?: string; headshots?: string[]; currentExpression?: number } | undefined
): string | undefined {
  if (!ch) return undefined
  const i = ch.currentExpression ?? 0
  return ch.headshots?.[i] || ch.headshot
}

/**
 * 비밀 메시지(비밀 굴림·비밀 발화) 수신 대상 개인 룸 — 보낸 사람 + 그 방의 모든 GM.
 * rooms.canSeeMessage(히스토리 열람 규칙)와 같은 집합이어야 한다 — 어긋나면 재입장 뒤에야 보이는 메시지가 생긴다.
 */
function secretTargets(room: Room, senderId: string): string[] {
  const targets = new Set<string>(['user:' + senderId])
  for (const p of room.participants.values()) if (p.role === 'GM') targets.add('user:' + p.playerId)
  return [...targets]
}

/**
 * 이 메시지의 전달 대상 — 비공개(귓속말·비밀)면 당사자들의 개인 룸, 공개면 방 전체(roomId).
 * 수정·삭제 브로드캐스트가 원문과 같은 사람에게만 가도록 발화 시점의 라우팅을 그대로 재현한다.
 */
function messageAudience(room: Room, m: { playerId?: string; to?: string; channel: string; secret?: boolean }): string[] {
  if (m.secret) return secretTargets(room, m.playerId ?? '')
  if (m.channel === 'whisper') {
    const ids = [m.playerId, m.to].filter((v): v is string => !!v)
    return ids.map((id) => 'user:' + id)
  }
  return [room.id]
}

/**
 * opts.auth 미주입 시 비영속 인메모리 스토어(테스트 안전). 운영은 index.ts 에서 영속 스토어 주입.
 * corsOrigins: null/미설정=전체 허용(*, 개발/로컬). 배열=화이트리스트(공개 배포). Origin 헤더 없음
 *   (Electron file://·네이티브)은 항상 허용. tls 제공 시 https(wss) 서버, 없으면 http(ws).
 */
export function createRelay(opts?: {
  auth?: AuthStore
  characters?: CharacterStore
  rooms?: RoomStore
  assets?: AssetStore
  dm?: DmStore
  notif?: NotifStore
  posts?: PostStore
  sessionlogs?: SessionLogStore
  dottown?: DottownStore
  economy?: EconStore
  market?: MarketStore
  estate?: EstateStore
  community?: CommunityStore
  cmtyPosts?: CommunityPostStore
  cmtyChars?: CommunityCharStore
  cmtyCatalog?: CommunityCatalog
  cmtyLedger?: CommunityLedger
  cmtyGifts?: CommunityGiftStore
  cmtyEcon?: CommunityEcon
  cmtyGames?: CommunityGames
  cmtyQuest?: CommunityQuest
  cmtySurvey?: CommunitySurvey
  requireAuth?: boolean
  corsOrigins?: string[] | null
  tls?: { key: string; cert: string }
  /** 서버 데이터 디렉터리(관리자 내보내기/가져오기 대상). 미지정 시 <cwd>/data — 운영 스토어와 동일 기본값. */
  dataDir?: string
  /** 웹 클라이언트(웹판) 정적 루트 — build:web 산출물(webdist). 지정 시 미매칭 GET/HEAD 를 실존 파일로 서빙. */
  webRoot?: string | null
  /** 진단 로거(주입 시 연결/해제·주기 메모리·소켓 수를 호스트 로그로). 미주입(테스트)이면 무음. */
  log?: (...args: unknown[]) => void
}): Relay {
  const store = opts?.rooms ?? new RoomStore()
  const auth = opts?.auth ?? createAuthStore({ persist: false })
  const characters = opts?.characters ?? createCharacterStore({ persist: false })
  const assets = opts?.assets ?? createAssetStore({ persist: false })
  const dm = opts?.dm ?? createDmStore({ persist: false })
  const notif = opts?.notif ?? createNotifStore({ persist: false })
  const posts = opts?.posts ?? createPostStore({ persist: false })
  const sessionlogs = opts?.sessionlogs ?? createSessionLogStore({ persist: false })
  const dottown = opts?.dottown ?? createDottownStore({ persist: false })
  const economy = opts?.economy ?? createEconomyStore({ persist: false })
  const market = opts?.market ?? createMarketStore({ persist: false })
  const community = opts?.community ?? createCommunityStore({ persist: false })
  const cmtyPosts = opts?.cmtyPosts ?? createCommunityPostStore({ persist: false })
  const cmtyChars = opts?.cmtyChars ?? createCommunityCharStore({ persist: false })
  const cmtyCatalog = opts?.cmtyCatalog ?? createCommunityCatalog({ persist: false })
  const cmtyLedger = opts?.cmtyLedger ?? createCommunityLedger({ persist: false })
  const cmtyGifts = opts?.cmtyGifts ?? createCommunityGiftStore({ persist: false })
  const cmtyGames = opts?.cmtyGames ?? createCommunityGames({ persist: false })
  // 도트타운 표시 닉네임 해석(공통) — 도트타운 닉 우선, 없으면 계정 닉네임/아이디. 삭제된 계정이면 ''(호출부 폴백).
  //   광장/방 아바타 라벨(enter)과 집 위 라벨(estate viewOf)이 같은 규칙으로 최신 닉을 표시하게 공유한다.
  const displayNick = (id: string): string =>
    (id && (dottown.getNick(id) || auth.getAccountById(id)?.nickname || auth.getAccountById(id)?.username)) || ''
  // 도트타운 광장 부동산(빈터 입주·전세/월세) — 코인 차감은 economy.applyDelta 로 수렴(원장·잔액 공유).
  const estate =
    opts?.estate ??
    createEstateStore({
      persist: false,
      charge: (id, amt, reason, ref) => economy.applyDelta(id, amt, reason, ref),
      resolveNick: displayNick
    })
  // 부동산 변경 시 광장 차단셀 갱신 + 전체 브로드캐스트. 실제 구현은 plaza 생성 후 주입(아래) — 그 전엔 no-op.
  let broadcastLots: () => void = () => {}
  // 전역 프레즌스(누가 지금 접속 중인가) — userId → 그 사용자의 소켓 id 집합. 방과 무관(로비/방 어디든).
  const presence = new Map<string, Set<string>>()

  // ===== 프레즌스 상태(수동 온라인/자리비움/세션중/오프라인 표시) =====
  // 계정 소켓 중 '유효한' 세션방(방 존재 + 참가자 connected)에 있는 소켓이 있으면 세션중으로 파생.
  // socket.data.roomId 는 추방·방 삭제 시 정리되지 않고 남을 수 있어 store 재검증으로 오탐을 막는다.
  const inSession = (id: string): boolean => {
    for (const sid of presence.get(id) ?? []) {
      const s = io.sockets.sockets.get(sid)
      const rid = s?.data.roomId
      if (rid && s && store.getRoom(rid)?.participants.get(s.data.playerId)?.connected) return true
    }
    return false
  }
  // 실효 상태 — 우선순위: 오프라인(null) > invisible > 수동 away/session > 자동 session > online.
  const effectiveStatus = (id: string): PresenceStatus | null => {
    if (!presence.get(id)?.size) return null
    const manual = auth.getStatus(id) ?? 'online'
    if (manual !== 'online') return manual
    return inSession(id) ? 'session' : 'online'
  }
  // 외부 노출용 — invisible 은 오프라인으로 위장. 모든 online 판정은 이 두 헬퍼만 거친다(위장 누수 방지 단일 지점).
  const visibleOnline = (id: string): boolean => {
    const st = effectiveStatus(id)
    return !!st && st !== 'invisible'
  }
  const publicStatus = (id: string): PublicPresenceStatus | undefined => {
    const st = effectiveStatus(id)
    return !st || st === 'invisible' ? undefined : st
  }
  // 마지막으로 브로드캐스트한 표시 상태(계정별) — 중복 emit 억제. 오프라인/위장은 항목 자체를 지운다.
  const shownStatus = new Map<string, PublicPresenceStatus>()
  const syncPresence = (id: string): void => {
    if (!id) return
    const st = effectiveStatus(id)
    const pub = !st || st === 'invisible' ? null : st
    const prev = shownStatus.get(id) ?? null
    if (pub === prev) return
    if (pub) {
      shownStatus.set(id, pub)
      io.emit('dm:presence', { userId: id, online: true, status: pub })
    } else {
      shownStatus.delete(id)
      io.emit('dm:presence', { userId: id, online: false })
    }
  }

  // ===== 로비 알림(종) — 저장 + 대상 개인룸 실시간 push. push 가 자기알림/무효로 null 이면 no-op. =====
  const notify = (ownerId: string, n: NotifInput): void => {
    const item = notif.push(ownerId, n)
    if (item) io.to('user:' + ownerId).emit('notif:new', item)
  }
  /** 알림 액터 스냅샷(작성 시점 이름·아바타 — 탈퇴해도 표시 유지). */
  const actorOf = (a: PublicAccount): { id: string; name: string; avatar?: string } => ({
    id: a.id,
    name: a.nickname || a.username,
    ...(a.avatar ? { avatar: a.avatar } : {})
  })
  // DM 전송 레이트리밋(계정당 슬라이딩 윈도) — 고빈도 전송의 동기 디스크 쓰기로 이벤트 루프가 멈추는 것 방지.
  const dmRate = new Map<string, { count: number; resetAt: number }>()
  // 도트타운 경제 레이트리밋 — 알바/구매/일일 라우트의 자동화 스팸(동기 디스크 쓰기 루프) 차단(DM 과 동일 사상).
  const econRate = new Map<string, { count: number; resetAt: number }>()
  // 마이룸 소셜(좋아요·방문·방명록) 레이트리밋 — 경제와 별도 버킷(계정당 10초 40건). 좋아요 코인 보상 남발/스팸 차단.
  const socialRate = new Map<string, { count: number; resetAt: number }>()
  // 프레즌스 상태 변경 레이트리밋 — presence:set 폭주(동기 디스크쓰기·전역 브로드캐스트 반복) 차단.
  const presenceRate = new Map<string, { count: number; resetAt: number }>()
  const LIKE_REWARD = 10 // 새 방문자가 내 방에 좋아요를 누르면 소유주가 받는 코인(쌍당 1회 — 파밍 불가)
  const MARKET_FEE_PCT = 10 // 마켓 판매 수수료(%) — 창작자는 가격의 90%를 받고 10%는 소각(sink)
  const MARKET_FILE_MAX = 256 * 1024 // 마켓 이미지 파일당 최대 바이트(강한 캡)
  const CHAR_CANVAS = { w: 48, h: 64 } // 의상 파일 필수 치수(캐릭터 캔버스)
  const FURN_MAX = 256 // 가구 스프라이트 최대 한 변(px)
  const requireAuth = opts?.requireAuth === true
  const corsOrigins = opts?.corsOrigins ?? null
  const dataDir = opts?.dataDir ?? join(process.cwd(), 'data') // 관리자 서버 백업/복원 대상(운영 스토어와 동일 기본 경로)
  const log = opts?.log ?? ((): void => {}) // 진단 로그(미주입이면 무음 — 테스트 소음 방지)

  // 인라인 data URL 이미지를 서버 자산 저장소에 넣고 'asset:<해시>' 로 치환(콘텐츠 주소·중복 제거). data URL 이
  // 아니거나 디코드/저장에 실패하면 원본을 그대로 둔다(렌더 안전 — 최악이라도 인라인 유지, 끊김 없음).
  const internalizeInlineImage = async (s: string): Promise<string> => {
    if (typeof s !== 'string' || !s.startsWith('data:')) return s
    const comma = s.indexOf(',')
    if (comma < 0) return s
    const meta = s.slice(5, comma) // 예: 'image/png;base64'
    if (!/;base64$/i.test(meta)) return s
    const mime = meta.slice(0, -7) // ';base64' 제거
    try {
      const bytes = Buffer.from(s.slice(comma + 1), 'base64')
      if (bytes.length === 0) return s
      return 'asset:' + (await assets.put(bytes, mime))
    } catch {
      return s
    }
  }

  // 입장/싱크 스냅샷의 두상 풀(avatarPool)을 asset 참조로 경량화 — 콜드 재입장마다 수십 MB 인라인 풀을 통째
  // 재전송하지 않도록 한다. 풀 이미지는 콘텐츠 주소로 한 번만 저장되고 스냅샷엔 'asset:<해시>'(수십 바이트)만
  // 실린다. 클라는 입장 시 풀을 hydrate 해 기존 채팅·동결·내보내기 코드에 data URL 그대로 넘긴다.
  // 라이브 chat:new 두상은 인라인 유지(동결·내보내기 경로 무변경).
  const lightenAvatarPool = async (snap: RoomState): Promise<RoomState> => {
    const pool = snap.avatarPool
    if (Array.isArray(pool) && pool.length) {
      snap.avatarPool = await Promise.all(pool.map(internalizeInlineImage))
    }
    return snap
  }

  // origin 허용 판정: 화이트리스트 미설정이면 전체. Origin 없음(Electron/네이티브)은 항상 허용.
  const originAllowed = (origin: string | undefined): boolean =>
    !corsOrigins || !origin || corsOrigins.includes(origin)
  // CORS 응답 헤더값: 화이트리스트면 일치 origin 만 에코(아니면 첫 항목), 미설정이면 '*'.
  const corsHeaderValue = (origin: string | undefined): string =>
    !corsOrigins ? '*' : origin && corsOrigins.includes(origin) ? origin : (corsOrigins[0] ?? '*')

  const JSON_H = { 'content-type': 'application/json' } as const
  /** 관리자 전용 엔드포인트 게이트 — 본문 token 이 admin 이면 그 계정, 아니면 401/403 응답 후 null. */
  const requireAdmin = (body: Record<string, unknown>, res: ServerResponse): PublicAccount | null => {
    const account = typeof body.token === 'string' ? auth.verifyToken(body.token) : null
    if (!account) {
      res.writeHead(401, JSON_H)
      res.end(JSON.stringify({ ok: false, error: '인증이 필요합니다.' }))
      return null
    }
    if (account.role !== 'admin') {
      res.writeHead(403, JSON_H)
      res.end(JSON.stringify({ ok: false, error: '권한이 없습니다.' }))
      return null
    }
    return account
  }
  /** member 이상 게이트(도트타운 경제 — 알바·구매·일일). 손님은 403. */
  const requireMember = (body: Record<string, unknown>, res: ServerResponse): PublicAccount | null => {
    const account = typeof body.token === 'string' ? auth.verifyToken(body.token) : null
    if (!account) {
      res.writeHead(401, JSON_H)
      res.end(JSON.stringify({ ok: false, error: '인증이 필요합니다.' }))
      return null
    }
    if (account.role === 'guest') {
      res.writeHead(403, JSON_H)
      res.end(JSON.stringify({ ok: false, error: '손님 계정은 이용할 수 없습니다(관리자 승인 후).' }))
      return null
    }
    return account
  }
  /** 경제 라우트 레이트리밋 — 계정당 10초 30건. 초과 시 429 후 true(쓰기 유발 전에 차단). */
  const econLimited = (accountId: string, res: ServerResponse): boolean => {
    const t = Date.now()
    const rl = econRate.get(accountId)
    if (!rl || t > rl.resetAt) {
      econRate.set(accountId, { count: 1, resetAt: t + 10_000 })
      return false
    }
    if (rl.count >= 30) {
      res.writeHead(429, JSON_H)
      res.end(JSON.stringify({ ok: false, error: '너무 자주 요청했어요. 잠시 후 다시 시도하세요.' }))
      return true
    }
    rl.count++
    return false
  }
  /** 소셜 라우트 레이트리밋 — 계정당 10초 40건(좋아요/방문/방명록). 초과 시 429 후 true. */
  const socialLimited = (accountId: string, res: ServerResponse): boolean => {
    const t = Date.now()
    const rl = socialRate.get(accountId)
    if (!rl || t > rl.resetAt) {
      socialRate.set(accountId, { count: 1, resetAt: t + 10_000 })
      return false
    }
    if (rl.count >= 40) {
      res.writeHead(429, JSON_H)
      res.end(JSON.stringify({ ok: false, error: '너무 자주 요청했어요. 잠시 후 다시 시도하세요.' }))
      return true
    }
    rl.count++
    return false
  }

  /** 이름을 문자열로 받는 브로드캐스트 — 커뮤니티 라우트 표가 이벤트를 값으로 다루기 때문에 필요하다. */
  const emitRaw = (room: string, event: string, payload: unknown): void => {
    ;(io.to(room) as unknown as { emit: (e: string, p: unknown) => void }).emit(event, payload)
  }

  // ── 커뮤니티 경제 ──────────────────────────────────────────────────────
  // 지갑·소지품은 캐릭터 저장소 위에 얹힌다(같은 파일 안이라 한 번의 쓰기로 끝난다).
  const cmtyEcon =
    opts?.cmtyEcon ??
    createCommunityEcon({
      community,
      chars: cmtyChars,
      catalog: cmtyCatalog,
      ledger: cmtyLedger,
      gifts: cmtyGifts,
      persist: false
    })
  // 경제 알림은 사람이 한 일이 아닌 경우가 많아, 액터를 커뮤니티 자체로 둔다.
  cmtyEcon.setNotify((accountId, text, ref) =>
    notify(accountId, {
      kind: 'cmty',
      actor: { id: '', name: community.settings()?.name || '커뮤니티' },
      ...(ref ? { ref } : {}),
      text
    } as NotifInput)
  )
  // 퀘스트·조사 — 진행 상태는 캐릭터 샤드 안에 있어 보상 지급이 한 번의 쓰기로 끝난다.
  const cmtyQuest = opts?.cmtyQuest ?? createCommunityQuest({ chars: cmtyChars, games: cmtyGames, econ: cmtyEcon, catalog: cmtyCatalog })
  const cmtySurvey = opts?.cmtySurvey ?? createCommunitySurvey({ chars: cmtyChars, games: cmtyGames, econ: cmtyEcon, catalog: cmtyCatalog })
  cmtyQuest.setNotify((accountId, text, ref) =>
    notify(accountId, {
      kind: 'cmty',
      actor: { id: '', name: community.settings()?.name || '커뮤니티' },
      ...(ref ? { ref } : {}),
      text
    } as NotifInput)
  )
  // 재시작 사이에 끝난 파견을 확정하고, 아직 알리지 않은 것을 한 번에 알린다.
  cmtyQuest.tick(Date.now())
  // 도감의 획득처 탭이 퀘스트·조사까지 훑도록 이어 준다.
  cmtyCatalog.addSourceProvider((defId) =>
    cmtyGames.sourcesOf(defId).map((x) => ({ kind: x.kind, id: x.id, name: x.name, chance: x.chance, qty: x.qty }))
  )

  // 기한이 지난 선물은 보낸 사람에게 돌아간다. 부팅 직후 한 번, 그 뒤로는 한 시간에 한 번.
  cmtyEcon.sweepGifts(Date.now())
  const giftSweeper = setInterval(() => cmtyEcon.sweepGifts(Date.now()), 60 * 60 * 1000)
  giftSweeper.unref?.()

  // ── 커뮤니티 라우트 ────────────────────────────────────────────────────
  // 예순 개 남짓이라 별도 모듈의 표로 두고 여기서는 배선만 한다(각 항목이 필요한 권한을 자기 옆에 적는다).
  const communityRoutes = createCommunityRoutes({
    auth,
    community,
    posts: cmtyPosts,
    chars: cmtyChars,
    catalog: cmtyCatalog,
    econ: cmtyEcon,
    ledger: cmtyLedger,
    gifts: cmtyGifts,
    games: cmtyGames,
    quest: cmtyQuest,
    survey: cmtySurvey,
    readJsonBody,
    notify: (ownerId, item) => notify(ownerId, item as NotifInput),
    actorOf,
    // 이벤트 이름을 문자열로 받아 넘기므로 여기서 한 번만 넓힌다. 이름·페이로드 계약 자체는 protocol 이 강제한다.
    emitTo: (room, event, payload) => emitRaw(room, event, payload),
    emitAccount: (accountId, event, payload) => emitRaw('acct:' + accountId, event, payload),
    socialLimited,
    econLimited,
    now: () => Date.now()
  })

  // ── 웹 클라이언트(웹판) 정적 서빙 ──────────────────────────────────────
  // webRoot 지정 시 미매칭 GET/HEAD 를 이 폴더의 '실존 파일'로만 응답한다. 미존재 경로는 핸들러 끝의
  // 404 JSON 으로 흘려보내 '구버전 서버 감지' 신호를 보존한다(웹판엔 SPA 라우터가 없어 폴백 불필요).
  const webRoot = opts?.webRoot || null
  /**
   * 웹판 문서(HTML)에만 붙이는 콘텐츠 보안 정책 — 주입된 스크립트가 실행되는 길을 막는 2차 방어선이다.
   * 각 항목이 넓은 이유:
   *   img/media/connect — 접속할 호스트를 사용자가 직접 입력하므로 대상 오리진을 미리 알 수 없다.
   *   connect 의 data:·blob: — 자산 업로드가 data URL 을 fetch 해 blob 으로 바꾼 뒤 올린다. '*' 는 이 두 스킴을
   *     포함하지 않으므로 빠뜨리면 웹판에서 이미지·음원 업로드가 전부 실패한다.
   *   style 'unsafe-inline' — 글 본문이 인라인 style 로 서식을 표현한다(새니타이저가 허용하는 유일한 속성).
   *   worker blob: — 움짤 리사이즈 워커가 blob URL 로 뜬다.
   *   영상 임베드 호스트 — 배경음악 재생용 프레임.
   * 값을 넓혀야 할 일이 생기면, 넓히기 전에 그 기능이 정말 그 권한을 필요로 하는지 먼저 확인한다.
   */
  const WEB_CSP = [
    "default-src 'self'",
    "script-src 'self' https://www.youtube.com",
    "style-src 'self' 'unsafe-inline'",
    'img-src * data: blob:',
    'media-src * data: blob:',
    "font-src 'self' data:",
    'connect-src * data: blob:',
    "worker-src 'self' blob:",
    "frame-src 'self' https://www.youtube.com https://www.youtube-nocookie.com",
    "object-src 'none'",
    "base-uri 'self'",
    "form-action 'none'"
  ].join('; ')
  const WEB_MIME: Record<string, string> = {
    '.html': 'text/html; charset=utf-8',
    '.js': 'text/javascript; charset=utf-8',
    '.css': 'text/css; charset=utf-8',
    '.svg': 'image/svg+xml',
    '.png': 'image/png',
    '.jpg': 'image/jpeg',
    '.jpeg': 'image/jpeg',
    '.gif': 'image/gif',
    '.webp': 'image/webp',
    '.ico': 'image/x-icon',
    '.json': 'application/json; charset=utf-8',
    '.txt': 'text/plain; charset=utf-8',
    '.map': 'application/json',
    '.woff': 'font/woff',
    '.woff2': 'font/woff2',
    '.ttf': 'font/ttf',
    '.mp3': 'audio/mpeg',
    '.ogg': 'audio/ogg',
    '.wasm': 'application/wasm'
  }
  /** 요청 경로를 webRoot 안의 실존 파일로 해석(경로 탈출 차단·허용 확장자만). 파일이 아니면 null. */
  const resolveWebFile = (
    rawUrl: string
  ): { path: string; rel: string; type: string; size: number; etag: string } | null => {
    if (!webRoot) return null
    let p = rawUrl.split(/[?#]/)[0]
    try {
      p = decodeURIComponent(p)
    } catch {
      return null // 잘못된 % 인코딩
    }
    if (p === '/') p = '/index.html'
    // 경로 탈출 차단: 역슬래시·널문자·'..'/빈 세그먼트 금지 + 최종 경로가 webRoot 안인지 재확인.
    if (!p.startsWith('/') || p.includes('\\') || p.includes('\0')) return null
    if (p.slice(1).split('/').some((seg) => seg === '..' || seg === '')) return null
    const abs = join(webRoot, p.slice(1))
    const rel = relative(webRoot, abs)
    if (!rel || rel.startsWith('..')) return null
    const dot = abs.lastIndexOf('.')
    const type = dot >= 0 ? WEB_MIME[abs.slice(dot).toLowerCase()] : undefined
    if (!type) return null
    try {
      const st = statSync(abs)
      if (!st.isFile()) return null
      // 약검증자 ETag(크기+수정시각) — no-cache 파일의 재검증이 매번 전체 재전송이 아니라 304 로 끝나게.
      const etag = `W/"${st.size.toString(16)}-${Math.trunc(st.mtimeMs).toString(16)}"`
      return { path: abs, rel, type, size: st.size, etag }
    } catch {
      return null // 미존재 — 404 JSON 폴백
    }
  }

  const handler = (req: IncomingMessage, res: ServerResponse): void => {
    // CORS: 프리뷰(다른 포트)·Electron(file://)에서 fetch 로 로그인/회원가입 허용.
    const origin = typeof req.headers.origin === 'string' ? req.headers.origin : undefined
    res.setHeader('Access-Control-Allow-Origin', corsHeaderValue(origin))
    res.setHeader('Vary', 'Origin')
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS')
    // 'authorization' 필수 — POST /asset 은 Bearer 토큰을 헤더로 보낸다. 빠지면 렌더러(app:// origin)의 업로드가
    // CORS 프리플라이트(OPTIONS)에서 막혀 전부 실패한다.
    res.setHeader('Access-Control-Allow-Headers', 'content-type, authorization')
    if (req.method === 'OPTIONS') {
      res.writeHead(204)
      res.end()
      return
    }
    if (req.url === '/health') {
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ ok: true, ver: SERVER_VERSION, rooms: store.roomCount }))
      return
    }
    // 자산 서빙(GET /asset/<sha256>) — 콘텐츠 주소(불변)라 영구 캐시. 해시가 곧 캐퍼빌리티이므로 인증 없이 제공.
    // 콘텐츠 주소(불변)라 ETag=해시(강한 검증자) + If-None-Match 304 로 재검증을 짧게 끝내고,
    // Range(206) 부분전송으로 오디오 시크·부분요청이 매번 전곡을 재전송하지 않게 한다(egress 절감).
    if (req.method === 'GET' && req.url && req.url.startsWith('/asset/')) {
      const hash = req.url.slice('/asset/'.length).split(/[?#]/)[0]
      const a = assets.resolve(hash)
      if (!a) {
        res.writeHead(404)
        res.end()
        return
      }
      // 크기: 영속이면 파일 stat, 인메모리면 바이트 길이. stat 실패(직전 sweep 등)는 404 로 폴백.
      let size: number
      if (a.path) {
        try {
          size = statSync(a.path).size
        } catch {
          res.writeHead(404)
          res.end()
          return
        }
      } else {
        size = a.bytes ? a.bytes.length : 0
      }
      const etag = '"' + hash + '"'
      res.setHeader('content-type', a.mime)
      // 업로드 자산은 사용자 콘텐츠라 브라우저 MIME 스니핑을 막아 선언된 타입으로만 처리(HTML 폴리글롯 방어).
      res.setHeader('x-content-type-options', 'nosniff')
      // 자산은 API·웹판과 같은 오리진에서 나가므로, 혹시라도 문서로 해석되면 그 오리진의 저장소(로그인 토큰)에 닿는다.
      // 아래 둘로 '문서로 열리는 길' 자체를 막는다. 화면 표시는 <img>/<audio> 같은 하위 리소스 로드라 영향받지 않는다.
      //   - attachment: 주소창으로 직접 열면 표시 대신 내려받기가 된다.
      //   - sandbox: 그래도 문서로 열렸을 때 스크립트·같은 오리진 권한을 모두 뗀다.
      res.setHeader('content-disposition', 'attachment')
      res.setHeader('content-security-policy', 'sandbox')
      res.setHeader('cache-control', 'public, max-age=31536000, immutable')
      res.setHeader('etag', etag)
      res.setHeader('accept-ranges', 'bytes')
      // 조건부요청 — ETag 일치(또는 *)면 304(본문 없음).
      const inm = req.headers['if-none-match']
      if (typeof inm === 'string' && inm.split(',').some((t) => {
        const v = t.trim()
        return v === etag || v === 'W/' + etag || v === '*'
      })) {
        res.writeHead(304)
        res.end()
        return
      }
      // Range 파싱 — 'bytes=start-end' 단일 구간만(멀티파트 미지원). 인식 못 하면 전체 200 폴백.
      let start = 0
      let end = size - 1
      let partial = false
      const rangeH = req.headers['range']
      if (typeof rangeH === 'string' && size > 0) {
        const m = /^bytes=(\d*)-(\d*)$/.exec(rangeH.trim())
        if (m && (m[1] !== '' || m[2] !== '')) {
          if (m[1] === '') {
            // suffix: 마지막 N 바이트.
            const n = parseInt(m[2], 10)
            if (Number.isFinite(n) && n > 0) {
              start = Math.max(0, size - n)
              end = size - 1
              partial = true
            }
          } else {
            start = parseInt(m[1], 10)
            end = m[2] === '' ? size - 1 : parseInt(m[2], 10)
            if (end > size - 1) end = size - 1
            partial = true
          }
          if (partial && (!Number.isFinite(start) || !Number.isFinite(end) || start > end || start >= size)) {
            // 416 — 범위 불만족.
            res.setHeader('content-range', `bytes */${size}`)
            res.writeHead(416)
            res.end()
            return
          }
        }
      }
      if (partial) {
        res.setHeader('content-range', `bytes ${start}-${end}/${size}`)
        res.setHeader('content-length', String(end - start + 1))
        res.writeHead(206)
        if (a.path) {
          const stream = createReadStream(a.path, { start, end })
          stream.on('error', () => res.end()) // 헤더는 이미 전송(206) — 종료만.
          stream.pipe(res)
        } else {
          res.end(a.bytes ? a.bytes.subarray(start, end + 1) : undefined)
        }
        return
      }
      res.setHeader('content-length', String(size))
      res.writeHead(200)
      if (a.path) {
        const stream = createReadStream(a.path)
        stream.on('error', () => {
          if (!res.headersSent) res.writeHead(404)
          res.end()
        })
        stream.pipe(res)
      } else {
        res.end(a.bytes)
      }
      return
    }
    // 자산 업로드(POST /asset) — 바이너리 본문 + content-type. 인증 모드면 유효 토큰 필요(익명 디스크 채우기 방지).
    // 반환: { ok, ref: 'asset:<해시>' }. 콘텐츠 해시라 같은 파일 재업로드는 중복 제거됨.
    if (req.method === 'POST' && req.url === '/asset') {
      if (requireAuth) {
        const authz = typeof req.headers['authorization'] === 'string' ? req.headers['authorization'] : ''
        const token = authz.startsWith('Bearer ') ? authz.slice(7) : ''
        if (!auth.verifyToken(token)) {
          res.writeHead(401, { 'content-type': 'application/json' })
          res.end(JSON.stringify({ ok: false, error: '인증이 필요합니다.' }))
          return
        }
      }
      void readRawBody(req, assets.maxBytes).then(async (buf) => {
        if (!buf || buf.length === 0) {
          res.writeHead(413, { 'content-type': 'application/json' })
          res.end(JSON.stringify({ ok: false, error: '파일이 비었거나 너무 큽니다.' }))
          return
        }
        const mime =
          typeof req.headers['content-type'] === 'string'
            ? req.headers['content-type']
            : 'application/octet-stream'
        try {
          const hash = await assets.put(buf, mime)
          res.writeHead(200, { 'content-type': 'application/json' })
          res.end(JSON.stringify({ ok: true, ref: 'asset:' + hash }))
        } catch {
          res.writeHead(500, { 'content-type': 'application/json' })
          res.end(JSON.stringify({ ok: false, error: '자산 저장 실패' }))
        }
      })
      return
    }
    // 인증: 소켓 연결 전 토큰 발급(회원가입/로그인).
    if (req.method === 'POST' && (req.url === '/auth/signup' || req.url === '/auth/login')) {
      void readJsonBody(req).then((body) => {
        const username = typeof body.username === 'string' ? body.username : ''
        const password = typeof body.password === 'string' ? body.password : ''
        const result =
          req.url === '/auth/signup' ? auth.signup(username, password) : auth.login(username, password)
        res.writeHead(result.ok ? 200 : 400, { 'content-type': 'application/json' })
        res.end(JSON.stringify(result))
      })
      return
    }
    // 프로필 갱신(닉네임·사진·소개) — 토큰 인증. 본문에 token + 부분 패치.
    if (req.method === 'POST' && req.url === '/auth/profile') {
      void readJsonBody(req).then((body) => {
        const token = typeof body.token === 'string' ? body.token : ''
        // 손님은 프로필 색 테마(꾸밈)만 못 바꾼다 — 프사·헤더·닉네임·소개·링크는 허용.
        const isGuest = auth.verifyToken(token)?.role === 'guest'
        const result = auth.updateProfile(token, {
          nickname: typeof body.nickname === 'string' ? body.nickname : undefined,
          avatar: typeof body.avatar === 'string' ? body.avatar : undefined,
          bio: typeof body.bio === 'string' ? body.bio : undefined,
          banner: typeof body.banner === 'string' ? body.banner : undefined,
          links: Array.isArray(body.links) ? body.links : undefined,
          profileTheme:
            !isGuest && body.profileTheme !== undefined ? (body.profileTheme as ProfileTheme) : undefined // updateProfile 가 sanitizeTheme 로 재검증
        })
        res.writeHead(result.ok ? 200 : 400, { 'content-type': 'application/json' })
        res.end(JSON.stringify(result))
      })
      return
    }
    // 비밀번호 변경(본인) — 토큰 + 현재 비밀번호 재확인. 성공 시 이 세션만 남고 다른 기기 세션은 끊긴다.
    if (req.method === 'POST' && req.url === '/auth/password') {
      void readJsonBody(req).then((body) => {
        const token = typeof body.token === 'string' ? body.token : ''
        const current = typeof body.current === 'string' ? body.current : ''
        const next = typeof body.next === 'string' ? body.next : ''
        const result = auth.changePassword(token, current, next)
        if (result.ok) {
          // 끊긴 세션으로 붙어 있던 소켓은 살아 있어도 토큰이 무효다 — 즉시 끊어 재로그인시킨다.
          for (const s of io.sockets.sockets.values()) {
            const hs = s.handshake.auth as { token?: unknown }
            if (s.data.account?.id === result.accountId && hs?.token !== token) s.disconnect(true)
          }
        }
        res.writeHead(result.ok ? 200 : 400, JSON_H)
        res.end(JSON.stringify(result))
      })
      return
    }
    // 관리자 이양 — 지금 관리자가 다른 계정에 관리자를 넘기고 본인은 멤버가 된다(관리자는 항상 1명).
    if (req.method === 'POST' && req.url === '/admin/transfer') {
      void readJsonBody(req).then((body) => {
        const me = requireAdmin(body, res)
        if (!me) return
        const userId = typeof body.userId === 'string' ? body.userId : ''
        const result = auth.transferAdmin(me.id, userId)
        if (!result.ok) {
          res.writeHead(400, JSON_H)
          res.end(JSON.stringify(result))
          return
        }
        // 양쪽 접속 세션에 새 등급을 즉시 반영(재로그인 없이 관리 화면이 열리고 닫히도록).
        for (const s of io.sockets.sockets.values()) {
          if (s.data.account?.id === result.to.id) {
            s.data.account.role = 'admin'
            s.emit('role:changed', { role: 'admin' })
          } else if (s.data.account?.id === result.from.id) {
            s.data.account.role = 'member'
            s.emit('role:changed', { role: 'member' })
          }
        }
        res.writeHead(200, JSON_H)
        res.end(JSON.stringify(result))
      })
      return
    }
    // 계정 탈퇴 — 토큰 + 비밀번호 재확인. 성공 시 계정·세션·방명록 제거 후 캐릭터·DM·소유 세션방을 연쇄 정리.
    if (req.method === 'POST' && req.url === '/auth/delete') {
      void readJsonBody(req).then((body) => {
        const token = typeof body.token === 'string' ? body.token : ''
        const password = typeof body.password === 'string' ? body.password : ''
        const result = auth.deleteAccount(token, password)
        if (!result.ok) {
          res.writeHead(400, { 'content-type': 'application/json' })
          res.end(JSON.stringify(result))
          return
        }
        const accountId = result.accountId
        for (const fid of result.affectedFriends) io.to('user:' + fid).emit('friend:update') // (전)친구 목록 갱신
        // 연쇄 정리: 캐릭터·DM·블로그·소유 세션방(고아 자산은 이후 자산 GC 가 회수).
        characters.removeAll(accountId)
        posts.removeAll(accountId) // 블로그 글·게시판 + 타인 글에 남긴 댓글/좋아요 제거
        sessionlogs.removeAll(accountId) // 세션 로그·게시판 제거
        dottown.removeAll(accountId) // 도트타운 마이룸·캐릭터 외형 제거
        economy.removeAll(accountId) // 도트타운 지갑·원장·소유·알바·일일 제거
        market.removeAll(accountId) // 도트타운 마켓 등록·보유 제거
        community.removeAll(accountId) // 커뮤니티 멤버십(글·댓글은 남긴다)
        cmtyPosts.removeAll(accountId) // 커뮤니티 좋아요·신고 회수
        cmtyChars.removeAll(accountId, Date.now()) // 커뮤니티 캐릭터를 보관 상태로(지갑·소지품은 그대로 남는다)
        estate.removeAll(accountId) // 광장 부동산(소유 건물) 제거
        broadcastLots()
        notif.removeForUser(accountId) // 알림 피드 제거(고아 파일 방지)
        dmRate.delete(accountId) // DM 레이트리밋 항목 정리(계정 소멸)
        econRate.delete(accountId) // 경제 레이트리밋 항목 정리
        socialRate.delete(accountId) // 소셜 레이트리밋 항목 정리
        shownStatus.delete(accountId) // 프레즌스 표시 상태 정리
        // DM 상대에게 사라진 대화 정리 신호 — by=상대 로 보내 그 사람 본인이 지운 것처럼 receiveClear→applyClear 실행(온라인 시 즉시 목록에서 제거).
        for (const peer of dm.removeForUser(accountId)) {
          io.to('user:' + peer).emit('dm:cleared', { peer: accountId, by: peer })
        }
        // 그룹 DM 은 파일 삭제가 아니라 멤버 제거(잔존 멤버 대화 보존). 잔존 멤버에게 재조회 신호.
        for (const g of dm.leaveAllGroups(accountId)) {
          for (const m of g.remaining) io.to('user:' + m).emit('dm:group:update', { threadId: g.threadId })
        }
        for (const room of store.deleteOwnedBy(accountId)) {
          for (const pid of room.participants) {
            io.to('user:' + pid).emit('room:closed', '세션이 삭제되었습니다.')
            void io.in('user:' + pid).socketsLeave(room.id)
          }
        }
        // 탈퇴 계정 본인의 열린 소켓 강제 종료 — disconnect 핸들러가 프레즌스·레이트리밋 정리 + 오프라인 브로드캐스트(유령 온라인 방지).
        void io.in('acct:' + accountId).disconnectSockets(true)
        res.writeHead(200, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ ok: true }))
      })
      return
    }
    // 갠홈 둘러보기 — 전체 사용자 공개 요약. (공개 디렉터리 — 인증 불필요)
    if (req.method === 'GET' && req.url === '/users') {
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ ok: true, users: auth.listUsers() }))
      return
    }
    // 타인/내 갠홈 보기 — 공개 프로필 + 방명록. GET /home?id=<userId>.
    if (req.method === 'GET' && req.url && (req.url === '/home' || req.url.startsWith('/home?'))) {
      const id = new URLSearchParams(req.url.split('?')[1] ?? '').get('id') ?? ''
      const home = auth.getHome(id)
      res.writeHead(home ? 200 : 404, { 'content-type': 'application/json' })
      res.end(JSON.stringify(home ? { ok: true, ...home } : { ok: false, error: '사용자를 찾을 수 없습니다.' }))
      return
    }
    // 방명록 글 남기기 — 토큰 인증. 본문 { token, target, message }. 성공 시 홈 주인에게 알림.
    if (req.method === 'POST' && req.url === '/guestbook') {
      void readJsonBody(req).then((body) => {
        const token = typeof body.token === 'string' ? body.token : ''
        const author = auth.verifyToken(token)
        if (!author) {
          res.writeHead(401, { 'content-type': 'application/json' })
          res.end(JSON.stringify({ ok: false, error: '로그인이 필요합니다.' }))
          return
        }
        // 레이트리밋 — 방명록 도배가 대상의 알림 피드를 밀어내고(축출) 동기 저장을 반복시키지 않게.
        if (socialLimited(author.id, res)) return
        const target = typeof body.target === 'string' ? body.target : ''
        const message = typeof body.message === 'string' ? body.message : ''
        const result = auth.addGuestbookEntry(token, target, message)
        if (result.ok) notify(target, { kind: 'guestbook', actor: actorOf(author), text: message })
        res.writeHead(result.ok ? 200 : 400, { 'content-type': 'application/json' })
        res.end(JSON.stringify(result))
      })
      return
    }
    // 내 로비 공개(동기화) — 토큰 인증. 본문 { token, lobby }. 이미지 포함이라 더 큰 본문 허용(readRawBody).
    if (req.method === 'POST' && req.url === '/lobby') {
      void readRawBody(req, 12 * 1024 * 1024).then((buf) => {
        if (!buf || buf.length === 0) {
          res.writeHead(413, { 'content-type': 'application/json' })
          res.end(JSON.stringify({ ok: false, error: '로비 데이터가 비었거나 너무 큽니다.' }))
          return
        }
        let body: Record<string, unknown> = {}
        try {
          const parsed = JSON.parse(buf.toString('utf8'))
          if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) body = parsed as Record<string, unknown>
        } catch {
          body = {}
        }
        const token = typeof body.token === 'string' ? body.token : ''
        // 손님은 로비를 꾸밀 수 없다(호스팅 용량 보호) — 공개 스냅샷 동기화 거부.
        if (auth.verifyToken(token)?.role === 'guest') {
          res.writeHead(403, { 'content-type': 'application/json' })
          res.end(JSON.stringify({ ok: false, error: '손님 계정은 로비를 꾸밀 수 없습니다.' }))
          return
        }
        // 보내는 기기가 아는 '그림 참조 수' — 0 이면 정말 그림이 없는 로비, 없으면 알 수 없음(옛 프로그램).
        const refCount = typeof body.imageIds === 'number' ? body.imageIds : undefined
        const result = auth.setLobby(token, body.lobby, refCount)
        res.writeHead(result.ok ? 200 : 400, { 'content-type': 'application/json' })
        res.end(JSON.stringify(result))
      })
      return
    }
    // 타인/내 로비 열람 — 공개 스냅샷. GET /lobby?id=<userId>.
    if (req.method === 'GET' && req.url && (req.url === '/lobby' || req.url.startsWith('/lobby?'))) {
      const id = new URLSearchParams(req.url.split('?')[1] ?? '').get('id') ?? ''
      const lobby = auth.getLobby(id)
      res.writeHead(lobby ? 200 : 404, { 'content-type': 'application/json' })
      res.end(JSON.stringify(lobby ? { ok: true, lobby } : { ok: false, error: '로비를 찾을 수 없습니다.' }))
      return
    }
    // 방명록 글 삭제 — 홈 주인/작성자만. 본문 { token, target, entryId }.
    if (req.method === 'POST' && req.url === '/guestbook/delete') {
      void readJsonBody(req).then((body) => {
        const token = typeof body.token === 'string' ? body.token : ''
        const target = typeof body.target === 'string' ? body.target : ''
        const entryId = typeof body.entryId === 'string' ? body.entryId : ''
        const result = auth.removeGuestbookEntry(token, target, entryId)
        res.writeHead(result.ok ? 200 : 400, { 'content-type': 'application/json' })
        res.end(JSON.stringify(result))
      })
      return
    }
    // DM 보내기 — 토큰 인증. 본문 { token, to, text }. 성공 시 양쪽 개인룸으로 실시간 푸시.
    if (req.method === 'POST' && req.url === '/dm/send') {
      void readJsonBody(req).then((body) => {
        const account = typeof body.token === 'string' ? auth.verifyToken(body.token) : null
        if (!account) {
          res.writeHead(401, { 'content-type': 'application/json' })
          res.end(JSON.stringify({ ok: false, error: '인증이 필요합니다.' }))
          return
        }
        // 레이트리밋 — 계정당 10초에 30건. 초과 시 429(이벤트 루프 보호).
        const now = Date.now()
        const rl = dmRate.get(account.id)
        if (!rl || now > rl.resetAt) {
          dmRate.set(account.id, { count: 1, resetAt: now + 10_000 })
        } else if (rl.count >= 30) {
          res.writeHead(429, { 'content-type': 'application/json' })
          res.end(JSON.stringify({ ok: false, error: '너무 자주 보냈습니다. 잠시 후 다시 시도하세요.' }))
          return
        } else {
          rl.count++
        }
        const text = typeof body.text === 'string' ? body.text : ''
        // 그룹 분기 — threadId 가 있으면 멤버 전원 팬아웃(레이트리밋은 위 공용 버킷을 이미 통과).
        const threadId = typeof body.threadId === 'string' ? body.threadId : ''
        if (threadId) {
          const g = dm.group(threadId)
          if (!g || !g.members.includes(account.id)) {
            res.writeHead(403, { 'content-type': 'application/json' })
            res.end(JSON.stringify({ ok: false, error: '그룹 대화에 참여하고 있지 않습니다.' }))
            return
          }
          const msg = dm.appendGroup(account.id, threadId, text)
          if (!msg) {
            res.writeHead(400, { 'content-type': 'application/json' })
            res.end(JSON.stringify({ ok: false, error: '메시지를 보낼 수 없습니다.' }))
            return
          }
          for (const m of g.members) io.to('user:' + m).emit('dm:new', msg)
          res.writeHead(200, { 'content-type': 'application/json' })
          res.end(JSON.stringify({ ok: true, message: msg }))
          return
        }
        const to = typeof body.to === 'string' ? body.to : ''
        // 대상이 실재하는 사용자인지 확인(임의 id 로 고아 대화 생성 방지).
        if (!to || !auth.getHome(to)) {
          res.writeHead(400, { 'content-type': 'application/json' })
          res.end(JSON.stringify({ ok: false, error: '받는 사람을 찾을 수 없습니다.' }))
          return
        }
        const msg = dm.append(account.id, to, text)
        if (!msg) {
          res.writeHead(400, { 'content-type': 'application/json' })
          res.end(JSON.stringify({ ok: false, error: '메시지를 보낼 수 없습니다.' }))
          return
        }
        io.to('user:' + msg.to).emit('dm:new', msg)
        io.to('user:' + msg.from).emit('dm:new', msg)
        // 종 알림 — 상대별 최신 1건 유지(연속 메시지 도배 방지). 실시간 토스트는 dm:new 가 담당, 이건 누적 피드.
        notify(msg.to, { kind: 'dm', actor: actorOf(account), ref: account.id, text: msg.text })
        res.writeHead(200, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ ok: true, message: msg }))
      })
      return
    }
    // DM 수정 — 본인 메시지만. 본문 { token, peer, id, text }. 성공 시 양쪽 개인룸으로 반영.
    if (req.method === 'POST' && req.url === '/dm/edit') {
      void readJsonBody(req).then((body) => {
        const account = typeof body.token === 'string' ? auth.verifyToken(body.token) : null
        if (!account) {
          res.writeHead(401, { 'content-type': 'application/json' })
          res.end(JSON.stringify({ ok: false, error: '인증이 필요합니다.' }))
          return
        }
        const peer = typeof body.peer === 'string' ? body.peer : ''
        const id = typeof body.id === 'string' ? body.id : ''
        const text = typeof body.text === 'string' ? body.text : ''
        const threadId = typeof body.threadId === 'string' ? body.threadId : ''
        if (threadId) {
          const g = dm.group(threadId)
          const msg = g && g.members.includes(account.id) ? dm.editGroup(account.id, threadId, id, text) : null
          if (!msg || !g) {
            res.writeHead(400, { 'content-type': 'application/json' })
            res.end(JSON.stringify({ ok: false, error: '메시지를 수정할 수 없습니다.' }))
            return
          }
          for (const m of g.members) io.to('user:' + m).emit('dm:edited', msg)
          res.writeHead(200, { 'content-type': 'application/json' })
          res.end(JSON.stringify({ ok: true, message: msg }))
          return
        }
        const msg = dm.edit(account.id, peer, id, text)
        if (!msg) {
          res.writeHead(400, { 'content-type': 'application/json' })
          res.end(JSON.stringify({ ok: false, error: '메시지를 수정할 수 없습니다.' }))
          return
        }
        io.to('user:' + msg.to).emit('dm:edited', msg)
        io.to('user:' + msg.from).emit('dm:edited', msg)
        res.writeHead(200, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ ok: true, message: msg }))
      })
      return
    }
    // DM 삭제 — 본인 메시지만. 본문 { token, peer, id }. 성공 시 양쪽 개인룸에서 제거.
    if (req.method === 'POST' && req.url === '/dm/delete') {
      void readJsonBody(req).then((body) => {
        const account = typeof body.token === 'string' ? auth.verifyToken(body.token) : null
        if (!account) {
          res.writeHead(401, { 'content-type': 'application/json' })
          res.end(JSON.stringify({ ok: false, error: '인증이 필요합니다.' }))
          return
        }
        const peer = typeof body.peer === 'string' ? body.peer : ''
        const id = typeof body.id === 'string' ? body.id : ''
        const threadId = typeof body.threadId === 'string' ? body.threadId : ''
        if (threadId) {
          const g = dm.group(threadId)
          if (!g || !dm.removeGroup(account.id, threadId, id)) {
            res.writeHead(400, { 'content-type': 'application/json' })
            res.end(JSON.stringify({ ok: false, error: '메시지를 삭제할 수 없습니다.' }))
            return
          }
          for (const m of g.members) io.to('user:' + m).emit('dm:deleted', { id, from: account.id, to: '', threadId })
          res.writeHead(200, { 'content-type': 'application/json' })
          res.end(JSON.stringify({ ok: true }))
          return
        }
        if (!dm.remove(account.id, peer, id)) {
          res.writeHead(400, { 'content-type': 'application/json' })
          res.end(JSON.stringify({ ok: false, error: '메시지를 삭제할 수 없습니다.' }))
          return
        }
        io.to('user:' + peer).emit('dm:deleted', { id, from: account.id, to: peer })
        io.to('user:' + account.id).emit('dm:deleted', { id, from: account.id, to: peer })
        res.writeHead(200, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ ok: true }))
      })
      return
    }
    // DM 대화 개인 삭제(정리) — 본문 { token, peer }. 내 목록에서만 지우고(상대 유지), 양쪽 모두 지우면 서버 파일 삭제.
    if (req.method === 'POST' && req.url === '/dm/clear') {
      void readJsonBody(req).then((body) => {
        const account = typeof body.token === 'string' ? auth.verifyToken(body.token) : null
        if (!account) {
          res.writeHead(401, { 'content-type': 'application/json' })
          res.end(JSON.stringify({ ok: false, error: '인증이 필요합니다.' }))
          return
        }
        const peer = typeof body.peer === 'string' ? body.peer : ''
        const threadId = typeof body.threadId === 'string' ? body.threadId : ''
        if (threadId) {
          const ok = dm.clearForGroup(account.id, threadId)
          if (ok) io.to('user:' + account.id).emit('dm:cleared', { peer: '', by: account.id, threadId }) // 내 다른 세션 동기화
          res.writeHead(ok ? 200 : 400, { 'content-type': 'application/json' })
          res.end(JSON.stringify(ok ? { ok: true } : { ok: false, error: '대화를 정리할 수 없습니다.' }))
          return
        }
        const ok = dm.clearFor(account.id, peer)
        if (ok) io.to('user:' + account.id).emit('dm:cleared', { peer, by: account.id }) // 내 다른 세션 동기화
        res.writeHead(ok ? 200 : 400, { 'content-type': 'application/json' })
        res.end(JSON.stringify(ok ? { ok: true } : { ok: false, error: '대화를 정리할 수 없습니다.' }))
      })
      return
    }
    // DM 대화 내용 — 토큰 인증. 본문 { token, peer }.
    if (req.method === 'POST' && req.url === '/dm/thread') {
      void readJsonBody(req).then((body) => {
        const account = typeof body.token === 'string' ? auth.verifyToken(body.token) : null
        if (!account) {
          res.writeHead(401, { 'content-type': 'application/json' })
          res.end(JSON.stringify({ ok: false, error: '인증이 필요합니다.' }))
          return
        }
        const peer = typeof body.peer === 'string' ? body.peer : ''
        const threadId = typeof body.threadId === 'string' ? body.threadId : ''
        if (threadId) {
          const messages = dm.groupThread(account.id, threadId)
          if (messages === null) {
            // 비멤버 — 접근 거부(빈 대화와 구분).
            res.writeHead(403, { 'content-type': 'application/json' })
            res.end(JSON.stringify({ ok: false, error: '그룹 대화에 참여하고 있지 않습니다.' }))
            return
          }
          res.writeHead(200, { 'content-type': 'application/json' })
          res.end(JSON.stringify({ ok: true, messages }))
          return
        }
        const messages = peer ? dm.thread(account.id, peer) : []
        res.writeHead(200, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ ok: true, messages }))
      })
      return
    }
    // DM 대화 목록 — 토큰 인증. 상대 표시정보(닉·아바타) 동봉. 본문 { token }.
    if (req.method === 'POST' && req.url === '/dm/list') {
      void readJsonBody(req).then((body) => {
        const account = typeof body.token === 'string' ? auth.verifyToken(body.token) : null
        if (!account) {
          res.writeHead(401, { 'content-type': 'application/json' })
          res.end(JSON.stringify({ ok: false, error: '인증이 필요합니다.' }))
          return
        }
        const conversations = dm.list(account.id).map((c) => {
          const peer = auth.getHome(c.peerId)?.account
          return {
            ...c,
            name: peer ? peer.nickname || peer.username : '(알 수 없음)',
            avatar: peer?.avatar,
            online: visibleOnline(c.peerId),
            status: publicStatus(c.peerId)
          }
        })
        // 그룹 대화 — 멤버 표시정보 동봉(정원 16이라 부담 없음). 구클라는 이 필드를 몰라 무시(하위호환).
        const groups = dm.listGroups(account.id).map((g) => ({
          threadId: g.threadId,
          title: g.title,
          last: g.last,
          lastFrom: g.lastFrom,
          updatedAt: g.updatedAt,
          members: g.members.map((id) => {
            const a = auth.getHome(id)?.account
            return {
              id,
              name: a ? a.nickname || a.username : '(알 수 없음)',
              avatar: a?.avatar,
              online: visibleOnline(id)
            }
          })
        }))
        res.writeHead(200, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ ok: true, conversations, groups }))
      })
      return
    }

    // 그룹 DM 생성 — 본문 { token, members: string[], title? }. 본인 자동 포함, 총원 2~16.
    if (req.method === 'POST' && req.url === '/dm/group/create') {
      void readJsonBody(req).then((body) => {
        const account = typeof body.token === 'string' ? auth.verifyToken(body.token) : null
        if (!account) {
          res.writeHead(401, { 'content-type': 'application/json' })
          res.end(JSON.stringify({ ok: false, error: '인증이 필요합니다.' }))
          return
        }
        // 그룹 양산 스팸 방지 — DM 공용 버킷 소비.
        const now = Date.now()
        const rl = dmRate.get(account.id)
        if (!rl || now > rl.resetAt) {
          dmRate.set(account.id, { count: 1, resetAt: now + 10_000 })
        } else if (rl.count >= 30) {
          res.writeHead(429, { 'content-type': 'application/json' })
          res.end(JSON.stringify({ ok: false, error: '너무 자주 요청했어요. 잠시 후 다시 시도하세요.' }))
          return
        } else {
          rl.count++
        }
        const members = Array.isArray(body.members)
          ? (body.members as unknown[]).filter((x): x is string => typeof x === 'string' && !!x)
          : []
        if (members.some((id) => id !== account.id && !auth.getHome(id))) {
          res.writeHead(400, { 'content-type': 'application/json' })
          res.end(JSON.stringify({ ok: false, error: '초대할 사용자를 찾을 수 없습니다.' }))
          return
        }
        const title = typeof body.title === 'string' ? body.title : undefined
        const g = dm.createGroup(account.id, members, title)
        if (!g) {
          res.writeHead(400, { 'content-type': 'application/json' })
          res.end(
            JSON.stringify({ ok: false, error: `그룹은 본인 포함 2~${MAX_GROUP_MEMBERS}명으로 만들 수 있습니다.` })
          )
          return
        }
        for (const m of g.members) io.to('user:' + m).emit('dm:group:update', { threadId: g.threadId })
        res.writeHead(200, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ ok: true, group: g }))
      })
      return
    }
    // 그룹 DM 초대 — 본문 { token, threadId, userId }. 멤버 누구나 초대 가능(합류 이전 히스토리는 가림).
    if (req.method === 'POST' && req.url === '/dm/group/invite') {
      void readJsonBody(req).then((body) => {
        const account = typeof body.token === 'string' ? auth.verifyToken(body.token) : null
        if (!account) {
          res.writeHead(401, { 'content-type': 'application/json' })
          res.end(JSON.stringify({ ok: false, error: '인증이 필요합니다.' }))
          return
        }
        const threadId = typeof body.threadId === 'string' ? body.threadId : ''
        const userId = typeof body.userId === 'string' ? body.userId : ''
        if (!userId || !auth.getHome(userId)) {
          res.writeHead(400, { 'content-type': 'application/json' })
          res.end(JSON.stringify({ ok: false, error: '초대할 사용자를 찾을 수 없습니다.' }))
          return
        }
        const g = dm.invite(account.id, threadId, userId)
        if (!g) {
          res.writeHead(400, { 'content-type': 'application/json' })
          res.end(JSON.stringify({ ok: false, error: '초대할 수 없습니다(이미 멤버이거나 정원 초과).' }))
          return
        }
        for (const m of g.members) io.to('user:' + m).emit('dm:group:update', { threadId: g.threadId })
        res.writeHead(200, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ ok: true, group: g }))
      })
      return
    }
    // 그룹 DM 나가기 — 본문 { token, threadId }. 마지막 멤버가 나가면 파일 삭제.
    if (req.method === 'POST' && req.url === '/dm/group/leave') {
      void readJsonBody(req).then((body) => {
        const account = typeof body.token === 'string' ? auth.verifyToken(body.token) : null
        if (!account) {
          res.writeHead(401, { 'content-type': 'application/json' })
          res.end(JSON.stringify({ ok: false, error: '인증이 필요합니다.' }))
          return
        }
        const threadId = typeof body.threadId === 'string' ? body.threadId : ''
        const r = dm.leave(account.id, threadId)
        if (!r.ok) {
          res.writeHead(400, { 'content-type': 'application/json' })
          res.end(JSON.stringify({ ok: false, error: '그룹에서 나갈 수 없습니다.' }))
          return
        }
        // 잔존 멤버 + 탈퇴자 본인(멀티세션 동기화 — 재조회 시 목록에서 사라짐)에게 통지.
        for (const m of [...r.remaining, account.id]) io.to('user:' + m).emit('dm:group:update', { threadId })
        res.writeHead(200, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ ok: true }))
      })
      return
    }

    // 알림 목록 — 본문 { token }. 최신순 + 미읽음 수.
    if (req.method === 'POST' && req.url === '/notif/list') {
      void readJsonBody(req).then((body) => {
        const account = typeof body.token === 'string' ? auth.verifyToken(body.token) : null
        if (!account) {
          res.writeHead(401, { 'content-type': 'application/json' })
          res.end(JSON.stringify({ ok: false, error: '인증이 필요합니다.' }))
          return
        }
        res.writeHead(200, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ ok: true, notifications: notif.list(account.id), unread: notif.unreadCount(account.id) }))
      })
      return
    }
    // 알림 읽음 처리 — 본문 { token, ids? }. ids 없으면 전체 읽음(본인 피드만 — 서버 권위).
    if (req.method === 'POST' && req.url === '/notif/read') {
      void readJsonBody(req).then((body) => {
        const account = typeof body.token === 'string' ? auth.verifyToken(body.token) : null
        if (!account) {
          res.writeHead(401, { 'content-type': 'application/json' })
          res.end(JSON.stringify({ ok: false, error: '인증이 필요합니다.' }))
          return
        }
        const ids = Array.isArray(body.ids)
          ? (body.ids as unknown[]).filter((x): x is string => typeof x === 'string')
          : undefined
        notif.markRead(account.id, ids)
        res.writeHead(200, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ ok: true }))
      })
      return
    }
    // 알림 전체 지우기 — 본문 { token }. 본인 피드만 비운다(서버 권위).
    if (req.method === 'POST' && req.url === '/notif/clear') {
      void readJsonBody(req).then((body) => {
        const account = typeof body.token === 'string' ? auth.verifyToken(body.token) : null
        if (!account) {
          res.writeHead(401, { 'content-type': 'application/json' })
          res.end(JSON.stringify({ ok: false, error: '인증이 필요합니다.' }))
          return
        }
        notif.clear(account.id)
        res.writeHead(200, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ ok: true }))
      })
      return
    }

    // ===== 블로그/게시글 — 자기 로비의 글. 목록/상세는 토큰 선택(있으면 작성자 권한·내 좋아요 반영). =====
    // 글 목록 — 본문 { token?, target }. 작성자 본인이면 비공개·임시저장 포함, 아니면 공개·비임시만.
    if (req.method === 'POST' && req.url === '/posts/list') {
      void readJsonBody(req).then((body) => {
        const viewer = typeof body.token === 'string' ? auth.verifyToken(body.token) : null
        const target = typeof body.target === 'string' ? body.target : ''
        const result = posts.listFor(viewer?.id ?? null, target)
        res.writeHead(200, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ ok: true, ...result }))
      })
      return
    }
    // 글 상세 — 본문 { token?, id }. 비공개/임시저장은 작성자만(아니면 404).
    if (req.method === 'POST' && req.url === '/post/get') {
      void readJsonBody(req).then((body) => {
        const viewer = typeof body.token === 'string' ? auth.verifyToken(body.token) : null
        const id = typeof body.id === 'string' ? body.id : ''
        const r = posts.get(viewer?.id ?? null, id)
        if (!r) {
          res.writeHead(404, { 'content-type': 'application/json' })
          res.end(JSON.stringify({ ok: false, error: '글을 찾을 수 없습니다.' }))
          return
        }
        res.writeHead(200, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ ok: true, post: r.post, liked: r.liked }))
      })
      return
    }
    // 글 작성/수정 — 토큰 인증. 본문 { token, post }. 본문 HTML 은 저장 시 화이트리스트 정규화.
    if (req.method === 'POST' && req.url === '/post/save') {
      void readJsonBody(req).then((body) => {
        const account = typeof body.token === 'string' ? auth.verifyToken(body.token) : null
        if (!account) {
          res.writeHead(401, { 'content-type': 'application/json' })
          res.end(JSON.stringify({ ok: false, error: '인증이 필요합니다.' }))
          return
        }
        if (account.role === 'guest') {
          res.writeHead(403, { 'content-type': 'application/json' })
          res.end(JSON.stringify({ ok: false, error: '손님 계정은 블로그 글을 쓸 수 없습니다.' }))
          return
        }
        const input = body.post && typeof body.post === 'object' ? (body.post as Record<string, unknown>) : {}
        const result = posts.save(account.id, input)
        res.writeHead(result.ok ? 200 : 400, { 'content-type': 'application/json' })
        res.end(JSON.stringify(result))
      })
      return
    }
    // 글 삭제 — 토큰 인증(작성자). 본문 { token, id }.
    if (req.method === 'POST' && req.url === '/post/delete') {
      void readJsonBody(req).then((body) => {
        const account = typeof body.token === 'string' ? auth.verifyToken(body.token) : null
        if (!account) {
          res.writeHead(401, { 'content-type': 'application/json' })
          res.end(JSON.stringify({ ok: false, error: '인증이 필요합니다.' }))
          return
        }
        const id = typeof body.id === 'string' ? body.id : ''
        const ok = posts.remove(account.id, id)
        res.writeHead(ok ? 200 : 400, { 'content-type': 'application/json' })
        res.end(JSON.stringify(ok ? { ok: true } : { ok: false, error: '삭제할 수 없습니다(작성자만).' }))
      })
      return
    }
    // 좋아요 토글 — 토큰 인증(누구나). 본문 { token, id }.
    if (req.method === 'POST' && req.url === '/post/like') {
      void readJsonBody(req).then((body) => {
        const account = typeof body.token === 'string' ? auth.verifyToken(body.token) : null
        if (!account) {
          res.writeHead(401, { 'content-type': 'application/json' })
          res.end(JSON.stringify({ ok: false, error: '인증이 필요합니다.' }))
          return
        }
        const id = typeof body.id === 'string' ? body.id : ''
        const r = posts.toggleLike(account.id, id)
        if (!r) {
          res.writeHead(400, { 'content-type': 'application/json' })
          res.end(JSON.stringify({ ok: false, error: '처리할 수 없습니다.' }))
          return
        }
        res.writeHead(200, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ ok: true, ...r }))
      })
      return
    }
    // 댓글 작성 — 토큰 인증(누구나). 본문 { token, postId, text }.
    if (req.method === 'POST' && req.url === '/post/comment') {
      void readJsonBody(req).then((body) => {
        const account = typeof body.token === 'string' ? auth.verifyToken(body.token) : null
        if (!account) {
          res.writeHead(401, { 'content-type': 'application/json' })
          res.end(JSON.stringify({ ok: false, error: '인증이 필요합니다.' }))
          return
        }
        // 레이트리밋 — 댓글 도배가 글 주인의 알림 피드를 밀어내지(축출) 않게(방명록과 동일 버킷).
        if (socialLimited(account.id, res)) return
        const postId = typeof body.postId === 'string' ? body.postId : ''
        const text = typeof body.text === 'string' ? body.text : ''
        const parentId = typeof body.parentId === 'string' ? body.parentId : undefined
        const r = posts.addComment(
          { id: account.id, name: account.nickname || account.username, avatar: account.avatar },
          postId,
          text,
          parentId
        )
        if (!r) {
          res.writeHead(400, { 'content-type': 'application/json' })
          res.end(JSON.stringify({ ok: false, error: '댓글을 남길 수 없습니다.' }))
          return
        }
        // 종 알림 — 답글이면 부모 댓글 작성자에게 reply, 글 주인에게는 comment(부모 작성자=글 주인이면 reply 1건만).
        // notify(push)가 자기 알림을 걸러주므로 셀프 댓글·셀프 답글은 자연 무시된다.
        const actor = actorOf(account)
        if (r.parentAuthorId) notify(r.parentAuthorId, { kind: 'reply', actor, ref: r.post.id, text: r.comment.text })
        if (r.post.authorId !== r.parentAuthorId) {
          notify(r.post.authorId, { kind: 'comment', actor, ref: r.post.id, text: r.comment.text })
        }
        res.writeHead(200, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ ok: true, comment: r.comment }))
      })
      return
    }
    // 댓글 수정 — 토큰 인증(작성자). 본문 { token, postId, commentId, text }.
    if (req.method === 'POST' && req.url === '/post/comment/edit') {
      void readJsonBody(req).then((body) => {
        const account = typeof body.token === 'string' ? auth.verifyToken(body.token) : null
        if (!account) {
          res.writeHead(401, { 'content-type': 'application/json' })
          res.end(JSON.stringify({ ok: false, error: '인증이 필요합니다.' }))
          return
        }
        const postId = typeof body.postId === 'string' ? body.postId : ''
        const commentId = typeof body.commentId === 'string' ? body.commentId : ''
        const text = typeof body.text === 'string' ? body.text : ''
        const comment = posts.editComment(account.id, postId, commentId, text)
        if (!comment) {
          res.writeHead(400, { 'content-type': 'application/json' })
          res.end(JSON.stringify({ ok: false, error: '댓글을 수정할 수 없습니다.' }))
          return
        }
        res.writeHead(200, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ ok: true, comment }))
      })
      return
    }
    // 댓글 삭제 — 토큰 인증(댓글 작성자 또는 글 주인). 본문 { token, postId, commentId }.
    if (req.method === 'POST' && req.url === '/post/comment/delete') {
      void readJsonBody(req).then((body) => {
        const account = typeof body.token === 'string' ? auth.verifyToken(body.token) : null
        if (!account) {
          res.writeHead(401, { 'content-type': 'application/json' })
          res.end(JSON.stringify({ ok: false, error: '인증이 필요합니다.' }))
          return
        }
        const postId = typeof body.postId === 'string' ? body.postId : ''
        const commentId = typeof body.commentId === 'string' ? body.commentId : ''
        const ok = posts.removeComment(account.id, postId, commentId)
        res.writeHead(ok ? 200 : 400, { 'content-type': 'application/json' })
        res.end(JSON.stringify(ok ? { ok: true } : { ok: false, error: '댓글을 삭제할 수 없습니다.' }))
      })
      return
    }
    // 게시판 목록 교체 — 토큰 인증(작성자). 본문 { token, boards }. 사라진 게시판의 글은 미분류로.
    if (req.method === 'POST' && req.url === '/boards/set') {
      void readJsonBody(req).then((body) => {
        const account = typeof body.token === 'string' ? auth.verifyToken(body.token) : null
        if (!account) {
          res.writeHead(401, { 'content-type': 'application/json' })
          res.end(JSON.stringify({ ok: false, error: '인증이 필요합니다.' }))
          return
        }
        if (account.role === 'guest') {
          res.writeHead(403, { 'content-type': 'application/json' })
          res.end(JSON.stringify({ ok: false, error: '손님 계정은 블로그를 관리할 수 없습니다.' }))
          return
        }
        const boards = posts.setBoards(account.id, body.boards)
        res.writeHead(200, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ ok: true, boards }))
      })
      return
    }

    // ===== 세션 로그 — 방 채팅 로그를 로비에 백업한 스냅샷. 본문은 sandbox iframe 으로 격리 렌더(화이트리스트 X). =====
    // 목록 — 본문 { token?, target }. 작성자 본인이면 비공개 포함, 아니면 공개만.
    if (req.method === 'POST' && req.url === '/slogs/list') {
      void readJsonBody(req).then((body) => {
        const viewer = typeof body.token === 'string' ? auth.verifyToken(body.token) : null
        const target = typeof body.target === 'string' ? body.target : ''
        const result = sessionlogs.listFor(viewer?.id ?? null, target)
        res.writeHead(200, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ ok: true, ...result }))
      })
      return
    }
    // 상세 — 본문 { token?, id }. 비공개는 작성자만(아니면 404).
    if (req.method === 'POST' && req.url === '/slog/get') {
      void readJsonBody(req).then((body) => {
        const viewer = typeof body.token === 'string' ? auth.verifyToken(body.token) : null
        const id = typeof body.id === 'string' ? body.id : ''
        const r = sessionlogs.get(viewer?.id ?? null, id)
        if (!r) {
          res.writeHead(404, { 'content-type': 'application/json' })
          res.end(JSON.stringify({ ok: false, error: '세션 로그를 찾을 수 없습니다.' }))
          return
        }
        res.writeHead(200, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ ok: true, log: r.log }))
      })
      return
    }
    // 백업 생성/수정 — 토큰 인증. 본문 { token, log }. 새 백업은 html(외부화된 자기완결 문서) 필요,
    // id 있으면 수정(html 은 로비 편집기가 보낼 때만 본문 교체 — 새니타이저 재통과, 없으면 메타만).
    if (req.method === 'POST' && req.url === '/slog/save') {
      void readJsonBody(req).then((body) => {
        const account = typeof body.token === 'string' ? auth.verifyToken(body.token) : null
        if (!account) {
          res.writeHead(401, { 'content-type': 'application/json' })
          res.end(JSON.stringify({ ok: false, error: '인증이 필요합니다.' }))
          return
        }
        if (account.role === 'guest') {
          res.writeHead(403, { 'content-type': 'application/json' })
          res.end(JSON.stringify({ ok: false, error: '손님 계정은 세션 로그를 백업할 수 없습니다.' }))
          return
        }
        const input = body.log && typeof body.log === 'object' ? (body.log as Record<string, unknown>) : {}
        const result = sessionlogs.save(account.id, input)
        res.writeHead(result.ok ? 200 : 400, { 'content-type': 'application/json' })
        res.end(JSON.stringify(result))
      })
      return
    }
    // 삭제 — 토큰 인증(작성자). 본문 { token, id }.
    if (req.method === 'POST' && req.url === '/slog/delete') {
      void readJsonBody(req).then((body) => {
        const account = typeof body.token === 'string' ? auth.verifyToken(body.token) : null
        if (!account) {
          res.writeHead(401, { 'content-type': 'application/json' })
          res.end(JSON.stringify({ ok: false, error: '인증이 필요합니다.' }))
          return
        }
        const id = typeof body.id === 'string' ? body.id : ''
        const ok = sessionlogs.remove(account.id, id)
        res.writeHead(ok ? 200 : 400, { 'content-type': 'application/json' })
        res.end(JSON.stringify(ok ? { ok: true } : { ok: false, error: '삭제할 수 없습니다(작성자만).' }))
      })
      return
    }
    // 세션 로그 게시판 목록 교체 — 토큰 인증(작성자). 본문 { token, boards }. 블로그와 별도 목록.
    if (req.method === 'POST' && req.url === '/slogs/boards/set') {
      void readJsonBody(req).then((body) => {
        const account = typeof body.token === 'string' ? auth.verifyToken(body.token) : null
        if (!account) {
          res.writeHead(401, { 'content-type': 'application/json' })
          res.end(JSON.stringify({ ok: false, error: '인증이 필요합니다.' }))
          return
        }
        if (account.role === 'guest') {
          res.writeHead(403, { 'content-type': 'application/json' })
          res.end(JSON.stringify({ ok: false, error: '손님 계정은 세션 로그를 관리할 수 없습니다.' }))
          return
        }
        const boards = sessionlogs.setBoards(account.id, body.boards)
        res.writeHead(200, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ ok: true, boards }))
      })
      return
    }

    // ===== 친구 — 아이디로 신청·수락·거절·끊기·목록(손님 포함 누구나). 변경 시 상대에게 friend:update 푸시. =====
    if (req.method === 'POST' && req.url === '/friend/request') {
      void readJsonBody(req).then((body) => {
        const token = typeof body.token === 'string' ? body.token : ''
        const username = typeof body.username === 'string' ? body.username : ''
        const r = auth.friendRequest(token, username)
        if (r.ok) {
          if (r.targetId) io.to('user:' + r.targetId).emit('friend:update')
          if (r.selfId) io.to('user:' + r.selfId).emit('friend:update') // 본인 다른 기기 동기화
          // 종 알림 — 자동수락(상대가 먼저 신청해 둔 경우)이면 '수락', 아니면 '신청 도착'.
          const actor = typeof body.token === 'string' ? auth.verifyToken(body.token) : null
          if (actor && r.targetId) {
            notify(r.targetId, {
              kind: 'friend',
              actor: actorOf(actor),
              ref: actor.id,
              text: r.autoAccepted ? '친구 신청을 수락했어요.' : '친구 신청을 보냈어요.'
            })
          }
        }
        res.writeHead(r.ok ? 200 : 400, JSON_H)
        res.end(JSON.stringify(r))
      })
      return
    }
    // 친구 검색 — 본문 { token, q }. 아이디/닉네임 부분 일치 후보(동명이인 나열 — 클라가 선택해 신청).
    if (req.method === 'POST' && req.url === '/friend/search') {
      void readJsonBody(req).then((body) => {
        const account = typeof body.token === 'string' ? auth.verifyToken(body.token) : null
        if (!account) {
          res.writeHead(401, JSON_H)
          res.end(JSON.stringify({ ok: false, error: '인증이 필요합니다.' }))
          return
        }
        const q = (typeof body.q === 'string' ? body.q : '').trim().toLowerCase()
        if (q.length < 1) {
          res.writeHead(200, JSON_H)
          res.end(JSON.stringify({ ok: true, users: [] }))
          return
        }
        // 서버측 필터 — 전체 디렉터리를 클라로 보내지 않는다. 본인 제외, 최대 20명.
        const users = auth
          .listUsers()
          .filter(
            (u) =>
              u.id !== account.id &&
              (u.username.toLowerCase().includes(q) || (u.nickname ?? '').toLowerCase().includes(q))
          )
          .slice(0, 20)
          .map((u) => ({ ...u, online: visibleOnline(u.id) }))
        res.writeHead(200, JSON_H)
        res.end(JSON.stringify({ ok: true, users }))
      })
      return
    }
    if (
      req.method === 'POST' &&
      (req.url === '/friend/accept' || req.url === '/friend/reject' || req.url === '/friend/remove')
    ) {
      const url = req.url
      void readJsonBody(req).then((body) => {
        const token = typeof body.token === 'string' ? body.token : ''
        const userId = typeof body.userId === 'string' ? body.userId : ''
        const r =
          url === '/friend/accept'
            ? auth.acceptFriend(token, userId)
            : url === '/friend/reject'
              ? auth.rejectFriend(token, userId)
              : auth.removeFriend(token, userId)
        if (r.ok) {
          if (r.targetId) io.to('user:' + r.targetId).emit('friend:update')
          if (r.selfId) io.to('user:' + r.selfId).emit('friend:update') // 본인 다른 기기 동기화
          // 종 알림 — 수락만(거절·끊기는 조용히).
          if (url === '/friend/accept' && r.targetId) {
            const actor = auth.verifyToken(token)
            if (actor) {
              notify(r.targetId, {
                kind: 'friend',
                actor: actorOf(actor),
                ref: actor.id,
                text: '친구 신청을 수락했어요.'
              })
            }
          }
        }
        res.writeHead(r.ok ? 200 : 400, JSON_H)
        res.end(JSON.stringify(r))
      })
      return
    }
    if (req.method === 'POST' && req.url === '/friend/list') {
      void readJsonBody(req).then((body) => {
        const token = typeof body.token === 'string' ? body.token : ''
        const r = auth.friendList(token)
        if (!r.ok) {
          res.writeHead(400, JSON_H)
          res.end(JSON.stringify(r))
          return
        }
        // 온라인·상태 표시는 프레즌스 헬퍼로 덧붙인다(invisible=오프라인 위장).
        const withOnline = (arr: { id: string }[]): unknown[] =>
          arr.map((u) => ({ ...u, online: visibleOnline(u.id), status: publicStatus(u.id) }))
        res.writeHead(200, JSON_H)
        res.end(
          JSON.stringify({
            ok: true,
            friends: withOnline(r.friends),
            incoming: withOnline(r.incoming),
            outgoing: withOnline(r.outgoing)
          })
        )
      })
      return
    }

    // ===== 서버 관리(관리자 전용) — 호스팅 용량 모니터링·회수 =====
    // 멤버별 용량 상세 + 서버 전체 요약. 1회 전역 스캔(방·캐릭터·블로그·로비/프로필 참조 + 자산 크기).
    if (req.method === 'POST' && req.url === '/admin/overview') {
      void readJsonBody(req).then((body) => {
        if (!requireAdmin(body, res)) return
        const accountsList = auth.listForAdmin()
        const online = new Set(presence.keys())
        // 유저별 카테고리 바이트 + 참조 자산 해시 집합.
        const per = accountsList.map((u) => {
          const rooms = store.usageForOwner(u.id)
          const chars = characters.usageFor(u.id)
          const blog = posts.usageFor(u.id)
          const slog = sessionlogs.usageFor(u.id)
          const prof = auth.usageForUser(u.id)
          const dt = dottown.usageFor(u.id) // 도트타운 마이룸·캐릭터(메타) 용량
          const econ = economy.usageFor(u.id) // 도트타운 코인 지갑·소유·원장(메타) 용량
          const refs = new Set<string>([...rooms.refs, ...chars.refs, ...blog.refs, ...slog.refs, ...prof.refs, ...dt.refs])
          return { u, rooms, chars, blog, slog, prof, dt, econ, refs }
        })
        // 전역 참조 카운트(고유 판정용) — 한 해시를 몇 명이 참조하는지.
        const refCount = new Map<string, number>()
        for (const p of per) for (const h of p.refs) refCount.set(h, (refCount.get(h) ?? 0) + 1)
        const sizes = assets.sizesOf(refCount.keys()) // 참조 해시 크기 일괄 조회(중복 제거)
        const sizeOf = (h: string): number => sizes.get(h) ?? 0
        const users = per.map(({ u, rooms, chars, blog, slog, prof, dt, econ, refs }) => {
          let assetLogical = 0
          let assetUnique = 0
          for (const h of refs) {
            const sz = sizeOf(h)
            assetLogical += sz
            if (refCount.get(h) === 1) assetUnique += sz // 이 유저만 참조 → 삭제 시 실제 회수될 바이트
          }
          // '로비' 컬럼은 로비 스냅샷만(= '로비 초기화' 회수 범위와 일치). 프로필(아바타·배너·방명록)은 별도로
          // 합계에 포함하되 컬럼엔 안 섞는다 — 컬럼이 약속한 만큼 초기화로 회수되게 한다.
          // 커뮤니티는 조직 소유라 글은 계정 삭제로 사라지지 않지만, 용량은 올린 사람 앞으로 잡아 준다.
          const cmty = cmtyPosts.usageFor(u.id)
          const cmtyC = cmtyChars.usageFor(u.id)
          const serialized = rooms.bytes + chars.bytes + blog.bytes + slog.bytes + prof.lobbyBytes + prof.profileBytes + dt.bytes + econ.bytes + cmty.bytes + cmtyC.bytes
          return {
            id: u.id,
            username: u.username,
            nickname: u.nickname,
            avatar: u.avatar,
            role: u.role,
            createdAt: u.createdAt,
            lastSeenAt: u.lastSeenAt, // 마지막 접속 일시(로그인·연결/종료 시 갱신)
            online: online.has(u.id),
            // 관리자 대시보드는 실상태(invisible 포함) — 서버 소유자는 어차피 로그로 확인 가능(운영 목적, 위장 대상 아님).
            status: effectiveStatus(u.id) ?? undefined,
            rooms: { count: rooms.count, bytes: rooms.bytes },
            roomList: rooms.list, // 개별 방 삭제용(id·제목·코드·바이트)
            characters: { count: chars.count, bytes: chars.bytes },
            posts: { count: blog.count, bytes: blog.bytes },
            sessionlogs: { count: slog.count, bytes: slog.bytes },
            lobbyBytes: prof.lobbyBytes,
            profileBytes: prof.profileBytes,
            dottownBytes: dt.bytes + econ.bytes,
            communityBytes: cmty.bytes + cmtyC.bytes,
            coins: economy.balanceOf(u.id),
            assetBytesLogical: assetLogical,
            assetBytesUnique: assetUnique,
            totalLogical: serialized + assetLogical
          }
        })
        // 서버 전체: 총 자산 디스크 + 라이브(참조됨) + 고아(아무도 참조 안 함 = GC 회수 대상).
        // 라이브 집합은 /admin/gc 의 sweep 과 동일한 전역 참조(소유자 유무 무관)로 계산한다(per-user 분해는 위 refCount 로 별도).
        // orphanBytes 는 회수 가능량의 상한 — sweep 은 막 업로드된(유예 1시간 내) 미참조 자산은 보존하므로 즉시 회수량은 더 작을 수 있다.
        const total = assets.totalBytes()
        const globalLive = new Set<string>()
        store.collectAssetRefs(globalLive)
        characters.collectAssetRefs(globalLive)
        auth.collectAssetRefs(globalLive)
        posts.collectAssetRefs(globalLive)
        sessionlogs.collectAssetRefs(globalLive)
        dottown.collectAssetRefs(globalLive) // /admin/gc 와 동일 라이브셋(방명록 authorAvatar 등)
        market.collectAssetRefs(globalLive) // ⚠UGC 마켓: 등록/보유 아이템 이미지(안 실으면 1시간 후 회수)
        community.collectAssetRefs(globalLive)
        cmtyPosts.collectAssetRefs(globalLive)
        cmtyChars.collectAssetRefs(globalLive) // ⚠커뮤니티 이미지(설정·글·캐릭터) — 안 실으면 회수된다
        cmtyCatalog.collectAssetRefs(globalLive) // ⚠아이템 그림·상점 배너
        cmtyGifts.collectAssetRefs(globalLive) // ⚠보내는 중인 선물의 편지 그림
        cmtyGames.collectAssetRefs(globalLive) // ⚠퀘스트 배너·완료 카드·장면 그림
        const liveSizes = assets.sizesOf(globalLive)
        let liveBytes = 0
        for (const h of globalLive) liveBytes += liveSizes.get(h) ?? 0
        const summary = {
          accountCount: accountsList.length,
          roomCount: store.roomCount,
          assetCount: total.count,
          assetBytes: total.bytes,
          liveAssetBytes: liveBytes,
          orphanBytes: Math.max(0, total.bytes - liveBytes)
        }
        res.writeHead(200, JSON_H)
        // 저장이 말썽인 방은 반드시 눈에 띄어야 한다 — 그대로 두면 재시작하는 순간 그 사이 대화가 사라진다.
        res.end(
          JSON.stringify({
            ok: true,
            summary,
            users,
            communityEnabled: community.enabled(),
            // 커뮤니티 성격 — 아직 안 열었으면 null. 서버 관리 화면의 전환 손잡이가 쓴다.
            communityMode: community.settings()?.mode ?? null,
            saveTroubles: store.saveTroubles()
          })
        )
      })
      return
    }

    // 커뮤니티 기능 켬/끔 — 서버 주인만. 꺼 두면 모든 유저의 바탕화면에서 아이콘까지 사라진다.
    if (req.method === 'POST' && req.url === '/admin/community') {
      void readJsonBody(req).then((body) => {
        if (!requireAdmin(body, res)) return
        if (typeof body.enabled === 'boolean') community.setEnabled(body.enabled)
        res.writeHead(200, JSON_H)
        res.end(JSON.stringify({ ok: true, enabled: community.enabled() }))
      })
      return
    }

    // 등급 변경(승인 member / 강등 guest) — 대상 접속 세션에 즉시 반영(소켓 data 갱신 + role:changed 푸시).
    if (req.method === 'POST' && req.url === '/admin/role') {
      void readJsonBody(req).then((body) => {
        if (!requireAdmin(body, res)) return
        const userId = typeof body.userId === 'string' ? body.userId : ''
        const role = body.role === 'member' ? 'member' : body.role === 'guest' ? 'guest' : null
        if (!role) {
          res.writeHead(400, JSON_H)
          res.end(JSON.stringify({ ok: false, error: '잘못된 등급입니다.' }))
          return
        }
        const r = auth.setRole(userId, role)
        if (!r.ok) {
          res.writeHead(400, JSON_H)
          res.end(JSON.stringify(r))
          return
        }
        for (const s of io.sockets.sockets.values()) {
          if (s.data.account?.id === userId) {
            s.data.account.role = role
            s.emit('role:changed', { role })
          }
        }
        res.writeHead(200, JSON_H)
        res.end(JSON.stringify({ ok: true, account: r.account }))
      })
      return
    }

    // 로그인 아이디(username) 변경 — 관리자. 대상 접속 세션에 즉시 반영(소켓 data 갱신 + account:renamed 푸시).
    // id(내부 UUID)는 불변이라 라우팅·소유관계는 그대로 — 토큰도 id 기반이라 대상은 로그아웃되지 않는다.
    if (req.method === 'POST' && req.url === '/admin/username') {
      void readJsonBody(req).then((body) => {
        if (!requireAdmin(body, res)) return
        const userId = typeof body.userId === 'string' ? body.userId : ''
        const username = typeof body.username === 'string' ? body.username : ''
        const r = auth.setUsername(userId, username)
        if (!r.ok) {
          res.writeHead(400, JSON_H)
          res.end(JSON.stringify(r))
          return
        }
        for (const s of io.sockets.sockets.values()) {
          if (s.data.account?.id === userId) {
            s.data.account.username = r.account.username
            s.emit('account:renamed', { username: r.account.username })
          }
        }
        res.writeHead(200, JSON_H)
        res.end(JSON.stringify({ ok: true, account: r.account }))
      })
      return
    }

    // 유저 세션방 1개 강제 삭제 — 소유자 검증 없이 제거 + 참가자 강제 퇴장.
    if (req.method === 'POST' && req.url === '/admin/room/delete') {
      void readJsonBody(req).then((body) => {
        if (!requireAdmin(body, res)) return
        const roomId = typeof body.roomId === 'string' ? body.roomId : ''
        const del = store.adminDeleteRoom(roomId)
        if (!del) {
          res.writeHead(404, JSON_H)
          res.end(JSON.stringify({ ok: false, error: '세션방을 찾을 수 없습니다.' }))
          return
        }
        for (const pid of del.participants) {
          io.to('user:' + pid).emit('room:closed', '관리자가 세션을 삭제했습니다.')
          void io.in('user:' + pid).socketsLeave(roomId)
          syncPresence(pid) // '세션중' 표시 해제
        }
        res.writeHead(200, JSON_H)
        res.end(JSON.stringify({ ok: true }))
      })
      return
    }

    // 유저 로비 꾸밈 초기화 — 공개 로비 스냅샷 제거(고아 자산은 이후 GC 회수).
    if (req.method === 'POST' && req.url === '/admin/lobby/clear') {
      void readJsonBody(req).then((body) => {
        if (!requireAdmin(body, res)) return
        const userId = typeof body.userId === 'string' ? body.userId : ''
        const ok = auth.adminClearLobby(userId)
        res.writeHead(ok ? 200 : 404, JSON_H)
        res.end(JSON.stringify(ok ? { ok: true } : { ok: false, error: '대상 계정을 찾을 수 없습니다.' }))
      })
      return
    }

    // 유저 캐릭터 전부 삭제 — 대상의 접속 세션엔 빈 라이브러리를 즉시 반영.
    if (req.method === 'POST' && req.url === '/admin/chars/delete') {
      void readJsonBody(req).then((body) => {
        if (!requireAdmin(body, res)) return
        const userId = typeof body.userId === 'string' ? body.userId : ''
        const n = characters.removeAll(userId)
        // 빈 char:library 는 클라에서 '신규 계정 시드'로 해석돼 로컬 캐릭터를 되올린다 — 전용 char:wiped 로 로컬도 비운다.
        io.to('acct:' + userId).emit('char:wiped')
        res.writeHead(200, JSON_H)
        res.end(JSON.stringify({ ok: true, removed: n }))
      })
      return
    }

    // 유저 블로그 전부 삭제.
    if (req.method === 'POST' && req.url === '/admin/posts/delete') {
      void readJsonBody(req).then((body) => {
        if (!requireAdmin(body, res)) return
        const userId = typeof body.userId === 'string' ? body.userId : ''
        posts.removeAll(userId)
        res.writeHead(200, JSON_H)
        res.end(JSON.stringify({ ok: true }))
      })
      return
    }

    // 유저 세션 로그 전부 삭제.
    if (req.method === 'POST' && req.url === '/admin/sessionlogs/delete') {
      void readJsonBody(req).then((body) => {
        if (!requireAdmin(body, res)) return
        const userId = typeof body.userId === 'string' ? body.userId : ''
        sessionlogs.removeAll(userId)
        res.writeHead(200, JSON_H)
        res.end(JSON.stringify({ ok: true }))
      })
      return
    }

    // 유저 계정+전체 데이터 완전 삭제 — /auth/delete 연쇄와 동일하나 관리자 권한으로(비밀번호 없이). admin 대상은 거부.
    if (req.method === 'POST' && req.url === '/admin/user/purge') {
      void readJsonBody(req).then((body) => {
        if (!requireAdmin(body, res)) return
        const userId = typeof body.userId === 'string' ? body.userId : ''
        const r = auth.deleteAccountById(userId)
        if (!r.ok) {
          res.writeHead(400, JSON_H)
          res.end(JSON.stringify(r))
          return
        }
        const accountId = r.accountId
        for (const fid of r.affectedFriends) io.to('user:' + fid).emit('friend:update') // (전)친구 목록 갱신
        characters.removeAll(accountId)
        posts.removeAll(accountId)
        sessionlogs.removeAll(accountId)
        dottown.removeAll(accountId)
        economy.removeAll(accountId)
        market.removeAll(accountId)
        community.removeAll(accountId)
        cmtyPosts.removeAll(accountId)
        cmtyChars.removeAll(accountId, Date.now())
        estate.removeAll(accountId)
        broadcastLots()
        notif.removeForUser(accountId) // 알림 피드 제거(고아 파일 방지)
        dmRate.delete(accountId)
        econRate.delete(accountId)
        socialRate.delete(accountId)
        shownStatus.delete(accountId) // 프레즌스 표시 상태 정리
        for (const peer of dm.removeForUser(accountId)) {
          io.to('user:' + peer).emit('dm:cleared', { peer: accountId, by: peer })
        }
        // 그룹 DM 은 멤버 제거만(잔존 멤버 대화 보존) — 잔존 멤버에게 재조회 신호.
        for (const g of dm.leaveAllGroups(accountId)) {
          for (const m of g.remaining) io.to('user:' + m).emit('dm:group:update', { threadId: g.threadId })
        }
        for (const room of store.deleteOwnedBy(accountId)) {
          for (const pid of room.participants) {
            io.to('user:' + pid).emit('room:closed', '세션이 삭제되었습니다.')
            void io.in('user:' + pid).socketsLeave(room.id)
            syncPresence(pid) // 세션중 표시 해제(socket.data.roomId 잔존 대비 — inSession 이 store 재검증)
          }
        }
        void io.in('acct:' + accountId).disconnectSockets(true) // 본인 소켓 강제 종료(프레즌스·레이트리밋 정리)
        res.writeHead(200, JSON_H)
        res.end(JSON.stringify({ ok: true }))
      })
      return
    }

    // 미참조(고아) 자산 즉시 정리 — 라이브 참조 집합을 모아 sweep(유예 보존). 확보 바이트 반환.
    if (req.method === 'POST' && req.url === '/admin/gc') {
      void readJsonBody(req).then((body) => {
        if (!requireAdmin(body, res)) return
        const live = new Set<string>()
        store.collectAssetRefs(live)
        characters.collectAssetRefs(live)
        auth.collectAssetRefs(live)
        posts.collectAssetRefs(live)
        sessionlogs.collectAssetRefs(live)
        dottown.collectAssetRefs(live)
        economy.collectAssetRefs(live)
        market.collectAssetRefs(live) // ⚠UGC 마켓 이미지 라이브셋(등록/보유) — sweep 회수 방지
        community.collectAssetRefs(live)
        cmtyPosts.collectAssetRefs(live)
        cmtyChars.collectAssetRefs(live) // ⚠커뮤니티 이미지 라이브셋 — sweep 회수 방지
        cmtyCatalog.collectAssetRefs(live)
        cmtyGifts.collectAssetRefs(live)
        cmtyGames.collectAssetRefs(live)
        const { removed, freed } = assets.sweep(live)
        res.writeHead(200, JSON_H)
        res.end(JSON.stringify({ ok: true, removed, freed }))
      })
      return
    }

    // 서버 데이터 전체 내보내기(관리자) — data/ 의 모든 파일(계정·게시글·DM·세션방·캐릭터·자산·설정)을 base64 번들로 묶는다.
    // 다른 서버로의 '완벽 이전'용. ⚠ accounts.json 의 비밀번호 해시·전체 DM 이 포함되므로 내려받은 파일을 안전하게 보관할 것.
    if (req.method === 'POST' && req.url === '/admin/export') {
      void readJsonBody(req).then((body) => {
        if (!requireAdmin(body, res)) return
        try {
          const files: Record<string, string> = {}
          let total = 0
          for (const f of listFilesRec(dataDir)) {
            const buf = readFileSync(f)
            total += buf.length
            if (total > SERVER_EXPORT_MAX_BYTES) {
              res.writeHead(413, JSON_H)
              res.end(
                JSON.stringify({
                  ok: false,
                  error: '서버 데이터가 너무 큽니다(약 100MB 초과). 앱 내 내보내기 대신 서버의 data 폴더를 직접 복사해 옮겨 주세요.'
                })
              )
              return
            }
            files[relative(dataDir, f).split(sep).join('/')] = buf.toString('base64') // 키는 정슬래시 상대경로
          }
          res.writeHead(200, JSON_H)
          res.end(JSON.stringify({ type: 'tacoyaki-server', version: 1, exportedAt: Date.now(), files }))
        } catch (e) {
          console.error('[admin] 서버 내보내기 실패:', e)
          res.writeHead(500, JSON_H)
          res.end(JSON.stringify({ ok: false, error: '서버 데이터를 읽지 못했습니다.' }))
        }
      })
      return
    }

    // 서버 데이터 가져오기(관리자) — 내보낸 번들을 data/ 에 복원. 토큰은 Authorization 헤더로(본문은 대용량 번들이라 분리).
    // ⚠ 기존 data/ 를 덮어쓴다. 복원 후 서버를 재시작해야 인메모리 스토어가 새 데이터를 읽는다.
    if (req.method === 'POST' && req.url === '/admin/import') {
      const authz = typeof req.headers['authorization'] === 'string' ? req.headers['authorization'] : ''
      const token = authz.startsWith('Bearer ') ? authz.slice(7) : ''
      const account = auth.verifyToken(token)
      if (!account || account.role !== 'admin') {
        res.writeHead(account ? 403 : 401, JSON_H)
        res.end(JSON.stringify({ ok: false, error: account ? '권한이 없습니다.' : '인증이 필요합니다.' }))
        return
      }
      void readRawBody(req, 200 * 1024 * 1024).then((buf) => {
        if (!buf || buf.length === 0) {
          res.writeHead(413, JSON_H)
          res.end(JSON.stringify({ ok: false, error: '가져올 데이터가 비었거나 너무 큽니다.' }))
          return
        }
        let bundle: Record<string, unknown> = {}
        try {
          const p = JSON.parse(buf.toString('utf8'))
          if (p && typeof p === 'object' && !Array.isArray(p)) bundle = p as Record<string, unknown>
        } catch {
          bundle = {}
        }
        if (
          bundle.type !== 'tacoyaki-server' ||
          bundle.version !== 1 ||
          !bundle.files ||
          typeof bundle.files !== 'object'
        ) {
          res.writeHead(400, JSON_H)
          res.end(JSON.stringify({ ok: false, error: '타코야키 서버 백업 파일이 아닙니다.' }))
          return
        }
        try {
          let restored = 0
          for (const [rel, b64] of Object.entries(bundle.files as Record<string, unknown>)) {
            if (typeof b64 !== 'string' || !isSafeRelPath(rel)) continue // 비문자·경로 탈출 건너뜀
            const target = join(dataDir, rel)
            mkdirSync(join(target, '..'), { recursive: true })
            const tmp = target + '.tmp'
            writeFileSync(tmp, Buffer.from(b64, 'base64'))
            renameSync(tmp, target) // 원자적 교체
            restored++
          }
          res.writeHead(200, JSON_H)
          res.end(JSON.stringify({ ok: true, restored, restartRequired: true }))
        } catch (e) {
          console.error('[admin] 서버 가져오기 실패:', e)
          res.writeHead(500, JSON_H)
          res.end(JSON.stringify({ ok: false, error: '데이터 복원에 실패했습니다.' }))
        }
      })
      return
    }

    // ===== 멤버 본인 데이터 이전 — 게시글·세션방을 본인이 내보내/가져오기(다른 서버로). 토큰 인증(손님 제외). =====
    // 내보내기: 본문 { token }. 응답 = { type, version, blog, rooms, assets }. (로비 꾸밈·캐릭터는 클라 '전체 설정'에 별도 포함)
    if (req.method === 'POST' && req.url === '/me/export') {
      void readJsonBody(req).then((body) => {
        const account = typeof body.token === 'string' ? auth.verifyToken(body.token) : null
        if (!account) {
          res.writeHead(401, JSON_H)
          res.end(JSON.stringify({ ok: false, error: '인증이 필요합니다.' }))
          return
        }
        try {
          const blog = posts.exportFor(account.id) // { posts, boards }
          const slog = sessionlogs.exportFor(account.id) // { logs, boards }
          const rooms = store.exportOwnedBy(account.id) // 내가 소유한 방 전체 장면·채팅
          const dt = dottown.exportFor(account.id) // 마이룸·캐릭터 외형(메타)
          // 코인 경제(지갑·소유·일일)는 멤버 본인 이전에서 제외 — 서버 권위 게임상태라 클라가 편집해 재가져오기로
          //   주입하면 잔액/소유를 위조할 수 있다. 서버 간 전체 이전은 관리자 전체백업(파일 레벨)이 보존한다.
          // 참조 자산 해시 수집 + 본문 JSON 크기 합산 — 상한은 '본문(글·로그·방) + 자산' 합으로 검사(인메모리 응답 문자열 보호).
          const refs = new Set<string>()
          const blogJson = JSON.stringify(blog)
          scanAssetRefs(blogJson, refs)
          let total = Buffer.byteLength(blogJson, 'utf8')
          const slogJson = JSON.stringify(slog)
          scanAssetRefs(slogJson, refs)
          total += Buffer.byteLength(slogJson, 'utf8')
          for (const rf of rooms) {
            const rj = JSON.stringify(rf)
            scanAssetRefs(rj, refs)
            total += Buffer.byteLength(rj, 'utf8')
          }
          const dtJson = JSON.stringify(dt)
          scanAssetRefs(dtJson, refs)
          total += Buffer.byteLength(dtJson, 'utf8')
          const tooBig = (): boolean => {
            if (total > MEMBER_EXPORT_MAX_BYTES) {
              res.writeHead(413, JSON_H)
              res.end(JSON.stringify({ ok: false, error: '내 데이터가 너무 큽니다(약 80MB 초과). 세션방을 줄이거나 나눠서 옮겨 주세요.' }))
              return true
            }
            return false
          }
          if (tooBig()) return // 본문만으로 이미 초과
          const assetsOut: Record<string, { mime: string; data: string }> = {}
          for (const hash of refs) {
            const a = assets.resolve(hash)
            if (!a) continue
            let bytes: Buffer | undefined
            if (a.path) {
              try {
                bytes = readFileSync(a.path)
              } catch {
                continue
              }
            } else {
              bytes = a.bytes
            }
            if (!bytes) continue
            total += bytes.length
            if (tooBig()) return
            assetsOut[hash] = { mime: a.mime, data: bytes.toString('base64') }
          }
          res.writeHead(200, JSON_H)
          res.end(JSON.stringify({ type: 'tacoyaki-member-server', version: 1, blog, sessionlogs: slog, rooms, dottown: dt, assets: assetsOut }))
        } catch (e) {
          console.error('[me] 내보내기 실패:', e)
          res.writeHead(500, JSON_H)
          res.end(JSON.stringify({ ok: false, error: '내 데이터를 읽지 못했습니다.' }))
        }
      })
      return
    }

    // 가져오기: 토큰=Authorization Bearer(본문은 대용량 번들). 게시글·세션방을 이 계정 소유로 복원(손님 제외).
    if (req.method === 'POST' && req.url === '/me/import') {
      const authz = typeof req.headers['authorization'] === 'string' ? req.headers['authorization'] : ''
      const token = authz.startsWith('Bearer ') ? authz.slice(7) : ''
      const account = auth.verifyToken(token)
      if (!account) {
        res.writeHead(401, JSON_H)
        res.end(JSON.stringify({ ok: false, error: '인증이 필요합니다.' }))
        return
      }
      if (account.role === 'guest') {
        res.writeHead(403, JSON_H)
        res.end(JSON.stringify({ ok: false, error: '손님 계정은 게시글·세션방을 가질 수 없습니다(관리자 승인 후 이용).' }))
        return
      }
      void readRawBody(req, 160 * 1024 * 1024).then(async (buf) => {
        if (!buf || buf.length === 0) {
          res.writeHead(413, JSON_H)
          res.end(JSON.stringify({ ok: false, error: '가져올 데이터가 비었거나 너무 큽니다.' }))
          return
        }
        let bundle: Record<string, unknown> = {}
        try {
          const p = JSON.parse(buf.toString('utf8'))
          if (p && typeof p === 'object' && !Array.isArray(p)) bundle = p as Record<string, unknown>
        } catch {
          bundle = {}
        }
        if (bundle.type !== 'tacoyaki-member-server' || bundle.version !== 1) {
          res.writeHead(400, JSON_H)
          res.end(JSON.stringify({ ok: false, error: '타코야키 내 데이터 백업이 아닙니다.' }))
          return
        }
        try {
          // 1) 자산 먼저 복원(콘텐츠 주소 — 같은 해시로 재저장, mime 보존) → 글·방의 asset 참조가 새 서버에서 살아남.
          const assetsIn =
            bundle.assets && typeof bundle.assets === 'object'
              ? (bundle.assets as Record<string, { mime?: string; data?: string }>)
              : {}
          // 개별 자산 크기(assets.maxBytes)·개수 상한 — 인증 멤버라도 임의 대용량/대량 자산 주입을 막는다.
          await Promise.all(
            Object.values(assetsIn)
              .slice(0, 5000)
              .map((a) => {
                if (!a || typeof a.data !== 'string') return Promise.resolve('')
                const bytes = Buffer.from(a.data, 'base64')
                if (bytes.length === 0 || bytes.length > assets.maxBytes) return Promise.resolve('') // 빈/과대 자산 건너뜀
                return assets
                  .put(bytes, typeof a.mime === 'string' ? a.mime : 'application/octet-stream')
                  .catch(() => '')
              })
          )
          // 2) 게시글·게시판 복원(새 계정 재귀속).
          const blog = bundle.blog && typeof bundle.blog === 'object' ? (bundle.blog as Record<string, unknown>) : {}
          const postCount = posts.importFor(account.id, blog.posts, blog.boards)
          // 3) 세션 로그·게시판 복원(구버전 번들엔 없을 수 있음 — 없으면 0건).
          const slog = bundle.sessionlogs && typeof bundle.sessionlogs === 'object' ? (bundle.sessionlogs as Record<string, unknown>) : {}
          const slogCount = sessionlogs.importFor(account.id, slog.logs, slog.boards)
          // 4) 세션방 복원(새 id·코드·소유자=나).
          const roomCount = store.importOwnedBy(account.id, bundle.rooms, account.nickname || account.username)
          // 5) 도트타운 마이룸·캐릭터 복원(구버전 번들엔 없을 수 있음 — 없으면 무시).
          //    저장 라우트와 동일한 소유권 게이트 — 번들을 위조해도 미보유 프리미엄/마켓 아이템이 되살아나지 않게 거른다.
          const ownsFurn = (id: string): boolean =>
            id.startsWith('m_') ? market.owns(account.id, id) : economy.canPlace(account.id, id)
          // 방/캐릭터 1건에 소유권 게이트 적용(방=미보유 가구 제거·미보유 벽지/바닥 비움, 캐릭터=미보유 마켓 의상 탈락).
          const gateRoom = (roomIn: object): Record<string, unknown> => {
            const room = { ...(roomIn as Record<string, unknown>) }
            room.placed = (Array.isArray(room.placed) ? room.placed : []).filter((p) => {
              const fid = p && typeof p === 'object' ? (p as Record<string, unknown>).furnitureId : null
              return typeof fid === 'string' && ownsFurn(fid)
            })
            for (const k of ['wallpaperId', 'flooringId']) {
              const id = room[k]
              if (typeof id === 'string' && id && (id.startsWith('m_') || !economy.canPlace(account.id, id))) room[k] = ''
            }
            return room
          }
          const gateChar = (charIn: object): Record<string, unknown> => {
            const char = { ...(charIn as Record<string, unknown>) }
            const inLayers = char.layers && typeof char.layers === 'object' ? (char.layers as Record<string, unknown>) : {}
            const layers: Record<string, unknown> = {}
            for (const [slot, val] of Object.entries(inLayers)) {
              const id = val && typeof val === 'object' ? (val as Record<string, unknown>).id : null
              if (typeof id === 'string' && id.startsWith('m_') && !market.owns(account.id, id)) continue // 미보유 마켓 의상 탈락
              layers[slot] = val
            }
            char.layers = layers
            return char
          }
          const gateDottown = (data: unknown): unknown => {
            if (!data || typeof data !== 'object') return data
            const dt = { ...(data as Record<string, unknown>) }
            if (dt.room && typeof dt.room === 'object') dt.room = gateRoom(dt.room)
            if (dt.char && typeof dt.char === 'object') dt.char = gateChar(dt.char)
            // 저장 슬롯도 방/캐릭터와 동일 게이트 — 위조 번들의 미보유 아이템이 프리셋 슬롯에 저장되지 않게(게이팅 일관성).
            if (Array.isArray(dt.roomPresets)) {
              dt.roomPresets = dt.roomPresets.map((s) => {
                if (!s || typeof s !== 'object') return s
                const slot = { ...(s as Record<string, unknown>) }
                if (slot.layout && typeof slot.layout === 'object') slot.layout = gateRoom(slot.layout)
                return slot
              })
            }
            if (Array.isArray(dt.charPresets)) {
              dt.charPresets = dt.charPresets.map((s) => {
                if (!s || typeof s !== 'object') return s
                const slot = { ...(s as Record<string, unknown>) }
                if (slot.char && typeof slot.char === 'object') slot.char = gateChar(slot.char)
                return slot
              })
            }
            return dt
          }
          dottown.importFor(account.id, gateDottown(bundle.dottown))
          // 코인 경제는 가져오기에서 의도적으로 제외(위조 방지 — 위 /me/export 주석 참고).
          res.writeHead(200, JSON_H)
          res.end(JSON.stringify({ ok: true, posts: postCount, sessionlogs: slogCount, rooms: roomCount }))
        } catch (e) {
          console.error('[me] 가져오기 실패:', e)
          res.writeHead(500, JSON_H)
          res.end(JSON.stringify({ ok: false, error: '데이터 복원에 실패했습니다.' }))
        }
      })
      return
    }

    // ===== 도트타운(확장팩) 마이룸·캐릭터 영속 =====
    // 마이룸 저장 — 토큰 인증(손님 제외, 본인 방만). 본문 { token, layout }. rev 충돌 시 409 + 현재 서버본.
    // 성공 시 dottown:updated 를 전체 브로드캐스트 → 그 방을 '방문 중'인 클라가 재조회(멤버십 상태 없이 신호만).
    if (req.method === 'POST' && req.url === '/dottown/room/save') {
      void readJsonBody(req).then((body) => {
        const account = typeof body.token === 'string' ? auth.verifyToken(body.token) : null
        if (!account) {
          res.writeHead(401, JSON_H)
          res.end(JSON.stringify({ ok: false, error: '인증이 필요합니다.' }))
          return
        }
        if (account.role === 'guest') {
          res.writeHead(403, JSON_H)
          res.end(JSON.stringify({ ok: false, error: '손님 계정은 마이룸을 꾸밀 수 없습니다(관리자 승인 후 이용).' }))
          return
        }
        if (econLimited(account.id, res)) return // 전체 파일 동기 재기록 라우트 — 연타 폭주 차단
        // 소유권 게이트(안티치트) — 배치 가구는 마켓(m_) 소유 또는 프리미엄 economy 소유, 벽지/바닥은 프리미엄 economy 소유만.
        const layout = body.layout && typeof body.layout === 'object' ? (body.layout as Record<string, unknown>) : {}
        const placed = Array.isArray(layout.placed) ? layout.placed : []
        const furnIds: string[] = []
        for (const p of placed) {
          const fid = p && typeof p === 'object' ? (p as Record<string, unknown>).furnitureId : null
          if (typeof fid === 'string') furnIds.push(fid)
        }
        // 가구: 마켓 id 는 보유, 그 외는 economy(무료/프리미엄) 소유.
        const badFurn = furnIds.some((id) => (id.startsWith('m_') ? !market.owns(account.id, id) : !economy.canPlace(account.id, id)))
        // 벽지/바닥: 마켓엔 타일 종류가 없으므로 m_ id 는 무효(거부), 그 외는 economy 소유.
        const tileIds = [layout.wallpaperId, layout.flooringId].filter((x): x is string => typeof x === 'string' && x.length > 0)
        const badTile = tileIds.some((id) => id.startsWith('m_') || !economy.canPlace(account.id, id))
        if (badFurn || badTile) {
          res.writeHead(403, JSON_H)
          res.end(JSON.stringify({ ok: false, error: '보유하지 않았거나 올바르지 않은 아이템이 포함돼 있어요.' }))
          return
        }
        const result = dottown.saveRoom(account.id, body.layout)
        if (result.ok) io.emit('dottown:updated', { ownerId: account.id })
        res.writeHead(result.ok ? 200 : 409, JSON_H)
        res.end(JSON.stringify(result))
      })
      return
    }
    // 마이룸 조회(공개 읽기전용) — GET /dottown/room?id=<userId>. 방+캐릭터+공개 프로필 동봉(방문 1회 조회).
    if (req.method === 'GET' && req.url && (req.url === '/dottown/room' || req.url.startsWith('/dottown/room?'))) {
      const id = new URLSearchParams(req.url.split('?')[1] ?? '').get('id') ?? ''
      const owner = id ? auth.getAccountById(id) : null
      // working=알바 중 → 방문자 화면에서 호스트 캐릭터 숨김(마이룸 비움).
      res.writeHead(200, JSON_H)
      res.end(JSON.stringify({ ok: true, layout: dottown.getRoom(id), char: dottown.getChar(id), owner, working: id ? economy.isWorking(id) : false }))
      return
    }
    // 캐릭터 외형 저장 — 토큰 인증(손님 제외). 본문 { token, config }(레이어 맵).
    if (req.method === 'POST' && req.url === '/dottown/char/save') {
      void readJsonBody(req).then((body) => {
        const account = typeof body.token === 'string' ? auth.verifyToken(body.token) : null
        if (!account) {
          res.writeHead(401, JSON_H)
          res.end(JSON.stringify({ ok: false, error: '인증이 필요합니다.' }))
          return
        }
        if (account.role === 'guest') {
          res.writeHead(403, JSON_H)
          res.end(JSON.stringify({ ok: false, error: '손님 계정은 캐릭터를 저장할 수 없습니다.' }))
          return
        }
        if (econLimited(account.id, res)) return // 전체 파일 동기 재기록 라우트 — 연타 폭주 차단
        // 마켓 의상(m_…)은 보유(구매/창작)해야 착용 저장 가능 — 미보유 위조 차단.
        const cfg = body.config && typeof body.config === 'object' ? (body.config as Record<string, unknown>) : {}
        const layers = cfg.layers && typeof cfg.layers === 'object' ? (cfg.layers as Record<string, unknown>) : {}
        for (const v of Object.values(layers)) {
          const id = v && typeof v === 'object' ? (v as Record<string, unknown>).id : null
          if (typeof id === 'string' && id.startsWith('m_') && !market.owns(account.id, id)) {
            res.writeHead(403, JSON_H)
            res.end(JSON.stringify({ ok: false, error: '보유하지 않은 마켓 의상이 포함돼 있어요.' }))
            return
          }
        }
        const r = dottown.saveChar(account.id, body.config)
        res.writeHead(200, JSON_H)
        res.end(JSON.stringify(r))
      })
      return
    }
    // 캐릭터 외형 조회(공개 읽기전용) — GET /dottown/char?id=<userId>. 도트타운 표시 닉네임도 동봉.
    if (req.method === 'GET' && req.url && (req.url === '/dottown/char' || req.url.startsWith('/dottown/char?'))) {
      const id = new URLSearchParams(req.url.split('?')[1] ?? '').get('id') ?? ''
      res.writeHead(200, JSON_H)
      res.end(JSON.stringify({ ok: true, char: dottown.getChar(id), nick: dottown.getNick(id) }))
      return
    }
    // 도트타운 표시 닉네임 저장(본인·멤버) — POST /dottown/nick { token, nick }. 빈 값=해제(계정 닉네임 폴백).
    if (req.method === 'POST' && req.url === '/dottown/nick') {
      void readJsonBody(req).then((body) => {
        const account = requireMember(body, res)
        if (!account) return
        if (econLimited(account.id, res)) return // 전체 파일 동기 재기록 — 연타 폭주 차단
        const r = dottown.setNick(account.id, body.nick)
        broadcastLots() // 집 위 라벨(ownerNick)이 현재 닉으로 다시 해석되도록 광장에 최신 lots 재송출
        res.writeHead(200, JSON_H)
        res.end(JSON.stringify(r))
      })
      return
    }

    // ===== 도트타운 저장 슬롯(마이룸/캐릭터 프리셋 각 6개) — 전부 멤버 전용(본인 것). =====
    // 슬롯 저장은 '현재 방/외형'의 스냅샷일 뿐 — 소유권 게이트는 '불러오기(=room/save·char/save)'에서 재검증되므로 여기선 생략.
    if (req.method === 'POST' && req.url === '/dottown/room/presets') {
      void readJsonBody(req).then((body) => {
        const account = requireMember(body, res)
        if (!account) return
        res.writeHead(200, JSON_H)
        res.end(JSON.stringify({ ok: true, presets: dottown.listRoomPresets(account.id) }))
      })
      return
    }
    if (req.method === 'POST' && req.url === '/dottown/room/preset/save') {
      void readJsonBody(req).then((body) => {
        const account = requireMember(body, res)
        if (!account) return
        if (econLimited(account.id, res)) return // 전체 파일 동기 재기록 — 연타 폭주 차단
        const r = dottown.saveRoomPreset(account.id, body.slot as number, body.layout)
        res.writeHead(r.ok ? 200 : 400, JSON_H)
        res.end(JSON.stringify(r))
      })
      return
    }
    if (req.method === 'POST' && req.url === '/dottown/room/preset/delete') {
      void readJsonBody(req).then((body) => {
        const account = requireMember(body, res)
        if (!account) return
        if (econLimited(account.id, res)) return
        const r = dottown.deleteRoomPreset(account.id, body.slot as number)
        res.writeHead(r.ok ? 200 : 400, JSON_H)
        res.end(JSON.stringify(r))
      })
      return
    }
    if (req.method === 'POST' && req.url === '/dottown/char/presets') {
      void readJsonBody(req).then((body) => {
        const account = requireMember(body, res)
        if (!account) return
        res.writeHead(200, JSON_H)
        res.end(JSON.stringify({ ok: true, presets: dottown.listCharPresets(account.id) }))
      })
      return
    }
    if (req.method === 'POST' && req.url === '/dottown/char/preset/save') {
      void readJsonBody(req).then((body) => {
        const account = requireMember(body, res)
        if (!account) return
        if (econLimited(account.id, res)) return
        const r = dottown.saveCharPreset(account.id, body.slot as number, body.config)
        res.writeHead(r.ok ? 200 : 400, JSON_H)
        res.end(JSON.stringify(r))
      })
      return
    }
    if (req.method === 'POST' && req.url === '/dottown/char/preset/delete') {
      void readJsonBody(req).then((body) => {
        const account = requireMember(body, res)
        if (!account) return
        if (econLimited(account.id, res)) return
        const r = dottown.deleteCharPreset(account.id, body.slot as number)
        res.writeHead(r.ok ? 200 : 400, JSON_H)
        res.end(JSON.stringify(r))
      })
      return
    }

    // ===== 도트타운 소셜 — 좋아요·방문·방명록·인기 랭킹 =====
    // 내 방 소셜 요약(소유주) — 토큰 인증(누구나 본인 것). 본문 { token }.
    if (req.method === 'POST' && req.url === '/dottown/social') {
      void readJsonBody(req).then((body) => {
        const account = typeof body.token === 'string' ? auth.verifyToken(body.token) : null
        if (!account) {
          res.writeHead(401, JSON_H)
          res.end(JSON.stringify({ ok: false, error: '인증이 필요합니다.' }))
          return
        }
        res.writeHead(200, JSON_H)
        res.end(JSON.stringify({ ok: true, ...dottown.ownSocial(account.id) }))
      })
      return
    }
    // 방 방문 기록(고유 계정) + 방문자 관점 요약 — 토큰 인증. 본문 { token, target }.
    if (req.method === 'POST' && req.url === '/dottown/room/visit') {
      void readJsonBody(req).then((body) => {
        const account = typeof body.token === 'string' ? auth.verifyToken(body.token) : null
        if (!account) {
          res.writeHead(401, JSON_H)
          res.end(JSON.stringify({ ok: false, error: '인증이 필요합니다.' }))
          return
        }
        if (socialLimited(account.id, res)) return
        const target = typeof body.target === 'string' ? body.target : ''
        if (!target || !auth.getAccountById(target)) {
          res.writeHead(404, JSON_H)
          res.end(JSON.stringify({ ok: false, error: '대상을 찾을 수 없습니다.' }))
          return
        }
        res.writeHead(200, JSON_H)
        res.end(JSON.stringify({ ok: true, ...dottown.recordVisit(target, account.id) }))
      })
      return
    }
    // 방 좋아요 토글(본인 방 불가) — 토큰 인증. 본문 { token, target }. 최초 좋아요면 소유주에 코인 보상.
    if (req.method === 'POST' && req.url === '/dottown/room/like') {
      void readJsonBody(req).then((body) => {
        const account = typeof body.token === 'string' ? auth.verifyToken(body.token) : null
        if (!account) {
          res.writeHead(401, JSON_H)
          res.end(JSON.stringify({ ok: false, error: '인증이 필요합니다.' }))
          return
        }
        if (socialLimited(account.id, res)) return
        const target = typeof body.target === 'string' ? body.target : ''
        if (!target || !auth.getAccountById(target)) {
          res.writeHead(404, JSON_H)
          res.end(JSON.stringify({ ok: false, error: '대상을 찾을 수 없습니다.' }))
          return
        }
        const r = dottown.toggleLike(target, account.id)
        // 코인 보상은 '멤버가 누른 최초 좋아요'에만 지급 — 손님은 무승인·무제한 가입이 가능하므로,
        //   손님 계정을 대량 생성해 자기 방에 좋아요를 눌러 코인을 무한 발행하는 파밍을 차단한다(좋아요 자체는 손님도 허용).
        if (r.ok && r.reward && account.role !== 'guest') {
          const rr = economy.applyDelta(target, LIKE_REWARD, 'like', account.id)
          if (rr.ok) io.to('user:' + target).emit('dottown:coin', { balance: rr.balance })
        }
        if (r.ok) io.emit('dottown:updated', { ownerId: target }) // 방문자·소유주 카운트 갱신
        res.writeHead(r.ok ? 200 : 400, JSON_H)
        res.end(JSON.stringify(r))
      })
      return
    }
    // 방명록 남기기 — 토큰 인증(작성자 이름/프로필은 서버가 계정에서 채움). 본문 { token, target, message }.
    if (req.method === 'POST' && req.url === '/dottown/guestbook') {
      void readJsonBody(req).then((body) => {
        const account = typeof body.token === 'string' ? auth.verifyToken(body.token) : null
        if (!account) {
          res.writeHead(401, JSON_H)
          res.end(JSON.stringify({ ok: false, error: '인증이 필요합니다.' }))
          return
        }
        if (socialLimited(account.id, res)) return
        const target = typeof body.target === 'string' ? body.target : ''
        if (!target || !auth.getAccountById(target)) {
          res.writeHead(404, JSON_H)
          res.end(JSON.stringify({ ok: false, error: '대상을 찾을 수 없습니다.' }))
          return
        }
        const message = typeof body.message === 'string' ? body.message : ''
        const r = dottown.addGuest(target, { id: account.id, name: account.nickname || account.username, avatar: account.avatar }, message)
        if (r.ok) {
          io.emit('dottown:updated', { ownerId: target })
          notify(target, { kind: 'dtguestbook', actor: actorOf(account), text: message }) // 종 알림(마이룸 주인)
        }
        res.writeHead(r.ok ? 200 : 400, JSON_H)
        res.end(JSON.stringify(r))
      })
      return
    }
    // 방명록 삭제(방 주인 또는 작성자) — 토큰 인증. 본문 { token, target, entryId }.
    if (req.method === 'POST' && req.url === '/dottown/guestbook/delete') {
      void readJsonBody(req).then((body) => {
        const account = typeof body.token === 'string' ? auth.verifyToken(body.token) : null
        if (!account) {
          res.writeHead(401, JSON_H)
          res.end(JSON.stringify({ ok: false, error: '인증이 필요합니다.' }))
          return
        }
        if (socialLimited(account.id, res)) return
        const target = typeof body.target === 'string' ? body.target : ''
        const entryId = typeof body.entryId === 'string' ? body.entryId : ''
        const r = dottown.removeGuest(target, account.id, entryId)
        if (r.ok) io.emit('dottown:updated', { ownerId: target })
        res.writeHead(r.ok ? 200 : 400, JSON_H)
        res.end(JSON.stringify(r))
      })
      return
    }
    // 인기 마이룸 랭킹(공개 읽기전용) — GET /dottown/top. 소유주 공개 프로필 동봉.
    if (req.method === 'GET' && req.url && (req.url === '/dottown/top' || req.url.startsWith('/dottown/top?'))) {
      const rooms = dottown.topRooms(20).map((r) => ({ ...r, owner: auth.getAccountById(r.ownerId) }))
      res.writeHead(200, JSON_H)
      res.end(JSON.stringify({ ok: true, rooms }))
      return
    }

    // ===== 도트타운 경제 — 코인·아르바이트·상점·일일 보상(서버 권위) =====
    // 진행 알바 shift → 소켓/응답 페이로드(계정 id·status 제외).
    const jobPayload = (
      sh: { shopId: string; startAt: number; endAt: number; minutes: number; hourlyWage: number } | null
    ): { shopId: string; startAt: number; endAt: number; minutes: number; hourlyWage: number; remainingMs: number } | null =>
      sh
        ? {
            shopId: sh.shopId,
            startAt: sh.startAt,
            endAt: sh.endAt,
            minutes: sh.minutes,
            hourlyWage: sh.hourlyWage,
            // 서버 시계 기준 남은 시간 — 클라가 벽시계 오차와 무관하게 카운트다운을 앵커하게(수신 시점 상대값).
            remainingMs: Math.max(0, sh.endAt - Date.now())
          }
        : null

    // 경제 상태 일괄 조회(위젯 오픈 시) — 토큰 인증(누구나 본인 것). 본문 { token }.
    if (req.method === 'POST' && req.url === '/dottown/econ') {
      void readJsonBody(req).then((body) => {
        const account = typeof body.token === 'string' ? auth.verifyToken(body.token) : null
        if (!account) {
          res.writeHead(401, JSON_H)
          res.end(JSON.stringify({ ok: false, error: '인증이 필요합니다.' }))
          return
        }
        res.writeHead(200, JSON_H)
        res.end(JSON.stringify({ ok: true, ...economy.snapshot(account.id) }))
      })
      return
    }
    // 일일 보상 수령(member+). 본문 { token }.
    if (req.method === 'POST' && req.url === '/dottown/daily/claim') {
      void readJsonBody(req).then((body) => {
        const account = requireMember(body, res)
        if (!account) return
        if (econLimited(account.id, res)) return
        const r = economy.claimDaily(account.id)
        if (r.ok) io.to('user:' + account.id).emit('dottown:coin', { balance: r.balance })
        res.writeHead(r.ok ? 200 : 400, JSON_H)
        res.end(JSON.stringify(r))
      })
      return
    }
    // 알바 시작(member+). 본문 { token, shopId, minutes }.
    if (req.method === 'POST' && req.url === '/dottown/job/start') {
      void readJsonBody(req).then((body) => {
        const account = requireMember(body, res)
        if (!account) return
        if (econLimited(account.id, res)) return
        const shopId = typeof body.shopId === 'string' ? body.shopId : ''
        const minutes = typeof body.minutes === 'number' ? body.minutes : 0
        const r = economy.startJob(account.id, shopId, minutes)
        if (r.ok && r.shift) {
          // 근무 시작 → 이 계정을 마이룸 실시간 방문에서 강제 이탈시킨다(입장 게이트만으론 '이미 방에 있다가 근무 시작'을
          //   못 막는다). 액터 제거(타인 화면서 즉시 사라짐) + 그 계정 소켓의 socket.io 방/상태 정리.
          roomVisit.kick(account.id)
          for (const s of io.sockets.sockets.values()) {
            if (s.data.account?.id === account.id && s.data.visitRoomId) {
              void s.leave('roomvisit:' + s.data.visitRoomId)
              s.data.visitRoomId = undefined
            }
          }
          io.to('user:' + account.id).emit('dottown:job', { shift: jobPayload(r.shift) })
          // 그 가게 점원으로 "영업 중" 전파 — 광장에 없던 유저면 저장된 외형(nick·look)으로 점원 액터 주입(탭 무관 카운터 유지).
          plaza.setWorking(account.id, true, shopId, { nick: displayNick(account.id), look: dottown.getChar(account.id) })
        }
        res.writeHead(r.ok ? 200 : 400, JSON_H)
        res.end(JSON.stringify(r.ok ? { ok: true, shift: jobPayload(r.shift ?? null) } : r))
      })
      return
    }
    // 퇴근·정산(member+). 본문 { token }. now>=endAt 서버 재검증 후 지급.
    if (req.method === 'POST' && req.url === '/dottown/job/finish') {
      void readJsonBody(req).then((body) => {
        const account = requireMember(body, res)
        if (!account) return
        if (econLimited(account.id, res)) return
        const r = economy.finishJob(account.id)
        if (r.ok) {
          io.to('user:' + account.id).emit('dottown:coin', { balance: r.balance })
          io.to('user:' + account.id).emit('dottown:job', { shift: null })
          plaza.setWorking(account.id, false) // 퇴근 → "영업 중" 해제
        }
        res.writeHead(r.ok ? 200 : 400, JSON_H)
        res.end(JSON.stringify(r))
      })
      return
    }
    // 근무 취소(보상 없음, member+). 본문 { token }.
    if (req.method === 'POST' && req.url === '/dottown/job/cancel') {
      void readJsonBody(req).then((body) => {
        const account = requireMember(body, res)
        if (!account) return
        if (econLimited(account.id, res)) return
        const r = economy.cancelJob(account.id)
        if (r.had) {
          io.to('user:' + account.id).emit('dottown:job', { shift: null }) // 진행 중이던 경우에만 브로드캐스트
          plaza.setWorking(account.id, false) // 근무 취소 → "영업 중" 해제
        }
        res.writeHead(200, JSON_H)
        res.end(JSON.stringify({ ok: true }))
      })
      return
    }
    // 상점 구매(member+) — 코인 소각 + 소유권. 본문 { token, itemId }.
    if (req.method === 'POST' && req.url === '/dottown/shop/buy') {
      void readJsonBody(req).then((body) => {
        const account = requireMember(body, res)
        if (!account) return
        if (econLimited(account.id, res)) return
        const itemId = typeof body.itemId === 'string' ? body.itemId : ''
        const r = economy.buy(account.id, itemId)
        if (r.ok) io.to('user:' + account.id).emit('dottown:coin', { balance: r.balance })
        res.writeHead(r.ok ? 200 : 400, JSON_H)
        res.end(JSON.stringify(r))
      })
      return
    }

    // 낚시 던지기(member+) — 쿨다운 확인 후 입질 시각을 서버가 랜덤 결정. 본문 { token }.
    if (req.method === 'POST' && req.url === '/dottown/fish/cast') {
      void readJsonBody(req).then((body) => {
        const account = requireMember(body, res)
        if (!account) return
        if (econLimited(account.id, res)) return
        const r = economy.castFish(account.id)
        res.writeHead(r.ok ? 200 : 400, JSON_H)
        res.end(JSON.stringify(r))
      })
      return
    }
    // 낚시 당기기(member+) — 입질 시간창(서버 권위) 판정. 본문 { token }.
    if (req.method === 'POST' && req.url === '/dottown/fish/pull') {
      void readJsonBody(req).then((body) => {
        const account = requireMember(body, res)
        if (!account) return
        if (econLimited(account.id, res)) return
        const r = economy.pullFish(account.id)
        res.writeHead(r.ok ? 200 : 400, JSON_H)
        res.end(JSON.stringify(r))
      })
      return
    }
    // 물고기 판매(member+) — itemId 생략 시 전량. 본문 { token, itemId? }.
    if (req.method === 'POST' && req.url === '/dottown/fish/sell') {
      void readJsonBody(req).then((body) => {
        const account = requireMember(body, res)
        if (!account) return
        if (econLimited(account.id, res)) return
        const itemId = typeof body.itemId === 'string' ? body.itemId : undefined
        const r = economy.sellFish(account.id, itemId)
        if (r.ok) io.to('user:' + account.id).emit('dottown:coin', { balance: r.balance })
        res.writeHead(r.ok ? 200 : 400, JSON_H)
        res.end(JSON.stringify(r))
      })
      return
    }
    // 구버전 낚시 경로 — 현재는 미지원(조용한 실패 대신 업데이트 안내).
    if (req.method === 'POST' && req.url === '/dottown/fish') {
      res.writeHead(400, JSON_H)
      res.end(JSON.stringify({ ok: false, error: '앱이 구버전이에요. 업데이트하면 새 낚시 미니게임을 즐길 수 있어요.' }))
      return
    }
    // 요리(member+) — 레시피 재료 소비 + 코인 보상. 본문 { token, recipeId }.
    if (req.method === 'POST' && req.url === '/dottown/cook') {
      void readJsonBody(req).then((body) => {
        const account = requireMember(body, res)
        if (!account) return
        if (econLimited(account.id, res)) return
        const recipeId = typeof body.recipeId === 'string' ? body.recipeId : ''
        const r = economy.cook(account.id, recipeId)
        if (r.ok) io.to('user:' + account.id).emit('dottown:coin', { balance: r.balance })
        res.writeHead(r.ok ? 200 : 400, JSON_H)
        res.end(JSON.stringify(r))
      })
      return
    }

    // ===== 도트타운 광장 부동산 — 빈터 입주(전세/월세)·외형·월세납부·퇴거 =====
    // 스냅샷(member+) — 20칸 + 내 집. 본문 { token }.
    if (req.method === 'POST' && req.url === '/dottown/estate') {
      void readJsonBody(req).then((body) => {
        const account = requireMember(body, res)
        if (!account) return
        res.writeHead(200, JSON_H)
        res.end(JSON.stringify({ ok: true, lots: estate.lots(), myLot: estate.myLot(account.id) }))
      })
      return
    }
    // 입주(member+) — 빈 칸에 전세/월세로 건물 세움(계정당 1채). 본문 { token, index, tenancy, style }.
    if (req.method === 'POST' && req.url === '/dottown/estate/lease') {
      void readJsonBody(req).then((body) => {
        const account = requireMember(body, res)
        if (!account) return
        if (econLimited(account.id, res)) return
        const index = typeof body.index === 'number' ? body.index : -1
        const tenancy = body.tenancy === 'wolse' ? 'wolse' : 'jeonse'
        const style = typeof body.style === 'number' ? body.style : 0
        const r = estate.lease(account.id, displayNick(account.id) || account.username, index, tenancy, style)
        if (r.ok) {
          io.to('user:' + account.id).emit('dottown:coin', { balance: r.balance ?? economy.balanceOf(account.id) })
          broadcastLots()
        }
        res.writeHead(r.ok ? 200 : 400, JSON_H)
        res.end(JSON.stringify(r))
      })
      return
    }
    // 건물 외형 변경(member+·무료). 본문 { token, style }.
    if (req.method === 'POST' && req.url === '/dottown/estate/style') {
      void readJsonBody(req).then((body) => {
        const account = requireMember(body, res)
        if (!account) return
        if (econLimited(account.id, res)) return
        const style = typeof body.style === 'number' ? body.style : 0
        const r = estate.setStyle(account.id, style)
        if (r.ok) broadcastLots()
        res.writeHead(r.ok ? 200 : 400, JSON_H)
        res.end(JSON.stringify(r))
      })
      return
    }
    // 월세 납부(member+·하루치). 본문 { token }.
    if (req.method === 'POST' && req.url === '/dottown/estate/pay') {
      void readJsonBody(req).then((body) => {
        const account = requireMember(body, res)
        if (!account) return
        if (econLimited(account.id, res)) return
        const r = estate.payRent(account.id)
        if (r.ok) io.to('user:' + account.id).emit('dottown:coin', { balance: r.balance ?? economy.balanceOf(account.id) })
        res.writeHead(r.ok ? 200 : 400, JSON_H)
        res.end(JSON.stringify(r))
      })
      return
    }
    // 방 빼기(member+·환불 없음). 본문 { token }.
    if (req.method === 'POST' && req.url === '/dottown/estate/moveout') {
      void readJsonBody(req).then((body) => {
        const account = requireMember(body, res)
        if (!account) return
        if (econLimited(account.id, res)) return
        const r = estate.moveOut(account.id)
        if (r.had) broadcastLots()
        res.writeHead(200, JSON_H)
        res.end(JSON.stringify(r))
      })
      return
    }

    // ===== 도트타운 UGC 마켓 — 유저 제작 가구/의상 등록·구매(창작 경제) =====
    // 공개 목록(숨김 제외) — GET /dottown/market.
    if (req.method === 'GET' && req.url && (req.url === '/dottown/market' || req.url.startsWith('/dottown/market?'))) {
      res.writeHead(200, JSON_H)
      res.end(JSON.stringify({ ok: true, items: market.list() }))
      return
    }
    // 내 상태(보유 + 내 등록) — 토큰 인증. 본문 { token }.
    if (req.method === 'POST' && req.url === '/dottown/market/state') {
      void readJsonBody(req).then((body) => {
        const account = typeof body.token === 'string' ? auth.verifyToken(body.token) : null
        if (!account) {
          res.writeHead(401, JSON_H)
          res.end(JSON.stringify({ ok: false, error: '인증이 필요합니다.' }))
          return
        }
        res.writeHead(200, JSON_H)
        res.end(JSON.stringify({ ok: true, owned: market.ownedItems(account.id), listings: market.mine(account.id) }))
      })
      return
    }
    // 등록(member+) — 본문 { token, kind, name, price, files:{key:'asset:<hash>'}, layer?, flippable? }.
    //   업로드된 자산을 서버가 직접 읽어 PNG·치수·용량을 재검증(클라 신뢰 안 함). 창작자에게 소유권 자동 부여.
    if (req.method === 'POST' && req.url === '/dottown/market/submit') {
      void readJsonBody(req).then((body) => {
        const account = requireMember(body, res)
        if (!account) return
        if (econLimited(account.id, res)) return
        const kind = body.kind === 'clothes' ? 'clothes' : 'furniture'
        const inFiles = body.files && typeof body.files === 'object' ? (body.files as Record<string, unknown>) : {}
        const cleanFiles: Record<string, string> = {}
        for (const [key, ref] of Object.entries(inFiles).slice(0, 16)) {
          if (typeof ref !== 'string') continue
          const hash = ref.startsWith('asset:') ? ref.slice(6) : ref
          if (!assets.isHash(hash)) continue
          const a = assets.read(hash)
          if (!a || a.bytes.length > MARKET_FILE_MAX) {
            res.writeHead(400, JSON_H)
            res.end(JSON.stringify({ ok: false, error: '이미지가 없거나 너무 커요(파일당 256KB 이하).' }))
            return
          }
          const dim = pngDimensions(a.bytes)
          if (!dim) {
            res.writeHead(400, JSON_H)
            res.end(JSON.stringify({ ok: false, error: 'PNG 이미지만 올릴 수 있어요.' }))
            return
          }
          if (kind === 'clothes' && (dim.w !== CHAR_CANVAS.w || dim.h !== CHAR_CANVAS.h)) {
            res.writeHead(400, JSON_H)
            res.end(JSON.stringify({ ok: false, error: `의상은 ${CHAR_CANVAS.w}×${CHAR_CANVAS.h} 크기여야 해요.` }))
            return
          }
          if (kind === 'furniture' && (dim.w > FURN_MAX || dim.h > FURN_MAX)) {
            res.writeHead(400, JSON_H)
            res.end(JSON.stringify({ ok: false, error: `가구는 ${FURN_MAX}px 이하여야 해요.` }))
            return
          }
          cleanFiles[key] = hash
        }
        const r = market.submit(account.id, account.nickname || account.username, {
          kind,
          name: body.name,
          price: body.price,
          files: cleanFiles,
          layer: body.layer,
          flippable: body.flippable
        })
        if (r.ok) market.grantOwnership(account.id, r.item) // 창작자는 자기 작품을 보유(등록을 내려도 사용 가능)
        res.writeHead(r.ok ? 200 : 400, JSON_H)
        res.end(JSON.stringify(r))
      })
      return
    }
    // 구매(member+) — 코인 이체(창작자 90% + 수수료 10% 소각) + 소유권. 본문 { token, itemId }.
    if (req.method === 'POST' && req.url === '/dottown/market/buy') {
      void readJsonBody(req).then((body) => {
        const account = requireMember(body, res)
        if (!account) return
        if (econLimited(account.id, res)) return
        const itemId = typeof body.itemId === 'string' ? body.itemId : ''
        const item = market.getItem(itemId)
        if (!item || item.hidden) {
          res.writeHead(404, JSON_H)
          res.end(JSON.stringify({ ok: false, error: '판매 중이 아닌 아이템이에요.' }))
          return
        }
        if (item.creatorId === account.id || market.owns(account.id, itemId)) {
          res.writeHead(400, JSON_H)
          res.end(JSON.stringify({ ok: false, error: '이미 보유한 아이템이에요.' }))
          return
        }
        if (item.price > 0) {
          const fee = Math.floor((item.price * MARKET_FEE_PCT) / 100)
          const r = economy.transfer(account.id, item.creatorId, item.price, fee)
          if (!r.ok) {
            res.writeHead(400, JSON_H)
            res.end(JSON.stringify({ ok: false, error: r.error ?? '구매하지 못했어요.' }))
            return
          }
          io.to('user:' + account.id).emit('dottown:coin', { balance: r.fromBalance })
          io.to('user:' + item.creatorId).emit('dottown:coin', { balance: r.toBalance })
        }
        market.grantOwnership(account.id, item)
        res.writeHead(200, JSON_H)
        res.end(JSON.stringify({ ok: true, balance: economy.balanceOf(account.id) }))
      })
      return
    }
    // 등록 내리기(창작자 또는 관리자) — 본문 { token, itemId }.
    if (req.method === 'POST' && req.url === '/dottown/market/remove') {
      void readJsonBody(req).then((body) => {
        const account = typeof body.token === 'string' ? auth.verifyToken(body.token) : null
        if (!account) {
          res.writeHead(401, JSON_H)
          res.end(JSON.stringify({ ok: false, error: '인증이 필요합니다.' }))
          return
        }
        if (econLimited(account.id, res)) return
        const itemId = typeof body.itemId === 'string' ? body.itemId : ''
        const r = market.remove(itemId, account.id, account.role === 'admin')
        res.writeHead(r.ok ? 200 : 403, JSON_H)
        res.end(JSON.stringify(r))
      })
      return
    }
    // 커뮤니티 — 맡았으면 응답까지 끝낸다. 정적 서빙보다 앞이어야 한다(뒤면 404 JSON 으로 흘러간다).
    if (communityRoutes(req, res)) return

    // 웹 클라이언트(웹판) 정적 서빙 — webRoot 의 실존 파일만. 그 외는 아래 404 JSON(구버전 감지 신호)로.
    if ((req.method === 'GET' || req.method === 'HEAD') && req.url) {
      const f = resolveWebFile(req.url)
      if (f) {
        // 재검증이 304 로 끝나게(약검증자 — 크기+수정시각. 재배포로 파일이 바뀌면 태그도 바뀐다).
        if (req.headers['if-none-match'] === f.etag) {
          const head304: Record<string, string> = { etag: f.etag }
          // 304 에 빠진 헤더는 브라우저가 캐시본의 것을 그대로 쓴다. 정책만 바뀌고 파일은 그대로인 배포에서
          // 옛 정책이 계속 적용되지 않도록, 재검증 응답에도 같은 정책을 실어 보낸다.
          if (f.type.startsWith('text/html')) head304['content-security-policy'] = WEB_CSP
          res.writeHead(304, head304)
          res.end()
          return
        }
        // 해시 파일명(assets/)은 불변 캐시, index.html·yt.html 등 이름 고정 파일은 항상 재검증(재배포 즉시 반영).
        // ⚠ webRoot '상대' 경로로 판정 — 절대경로 검사면 상위 폴더명에 assets 가 있을 때 전부 불변 캐시가 된다.
        const immutable = f.rel.startsWith(`assets${sep}`)
        const head: Record<string, string | number> = {
          'content-type': f.type,
          'content-length': f.size,
          etag: f.etag,
          'cache-control': immutable ? 'public, max-age=31536000, immutable' : 'no-cache',
          'x-content-type-options': 'nosniff'
        }
        // 문서에만 정책을 건다(스크립트·스타일 파일에 붙여 봐야 의미가 없고, 하위 리소스는 문서 정책을 따른다).
        if (f.type.startsWith('text/html')) head['content-security-policy'] = WEB_CSP
        res.writeHead(200, head)
        if (req.method === 'HEAD') {
          res.end()
          return
        }
        const stream = createReadStream(f.path)
        stream.on('error', () => res.destroy()) // 읽기 실패(전송 중 삭제 등) — 연결 종료
        stream.pipe(res)
        return
      }
    }
    // 미매칭 라우트 — 빈 404 대신 사유를 JSON 으로 알려, 신버전 클라가 구버전 서버를 만났을 때
    // '연결 불가'가 아니라 '서버 업데이트 필요'로 안내할 수 있게 한다.
    res.writeHead(404, JSON_H)
    res.end(JSON.stringify({ ok: false, error: '이 서버에 없는 기능입니다. 서버 프로그램을 최신 버전으로 업데이트해 주세요.' }))
  }

  // tls 제공 시 https(wss), 아니면 http(ws). 양쪽 다 동일 핸들러 사용.
  const httpServer: HttpServer | HttpsServer = opts?.tls
    ? createHttpsServer({ key: opts.tls.key, cert: opts.tls.cert }, handler)
    : createServer(handler)

  const io = new Server<ClientToServerEvents, ServerToClientEvents, Record<string, never>, SocketData>(
    httpServer,
    {
      // 화이트리스트 설정 시 일치 origin·무(無)origin만 허용, 미설정이면 전체(개발/로컬).
      cors: corsOrigins ? { origin: (origin, cb) => cb(null, originAllowed(origin)) } : { origin: '*' },
      // 소켓 프레임 상한. 정상 미디어는 /asset(HTTP)로 올려 'asset:' 참조(수십 바이트)로 오므로 소켓 메시지는 작다.
      // 인라인이 남는 유일한 정상 경로는 캐릭터 두상(char:update — 개당 ≤~0.9MB × 최대 24 ≈ 22MB)뿐 → 그 위 여유로 48MB.
      // 큰 미디어는 소켓이 아니라 /asset 업로드로만 받는다(단일 대용량 메시지가 이벤트 루프를 막는 것을 방지).
      maxHttpBufferSize: 48 * 1024 * 1024,
      // 하트비트: 죽은(half-open) 소켓을 빨리 감지해 '핑 타임아웃'(복구 가능 사유)으로 정리한다. 타임아웃이 길면
      // 죽은 소켓을 한참 살아 있다고 착각해, 클라가 그 전에 새로 연결하면서 세션 복구가 실패(풀 재입장)할 수 있다.
      // 큰 미디어는 /asset(HTTP)로 빠져 이벤트 루프가 길게 막히지 않으므로 짧은 타임아웃이 안전하다.
      pingInterval: 20000,
      pingTimeout: 30000,
      // 세션 복구 — 잠깐 끊긴 재접속(2분 내)은 방·놓친 이벤트를 자동 복원해 대용량 스냅샷 재전송 없이 이어간다.
      // 인증 미들웨어는 재실행(skipMiddlewares:false)해 토큰을 매 재접속마다 재검증.
      connectionStateRecovery: {
        maxDisconnectionDuration: 2 * 60 * 1000,
        skipMiddlewares: false
      }
    }
  )

  // 도트타운 광장 허브 — 휘발 멀티플레이(인메모리). 100ms 틱을 광장 룸으로 송출. 종료 시 인터벌 정리.
  const plaza = createPlazaHub({
    onTick: (plazaId, tick) => io.to('plaza:' + plazaId).emit('plaza:tick', tick)
  })
  httpServer.on('close', () => plaza.dispose())

  // 마이룸 실시간 방문 허브 — 방(roomId=소유자 id)별 휘발 프레즌스. 틱을 그 방 소켓룸(roomvisit:<id>)으로만 송출.
  const roomVisit = createRoomPresenceHub({
    onTick: (roomId, tick) => io.to('roomvisit:' + roomId).emit('roomvisit:tick', tick)
  })
  httpServer.on('close', () => roomVisit.dispose())

  // 부동산 변경 반영 — 이동 차단셀(점유 건물) 갱신 + 광장 룸에 최신 20칸 전송.
  broadcastLots = (): void => {
    plaza.setLotBlocked(estate.blockedCells())
    io.to('plaza:' + PLAZA_ID).emit('plaza:lots', { plazaId: PLAZA_ID, lots: estate.lots() })
  }
  plaza.setLotBlocked(estate.blockedCells()) // 시작 시 초기 차단셀
  // 연체 월세 자동 퇴거 — 1분마다 스윕. 뺀 칸이 있으면 브로드캐스트(광장에서 건물만 사라짐 — 실제 마이룸은 보존).
  const estateSweep = setInterval(() => {
    if (estate.sweep().length) broadcastLots()
  }, 60_000)
  if (typeof estateSweep.unref === 'function') estateSweep.unref()
  httpServer.on('close', () => clearInterval(estateSweep))

  // 각 방의 플레이어별 현재 맵 위치 — key=roomId → (playerId → mapId). GM 위치 표시용(휘발·비영속).
  const roomPositions = new Map<string, Map<string, string>>()
  // 같은 구조의 플레이어별 현재 뷰(map|vn) — GM '이동' 메뉴에서 같은 맵 내 일반↔비주얼노벨 전환을 보이게 한다(휘발·비영속).
  const roomViews = new Map<string, Map<string, 'map' | 'vn'>>()

  // 핸드아웃 대상 라우팅 헬퍼(개인 룸 user:pid). pid 빈 배열이면 no-op(전체 브로드캐스트 방지).
  const emitHandoutState = (pids: string[], h: Handout): void => {
    if (pids.length) io.to(pids.map((p) => 'user:' + p)).emit('handout:state', h)
  }
  const emitHandoutRemove = (pids: string[], id: string): void => {
    if (pids.length) io.to(pids.map((p) => 'user:' + p)).emit('handout:remove', { id })
  }
  const emitHandoutFocus = (pids: string[], id: string): void => {
    if (pids.length) io.to(pids.map((p) => 'user:' + p)).emit('handout:focus', { id })
  }

  // 인증 미들웨어: 토큰 검증 → socket.data 에 account/playerId 부착. requireAuth 면 무효 토큰 연결 거부.
  io.use((socket, next) => {
    const hs = socket.handshake.auth as { token?: unknown; playerId?: unknown }
    const account = typeof hs?.token === 'string' ? auth.verifyToken(hs.token) : null
    if (requireAuth && !account) {
      next(new Error('AUTH_REQUIRED'))
      return
    }
    socket.data.account = account ?? undefined
    socket.data.playerId = account
      ? account.id
      : typeof hs?.playerId === 'string' && hs.playerId
        ? hs.playerId
        : randomUUID()
    next()
  })

  io.on('connection', (socket) => {
    // playerId/account 는 인증 미들웨어가 socket.data 에 채워둠.
    const playerId = socket.data.playerId

    // 같은 기기의 죽은 옛 소켓은 강제로 끊지 않고 pingTimeout(위 Server 옵션)으로 스스로 정리되게 둔다 —
    // 강제 종료 사유는 복구 불가라 connectionStateRecovery 의 세션 저장을 막지만, 핑 타임아웃은 복구 가능
    // 사유라 다음 재접속이 세션 복구로 이어진다.
    log(
      'connect',
      playerId.slice(0, 8),
      'sockets',
      io.sockets.sockets.size,
      'rssMB',
      Math.round(process.memoryUsage().rss / 1048576)
    )

    // 모든 연결: 개인 룸 입장 — DM·귓속말·핸드아웃 타깃은 이 룸으로 전달된다. 방 입장 핸들러도 조인하지만,
    // 방 밖(로비)에서도 DM 을 받으려면 '연결 시점'에 미리 들어가 있어야 한다(조인은 멱등).
    void socket.join('user:' + playerId)

    // 인증 계정: 개인 계정 룸 입장 + 캐릭터 라이브러리 전송(다기기 영속 동기화 기반) + 전역 프레즌스 등록.
    const account = socket.data.account
    if (account) {
      void socket.join('acct:' + account.id)
      auth.touchSeen(account.id) // 마지막 접속 기록(연결 시점 — 종료 시점은 disconnect 에서)
      // 라이브러리 전송은 '새(콜드) 연결'에만 — connectionStateRecovery 로 '복구된' 재접속(아래 socket.recovered 처리)은
      // 클라가 이미 캐릭터를 들고 있으므로, 전체 라이브러리를 다시 밀어 넣으면 편집 중인 시트를 옛 스냅샷으로 덮는다(글자 사라짐).
      if (!socket.recovered) socket.emit('char:library', characters.list(account.id))
      // 전역 프레즌스: 이 계정의 소켓 집합에 추가. 표시 상태가 바뀌면 전체 알림(invisible 이면 무음 — 오프라인 위장).
      const set = presence.get(account.id) ?? new Set<string>()
      set.add(socket.id)
      presence.set(account.id, set)
      syncPresence(account.id)
      // 접속자에게 현재 스냅샷 — online 은 위장 반영, statuses 는 'online' 아닌 항목만, self 는 내 실상태(본인 UI 시드).
      const statuses: Record<string, PublicPresenceStatus> = {}
      const onlineIds: string[] = []
      for (const id of presence.keys()) {
        if (!visibleOnline(id)) continue
        onlineIds.push(id)
        const st = publicStatus(id)
        if (st && st !== 'online') statuses[id] = st
      }
      // self 는 '수동' 상태만 시드 — 실효값(자동 session)을 보내면 재접속 시 그 파생값이 클라 '내 상태'로 고착된다.
      socket.emit('dm:presence:init', { online: onlineIds, statuses, self: auth.getStatus(account.id) ?? 'online' })
      // 현재 등급을 1회 동기화 — 오프라인 중 관리자가 등급을 바꿔 role:changed 푸시를 놓쳤어도, 재접속 시
      // 클라 UI(손님 배너·게이팅)가 stale 로 남지 않게 한다. applyRole 가 동일 값이면 무시하므로 비용 없음.
      socket.emit('role:changed', { role: account.role })
    }

    const broadcastParticipants = (roomId: string): void => {
      const room = store.getRoom(roomId)
      if (room) io.to(roomId).emit('room:participants', store.participants(room))
    }
    // 각 플레이어의 현재 맵 위치를 GM 들에게만 집계 전달. 참가자 목록에 있는 위치만 포함(이탈자 자동 제외).
    const emitPositions = (roomId: string): void => {
      const room = store.getRoom(roomId)
      if (!room) return
      const pos = roomPositions.get(roomId)
      const vws = roomViews.get(roomId)
      const positions: Record<string, string> = {}
      const views: Record<string, 'map' | 'vn'> = {}
      if (pos) for (const [pid, mid] of pos) if (room.participants.has(pid)) positions[pid] = mid
      if (vws) for (const [pid, v] of vws) if (room.participants.has(pid)) views[pid] = v
      for (const p of room.participants.values()) {
        if (p.role === 'GM') io.to('user:' + p.playerId).emit('room:positions', { positions, views })
      }
    }

    // 세션 복구 재접속(connectionStateRecovery) — socket.rooms·socket.data·놓친 이벤트가 자동 복원됨.
    // 따라서 클라가 재입장(room:join)으로 대용량 스냅샷을 다시 받지 않아도 되고, 여기선 브리프 끊김 때
    // markDisconnected 로 connected=false 됐던 온라인 표시만 되돌린다(+ GM 위치 집계 갱신).
    if (socket.recovered && socket.data.roomId) {
      if (store.markConnected(socket.data.roomId, playerId)) broadcastParticipants(socket.data.roomId)
      emitPositions(socket.data.roomId)
      // connected 복원 뒤 실효 상태 재브로드캐스트 — 연결 초기 syncPresence 는 connected=false 시점이라
      // '세션중'이 'online'으로 어긋난 채 고착된다(room:join 정상 경로와 동일하게 맞춤).
      if (account) syncPresence(account.id)
      log(
        'recovered',
        playerId.slice(0, 8),
        socket.data.roomId.slice(0, 8),
        'sockets',
        io.sockets.sockets.size
      )
    }

    // 현재 소켓의 세션방 소속을 끊는 공통 정리 — room:leave 와 '다른 방 입장 시 자동 퇴장'이 공유한다.
    // 이전 방의 소켓룸에 남은 채 새 방에 들어가면(직전 room:leave 유실 등) 두 방 방송을 동시에 받아
    // 이전 방의 BGM 이 새 방에서 들리므로, 새 방 배정 전에 반드시 여기로 소속을 정리한다.
    const leaveCurrentRoom = (): void => {
      const roomId = socket.data.roomId
      if (!roomId) return
      void socket.leave(roomId)
      const remaining = store.leave(roomId, playerId)
      // 휘발 위치·뷰맵 정리: 방이 사라졌으면 통째로, 아니면 떠난 플레이어 항목만 제거(누수 방지).
      if (!remaining) {
        roomPositions.delete(roomId)
        roomViews.delete(roomId)
      } else {
        roomPositions.get(roomId)?.delete(playerId)
        roomViews.get(roomId)?.delete(playerId)
      }
      socket.data.roomId = undefined
      broadcastParticipants(roomId)
    }

    socket.on('room:create', async (req, ack) => {
      // 손님(승인 대기)은 세션방을 만들 수 없다(호스팅 용량 보호). 멤버·관리자만 생성하며 생성자가 그 방의 GM(소유자).
      if (socket.data.account?.role === 'guest') {
        ack?.({ ok: false, error: '손님 계정은 세션방을 만들 수 없습니다. 관리자 승인 후 이용해 주세요.' })
        return
      }
      const { room, self } = store.createRoom({
        playerId,
        nick: req?.nick ?? '',
        color: req?.color ?? '',
        accountId: socket.data.account?.id,
        title: typeof req?.title === 'string' ? req.title : undefined,
        cardImage: typeof req?.cardImage === 'string' ? req.cardImage : undefined
      })
      if (socket.data.roomId && socket.data.roomId !== room.id) leaveCurrentRoom() // 이전 방 자동 퇴장(이중 소속 차단)
      socket.data.roomId = room.id
      void socket.join(room.id)
      void socket.join('user:' + playerId) // 개인 룸(귓속말/비밀/추방/핸드아웃 타깃)
      if (socket.data.account) syncPresence(socket.data.account.id) // '세션중' 자동 파생
      ack?.({ ok: true, data: { self, room: await lightenAvatarPool(store.snapshot(room, self)) } })
      broadcastParticipants(room.id)
      emitPositions(room.id) // 입장 GM 에게 현재 위치 집계 전달
    })

    socket.on('room:join', async (req, ack) => {
      if (!req?.code) {
        ack?.({ ok: false, error: '초대 코드를 입력하세요.' })
        return
      }
      const res = store.joinByCode(req.code, {
        playerId,
        nick: req.nick ?? '',
        color: req.color ?? '',
        accountId: socket.data.account?.id
      })
      if ('error' in res) {
        ack?.({ ok: false, error: res.error })
        return
      }
      if (socket.data.roomId && socket.data.roomId !== res.room.id) leaveCurrentRoom() // 이전 방 자동 퇴장(이중 소속 차단)
      socket.data.roomId = res.room.id
      void socket.join(res.room.id)
      void socket.join('user:' + playerId) // 개인 룸(귓속말/비밀/추방/핸드아웃 타깃)
      if (socket.data.account) syncPresence(socket.data.account.id) // '세션중' 자동 파생
      const snap = await lightenAvatarPool(store.snapshot(res.room, res.self))
      // 재입장 착지 맵 — 이 플레이어가 마지막으로 보고한 맵(room:where)이 살아 있으면 거기로.
      const last = roomPositions.get(res.room.id)?.get(playerId)
      if (last && res.room.maps.has(last)) snap.activeMapId = last
      ack?.({ ok: true, data: { self: res.self, room: snap } })
      broadcastParticipants(res.room.id)
      emitPositions(res.room.id)
    })

    // ===== 세션방 목록·관리 (서버 영속) — 전부 인증 계정 기준. 메타/삭제/복사/채팅삭제=소유자 =====
    socket.on('room:list', (ack) => {
      const acct = socket.data.account
      ack?.({ ok: true, data: acct ? store.listForAccount(acct.id) : [] })
    })

    socket.on('room:enter', async (req, ack) => {
      if (!req?.roomId) {
        ack?.({ ok: false, error: '세션을 선택하세요.' })
        return
      }
      const res = store.enterRoom(req.roomId, {
        playerId,
        nick: req.nick ?? '',
        color: req.color ?? '',
        accountId: socket.data.account?.id
      })
      if ('error' in res) {
        ack?.({ ok: false, error: res.error })
        return
      }
      if (socket.data.roomId && socket.data.roomId !== res.room.id) leaveCurrentRoom() // 이전 방 자동 퇴장(이중 소속 차단)
      socket.data.roomId = res.room.id
      void socket.join(res.room.id)
      void socket.join('user:' + playerId)
      if (socket.data.account) syncPresence(socket.data.account.id) // '세션중' 자동 파생
      ack?.({ ok: true, data: { self: res.self, room: await lightenAvatarPool(store.snapshot(res.room, res.self)) } })
      broadcastParticipants(res.room.id)
      emitPositions(res.room.id)
    })

    socket.on('room:setMeta', (req, ack) => {
      const acct = socket.data.account
      if (!acct || !req?.roomId) {
        ack?.({ ok: false, error: '권한이 없습니다.' })
        return
      }
      const sum = store.setMeta(req.roomId, acct.id, { title: req.title, cardImage: req.cardImage })
      if (!sum) {
        ack?.({ ok: false, error: '세션을 수정할 수 없습니다(소유자만).' })
        return
      }
      ack?.({ ok: true, data: sum })
    })

    socket.on('room:delete', (req, ack) => {
      const acct = socket.data.account
      if (!acct || !req?.roomId) {
        ack?.({ ok: false, error: '권한이 없습니다.' })
        return
      }
      const res = store.deleteRoom(req.roomId, acct.id)
      if (!res) {
        ack?.({ ok: false, error: '세션을 삭제할 수 없습니다(소유자만).' })
        return
      }
      // 입장 중인 참가자 강제 퇴장.
      for (const pid of res.participants) {
        io.to('user:' + pid).emit('room:closed', '세션이 삭제되었습니다.')
        void io.in('user:' + pid).socketsLeave(req.roomId)
        syncPresence(pid) // '세션중' 표시 해제(inSession 이 store 재검증이라 roomId 잔존해도 안전)
      }
      ack?.({ ok: true, data: { id: req.roomId } })
    })

    // 참가자 본인의 멤버십 탈퇴 — '내 세션 목록'에서 제거(소유자는 불가). 같은 초대 코드로 재참가 가능.
    socket.on('room:leaveMembership', (req, ack) => {
      const acct = socket.data.account
      if (!acct || !req?.roomId) {
        ack?.({ ok: false, error: '권한이 없습니다.' })
        return
      }
      const r = store.leaveMembership(req.roomId, acct.id, playerId)
      if ('error' in r) {
        ack?.({ ok: false, error: r.error })
        return
      }
      // 같은 계정의 '다른 기기'가 이 방에 입장 중이면 통지 + 소켓 상태 정리 — 무통지로 브로드캐스트만 끊기면
      // 그 기기 화면이 소리 없이 정지하고(채팅도 무음 소실) stale roomId 가 방별 시트 멤버십을 오염시킨다.
      for (const s of io.sockets.sockets.values()) {
        if (s.id !== socket.id && s.data.playerId === playerId && s.data.roomId === req.roomId) {
          s.emit('room:closed', '이 세션에서 나갔습니다.')
          s.data.roomId = undefined
        }
      }
      // 지금 그 방에 입장 중이었다면 소켓도 정리(다른 기기 포함).
      void io.in('user:' + playerId).socketsLeave(req.roomId)
      if (socket.data.roomId === req.roomId) socket.data.roomId = undefined
      roomPositions.get(req.roomId)?.delete(playerId)
      roomViews.get(req.roomId)?.delete(playerId)
      broadcastParticipants(req.roomId) // 남은 인원에게 참가자 목록 갱신
      syncPresence(acct.id)
      ack?.({ ok: true, data: { id: req.roomId } })
    })

    socket.on('room:duplicate', (req, ack) => {
      const acct = socket.data.account
      if (!acct || !req?.roomId) {
        ack?.({ ok: false, error: '권한이 없습니다.' })
        return
      }
      if (acct.role === 'guest') {
        ack?.({ ok: false, error: '손님 계정은 세션방을 만들 수 없습니다.' })
        return
      }
      const sum = store.duplicateRoom(req.roomId, acct.id)
      if (!sum) {
        ack?.({ ok: false, error: '세션을 복사할 수 없습니다(소유자만).' })
        return
      }
      ack?.({ ok: true, data: sum })
    })

    socket.on('room:clearChat', (req, ack) => {
      const acct = socket.data.account
      if (!acct || !req?.roomId) {
        ack?.({ ok: false, error: '권한이 없습니다.' })
        return
      }
      if (!store.clearChat(req.roomId, acct.id)) {
        ack?.({ ok: false, error: '채팅을 비울 수 없습니다(소유자만).' })
        return
      }
      io.to(req.roomId).emit('chat:clear') // 입장 중이면 로컬 채팅도 비움
      ack?.({ ok: true, data: { id: req.roomId } })
    })

    socket.on('chat:send', (req) => {
      const roomId = socket.data.roomId
      if (!roomId || !req) return
      const room = store.getRoom(roomId)
      if (!room) return
      const sender = room.participants.get(playerId)
      if (!sender) return // 방에 속하지 않은 소켓은 무시 (위조 방지)

      let raw = (typeof req.text === 'string' ? req.text : '').slice(0, MAX_CHAT_CHARS)
      // 손님(guest) 계정은 채팅 이미지 불가 — [img=...] 마크업을 서버에서 제거(클라 UI 숨김의 우회 방지).
      // 색·크기·기울임·굵기 등 다른 꾸미기는 그대로 허용. 멤버·관리자·GM 은 이미지 허용.
      if (socket.data.account?.role === 'guest') raw = raw.replace(/\[img=[^\]]*\]/gi, '')
      if (!raw.trim()) return

      // 서버 권위 다이스: 명령이면 서버가 굴리고, 아니면 평문 메시지.
      // author/color/playerId 는 서버가 참가자 정보로 스탬프 (클라 전송값 무시 → 위조 방지).
      // script(/desc)는 꾸미기 본문이므로 다이스로 해석하지 않음.
      const isScript = req.script === true
      const dice = isScript ? null : parseCommand(raw)
      const id = randomUUID()
      const time = Date.now()
      const channel = req.channel ?? 'main'
      const secret = req.secret === true
      // GM 1회성 NPC: GM 이고 npcName 이 있으면 그 이름으로 발화, 투명 두상(아바타·이름색 없음). PL 은 무시(위조 방지).
      const npcName =
        sender.role === 'GM' && typeof req.npcName === 'string' ? req.npcName.trim().slice(0, 60) : ''
      const isNpc = npcName.length > 0
      // author/color 는 현재 발화 정체성(프레즌스 = 오너 또는 장착 캐릭터)을 우선 반영, 없으면 참가자 폴백.
      // (정체성 전환 시 클라가 char:update 를 먼저 보내므로 소켓 순서상 최신 정체성이 반영됨.)
      const identity = isNpc ? undefined : room.characters.get(playerId)
      const author = isNpc ? npcName : identity?.name || sender.nick
      const color = isNpc ? '#8b93a7' : identity?.color || sender.color
      // 발화 당시 두상·이름색을 메시지에 각인 — 영속·재시작·새 참가자에도 채팅 두상 보존. NPC 는 투명 두상이라 미설정.
      const avatar = isNpc ? undefined : presenceHeadshot(identity)
      const nameColor = isNpc ? undefined : identity?.nameColor
      const base = {
        id,
        time,
        channel,
        author,
        playerId,
        color,
        avatar,
        nameColor,
        ...(isNpc ? { npc: true as const } : {})
      }
      const message: ChatMessage = dice
        ? { ...base, kind: 'dice', dice }
        : {
            ...base,
            kind: isScript ? 'script' : req.narration ? 'narration' : 'speech',
            // 인라인 굴림 [[1d100]] 을 서버 권위로 1회 해석 → 전원 같은 숫자. 채팅·스크립트 공통.
            text: resolveInlineRolls(raw.trim())
          }

      // ── 대상 필터링: 개인 룸(user:playerId)으로 라우팅. 히스토리에는 저장하되(재입장 보존)
      //    내보낼 때 뷰어별로 걸러(store.snapshot) 제3자에게는 실리지 않는다. ──
      if (secret) {
        // 비밀 굴림/메시지: GM + 본인에게만.
        message.secret = true
        store.addMessage(roomId, message)
        io.to(secretTargets(room, playerId)).emit('chat:new', message)
        return
      }
      if (channel === 'whisper' && typeof req.to === 'string' && req.to) {
        // 귓속말: 발신자 + 대상에게만(방 안의 대상만).
        if (!room.participants.has(req.to)) return
        message.to = req.to
        store.addMessage(roomId, message)
        io.to(['user:' + playerId, 'user:' + req.to]).emit('chat:new', message)
        return
      }
      if (channel === 'group' && typeof req.groupId === 'string' && req.groupId) {
        // 그룹 채널: 멤버 + GM 에게만(휘발 — 히스토리 미저장). 발신 권한 검증(멤버/GM).
        if (!store.canAccessChannel(roomId, req.groupId, playerId)) return
        message.groupId = req.groupId
        const targets = store.channelRecipients(roomId, req.groupId).map((id) => 'user:' + id)
        if (targets.length) io.to(targets).emit('chat:new', message)
        return
      }
      // 공개: 히스토리 저장 + 방 전체 브로드캐스트.
      store.addMessage(roomId, message)
      io.to(roomId).emit('chat:new', message)
      // 비주얼 카드 트리거 — 텍스트(발화·지문·스크립트)는 마크업을 벗긴 본문에 카드 이름이 '포함'되면,
      // 주사위는 결과 라벨(성공/실패/단계)이 카드 이름과 정확히 일치하면 전원 오버레이 재생.
      // 한 발화에 컷인 1개(포함 매칭은 긴 이름 우선). 발화 순간 1회만 emit 하므로 히스토리 재생·재입장에는
      // 다시 뜨지 않는다(클라 오버레이도 nonce 로 과거 트리거를 무시).
      if ('text' in message && message.text) {
        const card = store.findCardInText(roomId, message.text)
        if (card) io.to(roomId).emit('room:cardplay', { card })
      } else if (message.kind === 'dice' && message.dice) {
        // 라벨 굴림(예: "CC<=60 (근력)")은 기능명이 카드 이름과 겹칠 수 있어 원문 포함 매칭을
        // 우선한다 — 평문 발화의 카드 트리거와 동일 규칙. 무라벨 명령은 결과 라벨 키워드만 본다.
        const named =
          'name' in message.dice && message.dice.name
            ? store.findCardInText(roomId, message.dice.command)
            : undefined
        if (named) {
          io.to(roomId).emit('room:cardplay', { card: named })
        } else {
          for (const key of diceCardKeywords(message.dice)) {
            const card = store.findCardByTitle(roomId, key)
            if (card) {
              io.to(roomId).emit('room:cardplay', { card })
              break
            }
          }
        }
      }
    })

    // ===== 클라가 굴린 결과 중계 (시트 주사위·광기) =====
    // chat:send 와 달리 서버가 재굴림하지 않고 payload(dice/madness)를 신뢰해 그대로 브로드캐스트
    // (라벨·광기표 등 서버가 재현 못하는 결과 보존). author/color/playerId 는 서버가 정체성으로 스탬프(위조 방지).
    socket.on('chat:roll', (req) => {
      const roomId = socket.data.roomId
      if (!roomId || !req) return
      const room = store.getRoom(roomId)
      if (!room) return
      const sender = room.participants.get(playerId)
      if (!sender) return // 방 밖 소켓 무시 (위조 방지)

      const kind = req.kind === 'madness' ? 'madness' : 'dice'
      const dice = kind === 'dice' && req.dice && typeof req.dice === 'object' ? req.dice : undefined
      const madness =
        kind === 'madness' && req.madness && typeof req.madness === 'object' ? req.madness : undefined
      if (!dice && !madness) return // 빈/잘못된 payload 무시

      const id = randomUUID()
      const time = Date.now()
      const channel = req.channel ?? 'main'
      const secret = req.secret === true
      const identity = room.characters.get(playerId)
      const author = identity?.name || sender.nick
      const color = identity?.color || sender.color
      const avatar = presenceHeadshot(identity) // 발화 당시 두상 각인
      const nameColor = identity?.nameColor
      const message: ChatMessage = dice
        ? { id, time, channel, author, playerId, color, avatar, nameColor, kind: 'dice', dice }
        : { id, time, channel, author, playerId, color, avatar, nameColor, kind: 'madness', madness }

      // 라우팅(chat:send 와 동일): 비밀=GM+본인, 귓속말=대상+본인, 그 외 공개=방 전체. 전부 히스토리 저장.
      if (secret) {
        message.secret = true
        store.addMessage(roomId, message)
        io.to(secretTargets(room, playerId)).emit('chat:new', message)
        return
      }
      if (channel === 'whisper' && typeof req.to === 'string' && req.to) {
        if (!room.participants.has(req.to)) return
        message.to = req.to
        store.addMessage(roomId, message)
        io.to(['user:' + playerId, 'user:' + req.to]).emit('chat:new', message)
        return
      }
      if (channel === 'group' && typeof req.groupId === 'string' && req.groupId) {
        // 그룹 채널: 멤버 + GM 에게만(휘발 — 히스토리 미저장). 발신 권한 검증(멤버/GM).
        if (!store.canAccessChannel(roomId, req.groupId, playerId)) return
        message.groupId = req.groupId
        const targets = store.channelRecipients(roomId, req.groupId).map((id) => 'user:' + id)
        if (targets.length) io.to(targets).emit('chat:new', message)
        return
      }
      store.addMessage(roomId, message)
      io.to(roomId).emit('chat:new', message)
      // 시트 굴림도 결과 라벨(성공/실패/단계)로 비주얼 카드 발동 — 공개 굴림만, 광기(madness)는 라벨 없음.
      if (message.kind === 'dice' && message.dice) {
        for (const key of diceCardKeywords(message.dice)) {
          const card = store.findCardByTitle(roomId, key)
          if (card) {
            io.to(roomId).emit('room:cardplay', { card })
            break
          }
        }
      }
    })

    // ===== 행운 성공 전환 결과 카드 — 서버가 정체성 스탬프 후 kind='luck' 로 공개 브로드캐스트(히스토리 저장). =====
    socket.on('chat:luck', (req) => {
      const roomId = socket.data.roomId
      if (!roomId || !req || typeof req.command !== 'string') return
      const room = store.getRoom(roomId)
      if (!room) return
      if (room.luckEnabled === false) return // 하우스룰 OFF 면 행운 전환 무시(위조 방어)
      const sender = room.participants.get(playerId)
      if (!sender) return
      const identity = room.characters.get(playerId)
      const author = identity?.name || sender.nick
      const color = identity?.color || sender.color
      const channel: ChatChannel = req.channel === 'ooc' ? 'ooc' : 'main'
      const cost = Number.isFinite(req.cost) ? Math.max(0, Math.floor(req.cost)) : 0
      const remaining = Number.isFinite(req.remaining) ? Math.max(0, Math.floor(req.remaining)) : 0
      const message: ChatMessage = {
        id: randomUUID(),
        time: Date.now(),
        channel,
        kind: 'luck',
        author,
        playerId,
        color,
        avatar: presenceHeadshot(identity), // 발화 당시 두상 각인
        nameColor: identity?.nameColor,
        luck: { cost, remaining, command: req.command.slice(0, 200) }
      }
      store.addMessage(roomId, message)
      io.to(roomId).emit('chat:new', message)
    })

    // ===== GM 선택지 게시 — 옵션 스크립트는 서버만 보관(비공개), 라벨만 방 전체에 브로드캐스트(히스토리 저장). =====
    socket.on('chat:choice', (req) => {
      const roomId = gmRoomId()
      if (!roomId || !req || typeof req.prompt !== 'string') return
      const opts = Array.isArray(req.options) ? req.options : []
      const stored = opts
        .filter((o) => o && typeof o.label === 'string' && o.label.trim())
        .slice(0, 10)
        .map((o, i) => ({
          id: typeof o.id === 'string' && o.id ? o.id : `o${i}`,
          label: o.label.slice(0, 200),
          script: typeof o.script === 'string' && o.script ? o.script.slice(0, 4000) : undefined
        }))
      if (!stored.length) return
      const id = randomUUID()
      store.setChoice(roomId, id, stored) // 스크립트 포함 서버 보관
      const pub = stored.map((o) => ({ id: o.id, label: o.label })) // 브로드캐스트본은 스크립트 제거
      // 선택지 색 — hex 만 통과(비밀 아님 → 메시지에 실어 영속). 없으면 테마 기본.
      const hex = (c: unknown): string | undefined =>
        typeof c === 'string' && /^#[0-9a-f]{3,8}$/i.test(c.trim()) ? c.trim() : undefined
      const message: ChatMessage = {
        id,
        time: Date.now(),
        channel: 'main',
        kind: 'choice',
        playerId,
        choice: {
          prompt: req.prompt.slice(0, 500),
          options: pub,
          btnColor: hex(req.btnColor),
          bgColor: hex(req.bgColor),
          textColor: hex(req.textColor),
          promptColor: hex(req.promptColor)
        }
      }
      store.addMessage(roomId, message)
      io.to(roomId).emit('chat:new', message)
    })

    // ===== 플레이어 선택지 응답 — 1회만. GM 비공개 통지 +(스크립트 있으면)본인 출력 + 본인 버튼 잠금. =====
    socket.on('choice:select', (req) => {
      const roomId = socket.data.roomId
      if (!roomId || !req || typeof req.messageId !== 'string' || typeof req.optionId !== 'string') return
      const room = store.getRoom(roomId)
      if (!room) return
      const sender = room.participants.get(playerId)
      if (!sender) return
      const res = store.selectChoice(roomId, req.messageId, req.optionId, playerId)
      if (!res) return // 중복 응답·무효 옵션·만료
      const { option } = res
      const name = room.characters.get(playerId)?.name || sender.nick
      // GM 비공개 통지("○○님이 [라벨] 선택").
      const gm = [...room.participants.values()].find((p) => p.role === 'GM')
      if (gm) {
        const notice: ChatMessage = {
          id: randomUUID(),
          time: Date.now(),
          channel: 'main',
          kind: 'system',
          text: `${name}님이 「${option.label}」 선택`
        }
        io.to('user:' + gm.playerId).emit('chat:new', notice)
      }
      // 스크립트가 있으면 선택한 본인에게만 꾸미기 스크립트로 출력.
      if (option.script) {
        const scriptMsg: ChatMessage = {
          id: randomUUID(),
          time: Date.now(),
          channel: 'main',
          kind: 'script',
          text: option.script
        }
        io.to('user:' + playerId).emit('chat:new', scriptMsg)
      }
      // 본인 버튼 잠금(고른 옵션 표시).
      io.to('user:' + playerId).emit('choice:locked', { messageId: req.messageId, optionId: req.optionId })
    })

    // ===== 채팅 수정/삭제 — 수정=작성자 본인/GM(텍스트만), 삭제=GM 만. 서버가 권한 검증 후 방 전체에 반영. =====
    socket.on('chat:edit', (req) => {
      const roomId = socket.data.roomId
      if (!roomId || !req || typeof req.id !== 'string') return
      const room = store.getRoom(roomId)
      if (!room) return
      const sender = room.participants.get(playerId)
      if (!sender) return // 방 밖 소켓 무시
      const text = (typeof req.text === 'string' ? req.text : '').slice(0, MAX_CHAT_CHARS)
      if (!text.trim()) return
      const msg = store.editMessage(roomId, req.id, text, playerId, sender.role === 'GM')
      // 귓속말·비밀 메시지 수정본은 원문과 같은 사람에게만 — 방 전체로 쏘면 본문이 통째로 새어 나간다.
      if (msg) io.to(messageAudience(room, msg)).emit('chat:edited', { id: msg.id, text })
    })

    socket.on('chat:delete', (req) => {
      const roomId = socket.data.roomId
      if (!roomId || !req || typeof req.id !== 'string') return
      const room = store.getRoom(roomId)
      if (!room) return
      const sender = room.participants.get(playerId)
      if (!sender) return
      // 지우기 전에 대상 집합을 뽑아 둔다(삭제 후엔 메시지가 사라져 라우팅을 복원할 수 없다).
      const before = room.messages.find((m) => m.id === req.id)
      const audience = before ? messageAudience(room, before) : [roomId]
      const id = store.deleteMessage(roomId, req.id, sender.role === 'GM')
      if (id) io.to(audience).emit('chat:deleted', { id })
    })

    // ===== 입력 중 표시 (휘발 — 저장 안 함, 발신자 제외 방 전체) =====
    socket.on('chat:typing', (req) => {
      const roomId = socket.data.roomId
      if (!roomId || !req) return
      const room = store.getRoom(roomId)
      if (!room || !room.participants.has(playerId)) return // 방 밖 소켓 무시
      // 어느 탭에서 치는지 그대로 중계(클라가 활성 탭만 표시). channel 미지정이면 'main' 으로 폴백.
      const channel =
        req.channel === 'ooc' || req.channel === 'whisper' || req.channel === 'group' ? req.channel : 'main'
      const groupId = channel === 'group' && typeof req.groupId === 'string' ? req.groupId : undefined
      socket
        .to(roomId)
        .emit('chat:typing', {
          playerId,
          typing: req.typing === true,
          channel,
          ...(groupId ? { groupId } : {})
        })
    })

    // ===== 캐릭터 프레즌스 공유 =====
    socket.on('char:update', (req) => {
      const roomId = socket.data.roomId
      if (!roomId || !req) return
      const room = store.getRoom(roomId)
      if (!room || !room.participants.has(playerId)) return // 방 밖 소켓 무시 (위조 방지)
      // playerId 는 서버 권위 스탬프. 나머지는 방어적 정규화.
      const rawStats = req.stats
      const stats =
        rawStats && typeof rawStats === 'object'
          ? {
              hp: typeof rawStats.hp === 'number' ? rawStats.hp : 0,
              hpMax: typeof rawStats.hpMax === 'number' ? rawStats.hpMax : 0,
              mp: typeof rawStats.mp === 'number' ? rawStats.mp : 0,
              mpMax: typeof rawStats.mpMax === 'number' ? rawStats.mpMax : 0,
              san: typeof rawStats.san === 'number' ? rawStats.san : 0,
              sanMax: typeof rawStats.sanMax === 'number' ? rawStats.sanMax : 0
            }
          : undefined
      const stored = store.setCharacter(roomId, {
        playerId,
        charId: typeof req.charId === 'string' ? req.charId : '',
        name: typeof req.name === 'string' ? req.name : '',
        color: typeof req.color === 'string' && req.color ? req.color : '#7c9cff',
        nameColor: typeof req.nameColor === 'string' ? req.nameColor : undefined, // 이름색(F) 보존
        headshot: typeof req.headshot === 'string' ? req.headshot : undefined,
        standings: Array.isArray(req.standings) ? req.standings.filter((s) => typeof s === 'string') : [],
        // 표정별 두상 — 스탠딩과 index 연동. 빈 문자열(폴백 표시)도 보존.
        headshots: Array.isArray(req.headshots)
          ? req.headshots.filter((s) => typeof s === 'string')
          : undefined,
        currentExpression: typeof req.currentExpression === 'number' ? req.currentExpression : 0,
        visibility: req.visibility === 'public' || req.visibility === 'hidden' ? req.visibility : 'private',
        stats,
        bio: typeof req.bio === 'string' ? req.bio.slice(0, 500) : undefined, // 계정 자기소개(프로필 팝업용)
        banner: typeof req.banner === 'string' && req.banner ? req.banner.slice(0, 1_200_000) : undefined, // 프로필 배너
        links: coerceProfileLinks(req.links), // 프로필 링크(SNS 바이오)
        profileTheme: coerceProfileTheme(req.profileTheme), // 프로필 색 테마
        // VN 무대 스탠딩 표시 높이(px) — 숫자만 통과(setCharacter 가 40~4000 클램프·비유한 드롭). 빠지면 멀티에서 크기 미동기화.
        standingHeight: typeof req.standingHeight === 'number' ? req.standingHeight : undefined
      })
      if (stored) io.to(roomId).emit('char:state', stored)
    })

    socket.on('char:expr', (req) => {
      const roomId = socket.data.roomId
      if (!roomId || !req || typeof req.index !== 'number') return
      const index = store.setExpression(roomId, playerId, req.index)
      if (index !== undefined) io.to(roomId).emit('char:expr', { playerId, index })
    })

    // ===== 추방 (GM 전용) =====
    socket.on('room:kick', (req) => {
      const roomId = socket.data.roomId
      if (!roomId || !req || typeof req.playerId !== 'string') return
      const room = store.getRoom(roomId)
      if (!room) return
      const me = room.participants.get(playerId)
      if (!me || me.role !== 'GM') return // GM 만 추방 가능
      const target = req.playerId
      if (target === playerId) return // 자기 자신 추방 불가
      const targetP = room.participants.get(target)
      if (!targetP || targetP.role === 'GM') return // 대상 없음 또는 GM(추방 불가)
      // 참가자·캐릭터 제거(GM 잔류로 방은 유지) + 초대 코드 재발급(옛 코드 무효화)
      store.leave(roomId, target)
      // 멤버십도 제거 — 안 지우면 추방당한 계정이 '내 세션 목록'에서 room:enter(members.has 통과)로 재입장 가능(코드 재발급 무력화).
      room.members.delete(target)
      // 휘발 위치·뷰맵에서 추방 대상 제거(room:leave 와 동일 — 죽은 항목 잔류 방지). GM 잔류로 방은 유지.
      roomPositions.get(roomId)?.delete(target)
      roomViews.get(roomId)?.delete(target)
      const newCode = store.reissueCode(roomId)
      // 추방 대상: 통지 후 방 소켓룸에서 제외(이후 공개 메시지 차단)
      io.to('user:' + target).emit('room:closed', '방에서 추방되었습니다.')
      void io.in('user:' + target).socketsLeave(roomId)
      // 추방 대상 소켓의 현재 방 표식도 정리 — 남겨두면 그 소켓이 다음에 다른 방에 들어갈 때
      // 입장 핸들러의 '이전 방 자동 퇴장'이 이 stale 값으로 이 방을 건드린다(재초대된 참가자 오삭제 등).
      for (const s of io.sockets.sockets.values()) {
        if (s.data.playerId === target && s.data.roomId === roomId) s.data.roomId = undefined
      }
      syncPresence(target) // '세션중' 표시 해제(계정 id=playerId 운영 전제 — inSession 이 store 재검증)
      // 갱신은 방 전체, 새 코드는 "남은 참가자 개인 룸"에만(추방 대상은 participants 에서 빠져 새 코드 수신 불가 = 재입장 차단).
      broadcastParticipants(roomId)
      const remaining = store.getRoom(roomId)
      if (newCode && remaining) {
        for (const pid of remaining.participants.keys()) io.to('user:' + pid).emit('room:code', newCode)
      }
    })

    // ===== 외형: 방 GM(소유자)의 테마·다이스 카드 강제 =====
    socket.on('room:appearance', (req) => {
      const roomId = socket.data.roomId
      if (!roomId || !req) return
      const room = store.getRoom(roomId)
      if (!room) return
      const me = room.participants.get(playerId)
      if (!me || me.role !== 'GM') return // 방 GM 만 외형 강제(자기 방에 한함)
      const ap = store.setAppearance(roomId, req)
      if (ap) io.to(roomId).emit('room:appearance', ap) // 방 전체(GM 포함) 동기화
    })

    // ===== 캐릭터 시트 영속 (인증 계정 전용) =====
    // 저장/삭제는 본인 계정에만. 변경 시 그 계정의 모든 소켓(다기기)에 최신 라이브러리 동기화.
    socket.on('char:save', (req) => {
      const acct = socket.data.account
      if (!acct || !req || typeof req.id !== 'string' || !req.id) return
      // 발신 소켓은 제외(socket.to) — 저장한 본인은 이미 로컬에 최신 상태가 있고, 자기 에코로 전체 라이브러리를
      // 되받으면 편집 중 시트를 옛 스냅샷으로 덮을 수 있다. 같은 계정의 '다른 기기'에는 그대로 동기화된다.
      if (characters.save(acct.id, req))
        socket.to('acct:' + acct.id).emit('char:library', characters.list(acct.id))
    })

    socket.on('char:delete', (req) => {
      const acct = socket.data.account
      if (!acct || !req || typeof req.id !== 'string') return
      if (characters.remove(acct.id, req.id))
        socket.to('acct:' + acct.id).emit('char:library', characters.list(acct.id))
    })

    // ===== 방별 시트 멤버십 — 내 라이브러리 시트를 이 방에 추가/제거(서버 영속). =====
    socket.on('room:char:add', (req) => {
      const roomId = socket.data.roomId
      if (!roomId || !req || typeof req.charId !== 'string' || !req.charId) return
      const ids = store.addRoomChar(roomId, playerId, req.charId.slice(0, 200))
      if (ids) io.to('user:' + playerId).emit('room:char:list', { playerId, charIds: ids })
    })
    socket.on('room:char:remove', (req) => {
      const roomId = socket.data.roomId
      if (!roomId || !req || typeof req.charId !== 'string') return
      const ids = store.removeRoomChar(roomId, playerId, req.charId)
      if (ids) io.to('user:' + playerId).emit('room:char:list', { playerId, charIds: ids })
    })

    // ===== GM 시트 지급 — GM 이 만든 시트를 대상 플레이어 계정으로 복사 + 그 방 멤버십에 추가. =====
    socket.on('room:char:grant', (req) => {
      const roomId = socket.data.roomId
      if (
        !roomId ||
        !req ||
        typeof req.targetPlayerId !== 'string' ||
        !req.record ||
        typeof req.record !== 'object'
      )
        return
      const room = store.getRoom(roomId)
      if (!room) return
      const me = room.participants.get(playerId)
      if (!me || me.role !== 'GM') return // GM 만 지급
      const target = req.targetPlayerId
      if (!room.participants.has(target)) return // 같은 방 참가자만
      const newId = randomUUID()
      const record = { ...(req.record as Record<string, unknown>), id: newId } // 새 id 로 소유권 이전 복사
      if (!characters.save(target, record)) return
      store.addRoomChar(roomId, target, newId)
      io.to('acct:' + target).emit('char:library', characters.list(target)) // 대상 라이브러리 갱신
      io.to('user:' + target).emit('room:char:list', {
        playerId: target,
        charIds: store.roomCharsFor(roomId, target)
      })
      // 대상에게만 받음 알림(시스템 메시지 · 히스토리 미저장).
      const sys = {
        id: randomUUID(),
        time: Date.now(),
        channel: 'main' as const,
        kind: 'system' as const,
        text: 'GM이 캐릭터 시트를 지급했습니다.'
      }
      io.to('user:' + target).emit('chat:new', sys)
    })

    // GM 시트 지급 취소·빼앗기 — 대상의 계정·방에서 해당 시트 회수(삭제).
    socket.on('room:char:revoke', (req) => {
      const roomId = socket.data.roomId
      if (
        !roomId ||
        !req ||
        typeof req.targetPlayerId !== 'string' ||
        typeof req.charId !== 'string' ||
        !req.charId
      )
        return
      const room = store.getRoom(roomId)
      if (!room) return
      const me = room.participants.get(playerId)
      if (!me || me.role !== 'GM') return // GM 만 회수
      const target = req.targetPlayerId
      // 같은 방 참가자 또는 세션 멤버 — 부재 멤버 시트도 열람이 열려 있으므로 회수도 같은 경계로(무음 무시 방지).
      if (!room.participants.has(target) && !room.members.has(target)) return
      // 삭제가 아니라 GM 라이브러리로 회수(이전). 대상 레코드를 GM 계정으로 복사 + GM 방 멤버십에 추가.
      const gmAcct = socket.data.account
      if (gmAcct) {
        const record = characters.get(target, req.charId)
        if (record) {
          characters.save(gmAcct.id, record) // 같은 id 유지(소유권을 GM 으로 이전)
          store.addRoomChar(roomId, gmAcct.id, req.charId)
          io.to('acct:' + gmAcct.id).emit('char:library', characters.list(gmAcct.id)) // GM 라이브러리에 추가 반영
          io.to('user:' + gmAcct.id).emit('room:char:list', {
            playerId: gmAcct.id,
            charIds: store.roomCharsFor(roomId, gmAcct.id)
          })
        }
      }
      // 대상 계정/방에서 제거(권한 회수).
      store.removeRoomChar(roomId, target, req.charId)
      characters.remove(target, req.charId)
      io.to('acct:' + target).emit('char:library', characters.list(target)) // 대상 라이브러리 갱신(계정 기준 — 어디 있든 안전)
      // 방 기준 푸시(시트 멤버십·통지)는 이 방에 재실 중일 때만 — 부재 대상이 '다른 방'에 온라인이면
      // 이 방 기준 목록/통지가 그 방 화면을 오염시킨다. 부재자는 다음 입장 스냅샷이 올바른 목록을 준다.
      if (room.participants.has(target)) {
        io.to('user:' + target).emit('room:char:list', {
          playerId: target,
          charIds: store.roomCharsFor(roomId, target)
        })
        // 회수 통지(대상에게).
        const sys = {
          id: randomUUID(),
          time: Date.now(),
          channel: 'main' as const,
          kind: 'system' as const,
          text: 'GM이 캐릭터 시트를 회수했습니다.'
        }
        io.to('user:' + target).emit('chat:new', sys)
      }
      // 요청 GM 의 열람 데이터 갱신(대상 전체 시트).
      socket.emit('sheet:data', { playerId: target, characters: characters.list(target) })
    })

    // ===== GM 전용 시트 열람 =====
    // 같은 방 GM 이 참가자의 전체 캐릭터 시트를 읽기전용으로 요청. 인증 참가자는 playerId === account.id 이므로
    // 그 id 로 캐릭터 라이브러리를 조회해 "요청한 GM 소켓에게만" 전달(상시 전송 아님 · 온디맨드).
    socket.on('sheet:request', (req) => {
      const roomId = socket.data.roomId
      if (!roomId || !req || typeof req.playerId !== 'string') return
      const room = store.getRoom(roomId)
      if (!room) return
      const me = room.participants.get(playerId)
      if (!me || me.role !== 'GM') return // GM 만 열람 가능
      const target = req.playerId
      // 같은 방 참가자 또는 세션 멤버(입장 이력 계정) — 부재 PL 의 시트도 스탠딩 배치용으로 열람 가능.
      if (!room.participants.has(target) && !room.members.has(target)) return
      // GM 은 대상 참가자의 전체 캐릭터 시트를 열람(방 멤버십 필터 없음 — 직접 만들어 방에 안 넣은 시트도 포함).
      socket.emit('sheet:data', { playerId: target, characters: characters.list(target) })
    })

    // ===== 부재 멤버 목록 (GM 전용) =====
    // 이 세션에 입장한 적 있으나 지금은 나가 있는 계정 — 스탠딩 배치 메뉴에서 부재 PL 시트를 고르는 용도.
    socket.on('room:absentMembers', (ack) => {
      const roomId = socket.data.roomId
      const room = roomId ? store.getRoom(roomId) : undefined
      const me = room?.participants.get(playerId)
      if (!room || !me || me.role !== 'GM') {
        ack?.({ ok: false, error: 'GM만 조회할 수 있습니다.' })
        return
      }
      const list = [...room.members]
        .filter((id) => !room.participants.has(id))
        .map((id) => ({ playerId: id, nick: displayNick(id) || '(탈퇴한 계정)' }))
      ack?.({ ok: true, data: list })
    })

    // ===== GM 전용 시트 편집 =====
    // GM 이 같은 방 참가자의 시트를 수정 → 대상 계정에 저장 + 대상 본인에게 sheet:push(로컬 병합) + GM 열람 데이터 갱신.
    socket.on('sheet:edit', (req) => {
      const roomId = socket.data.roomId
      if (!roomId || !req || typeof req.targetPlayerId !== 'string') return
      const char = req.character
      if (!char || typeof char.id !== 'string' || !char.id) return
      const room = store.getRoom(roomId)
      if (!room) return
      const me = room.participants.get(playerId)
      if (!me || me.role !== 'GM') return // GM 만 편집
      const target = req.targetPlayerId
      // 같은 방 참가자 또는 세션 멤버 — 부재 멤버 시트도 열람이 열려 있으므로 편집이 무음 유실되지 않게 같은 경계로.
      if (!room.participants.has(target) && !room.members.has(target)) return
      // 대상 계정에 저장(덮어쓰기) — 오프라인이어도 영속(재접속 시 char:library 로 반영).
      const saved = characters.save(target, char)
      if (!saved) return
      // 대상 본인에게 푸시(자기 로컬 캐릭터 병합) + GM 열람 데이터 갱신(전체 시트).
      io.to('user:' + target).emit('sheet:push', { character: saved })
      socket.emit('sheet:data', { playerId: target, characters: characters.list(target) })
    })

    // ===== 핸드아웃 (GM 전용) =====
    socket.on('handout:upsert', (req) => {
      const roomId = socket.data.roomId
      if (!roomId || !req) return
      const room = store.getRoom(roomId)
      if (!room) return
      const me = room.participants.get(playerId)
      if (!me || me.role !== 'GM') return // 생성/편집은 GM 만
      const res = store.upsertHandout(roomId, req)
      if (!res) return
      const { handout, prev } = res
      const all = [...room.participants.values()]
      const newView = all.filter((p) => canViewHandout(handout, p)).map((p) => p.playerId)
      // 가시성이 좁아졌으면(이전엔 보였으나 지금은 못 봄) 그 대상에서 제거(잔여 사본 정리).
      if (prev) {
        const lost = all
          .filter((p) => canViewHandout(prev, p) && !canViewHandout(handout, p))
          .map((p) => p.playerId)
        emitHandoutRemove(lost, handout.id)
      }
      emitHandoutState(newView, handout)
    })

    socket.on('handout:delete', (req) => {
      const roomId = socket.data.roomId
      if (!roomId || !req || typeof req.id !== 'string') return
      const room = store.getRoom(roomId)
      if (!room) return
      const me = room.participants.get(playerId)
      if (!me || me.role !== 'GM') return
      const prev = store.deleteHandout(roomId, req.id)
      if (!prev) return
      const targets = [...room.participants.values()]
        .filter((p) => canViewHandout(prev, p))
        .map((p) => p.playerId)
      emitHandoutRemove(targets, prev.id)
    })

    socket.on('handout:focus', (req) => {
      const roomId = socket.data.roomId
      if (!roomId || !req || typeof req.id !== 'string') return
      const room = store.getRoom(roomId)
      if (!room) return
      const me = room.participants.get(playerId)
      if (!me || me.role !== 'GM') return
      const h = store.getHandout(roomId, req.id)
      if (!h || h.scope === 'private') return // 비공개엔 강제 포커스 미동작
      // 대상 = 볼 수 있는 사람 중 발신 GM 제외(GM 본인 화면은 강제 오픈 안 함).
      const targets = [...room.participants.values()]
        .filter((p) => p.playerId !== playerId && canViewHandout(h, p))
        .map((p) => p.playerId)
      emitHandoutFocus(targets, h.id)
    })

    // ===== 맵·토큰 (다중 맵) =====
    // GM 검증: 방에 속한 GM 이면 roomId, 아니면 undefined.
    const gmRoomId = (): string | undefined => {
      const roomId = socket.data.roomId
      if (!roomId) return undefined
      const me = store.getRoom(roomId)?.participants.get(playerId)
      return me && me.role === 'GM' ? roomId : undefined
    }

    // 토큰 공개범위(visibility)에 따라 '볼 수 있는 참가자'에게만 방송하기 위한 헬퍼(기존 개인 룸 user:<id> 재사용).
    // 못 보는 참가자에겐 서버가 아예 전송하지 않는다(클라 은닉 신뢰 X).
    /** token:state 방송 — 참가자별로 앞면/뒷면 표현을 보내고, 아무 면도 못 보면 token:remove(가진 경우 드롭). */
    const broadcastTokenState = (room: Room, roomId: string, mapId: string, token: Token): void => {
      // 전체 공개 + 상태 비공개 상태바 없음 → 원본을 방 전체에(그 외엔 참가자별 표현).
      if (tokenVisibility(token) === 'all' && !(token.statsPrivate && token.bars?.length)) {
        io.to(roomId).emit('token:state', { mapId, token })
        return
      }
      for (const p of room.participants.values()) {
        const ur = 'user:' + p.playerId
        const rep = tokenForViewer(token, p) // 앞면 / 뒷면 / null(미표시)
        if (rep) io.to(ur).emit('token:state', { mapId, token: rep })
        else io.to(ur).emit('token:remove', { mapId, id: token.id })
      }
    }
    /**
     * move/rotate/imageindex 등 경량 이벤트 — 해당 면을 보유한 참가자에게만.
     * needFront=true 면 앞면 보유자만(이미지 카드 전환), false 면 앞·뒷면 어느 쪽이든 보유자(위치·각도).
     */
    const emitToTokenViewers = (
      room: Room,
      roomId: string,
      token: Token,
      needFront: boolean,
      send: (target: string | string[]) => void
    ): void => {
      if (tokenVisibility(token) === 'all') {
        send(roomId)
        return
      }
      const rooms = [...room.participants.values()]
        .filter((p) => (needFront ? canSeeToken(token, p) : tokenForViewer(token, p) !== null))
        .map((p) => 'user:' + p.playerId)
      if (rooms.length) send(rooms)
    }
    /** map:added 방송 — 제한/양면 토큰이 있으면 참가자별로 앞면/뒷면 표현만 담아 개별 전송. */
    const broadcastMapAdded = (room: Room, roomId: string, map: GameMap): void => {
      if (map.tokens.every((t) => tokenVisibility(t) === 'all' && !(t.statsPrivate && t.bars?.length))) {
        io.to(roomId).emit('map:added', map)
        return
      }
      for (const p of room.participants.values())
        io.to('user:' + p.playerId).emit('map:added', {
          ...map,
          tokens: map.tokens.map((t) => tokenForViewer(t, p)).filter((t): t is Token => t !== null)
        })
    }

    // ===== BGM (다중 동시재생, GM 전용·전원 동기화) =====
    // set=트랙 추가/로드(소스 포함 broadcast 전체 목록), control=경량 트랙 토글(재생/반복/볼륨), clear=한 트랙 또는 전체 정지.
    socket.on('bgm:set', (req) => {
      const roomId = gmRoomId()
      if (!roomId || !req) return
      // 음원은 /asset 업로드 후 'asset:' 참조로 와야 한다. 거대 인라인 data URL(클라 업로드 실패 폴백)이
      // 방 상태에 박히면 bgm:state 로 전원에게 통째 재전송되므로, 저장 전에 떨군다(+진단 로그).
      if (isOversizedInline(req.src)) {
        log('drop', 'bgm:set oversized inline', playerId.slice(0, 8), 'chars', String(req.src).length)
        return
      }
      const tracks = store.setBgm(roomId, req)
      if (tracks) io.to(roomId).emit('bgm:state', tracks, roomId) // roomId=수신 클라의 자기 방 검증용
    })

    socket.on('bgm:control', (req) => {
      const roomId = gmRoomId()
      if (!roomId || !req) return
      const ctl = store.controlBgm(roomId, req)
      if (ctl) io.to(roomId).emit('bgm:control', ctl, roomId)
    })

    socket.on('bgm:clear', (req) => {
      const roomId = gmRoomId()
      if (!roomId) return
      const tracks = store.clearBgm(roomId, typeof req?.trackId === 'string' ? req.trackId : undefined)
      if (tracks) io.to(roomId).emit('bgm:state', tracks, roomId)
    })

    // 전체 트랙 권위적 교체 — '나만 듣기'→'전체 동기화' 재조정 시 GM 로컬과 방을 정확히 일치시켜 PL 혼선 제거.
    socket.on('bgm:replace', (req) => {
      const roomId = gmRoomId()
      if (!roomId) return
      // bgm:set 과 동일 — 거대 인라인 음원 트랙은 제외하고 교체(참조·유튜브·작은 인라인만 통과).
      const incoming = Array.isArray(req?.tracks) ? req.tracks : []
      const safe = incoming.filter((t) => !isOversizedInline((t as { src?: unknown })?.src))
      if (safe.length !== incoming.length) {
        log(
          'drop',
          'bgm:replace oversized inline',
          playerId.slice(0, 8),
          'removed',
          incoming.length - safe.length
        )
      }
      const tracks = store.replaceBgm(roomId, safe)
      if (tracks) io.to(roomId).emit('bgm:state', tracks, roomId)
    })

    // BGM 시크 — GM 이 재생 위치(초)를 전원에게 점프 명령. 위치는 항상 변하므로 저장 안 함(transient broadcast, 핑처럼).
    // 존재하는 트랙에만, 위치는 유한·음수 차단. 전원(GM 에코 포함)이 받아 각자 오디오를 그 지점으로 이동.
    socket.on('bgm:seek', (req) => {
      const roomId = gmRoomId()
      if (!roomId || typeof req?.trackId !== 'string') return
      const position =
        typeof req.position === 'number' && Number.isFinite(req.position) ? Math.max(0, req.position) : 0
      if (!store.getRoom(roomId)?.bgm.some((t) => t.trackId === req.trackId)) return // 없는 트랙 무시
      io.to(roomId).emit('bgm:seek', { trackId: req.trackId, position }, roomId)
    })

    // 방 주사위 연출 카드(GM 전용). image 없으면 해제. level=성공 단계별, 없으면 공통 → 전원 동기화.
    socket.on('room:cutin', (req) => {
      const roomId = gmRoomId()
      if (!roomId || !req) return
      const res = store.setCutIn(roomId, typeof req.image === 'string' ? req.image : undefined, req.level)
      if (res.ok) io.to(roomId).emit('room:cutin', { image: res.image, level: res.level })
    })

    // 화면 강제 이동(GM 전용) — 맵/비주얼노벨 탭 + (있으면)지정 맵으로 전환(휘발 액션, 방 상태 비저장).
    // targets 지정 시 그 플레이어들만(개인 룸), 없으면 방 전원(특정 인원 이동).
    socket.on('room:view', (req) => {
      const roomId = gmRoomId()
      if (!roomId || !req) return
      const view = req.view === 'vn' ? 'vn' : 'map'
      const mapId = typeof req.mapId === 'string' ? req.mapId : undefined // 클라가 존재 여부 가드(setActiveLocal)
      const targets = Array.isArray(req.targets)
        ? req.targets.filter((t): t is string => typeof t === 'string' && !!t)
        : undefined
      if (targets && targets.length) io.to(targets.map((t) => 'user:' + t)).emit('room:view', { view, mapId })
      else io.to(roomId).emit('room:view', { view, mapId })
      // 전원 이동은 방의 활성 맵으로 기록 — 재입장자가 '마지막으로 있던 맵'에 착지하는 폴백 기준.
      // 비주얼 노벨로 보낼 때도 장면(맵)은 같이 바뀌므로 함께 기록한다(안 하면 재입장자만 옛 장면에 착지).
      if (mapId && !(targets && targets.length)) store.setActiveMap(roomId, mapId)
    })

    // 각 클라가 현재 보는 맵/뷰를 보고 — 서버는 위치를 저장하고 GM 들에게 집계(room:positions) 전달.
    socket.on('room:where', (req) => {
      const roomId = socket.data.roomId
      if (!roomId || !req || typeof req.mapId !== 'string' || !req.mapId) return
      if (!store.getRoom(roomId)?.participants.has(playerId)) return
      let pos = roomPositions.get(roomId)
      if (!pos) {
        pos = new Map()
        roomPositions.set(roomId, pos)
      }
      pos.set(playerId, req.mapId)
      let vws = roomViews.get(roomId)
      if (!vws) {
        vws = new Map()
        roomViews.set(roomId, vws)
      }
      vws.set(playerId, req.view === 'vn' ? 'vn' : 'map')
      emitPositions(roomId)
    })

    // ~문장~ 행동지문 색(GM 전용) — 빈/무효값이면 해제. 방 단위 저장 + 전원 동기화.
    socket.on('room:dim', (req) => {
      const roomId = gmRoomId()
      if (!roomId || !req) return
      const res = store.setDimColor(roomId, typeof req.color === 'string' ? req.color : undefined)
      if (res.ok) io.to(roomId).emit('room:dim', { color: res.color })
    })

    // 행운 깎기(CoC7 하우스룰) 사용 여부(GM 전용) — 전원 동기화.
    socket.on('room:luck', (req) => {
      const roomId = gmRoomId()
      if (!roomId || !req) return
      const res = store.setLuckEnabled(roomId, req.enabled === true)
      if (res.ok) io.to(roomId).emit('room:luck', { enabled: res.enabled })
    })

    // 일반 맵 VN 오버레이 표시(GM 전용) — 전원 동기화.
    socket.on('room:vnoverlay', (req) => {
      const roomId = gmRoomId()
      if (!roomId || !req) return
      const res = store.setVnOverlay(roomId, req.enabled === true)
      if (res.ok) io.to(roomId).emit('room:vnoverlay', { enabled: res.enabled })
    })

    // GM 커스텀 광기표(GM 전용) — 서버 정규화 후 전원 동기화. 빈/무효면 기본표로 복귀.
    socket.on('room:madness', (req) => {
      const roomId = gmRoomId()
      if (!roomId || !req) return
      const res = store.setMadnessTables(roomId, req)
      if (res.ok)
        io.to(roomId).emit('room:madness', {
          realtimeTemp: res.tables?.realtimeTemp ?? [],
          realtimeIndef: res.tables?.realtimeIndef ?? [],
          summary: res.tables?.summary ?? []
        })
    })

    // ===== 전투 (GM 전용·전원 동기화) =====
    // 전체 상태 교체(시작·이니셔티브·턴진행·HP·종료=null). 서버가 GM 검증·정규화 후 전원에 combat:state.
    socket.on('combat:set', (state) => {
      const roomId = gmRoomId()
      if (!roomId) return
      const next = store.setCombat(roomId, state)
      if (next !== undefined) io.to(roomId).emit('combat:state', next)
    })

    // ===== 그룹 채널 (GM 전용) =====
    // 개설/삭제 후 각 참가자에게 본인이 볼 수 있는 채널 목록만 동기화(멤버 필터).
    const syncChannels = (roomId: string): void => {
      const room = store.getRoom(roomId)
      if (!room) return
      for (const p of room.participants.values()) {
        io.to('user:' + p.playerId).emit('channel:list', store.channelsFor(room, p))
      }
    }
    socket.on('channel:create', (req) => {
      const roomId = gmRoomId()
      if (!roomId || !req) return
      if (store.createChannel(roomId, req)) syncChannels(roomId)
    })
    socket.on('channel:remove', (req) => {
      const roomId = gmRoomId()
      if (!roomId || !req?.id) return
      if (store.removeChannel(roomId, req.id)) syncChannels(roomId)
    })

    // ===== 방 불러오기 (GM 전용) =====
    // 스냅샷 장면 적용 후, 참가자별 필터 스냅샷으로 전원 풀 재싱크(핸드아웃 가시성 보존).
    socket.on('room:load', async (req) => {
      const roomId = gmRoomId()
      if (!roomId || !req) return
      const room = store.getRoom(roomId)
      if (!room || !store.loadSnapshot(roomId, req)) return
      for (const p of room.participants.values()) {
        io.to('user:' + p.playerId).emit('room:sync', await lightenAvatarPool(store.snapshot(room, p)))
      }
    })

    socket.on('map:create', (req) => {
      const roomId = gmRoomId()
      if (!roomId) return
      const map = store.createMap(roomId, typeof req?.name === 'string' ? req.name : undefined)
      if (map) io.to(roomId).emit('map:added', map)
    })

    // 맵세트 복제(GM 전용) — 서버가 새 맵을 만들어 전원에 map:added.
    socket.on('map:duplicate', (req) => {
      const roomId = gmRoomId()
      if (!roomId || !req || typeof req.mapId !== 'string') return
      const map = store.duplicateMap(roomId, req.mapId)
      const room = store.getRoom(roomId)
      if (map && room) broadcastMapAdded(room, roomId, map)
    })

    // 맵세트 일괄 가져오기(GM 전용) — 외부 파일 변환 맵들을 정규화·생성해 각각 map:added.
    socket.on('map:import', (req) => {
      const roomId = gmRoomId()
      if (!roomId || !req) return
      // 배경/바탕/VN 배경은 'asset:' 참조여야 함 — 형제 map:background·map:vnbg 와 동일하게
      // 거대 인라인(자산 업로드 실패 폴백)을 떨궈 스냅샷·방송 부풀림을 막는다.
      const maps = Array.isArray(req.maps)
        ? req.maps.map((m) => {
            if (!m || typeof m !== 'object') return m
            const o = m as unknown as Record<string, unknown>
            const bg = o.background as { image?: unknown } | null | undefined
            if (bg && isOversizedInline(bg.image)) o.background = null
            const bd = o.backdrop as { image?: unknown } | null | undefined
            if (bd && isOversizedInline(bd.image)) o.backdrop = undefined
            if (isOversizedInline(o.vnBackground)) o.vnBackground = undefined
            return o
          })
        : req.maps
      const created = store.importMaps(roomId, maps)
      const room = store.getRoom(roomId)
      if (room) for (const map of created) broadcastMapAdded(room, roomId, map)
      // 동반된 통합 레이어(방 상주 패널) — 토큰 인라인 이미지도 배경과 같은 기준으로 방어(업로드 실패
      // 폴백의 거대 data URL 이 방 상주 상태·스냅샷에 박히지 않게 이미지 필드만 떨군다).
      const globalsRaw = Array.isArray(req.globalTokens)
        ? req.globalTokens.map((t) => {
            if (!t || typeof t !== 'object') return t
            const o = t as unknown as Record<string, unknown>
            if (isOversizedInline(o.image)) o.image = undefined
            if (isOversizedInline(o.backImage)) o.backImage = undefined
            return t
          })
        : req.globalTokens
      // z 보존을 위해 일괄 저장. 신규 토큰이라 아무도 가진 적이 없으므로 못 보는 참가자에게는 아무것도
      // 보내지 않는다(broadcastTokenState 의 token:remove 레그는 갱신용 — 여기서는 무의미한 no-op).
      // 표시 맵 제한은 재발급된 실제 맵 id 로 서버가 다시 묶는다(importGlobalTokens 가 항상 재부여 —
      // 맵이 하나도 안 들어왔으면 전체 표시로 해제).
      const globals = store.importGlobalTokens(
        roomId,
        globalsRaw,
        created.length ? created.map((m) => m.id) : undefined
      )
      if (room)
        for (const t of globals) {
          if (tokenVisibility(t) === 'all' && !(t.statsPrivate && t.bars?.length)) {
            io.to(roomId).emit('token:state', { mapId: GLOBAL_MAP_ID, token: t })
          } else {
            for (const p of room.participants.values()) {
              const rep = tokenForViewer(t, p)
              if (rep) io.to('user:' + p.playerId).emit('token:state', { mapId: GLOBAL_MAP_ID, token: rep })
            }
          }
        }
    })

    // ===== 저장 슬롯 (GM 전용) — 현재 반면을 이름 붙여 저장 / 로드(전원 재싱크) / 삭제 =====
    socket.on('map:save', (req) => {
      const roomId = gmRoomId()
      if (!roomId) return
      const slots = store.saveSlot(roomId, req?.name)
      if (slots) io.to(roomId).emit('map:slots', { slots }) // 성공 시 목록 갱신(꽉 차면 undefined → 무동작)
    })
    socket.on('map:load', async (req) => {
      const roomId = gmRoomId()
      if (!roomId || !req || typeof req.slotId !== 'string') return
      if (!store.loadSlot(roomId, req.slotId)) return
      const room = store.getRoom(roomId)
      if (!room) return
      // 슬롯 로드는 반면을 통째 교체 — 참가자별 필터 스냅샷으로 전원 풀 재싱크(공개범위·가시성 보존).
      for (const p of room.participants.values())
        io.to('user:' + p.playerId).emit('room:sync', await lightenAvatarPool(store.snapshot(room, p)))
      io.to(roomId).emit('map:slots', { slots: store.saveSlotsMeta(roomId) })
    })
    socket.on('map:slotdelete', (req) => {
      const roomId = gmRoomId()
      if (!roomId || !req || typeof req.slotId !== 'string') return
      const slots = store.deleteSlot(roomId, req.slotId)
      if (slots) io.to(roomId).emit('map:slots', { slots })
    })

    // ===== 비주얼 카드 — GM 등록·삭제·수동 재생 =====
    socket.on('card:set', (req) => {
      const roomId = gmRoomId()
      if (!roomId) return
      const cards = store.setVisualCard(roomId, req)
      if (cards) io.to(roomId).emit('room:cards', { cards })
    })
    socket.on('card:delete', (req) => {
      const roomId = gmRoomId()
      if (!roomId || !req || typeof req.id !== 'string') return
      const cards = store.deleteVisualCard(roomId, req.id)
      if (cards) io.to(roomId).emit('room:cards', { cards })
    })
    socket.on('card:play', (req) => {
      const roomId = gmRoomId()
      if (!roomId || !req || typeof req.id !== 'string') return
      const card = store.getVisualCard(roomId, req.id)
      if (card) io.to(roomId).emit('room:cardplay', { card }) // 전원 화면에 오버레이 재생
    })

    socket.on('map:delete', (req) => {
      const roomId = gmRoomId()
      if (!roomId || !req || typeof req.mapId !== 'string') return
      const res = store.deleteMap(roomId, req.mapId)
      if (res) {
        io.to(roomId).emit('map:removed', { mapId: res.removed })
        io.to(roomId).emit('map:active', { mapId: res.activeMapId })
      }
    })

    socket.on('map:rename', (req) => {
      const roomId = gmRoomId()
      if (!roomId || !req || typeof req.mapId !== 'string') return
      const res = store.renameMap(roomId, req.mapId, typeof req.name === 'string' ? req.name : '')
      if (res) io.to(roomId).emit('map:renamed', res)
    })

    socket.on('map:activate', (req) => {
      const roomId = gmRoomId()
      if (!roomId || !req || typeof req.mapId !== 'string') return
      const active = store.setActiveMap(roomId, req.mapId)
      if (active) io.to(roomId).emit('map:active', { mapId: active })
    })

    socket.on('map:background', (req) => {
      const roomId = gmRoomId()
      if (!roomId || !req || typeof req.mapId !== 'string') return
      // 배경 이미지는 'asset:' 참조여야 함 — 거대 인라인(업로드 실패 폴백)은 스냅샷·방송을 부풀려 떨군다(+로그).
      if (req.bg && isOversizedInline((req.bg as { image?: unknown }).image)) {
        log('drop', 'map:background oversized inline', playerId.slice(0, 8))
        return
      }
      const stored = store.setBackground(roomId, req.mapId, req.bg ?? null)
      if (stored !== undefined) io.to(roomId).emit('map:background', { mapId: req.mapId, bg: stored })
    })

    // 비주얼 노벨 무대 배경(맵별, GM 전용). image 없으면 해제. 전원 동기화.
    socket.on('map:vnbg', (req) => {
      const roomId = gmRoomId()
      if (!roomId || !req || typeof req.mapId !== 'string') return
      if (isOversizedInline(req.image)) {
        log('drop', 'map:vnbg oversized inline', playerId.slice(0, 8))
        return
      }
      const res = store.setVnBackground(
        roomId,
        req.mapId,
        typeof req.image === 'string' ? req.image : undefined
      )
      if (res.ok) io.to(roomId).emit('map:vnbg', { mapId: req.mapId, image: res.image })
    })

    // 비주얼 노벨 배경 흐림 강도(맵별, GM 전용 · 0=없음). 배경 이미지는 건드리지 않고
    // 흐림 숫자만 전용 이벤트로 동기화 — 이미지 재전송/재하이드레이션 낭비 없음.
    socket.on('map:vnbgblur', (req) => {
      const roomId = gmRoomId()
      if (!roomId || !req || typeof req.mapId !== 'string' || typeof req.blur !== 'number') return
      const res = store.setVnBgBlur(roomId, req.mapId, req.blur)
      if (res.ok) io.to(roomId).emit('map:vnbgblur', { mapId: req.mapId, blur: res.blur ?? 0 })
    })

    // 맵 배경 단색(맵별, GM 전용 · 여백 전체). color 없으면 해제(투명). 전원 동기화.
    socket.on('map:bgcolor', (req) => {
      const roomId = gmRoomId()
      if (!roomId || !req || typeof req.mapId !== 'string') return
      const res = store.setMapBgColor(
        roomId,
        req.mapId,
        typeof req.color === 'string' ? req.color : undefined
      )
      if (res.ok) io.to(roomId).emit('map:bgcolor', { mapId: req.mapId, color: res.color })
    })

    // 맵 바탕(최후면 이미지+블러 · 맵별, GM 전용 · 화면 전체). backdrop null 이면 해제. 전원 동기화.
    socket.on('map:backdrop', (req) => {
      const roomId = gmRoomId()
      if (!roomId || !req || typeof req.mapId !== 'string') return
      const res = store.setMapBackdrop(roomId, req.mapId, req.backdrop ?? null)
      if (res.ok) io.to(roomId).emit('map:backdrop', { mapId: req.mapId, backdrop: res.backdrop ?? null })
    })

    // 맵세트 메타(전환 문구·크로스페이드) 전체 교체(GM 전용). 전원 동기화.
    socket.on('map:meta', (req) => {
      const roomId = gmRoomId()
      if (!roomId || !req || typeof req.mapId !== 'string') return
      const res = store.setMapMeta(roomId, req.mapId, { crossfade: req.crossfade === true })
      if (res.ok) io.to(roomId).emit('map:meta', { mapId: req.mapId, crossfade: res.crossfade })
    })

    // 맵 레이어 표시/숨김(GM 전용) — 무대 앞 밴드·무대 뒤를 맵 단위로 전원 동기화.
    socket.on('map:layervis', (req) => {
      const roomId = gmRoomId()
      if (!roomId || !req || typeof req.mapId !== 'string') return
      const res = store.setMapLayerVis(roomId, req.mapId, req.hidden)
      if (res.ok) io.to(roomId).emit('map:layervis', { mapId: req.mapId, hidden: res.hidden ?? [] })
    })

    // 맵세트 번들 BGM 저장/해제(GM 전용). save=현재 방 BGM 을 이 맵에 스냅샷, clear=해제. 전원 동기화.
    socket.on('map:bgm', (req) => {
      const roomId = gmRoomId()
      if (!roomId || !req || typeof req.mapId !== 'string') return
      const op = req.op === 'clear' ? 'clear' : 'save'
      const res = store.setMapBgm(roomId, req.mapId, op)
      if (res.ok) io.to(roomId).emit('map:bgm', { mapId: req.mapId, bgm: res.bgm ?? null })
    })

    // VN 무대 레이어 스택 전체 교체(GM 전용). 서버가 정규화 후 전원 동기화.
    socket.on('map:vnlayers', (req) => {
      const roomId = gmRoomId()
      if (!roomId || !req || typeof req.mapId !== 'string') return
      const res = store.setVnLayers(roomId, req.mapId, req.layers)
      if (res.ok) io.to(roomId).emit('map:vnlayers', { mapId: req.mapId, layers: res.layers ?? [] })
    })

    socket.on('map:grid', (req) => {
      const roomId = gmRoomId()
      if (!roomId || !req || typeof req.mapId !== 'string' || !req.grid) return
      const stored = store.setGrid(roomId, req.mapId, req.grid)
      if (stored) io.to(roomId).emit('map:grid', { mapId: req.mapId, grid: stored })
    })

    socket.on('token:upsert', (req) => {
      const roomId = gmRoomId()
      if (!roomId || !req || typeof req.mapId !== 'string') return
      const token = store.upsertToken(roomId, req.mapId, req)
      const room = store.getRoom(roomId)
      if (token && room) broadcastTokenState(room, roomId, req.mapId, token)
    })

    socket.on('token:move', (req) => {
      const roomId = socket.data.roomId
      if (!roomId || !req || typeof req.mapId !== 'string' || typeof req.id !== 'string') return
      if (!isFiniteCoord(req.x) || !isFiniteCoord(req.y)) return // NaN/Infinity 거부(저장은 moveToken 이 클램프)
      const room = store.getRoom(roomId)
      if (!room) return
      const me = room.participants.get(playerId)
      if (!me) return
      const token = store.getToken(roomId, req.mapId, req.id)
      if (!token) return
      // 이동 권한: GM 은 모든 토큰, PL 은 자기 캐릭터 토큰 또는 권한을 부여받은 토큰(allowedPlayers).
      if (me.role !== 'GM' && token.charPlayerId !== playerId && !token.allowedPlayers?.includes(playerId))
        return
      const moved = store.moveToken(roomId, req.mapId, req.id, req.x, req.y)
      if (moved) {
        const payload = { mapId: req.mapId, id: moved.id, x: moved.x, y: moved.y }
        // 위치는 앞·뒷면 어느 쪽이든 보유자에게(needFront=false).
        emitToTokenViewers(room, roomId, moved, false, (target) => io.to(target).emit('token:move', payload))
      }
    })

    // 토큰 회전(GM 또는 토큰 소유 PL — 이동과 동일 권한). 각도만 전송·브로드캐스트.
    socket.on('token:rotate', (req) => {
      const roomId = socket.data.roomId
      if (!roomId || !req || typeof req.mapId !== 'string' || typeof req.id !== 'string') return
      if (!isFiniteCoord(req.rotation)) return // NaN/Infinity 거부
      const room = store.getRoom(roomId)
      if (!room) return
      const me = room.participants.get(playerId)
      if (!me) return
      const token = store.getToken(roomId, req.mapId, req.id)
      if (!token) return
      // 회전 권한: GM 은 모든 토큰, PL 은 자기 캐릭터 토큰 또는 권한을 부여받은 토큰(allowedPlayers).
      if (me.role !== 'GM' && token.charPlayerId !== playerId && !token.allowedPlayers?.includes(playerId))
        return
      const rotated = store.rotateToken(roomId, req.mapId, req.id, req.rotation)
      if (rotated) {
        const payload = { mapId: req.mapId, id: rotated.id, rotation: rotated.rotation ?? 0 }
        // 각도는 앞·뒷면 어느 쪽이든 보유자에게(needFront=false).
        emitToTokenViewers(room, roomId, rotated, false, (target) =>
          io.to(target).emit('token:rotate', payload)
        )
      }
    })

    // 토큰 크기조정(GM 또는 토큰 소유 PL — 이동과 동일 권한). 크기(칸)만 전송·브로드캐스트(크기조정 드래그 라이브).
    socket.on('token:resize', (req) => {
      const roomId = socket.data.roomId
      if (!roomId || !req || typeof req.mapId !== 'string' || typeof req.id !== 'string') return
      if (!isFiniteCoord(req.size)) return // NaN/Infinity 거부(저장은 resizeToken 이 클램프)
      const room = store.getRoom(roomId)
      if (!room) return
      const me = room.participants.get(playerId)
      if (!me) return
      const token = store.getToken(roomId, req.mapId, req.id)
      if (!token) return
      // 크기조정 권한: GM 은 모든 토큰, PL 은 자기 캐릭터 토큰 또는 권한을 부여받은 토큰(allowedPlayers).
      if (me.role !== 'GM' && token.charPlayerId !== playerId && !token.allowedPlayers?.includes(playerId))
        return
      const resized = store.resizeToken(roomId, req.mapId, req.id, req.size)
      if (resized) {
        const payload = { mapId: req.mapId, id: resized.id, size: resized.size ?? 1 }
        // 크기는 앞·뒷면 어느 쪽이든 보유자에게(needFront=false).
        emitToTokenViewers(room, roomId, resized, false, (target) =>
          io.to(target).emit('token:resize', payload)
        )
      }
    })

    // 이미지 카드 표시 이미지 전환(GM 또는 토큰 소유 PL — 이동과 동일 권한). index 만 전송·브로드캐스트.
    socket.on('token:imageindex', (req) => {
      const roomId = socket.data.roomId
      if (!roomId || !req || typeof req.mapId !== 'string' || typeof req.id !== 'string') return
      if (!Number.isInteger(req.index) || req.index < 0) return
      const room = store.getRoom(roomId)
      if (!room) return
      const me = room.participants.get(playerId)
      if (!me) return
      const token = store.getToken(roomId, req.mapId, req.id)
      if (!token) return
      // 전환 권한: GM 은 모든 토큰, PL 은 자기 캐릭터 토큰 또는 권한을 부여받은 토큰(allowedPlayers).
      if (me.role !== 'GM' && token.charPlayerId !== playerId && !token.allowedPlayers?.includes(playerId))
        return
      const t = store.setTokenImageIndex(roomId, req.mapId, req.id, req.index)
      if (t) {
        const payload = { mapId: req.mapId, id: t.id, index: t.currentIndex ?? 0 }
        // 이미지 카드 전환은 앞면 보유자에게만(뒷면 뷰어는 무관·needFront=true).
        emitToTokenViewers(room, roomId, t, true, (target) => io.to(target).emit('token:imageindex', payload))
      }
    })

    socket.on('token:remove', (req) => {
      const roomId = gmRoomId()
      if (!roomId || !req || typeof req.mapId !== 'string' || typeof req.id !== 'string') return
      const prev = store.removeToken(roomId, req.mapId, req.id)
      if (prev) io.to(roomId).emit('token:remove', { mapId: req.mapId, id: prev.id })
    })

    // 토큰 z순서·레이어 변경(GM 전용). 변경된 토큰(교환 시 2개)을 각각 token:state 로 전원 동기화.
    socket.on('token:reorder', (req) => {
      const roomId = gmRoomId()
      if (!roomId || !req || typeof req.mapId !== 'string' || typeof req.id !== 'string') return
      const changed = store.reorderToken(roomId, req.mapId, req.id, { op: req.op, layer: req.layer })
      const room = store.getRoom(roomId)
      if (room) for (const token of changed) broadcastTokenState(room, roomId, req.mapId, token)
    })

    // ===== 자유 드로잉·핑 =====
    // 그리기=전원(방 참가자), 색·playerId 는 서버가 참가자 정보로 스탬프(위조 방지).
    socket.on('map:draw', (req) => {
      const roomId = socket.data.roomId
      if (!roomId || !req || typeof req.mapId !== 'string') return
      const room = store.getRoom(roomId)
      const me = room?.participants.get(playerId)
      if (!room || !me) return
      // 그리기 색은 작성자가 고른 색을 우선 사용(휘발성 드로잉 — 길이만 캡). 없으면 참가자색.
      const color = typeof req.color === 'string' && req.color ? req.color.slice(0, 32) : me.color
      const stroke = store.addStroke(roomId, req.mapId, req, { playerId, color })
      if (stroke) io.to(roomId).emit('map:draw', { mapId: req.mapId, stroke })
    })

    // 지우개=작성자 또는 GM(서버 검증).
    socket.on('map:draw:erase', (req) => {
      const roomId = socket.data.roomId
      if (!roomId || !req || typeof req.mapId !== 'string' || typeof req.strokeId !== 'string') return
      const room = store.getRoom(roomId)
      const me = room?.participants.get(playerId)
      if (!room || !me) return
      const stroke = store.getStroke(roomId, req.mapId, req.strokeId)
      if (!stroke) return
      if (me.role !== 'GM' && stroke.playerId !== playerId) return // PL 은 자기 획만
      const removed = store.eraseStroke(roomId, req.mapId, req.strokeId)
      if (removed) io.to(roomId).emit('map:draw:erase', { mapId: req.mapId, strokeId: removed.id })
    })

    // 전체 지우기=GM 전용.
    socket.on('map:draw:clear', (req) => {
      const roomId = gmRoomId()
      if (!roomId || !req || typeof req.mapId !== 'string') return
      if (store.clearDrawings(roomId, req.mapId)) io.to(roomId).emit('map:draw:clear', { mapId: req.mapId })
    })

    // ===== 맵 텍스트 라벨 =====
    // 생성=전원(작성자=서버 스탬프), 편집=작성자 또는 GM(서버 검증).
    socket.on('map:text', (req) => {
      const roomId = socket.data.roomId
      if (!roomId || !req || typeof req.mapId !== 'string') return
      const room = store.getRoom(roomId)
      const me = room?.participants.get(playerId)
      if (!room || !me) return
      // 편집(id 있음)이면 작성자/GM 만. 신규(id 없음)는 전원 허용.
      if (typeof req.id === 'string' && req.id) {
        const existing = store.getText(roomId, req.mapId, req.id)
        if (existing && me.role !== 'GM' && existing.playerId !== playerId) return
      }
      const text = store.upsertText(roomId, req.mapId, req, { playerId })
      if (text) io.to(roomId).emit('map:text:state', { mapId: req.mapId, text })
    })

    // 이동=작성자 또는 GM.
    socket.on('map:text:move', (req) => {
      const roomId = socket.data.roomId
      if (!roomId || !req || typeof req.mapId !== 'string' || typeof req.id !== 'string') return
      if (!isFiniteCoord(req.x) || !isFiniteCoord(req.y)) return
      const room = store.getRoom(roomId)
      const me = room?.participants.get(playerId)
      if (!room || !me) return
      const t = store.getText(roomId, req.mapId, req.id)
      if (!t) return
      if (me.role !== 'GM' && t.playerId !== playerId) return // PL 은 자기 텍스트만
      const moved = store.moveText(roomId, req.mapId, req.id, req.x, req.y)
      if (moved)
        io.to(roomId).emit('map:text:move', { mapId: req.mapId, id: moved.id, x: moved.x, y: moved.y })
    })

    // 삭제=작성자 또는 GM.
    socket.on('map:text:remove', (req) => {
      const roomId = socket.data.roomId
      if (!roomId || !req || typeof req.mapId !== 'string' || typeof req.id !== 'string') return
      const room = store.getRoom(roomId)
      const me = room?.participants.get(playerId)
      if (!room || !me) return
      const t = store.getText(roomId, req.mapId, req.id)
      if (!t) return
      if (me.role !== 'GM' && t.playerId !== playerId) return // PL 은 자기 텍스트만
      const removed = store.removeText(roomId, req.mapId, req.id)
      if (removed) io.to(roomId).emit('map:text:remove', { mapId: req.mapId, id: removed.id })
    })

    // 텍스트 전체 지우기=GM 전용.
    socket.on('map:text:clear', (req) => {
      const roomId = gmRoomId()
      if (!roomId || !req || typeof req.mapId !== 'string') return
      if (store.clearTexts(roomId, req.mapId)) io.to(roomId).emit('map:text:clear', { mapId: req.mapId })
    })

    // 핑=전원(휘발 — 저장하지 않고 방 전체에 브로드캐스트만). 색·playerId 는 서버 스탬프.
    socket.on('map:ping', (req) => {
      const roomId = socket.data.roomId
      if (!roomId || !req || typeof req.mapId !== 'string') return
      if (!isFiniteCoord(req.x) || !isFiniteCoord(req.y)) return // NaN/Infinity 거부
      const room = store.getRoom(roomId)
      const me = room?.participants.get(playerId)
      if (!room || !me) return
      io.to(roomId).emit('map:ping', {
        mapId: req.mapId,
        x: clampCoord(req.x),
        y: clampCoord(req.y),
        playerId,
        // 본인 지정 이름색을 핑색으로. 없으면 참가자 기본색. 휘발 이벤트라 클라색 신뢰(길이만 캡).
        color: typeof req.color === 'string' && req.color ? req.color.slice(0, 32) : me.color
      })
    })

    socket.on('room:leave', () => {
      if (!socket.data.roomId) return
      leaveCurrentRoom() // 소켓룸·참가자·위치/뷰맵 공통 정리(방 입장 핸들러의 자동 퇴장과 동일 경로)
      if (account) syncPresence(account.id) // '세션중' 자동 해제
    })

    // ===== 수동 프레즌스 상태 — 온라인/자리비움/세션중/오프라인 표시(계정 영속). =====
    socket.on('presence:set', (req, ack) => {
      const acct = socket.data.account
      const status = req?.status
      if (!acct || typeof status !== 'string' || !['online', 'away', 'session', 'invisible'].includes(status)) {
        ack?.({ ok: false, error: '상태를 변경할 수 없습니다.' })
        return
      }
      // 레이트리밋 — 상태 토글 폭주가 accounts.json 동기쓰기·전역 브로드캐스트를 반복시키지 않게(계정당 10초 20건).
      const t = Date.now()
      const rl = presenceRate.get(acct.id)
      if (!rl || t > rl.resetAt) {
        presenceRate.set(acct.id, { count: 1, resetAt: t + 10_000 })
      } else if (rl.count >= 20) {
        ack?.({ ok: false, error: '너무 자주 변경했어요. 잠시 후 다시 시도하세요.' })
        return
      } else {
        rl.count++
      }
      auth.setStatus(acct.id, status as PresenceStatus)
      syncPresence(acct.id) // 표시 상태 전이 브로드캐스트(invisible→오프라인 위장 포함)
      ack?.({ ok: true, data: { status: status as PresenceStatus } })
    })

    // ===== 도트타운 광장(Plaza) — 휘발 멀티플레이 =====
    // 입장: 손님 포함 누구나 걸을 수 있다(구매/판매만 member↑). 외형은 서버 보관 CharSave 를 동봉(클라 주입 안 함).
    socket.on('plaza:enter', (req, ack) => {
      const nick = (account && displayNick(account.id)) || '손님'
      const look = account ? dottown.getChar(account.id) : null
      // 스폰 위치 — spawnAtOwnerId 의 집 현관 앞(내 집=내 id, 방문 복귀=방문한 집 주인 id). 그 집이 없으면 중앙.
      const spawnOwner = typeof req?.spawnAtOwnerId === 'string' ? req.spawnAtOwnerId : null
      const spawnLot = spawnOwner ? estate.myLot(spawnOwner) : null
      const spawnCell = spawnLot ? { cx: spawnLot.cx, cy: spawnLot.cy } : undefined
      const r = plaza.enter(playerId, nick, look, socket.id, spawnCell)
      if (!r.ok) {
        ack?.({ ok: false, error: r.error })
        return
      }
      void socket.join('plaza:' + r.joined.plazaId)
      socket.data.plazaId = r.joined.plazaId
      ack?.({ ok: true, data: { ...r.joined, lots: estate.lots() } }) // 부동산 빈터 스냅샷 동봉(허브는 모름)
      // 알바 중 입장이면 "영업 중"으로 표시(다음 틱에 주변 전파). self 는 economy HUD 로 별도 표시.
      if (account && economy.isWorking(account.id))
        plaza.setWorking(playerId, true, economy.jobOf(account.id)?.shopId, { nick, look })
    })
    socket.on('plaza:leave', () => {
      const plazaId = socket.data.plazaId
      if (plazaId) void socket.leave('plaza:' + plazaId)
      socket.data.plazaId = undefined
      plaza.leave(playerId, socket.id)
    })
    // 이동 의도(고빈도) — 서버가 인접·쿨다운·경계 검증 후 다음 틱에 반영(거부=무시).
    // 알바 중엔 이동 불가(점원 고정·마이룸 비움) — 서버 게이트(클라 잠금의 안티치트 백업).
    socket.on('plaza:move', (req) => {
      if (socket.data.plazaId && !(account && economy.isWorking(account.id))) plaza.move(playerId, req)
    })
    // 잡담 — 서버가 길이·도배 검증 후 광장 룸으로 말풍선+로그 송출.
    socket.on('plaza:say', (req) => {
      const plazaId = socket.data.plazaId
      if (!plazaId) return
      const r = plaza.say(playerId, req?.text)
      if (r.ok && r.msg) io.to('plaza:' + plazaId).emit('plaza:msg', r.msg)
    })
    // 이모트 — 서버가 화이트리스트·쿨다운 검증 후 광장 룸으로 브로드캐스트.
    socket.on('plaza:emote', (req) => {
      const plazaId = socket.data.plazaId
      if (!plazaId) return
      const r = plaza.emote(playerId, req?.emote)
      if (r.ok && r.emote) io.to('plaza:' + plazaId).emit('plaza:emote', { playerId, emote: r.emote })
    })

    // ===== 도트타운 마이룸 실시간 방문 — 휘발 멀티플레이 =====
    // 입장: 손님 포함 누구나 방문·걷기 가능. roomId=방 주인 id. 외형은 서버 보관 CharSave 동봉(위조 방지). 방 존재 여부 확인.
    socket.on('roomvisit:enter', (req, ack) => {
      const roomId = typeof req?.roomId === 'string' ? req.roomId : ''
      if (!roomId || !auth.getAccountById(roomId)) {
        ack?.({ ok: false, error: '방을 찾을 수 없어요.' })
        return
      }
      // 알바 근무 중엔 마이룸 라이브에 참가할 수 없다(캐릭터는 광장 상점에 있음) — 내 방/남의 방 모두 차단.
      if (account && economy.isWorking(account.id)) {
        ack?.({ ok: false, error: '알바 근무 중에는 마이룸에 들어갈 수 없어요.' })
        return
      }
      const nick = (account && displayNick(account.id)) || '손님'
      const look = account ? dottown.getChar(account.id) : null
      const prev = socket.data.visitRoomId
      if (prev && prev !== roomId) void socket.leave('roomvisit:' + prev) // 다른 방 방문 중이었으면 그 소켓룸에서 나감
      const r = roomVisit.enter(roomId, playerId, nick, look, socket.id)
      if (!r.ok) {
        ack?.({ ok: false, error: r.error })
        return
      }
      void socket.join('roomvisit:' + roomId)
      socket.data.visitRoomId = roomId
      ack?.({ ok: true, data: r.joined })
    })
    socket.on('roomvisit:leave', () => {
      const roomId = socket.data.visitRoomId
      if (roomId) void socket.leave('roomvisit:' + roomId)
      socket.data.visitRoomId = undefined
      roomVisit.leave(playerId, socket.id)
    })

    // ===== 커뮤니티 — 보고 있는 게시판·글의 룸으로 갈아탄다 =====
    // ⚠들어가기 전에 반드시 이전 룸을 떠난다. 안 그러면 화면을 옮길 때마다 소속이 쌓여
    //   상관없는 게시판의 사건까지 계속 받게 된다(이전에 같은 형태의 누수를 겪었다).
    const cmtyLeave = (): void => {
      for (const r of socket.data.cmtyRooms ?? []) void socket.leave(r)
      socket.data.cmtyRooms = []
    }
    socket.on('cmty:watch', (req) => {
      cmtyLeave()
      const acct = socket.data.account
      if (!acct) return
      const rooms: string[] = ['cmty:main']
      const boardId = typeof req?.boardId === 'string' ? req.boardId : ''
      const postId = typeof req?.postId === 'string' ? req.postId : ''
      // 존재만 보고 들여보내면 숨긴 게시판의 활동이 그대로 새 나간다 — 읽을 수 있는 사람만 들인다.
      const permCtx = {
        accountId: acct.id,
        isAppAdmin: acct.role === 'admin',
        member: community.member(acct.id),
        now: Date.now()
      }
      const board = community.board(boardId)
      if (board && community.can('board.read', { ...permCtx, board })) rooms.push('cmtyb:' + boardId)
      if (postId) {
        const sum = cmtyPosts.summary(postId)
        const pb = sum ? community.board(sum.boardId) : null
        if (pb && community.can('board.read', { ...permCtx, board: pb })) rooms.push('cmtyp:' + postId)
      }
      for (const r of rooms) void socket.join(r)
      socket.data.cmtyRooms = rooms
    })
    socket.on('cmty:unwatch', cmtyLeave)
    // 이동 의도(고빈도) — 서버가 인접·쿨다운·바닥경계 검증 후 다음 틱 반영(거부=권위좌표 재송출).
    socket.on('roomvisit:move', (req) => {
      const rid = socket.data.visitRoomId
      if (rid) roomVisit.move(rid, playerId, req)
    })
    // 잡담 — 서버가 길이·도배 검증 후 그 방 소켓룸으로 말풍선+로그 송출.
    socket.on('roomvisit:say', (req) => {
      const rid = socket.data.visitRoomId
      if (!rid) return
      const r = roomVisit.say(rid, playerId, req?.text)
      if (r.ok && r.msg) io.to('roomvisit:' + rid).emit('roomvisit:msg', r.msg)
    })
    // 이모트 — 화이트리스트·쿨다운 검증 후 그 방 소켓룸으로 브로드캐스트.
    socket.on('roomvisit:emote', (req) => {
      const rid = socket.data.visitRoomId
      if (!rid) return
      const r = roomVisit.emote(rid, playerId, req?.emote)
      if (r.ok && r.emote) io.to('roomvisit:' + rid).emit('roomvisit:emote', { playerId, emote: r.emote })
    })

    socket.on('disconnect', (reason) => {
      log('disconnect', playerId.slice(0, 8), reason, 'sockets', io.sockets.sockets.size)
      // 광장 정리 — 이 소켓이 광장 액터의 현재 소켓이면 퇴장 브로드캐스트 예약(더 새 소켓이 이어받았으면 유지).
      plaza.disconnect(playerId, socket.id)
      // 마이룸 방문 정리 — 동일 시맨틱(마지막 소켓이면 그 방에서 퇴장).
      roomVisit.disconnect(playerId, socket.id)
      // 전역 프레즌스 정리 — 이 계정의 마지막 소켓이 끊기면 오프라인 알림(위장 오프라인이었으면 무음).
      if (account) {
        auth.touchSeen(account.id) // 마지막 접속 = 마지막으로 연결돼 있던 시각(관리자 서버관리 표시)
        const set = presence.get(account.id)
        if (set) {
          set.delete(socket.id)
          if (set.size === 0) {
            presence.delete(account.id)
            dmRate.delete(account.id) // 마지막 소켓 종료 → DM 레이트리밋 항목도 정리(누수 방지)
            presenceRate.delete(account.id)
          }
        }
        // 마지막 소켓이 아니어도 이 소켓이 세션방 소켓이었으면 '세션중' 해제 가능 — 재계산으로 일괄 처리.
        syncPresence(account.id)
      }
      const roomId = socket.data.roomId
      if (!roomId) return
      // 연결만 끊김 → 참가자 유지(재접속 대기), 나머지에게 connected=false 알림.
      // 휘발 위치·뷰맵은 여기서 지우지 않는다 — 세션 복구(connectionStateRecovery) 재접속은 위치를 자동 재보고하지
      // 않으므로, 지우면 잠깐 끊겼다 복구된 플레이어의 GM 위치 마커가 사라진다. 정리는 명시적 퇴장(room:leave)에서만.
      // (항목은 playerId 키라 재입장 시 덮어써지고, 참가자 목록과 대조(emitPositions)되므로 무한 누적되지 않는다.)
      store.markDisconnected(roomId, playerId)
      broadcastParticipants(roomId)
    })
  })

  // 주기 진단(로거 주입 시만) — 소켓 수·메모리(RSS/heap)·방 수 추이로 누수/폭주를 호스트 로그에서 추적. unref 로 종료를 막지 않음.
  if (opts?.log) {
    const diag = setInterval(() => {
      const m = process.memoryUsage()
      log(
        'diag',
        'sockets',
        io.sockets.sockets.size,
        'rssMB',
        Math.round(m.rss / 1048576),
        'heapMB',
        Math.round(m.heapUsed / 1048576),
        'rooms',
        store.roomCount
      )
    }, 30000)
    diag.unref()
    httpServer.on('close', () => clearInterval(diag))
  }

  return { httpServer, io, store, auth, characters, assets, dm, notif, posts, sessionlogs, dottown, economy, market }
}
