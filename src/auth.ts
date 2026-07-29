// 계정·인증. 파일 영속(<dataDir>/accounts.json) + scrypt 해시 + 인메모리 세션 토큰.
// 권한 모델(2단계, 서로 무관한 별도 축):
//   ① 전역 등급 admin/member/guest — 서버 첫 가입자가 admin(부트스트랩·adminUsername 고정), 이후 가입자는
//      guest(승인 대기)로 생성된다. admin 이 guest 를 member 로 승인하면 세션방 생성·로비 꾸밈 등 일반 기능이
//      열린다. guest 는 프로필 편집·세션방 PL 참여만 가능(호스팅 용량 보호용 안전장치).
//   ② 방 역할 GM/PL(rooms.ts, 생성자=소유자=GM)은 ①과 별개로 방 안에서만 의미를 가진다.
import { randomUUID, randomBytes, scryptSync, timingSafeEqual } from 'node:crypto'
import { readFileSync, writeFileSync, mkdirSync, renameSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { collectAssetRefs as scanAssetRefs } from './assets'
import type { PresenceStatus, ProfileLink, ProfileTheme } from './protocol'

export type AccountRole = 'admin' | 'member' | 'guest'

/** hex 색만 허용(#rgb~#rrggbbaa) — CSS 주입 방지. 아니면 undefined. */
function hexColor(v: unknown): string | undefined {
  return typeof v === 'string' && /^#[0-9a-fA-F]{3,8}$/.test(v) ? v : undefined
}

/**
 * data:image/ URL 만 허용(길이 캡). 아바타·배너는 클라에서 CSS background `url(...)` 로 렌더되므로
 * 임의 문자열을 저장하면 CSS 주입(다른 사용자 갠홈·방명록에서 교차 노출) 위험 → 이미지 data URL 만 통과.
 * 빈/비이미지/비문자 → undefined.
 */
function dataImageUrl(v: unknown, maxLen: number): string | undefined {
  if (typeof v !== 'string' || !v) return undefined
  return /^data:image\/[a-z0-9.+-]+[;,]/i.test(v) ? v.slice(0, maxLen) : undefined
}

/** 자산 참조('asset:<sha256>') 형식 — 짧고(약 71자) CSS 주입 불가. */
const ASSET_REF_RE = /^asset:[a-f0-9]{64}$/

/**
 * 로비 이미지 필드 — 자산 참조('asset:<sha256>') 또는 data:image URL 둘 다 허용.
 * 자산화(egress 절감)한 신버전 클라는 'asset:' 참조를, 업로드 실패 폴백·구버전 클라는 data URL 을 보낸다(하위호환).
 * 참조는 그대로 통과(GET /asset 가 서빙·collectAssetRefs 가 GC 보존), data URL 은 기존처럼 검증·길이 캡.
 * 그 외 문자열은 거부(CSS 주입 방지).
 */
function lobbyImageRef(v: unknown, maxLen: number): string | undefined {
  if (typeof v !== 'string' || !v) return undefined
  if (ASSET_REF_RE.test(v)) return v
  return /^data:image\/[a-z0-9.+-]+[;,]/i.test(v) ? v.slice(0, maxLen) : undefined
}

/** 프로필 색 테마 정규화 — 모든 값 hex 검증. 전부 비면 undefined(제거). */
function sanitizeTheme(v: unknown): ProfileTheme | undefined {
  if (!v || typeof v !== 'object') return undefined
  const o = v as Record<string, unknown>
  const t: ProfileTheme = {
    accent: hexColor(o.accent),
    nameColor: hexColor(o.nameColor),
    bioColor: hexColor(o.bioColor),
    bg: hexColor(o.bg)
  }
  return t.accent || t.nameColor || t.bioColor || t.bg ? t : undefined
}

/** 프로필 링크 정규화 — 라벨·URL 길이 캡, http(s) 만 허용(javascript: 등 차단), 최대 6개. 빈 배열→undefined. */
function sanitizeLinks(arr: unknown): ProfileLink[] | undefined {
  if (!Array.isArray(arr)) return undefined
  const out: ProfileLink[] = []
  for (const v of arr) {
    if (!v || typeof v !== 'object') continue
    const o = v as Record<string, unknown>
    const label = typeof o.label === 'string' ? o.label.trim().slice(0, 30) : ''
    let url = typeof o.url === 'string' ? o.url.trim().slice(0, 400) : ''
    if (!url) continue
    if (!/^https?:\/\//i.test(url)) {
      if (/^[\w.-]+\.[a-z]{2,}/i.test(url)) url = 'https://' + url // 스킴 없으면 https 부여
      else continue // http(s) 아님(javascript: 등) → 차단
    }
    out.push({ label: label || url, url })
    if (out.length >= 6) break
  }
  return out.length ? out : undefined
}

/** 갠홈 방명록 글 1개 — 작성자 정보는 작성 시점 스냅샷(작성자 탈퇴/변경에도 표시 유지). */
export interface GuestbookEntry {
  id: string
  authorId: string
  authorName: string
  authorAvatar?: string
  message: string
  createdAt: number
}

/** 갠홈 둘러보기용 사용자 요약(공개). */
export interface UserSummary {
  id: string
  username: string
  nickname?: string
  avatar?: string
}

/** 관리자 서버관리용 계정 요약(등급·가입일·마지막 접속 포함 — admin 전용). */
export interface AdminAccountInfo {
  id: string
  username: string
  nickname?: string
  avatar?: string
  role: AccountRole
  createdAt: number
  /** 마지막 접속 일시(ms) — 로그인·소켓 연결/종료 시 갱신. 기능 도입 전 계정은 미기록. */
  lastSeenAt?: number
}

/** 타인 갠홈 방문 시 보는 홈(공개 프로필 + 방명록). */
export interface HomeView {
  account: PublicAccount
  guestbook: GuestbookEntry[]
}

/** 공개된 로비 꾸밈 1개(갤러리 카드). 음악은 오디오 없이 제목만 동기화. */
export interface LobbyGalleryItem {
  title: string
  memo: string
  colors: string[]
  image?: string
}
export interface LobbyDDayItem {
  title: string
  emoji: string
  mode: 'until' | 'since'
  date: string
  image?: string
}
/** 공개 캘린더 일정 1건(읽기전용 — 텍스트·색만). */
export interface LobbyCalEvent {
  text: string
  color: string
}
/** 공개 스티커 1개 — 바탕화면에 자유 배치한 이미지 장식(테두리·그림자 옵션). 방문 시 읽기전용 렌더. */
export interface LobbySticker {
  /** 좌상단 px(호스트 화면 기준). */
  x: number
  y: number
  /** 표시 크기 px(비율 유지). */
  w: number
  h: number
  /** 테두리 on/off + 색(hex) + 굵기(px). */
  border: boolean
  borderColor: string
  borderWidth: number
  /** 그림자 on/off. */
  shadow: boolean
  /** 스티커 이미지(asset 참조 또는 data URL). 없으면 스티커 자체가 무의미 → sanitize 가 제외. */
  image?: string
}
/** 사용자가 공개(동기화)한 로비 스냅샷 — 다른 사람이 '로비 방문' 시 이 데이터로 읽기전용 렌더. */
export interface LobbySnapshot {
  colors: Record<string, string>
  wallpaper: { kind: 'solid' | 'image'; color: string; fit: 'cover' | 'contain'; image?: string }
  memoText: string
  gallery: LobbyGalleryItem[]
  music: { title: string; cover?: string }[]
  ddays: LobbyDDayItem[]
  /** 'YYYY-MM-DD' → 그 날 일정 목록(공개). */
  calEvents: Record<string, LobbyCalEvent[]>
  iconImages: Record<string, string>
  iconPos: Record<string, { x: number; y: number }>
  iconEmojis: Record<string, string>
  /** 아이콘 이름(라벨) 커스텀(iconId → 글자). 구버전 스냅샷엔 없음. */
  iconLabels?: Record<string, string>
  /** 아이콘 그림 표시 크기(iconId → px). 구버전 스냅샷엔 없음. */
  iconSizes?: Record<string, number>
  /** 숨긴 아이콘(iconId → true). 방문자에게도 숨긴다. 구버전 스냅샷엔 없음. */
  hiddenIcons?: Record<string, boolean>
  /** 바탕화면 스티커(그리는 순서 = 배열 순서 = 겹침 순서). */
  stickers: LobbySticker[]
  updatedAt: number
}

// 로비 스냅샷 상한(작은 서버 보호 — 이미지/개수 캡).
const MAX_LOBBY_IMAGE = 1_400_000 // 벽지·갤러리 이미지 1장
const MAX_LOBBY_ICON = 200_000 // 아이콘 이미지 1개
const MAX_LOBBY_COVER = 400_000 // 음악 트랙 커버 1개
const MAX_LOBBY_COVER_TOTAL = 5_000_000 // 커버 합계 상한 — accounts.json 비대화·본문 한도 방지(초과분은 제목만 저장)
const MAX_LOBBY_GALLERY = 60
const MAX_LOBBY_MUSIC = 200
const MAX_LOBBY_ICONS = 24
const MAX_LOBBY_MEMO = 4000
const MAX_LOBBY_DDAY = 40 // 디데이 카드 개수 상한
const MAX_LOBBY_DDAY_TOTAL = 5_000_000 // 디데이 이미지 합계 상한(accounts.json 비대화·본문 한도 방지)
const MAX_LOBBY_CAL_DAYS = 400 // 캘린더 일정 날짜(키) 개수 상한
const MAX_LOBBY_CAL_PER_DAY = 20 // 한 날짜의 일정 개수 상한
const MAX_LOBBY_CAL_TEXT = 200 // 일정 텍스트 길이 상한
const MAX_LOBBY_STICKERS = 60 // 스티커 개수 상한
const MAX_LOBBY_STICKER = 600_000 // 스티커 이미지 1개 상한
const MAX_LOBBY_STICKER_TOTAL = 6_000_000 // 스티커 이미지 합계 상한(accounts.json 비대화·본문 한도 방지)

/** 로비 스냅샷 정규화 — 색은 hex, 이미지는 data:image(길이 캡), 텍스트/개수 캡. CSS·저장 주입 방지. */
/** 스냅샷에 실제로 실린 그림 수 — 통째로 빠진 사본이 멀쩡한 것을 덮지 않게 가르는 데 쓴다. */
function countLobbyImages(l: LobbySnapshot): number {
  return (
    (l.wallpaper?.image ? 1 : 0) +
    Object.keys(l.iconImages ?? {}).length +
    (l.gallery ?? []).filter((g) => g.image).length +
    (l.ddays ?? []).filter((d) => d.image).length +
    (l.stickers ?? []).length +
    (l.music ?? []).filter((m) => m.cover).length
  )
}

function sanitizeLobby(v: unknown): LobbySnapshot | null {
  if (!v || typeof v !== 'object') return null
  const o = v as Record<string, unknown>
  const colors: Record<string, string> = {}
  if (o.colors && typeof o.colors === 'object') {
    for (const [k, val] of Object.entries(o.colors as Record<string, unknown>)) {
      if (Object.keys(colors).length >= 24) break
      const h = hexColor(val)
      if (h) colors[k.slice(0, 24)] = h
    }
  }
  const wp = (o.wallpaper && typeof o.wallpaper === 'object' ? o.wallpaper : {}) as Record<string, unknown>
  const wallpaper = {
    kind: wp.kind === 'image' ? ('image' as const) : ('solid' as const),
    color: hexColor(wp.color) ?? '',
    fit: wp.fit === 'contain' ? ('contain' as const) : ('cover' as const),
    image: lobbyImageRef(wp.image, MAX_LOBBY_IMAGE)
  }
  const gallery: LobbyGalleryItem[] = []
  if (Array.isArray(o.gallery)) {
    for (const g of o.gallery as Record<string, unknown>[]) {
      if (gallery.length >= MAX_LOBBY_GALLERY) break
      if (!g || typeof g !== 'object') continue
      gallery.push({
        title: typeof g.title === 'string' ? g.title.slice(0, 60) : '',
        memo: typeof g.memo === 'string' ? g.memo.slice(0, 300) : '',
        colors: Array.isArray(g.colors) ? (g.colors as unknown[]).slice(0, 4).map((c) => hexColor(c) ?? '') : [],
        image: lobbyImageRef(g.image, MAX_LOBBY_IMAGE)
      })
    }
  }
  const music: { title: string; cover?: string }[] = []
  let coverBudget = MAX_LOBBY_COVER_TOTAL
  if (Array.isArray(o.music)) {
    for (const m of o.music as Record<string, unknown>[]) {
      if (music.length >= MAX_LOBBY_MUSIC) break
      const title = m && typeof m === 'object' && typeof m.title === 'string' ? m.title.slice(0, 200) : ''
      const cover = m && typeof m === 'object' ? lobbyImageRef(m.cover, MAX_LOBBY_COVER) : undefined
      if (cover && cover.length <= coverBudget) {
        coverBudget -= cover.length
        music.push({ title, cover })
      } else {
        music.push({ title }) // 커버 예산 초과 또는 비-이미지 → 제목만
      }
    }
  }
  const iconImages: Record<string, string> = {}
  if (o.iconImages && typeof o.iconImages === 'object') {
    for (const [k, val] of Object.entries(o.iconImages as Record<string, unknown>)) {
      if (Object.keys(iconImages).length >= MAX_LOBBY_ICONS) break
      const img = lobbyImageRef(val, MAX_LOBBY_ICON)
      if (img) iconImages[k.slice(0, 40)] = img
    }
  }
  const iconPos: Record<string, { x: number; y: number }> = {}
  if (o.iconPos && typeof o.iconPos === 'object') {
    for (const [k, val] of Object.entries(o.iconPos as Record<string, unknown>)) {
      if (Object.keys(iconPos).length >= MAX_LOBBY_ICONS) break
      const p = val as Record<string, unknown>
      if (p && typeof p.x === 'number' && typeof p.y === 'number' && isFinite(p.x) && isFinite(p.y)) {
        iconPos[k.slice(0, 40)] = { x: Math.round(p.x), y: Math.round(p.y) }
      }
    }
  }
  const iconEmojis: Record<string, string> = {}
  if (o.iconEmojis && typeof o.iconEmojis === 'object') {
    for (const [k, val] of Object.entries(o.iconEmojis as Record<string, unknown>)) {
      if (Object.keys(iconEmojis).length >= MAX_LOBBY_ICONS) break
      if (typeof val === 'string' && val.trim()) iconEmojis[k.slice(0, 40)] = val.slice(0, 16)
    }
  }
  // 아이콘 이름(라벨) — 텍스트 길이 캡(클라 ICON_LABEL_MAX 와 동일 24자).
  const iconLabels: Record<string, string> = {}
  if (o.iconLabels && typeof o.iconLabels === 'object') {
    for (const [k, val] of Object.entries(o.iconLabels as Record<string, unknown>)) {
      if (Object.keys(iconLabels).length >= MAX_LOBBY_ICONS) break
      if (typeof val === 'string' && val.trim()) iconLabels[k.slice(0, 40)] = val.trim().slice(0, 24)
    }
  }
  // 아이콘 그림 크기 — 숫자 clamp(클라 ICON_SIZE_MIN/MAX 와 동일 32~72).
  const iconSizes: Record<string, number> = {}
  if (o.iconSizes && typeof o.iconSizes === 'object') {
    for (const [k, val] of Object.entries(o.iconSizes as Record<string, unknown>)) {
      if (Object.keys(iconSizes).length >= MAX_LOBBY_ICONS) break
      if (typeof val === 'number' && isFinite(val)) iconSizes[k.slice(0, 40)] = Math.min(72, Math.max(32, Math.round(val)))
    }
  }
  // 숨긴 아이콘 — true 인 항목만 보존(방문자 렌더에서도 제외).
  const hiddenIcons: Record<string, boolean> = {}
  if (o.hiddenIcons && typeof o.hiddenIcons === 'object') {
    for (const [k, val] of Object.entries(o.hiddenIcons as Record<string, unknown>)) {
      if (Object.keys(hiddenIcons).length >= MAX_LOBBY_ICONS) break
      if (val === true) hiddenIcons[k.slice(0, 40)] = true
    }
  }
  const ddays: LobbyDDayItem[] = []
  let ddayBudget = MAX_LOBBY_DDAY_TOTAL
  if (Array.isArray(o.ddays)) {
    for (const d of o.ddays as Record<string, unknown>[]) {
      if (ddays.length >= MAX_LOBBY_DDAY) break
      if (!d || typeof d !== 'object') continue
      const image = lobbyImageRef(d.image, MAX_LOBBY_IMAGE)
      const keepImg = image && image.length <= ddayBudget
      if (keepImg) ddayBudget -= image!.length
      ddays.push({
        title: typeof d.title === 'string' ? d.title.slice(0, 60) : '',
        emoji: typeof d.emoji === 'string' ? d.emoji.slice(0, 8) : '',
        mode: d.mode === 'since' ? 'since' : 'until',
        // 날짜는 'YYYY-MM-DD' 만 허용(그 외는 빈 문자열 → 클라가 안전 처리).
        date: typeof d.date === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(d.date) ? d.date : '',
        ...(keepImg ? { image } : {})
      })
    }
  }
  // 캘린더 일정 — 날짜 키('YYYY-MM-DD')만 허용, 텍스트/색/개수 캡. 색은 hex(없으면 기본 초록).
  const calEvents: Record<string, LobbyCalEvent[]> = {}
  if (o.calEvents && typeof o.calEvents === 'object') {
    for (const [k, val] of Object.entries(o.calEvents as Record<string, unknown>)) {
      if (Object.keys(calEvents).length >= MAX_LOBBY_CAL_DAYS) break
      if (!/^\d{4}-\d{2}-\d{2}$/.test(k) || !Array.isArray(val)) continue
      const list: LobbyCalEvent[] = []
      for (const ev of val as Record<string, unknown>[]) {
        if (list.length >= MAX_LOBBY_CAL_PER_DAY) break
        if (!ev || typeof ev !== 'object') continue
        const text = typeof ev.text === 'string' ? ev.text.slice(0, MAX_LOBBY_CAL_TEXT) : ''
        if (!text.trim()) continue
        list.push({ text, color: hexColor(ev.color) ?? '#5bbd7a' })
      }
      if (list.length) calEvents[k] = list
    }
  }
  // 스티커 — 이미지 필수(없으면 제외), 개수·이미지 용량(개별·합계) 캡, 좌표/크기 숫자 검증, 색 hex·굵기 clamp.
  const stickers: LobbySticker[] = []
  let stickerBudget = MAX_LOBBY_STICKER_TOTAL
  const stickerNum = (v: unknown, min: number, max: number, dflt: number): number =>
    typeof v === 'number' && isFinite(v) ? Math.min(max, Math.max(min, Math.round(v))) : dflt
  if (Array.isArray(o.stickers)) {
    for (const st of o.stickers as Record<string, unknown>[]) {
      if (stickers.length >= MAX_LOBBY_STICKERS) break
      if (!st || typeof st !== 'object') continue
      const image = lobbyImageRef(st.image, MAX_LOBBY_STICKER)
      if (!image || image.length > stickerBudget) continue // 이미지 없거나 합계 예산 초과 → 제외(메타만은 무의미)
      stickerBudget -= image.length
      stickers.push({
        x: stickerNum(st.x, -4000, 20000, 0),
        y: stickerNum(st.y, -4000, 20000, 0),
        w: stickerNum(st.w, 8, 4000, 160),
        h: stickerNum(st.h, 8, 4000, 160),
        border: st.border === true,
        borderColor: hexColor(st.borderColor) ?? '#ffffff',
        borderWidth: stickerNum(st.borderWidth, 0, 40, 0),
        shadow: st.shadow !== false, // 기본 켬(명시적 false 일 때만 끔)
        image
      })
    }
  }
  return {
    colors,
    wallpaper,
    memoText: typeof o.memoText === 'string' ? o.memoText.slice(0, MAX_LOBBY_MEMO) : '',
    gallery,
    music,
    ddays,
    calEvents,
    iconImages,
    iconPos,
    iconEmojis,
    iconLabels,
    iconSizes,
    hiddenIcons,
    stickers,
    updatedAt: Date.now()
  }
}

export interface Account {
  id: string
  username: string
  /** scrypt 해시(hex) */
  hash: string
  /** 솔트(hex) */
  salt: string
  role: AccountRole
  createdAt: number
  /** 표시 닉네임(미설정 시 username 폴백) */
  nickname?: string
  /** 프로필 사진(data URL, 작은 WebP) */
  avatar?: string
  /** 자기소개 */
  bio?: string
  /** 프로필 배너(헤더 이미지, data URL) */
  banner?: string
  /** 프로필 링크(SNS 바이오) */
  links?: ProfileLink[]
  /** 프로필 카드 색 커스텀 */
  profileTheme?: ProfileTheme
  /** 갠홈 방명록(다른 사용자가 남긴 글). */
  guestbook?: GuestbookEntry[]
  /** 공개(동기화)한 로비 꾸밈 스냅샷 — 타인 '로비 방문' 시 사용. */
  lobby?: LobbySnapshot
  /** 친구(상호 수락) userId 목록. */
  friends?: string[]
  /** 나에게 온 친구 신청(상대 userId). */
  friendReqIn?: string[]
  /** 내가 보낸 친구 신청(상대 userId). */
  friendReqOut?: string[]
  /** 수동 프레즌스 상태(미설정=online). invisible 은 재접속 후에도 유지.
   *  PublicAccount 에는 절대 싣지 않는다 — /home 등으로 새면 '오프라인 표시' 위장이 무력화된다. */
  status?: PresenceStatus
  /** 마지막 접속 일시(ms) — 로그인 성공·소켓 연결/종료 시 갱신(관리자 서버관리 표시용). */
  lastSeenAt?: number
}

/** 외부로 노출하는 안전한 계정 정보(해시·솔트 제외). */
export interface PublicAccount {
  id: string
  username: string
  role: AccountRole
  nickname?: string
  avatar?: string
  bio?: string
  banner?: string
  links?: ProfileLink[]
  profileTheme?: ProfileTheme
}

/** 프로필 편집 패치(부분 갱신). */
export interface ProfilePatch {
  nickname?: string
  avatar?: string
  bio?: string
  banner?: string
  links?: ProfileLink[]
  profileTheme?: ProfileTheme
}

export type AuthResult =
  | { ok: true; token: string; account: PublicAccount }
  | { ok: false; error: string }

export type ProfileResult = { ok: true; account: PublicAccount } | { ok: false; error: string }
export type GuestbookResult = { ok: true; guestbook: GuestbookEntry[] } | { ok: false; error: string }
export type LobbyResult = { ok: true } | { ok: false; error: string }

/** 친구 신청/수락/거절/끊기 결과. 성공 시 상대 id(targetId)·행위자 id(selfId, 본인 다른 기기 푸시용)·자동수락 여부. */
export type FriendResult =
  | { ok: true; targetId?: string; selfId?: string; autoAccepted?: boolean }
  | { ok: false; error: string }
/** 친구 목록 응답(요약). 온라인 표시는 호출 측 relay 가 프레즌스로 덧붙인다. */
export type FriendListResult =
  | { ok: true; friends: UserSummary[]; incoming: UserSummary[]; outgoing: UserSummary[] }
  | { ok: false; error: string }

/** 방명록 글 최대 길이·홈당 최대 보관 수(초과 시 오래된 것부터 제거). */
const MAX_GUESTBOOK_MESSAGE = 500
const MAX_GUESTBOOK_ENTRIES = 300

/** 친구·신청 개수 상한(accounts.json 무한 증식 방지 — 다른 항목과 동일한 용량 보호). */
const MAX_FRIENDS = 1000
const MAX_FRIEND_REQ = 500

interface PersistShape {
  accounts: Account[]
}
interface ConfigShape {
  adminUsername?: string
}

const SCRYPT_KEYLEN = 64

function hashPassword(password: string, salt: string): string {
  return scryptSync(password, salt, SCRYPT_KEYLEN).toString('hex')
}

/** 아이디 비교는 대소문자·공백 무시(중복/관리자 매칭용). 표시는 원본 유지. */
function normUser(u: string): string {
  return u.trim().toLowerCase()
}

export interface AuthStore {
  signup(username: string, password: string): AuthResult
  login(username: string, password: string): AuthResult
  verifyToken(token: string): PublicAccount | null
  logout(token: string): void
  /**
   * 계정 탈퇴 — 토큰 + 비밀번호 재확인(파괴적·비가역). 성공 시 계정·세션·이 사용자가 남긴 방명록을 제거하고
   * 탈퇴 계정 id 와 영향받은 친구 id 목록(friend:update 푸시용)을 반환한다(캐릭터·DM·소유 세션방 등 다른 저장소
   * 연쇄 정리는 호출 측 relay 가 이 id 로 수행).
   */
  deleteAccount(
    token: string,
    password: string
  ): { ok: true; accountId: string; affectedFriends: string[] } | { ok: false; error: string }
  getAccountById(id: string): PublicAccount | null
  /**
   * 본인 비밀번호 변경 — 토큰 + 현재 비밀번호 재확인. 성공하면 이 토큰만 남기고 나머지 세션을 끊는다
   * (비밀번호를 바꾸는 이유가 보통 '다른 기기/사람을 내보내려는 것'이라 남은 세션을 살려 두면 의미가 없다).
   */
  changePassword(
    token: string,
    current: string,
    next: string
  ): { ok: true; accountId: string } | { ok: false; error: string }
  /**
   * 관리자 이양 — 지금 관리자가 다른 계정에게 관리자를 넘기고 본인은 member 가 된다(관리자는 항상 1명).
   * 대상은 손님이 아니어야 한다(승인부터 하고 넘기게). 서버를 연 사람이 실수로 먼저 로그인해 관리자가 된 경우를 푼다.
   * 권한 검사(요청자=admin)는 호출 측 relay 가 수행한다.
   */
  transferAdmin(
    fromId: string,
    toId: string
  ): { ok: true; from: PublicAccount; to: PublicAccount } | { ok: false; error: string }
  /**
   * 관리자: 대상 계정 등급 변경(member↔guest). admin 은 부트스트랩 전용이라 대상이 admin 이거나 목표가 admin 이면 거부.
   * 권한 검사(요청자=admin)는 호출 측 relay 가 수행한다. 성공 시 갱신된 공개 계정을 반환.
   */
  setRole(targetId: string, role: AccountRole): ProfileResult
  /**
   * 관리자: 대상 계정의 로그인 아이디(username) 변경. 길이(2자 이상)·중복(대소문자·공백 무시, 본인 제외) 검증 후 갱신.
   * id(내부 UUID)는 그대로라 다른 저장소(방·캐릭터·DM·블로그·친구) 연쇄 변경은 없다. 권한 검사(요청자=admin)는
   * 호출 측 relay 가 수행한다. 성공 시 갱신된 공개 계정을 반환.
   */
  setUsername(targetId: string, newUsername: string): ProfileResult
  /** 관리자 서버관리 — 전체 계정 요약(등급·가입일·아바타·마지막 접속). 가입 순(오래된 순). */
  listForAdmin(): AdminAccountInfo[]
  /** 마지막 접속 일시 갱신 — 로그인·소켓 연결/종료 시 호출. 메모리는 즉시, 디스크 저장은
   *  직전 기록과 60초 이상 차이날 때만(잦은 재접속에도 accounts.json 쓰기 폭주 방지). */
  touchSeen(accountId: string): void
  /**
   * 관리자 용량 산출 — 로비 스냅샷(공개 꾸밈, '로비 초기화'가 지우는 범위)과 프로필(아바타·배너·소개·방명록)을
   * 분리한 직렬화 바이트 + 참조 자산 해시. '로비' 컬럼과 초기화 회수 범위를 일치시키기 위함.
   */
  usageForUser(userId: string): { lobbyBytes: number; profileBytes: number; refs: Set<string> }
  /** 관리자: 한 계정의 공개 로비 스냅샷 초기화(꾸밈 회수). 멱등. 대상 없으면 false. */
  adminClearLobby(userId: string): boolean
  /**
   * 관리자: 비밀번호 없이 대상 계정 삭제(계정·세션·이 사용자가 남긴 방명록 제거). admin 대상은 거부.
   * 캐릭터·DM·블로그·소유 세션방 연쇄 정리는 호출 측 relay 가 반환 accountId 로 수행(deleteAccount 와 동일).
   */
  deleteAccountById(
    userId: string
  ): { ok: true; accountId: string; affectedFriends: string[] } | { ok: false; error: string }
  /** 친구 신청(아이디=username 기준). 자기 자신·중복·이미 친구 거부. 상대가 이미 나를 신청했으면 자동 수락. */
  friendRequest(token: string, username: string): FriendResult
  /** 받은 친구 신청 수락 — 양쪽 friends 에 추가하고 보류 제거. */
  acceptFriend(token: string, requesterId: string): FriendResult
  /** 받은/보낸 친구 신청 취소·거절(멱등). */
  rejectFriend(token: string, otherId: string): FriendResult
  /** 친구 끊기(양쪽 friends 에서 제거, 멱등). */
  removeFriend(token: string, userId: string): FriendResult
  /** 내 친구·받은신청·보낸신청 목록(요약). 온라인 표시는 relay 가 덧붙인다. */
  friendList(token: string): FriendListResult
  /** 토큰 소유 계정의 프로필(닉네임·사진·소개) 부분 갱신. */
  updateProfile(token: string, patch: ProfilePatch): ProfileResult
  /** 수동 프레즌스 상태 저장(계정 영속). 무효 값/계정 없음이면 false. */
  setStatus(accountId: string, status: PresenceStatus): boolean
  /** 저장된 수동 프레즌스 상태(미설정=undefined=online). */
  getStatus(accountId: string): PresenceStatus | undefined
  /** 갠홈 둘러보기 — 전체 사용자 공개 요약(닉네임순). */
  listUsers(): UserSummary[]
  /** 타인/내 갠홈 보기 — 공개 프로필 + 방명록. 없는 id 면 null. */
  getHome(userId: string): HomeView | null
  /** 방명록 글 남기기 — 토큰 인증(작성자). 대상 홈에 추가 후 갱신된 방명록 반환. */
  addGuestbookEntry(token: string, targetUserId: string, message: string): GuestbookResult
  /** 방명록 글 삭제 — 홈 주인 또는 작성자만. 갱신된 방명록 반환. */
  removeGuestbookEntry(token: string, targetUserId: string, entryId: string): GuestbookResult
  /**
   * 내 로비 스냅샷 공개(동기화) — 토큰 인증. 정규화 후 저장.
   * refCount 는 보내는 기기가 '가지고 있다고 아는 그림 수'다. 그림이 하나도 안 실린 사본이 왔는데
   * 그 기기가 그림을 가지고 있다고 말하면, 읽지 못했을 뿐이므로 덮지 않는다.
   */
  setLobby(token: string, snapshot: unknown, refCount?: number): LobbyResult
  /** 타인/내 로비 스냅샷 조회(공개). 없으면 null. */
  getLobby(userId: string): LobbySnapshot | null
  /** 전 계정(아바타·배너·로비 스냅샷 등)에서 참조 중인 'asset:<해시>' 수집(자산 GC 라이브 집합). */
  collectAssetRefs(into: Set<string>): void
  /** 진단/테스트용. */
  accountCount(): number
  /** 진단/테스트용 — 현재 유효(미만료) 세션 수. */
  sessionCount(): number
}

/** 세션 토큰 기본 유휴 만료(슬라이딩) — 검증마다 연장. 30일 미사용 시 만료. */
const DEFAULT_SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000
/** 로그인 레이트리밋 기본값 — 윈도 내 최대 실패 횟수 / 윈도 길이. */
const DEFAULT_MAX_LOGIN_ATTEMPTS = 8
const DEFAULT_LOGIN_WINDOW_MS = 5 * 60 * 1000

interface Session {
  accountId: string
  expiresAt: number
}

/**
 * persist:false 면 파일 입출력 없이 인메모리로만(테스트용). dataDir 기본 = <cwd>/data.
 * sessionTtlMs=세션 유휴 만료(슬라이딩). maxLoginAttempts/loginWindowMs=로그인 레이트리밋.
 * now=시계 주입(테스트 결정성).
 */
export function createAuthStore(opts?: {
  dataDir?: string
  persist?: boolean
  sessionTtlMs?: number
  maxLoginAttempts?: number
  loginWindowMs?: number
  now?: () => number
}): AuthStore {
  const persist = opts?.persist !== false
  const dataDir = opts?.dataDir ?? join(process.cwd(), 'data')
  const accountsPath = join(dataDir, 'accounts.json')
  const configPath = join(dataDir, 'config.json')
  const ttl = opts?.sessionTtlMs ?? DEFAULT_SESSION_TTL_MS
  const maxAttempts = opts?.maxLoginAttempts ?? DEFAULT_MAX_LOGIN_ATTEMPTS
  const windowMs = opts?.loginWindowMs ?? DEFAULT_LOGIN_WINDOW_MS
  const now = opts?.now ?? Date.now

  let accounts: Account[] = []
  let config: ConfigShape = {}
  // 토큰 → 세션(계정 id + 만료시각). 인메모리(서버 재시작 시 휘발 = 전원 재로그인).
  const sessions = new Map<string, Session>()
  // 로그인 실패 추적(정규화 아이디 기준 슬라이딩 윈도). 브루트포스 완화.
  const loginAttempts = new Map<string, { count: number; resetAt: number }>()

  if (persist) {
    try {
      if (existsSync(accountsPath)) {
        const data = JSON.parse(readFileSync(accountsPath, 'utf8')) as PersistShape
        if (Array.isArray(data.accounts)) accounts = data.accounts
      }
    } catch (e) {
      console.error('[auth] accounts.json 로드 실패 — 빈 목록으로 시작:', e)
    }
    try {
      if (existsSync(configPath)) config = JSON.parse(readFileSync(configPath, 'utf8')) as ConfigShape
    } catch (e) {
      console.error('[auth] config.json 로드 실패:', e)
    }
  }

  function save(): void {
    if (!persist) return
    try {
      mkdirSync(dataDir, { recursive: true })
      const tmp = accountsPath + '.tmp'
      writeFileSync(tmp, JSON.stringify({ accounts }, null, 2), 'utf8') // 원자적 쓰기(임시→rename)
      renameSync(tmp, accountsPath)
    } catch (e) {
      console.error('[auth] 계정 저장 실패:', e)
    }
  }

  // 마지막 접속 기록 — 메모리는 즉시 갱신, 파일 쓰기는 전역 1회로 뭉친다(60초 트레일링).
  // accounts.json 은 아바타·배너·로비 스냅샷까지 담겨 수 MB 가 될 수 있어, 재접속 폭주 때 계정 수만큼
  // 전체 동기 쓰기가 몰리지 않게 한다. 표시용 정보라 최대 1분 지연 저장(비정상 종료 시 그만큼 유실)은 무해.
  let seenSaveTimer: NodeJS.Timeout | null = null
  function touchSeen(accountId: string): void {
    const a = accounts.find((x) => x.id === accountId)
    if (!a) return
    a.lastSeenAt = Date.now()
    if (!persist || seenSaveTimer) return // 이미 예약된 저장이 이 갱신도 함께 실어 간다
    seenSaveTimer = setTimeout(() => {
      seenSaveTimer = null
      save()
    }, 60_000)
    seenSaveTimer.unref() // 대기 중 저장이 프로세스 종료(테스트 러너 포함)를 붙잡지 않게
  }

  const pub = (a: Account): PublicAccount => ({
    id: a.id,
    username: a.username,
    role: a.role,
    nickname: a.nickname,
    avatar: a.avatar,
    bio: a.bio,
    banner: a.banner,
    links: a.links,
    profileTheme: a.profileTheme
  })
  function issue(a: Account): string {
    const token = randomUUID() + randomUUID() // 불투명 토큰
    sessions.set(token, { accountId: a.id, expiresAt: now() + ttl })
    sweepSessions() // 만료 토큰 정리(로그인 빈도 = 드묾 → O(n) 허용)
    return token
  }
  /** 만료 세션 일괄 제거(메모리 바운드). */
  function sweepSessions(): void {
    const t = now()
    for (const [token, s] of sessions) if (s.expiresAt <= t) sessions.delete(token)
  }
  /** 토큰 → 계정 id. 만료면 제거 후 null, 유효면 만료시각 슬라이딩 연장. */
  function accountIdForToken(token: unknown): string | null {
    if (typeof token !== 'string') return null
    const s = sessions.get(token)
    if (!s) return null
    if (s.expiresAt <= now()) {
      sessions.delete(token)
      return null
    }
    s.expiresAt = now() + ttl // 슬라이딩 — 활성 세션은 계속 연장
    return s.accountId
  }
  const find = (username: string): Account | undefined => {
    const n = normUser(username)
    return accounts.find((a) => normUser(a.username) === n)
  }

  // ===== 로그인 레이트리밋(정규화 아이디 기준 · 존재 여부와 무관 = 아이디 열거 방지) =====
  function isRateLimited(key: string): boolean {
    const rec = loginAttempts.get(key)
    return !!rec && rec.resetAt > now() && rec.count >= maxAttempts
  }
  function recordLoginFail(key: string): void {
    const t = now()
    const rec = loginAttempts.get(key)
    if (!rec || rec.resetAt <= t) {
      // 윈도 신규/갱신 — 누적 방지 위해 가끔 만료 항목 정리.
      if (loginAttempts.size > 5000) for (const [k, v] of loginAttempts) if (v.resetAt <= t) loginAttempts.delete(k)
      loginAttempts.set(key, { count: 1, resetAt: t + windowMs })
    } else {
      rec.count++
    }
  }

  // ===== 친구 관계 헬퍼 =====
  /** a·b 를 상호 친구로 추가(중복 방지). */
  function addFriend(a: Account, b: Account): void {
    if (!(a.friends ?? []).includes(b.id)) a.friends = [...(a.friends ?? []), b.id]
    if (!(b.friends ?? []).includes(a.id)) b.friends = [...(b.friends ?? []), a.id]
  }
  /** a·b 사이의 보류 신청(양방향 in/out)을 모두 제거. */
  function clearPending(a: Account, b: Account | undefined, otherId: string): void {
    a.friendReqIn = (a.friendReqIn ?? []).filter((x) => x !== otherId)
    a.friendReqOut = (a.friendReqOut ?? []).filter((x) => x !== otherId)
    if (b) {
      b.friendReqIn = (b.friendReqIn ?? []).filter((x) => x !== a.id)
      b.friendReqOut = (b.friendReqOut ?? []).filter((x) => x !== a.id)
    }
  }
  /** 계정 삭제 시 다른 모든 계정의 friends·신청 목록에서 그 id 를 제거(고아 참조 정리). */
  function purgeFromFriends(removedId: string): void {
    for (const acc of accounts) {
      if (acc.friends?.includes(removedId)) acc.friends = acc.friends.filter((x) => x !== removedId)
      if (acc.friendReqIn?.includes(removedId)) acc.friendReqIn = acc.friendReqIn.filter((x) => x !== removedId)
      if (acc.friendReqOut?.includes(removedId)) acc.friendReqOut = acc.friendReqOut.filter((x) => x !== removedId)
    }
  }
  /** id → 공개 요약(없으면 null). 친구 목록 응답용. */
  function summaryOf(id: string): UserSummary | null {
    const a = accounts.find((x) => x.id === id)
    return a ? { id: a.id, username: a.username, nickname: a.nickname, avatar: a.avatar } : null
  }

  return {
    signup(username, password) {
      const name = (username ?? '').trim()
      if (name.length < 2) return { ok: false, error: '아이디는 2자 이상이어야 합니다.' }
      if ((password ?? '').length < 4) return { ok: false, error: '비밀번호는 4자 이상이어야 합니다.' }
      if (find(name)) return { ok: false, error: '이미 사용 중인 아이디입니다.' }
      // 관리자: config.adminUsername 와 일치하거나, 첫 가입자(부트스트랩). 이후 가입자는 손님(승인 대기).
      const isAdmin =
        (!!config.adminUsername && normUser(config.adminUsername) === normUser(name)) ||
        accounts.length === 0
      const salt = randomBytes(16).toString('hex')
      const account: Account = {
        id: randomUUID(),
        username: name,
        hash: hashPassword(password, salt),
        salt,
        role: isAdmin ? 'admin' : 'guest',
        createdAt: Date.now()
      }
      accounts.push(account)
      save()
      return { ok: true, token: issue(account), account: pub(account) }
    },

    login(username, password) {
      const key = normUser(username ?? '')
      if (isRateLimited(key)) {
        return { ok: false, error: '로그인 시도가 너무 많습니다. 잠시 후 다시 시도하세요.' }
      }
      const account = find(username ?? '')
      const fail: AuthResult = { ok: false, error: '아이디 또는 비밀번호가 올바르지 않습니다.' }
      if (!account) {
        recordLoginFail(key)
        return fail
      }
      const attempt = Buffer.from(hashPassword(password ?? '', account.salt), 'hex')
      const stored = Buffer.from(account.hash, 'hex')
      if (attempt.length !== stored.length || !timingSafeEqual(attempt, stored)) {
        recordLoginFail(key)
        return fail
      }
      loginAttempts.delete(key) // 성공 시 카운터 초기화
      touchSeen(account.id) // 마지막 접속 기록(관리자 서버관리 표시)
      return { ok: true, token: issue(account), account: pub(account) }
    },

    verifyToken(token) {
      const id = accountIdForToken(token)
      if (!id) return null
      const a = accounts.find((x) => x.id === id)
      return a ? pub(a) : null
    },

    logout(token) {
      sessions.delete(token)
    },

    deleteAccount(token, password) {
      const id = accountIdForToken(token)
      if (!id) return { ok: false, error: '로그인이 필요합니다.' }
      const a = accounts.find((x) => x.id === id)
      if (!a) return { ok: false, error: '계정을 찾을 수 없습니다.' }
      // 비밀번호 재확인(타이밍 세이프) — 비가역 작업이라 토큰만으로는 부족.
      const attempt = Buffer.from(hashPassword(password ?? '', a.salt), 'hex')
      const stored = Buffer.from(a.hash, 'hex')
      if (attempt.length !== stored.length || !timingSafeEqual(attempt, stored)) {
        return { ok: false, error: '비밀번호가 올바르지 않습니다.' }
      }
      accounts = accounts.filter((x) => x.id !== id)
      for (const [tok, s] of sessions) if (s.accountId === id) sessions.delete(tok) // 모든 세션 무효화
      // 다른 사용자 홈에 이 사람이 남긴 방명록 글 제거(작성자 스냅샷이라 별도 정리 필요).
      for (const acc of accounts) {
        if (acc.guestbook?.some((e) => e.authorId === id)) {
          acc.guestbook = acc.guestbook.filter((e) => e.authorId !== id)
        }
      }
      // 영향받은 친구(친구·받은신청·보낸신청 상대) — relay 가 friend:update 로 그들 목록을 갱신.
      const affectedFriends = [...new Set([...(a.friends ?? []), ...(a.friendReqIn ?? []), ...(a.friendReqOut ?? [])])]
      purgeFromFriends(id) // 친구·신청 목록에서도 제거
      save()
      return { ok: true, accountId: id, affectedFriends }
    },

    getAccountById(id) {
      const a = accounts.find((x) => x.id === id)
      return a ? pub(a) : null
    },

    changePassword(token, current, next) {
      const id = accountIdForToken(token)
      if (!id) return { ok: false, error: '로그인이 필요합니다.' }
      const a = accounts.find((x) => x.id === id)
      if (!a) return { ok: false, error: '계정을 찾을 수 없습니다.' }
      // 현재 비밀번호 재확인(타이밍 세이프) — 토큰만으로는 부족(자리를 비운 사이 바꿔치기 방지).
      const attempt = Buffer.from(hashPassword(current ?? '', a.salt), 'hex')
      const stored = Buffer.from(a.hash, 'hex')
      if (attempt.length !== stored.length || !timingSafeEqual(attempt, stored)) {
        return { ok: false, error: '현재 비밀번호가 올바르지 않습니다.' }
      }
      const pw = typeof next === 'string' ? next : ''
      if (pw.length < 4) return { ok: false, error: '새 비밀번호는 4자 이상이어야 합니다.' }
      if (pw === current) return { ok: false, error: '지금 쓰는 비밀번호와 같습니다.' }
      // 소금(salt)도 새로 뽑는다 — 옛 해시로 만든 사전 계산이 새 비밀번호에 재사용되지 않게.
      a.salt = randomBytes(16).toString('hex')
      a.hash = hashPassword(pw, a.salt)
      // 지금 쓰는 세션만 남기고 나머지는 끊는다(다른 기기·다른 사람 로그아웃).
      for (const [tok, s] of sessions) if (s.accountId === id && tok !== token) sessions.delete(tok)
      save()
      return { ok: true, accountId: id }
    },

    transferAdmin(fromId, toId) {
      if (!toId || fromId === toId) return { ok: false, error: '자기 자신에게는 넘길 수 없습니다.' }
      const from = accounts.find((x) => x.id === fromId)
      const to = accounts.find((x) => x.id === toId)
      if (!from || from.role !== 'admin') return { ok: false, error: '관리자만 이양할 수 있습니다.' }
      if (!to) return { ok: false, error: '대상 계정을 찾을 수 없습니다.' }
      if (to.role === 'guest') {
        return { ok: false, error: '승인 대기(손님) 계정에는 넘길 수 없습니다. 먼저 멤버로 승인해 주세요.' }
      }
      to.role = 'admin'
      from.role = 'member'
      save()
      return { ok: true, from: pub(from), to: pub(to) }
    },

    setRole(targetId, role) {
      const a = accounts.find((x) => x.id === targetId)
      if (!a) return { ok: false, error: '대상 계정을 찾을 수 없습니다.' }
      if (a.role === 'admin') return { ok: false, error: '관리자 등급은 변경할 수 없습니다.' }
      if (role !== 'member' && role !== 'guest') return { ok: false, error: '허용되지 않는 등급입니다.' }
      a.role = role
      save()
      return { ok: true, account: pub(a) }
    },

    setUsername(targetId, newUsername) {
      const a = accounts.find((x) => x.id === targetId)
      if (!a) return { ok: false, error: '대상 계정을 찾을 수 없습니다.' }
      const name = (newUsername ?? '').trim().slice(0, 40)
      if (name.length < 2) return { ok: false, error: '아이디는 2자 이상이어야 합니다.' }
      // 다른 계정이 같은 아이디(정규화 비교)를 쓰면 거부 — 본인은 대소문자/공백만 바꾸는 것은 허용.
      if (accounts.some((x) => x.id !== targetId && normUser(x.username) === normUser(name))) {
        return { ok: false, error: '이미 사용 중인 아이디입니다.' }
      }
      a.username = name
      save()
      return { ok: true, account: pub(a) }
    },

    listForAdmin() {
      return accounts
        .map((a) => ({
          id: a.id,
          username: a.username,
          nickname: a.nickname,
          avatar: a.avatar,
          role: a.role,
          createdAt: a.createdAt,
          lastSeenAt: a.lastSeenAt
        }))
        .sort((x, y) => x.createdAt - y.createdAt)
    },

    touchSeen,

    usageForUser(userId) {
      const a = accounts.find((x) => x.id === userId)
      const refs = new Set<string>()
      if (!a) return { lobbyBytes: 0, profileBytes: 0, refs }
      // 로비 스냅샷(공개 꾸밈 — '로비 초기화'가 지우는 a.lobby)과 프로필(아바타·배너·소개·링크·방명록)을 분리한다.
      // 둘 다 자산 참조를 포함할 수 있어 refs 는 합쳐 수집(아바타·배너는 data URL 이라 바이트로 직접 잡힘).
      const lobbyJson = a.lobby ? JSON.stringify(a.lobby) : ''
      const profileJson = JSON.stringify({
        avatar: a.avatar,
        banner: a.banner,
        bio: a.bio,
        links: a.links,
        profileTheme: a.profileTheme,
        guestbook: a.guestbook
      })
      scanAssetRefs(lobbyJson, refs)
      scanAssetRefs(profileJson, refs)
      return {
        lobbyBytes: lobbyJson ? Buffer.byteLength(lobbyJson, 'utf8') : 0,
        profileBytes: Buffer.byteLength(profileJson, 'utf8'),
        refs
      }
    },

    adminClearLobby(userId) {
      const a = accounts.find((x) => x.id === userId)
      if (!a) return false
      if (a.lobby === undefined) return true // 이미 비어 있음 — 멱등
      a.lobby = undefined
      save()
      return true
    },

    deleteAccountById(userId) {
      const a = accounts.find((x) => x.id === userId)
      if (!a) return { ok: false, error: '대상 계정을 찾을 수 없습니다.' }
      if (a.role === 'admin') return { ok: false, error: '관리자 계정은 삭제할 수 없습니다.' }
      accounts = accounts.filter((x) => x.id !== userId)
      for (const [tok, s] of sessions) if (s.accountId === userId) sessions.delete(tok) // 세션 무효화
      // 다른 사용자 홈에 이 사람이 남긴 방명록 글 제거(작성자 스냅샷이라 별도 정리 필요).
      for (const acc of accounts) {
        if (acc.guestbook?.some((e) => e.authorId === userId)) {
          acc.guestbook = acc.guestbook.filter((e) => e.authorId !== userId)
        }
      }
      // 영향받은 친구(친구·받은신청·보낸신청 상대) — relay 가 friend:update 로 그들 목록을 갱신.
      const affectedFriends = [...new Set([...(a.friends ?? []), ...(a.friendReqIn ?? []), ...(a.friendReqOut ?? [])])]
      purgeFromFriends(userId) // 친구·신청 목록에서도 제거
      save()
      return { ok: true, accountId: userId, affectedFriends }
    },

    friendRequest(token, username) {
      const meId = accountIdForToken(token)
      if (!meId) return { ok: false, error: '로그인이 필요합니다.' }
      const me = accounts.find((x) => x.id === meId)
      const target = find(username ?? '')
      if (!me || !target) return { ok: false, error: '해당 아이디의 사용자를 찾을 수 없습니다.' }
      if (target.id === me.id) return { ok: false, error: '자기 자신에게는 신청할 수 없습니다.' }
      if ((me.friends ?? []).includes(target.id)) return { ok: false, error: '이미 친구입니다.' }
      if ((me.friends ?? []).length >= MAX_FRIENDS) return { ok: false, error: '친구 수가 한도에 도달했습니다.' }
      // 상대가 이미 나에게 신청해 둔 상태면 자동 수락.
      if ((me.friendReqIn ?? []).includes(target.id)) {
        // 자동수락도 상대(target) 친구 수 한도를 확인 — addFriend 가 양쪽에 추가하므로 한쪽만 검사하면 한도가 뚫린다.
        if ((target.friends ?? []).length >= MAX_FRIENDS) return { ok: false, error: '상대의 친구 수가 한도에 도달했습니다.' }
        addFriend(me, target)
        clearPending(me, target, target.id)
        save()
        return { ok: true, targetId: target.id, selfId: me.id, autoAccepted: true }
      }
      if ((me.friendReqOut ?? []).includes(target.id)) return { ok: false, error: '이미 신청을 보냈습니다.' }
      if ((me.friendReqOut ?? []).length >= MAX_FRIEND_REQ) return { ok: false, error: '보낸 친구 신청이 너무 많습니다.' }
      if ((target.friendReqIn ?? []).length >= MAX_FRIEND_REQ) return { ok: false, error: '상대의 받은 신청이 가득 찼습니다.' }
      me.friendReqOut = [...(me.friendReqOut ?? []), target.id]
      target.friendReqIn = [...(target.friendReqIn ?? []), me.id]
      save()
      return { ok: true, targetId: target.id, selfId: me.id, autoAccepted: false }
    },

    acceptFriend(token, requesterId) {
      const meId = accountIdForToken(token)
      if (!meId) return { ok: false, error: '로그인이 필요합니다.' }
      const me = accounts.find((x) => x.id === meId)
      const other = accounts.find((x) => x.id === requesterId)
      if (!me || !other) return { ok: false, error: '대상을 찾을 수 없습니다.' }
      if (!(me.friendReqIn ?? []).includes(requesterId)) return { ok: false, error: '받은 친구 신청이 없습니다.' }
      // 수락 시 양쪽 친구 수 한도 확인(addFriend 가 양쪽에 추가 — 한쪽만 보면 한도 우회).
      if ((me.friends ?? []).length >= MAX_FRIENDS) return { ok: false, error: '친구 수가 한도에 도달했습니다.' }
      if ((other.friends ?? []).length >= MAX_FRIENDS) return { ok: false, error: '상대의 친구 수가 한도에 도달했습니다.' }
      addFriend(me, other)
      clearPending(me, other, requesterId)
      save()
      return { ok: true, targetId: requesterId, selfId: me.id }
    },

    rejectFriend(token, otherId) {
      const meId = accountIdForToken(token)
      if (!meId) return { ok: false, error: '로그인이 필요합니다.' }
      const me = accounts.find((x) => x.id === meId)
      if (!me) return { ok: false, error: '계정을 찾을 수 없습니다.' }
      const other = accounts.find((x) => x.id === otherId)
      clearPending(me, other, otherId) // 받은·보낸 신청 모두 제거(멱등)
      save()
      return { ok: true, targetId: otherId, selfId: me.id }
    },

    removeFriend(token, userId) {
      const meId = accountIdForToken(token)
      if (!meId) return { ok: false, error: '로그인이 필요합니다.' }
      const me = accounts.find((x) => x.id === meId)
      if (!me) return { ok: false, error: '계정을 찾을 수 없습니다.' }
      const other = accounts.find((x) => x.id === userId)
      if (me.friends) me.friends = me.friends.filter((x) => x !== userId)
      if (other?.friends) other.friends = other.friends.filter((x) => x !== meId)
      clearPending(me, other, userId) // 혹시 남은 보류 신청도 정리
      save()
      return { ok: true, targetId: userId, selfId: me.id }
    },

    friendList(token) {
      const meId = accountIdForToken(token)
      if (!meId) return { ok: false, error: '로그인이 필요합니다.' }
      const me = accounts.find((x) => x.id === meId)
      if (!me) return { ok: false, error: '계정을 찾을 수 없습니다.' }
      const mapIds = (ids?: string[]): UserSummary[] =>
        (ids ?? []).map(summaryOf).filter((s): s is UserSummary => s !== null)
      return {
        ok: true,
        friends: mapIds(me.friends),
        incoming: mapIds(me.friendReqIn),
        outgoing: mapIds(me.friendReqOut)
      }
    },

    updateProfile(token, patch) {
      const id = accountIdForToken(token)
      if (!id) return { ok: false, error: '로그인이 필요합니다.' }
      const a = accounts.find((x) => x.id === id)
      if (!a) return { ok: false, error: '계정을 찾을 수 없습니다.' }
      if (typeof patch?.nickname === 'string') a.nickname = patch.nickname.trim().slice(0, 40) || undefined
      // avatar: 작은 WebP data URL. HTTP 본문 제한 고려해 900KB 상한. 빈 문자열=제거. data:image 만 허용(CSS 주입 차단).
      if (typeof patch?.avatar === 'string') a.avatar = patch.avatar ? dataImageUrl(patch.avatar, 900_000) : undefined
      if (typeof patch?.bio === 'string') a.bio = patch.bio.slice(0, 500) || undefined
      // banner: 헤더 이미지 WebP data URL. 아바타보다 크므로 1.2MB 상한. 빈 문자열=제거. data:image 만 허용.
      if (typeof patch?.banner === 'string') a.banner = patch.banner ? dataImageUrl(patch.banner, 1_200_000) : undefined
      if (Array.isArray(patch?.links)) a.links = sanitizeLinks(patch.links)
      if (patch?.profileTheme !== undefined) a.profileTheme = sanitizeTheme(patch.profileTheme)
      save()
      return { ok: true, account: pub(a) }
    },

    setStatus(accountId, status) {
      if (!['online', 'away', 'session', 'invisible'].includes(status)) return false
      const a = accounts.find((x) => x.id === accountId)
      if (!a) return false
      // 기본값(online)은 필드 자체를 지워 accounts.json 을 가볍게 유지.
      const next = status === 'online' ? undefined : status
      if (a.status === next) return true // 무변경이면 저장 생략 — 같은 상태 반복 emit 이 동기 전체쓰기를 유발하지 않게
      a.status = next
      save()
      return true
    },

    getStatus(accountId) {
      return accounts.find((x) => x.id === accountId)?.status
    },

    listUsers() {
      return accounts
        .map((a) => ({ id: a.id, username: a.username, nickname: a.nickname, avatar: a.avatar }))
        .sort((x, y) => (x.nickname || x.username).localeCompare(y.nickname || y.username))
    },

    getHome(userId) {
      const a = accounts.find((x) => x.id === userId)
      if (!a) return null
      return { account: pub(a), guestbook: a.guestbook ?? [] }
    },

    addGuestbookEntry(token, targetUserId, message) {
      const authorId = accountIdForToken(token)
      if (!authorId) return { ok: false, error: '로그인이 필요합니다.' }
      const author = accounts.find((x) => x.id === authorId)
      const target = accounts.find((x) => x.id === targetUserId)
      if (!author || !target) return { ok: false, error: '대상을 찾을 수 없습니다.' }
      const msg = (message ?? '').trim().slice(0, MAX_GUESTBOOK_MESSAGE)
      if (!msg) return { ok: false, error: '내용을 입력하세요.' }
      const entry: GuestbookEntry = {
        id: randomUUID(),
        authorId,
        authorName: author.nickname || author.username,
        authorAvatar: author.avatar,
        message: msg,
        createdAt: Date.now()
      }
      const list = [...(target.guestbook ?? []), entry]
      // 홈당 보관 상한 — 오래된 것부터 버림(메모리·파일 바운드).
      target.guestbook = list.length > MAX_GUESTBOOK_ENTRIES ? list.slice(list.length - MAX_GUESTBOOK_ENTRIES) : list
      save()
      return { ok: true, guestbook: target.guestbook }
    },

    removeGuestbookEntry(token, targetUserId, entryId) {
      const requesterId = accountIdForToken(token)
      if (!requesterId) return { ok: false, error: '로그인이 필요합니다.' }
      const target = accounts.find((x) => x.id === targetUserId)
      if (!target) return { ok: false, error: '대상을 찾을 수 없습니다.' }
      const list = target.guestbook ?? []
      const entry = list.find((e) => e.id === entryId)
      if (!entry) return { ok: true, guestbook: list } // 이미 없음 — 멱등
      // 홈 주인(대상=요청자) 또는 작성자만 삭제 가능.
      if (requesterId !== target.id && requesterId !== entry.authorId) {
        return { ok: false, error: '삭제 권한이 없습니다.' }
      }
      target.guestbook = list.filter((e) => e.id !== entryId)
      save()
      return { ok: true, guestbook: target.guestbook }
    },

    setLobby(token, snapshot, refCount) {
      const id = accountIdForToken(token)
      if (!id) return { ok: false, error: '로그인이 필요합니다.' }
      const a = accounts.find((x) => x.id === id)
      if (!a) return { ok: false, error: '계정을 찾을 수 없습니다.' }
      const clean = sanitizeLobby(snapshot)
      if (!clean) return { ok: false, error: '잘못된 로비 데이터입니다.' }
      // 그림이 통째로 빠진 사본이 왔다. 보낸 기기가 '그림을 가지고 있다'고 말하거나(읽지 못했을 뿐),
      // 아무 말도 하지 않으면(옛 프로그램이라 알 수 없다) 덮지 않는다.
      // 남의 화면에 보이던 로비가 한순간에 지워지는 사고는 되돌릴 방법이 없다.
      if (a.lobby && countLobbyImages(a.lobby) > 0 && countLobbyImages(clean) === 0 && refCount !== 0) {
        return { ok: false, error: '그림이 빠진 로비로 덮을 수 없습니다. 그림이 제대로 보이는 기기에서 보내 주세요.' }
      }
      a.lobby = clean
      save()
      return { ok: true }
    },

    getLobby(userId) {
      const a = accounts.find((x) => x.id === userId)
      return a?.lobby ?? null
    },

    collectAssetRefs(into) {
      scanAssetRefs(JSON.stringify(accounts), into)
    },

    accountCount() {
      return accounts.length
    },

    sessionCount() {
      sweepSessions()
      return sessions.size
    }
  }
}
