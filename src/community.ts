// 커뮤니티 — 서버 전역 하나의 커뮤니티(설정·역할·카테고리·게시판·멤버십·권한·명칭·테마·감사 로그).
// 글/댓글은 communityPost, 캐릭터는 communityChar 가 맡고, 이 파일은 그 둘이 기대는 '무엇을 할 수 있는가'를 정한다.
//
// 권한: 서버 계정 등급(auth 의 admin/member/guest)은 호스팅 용량 관리용 축이라 여기에 쓰지 않는다.
//   커뮤니티는 자체 역할·멤버십 테이블을 갖고, 판정은 effective() 하나로만 한다(우회 경로를 만들지 않기 위해).
// 자산: 참조는 전부 이 파일이 상주로 들고 있는 구조(설정·게시판 목록) 안에만 둔다.
//   지연 로드 파일에 참조가 숨으면 자산 GC 가 그것을 못 보고 이미지를 지운다.
import { readFileSync, writeFileSync, mkdirSync, renameSync, existsSync, appendFileSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { collectAssetRefs as scanAssetRefs } from './assets'

/** 서버 하나 = 커뮤니티 하나. 훗날 복수화해도 저장 경로가 그대로이도록 처음부터 세그먼트를 판다. */
export const MAIN_CID = 'main'

// ===== 한도(작은 서버 보호) =====
const MAX_CATEGORIES = 20
const MAX_BOARDS = 60
const MAX_ROLES = 12
const MAX_NAME = 40
const MAX_TAGLINE = 120
const MAX_DESC = 500
const MAX_PREFIXES = 20
const MAX_PREFIX = 20
const MAX_FORM_FIELDS = 40
const MAX_LABEL = 16
const MAX_NICK = 20
const MAX_REASON = 200
const MAX_AUDIT_DETAIL = 300
const MAX_APPLICATIONS = 500
const MAX_SUBS = 60

/** CSS 가 실제로 해석하는 길이만 — 3·4·6·8자리. 5·7자리는 값이 통째로 무시돼 색이 사라진다. */
const HEX_RE = /^#(?:[0-9a-fA-F]{3,4}|[0-9a-fA-F]{6}|[0-9a-fA-F]{8})$/
const ASSET_RE = /^asset:[a-f0-9]{64}$/

// ===== 권한 키 =====

/** 게시판 단위로 판정되는 권한(스코프 = boardId). */
export type BoardPerm =
  | 'board.read'
  | 'board.write'
  | 'board.edit'
  | 'board.comment'
  | 'board.attach'
  | 'board.secret'
  | 'board.notice'
  | 'board.pin'
  | 'board.editAny'
  | 'board.deleteAny'
  | 'board.blind'
  | 'board.move'
  | 'board.viewSecret'
  | 'board.viewAuthor'

/** 커뮤니티 전역 권한(스코프 = 커뮤니티). */
export type CommunityPerm =
  | 'cmty.manageBoards'
  | 'cmty.manageRoles'
  | 'cmty.manageMembers'
  | 'cmty.approveJoin'
  | 'cmty.sanction'
  | 'cmty.manageChars'
  | 'cmty.manageTheme'
  | 'cmty.manageLabels'
  | 'cmty.manageNotice'
  | 'cmty.handleReport'
  | 'cmty.viewAudit'
  | 'cmty.viewStats'
  | 'cmty.export'
  | 'cmty.manageItems'
  | 'cmty.grant'
  | 'cmty.viewLedger'
  | 'cmty.trade'
  | 'cmty.gift'
  | 'cmty.manageGames'

export type PermKey = BoardPerm | CommunityPerm
export type Grant = 'allow' | 'deny' | 'inherit'
export type PermPatch = Partial<Record<PermKey, Grant>>

/** 쓰기 계열 — 정지(mute) 중에 일괄 차단되는 권한. 읽기는 통과시킨다. */
const WRITE_PERMS: ReadonlySet<PermKey> = new Set<PermKey>([
  'board.write',
  'board.edit',
  'board.comment',
  'board.attach',
  'board.secret',
  'board.notice',
  'board.pin',
  // 선물은 사람 사이를 오가는 행위라 정지 대상에 든다. 상점·뽑기는 혼자 하는 일이라 두지 않는다.
  'cmty.gift'
])

/** 권한 정의 — 최종 기본값과 편집 UI 분류. danger 는 편집 시 한 번 더 확인받는 묶음. */
export interface PermDef {
  key: PermKey
  label: string
  group: string
  danger: boolean
  /** 아무 계층에서도 정해지지 않았을 때의 최종값. */
  def: boolean
}

export const BOARD_PERM_DEFS: PermDef[] = [
  { key: 'board.read', label: '읽기', group: '열람', danger: false, def: true },
  { key: 'board.write', label: '글쓰기', group: '작성', danger: false, def: true },
  { key: 'board.edit', label: '내 글 수정', group: '작성', danger: false, def: true },
  { key: 'board.comment', label: '댓글', group: '작성', danger: false, def: true },
  { key: 'board.attach', label: '이미지 첨부', group: '작성', danger: false, def: true },
  { key: 'board.secret', label: '비밀글·비밀댓글', group: '작성', danger: false, def: true },
  { key: 'board.notice', label: '공지 작성', group: '운영', danger: false, def: false },
  { key: 'board.pin', label: '상단 고정', group: '운영', danger: false, def: false },
  { key: 'board.editAny', label: '남의 글 수정', group: '운영', danger: true, def: false },
  { key: 'board.deleteAny', label: '남의 글 삭제', group: '운영', danger: true, def: false },
  { key: 'board.blind', label: '가림 처리', group: '운영', danger: true, def: false },
  { key: 'board.move', label: '게시판 간 이동', group: '운영', danger: false, def: false },
  { key: 'board.viewSecret', label: '비밀글 열람', group: '운영', danger: true, def: false },
  { key: 'board.viewAuthor', label: '익명 작성자 식별', group: '운영', danger: true, def: false }
]

export const CMTY_PERM_DEFS: PermDef[] = [
  { key: 'cmty.manageBoards', label: '게시판·카테고리 관리', group: '구성', danger: false, def: false },
  { key: 'cmty.manageRoles', label: '역할·권한 편집', group: '구성', danger: true, def: false },
  { key: 'cmty.manageMembers', label: '멤버 관리', group: '사람', danger: false, def: false },
  { key: 'cmty.approveJoin', label: '가입 심사', group: '사람', danger: false, def: false },
  { key: 'cmty.sanction', label: '제재', group: '사람', danger: true, def: false },
  { key: 'cmty.manageChars', label: '캐릭터 승인·양식', group: '사람', danger: false, def: false },
  { key: 'cmty.manageTheme', label: '테마', group: '꾸미기', danger: false, def: false },
  { key: 'cmty.manageLabels', label: '명칭', group: '꾸미기', danger: false, def: false },
  { key: 'cmty.manageNotice', label: '전역 공지', group: '운영', danger: false, def: false },
  { key: 'cmty.handleReport', label: '신고 처리', group: '운영', danger: false, def: false },
  { key: 'cmty.viewAudit', label: '기록 열람', group: '운영', danger: false, def: false },
  { key: 'cmty.viewStats', label: '활동 통계', group: '운영', danger: false, def: false },
  { key: 'cmty.export', label: '백업 내보내기', group: '운영', danger: true, def: false },
  { key: 'cmty.manageItems', label: '아이템·상점·뽑기 정의', group: '경제', danger: false, def: false },
  { key: 'cmty.manageGames', label: '퀘스트·조사 정의', group: '경제', danger: false, def: false },
  { key: 'cmty.grant', label: '지급·회수', group: '경제', danger: true, def: false },
  { key: 'cmty.viewLedger', label: '전체 거래 내역 열람', group: '경제', danger: false, def: false },
  // 아래 둘은 기본 허용 — 특정 인원에게만 끄기 위한 손잡이다.
  { key: 'cmty.trade', label: '상점·뽑기 이용', group: '경제', danger: false, def: true },
  { key: 'cmty.gift', label: '선물 주고받기', group: '경제', danger: false, def: true }
]

const PERM_DEF_BY_KEY = new Map<PermKey, PermDef>(
  [...BOARD_PERM_DEFS, ...CMTY_PERM_DEFS].map((d) => [d.key, d])
)
const IS_BOARD_PERM = new Set<string>(BOARD_PERM_DEFS.map((d) => d.key))

// ===== 엔티티 =====

export type BoardKind = 'general' | 'character' | 'roleplay' | 'log' | 'quest' | 'shop' | 'survey'
/** 실제로 만들 수 있는 종류. 스키마에만 있고 아직 화면이 없는 종류는 생성을 막는다. */
const CREATABLE_KINDS: ReadonlySet<BoardKind> = new Set<BoardKind>([
  'general',
  'character',
  'roleplay',
  'log',
  'quest',
  'shop',
  'survey'
])

export type ListStyle = 'row' | 'card' | 'grid' | 'inline'
export type Rating = 'all' | 'r15' | 'r19'

export type FieldType =
  | 'text'
  | 'longtext'
  | 'rich'
  | 'number'
  | 'select'
  | 'multiselect'
  | 'image'
  | 'gallery'
  | 'tags'
  | 'bgm'
  | 'check'
  | 'confirm'
  | 'divider'
const FIELD_TYPES: ReadonlySet<string> = new Set<FieldType>([
  'text', 'longtext', 'rich', 'number', 'select', 'multiselect',
  'image', 'gallery', 'tags', 'bgm', 'check', 'confirm', 'divider'
])

export interface FieldDef {
  key: string
  type: FieldType
  label: string
  required: boolean
  hint?: string
  max?: number
  options?: string[]
  /** 운영진에게만 보이는 칸(가입 신청서의 심사용 항목 등). */
  staffOnly?: boolean
  /** confirm 전용 — 이 문구와 정확히 일치해야 제출된다(공지 정독 확인). */
  answer?: string
  group?: string
  order: number
}

export interface Category {
  id: string
  name: string
  order: number
  collapsed: boolean
}

/**
 * 왼쪽 메뉴에 붙박이로 있는 자리들.
 * 이름·아이콘·순서는 관리자가 고치고 감출 수 있지만, 이 목록 자체는 코드가 가진다 —
 * 각 자리는 화면 하나와 짝이라 설정만으로 새로 만들어 낼 수 없다.
 */
export const MENU_BUILTINS = ['home', 'chars', 'inv', 'shop', 'gifts', 'quest', 'survey'] as const
export type MenuBuiltin = (typeof MENU_BUILTINS)[number]

export interface MenuItem {
  id: string
  /** 붙박이 자리면 그 이름, 관리자가 더한 바로가기면 빈 문자열. */
  builtin: string
  /** 비우면 그 자리의 기본 명칭(명칭 설정을 따라간다). */
  name: string
  /** 비우면 그 자리의 기본 아이콘. */
  icon: string
  hidden: boolean
  order: number
  /** 바로가기가 가리키는 게시판. 붙박이 자리에서는 쓰지 않는다. */
  boardId: string
}

export interface Board {
  id: string
  categoryId: string
  /** 생성 후 바꿀 수 없다 — 저장 형태가 종류에 묶여 있다. 표시 이름(name)은 언제든 자유. */
  kind: BoardKind
  name: string
  desc: string
  icon: string
  order: number
  /** 권한 없는 멤버에게는 목록에서조차 보이지 않는다(운영진 게시판). */
  hidden: boolean
  rolePerms: Record<string, PermPatch>
  prefixes: string[]
  form: FieldDef[]
  listStyle: ListStyle
  noticeMax: number
  anonymous: boolean
  rating: Rating
  createdAt: number
}

export interface AutoPromoteRule {
  fromRoleId: string
  minDays?: number
  minPosts?: number
  minComments?: number
  requireCharacter?: boolean
  /** 자동 승급은 되돌리는 비용이 커서 기본은 '대상자 알림'만 한다. */
  mode: 'suggest' | 'auto'
}

export interface CommunityRole {
  id: string
  name: string
  color: string
  /** 0 = 최상위. 자기보다 tier 가 큰 상대만 제재·편집할 수 있다(권력 집중 방지). */
  tier: number
  builtin: boolean
  perms: PermPatch
  autoRule?: AutoPromoteRule
}

export interface Sanction {
  kind: 'warn' | 'mute' | 'ban'
  reason: string
  /** 미지정 = 무기한. */
  until?: number
  byAccountId: string
  byTier: number
  at: number
}

export interface MemberStats {
  posts: number
  comments: number
  /** 내 글이 받은 댓글 수 — 편중(편파) 지표. 운영진만 본다. */
  received: number
  visits: number
  lastSeenAt: number
}

export interface CommunityMember {
  accountId: string
  roleId: string
  /** 커뮤니티 안에서 쓰는 표시명. 비면 계정 닉으로 폴백. */
  nick: string
  perms: PermPatch
  boardPerms: Record<string, PermPatch>
  sanction?: Sanction
  warns: number
  subs: string[]
  /** boardId → 마지막 열람 시각. 기기 간 일치를 위해 서버가 들고 있는다. */
  lastRead: Record<string, number>
  stats: MemberStats
  joinedAt: number
}

export interface JoinApplication {
  id: string
  accountId: string
  nick: string
  answers: Record<string, string>
  status: 'pending' | 'approved' | 'rejected'
  note: string
  decidedBy?: string
  decidedAt?: number
  createdAt: number
}

export type ThemeColorKey =
  | 'bg' | 'surface' | 'card' | 'raise' | 'pop'
  | 'line' | 'line2'
  | 'text' | 'text2' | 'text3'
  | 'accent' | 'accentText' | 'ok' | 'warn' | 'danger'
  | 'r1' | 'r2' | 'r3' | 'r4' | 'r5'

/** 색 슬롯 화이트리스트 — 자유 키를 받으면 일반 CSS 속성이 주입된다(배경 이미지로 외부 요청·문구 위조 등). */
export const THEME_COLOR_KEYS: ThemeColorKey[] = [
  'bg', 'surface', 'card', 'raise', 'pop',
  'line', 'line2',
  'text', 'text2', 'text3',
  'accent', 'accentText', 'ok', 'warn', 'danger',
  'r1', 'r2', 'r3', 'r4', 'r5'
]
const THEME_COLOR_SET = new Set<string>(THEME_COLOR_KEYS)

export type FontId = 'sans' | 'serif' | 'display'
const FONT_IDS: ReadonlySet<string> = new Set<FontId>(['sans', 'serif', 'display'])
export type BorderStyle = 'solid' | 'soft' | 'glow' | 'none'
const BORDER_STYLES: ReadonlySet<string> = new Set<BorderStyle>(['solid', 'soft', 'glow', 'none'])
export type MotionLevel = 'off' | 'subtle' | 'full'
const MOTION_LEVELS: ReadonlySet<string> = new Set<MotionLevel>(['off', 'subtle', 'full'])
export type BgMode = 'cover' | 'tile' | 'fixed'
const BG_MODES: ReadonlySet<string> = new Set<BgMode>(['cover', 'tile', 'fixed'])

export interface CommunityTheme {
  preset: string
  colors: Partial<Record<ThemeColorKey, string>>
  rarityNames: string[]
  bg?: { assetRef?: string; mode: BgMode; overlay?: string; overlayAlpha: number; blur: number }
  header?: { bannerRef?: string; logoRef?: string; height: number; showTitle: boolean }
  font?: { head: FontId; body: FontId; size: number }
  shape?: { radius: number; border: number; borderStyle: BorderStyle; shadow: 0 | 1 | 2 | 3 }
  motion?: MotionLevel
}

export type LabelKey =
  | 'community' | 'currency' | 'character' | 'inventory' | 'wardrobe' | 'gift'
  | 'quest' | 'explore' | 'shop' | 'gacha' | 'item'
  | 'stamina' | 'member' | 'staff' | 'owner'

export const DEFAULT_LABELS: Record<LabelKey, string> = {
  community: '커뮤니티',
  currency: 'G',
  character: '캐릭터',
  inventory: '소지품',
  wardrobe: '옷장',
  gift: '선물',
  quest: '퀘스트',
  explore: '조사',
  shop: '상점',
  gacha: '뽑기',
  item: '아이템',
  stamina: '체력',
  member: '멤버',
  staff: '스탭',
  owner: '관리자'
}
const LABEL_KEYS = new Set<string>(Object.keys(DEFAULT_LABELS))

export type Stage = 'prep' | 'open' | 'closed'
export type JoinMode = 'open' | 'approval' | 'invite'

/**
 * 커뮤니티 성격.
 * basic — 게시판 중심의 보통 커뮤니티. 캐릭터·경제·퀘스트·조사 쪽 길을 아예 내주지 않는다.
 * oc    — 캐릭터를 만들어 활동하는 커뮤니티(경제·놀이 포함). 자료 구조와 저장분은 그대로 두되
 *         지금은 새로 열 수 없다 — 화면과 라우트가 basic 만 내준다.
 */
export type CommunityMode = 'basic' | 'oc'

/** 경제 운영값 — 관리자가 커뮤 성격에 맞춰 조절한다. 0 은 대체로 '그 유입구를 끈다'는 뜻이다. */
export interface EconSettings {
  /** 캐릭터가 승인되는 그 순간 한 번만 들어가는 초기 자금. */
  initialG: number
  /** 소지품 기본 칸 수. 캐릭터별 추가분은 여기에 더해진다. */
  invCapBase: number
  /** 출석 보상(하루 1회). */
  dailyG: number
  /** 글 한 건 / 댓글 한 건당 자동 정산액. */
  postG: number
  commentG: number
  /** 자동 정산의 하루 상한 — 도배로 화폐를 찍어내는 길을 막는다. */
  dailyCapG: number
  /** 되팔기 허용. 아이템에 되팔기 값이 있어도 이게 꺼져 있으면 팔 수 없다. */
  sellBack: boolean
  /** 자동 정산을 받을 대표 캐릭터를 아직 정하지 않은 사람에게 안내를 띄울지. */
  payoutOn: boolean
}

export const DEFAULT_ECON: EconSettings = {
  initialG: 1000,
  invCapBase: 30,
  dailyG: 100,
  postG: 20,
  commentG: 5,
  dailyCapG: 300,
  sellBack: true,
  payoutOn: true
}

export interface CommunitySettings {
  cid: string
  /** 커뮤니티 성격 — 열 때 정해진다. basic 이면 캐릭터·경제·놀이 기능이 전부 닫힌다. */
  mode: CommunityMode
  name: string
  tagline: string
  logo: string
  stage: Stage
  joinMode: JoinMode
  applyForm: FieldDef[]
  econ: EconSettings
  theme: CommunityTheme
  labels: Partial<Record<LabelKey, string>>
  roles: CommunityRole[]
  categories: Category[]
  boards: Board[]
  /** 왼쪽 메뉴 구성. 붙박이 자리는 언제나 다 들어 있고, 감춘 것은 hidden 으로 남는다. */
  menu: MenuItem[]
  /** 역할·오버라이드·제재가 바뀔 때마다 오른다. 클라가 들고 있는 권한 스냅샷을 무효화하는 신호. */
  permVersion: number
  /** 백업 복원 등으로 세대가 바뀌었음을 알리는 값(진행 중 판정 무효화에 쓴다). */
  epoch: number
  ownerId: string
  createdAt: number
  updatedAt: number
}

export interface AuditEntry {
  id: string
  at: number
  actorId: string
  actorName: string
  /** 앱 관리자 자격으로 통과한 행위인지 — 역할을 받지 않은 서버 주인의 개입을 구분한다. */
  asAdmin?: boolean
  action: string
  targetType?: string
  targetId?: string
  targetName?: string
  detail?: string
}

/** 권한 판정에 필요한 문맥. account 는 서버 계정, member 는 커뮤니티 멤버십(비멤버면 null). */
export interface PermCtx {
  accountId: string
  isAppAdmin: boolean
  member: CommunityMember | null
  board?: Board | null
  now: number
}

export type Result<T> = { ok: true; value: T } | { ok: false; error: string }

// ===== 입력 정규화 =====

/**
 * 제어문자 제거 — 표시를 깨거나 기록을 위조하는 데 쓰이므로 사용자 입력에서 걷어낸다.
 * keepBreaks 면 줄바꿈·탭만 남긴다. 정규식에 제어문자를 넣지 않도록 코드포인트로 거른다.
 */
export function stripControl(s: string, keepBreaks: boolean): string {
  let out = ''
  for (const ch of s) {
    const c = ch.codePointAt(0) ?? 0
    if (c === 0x7f) continue
    if (c < 0x20 && !(keepBreaks && (c === 0x09 || c === 0x0a))) continue
    out += ch
  }
  return out
}

/** 한 줄 값 — 줄바꿈까지 포함해 제어문자를 전부 걷어낸다. */
function str(v: unknown, max: number): string {
  return typeof v === 'string' ? stripControl(v, false).trim().slice(0, max) : ''
}
/** 여러 줄 값 — 줄바꿈·탭만 남긴다. */
function multiline(v: unknown, max: number): string {
  return typeof v === 'string' ? stripControl(v, true).trim().slice(0, max) : ''
}
function num(v: unknown, lo: number, hi: number, def: number): number {
  if (typeof v !== 'number' || !Number.isFinite(v)) return def
  return Math.min(hi, Math.max(lo, Math.round(v)))
}
function bool(v: unknown, def = false): boolean {
  return typeof v === 'boolean' ? v : def
}
function hex(v: unknown): string {
  return typeof v === 'string' && HEX_RE.test(v.trim()) ? v.trim() : ''
}
function assetRef(v: unknown): string {
  return typeof v === 'string' && ASSET_RE.test(v.trim()) ? v.trim() : ''
}
function id(): string {
  return randomUUID()
}
/** 파일명으로 쓰이는 id 인지 — 경로 조립 전에 반드시 통과시킨다(경로 탈출 차단). */
export function isEntityId(v: unknown): v is string {
  return typeof v === 'string' && /^[0-9a-f-]{36}$/.test(v)
}

function normPatch(v: unknown): PermPatch {
  const out: PermPatch = {}
  if (!v || typeof v !== 'object') return out
  for (const [k, g] of Object.entries(v as Record<string, unknown>)) {
    if (!PERM_DEF_BY_KEY.has(k as PermKey)) continue
    if (g === 'allow' || g === 'deny') out[k as PermKey] = g
    // 'inherit' 는 '값 없음'과 같은 뜻이라 저장하지 않는다(패치를 비워 두는 것이 정상 상태).
  }
  return out
}

function normFormFields(v: unknown): FieldDef[] {
  if (!Array.isArray(v)) return []
  const out: FieldDef[] = []
  const seen = new Set<string>()
  for (const raw of v.slice(0, MAX_FORM_FIELDS)) {
    if (!raw || typeof raw !== 'object') continue
    const r = raw as Record<string, unknown>
    const type = typeof r.type === 'string' && FIELD_TYPES.has(r.type) ? (r.type as FieldType) : null
    if (!type) continue
    const key = str(r.key, 40).replace(/[^\w.-]/g, '') || `f${out.length}`
    if (seen.has(key)) continue
    seen.add(key)
    const options = Array.isArray(r.options)
      ? r.options.map((o) => str(o, 60)).filter(Boolean).slice(0, 40)
      : undefined
    out.push({
      key,
      type,
      label: str(r.label, MAX_NAME) || key,
      required: bool(r.required),
      ...(str(r.hint, 200) ? { hint: str(r.hint, 200) } : {}),
      ...(typeof r.max === 'number' ? { max: num(r.max, 1, 100_000, 1000) } : {}),
      ...(options && options.length ? { options } : {}),
      ...(bool(r.staffOnly) ? { staffOnly: true } : {}),
      ...(type === 'confirm' && str(r.answer, 200) ? { answer: str(r.answer, 200) } : {}),
      ...(str(r.group, MAX_NAME) ? { group: str(r.group, MAX_NAME) } : {}),
      order: num(r.order, 0, 999, out.length)
    })
  }
  return out.sort((a, b) => a.order - b.order)
}

/**
 * 테마 정규화 — 키는 화이트리스트, 값은 hex·정수·열거형만. 자유 문자열 슬롯을 하나도 두지 않는다.
 * 이 값은 관리자 한 명이 정해 전원 화면에 들어가므로, 여기가 유일한 검사 지점이다.
 */
export function normTheme(v: unknown): CommunityTheme {
  const r = (v && typeof v === 'object' ? v : {}) as Record<string, unknown>
  const colors: Partial<Record<ThemeColorKey, string>> = {}
  if (r.colors && typeof r.colors === 'object') {
    for (const [k, val] of Object.entries(r.colors as Record<string, unknown>)) {
      if (!THEME_COLOR_SET.has(k)) continue
      const c = hex(val)
      // 값이 없으면 키를 넣지 않는다 — 클라가 프로퍼티를 아예 세팅하지 않아 기본 팔레트가 살아남는다.
      if (c) colors[k as ThemeColorKey] = c
    }
  }
  const rarityNames = Array.isArray(r.rarityNames)
    ? r.rarityNames.slice(0, 5).map((n) => str(n, MAX_LABEL))
    : []
  const out: CommunityTheme = {
    preset: str(r.preset, 40),
    colors,
    rarityNames: rarityNames.length === 5 ? rarityNames : []
  }
  const bgRaw = r.bg as Record<string, unknown> | undefined
  if (bgRaw && typeof bgRaw === 'object') {
    const ref = assetRef(bgRaw.assetRef)
    out.bg = {
      ...(ref ? { assetRef: ref } : {}),
      mode: typeof bgRaw.mode === 'string' && BG_MODES.has(bgRaw.mode) ? (bgRaw.mode as BgMode) : 'cover',
      ...(hex(bgRaw.overlay) ? { overlay: hex(bgRaw.overlay) } : {}),
      // 배경 이미지 위 글자가 읽히지 않는 사고를 막기 위해 하한을 강제한다.
      overlayAlpha: ref ? num(bgRaw.overlayAlpha, 35, 100, 45) / 100 : num(bgRaw.overlayAlpha, 0, 100, 0) / 100,
      blur: num(bgRaw.blur, 0, 20, 0)
    }
  }
  const hd = r.header as Record<string, unknown> | undefined
  if (hd && typeof hd === 'object') {
    const banner = assetRef(hd.bannerRef)
    const logo = assetRef(hd.logoRef)
    out.header = {
      ...(banner ? { bannerRef: banner } : {}),
      ...(logo ? { logoRef: logo } : {}),
      height: num(hd.height, 120, 320, 160),
      showTitle: bool(hd.showTitle, true)
    }
  }
  const fo = r.font as Record<string, unknown> | undefined
  if (fo && typeof fo === 'object') {
    out.font = {
      head: typeof fo.head === 'string' && FONT_IDS.has(fo.head) ? (fo.head as FontId) : 'sans',
      body: typeof fo.body === 'string' && FONT_IDS.has(fo.body) ? (fo.body as FontId) : 'sans',
      size: num(fo.size, 14, 17, 15)
    }
  }
  const sh = r.shape as Record<string, unknown> | undefined
  if (sh && typeof sh === 'object') {
    out.shape = {
      radius: num(sh.radius, 0, 20, 12),
      border: num(sh.border, 0, 2, 1),
      borderStyle:
        typeof sh.borderStyle === 'string' && BORDER_STYLES.has(sh.borderStyle) ? (sh.borderStyle as BorderStyle) : 'solid',
      shadow: num(sh.shadow, 0, 3, 1) as 0 | 1 | 2 | 3
    }
  }
  if (typeof r.motion === 'string' && MOTION_LEVELS.has(r.motion)) out.motion = r.motion as MotionLevel
  return out
}

function normEcon(v: unknown): EconSettings {
  const r = (v && typeof v === 'object' ? v : {}) as Record<string, unknown>
  return {
    initialG: num(r.initialG, 0, 1_000_000, DEFAULT_ECON.initialG),
    // 칸 수를 줄여도 이미 든 물건은 지우지 않는다(초과분은 잠금 표시) — 값 자체는 자유롭게 둔다.
    invCapBase: num(r.invCapBase, 1, 200, DEFAULT_ECON.invCapBase),
    dailyG: num(r.dailyG, 0, 100_000, DEFAULT_ECON.dailyG),
    postG: num(r.postG, 0, 10_000, DEFAULT_ECON.postG),
    commentG: num(r.commentG, 0, 10_000, DEFAULT_ECON.commentG),
    dailyCapG: num(r.dailyCapG, 0, 1_000_000, DEFAULT_ECON.dailyCapG),
    sellBack: bool(r.sellBack, DEFAULT_ECON.sellBack),
    payoutOn: bool(r.payoutOn, DEFAULT_ECON.payoutOn)
  }
}

function normLabels(v: unknown): Partial<Record<LabelKey, string>> {
  const out: Partial<Record<LabelKey, string>> = {}
  if (!v || typeof v !== 'object') return out
  for (const [k, val] of Object.entries(v as Record<string, unknown>)) {
    if (!LABEL_KEYS.has(k)) continue
    const s = str(val, MAX_LABEL)
    // 빈 값 = 기본값 복귀. 저장하지 않는다.
    if (s) out[k as LabelKey] = s
  }
  return out
}

/** 미설정 라벨은 기본값으로 채워 반환한다 — 화면에서 undefined 가 나오지 않게. */
export function resolveLabels(dict: Partial<Record<LabelKey, string>>): Record<LabelKey, string> {
  return { ...DEFAULT_LABELS, ...dict }
}

const MAX_MENU = 40

/**
 * 왼쪽 메뉴 정규화.
 * 붙박이 자리는 저장된 것이 무엇이든 전부 살아남는다 — 저장본에 없으면(옛 버전에서 온 설정이거나
 * 클라가 빠뜨렸거나) 뒤에 붙여 준다. 그러지 않으면 판을 새로 짜다 실수로 홈이 사라진다.
 */
export function normMenu(v: unknown, boardIds: Set<string>): MenuItem[] {
  const out: MenuItem[] = []
  const seenBuiltin = new Set<string>()
  const seenId = new Set<string>()
  const raw = Array.isArray(v) ? v.slice(0, MAX_MENU) : []
  for (const item of raw) {
    const r = (item ?? {}) as Record<string, unknown>
    const builtin = typeof r.builtin === 'string' && (MENU_BUILTINS as readonly string[]).includes(r.builtin) ? r.builtin : ''
    if (builtin) {
      if (seenBuiltin.has(builtin)) continue
      seenBuiltin.add(builtin)
    }
    const boardId = !builtin && typeof r.boardId === 'string' && boardIds.has(r.boardId) ? r.boardId : ''
    // 붙박이도 아니고 갈 게시판도 없는 항목은 눌러도 갈 곳이 없다.
    if (!builtin && !boardId) continue
    const mid = builtin || (isEntityId(r.id) ? (r.id as string) : id())
    if (seenId.has(mid)) continue
    seenId.add(mid)
    out.push({
      id: mid,
      builtin,
      name: str(r.name, MAX_NAME),
      icon: str(r.icon, 40),
      hidden: bool(r.hidden),
      order: out.length,
      boardId
    })
  }
  for (const b of MENU_BUILTINS) {
    if (seenBuiltin.has(b)) continue
    out.push({ id: b, builtin: b, name: '', icon: '', hidden: false, order: out.length, boardId: '' })
  }
  return out
}

// ===== 기본 구성 =====

function defaultRoles(): CommunityRole[] {
  return [
    { id: 'owner', name: '관리자', color: '#f0a63c', tier: 0, builtin: true, perms: {} },
    {
      id: 'staff',
      name: '스탭',
      color: '#b57cf0',
      tier: 1,
      builtin: true,
      perms: {
        'cmty.manageBoards': 'allow',
        'cmty.manageMembers': 'allow',
        'cmty.approveJoin': 'allow',
        'cmty.sanction': 'allow',
        'cmty.manageChars': 'allow',
        'cmty.manageNotice': 'allow',
        'cmty.handleReport': 'allow',
        'cmty.viewStats': 'allow',
        'board.notice': 'allow',
        'board.pin': 'allow',
        'board.deleteAny': 'allow',
        'board.blind': 'allow',
        'board.move': 'allow',
        'board.viewSecret': 'allow'
      }
    },
    { id: 'member', name: '멤버', color: '#5fd18a', tier: 5, builtin: true, perms: {} },
    {
      id: 'pending',
      name: '승인대기',
      color: '#9aa3b0',
      tier: 9,
      builtin: true,
      // 심사 중에는 공지만 읽을 수 있다(공지 정독이 신청서 확인문구의 전제).
      perms: { 'board.write': 'deny', 'board.comment': 'deny', 'board.attach': 'deny', 'board.secret': 'deny' }
    }
  ]
}

/** 게시판 종류별 기본 글양식 — 관리자가 그대로 쓰거나 칸을 더한다. */
function defaultForm(kind: BoardKind): FieldDef[] {
  if (kind === 'character') {
    return [
      { key: 'fullBody', type: 'image', label: '전신', required: true, order: 0 },
      { key: 'oneLine', type: 'text', label: '한 줄 소개', required: false, max: 80, order: 1 },
      { key: 'age', type: 'text', label: '나이', required: false, max: 20, order: 2 },
      { key: 'gender', type: 'text', label: '성별', required: false, max: 20, order: 3 },
      { key: 'belong', type: 'text', label: '소속', required: false, max: 40, order: 4 },
      { key: 'look', type: 'longtext', label: '외관', required: false, max: 2000, order: 5 },
      { key: 'personality', type: 'longtext', label: '성격', required: false, max: 2000, order: 6 },
      { key: 'likes', type: 'text', label: '좋아하는 것', required: false, max: 200, order: 7 },
      { key: 'hates', type: 'text', label: '싫어하는 것', required: false, max: 200, order: 8 },
      { key: 'body', type: 'rich', label: '자유 서술', required: false, order: 9 },
      { key: 'bgm', type: 'bgm', label: '배경음악', required: false, order: 10 }
    ]
  }
  if (kind === 'log') {
    return [
      { key: 'gallery', type: 'gallery', label: '이미지', required: true, order: 0 },
      { key: 'body', type: 'rich', label: '설명', required: false, order: 1 },
      { key: 'cast', type: 'tags', label: '등장 캐릭터', required: false, order: 2 },
      { key: 'bgm', type: 'bgm', label: '배경음악', required: false, order: 3 }
    ]
  }
  if (kind === 'roleplay') {
    return [
      { key: 'body', type: 'rich', label: '본문', required: true, order: 0 },
      { key: 'cast', type: 'tags', label: '참여 캐릭터', required: false, order: 1 }
    ]
  }
  return [{ key: 'body', type: 'rich', label: '본문', required: true, order: 0 }]
}

function defaultListStyle(kind: BoardKind): ListStyle {
  return kind === 'character' ? 'card' : kind === 'log' ? 'grid' : kind === 'roleplay' ? 'card' : 'row'
}

function makeBoard(categoryId: string, kind: BoardKind, name: string, order: number, now: number, extra?: Partial<Board>): Board {
  return {
    id: id(),
    categoryId,
    kind,
    name,
    desc: '',
    icon: '',
    order,
    hidden: false,
    rolePerms: {},
    prefixes: [],
    form: defaultForm(kind),
    listStyle: defaultListStyle(kind),
    noticeMax: 3,
    anonymous: false,
    rating: 'all',
    createdAt: now,
    ...extra
  }
}

function defaultTheme(): CommunityTheme {
  return { preset: '바이올렛 골드', colors: {}, rarityNames: [] }
}

// ===== 저장소 =====

export interface CommunityStore {
  /**
   * 이 서버에서 커뮤니티 기능을 쓰는가. 서버 주인이 끄면 아무도 못 쓴다.
   * 커뮤니티를 만들기 전에도 값이 있어야 해서 설정과 따로 둔다.
   */
  enabled(): boolean
  setEnabled(v: boolean): void
  /** 커뮤니티가 아직 없으면 null. */
  settings(): CommunitySettings | null
  /** 없으면 만든다(앱 관리자가 처음 들어왔을 때). 이미 있으면 그대로 반환. */
  ensure(ownerId: string, now: number, mode?: CommunityMode): CommunitySettings
  member(accountId: string): CommunityMember | null
  members(): CommunityMember[]
  role(roleId: string): CommunityRole | null
  board(boardId: string): Board | null
  boards(): Board[]

  /** 유효 권한 — 커뮤니티 코드의 유일한 판정 경로. */
  can(perm: PermKey, ctx: PermCtx): boolean
  /** 클라 화면용 권한 스냅샷(버튼 숨김에만 쓰고 서버는 신뢰하지 않는다). */
  permSnapshot(ctx: Omit<PermCtx, 'board'>): { cmty: Record<string, boolean>; boards: Record<string, Record<string, boolean>> }
  /** 이 사람에게 보이는 게시판만(숨김 게시판은 존재 자체를 지운다). */
  visibleBoards(ctx: Omit<PermCtx, 'board'>): Board[]

  join(accountId: string, nick: string, answers: Record<string, unknown>, now: number): Result<{ member: CommunityMember | null; application: JoinApplication | null }>
  applications(): JoinApplication[]
  decideApplication(actorId: string, appId: string, approve: boolean, note: string, now: number): Result<CommunityMember | null>
  setRole(actorId: string, actorTier: number, accountId: string, roleId: string, now: number): Result<CommunityMember>
  setMemberPerms(accountId: string, perms: unknown, boardPerms: unknown): Result<CommunityMember>
  sanction(actorId: string, actorTier: number, accountId: string, input: unknown, now: number): Result<CommunityMember>
  clearSanction(actorTier: number, accountId: string): Result<CommunityMember>
  leave(accountId: string): void

  /** 커뮤니티 성격 전환(서버 주인 전용 — 검증은 라우트). 자료는 그대로 두고 화면·라우트 구성만 갈아탄다. */
  setMode(mode: unknown, now: number): Result<CommunitySettings>
  saveSettings(input: unknown, now: number): Result<CommunitySettings>
  saveTree(input: unknown, now: number): Result<CommunitySettings>
  saveTheme(theme: unknown, now: number): Result<CommunityTheme>
  saveLabels(labels: unknown, now: number): Result<Partial<Record<LabelKey, string>>>
  saveRoles(roles: unknown, now: number): Result<CommunityRole[]>

  /** 게시판 삭제 — 글 처리 방식을 반드시 정해서 부른다. 즉시 지우지 않고 감춘 뒤 유예를 둔다. */
  removeBoard(boardId: string, now: number): Result<Board>
  /** 활동 통계 갱신(고빈도 — 메모리 즉시, 저장은 트레일링). */
  bumpStat(accountId: string, field: keyof MemberStats, delta: number, now: number): void
  markRead(accountId: string, boardId: string, now: number): void
  toggleSub(accountId: string, boardId: string): Result<string[]>
  /** 이 게시판을 구독 중인 계정(새 글 알림 대상). */
  subscribers(boardId: string, exceptId: string): string[]

  audit(entry: Omit<AuditEntry, 'id' | 'at'>, now: number): void
  auditList(limit: number, before?: number): AuditEntry[]

  collectAssetRefs(into: Set<string>): void
  removeAll(accountId: string): void
  usageFor(accountId: string): { bytes: number; refs: Set<string> }
  exportFor(accountId: string): unknown
  importFor(accountId: string, data: unknown, now: number): void
  /** 서버 관리 화면의 요약 카드용. */
  usage(): { members: number; boards: number; bytes: number }
  flush(): void
}

export function createCommunityStore(opts?: { dataDir?: string; persist?: boolean }): CommunityStore {
  const persist = opts?.persist !== false
  const root = join(opts?.dataDir ?? join(process.cwd(), 'data'), 'community', MAIN_CID)
  const settingsPath = join(root, 'community.json')
  const featurePath = join(root, 'feature.json')
  const membersPath = join(root, 'members.json')
  const appsPath = join(root, 'applications.json')
  const auditDir = join(root, 'audit')

  let settings: CommunitySettings | null = null
  /**
   * 끔이 기본이다. 커뮤니티는 서버 주인이 뜻을 갖고 여는 기능이지, 세션만 쓰려는 서버에까지
   * 얹힐 것이 아니다. 이미 커뮤니티를 만들어 둔 서버는 아래 로드에서 켬으로 본다.
   */
  let featureOn = false
  let members: Record<string, CommunityMember> = {}
  let apps: JoinApplication[] = []
  /** 최근 감사 항목(화면 조회용 캐시). 파일이 진실이고 이건 사본이다. */
  let auditCache: AuditEntry[] = []

  let membersDirty = false
  let membersTimer: NodeJS.Timeout | null = null

  if (persist) {
    try {
      if (existsSync(settingsPath)) settings = normSettingsFile(JSON.parse(readFileSync(settingsPath, 'utf8')))
      if (existsSync(featurePath)) {
        const d = JSON.parse(readFileSync(featurePath, 'utf8')) as Record<string, unknown>
        featureOn = !d || d.enabled !== false
      } else if (settings) {
        // 이미 커뮤니티를 열어 쓰던 서버 — 새 기본값(끔)에 휩쓸려 갑자기 사라지면 안 된다.
        featureOn = true
      }
      if (existsSync(membersPath)) {
        const d = JSON.parse(readFileSync(membersPath, 'utf8')) as Record<string, unknown>
        if (d && typeof d === 'object') members = d as Record<string, CommunityMember>
      }
      if (existsSync(appsPath)) {
        const d = JSON.parse(readFileSync(appsPath, 'utf8'))
        if (Array.isArray(d)) apps = d as JoinApplication[]
      }
      auditCache = loadRecentAudit()
    } catch (e) {
      console.error('[community] 로드 실패 — 빈 상태로 시작:', e)
    }
  }

  /** 저장된 설정을 현재 스키마로 맞춘다(필드가 늘어난 버전에서 읽어도 깨지지 않게). */
  function normSettingsFile(d: unknown): CommunitySettings | null {
    if (!d || typeof d !== 'object') return null
    const r = d as Record<string, unknown>
    if (typeof r.cid !== 'string') return null
    const boards = Array.isArray(r.boards) ? (r.boards as Board[]) : []
    // 성격 값이 없는 저장분 = 이 값이 생기기 전의 판. 그 시절 개설은 캐릭터·역극·로그 게시판을 반드시
    // 심었으므로 그 흔적이 있으면 캐릭터 커뮤니티로 본다 — 보통으로 접으면 승인·지갑·파견이 전부 잠긴다.
    const mode: CommunityMode =
      r.mode === 'oc' || r.mode === 'basic'
        ? r.mode
        : boards.some((b) => b && b.kind !== 'general')
          ? 'oc'
          : 'basic'
    const roles = Array.isArray(r.roles) && r.roles.length ? (r.roles as CommunityRole[]) : defaultRoles()
    // 기본 등급 이름이 몇 차례 바뀌었다. 관리자가 직접 고친 이름은 건드리지 않고,
    // 우리가 붙여 준 옛 기본값 그대로인 것만 새 이름으로 옮긴다.
    for (const role of roles) {
      if (role.id === 'owner' && role.builtin && role.name === '총괄') role.name = '관리자'
      if (role.id === 'member' && role.builtin && role.name === '러너') role.name = '멤버'
      if (role.id === 'pending' && role.builtin && role.name === '가입 대기') role.name = '승인대기'
    }
    return {
      cid: MAIN_CID,
      mode,
      name: str(r.name, MAX_NAME) || '커뮤니티',
      tagline: str(r.tagline, MAX_TAGLINE),
      logo: assetRef(r.logo),
      stage: r.stage === 'open' || r.stage === 'closed' ? r.stage : 'prep',
      joinMode: r.joinMode === 'approval' || r.joinMode === 'invite' ? r.joinMode : 'open',
      applyForm: normFormFields(r.applyForm),
      econ: normEcon(r.econ),
      theme: normTheme(r.theme),
      labels: normLabels(r.labels),
      roles,
      categories: Array.isArray(r.categories) ? (r.categories as Category[]) : [],
      boards,
      menu: normMenu(r.menu, new Set(boards.map((b) => b.id))),
      permVersion: num(r.permVersion, 0, Number.MAX_SAFE_INTEGER, 1),
      epoch: num(r.epoch, 0, Number.MAX_SAFE_INTEGER, 1),
      ownerId: typeof r.ownerId === 'string' ? r.ownerId : '',
      createdAt: num(r.createdAt, 0, Number.MAX_SAFE_INTEGER, 0),
      updatedAt: num(r.updatedAt, 0, Number.MAX_SAFE_INTEGER, 0)
    }
  }

  function writeAtomic(path: string, data: string): void {
    if (!persist) return
    try {
      mkdirSync(root, { recursive: true })
      const tmp = path + '.tmp'
      writeFileSync(tmp, data, 'utf8')
      renameSync(tmp, path)
    } catch (e) {
      console.error('[community] 저장 실패:', path, e)
    }
  }

  function saveSettingsFile(): void {
    if (settings) writeAtomic(settingsPath, JSON.stringify(settings))
  }
  function saveMembersFile(): void {
    membersDirty = false
    writeAtomic(membersPath, JSON.stringify(members))
  }
  function saveAppsFile(): void {
    writeAtomic(appsPath, JSON.stringify(apps))
  }

  /**
   * 멤버 파일은 활동 통계 때문에 갱신이 잦다. 메모리는 즉시 바꾸고 디스크는 뭉쳐서 한 번만 쓴다
   * (계정 접속시각 저장과 같은 방식) — 방문 한 번에 전체 파일을 다시 쓰는 것을 막는다.
   */
  function touchMembers(immediate = false): void {
    if (!persist) return
    if (immediate) {
      if (membersTimer) {
        clearTimeout(membersTimer)
        membersTimer = null
      }
      saveMembersFile()
      return
    }
    membersDirty = true
    if (membersTimer) return
    membersTimer = setTimeout(() => {
      membersTimer = null
      if (membersDirty) saveMembersFile()
    }, 60_000)
    membersTimer.unref?.()
  }

  function auditFile(now: number): string {
    const d = new Date(now)
    const ym = `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`
    return join(auditDir, `${ym}.jsonl`)
  }

  /** 최근 월 파일 두 개만 읽어 화면용 캐시를 만든다(전량 로드 금지 — 무한 증가 파일이다). */
  function loadRecentAudit(): AuditEntry[] {
    if (!persist || !existsSync(auditDir)) return []
    try {
      const files = readdirSync(auditDir).filter((f) => f.endsWith('.jsonl')).sort().slice(-2)
      const out: AuditEntry[] = []
      for (const f of files) {
        const lines = readFileSync(join(auditDir, f), 'utf8').split('\n')
        for (const ln of lines) {
          if (!ln.trim()) continue
          try {
            out.push(JSON.parse(ln) as AuditEntry)
          } catch {
            /* 손상된 줄은 건너뛴다 — 추가 전용 파일이라 뒤 내용은 멀쩡하다 */
          }
        }
      }
      return out.slice(-1000)
    } catch {
      return []
    }
  }

  function bumpPermVersion(now: number): void {
    if (!settings) return
    settings.permVersion++
    settings.updatedAt = now
    saveSettingsFile()
  }

  function roleOf(roleId: string): CommunityRole | null {
    return settings?.roles.find((r) => r.id === roleId) ?? null
  }

  /** 제재가 아직 살아 있는지 — 만료는 따로 청소하지 않고 볼 때 판정한다. */
  function activeSanction(m: CommunityMember, now: number): Sanction | null {
    const s = m.sanction
    if (!s) return null
    if (s.kind === 'warn') return null
    if (s.until !== undefined && s.until <= now) return null
    return s
  }

  function can(perm: PermKey, ctx: PermCtx): boolean {
    const def = PERM_DEF_BY_KEY.get(perm)
    if (!def) return false
    // 1) 서버 주인은 무조건 통과 — 자가호스팅에서 커뮤니티에 잠기면 복구 수단이 파일 편집뿐이 된다.
    //    대신 이 경로로 지나간 행위는 호출부가 감사 기록에 asAdmin 으로 남긴다.
    if (ctx.isAppAdmin) return true
    const m = ctx.member
    const board = ctx.board ?? null
    // 2) 비멤버·심사 대기 — 공개 게시판을 읽는 것만.
    if (!m) return perm === 'board.read' && !!board && !board.hidden
    // 3~4) 제재. 개별 허용이 남아 있어 글이 써지는 일이 없도록 오버라이드보다 위에 둔다.
    const sanc = activeSanction(m, ctx.now)
    if (sanc?.kind === 'ban') return false
    if (sanc?.kind === 'mute' && WRITE_PERMS.has(perm)) return false

    let verdict: boolean | null = null
    const pick = (patch: PermPatch | undefined): boolean => {
      if (verdict !== null || !patch) return verdict !== null
      const g = patch[perm]
      if (g === 'allow') verdict = true
      else if (g === 'deny') verdict = false
      return verdict !== null
    }
    // 5) 개인 × 게시판 → 6) 개인 → 7) 역할 × 게시판 → 8) 역할 → 9) 기본값.
    if (board) pick(m.boardPerms[board.id])
    pick(m.perms)
    if (board) pick(board.rolePerms[m.roleId])
    pick(roleOf(m.roleId)?.perms)
    if (verdict === null) {
      // 9) 기본값. 단 숨긴 게시판은 '명시적으로 허용받은 사람만'이 규칙이라 기본을 거부로 뒤집는다.
      //    존재를 감추는 게시판에 기본 허용이 남아 있으면 감추는 의미가 없다.
      verdict = board?.hidden ? false : def.def
    }

    // owner 역할은 기본값 단계에서 전부 허용한다(명시적 deny 는 존중 — 스스로 건 제한은 유지).
    if (!verdict && m.roleId === 'owner') {
      const explicitDeny =
        (board && m.boardPerms[board.id]?.[perm] === 'deny') ||
        m.perms[perm] === 'deny' ||
        (board && board.rolePerms.owner?.[perm] === 'deny') ||
        roleOf('owner')?.perms[perm] === 'deny'
      if (!explicitDeny) verdict = true
    }
    // 모순 정규화 — 읽을 수 없는 게시판에 글은 쓸 수 없다.
    if (verdict && IS_BOARD_PERM.has(perm) && perm !== 'board.read' && board) {
      if (!can('board.read', ctx)) return false
    }
    return verdict
  }

  return {
    enabled: () => featureOn,
    setEnabled(v) {
      featureOn = v
      writeAtomic(featurePath, JSON.stringify({ enabled: v }))
    },

    settings: () => settings,

    ensure(ownerId, now, mode = 'basic') {
      if (settings) return settings
      const catId = id()
      const categories: Category[] = [{ id: catId, name: '안내', order: 0, collapsed: false }]
      const boards: Board[] = [
        makeBoard(catId, 'general', '공지', 0, now, { noticeMax: 10 }),
        makeBoard(catId, 'general', '자유', 1, now)
      ]
      // 캐릭터 커뮤니티로 열 때만 활동 구획을 함께 심는다.
      if (mode === 'oc') {
        const sysId = id()
        categories.push({ id: sysId, name: '러닝', order: 1, collapsed: false })
        boards.push(
          makeBoard(sysId, 'character', '캐릭터', 2, now),
          makeBoard(sysId, 'roleplay', '역극', 3, now),
          makeBoard(sysId, 'log', '로그', 4, now)
        )
      }
      settings = {
        cid: MAIN_CID,
        mode,
        name: '커뮤니티',
        tagline: '',
        logo: '',
        stage: 'prep',
        // 승인제가 기본 — 문을 열어 두는 것은 관리자가 뜻을 갖고 고르는 일이다(운영 설정에서 바꾼다).
        joinMode: 'approval',
        applyForm: [],
        econ: { ...DEFAULT_ECON },
        theme: defaultTheme(),
        labels: {},
        roles: defaultRoles(),
        categories,
        boards,
        menu: normMenu([], new Set(boards.map((b) => b.id))),
        permVersion: 1,
        epoch: 1,
        ownerId,
        createdAt: now,
        updatedAt: now
      }
      members[ownerId] = newMember(ownerId, 'owner', '', now)
      saveSettingsFile()
      touchMembers(true)
      return settings
    },

    member: (accountId) => (typeof accountId === 'string' && members[accountId]) || null,
    members: () => Object.values(members),
    role: (roleId) => roleOf(roleId),
    board: (boardId) => settings?.boards.find((b) => b.id === boardId) ?? null,
    boards: () => settings?.boards.slice().sort((a, b) => a.order - b.order) ?? [],

    can,

    permSnapshot(ctx) {
      const cmty: Record<string, boolean> = {}
      for (const d of CMTY_PERM_DEFS) cmty[d.key] = can(d.key, { ...ctx, board: null })
      const boards: Record<string, Record<string, boolean>> = {}
      for (const b of settings?.boards ?? []) {
        const row: Record<string, boolean> = {}
        for (const d of BOARD_PERM_DEFS) row[d.key] = can(d.key, { ...ctx, board: b })
        boards[b.id] = row
      }
      return { cmty, boards }
    },

    visibleBoards(ctx) {
      // 목록에 넣는 기준은 '읽을 수 있는가' 하나뿐이다. 숨김 여부는 can() 안에서 이미 반영된다.
      return (settings?.boards ?? [])
        .filter((b) => can('board.read', { ...ctx, board: b }))
        .slice()
        .sort((a, b) => a.order - b.order)
    },

    join(accountId, nick, answers, now) {
      if (!settings) return { ok: false, error: '아직 커뮤니티가 없습니다.' }
      if (members[accountId]) return { ok: true, value: { member: members[accountId], application: null } }
      const cleanNick = str(nick, MAX_NICK)
      if (settings.joinMode === 'invite') return { ok: false, error: '초대를 받은 사람만 가입할 수 있습니다.' }
      const form = settings.applyForm
      const picked: Record<string, string> = {}
      for (const f of form) {
        const raw = (answers as Record<string, unknown>)?.[f.key]
        const v = multiline(raw, f.max ?? 2000)
        // 확인문구 — 공지를 정독했는지 확인하는 칸이라 정확히 일치해야 한다.
        if (f.type === 'confirm' && f.answer && v !== f.answer) {
          return { ok: false, error: `'${f.label}' 을(를) 공지의 문구와 똑같이 입력해 주세요.` }
        }
        if (f.required && !v) return { ok: false, error: `'${f.label}' 을(를) 입력해 주세요.` }
        if (v) picked[f.key] = v
      }
      if (settings.joinMode === 'open') {
        const m = newMember(accountId, 'member', cleanNick, now)
        members[accountId] = m
        touchMembers(true)
        return { ok: true, value: { member: m, application: null } }
      }
      // 승인제 — 대기 역할로 넣어 두고 심사 목록에 올린다(공지는 읽을 수 있게).
      if (apps.some((a) => a.accountId === accountId && a.status === 'pending')) {
        return { ok: false, error: '이미 신청서를 냈습니다. 심사를 기다려 주세요.' }
      }
      if (apps.length >= MAX_APPLICATIONS) apps = apps.filter((a) => a.status === 'pending').slice(-MAX_APPLICATIONS)
      const app: JoinApplication = {
        id: id(),
        accountId,
        nick: cleanNick,
        answers: picked,
        status: 'pending',
        note: '',
        createdAt: now
      }
      apps.push(app)
      members[accountId] = newMember(accountId, 'pending', cleanNick, now)
      saveAppsFile()
      touchMembers(true)
      return { ok: true, value: { member: members[accountId], application: app } }
    },

    applications: () => apps.slice().sort((a, b) => b.createdAt - a.createdAt),

    decideApplication(actorId, appId, approve, note, now) {
      const app = apps.find((a) => a.id === appId)
      if (!app) return { ok: false, error: '신청서를 찾을 수 없습니다.' }
      if (app.status !== 'pending') return { ok: false, error: '이미 처리된 신청서입니다.' }
      app.status = approve ? 'approved' : 'rejected'
      app.note = str(note, MAX_REASON)
      app.decidedBy = actorId
      app.decidedAt = now
      saveAppsFile()
      const m = members[app.accountId]
      if (!m) return { ok: true, value: null }
      if (approve) {
        m.roleId = 'member'
        touchMembers(true)
        bumpPermVersion(now)
        return { ok: true, value: m }
      }
      // 반려 — 멤버십을 지워 다시 신청할 수 있게 한다.
      delete members[app.accountId]
      touchMembers(true)
      bumpPermVersion(now)
      return { ok: true, value: null }
    },

    setRole(actorId, actorTier, accountId, roleId, now) {
      if (!settings) return { ok: false, error: '아직 커뮤니티가 없습니다.' }
      const m = members[accountId]
      if (!m) return { ok: false, error: '멤버가 아닙니다.' }
      const target = roleOf(roleId)
      if (!target) return { ok: false, error: '없는 등급입니다.' }
      const cur = roleOf(m.roleId)
      // 자기와 같거나 위인 상대는 건드릴 수 없고, 자기보다 위 등급을 줄 수도 없다.
      if (cur && cur.tier <= actorTier && actorId !== accountId) return { ok: false, error: '이 멤버는 편집할 수 없습니다.' }
      if (target.tier < actorTier) return { ok: false, error: '자신보다 높은 등급은 줄 수 없습니다.' }
      // 관리자가 한 명도 남지 않는 조작은 막는다(누구도 운영할 수 없는 상태 방지).
      if (m.roleId === 'owner' && roleId !== 'owner') {
        const owners = Object.values(members).filter((x) => x.roleId === 'owner')
        if (owners.length <= 1) return { ok: false, error: '관리자가 최소 한 명은 있어야 합니다.' }
      }
      m.roleId = roleId
      touchMembers(true)
      bumpPermVersion(now)
      return { ok: true, value: m }
    },

    setMemberPerms(accountId, perms, boardPerms) {
      if (!settings) return { ok: false, error: '아직 커뮤니티가 없습니다.' }
      const m = members[accountId]
      if (!m) return { ok: false, error: '멤버가 아닙니다.' }
      m.perms = normPatch(perms)
      const bp: Record<string, PermPatch> = {}
      if (boardPerms && typeof boardPerms === 'object') {
        for (const [bid, patch] of Object.entries(boardPerms as Record<string, unknown>)) {
          if (!settings.boards.some((b) => b.id === bid)) continue
          const p = normPatch(patch)
          if (Object.keys(p).length) bp[bid] = p
        }
      }
      m.boardPerms = bp
      touchMembers(true)
      bumpPermVersion(Date.now())
      return { ok: true, value: m }
    },

    sanction(actorId, actorTier, accountId, input, now) {
      if (!settings) return { ok: false, error: '아직 커뮤니티가 없습니다.' }
      const m = members[accountId]
      if (!m) return { ok: false, error: '멤버가 아닙니다.' }
      const cur = roleOf(m.roleId)
      if (cur && cur.tier <= actorTier) return { ok: false, error: '이 멤버는 제재할 수 없습니다.' }
      const r = (input && typeof input === 'object' ? input : {}) as Record<string, unknown>
      const kind = r.kind === 'mute' || r.kind === 'ban' || r.kind === 'warn' ? r.kind : null
      if (!kind) return { ok: false, error: '제재 종류가 올바르지 않습니다.' }
      const reason = str(r.reason, MAX_REASON)
      if (!reason) return { ok: false, error: '사유를 입력해 주세요.' }
      if (kind === 'warn') {
        m.warns++
        m.sanction = { kind, reason, byAccountId: actorId, byTier: actorTier, at: now }
      } else {
        const days = typeof r.days === 'number' ? num(r.days, 0, 3650, 0) : 0
        m.sanction = {
          kind,
          reason,
          ...(days > 0 ? { until: now + days * 24 * 60 * 60 * 1000 } : {}),
          byAccountId: actorId,
          byTier: actorTier,
          at: now
        }
      }
      touchMembers(true)
      bumpPermVersion(now)
      return { ok: true, value: m }
    },

    clearSanction(actorTier, accountId) {
      const m = members[accountId]
      if (!m) return { ok: false, error: '멤버가 아닙니다.' }
      // 자기보다 위 등급이 건 제재는 풀 수 없다(권력 집중 방지의 반대편 장치).
      if (m.sanction && m.sanction.byTier < actorTier) return { ok: false, error: '상위 등급이 건 제재는 해제할 수 없습니다.' }
      delete m.sanction
      touchMembers(true)
      bumpPermVersion(Date.now())
      return { ok: true, value: m }
    },

    leave(accountId) {
      if (!members[accountId]) return
      // 관리자가 사라지면 커뮤니티를 운영할 사람이 없어진다.
      if (members[accountId].roleId === 'owner') {
        const owners = Object.values(members).filter((x) => x.roleId === 'owner')
        if (owners.length <= 1) return
      }
      delete members[accountId]
      touchMembers(true)
    },

    setMode(mode, now) {
      if (!settings) return { ok: false, error: '아직 커뮤니티가 없습니다.' }
      if (mode !== 'basic' && mode !== 'oc') return { ok: false, error: '알 수 없는 커뮤니티 성격입니다.' }
      if (settings.mode !== mode) {
        settings.mode = mode
        settings.updatedAt = now
        // 화면 구성이 통째로 바뀐다 — 클라가 들고 있는 스냅샷을 전부 무효화한다.
        settings.permVersion++
        saveSettingsFile()
      }
      return { ok: true, value: settings }
    },

    saveSettings(input, now) {
      if (!settings) return { ok: false, error: '아직 커뮤니티가 없습니다.' }
      const r = (input && typeof input === 'object' ? input : {}) as Record<string, unknown>
      if (typeof r.name === 'string') settings.name = str(r.name, MAX_NAME) || settings.name
      if (typeof r.tagline === 'string') settings.tagline = str(r.tagline, MAX_TAGLINE)
      if (r.logo !== undefined) settings.logo = assetRef(r.logo)
      if (r.stage === 'prep' || r.stage === 'open' || r.stage === 'closed') settings.stage = r.stage
      if (r.joinMode === 'open' || r.joinMode === 'approval' || r.joinMode === 'invite') settings.joinMode = r.joinMode
      if (r.applyForm !== undefined) settings.applyForm = normFormFields(r.applyForm)
      if (r.econ !== undefined) settings.econ = normEcon(r.econ)
      settings.updatedAt = now
      saveSettingsFile()
      return { ok: true, value: settings }
    },

    saveTree(input, now) {
      if (!settings) return { ok: false, error: '아직 커뮤니티가 없습니다.' }
      const r = (input && typeof input === 'object' ? input : {}) as Record<string, unknown>
      const rawCats = Array.isArray(r.categories) ? r.categories : []
      const rawBoards = Array.isArray(r.boards) ? r.boards : []
      if (rawCats.length > MAX_CATEGORIES) return { ok: false, error: `분류는 ${MAX_CATEGORIES}개까지입니다.` }
      if (rawBoards.length > MAX_BOARDS) return { ok: false, error: `게시판은 ${MAX_BOARDS}개까지입니다.` }

      const prevBoards = new Map(settings.boards.map((b) => [b.id, b]))
      const cats: Category[] = []
      const catIds = new Set<string>()
      for (const [i, raw] of rawCats.entries()) {
        const c = (raw ?? {}) as Record<string, unknown>
        const cid = isEntityId(c.id) ? c.id : id()
        if (catIds.has(cid)) continue
        catIds.add(cid)
        cats.push({ id: cid, name: str(c.name, MAX_NAME) || '분류', order: i, collapsed: bool(c.collapsed) })
      }
      if (!cats.length) return { ok: false, error: '분류가 최소 하나는 있어야 합니다.' }

      const boards: Board[] = []
      const seen = new Set<string>()
      for (const [i, raw] of rawBoards.entries()) {
        const b = (raw ?? {}) as Record<string, unknown>
        const bid = isEntityId(b.id) ? b.id : id()
        if (seen.has(bid)) continue
        seen.add(bid)
        const prev = prevBoards.get(bid)
        // 종류는 만들 때 정해지고 이후 바뀌지 않는다 — 저장 형태가 종류에 묶여 있다.
        // 보통 커뮤니티는 일반 게시판만 만들 수 있다(캐릭터·놀이 종류는 화면이 없다).
        const kind: BoardKind = prev
          ? prev.kind
          : typeof b.kind === 'string' &&
              CREATABLE_KINDS.has(b.kind as BoardKind) &&
              (settings.mode === 'oc' || b.kind === 'general')
            ? (b.kind as BoardKind)
            : 'general'
        const categoryId = typeof b.categoryId === 'string' && catIds.has(b.categoryId) ? b.categoryId : cats[0].id
        const rolePerms: Record<string, PermPatch> = {}
        if (b.rolePerms && typeof b.rolePerms === 'object') {
          for (const [rid, patch] of Object.entries(b.rolePerms as Record<string, unknown>)) {
            if (!settings.roles.some((x) => x.id === rid)) continue
            const p = normPatch(patch)
            if (Object.keys(p).length) rolePerms[rid] = p
          }
        }
        // 숨긴 게시판은 명시적으로 허용받은 사람만 볼 수 있다(can 의 기본이 거부로 뒤집힌다).
        // 아무 설정 없이 감추면 관리자 혼자만 남게 되므로, 처음 감출 때 운영진 열람을 기본으로 깔아 준다(이후 자유 편집).
        const hidden = bool(b.hidden, prev?.hidden ?? false)
        if (hidden && !Object.keys(rolePerms).length) rolePerms.staff = { 'board.read': 'allow' }
        const prefixes = Array.isArray(b.prefixes)
          ? b.prefixes.map((p) => str(p, MAX_PREFIX)).filter(Boolean).slice(0, MAX_PREFIXES)
          : prev?.prefixes ?? []
        const form = b.form !== undefined ? normFormFields(b.form) : (prev?.form ?? defaultForm(kind))
        boards.push({
          id: bid,
          categoryId,
          kind,
          name: str(b.name, MAX_NAME) || prev?.name || '게시판',
          desc: multiline(b.desc, MAX_DESC),
          icon: str(b.icon, 40),
          order: i,
          hidden,
          rolePerms,
          prefixes,
          form: form.length ? form : defaultForm(kind),
          listStyle:
            typeof b.listStyle === 'string' && ['row', 'card', 'grid', 'inline'].includes(b.listStyle)
              ? (b.listStyle as ListStyle)
              : (prev?.listStyle ?? defaultListStyle(kind)),
          noticeMax: num(b.noticeMax, 0, 20, prev?.noticeMax ?? 3),
          anonymous: bool(b.anonymous, prev?.anonymous ?? false),
          rating: b.rating === 'r15' || b.rating === 'r19' ? b.rating : 'all',
          createdAt: prev?.createdAt ?? now
        })
      }
      if (!boards.length) return { ok: false, error: '게시판이 최소 하나는 있어야 합니다.' }
      settings.categories = cats
      settings.boards = boards
      // 메뉴는 함께 왔을 때만 손댄다. 게시판만 고치는 화면이 메뉴를 통째로 날리지 않게.
      settings.menu = normMenu(r.menu === undefined ? settings.menu : r.menu, new Set(boards.map((b) => b.id)))
      settings.updatedAt = now
      settings.permVersion++
      saveSettingsFile()
      return { ok: true, value: settings }
    },

    saveTheme(theme, now) {
      if (!settings) return { ok: false, error: '아직 커뮤니티가 없습니다.' }
      settings.theme = normTheme(theme)
      settings.updatedAt = now
      saveSettingsFile()
      return { ok: true, value: settings.theme }
    },

    saveLabels(labels, now) {
      if (!settings) return { ok: false, error: '아직 커뮤니티가 없습니다.' }
      settings.labels = normLabels(labels)
      settings.updatedAt = now
      saveSettingsFile()
      return { ok: true, value: settings.labels }
    },

    saveRoles(roles, now) {
      if (!settings) return { ok: false, error: '아직 커뮤니티가 없습니다.' }
      if (!Array.isArray(roles)) return { ok: false, error: '등급 목록이 올바르지 않습니다.' }
      if (roles.length > MAX_ROLES) return { ok: false, error: `등급은 ${MAX_ROLES}개까지입니다.` }
      const prev = new Map(settings.roles.map((r) => [r.id, r]))
      const out: CommunityRole[] = []
      const seen = new Set<string>()
      for (const raw of roles) {
        const r = (raw ?? {}) as Record<string, unknown>
        const rid = typeof r.id === 'string' && /^[\w-]{1,40}$/.test(r.id) ? r.id : id()
        if (seen.has(rid)) continue
        seen.add(rid)
        const p = prev.get(rid)
        out.push({
          id: rid,
          name: str(r.name, MAX_NAME) || p?.name || '등급',
          color: hex(r.color) || p?.color || '#9aa3b0',
          tier: num(r.tier, 0, 99, p?.tier ?? 5),
          builtin: p?.builtin ?? false,
          perms: normPatch(r.perms),
          ...(p?.autoRule ? { autoRule: p.autoRule } : {})
        })
      }
      // 기본 등급은 지울 수 없다 — 지우면 그 등급을 달고 있던 멤버가 판정 불가 상태가 된다.
      for (const b of defaultRoles()) if (!seen.has(b.id)) out.push(prev.get(b.id) ?? b)
      settings.roles = out.sort((a, b) => a.tier - b.tier)
      settings.updatedAt = now
      settings.permVersion++
      saveSettingsFile()
      return { ok: true, value: settings.roles }
    },

    removeBoard(boardId, now) {
      if (!settings) return { ok: false, error: '아직 커뮤니티가 없습니다.' }
      const b = settings.boards.find((x) => x.id === boardId)
      if (!b) return { ok: false, error: '없는 게시판입니다.' }
      if (settings.boards.length <= 1) return { ok: false, error: '게시판이 최소 하나는 있어야 합니다.' }
      settings.boards = settings.boards.filter((x) => x.id !== boardId)
      settings.updatedAt = now
      settings.permVersion++
      saveSettingsFile()
      return { ok: true, value: b }
    },

    bumpStat(accountId, field, delta, now) {
      const m = members[accountId]
      if (!m) return
      if (field === 'lastSeenAt') m.stats.lastSeenAt = now
      else m.stats[field] = Math.max(0, m.stats[field] + delta)
      touchMembers()
    },

    markRead(accountId, boardId, now) {
      const m = members[accountId]
      if (!m) return
      m.lastRead[boardId] = now
      touchMembers()
    },

    toggleSub(accountId, boardId) {
      const m = members[accountId]
      if (!m) return { ok: false, error: '멤버가 아닙니다.' }
      if (!settings?.boards.some((b) => b.id === boardId)) return { ok: false, error: '없는 게시판입니다.' }
      const i = m.subs.indexOf(boardId)
      if (i >= 0) m.subs.splice(i, 1)
      else {
        if (m.subs.length >= MAX_SUBS) return { ok: false, error: `구독은 ${MAX_SUBS}개까지입니다.` }
        m.subs.push(boardId)
      }
      touchMembers(true)
      return { ok: true, value: m.subs.slice() }
    },

    subscribers(boardId, exceptId) {
      return Object.values(members)
        .filter((m) => m.accountId !== exceptId && m.subs.includes(boardId))
        .map((m) => m.accountId)
    },

    audit(entry, now) {
      const e: AuditEntry = {
        id: id(),
        at: now,
        actorId: entry.actorId,
        actorName: str(entry.actorName, MAX_NICK),
        ...(entry.asAdmin ? { asAdmin: true } : {}),
        action: str(entry.action, 60),
        ...(entry.targetType ? { targetType: str(entry.targetType, 30) } : {}),
        ...(entry.targetId ? { targetId: str(entry.targetId, 64) } : {}),
        ...(entry.targetName ? { targetName: str(entry.targetName, MAX_NAME) } : {}),
        ...(entry.detail ? { detail: multiline(entry.detail, MAX_AUDIT_DETAIL) } : {})
      }
      auditCache.push(e)
      if (auditCache.length > 1000) auditCache = auditCache.slice(-1000)
      if (!persist) return
      try {
        mkdirSync(auditDir, { recursive: true })
        // 추가 전용 — 한 줄 붙이는 것으로 끝난다. 전량 재직렬화는 이 파일에 쓰지 않는다(단조 증가).
        appendFileSync(auditFile(now), JSON.stringify(e) + '\n', 'utf8')
      } catch (err) {
        console.error('[community] 기록 저장 실패:', err)
      }
    },

    auditList(limit, before) {
      const lim = num(limit, 1, 200, 50)
      return auditCache
        .filter((e) => (before === undefined ? true : e.at < before))
        .slice(-lim)
        .reverse()
    },

    collectAssetRefs(into) {
      // 필드를 하나씩 세는 대신 통째로 훑는다 — 새 필드가 늘어도 빠뜨리지 않는다.
      if (settings) scanAssetRefs(JSON.stringify(settings), into)
    },

    removeAll(accountId) {
      // 커뮤니티에서 계정 탈퇴는 '멤버십 회수'다. 글·댓글은 남긴다(남의 역극 스레드에 구멍이 뚫린다).
      if (members[accountId]) {
        delete members[accountId]
        touchMembers(true)
      }
      const before = apps.length
      apps = apps.filter((a) => a.accountId !== accountId)
      if (apps.length !== before) saveAppsFile()
    },

    usageFor(accountId) {
      const m = members[accountId]
      const bytes = m ? Buffer.byteLength(JSON.stringify(m), 'utf8') : 0
      return { bytes, refs: new Set<string>() }
    },

    exportFor(accountId) {
      const m = members[accountId]
      return m ? { member: m } : null
    },

    importFor(accountId, data, now) {
      const r = (data && typeof data === 'object' ? data : {}) as Record<string, unknown>
      const raw = r.member as Record<string, unknown> | undefined
      if (!raw || typeof raw !== 'object') return
      if (members[accountId]) return // 이미 있으면 덮지 않는다(복원이 현재 상태를 되돌리지 않게)
      const roleId = typeof raw.roleId === 'string' && roleOf(raw.roleId) ? raw.roleId : 'member'
      // 복원으로 관리자가 되는 길은 막는다.
      members[accountId] = newMember(accountId, roleId === 'owner' ? 'member' : roleId, str(raw.nick, MAX_NICK), now)
      touchMembers(true)
    },

    usage() {
      let bytes = 0
      try {
        bytes = Buffer.byteLength(JSON.stringify({ settings, members }), 'utf8')
        if (persist && existsSync(auditDir)) {
          for (const f of readdirSync(auditDir)) bytes += statSync(join(auditDir, f)).size
        }
      } catch {
        /* 크기 산출 실패는 치명적이지 않다 */
      }
      return { members: Object.keys(members).length, boards: settings?.boards.length ?? 0, bytes }
    },

    flush() {
      if (membersTimer) {
        clearTimeout(membersTimer)
        membersTimer = null
      }
      if (membersDirty) saveMembersFile()
    }
  }

  function newMember(accountId: string, roleId: string, nick: string, now: number): CommunityMember {
    return {
      accountId,
      roleId,
      nick,
      perms: {},
      boardPerms: {},
      warns: 0,
      subs: [],
      lastRead: {},
      stats: { posts: 0, comments: 0, received: 0, visits: 0, lastSeenAt: now },
      joinedAt: now
    }
  }
}
