// 방 스토어 — 서버가 방/참가자/메시지의 진실원본.
// 세션방 영속: persist 모드면 방을 <dataDir>/rooms/<id>.json 에 저장(장면·메타·멤버·전체 채팅).
// 시작 시 로드, 변경 시 주기적 자동저장(lastActivityAt 기준 dirty flush). 방은 소유자 삭제 전까지 유지(유휴 정리 안 함).
import { randomUUID } from 'node:crypto'
import { readFileSync, existsSync, readdirSync, unlinkSync, appendFileSync, writeFileSync, statSync, mkdirSync } from 'node:fs'
import { mkdir, writeFile, rename, unlink } from 'node:fs/promises'
import { join } from 'node:path'
import { capImage, capImageList, capId, clampCoord } from './limits'
import { collectAssetRefs as scanAssetRefs } from './assets'
import type {
  Appearance,
  BgmState,
  Channel,
  Combatant,
  CombatState,
  ChatMessage,
  Handout,
  GameMap,
  GridConfig,
  HandoutScope,
  HandoutUpsertReq,
  MadnessTables,
  MapBackground,
  MapBackdrop,
  MapText,
  MapTextUpsertReq,
  Participant,
  RoomLoadReq,
  RoomState,
  SharedCharacter,
  Stroke,
  Token,
  TokenBar,
  TokenLayer,
  TokenUpsertReq,
  TokenZOp,
  VnLayer
} from './protocol'
import { GLOBAL_MAP_ID, MAX_TOKEN_CELLS } from './protocol'
import type { SuccessLevel } from './dice/types'

/** 버퍼를 줄 단위로 자른다 — 큰 기록장을 통째로 문자열로 만들지 않기 위해. */
function splitLines(buf: Buffer): Buffer[] {
  const out: Buffer[] = []
  let start = 0
  for (let i = 0; i < buf.length; i++) {
    if (buf[i] === 0x0a) {
      out.push(buf.subarray(start, i))
      start = i + 1
    }
  }
  if (start < buf.length) out.push(buf.subarray(start))
  return out
}

/** 저장이 이만큼 넘게 안 끝나면 매달린 것으로 보고 관리 화면에 알린다. */
const STUCK_FLUSH_MS = 60_000
/** 방당 메시지 보관 상한. 세션방 영속(전체 채팅 보관, 소유자가 비울 때까지) — 폭주 방지용 큰 상한. */
const MAX_HISTORY = 20000
/** 맵당 오브젝트 개수 상한 — 방 상태 팽창 방어(coerceLoadedMap 모든 진입점 적용). */
const MAX_TOKENS_PER_MAP = 2000
const MAX_DRAWINGS_PER_MAP = 2000
const MAX_TEXTS_PER_MAP = 1000

/** 서버 내부 맵세트 — 토큰은 빠른 조회 위해 Map. 와이어 전송 시 toWireMap 으로 배열화. */
export interface RoomMap {
  id: string
  name: string
  background: MapBackground | null
  grid: GridConfig
  tokens: Map<string, Token> // key: token id
  drawings: Map<string, Stroke> // key: stroke id (자유 드로잉, 삽입 순서 = z 순서)
  texts: Map<string, MapText> // key: text id (맵 텍스트 라벨)
  vnBackground?: string // 비주얼 노벨 무대 배경(data URL) — 맵세트별, 전술 배경과 별개
  vnBackgroundBlur?: number // 비주얼 노벨 배경 흐림 강도(0~40 · 없으면 0)
  vnLayers?: VnLayer[] // 비주얼 노벨 무대 레이어 스택 — vnBackground 위에 z순
  bgColor?: string // 맵 배경 단색(여백 전체) — 캔버스 전체 채움. hex. 없으면 투명
  backdrop?: MapBackdrop // 맵 바탕(최후면 이미지+블러) — 무대 바깥 여백까지 화면 전체를 덮음
  crossfade?: boolean // 크로스페이드 — 이 맵으로 전환 시 페이드 연출
  hiddenLayers?: TokenLayer[] // 숨긴 레이어(무대 앞 밴드·무대 뒤) — GM 설정·맵 단위 전원 동기
  bgm?: BgmState[] // 맵세트 번들 BGM 스냅샷(자산 참조). undefined=미저장, []=무음 저장
  importId?: string // 가져오기 출처 태그 — 같은 파일 배치의 맵·통합 레이어 연동 삭제용(불변)
}

export interface Room {
  id: string
  code: string
  title: string // 세션방 이름(목록 표시)
  ownerId: string // 소유자 계정 id(목록·삭제·복사·메타 권한). 비인증이면 playerId 폴백
  members: Set<string> // 참여한 적 있는 계정 id(목록용 · 소유자 포함)
  cardImage?: string // 세션 카드 이미지(1200×600 data URL)
  participants: Map<string, Participant> // key: playerId
  characters: Map<string, SharedCharacter> // key: playerId (프레즌스 서브셋)
  handouts: Map<string, Handout> // key: handout id (GM 자료)
  maps: Map<string, RoomMap> // key: map id (맵세트)
  activeMapId: string // 전원이 보는 활성 맵
  appearance: Appearance // 방 GM 강제 테마·다이스 카드
  cutInImage?: string // 방 주사위 연출 카드 이미지(data URL · GM 설정 · 레벨별 미설정 시 공통 폴백)
  cutInImages?: Partial<Record<SuccessLevel, string>> // 성공 단계별 연출 카드(GM 설정 · 전원 동기화)
  dimColor?: string // ~문장~ 행동지문 색(GM 설정 · 전원 동기화 · hex)
  madnessTables?: MadnessTables // GM 커스텀 광기표 — 미설정이면 클라 기본 표. 전원 동기화·영속.
  luckEnabled?: boolean // 행운 깎기(CoC7 하우스룰) 사용 여부 — GM 토글·전원 동기화·영속. 미설정=사용(기본).
  vnOverlay?: boolean // 일반 맵 위 VN 오버레이(대사창+발화자 스탠딩) 표시 — GM 토글·전원 동기화·영속. 미설정=꺼짐.
  bgm: BgmState[] // 방 BGM 트랙들 (다중, GM 제어·전원 동기화 · 최대 5)
  combat: CombatState | null // 방 전투 상태 (GM 제어·전원 동기화 · in-memory, 비영속)
  saveSlots?: SaveSlot[] // 저장 슬롯(반면 전체 명명 저장 · GM · 최대 3 · 영속)
  visualCards?: VisualCard[] // 비주얼 카드 — GM 등록·전원 동기화 · 영속
  globalTokens?: Map<string, Token> // 통합 레이어 — 맵세트를 넘어 모든 맵세트에 유지되는 토큰. key=token id · 영속
  channels: Map<string, Channel> // 그룹 채널(GM 개설·영속). key=channelId
  messages: ChatMessage[]
  /** 방별 캐릭터 시트 멤버십 — playerId(=계정) → 이 방에 속한 charId[]. 영속. 시트 데이터는 계정 라이브러리에. */
  charRooms: Map<string, string[]>
  createdAt: number
  lastActivityAt: number
}

/** 저장 슬롯 — 반면(맵·활성맵·BGM)을 이름 붙여 통째 저장. 최대 3 · 영속(디스크). */
export interface SaveSlot {
  id: string
  name: string
  savedAt: number
  maps: GameMap[] // 저장 시점 맵(와이어)
  activeMapId: string
  bgm: BgmState[]
  /** 저장 시점 통합 레이어 — 반면의 일부라 함께 복원(가져오기 배치 짝 유지). 구버전 슬롯엔 없음. */
  globalTokens?: Token[]
}
/** 저장 슬롯 메타(목록 표시용 — 맵 본문 제외). 클라 protocol 과 미러. */
export interface SaveSlotMeta {
  id: string
  name: string
  savedAt: number
}

/** 비주얼 카드 — 이름·이미지·음향. 채팅 말미 타이틀 또는 수동으로 전원 화면에 오버레이 재생. 클라 protocol 과 미러. */
export interface VisualCard {
  id: string
  name: string
  image?: string // 없으면 음향만([NOIMAGE])
  sound?: string
  soundSec?: number // 음향 재생 길이(초 · 1~600) — 없으면 음원 끝까지
  displaySec?: number // 카드 표시 시간(초 · 1~600) — 없으면 클릭할 때까지 표시
}

/** 세션방 목록 항목(room:list). 카드·메타만 — 장면/채팅 본문은 입장 시 스냅샷으로. 클라 protocol 과 미러. */
export interface RoomSummary {
  id: string
  code: string
  title: string
  cardImage?: string
  owner: boolean // 요청 계정이 소유자(=GM)인지
  memberCount: number
  online: number // 현재 접속 인원
  updatedAt: number
}

// 코드 알파벳: 혼동 쉬운 문자(I, O, 0, 1) 제외.
const CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'

function genSegment(): string {
  let s = ''
  for (let i = 0; i < 3; i++) s += CODE_ALPHABET[Math.floor(Math.random() * CODE_ALPHABET.length)]
  return s
}

function genCode(): string {
  return `${genSegment()}-${genSegment()}-${genSegment()}`
}

const DEFAULT_GM_COLOR = '#e7a33e'
const DEFAULT_PL_COLOR = '#7c9cff'
const DEFAULT_GRID: GridConfig = { size: 64, visible: true }

// ===== 레이어·z순서 =====
/** 레이어 렌더 순서(작을수록 뒤). 와이어 토큰 정렬·신규 z 계산에 사용. */
const LAYER_ORDER: Record<TokenLayer, number> = { behind: -1, bg: 0, token: 1, standing: 2 }
/** 겹침 밴드 — 앞(위)→뒤(아래). 무대 이미지는 bg 와 behind 사이. 밴드 경계 넘는 앞으로/뒤로용(클라 미러). */
const REORDER_BANDS: TokenLayer[] = ['standing', 'token', 'bg', 'behind']
/** 알 수 없는 값은 token 레이어로 정규화. */
function coerceLayer(v: unknown): TokenLayer {
  return v === 'behind' || v === 'bg' || v === 'standing' ? v : 'token'
}
/** 해당 레이어에서 가장 앞(최대 z). 비었으면 0 → 다음 신규 토큰 z=1. */
function topZ(tokens: Iterable<Token>, layer: TokenLayer): number {
  let max = 0
  for (const t of tokens) {
    if ((t.layer ?? 'token') === layer && (t.z ?? 0) > max) max = t.z ?? 0
  }
  return max
}

// 외형 강제 — 허용값(렌더러 useUIStore 와 동일). 와이어 문자열을 서버가 이 목록으로 검증.
const ACCENT_VALUES = ['indigo', 'teal', 'purple', 'amber', 'rose']
const DICE_STYLE_VALUES = ['editorial', 'medallion', 'ticket', 'cjk', 'classic']
const DEFAULT_APPEARANCE: Appearance = {
  theme: 'dark',
  accent: 'indigo',
  uiAccent: '',
  diceStyle: 'editorial'
}

/** 외형 페이로드 방어적 정규화(허용값 밖이면 기본값으로). uiAccent 는 hex 길이만 제한. */
function normalizeAppearance(ap: Partial<Appearance> | undefined): Appearance {
  return {
    theme: ap?.theme === 'light' ? 'light' : 'dark',
    accent: typeof ap?.accent === 'string' && ACCENT_VALUES.includes(ap.accent) ? ap.accent : 'indigo',
    uiAccent: typeof ap?.uiAccent === 'string' ? ap.uiAccent.trim().slice(0, 32) : '',
    diceStyle:
      typeof ap?.diceStyle === 'string' && DICE_STYLE_VALUES.includes(ap.diceStyle)
        ? ap.diceStyle
        : 'editorial'
  }
}

// BGM 음원 종류 허용값(렌더러 protocol BgmKind 와 동일).
const BGM_KINDS = ['file', 'youtube']
/** 동시 재생 BGM 트랙 최대 수(환경음+배경음 등 레이어드). */
export const MAX_BGM_TRACKS = 5
/** 볼륨 0~1 클램프(유한·기본값 처리). */
function clampVol(v: unknown, fallback = 1): number {
  return typeof v === 'number' && Number.isFinite(v) ? Math.max(0, Math.min(1, v)) : fallback
}

/**
 * BGM set 페이로드 방어적 정규화. 소스 없거나 kind 가 허용값 밖이면 null(무시).
 * title 은 200자 제한, loop 기본 true(앰비언트), volume 0~1(기본 1), playing 은 서버가 true 로 스탬프.
 */
function normalizeBgm(
  req:
    | { trackId?: unknown; kind?: unknown; src?: unknown; title?: unknown; loop?: unknown; volume?: unknown }
    | undefined
): BgmState | null {
  if (!req || typeof req.src !== 'string' || !req.src) return null
  if (typeof req.kind !== 'string' || !BGM_KINDS.includes(req.kind)) return null
  return {
    trackId: typeof req.trackId === 'string' && req.trackId ? req.trackId : 'bgm',
    kind: req.kind as BgmState['kind'],
    src: req.src,
    title: typeof req.title === 'string' ? req.title.slice(0, 200) : '',
    loop: req.loop !== false,
    playing: true,
    volume: clampVol(req.volume)
  }
}

// ===== 방 불러오기 방어적 정규화 — 신뢰할 수 없는 .orpg 페이로드를 안전한 서버 모델로. =====
/** 이동 권한 playerId 목록 정규화 — 문자열만·각 캡·최대 64개. 빈/무효는 undefined. */
function coercePlayerIds(v: unknown): string[] | undefined {
  if (!Array.isArray(v)) return undefined
  const out: string[] = []
  for (const x of v) {
    const id = capId(x)
    if (id && !out.includes(id)) out.push(id)
    if (out.length >= 64) break
  }
  return out.length ? out : undefined
}
/** 맵 텍스트 라벨 정규화 — 텍스트 200자·크기 8~200·색 캡. 무효면 null. */
function coerceMapText(t: unknown): MapText | null {
  if (!t || typeof t !== 'object') return null
  const o = t as Record<string, unknown>
  if (typeof o.id !== 'string' || !o.id) return null
  const text = typeof o.text === 'string' ? o.text.slice(0, 200) : ''
  if (!text) return null
  return {
    id: o.id,
    playerId: typeof o.playerId === 'string' ? o.playerId : '',
    x: clampCoord(o.x),
    y: clampCoord(o.y),
    text,
    color: typeof o.color === 'string' && o.color ? o.color.slice(0, 32) : '#ffffff',
    size: typeof o.size === 'number' && Number.isFinite(o.size) ? Math.max(8, Math.min(200, o.size)) : 28,
    bold: o.bold === true ? true : undefined
  }
}
/** 토큰 공개범위 정규화 — 4종 외/부재는 undefined(=all). */
function coerceVisibility(v: unknown): 'all' | 'owner' | 'private' | 'others' | undefined {
  return v === 'all' || v === 'owner' || v === 'private' || v === 'others' ? v : undefined
}
/** visibility 값 → 저장 필드 쌍. all/undefined=필드 없음, private 은 레거시 hidden 미러(구클라 열화용). */
function visFields(
  v: 'all' | 'owner' | 'private' | 'others' | undefined
): { visibility?: 'owner' | 'private' | 'others'; hidden?: true } {
  const vis = v && v !== 'all' ? v : undefined
  return { visibility: vis, hidden: vis === 'private' ? true : undefined }
}
/** 토큰의 유효 공개범위 — visibility 우선, 레거시 hidden:true 는 private, 없으면 all. */
export function tokenVisibility(t: { visibility?: string; hidden?: boolean }): 'all' | 'owner' | 'private' | 'others' {
  return coerceVisibility(t.visibility) ?? (t.hidden ? 'private' : 'all')
}
/**
 * 뷰어가 토큰을 볼 수 있는지 — all=전원, private=GM만, owner=소유자+GM, others=소유자 외.
 * GM 은 미리보기로 항상 열람. viewer 없으면(내부/내보내기) 전부 열람.
 */
export function canSeeToken(
  t: { visibility?: string; hidden?: boolean; charPlayerId?: string },
  viewer?: { playerId: string; role: Participant['role'] }
): boolean {
  if (!viewer) return true
  const v = tokenVisibility(t)
  if (v === 'all') return true
  if (viewer.role === 'GM') return true
  if (v === 'private') return false
  if (v === 'owner') return t.charPlayerId === viewer.playerId
  return t.charPlayerId !== viewer.playerId // 'others' — 소유자만 못 봄
}
/** 뷰어가 토큰 상태바·수치를 볼 수 있는지 — 상태 비공개면 소유자·GM(미리보기)만. */
export function canSeeStats(
  t: { statsPrivate?: boolean; charPlayerId?: string },
  viewer?: { playerId: string; role: Participant['role'] }
): boolean {
  if (!t.statsPrivate || !viewer) return true
  return viewer.role === 'GM' || t.charPlayerId === viewer.playerId
}
/**
 * 뷰어에게 보여줄 토큰 표현 — 앞면 가시=원본(단 상태 비공개면 상태바 제거), 아니면 backImage 있으면
 * 뒷면(앞면 민감정보 제거), 없으면 null(미표시). 양면 이미지·상태 비공개를 서버 권위로 구현.
 */
export function tokenForViewer(
  token: Token,
  viewer?: { playerId: string; role: Participant['role'] }
): Token | null {
  if (canSeeToken(token, viewer)) {
    // 앞면 보임 — 상태 비공개면 소유자·GM 외에는 커스텀 상태바를 서버가 제거(값 노출 차단).
    if (token.bars?.length && !canSeeStats(token, viewer)) return { ...token, bars: undefined }
    return token
  }
  if (!token.backImage) return null
  // 뒷면 — 앞면 이미지·라벨·메모·이미지카드·소유자·클릭·색·이름/UI 등 민감 정보는 담지 않는다.
  // 표시 맵 제한(mapIds)은 위치 정보라 유지 — 빠지면 뒷면만 보는 뷰어에게 전 맵 표시로 갈라진다.
  return {
    id: token.id,
    x: token.x,
    y: token.y,
    size: token.size,
    rotation: token.rotation,
    layer: token.layer,
    z: token.z,
    flipX: token.flipX,
    mapIds: token.mapIds,
    image: token.backImage
  }
}
/** 커스텀 상태바 정규화 — 최대 8개, 이름·현재/최대·색 캡. 빈 배열이면 undefined. */
function coerceBars(v: unknown): TokenBar[] | undefined {
  if (!Array.isArray(v)) return undefined
  const out: TokenBar[] = []
  for (const raw of v) {
    if (out.length >= 8) break
    if (!raw || typeof raw !== 'object') continue
    const o = raw as Record<string, unknown>
    const cur = typeof o.cur === 'number' && Number.isFinite(o.cur) ? o.cur : 0
    const max = typeof o.max === 'number' && Number.isFinite(o.max) ? o.max : 0
    out.push({
      id: typeof o.id === 'string' && o.id ? o.id.slice(0, 40) : randomUUID(),
      label: typeof o.label === 'string' ? o.label.slice(0, 24) || undefined : undefined,
      cur: Math.max(-1_000_000, Math.min(1_000_000, cur)),
      max: Math.max(0, Math.min(1_000_000, max)),
      color: typeof o.color === 'string' ? o.color.slice(0, 16) || undefined : undefined
    })
  }
  return out.length ? out : undefined
}
/** 토큰 가로/세로 칸수(비정방 스트레치 비율) 정규화 — 0.25~캡(MAX_TOKEN_CELLS), 무효는 undefined. */
function coerceSpanCells(v: unknown): number | undefined {
  if (typeof v !== 'number' || !Number.isFinite(v) || v <= 0) return undefined
  return Math.max(0.25, Math.min(MAX_TOKEN_CELLS, v))
}

/** 버튼 토큰 상태별 효과음(base/hover/press) 정규화 — 각 값은 문자열(asset ref/data URL)만·캡, 빈 값은 드롭.
 *  전부 비면 undefined(필드 자체 제거). */
function coerceSounds(s: unknown): { base?: string; hover?: string; press?: string } | undefined {
  if (!s || typeof s !== 'object') return undefined
  const o = s as Record<string, unknown>
  const pick = (v: unknown): string | undefined => (typeof v === 'string' && v ? capImage(v) : undefined)
  const base = pick(o.base)
  const hover = pick(o.hover)
  const press = pick(o.press)
  return base || hover || press ? { base, hover, press } : undefined
}

function coerceToken(t: unknown): Token | null {
  if (!t || typeof t !== 'object') return null
  const o = t as Record<string, unknown>
  if (typeof o.id !== 'string' || !o.id) return null
  return {
    id: o.id,
    x: clampCoord(o.x),
    y: clampCoord(o.y),
    size:
      typeof o.size === 'number' && Number.isFinite(o.size) && o.size > 0
        ? Math.min(o.size, MAX_TOKEN_CELLS)
        : 1,
    // 비정방 스트레치 비율(가로·세로 칸) — 둘 다 있을 때만 의미(크기 자체는 size=긴 변).
    w: coerceSpanCells(o.w),
    h: coerceSpanCells(o.h),
    rotation: typeof o.rotation === 'number' && Number.isFinite(o.rotation) ? o.rotation : undefined,
    charPlayerId: capId(o.charPlayerId),
    label: typeof o.label === 'string' ? o.label.slice(0, 200) : undefined,
    color: typeof o.color === 'string' ? o.color.slice(0, 32) : undefined,
    image: capImage(o.image),
    layer: coerceLayer(o.layer),
    z: typeof o.z === 'number' && Number.isFinite(o.z) ? o.z : 0,
    flipX: o.flipX === true ? true : undefined,
    hideName: o.hideName === true ? true : undefined,
    hideUI: o.hideUI === true ? true : undefined,
    allowedPlayers: coercePlayerIds(o.allowedPlayers),
    // 이미지 카드 — 디스크 로드 시에도 보존(없으면 undefined). 최대 20장.
    images: Array.isArray(o.images) ? capImageList(o.images, 20) : undefined,
    currentIndex:
      typeof o.currentIndex === 'number' && Number.isInteger(o.currentIndex) && o.currentIndex >= 0
        ? o.currentIndex
        : undefined,
    // 패널 속성 — 디스크 로드 시 보존.
    lockPos: o.lockPos === true ? true : undefined,
    lockSize: o.lockSize === true ? true : undefined,
    terrain: o.terrain === true ? true : undefined,
    memo: typeof o.memo === 'string' ? o.memo.slice(0, 500) || undefined : undefined,
    clickAction: typeof o.clickAction === 'string' ? o.clickAction.slice(0, 500) || undefined : undefined,
    backImage: capImage(o.backImage),
    bars: coerceBars(o.bars),
    statsPrivate: o.statsPrivate === true ? true : undefined,
    importId: capId(o.importId), // 가져오기 출처 태그(로드·가져오기 보존)
    mapIds: coercePlayerIds(o.mapIds), // 표시 맵 제한(통합 레이어 · 로드·가져오기 보존)
    liveStanding: o.liveStanding === true ? true : undefined, // 라이브 스탠딩 토큰(로스터 참조 렌더)
    // 버튼 토큰 — hover/press 교체 이미지·상태별 효과음(디스크 로드 시 보존).
    hoverImage: capImage(o.hoverImage),
    pressImage: capImage(o.pressImage),
    sounds: coerceSounds(o.sounds),
    ...visFields(coerceVisibility(o.visibility) ?? (o.hidden === true ? 'private' : undefined))
  }
}
function coerceStroke(s: unknown): Stroke | null {
  if (!s || typeof s !== 'object') return null
  const o = s as Record<string, unknown>
  if (typeof o.id !== 'string' || !o.id) return null
  const pts: number[] = []
  for (const v of Array.isArray(o.points) ? o.points : []) {
    if (typeof v === 'number' && Number.isFinite(v)) pts.push(v)
    if (pts.length >= 4000) break
  }
  if (pts.length % 2 !== 0) pts.pop()
  if (pts.length < 2) return null
  return {
    id: o.id,
    playerId: typeof o.playerId === 'string' ? o.playerId : '',
    color: typeof o.color === 'string' ? o.color : '#ffffff',
    width: typeof o.width === 'number' && Number.isFinite(o.width) ? Math.max(1, Math.min(40, o.width)) : 4,
    points: pts
  }
}
function coerceBackground(bg: unknown): MapBackground | null {
  if (!bg || typeof bg !== 'object') return null
  const o = bg as Record<string, unknown>
  return {
    image: capImage(o.image),
    w: clampCoord(o.w),
    h: clampCoord(o.h),
    fit: o.fit === 'contain' || o.fit === 'cover' ? o.fit : undefined
  }
}
/** 맵 바탕 정규화 — 이미지 캡·블러 0~40 클램프. 이미지 없으면 undefined(바탕 없음). */
function coerceBackdrop(v: unknown): MapBackdrop | undefined {
  if (!v || typeof v !== 'object') return undefined
  const o = v as Record<string, unknown>
  const image = capImage(o.image)
  if (!image) return undefined
  const blur =
    typeof o.blur === 'number' && Number.isFinite(o.blur) ? Math.max(0, Math.min(40, o.blur)) : undefined
  return blur ? { image, blur } : { image }
}
/** VN 레이어 배열 정규화 — 이미지 캡, 개수 상한(16), z/opacity/오프셋/배율 클램프. 무효/캡초과는 제외. 빈 결과는 undefined. */
function coerceVnLayers(arr: unknown): VnLayer[] | undefined {
  if (!Array.isArray(arr)) return undefined
  // 오프셋(-100~100%)·배율(20~300%) — 편집 UI 슬라이더와 같은 범위(저장 가능 공간=편집 가능 공간).
  // 기본값(0/100)은 저장하지 않아 와이어를 가볍게 유지.
  const offset = (v: unknown): number | undefined => {
    if (typeof v !== 'number' || !Number.isFinite(v)) return undefined
    const n = Math.round(Math.max(-100, Math.min(100, v)))
    return n === 0 ? undefined : n
  }
  const scaleOf = (v: unknown): number | undefined => {
    if (typeof v !== 'number' || !Number.isFinite(v)) return undefined
    const n = Math.round(Math.max(20, Math.min(300, v)))
    return n === 100 ? undefined : n
  }
  const out: VnLayer[] = []
  for (const v of arr) {
    if (!v || typeof v !== 'object') continue
    const o = v as Record<string, unknown>
    const image = capImage(o.image)
    if (!image) continue // 이미지 없음 또는 캡 초과(드롭) → 레이어 아님
    out.push({
      id: typeof o.id === 'string' && o.id ? o.id.slice(0, 200) : randomUUID(),
      image,
      z: typeof o.z === 'number' && Number.isFinite(o.z) ? o.z : out.length,
      opacity:
        typeof o.opacity === 'number' && Number.isFinite(o.opacity)
          ? Math.max(0, Math.min(1, o.opacity))
          : undefined,
      fit: o.fit === 'contain' ? 'contain' : o.fit === 'cover' ? 'cover' : undefined,
      front: o.front === true ? true : undefined,
      x: offset(o.x),
      y: offset(o.y),
      scale: scaleOf(o.scale)
    })
    if (out.length >= 16) break
  }
  return out.length ? out : undefined
}
/** VN 배경 흐림 강도 정규화 — 0~40, 0/무효는 undefined(없음). */
function coerceVnBlur(v: unknown): number | undefined {
  if (typeof v !== 'number' || !Number.isFinite(v)) return undefined
  const n = Math.round(Math.max(0, Math.min(40, v)))
  return n > 0 ? n : undefined
}
function coerceLoadedMap(gm: unknown): RoomMap | null {
  if (!gm || typeof gm !== 'object') return null
  const o = gm as Record<string, unknown>
  if (typeof o.id !== 'string' || !o.id) return null
  // 맵당 오브젝트 개수 상한 — 디스크 로드·가져오기 등 모든 진입점 방어(수정 클라의 대량 emit 차단).
  const tokens = new Map<string, Token>()
  for (const t of Array.isArray(o.tokens) ? o.tokens : []) {
    if (tokens.size >= MAX_TOKENS_PER_MAP) break
    const c = coerceToken(t)
    if (c) tokens.set(c.id, c)
  }
  const drawings = new Map<string, Stroke>()
  for (const s of Array.isArray(o.drawings) ? o.drawings : []) {
    if (drawings.size >= MAX_DRAWINGS_PER_MAP) break
    const c = coerceStroke(s)
    if (c) drawings.set(c.id, c)
  }
  const texts = new Map<string, MapText>()
  for (const t of Array.isArray(o.texts) ? o.texts : []) {
    if (texts.size >= MAX_TEXTS_PER_MAP) break
    const c = coerceMapText(t)
    if (c) texts.set(c.id, c)
  }
  const grid = o.grid && typeof o.grid === 'object' ? (o.grid as Record<string, unknown>) : {}
  const size =
    typeof grid.size === 'number' ? Math.round(Math.max(8, Math.min(512, grid.size))) : DEFAULT_GRID.size
  return {
    id: o.id,
    name: typeof o.name === 'string' && o.name ? o.name : '맵',
    background: coerceBackground(o.background),
    grid: { size, visible: grid.visible !== false },
    tokens,
    drawings,
    texts,
    vnBackground: capImage(o.vnBackground),
    vnBackgroundBlur: coerceVnBlur(o.vnBackgroundBlur),
    vnLayers: coerceVnLayers(o.vnLayers),
    bgColor: coerceDimColor(o.bgColor),
    backdrop: coerceBackdrop(o.backdrop),
    crossfade: o.crossfade === true ? true : undefined,
    hiddenLayers: coerceHiddenLayers(o.hiddenLayers),
    // 번들 BGM — 키가 있을 때만 정규화(없으면 undefined 유지=미저장). 최대 5·중복 제거는 coerceLoadedBgmList.
    bgm: o.bgm !== undefined ? coerceLoadedBgmList(o.bgm) : undefined,
    importId: capId(o.importId) // 가져오기 출처 태그(배치 연동 삭제용)
  }
}
function coerceLoadedHandout(h: unknown): Handout | null {
  if (!h || typeof h !== 'object') return null
  const o = h as Record<string, unknown>
  if (typeof o.id !== 'string' || !o.id) return null
  const scope: HandoutScope = o.scope === 'all' || o.scope === 'targeted' ? o.scope : 'private'
  const now = Date.now()
  return {
    id: o.id,
    title: typeof o.title === 'string' ? o.title.slice(0, 200) : '',
    body: typeof o.body === 'string' ? o.body.slice(0, 20000) : '',
    image: capImage(o.image),
    tags: Array.isArray(o.tags) ? o.tags.filter((t): t is string => typeof t === 'string').slice(0, 40) : [],
    scope,
    targets:
      scope === 'targeted' && Array.isArray(o.targets)
        ? o.targets.filter((t): t is string => typeof t === 'string')
        : [],
    createdAt: typeof o.createdAt === 'number' ? o.createdAt : now,
    updatedAt: typeof o.updatedAt === 'number' ? o.updatedAt : now
  }
}
/** 불러온 BGM 트랙 1개 정규화 — set 요청과 달리 저장된 playing 상태를 보존. 무효면 null. */
function coerceLoadedBgm(b: unknown): BgmState | null {
  if (!b || typeof b !== 'object') return null
  const o = b as Record<string, unknown>
  if (typeof o.src !== 'string' || !o.src) return null
  if (typeof o.kind !== 'string' || !BGM_KINDS.includes(o.kind)) return null
  return {
    trackId: typeof o.trackId === 'string' && o.trackId ? o.trackId : 'bgm',
    kind: o.kind as BgmState['kind'],
    src: o.src,
    title: typeof o.title === 'string' ? o.title.slice(0, 200) : '',
    loop: o.loop !== false,
    playing: o.playing === true,
    volume: clampVol(o.volume)
  }
}

/**
 * 불러온 BGM 트랙 목록 정규화. 배열이면 각 트랙 정규화(최대 5), 구버전 단일 객체면 배열로 마이그레이션,
 * null/없음이면 빈 배열. 중복 trackId 는 뒤엣것 우선.
 */
function coerceLoadedBgmList(b: unknown): BgmState[] {
  const raw = Array.isArray(b) ? b : b && typeof b === 'object' ? [b] : []
  const out: BgmState[] = []
  const seen = new Set<string>()
  for (const item of raw) {
    const t = coerceLoadedBgm(item)
    if (!t) continue
    if (seen.has(t.trackId)) {
      out[out.findIndex((x) => x.trackId === t.trackId)] = t
    } else if (out.length < MAX_BGM_TRACKS) {
      seen.add(t.trackId)
      out.push(t)
    }
  }
  return out
}

/** ~문장~ 행동지문 색 정규화 — #rgb/#rrggbb hex 만 허용, 그 외/빈값이면 undefined(해제). */
function coerceDimColor(v: unknown): string | undefined {
  if (typeof v !== 'string' || !v) return undefined
  const s = v.trim().toLowerCase()
  return /^#[0-9a-f]{3}$/.test(s) || /^#[0-9a-f]{6}$/.test(s) ? s : undefined
}

/** 성공 단계별 연출 카드 키 — 와이어/디스크 무효 키 방어용 화이트리스트. */
const CUTIN_LEVELS: SuccessLevel[] = ['critical', 'extreme', 'hard', 'regular', 'fail', 'fumble']

/** 성공 단계별 연출 카드 맵 정규화 — 유효 단계 키 + 캡 이하 이미지만. 빈 맵이면 undefined. */
function coerceCutInImages(v: unknown): Partial<Record<SuccessLevel, string>> | undefined {
  if (!v || typeof v !== 'object') return undefined
  const src = v as Record<string, unknown>
  const out: Partial<Record<SuccessLevel, string>> = {}
  for (const lv of CUTIN_LEVELS) {
    const img = capImage(src[lv])
    if (img) out[lv] = img
  }
  return Object.keys(out).length ? out : undefined
}

/** GM 커스텀 광기표 정규화 — realtime/summary 각 문자열 배열(최대 10개·각 500자). 둘 다 비면 undefined. */
function coerceMadnessTables(v: unknown): MadnessTables | undefined {
  if (!v || typeof v !== 'object') return undefined
  const o = v as Record<string, unknown>
  // 항목 수 가변 — 40개·500자 캡. 빈 행은 보존(클라가 빈 표면 기본표 폴백).
  const norm = (a: unknown): string[] =>
    (Array.isArray(a) ? a : [])
      .filter((s): s is string => typeof s === 'string')
      .slice(0, 40)
      .map((s) => s.slice(0, 500))
  // 구버전 키(realtime 단일) → realtimeTemp 로 마이그레이션.
  const realtimeTemp = norm(o.realtimeTemp ?? o.realtime)
  const realtimeIndef = norm(o.realtimeIndef)
  const summary = norm(o.summary)
  if (realtimeTemp.length === 0 && realtimeIndef.length === 0 && summary.length === 0) return undefined
  return { realtimeTemp, realtimeIndef, summary }
}

/**
 * 채팅 두상 풀 분리 — 같은 두상이 여러 메시지에 반복되므로 풀(avatarPool)로 묶고 메시지는 avatarRef(인덱스)만 보관.
 * 디스크 저장·입장 스냅샷에서 사용(메시지 수 비례 두상 중복 폭증 방지). 런타임·증분(chat:new)은 avatar 인라인 유지.
 */
function packAvatars(messages: ChatMessage[]): { messages: ChatMessage[]; avatarPool: string[] } {
  const pool: string[] = []
  const idx = new Map<string, number>()
  const out = messages.map((m): ChatMessage => {
    if (!m.avatar) return m
    let i = idx.get(m.avatar)
    if (i === undefined) {
      i = pool.length
      pool.push(m.avatar)
      idx.set(m.avatar, i)
    }
    const copy: ChatMessage = { ...m, avatarRef: i }
    delete copy.avatar
    return copy
  })
  return { messages: out, avatarPool: pool }
}

/**
 * 이 메시지를 볼 수 있는 사람인지 — 귓속말·비밀 메시지는 당사자에게만 보인다.
 *   공개(main/ooc)      누구나
 *   귓속말(whisper)     보낸 사람 + 받는 사람만 (GM 도 제3자면 못 본다)
 *   비밀(secret)        보낸 사람 + GM 만
 *   그룹(group)         채널 접근권이 있는 사람만 — 판정은 호출 측(채널 멤버십)에 위임한다.
 * 히스토리에 저장은 하되 '보낼 때' 반드시 이 필터를 통과시킨다(클라 은닉을 믿지 않는다).
 */
export function canSeeMessage(
  m: ChatMessage,
  viewer: { playerId: string; role: Participant['role'] },
  canAccessGroup?: (groupId: string) => boolean
): boolean {
  if (m.secret) return m.playerId === viewer.playerId || viewer.role === 'GM'
  if (m.channel === 'whisper') return m.playerId === viewer.playerId || m.to === viewer.playerId
  if (m.channel === 'group' && m.groupId) return canAccessGroup ? canAccessGroup(m.groupId) : false
  return true
}

/** packAvatars 역연산 — avatarRef 를 풀에서 찾아 avatar 인라인으로 복원(런타임 메시지로). */
function unpackAvatars(messages: ChatMessage[], pool: string[]): ChatMessage[] {
  return messages.map((m): ChatMessage => {
    if (typeof m.avatarRef !== 'number') return m
    const copy: ChatMessage = { ...m }
    const avatar = pool[m.avatarRef]
    delete copy.avatarRef
    if (avatar) copy.avatar = avatar
    return copy
  })
}

/** 새 빈 맵 생성(서버 내부). */
function makeMap(name: string): RoomMap {
  return {
    id: randomUUID(),
    name,
    background: null,
    grid: { ...DEFAULT_GRID },
    tokens: new Map(),
    drawings: new Map(),
    texts: new Map()
  }
}
/** 서버 내부 RoomMap → 와이어 GameMap(토큰·드로잉·텍스트 배열화). */
function toWireMap(m: RoomMap): GameMap {
  return {
    id: m.id,
    name: m.name,
    background: m.background,
    grid: m.grid,
    tokens: [...m.tokens.values()].sort(
      (a, b) => LAYER_ORDER[a.layer ?? 'token'] - LAYER_ORDER[b.layer ?? 'token'] || (a.z ?? 0) - (b.z ?? 0)
    ),
    drawings: [...m.drawings.values()],
    texts: [...m.texts.values()],
    vnBackground: m.vnBackground,
    vnBackgroundBlur: m.vnBackgroundBlur,
    vnLayers: m.vnLayers,
    bgColor: m.bgColor,
    backdrop: m.backdrop,
    crossfade: m.crossfade,
    hiddenLayers: m.hiddenLayers,
    bgm: m.bgm,
    importId: m.importId
  }
}

/** 핸드아웃 가시성(서버 권위). GM=전부 / private=GM만 / all=전체 / targeted=대상만. */
export function canViewHandout(h: Handout, viewer: { playerId: string; role: Participant['role'] }): boolean {
  if (viewer.role === 'GM') return true
  if (h.scope === 'private') return false
  if (h.scope === 'all') return true
  return h.targets.includes(viewer.playerId)
}

/** 저장 슬롯 배열 정규화(로드용) — 최대 3, 맵 재정규화(coerceLoadedMap→toWireMap), 무효/빈 맵 슬롯 제외. 빈 결과=undefined. */
function coerceSaveSlots(v: unknown): SaveSlot[] | undefined {
  if (!Array.isArray(v)) return undefined
  const out: SaveSlot[] = []
  for (const s of v) {
    if (out.length >= 3) break
    if (!s || typeof s !== 'object') continue
    const o = s as Record<string, unknown>
    const maps: GameMap[] = []
    for (const g of Array.isArray(o.maps) ? o.maps : []) {
      const m = coerceLoadedMap(g)
      if (m) maps.push(toWireMap(m))
    }
    if (!maps.length) continue // 맵 없는 슬롯은 복원 불가 → 제외
    const activeMapId =
      typeof o.activeMapId === 'string' && maps.some((m) => m.id === o.activeMapId)
        ? o.activeMapId
        : maps[0].id
    out.push({
      id: typeof o.id === 'string' && o.id ? o.id.slice(0, 60) : randomUUID(),
      name: (typeof o.name === 'string' ? o.name.trim() : '').slice(0, 60) || `저장 ${out.length + 1}`,
      savedAt: typeof o.savedAt === 'number' && Number.isFinite(o.savedAt) ? o.savedAt : Date.now(),
      maps,
      activeMapId,
      bgm: coerceLoadedBgmList(o.bgm),
      // 통합 레이어 스냅샷 — 키 있을 때만(구버전 슬롯은 undefined 유지 → 로드 시 현재 것 보존).
      globalTokens:
        o.globalTokens !== undefined
          ? [...(coerceGlobalTokens(o.globalTokens)?.values() ?? [])]
          : undefined
    })
  }
  return out.length ? out : undefined
}

/** 카드 음향 재생 길이(초) 정규화 — 음향 있을 때만 1~600 정수, 그 외 undefined(음원 끝까지). */
function coerceSoundSec(v: unknown, sound: string | undefined): number | undefined {
  if (!sound || typeof v !== 'number' || !Number.isFinite(v)) return undefined
  const n = Math.round(v)
  return n >= 1 ? Math.min(n, 600) : undefined
}
/** 숨긴 레이어 목록 정규화 — 알려진 밴드(REORDER_BANDS)만·중복 제거. 빈 결과=undefined(전부 표시). */
function coerceHiddenLayers(v: unknown): TokenLayer[] | undefined {
  if (!Array.isArray(v)) return undefined
  const out: TokenLayer[] = []
  for (const x of v) {
    if (REORDER_BANDS.includes(x as TokenLayer) && !out.includes(x as TokenLayer)) out.push(x as TokenLayer)
  }
  return out.length ? out : undefined
}
/** 카드 표시 시간(초) 정규화 — 이미지 있을 때만 1~600 정수, 그 외 undefined(클릭할 때까지 표시). */
function coerceDisplaySec(v: unknown, image: string | undefined): number | undefined {
  if (!image || typeof v !== 'number' || !Number.isFinite(v)) return undefined
  const n = Math.round(v)
  return n >= 1 ? Math.min(n, 600) : undefined
}

// 채팅 꾸미기 마크업 벗기기 — 카드 키워드 매칭을 '화면에 보이는 평문' 기준으로 하기 위한 미러.
// 문법·태그 목록은 렌더러 lib/chat/markup.ts 와 동일해야 한다: [a-z] 태그만 마크업이고,
// 모르는 태그([대성공]·[HIT] 같은 비 화이트리스트 대괄호)는 클라가 글자 그대로 보여주므로 여기서도 남긴다.
const MARKUP_TAG_RE = /\[(\/?)([a-z]+)(?:=[^\]]*)?\]/g
const MARKUP_TAGS = new Set([
  'b', 'i', 'u', 's', 'color', 'bg', 'size', 'ruby', 'center', 'right', 'left',
  'box', 'bubble', 'bar', 'img', 'dim', 'roll'
])
/** 보이드 태그 — 그 자리에 별도 객체(이미지·굴림 숫자·막대)가 렌더되므로 공백으로 치환해,
 *  앞뒤 글자가 이어붙어 화면에 없는 단어가 생기는 오발동을 막는다. 감싸기 태그는 표시 폭이 없어 제거. */
const MARKUP_VOID = new Set(['bar', 'img', 'roll'])
function stripChatMarkup(src: string): string {
  return (
    src
      .replace(MARKUP_TAG_RE, (raw, _closing, name) =>
        MARKUP_TAGS.has(name) ? (MARKUP_VOID.has(name) ? ' ' : '') : raw
      )
      // 인라인 강조(*기울임*·**굵게**)의 별표는 렌더에서 사라지므로 매칭에서도 제거 — "*대성공*" 강조 발동.
      .replace(/\*/g, '')
  )
}

/** 비주얼 카드 배열 정규화(로드용) — 최대 30, 이름 필수·40캡, 이미지/음향 캡·둘 다 없으면 제외. 빈 결과=undefined. */
function coerceVisualCards(v: unknown): VisualCard[] | undefined {
  if (!Array.isArray(v)) return undefined
  const out: VisualCard[] = []
  for (const c of v) {
    if (out.length >= 30) break
    if (!c || typeof c !== 'object') continue
    const o = c as Record<string, unknown>
    const name = (typeof o.name === 'string' ? o.name.trim() : '').slice(0, 40)
    if (!name) continue
    const image = capImage(o.image)
    const sound = capImage(o.sound)
    if (!image && !sound) continue // 이미지·음향 둘 다 없음 → 카드 아님
    out.push({
      id: typeof o.id === 'string' && o.id ? o.id.slice(0, 60) : randomUUID(),
      name,
      image,
      sound,
      soundSec: coerceSoundSec(o.soundSec, sound),
      displaySec: coerceDisplaySec(o.displaySec, image)
    })
  }
  return out.length ? out : undefined
}

/** 통합 레이어 토큰 정규화(로드용) — 배열→Map, coerceToken·개수 상한. 빈 결과=undefined. */
function coerceGlobalTokens(v: unknown): Map<string, Token> | undefined {
  if (!Array.isArray(v)) return undefined
  const tokens = new Map<string, Token>()
  for (const t of v) {
    if (tokens.size >= MAX_TOKENS_PER_MAP) break
    const c = coerceToken(t)
    if (c) tokens.set(c.id, c)
  }
  return tokens.size ? tokens : undefined
}

/** 방 → 영속 파일(JSON). 장면·메타·멤버·전체 채팅. 참가자/프레즌스는 런타임이라 제외. */
function roomToFile(room: Room): Record<string, unknown> {
  const { messages, avatarPool } = packAvatars(room.messages) // 채팅 두상 풀 분리 — 파일 크기 절감
  return {
    id: room.id,
    code: room.code,
    title: room.title,
    ownerId: room.ownerId,
    members: [...room.members],
    // 세션 멤버 명단(playerId 기준 · 이미지 없는 경량) — 재시작에도 '한번 접속한 멤버'를 권한 대상으로 유지.
    // connected 는 런타임 상태라 저장 안 함(로드 시 전부 오프라인 → 재접속하면 admit 이 갱신).
    participantList: [...room.participants.values()].map((p) => ({
      playerId: p.playerId,
      nick: p.nick,
      color: p.color,
      role: p.role
    })),
    cardImage: room.cardImage,
    maps: [...room.maps.values()].map(toWireMap),
    activeMapId: room.activeMapId,
    handouts: [...room.handouts.values()],
    appearance: room.appearance,
    cutInImage: room.cutInImage,
    cutInImages: room.cutInImages,
    dimColor: room.dimColor,
    madnessTables: room.madnessTables, // GM 커스텀 광기표
    luckEnabled: room.luckEnabled, // 행운 깎기 사용 여부
    vnOverlay: room.vnOverlay, // 일반 맵 VN 오버레이 표시 여부
    bgm: room.bgm,
    channels: [...room.channels.values()],
    messages,
    avatarPool, // 채팅 두상 풀
    charRooms: Object.fromEntries(room.charRooms), // 방별 시트 멤버십
    saveSlots: room.saveSlots ?? [], // 저장 슬롯(반면 전체 명명 저장 · 최대 3)
    visualCards: room.visualCards ?? [], // 비주얼 카드 — 이미지/음향
    globalTokens: room.globalTokens ? [...room.globalTokens.values()] : [], // 통합 레이어 토큰
    createdAt: room.createdAt,
    lastActivityAt: room.lastActivityAt
  }
}

/** 영속 파일 → 방(방어적 정규화). 참가자/프레즌스는 빈 상태(재입장 시 재구성). */
function roomFromFile(data: unknown): Room | null {
  if (!data || typeof data !== 'object') return null
  const o = data as Record<string, unknown>
  if (typeof o.id !== 'string' || !o.id || typeof o.code !== 'string' || !o.code) return null
  const maps = new Map<string, RoomMap>()
  for (const gm of Array.isArray(o.maps) ? o.maps : []) {
    const m = coerceLoadedMap(gm)
    if (m) maps.set(m.id, m)
  }
  if (maps.size === 0) {
    const m = makeMap('맵 1')
    maps.set(m.id, m)
  }
  const handouts = new Map<string, Handout>()
  for (const h of Array.isArray(o.handouts) ? o.handouts : []) {
    const c = coerceLoadedHandout(h)
    if (c) handouts.set(c.id, c)
  }
  // 채팅 두상 풀 복원 — avatarRef 를 풀에서 avatar 인라인으로 되돌림(런타임 메시지).
  const avatarPool = Array.isArray(o.avatarPool)
    ? o.avatarPool.filter((x): x is string => typeof x === 'string')
    : []
  const messages = unpackAvatars(
    Array.isArray(o.messages) ? (o.messages.filter((m) => m && typeof m === 'object') as ChatMessage[]) : [],
    avatarPool
  )
  // 방별 시트 멤버십 복원 — { playerId: charId[] } 객체.
  const charRooms = new Map<string, string[]>()
  if (o.charRooms && typeof o.charRooms === 'object') {
    for (const [pid, ids] of Object.entries(o.charRooms as Record<string, unknown>)) {
      if (Array.isArray(ids))
        charRooms.set(
          pid,
          ids.filter((x): x is string => typeof x === 'string')
        )
    }
  }
  // 세션 멤버 명단 복원 — 재시작에도 한번 접속한 멤버를 권한 대상으로 유지. 전부 오프라인(connected:false)으로 시작.
  const participants = new Map<string, Participant>()
  for (const p of Array.isArray(o.participantList) ? o.participantList : []) {
    if (!p || typeof p !== 'object') continue
    const pp = p as Record<string, unknown>
    if (typeof pp.playerId !== 'string' || !pp.playerId) continue
    participants.set(pp.playerId, {
      playerId: pp.playerId,
      nick: typeof pp.nick === 'string' && pp.nick ? pp.nick.slice(0, 80) : '탐사자',
      color: typeof pp.color === 'string' && pp.color ? pp.color.slice(0, 32) : DEFAULT_PL_COLOR,
      role: pp.role === 'GM' ? 'GM' : 'PL',
      connected: false
    })
  }
  const now = Date.now()
  return {
    id: o.id,
    code: o.code,
    title: typeof o.title === 'string' && o.title ? o.title : '세션',
    ownerId: typeof o.ownerId === 'string' ? o.ownerId : '',
    members: new Set(
      Array.isArray(o.members) ? o.members.filter((m): m is string => typeof m === 'string') : []
    ),
    cardImage: typeof o.cardImage === 'string' && o.cardImage ? o.cardImage : undefined,
    participants, // 영속 복원된 세션 멤버(전부 오프라인) — 재접속 시 admit 이 connected 갱신
    characters: new Map(),
    handouts,
    maps,
    activeMapId:
      typeof o.activeMapId === 'string' && maps.has(o.activeMapId)
        ? o.activeMapId
        : (maps.keys().next().value as string),
    appearance: normalizeAppearance(o.appearance as Partial<Appearance> | undefined),
    cutInImage: capImage(o.cutInImage),
    cutInImages: coerceCutInImages(o.cutInImages),
    dimColor: coerceDimColor(o.dimColor),
    madnessTables: coerceMadnessTables(o.madnessTables), // GM 커스텀 광기표
    luckEnabled: typeof o.luckEnabled === 'boolean' ? o.luckEnabled : undefined, // 행운 깎기 사용 여부(미설정=기본 사용)
    vnOverlay: typeof o.vnOverlay === 'boolean' ? o.vnOverlay : undefined, // VN 오버레이 표시 여부(미설정=꺼짐)
    bgm: coerceLoadedBgmList(o.bgm),
    combat: null, // 전투는 in-memory(비영속) — 재시작 시 초기화
    saveSlots: coerceSaveSlots(o.saveSlots), // 저장 슬롯 복원(최대 3)
    visualCards: coerceVisualCards(o.visualCards), // 비주얼 카드 복원
    globalTokens: coerceGlobalTokens(o.globalTokens), // 통합 레이어 토큰 복원
    channels: coerceChannels(o.channels),
    messages,
    charRooms,
    createdAt: typeof o.createdAt === 'number' ? o.createdAt : now,
    lastActivityAt: typeof o.lastActivityAt === 'number' ? o.lastActivityAt : now
  }
}

/** 그룹 채널 정규화(로드용) — id 필수, 이름 80·멤버 64 캡. */
function normalizeChannel(c: unknown): Channel | null {
  if (!c || typeof c !== 'object') return null
  const o = c as Record<string, unknown>
  const id = typeof o.id === 'string' && o.id ? o.id.slice(0, 200) : ''
  if (!id) return null
  const members = Array.isArray(o.members)
    ? o.members.filter((m): m is string => typeof m === 'string').slice(0, 64)
    : []
  return { id, name: typeof o.name === 'string' ? o.name.slice(0, 80) : '', members }
}
function coerceChannels(arr: unknown): Map<string, Channel> {
  const m = new Map<string, Channel>()
  for (const c of Array.isArray(arr) ? arr : []) {
    const n = normalizeChannel(c)
    if (n) m.set(n.id, n)
  }
  return m
}

/** 전투 상태 방어적 정규화(GM 입력). null/무효/빈 목록=전투 종료. 항목 64·이름 80·id 200 캡, 수치 클램프. */
function normalizeCombat(state: unknown): CombatState | null {
  if (!state || typeof state !== 'object') return null
  const o = state as Record<string, unknown>
  const num = (v: unknown, d: number): number =>
    typeof v === 'number' && Number.isFinite(v) ? Math.max(-100000, Math.min(100000, Math.round(v))) : d
  const list = Array.isArray(o.combatants) ? o.combatants.slice(0, 64) : []
  const combatants: Combatant[] = []
  for (const c of list) {
    if (!c || typeof c !== 'object') continue
    const r = c as Record<string, unknown>
    const id = typeof r.id === 'string' && r.id ? r.id.slice(0, 200) : ''
    if (!id) continue
    const cc: Combatant = {
      id,
      name: typeof r.name === 'string' ? r.name.slice(0, 80) : '',
      initiative: num(r.initiative, 0)
    }
    if (typeof r.charPlayerId === 'string' && r.charPlayerId) cc.charPlayerId = r.charPlayerId.slice(0, 200)
    if (typeof r.hp === 'number') cc.hp = num(r.hp, 0)
    if (typeof r.hpMax === 'number') cc.hpMax = num(r.hpMax, 0)
    combatants.push(cc)
  }
  if (combatants.length === 0) return null // 빈 전투 = 종료
  const round = Math.max(1, num(o.round, 1))
  const turn = Math.max(0, Math.min(combatants.length - 1, num(o.turn, 0)))
  return { round, turn, combatants }
}

export class RoomStore {
  private rooms = new Map<string, Room>() // key: roomId
  // GM 선택지 서버 보관 — key=`${roomId}:${messageId}`. 옵션(스크립트 포함·비공개) + 응답자(1회 제한). 휘발(비영속).
  private choices = new Map<
    string,
    { options: { id: string; label: string; script?: string }[]; responders: Set<string> }
  >()
  private codeToId = new Map<string, string>() // 정규화 코드 -> roomId
  private persist: boolean
  private roomDir: string
  private savedAt = new Map<string, number>() // roomId -> 마지막 저장 시점의 lastActivityAt
  private flushing = new Map<string, Promise<void>>() // 비동기 저장 진행 중인 roomId — 겹쳐쓰기 방지(직전 쓰기 끝나기 전 재진입 차단)
  /**
   * 저장이 말썽인 방 — roomId → 사유.
   * 저장 실패는 서버가 도는 동안에는 아무 티가 안 난다(메모리가 진실원본이라 화면은 멀쩡하다).
   * 그러다 재시작하면 그 사이 대화가 통째로 사라지므로, 관리 화면에서 미리 보이게 들고 있는다.
   */
  private saveTrouble = new Map<string, string>()
  /**
   * 이미 잃어버린 것에 대한 기록 — 저장이 나중에 잘된다고 사라지면 안 된다.
   * '지금 저장이 되는가'(saveTrouble)와 '이미 무엇을 잃었는가'는 다른 이야기다.
   */
  private saveLoss = new Map<string, string>()
  /** 방 폴더를 이미 만들어 뒀는가 — 대화 한 마디마다 폴더를 다시 만들지 않게. */
  private roomDirReady = false
  /** 방마다 지금 저장이 시작된 시각 — 너무 오래 매달려 있으면 알린다. */
  private flushStartedAt = new Map<string, number>()
  /** 쓰는 중에 또 요청이 와서 '끝나면 한 번 더'로 예약해 둔 방. 예약은 하나면 충분하다. */
  private queued = new Set<string>()

  /** persist:true 면 <dataDir>/rooms/*.json 로드·자동저장. 기본 비영속(테스트 안전). */
  constructor(opts?: { persist?: boolean; dataDir?: string }) {
    this.persist = opts?.persist === true
    this.roomDir = join(opts?.dataDir ?? join(process.cwd(), 'data'), 'rooms')
    if (this.persist) this.loadAll()
  }

  /** 방 폴더는 처음 한 번만 만든다 — 말 한 마디마다 디스크를 두드릴 일은 아니다. */
  private ensureRoomDir(): void {
    if (this.roomDirReady) return
    mkdirSync(this.roomDir, { recursive: true })
    this.roomDirReady = true
  }

  /** 방 하나의 대화 기록장 — 스냅샷 이후에 오간 말만 담기는 덧붙임 파일. */
  private journalPath(id: string): string {
    return join(this.roomDir, id + '.chat.jsonl')
  }

  /**
   * 대화를 그 자리에서 한 줄 덧붙인다.
   *
   * 방 전체 스냅샷은 8초마다 몰아서 쓴다. 그 사이에 서버가 내려가면 그 몇 초가 사라지고,
   * 스냅샷 쓰기가 막힌 방(너무 커서 직렬화가 안 되거나 디스크가 찬 경우)은 재시작하는 순간
   * 마지막 저장 이후가 통째로 사라진다 — 실제로 그렇게 잃었다.
   * 그래서 말은 오간 즉시 이 기록장에 한 줄씩 남기고, 스냅샷이 성공한 만큼만 잘라 낸다.
   * 쓰기가 실패해도 대화 자체는 막지 않는다(대신 관리 화면에 남긴다).
   */
  private journal(roomId: string, entry: Record<string, unknown>): void {
    if (!this.persist) return
    try {
      // 기록장을 처음 여는 순간, 이 방이 무엇인지부터 적어 둔다.
      // 세션 파일이 아직(또는 영영) 없어도 이 한 줄이면 방과 대화를 함께 되살릴 수 있다.
      if (!existsSync(this.journalPath(roomId))) {
        const r = this.rooms.get(roomId)
        if (r) {
          this.ensureRoomDir()
          appendFileSync(
            this.journalPath(roomId),
            JSON.stringify({
              op: 'room',
              r: { id: r.id, code: r.code, title: r.title, ownerId: r.ownerId, members: [...r.members], createdAt: r.createdAt }
            }) + '\n',
            'utf8'
          )
        }
      }
      this.ensureRoomDir()
      appendFileSync(this.journalPath(roomId), JSON.stringify(entry) + '\n', 'utf8')
    } catch (e) {
      this.saveTrouble.set(roomId, `대화 기록장 쓰기 실패: ${String(e)}`)
    }
  }

  /** 스냅샷이 담아낸 만큼(cut 바이트)을 기록장에서 덜어낸다. 그 뒤에 들어온 말은 남긴다. */
  private trimJournal(roomId: string, cut: number): void {
    if (!this.persist || cut <= 0) return
    const p = this.journalPath(roomId)
    try {
      if (!existsSync(p)) return
      const buf = readFileSync(p)
      // 재 두었던 길이보다 파일이 짧아졌다 = 그 사이 누가 갈아치웠다(백업 복원 등).
      // 그 파일은 우리가 아는 파일이 아니므로 손대지 않는다.
      if (buf.length < cut) return
      // 첫 줄(이 방이 무엇인가)은 언제나 남긴다 — 세션 파일이 없어질 때 방을 되살릴 유일한 단서다.
      const nl = buf.indexOf(0x0a)
      const headEnd = nl >= 0 && buf.subarray(0, nl).toString('utf8').includes('"op":"room"') ? nl + 1 : 0
      if (cut <= headEnd) return
      const tail = cut >= buf.length ? Buffer.alloc(0) : buf.subarray(cut)
      // 읽고 쓰는 사이에 다른 말이 끼어들 수 없다(추가도 이 스레드에서 동기로 일어난다).
      writeFileSync(p, Buffer.concat([buf.subarray(0, headEnd), tail]))
    } catch (e) {
      this.saveTrouble.set(roomId, `대화 기록장 정리 실패: ${String(e)}`)
    }
  }

  /** 기록장의 현재 길이(바이트). 스냅샷을 뜨는 순간을 표시해 둘 때 쓴다. */
  private journalSize(roomId: string): number {
    try {
      return existsSync(this.journalPath(roomId)) ? statSync(this.journalPath(roomId)).size : 0
    } catch {
      return 0
    }
  }

  /**
   * 반쪽(축약) 저장이 담기는 비상 사본. 본 저장본(.json)과 이름을 갈라 두는 이유 —
   * 반쪽이 본 저장본을 덮으면 거기 있던 옛 대화의 유일한 디스크 사본이 사라진다.
   */
  private rescuePath(id: string): string {
    return join(this.roomDir, id + '.rescue.json')
  }

  /** 비상 사본을 방으로 읽는다(본 저장본과 같은 꼴). 없거나 못 읽으면 null. */
  private roomFromRescue(id: string): Room | null {
    try {
      if (!existsSync(this.rescuePath(id))) return null
      const room = roomFromFile(JSON.parse(readFileSync(this.rescuePath(id), 'utf8')))
      return room && room.id === id ? room : null
    } catch {
      return null
    }
  }

  /**
   * 비상 사본에만 남은 말을 채워 넣는다 — 기록장 쓰기가 실패했던 몫이 여기서 돌아온다.
   * 기록장이 온전했다면 전부 이미 아는 말이라 0건으로 끝난다.
   * 자리 잡기는 기록장 복구와 같은 규칙: 아는 말 뒤를 가리키는 자리를 옮겨 가며 모르는 말을 끼운다.
   * 사본은 뜬 시점의 과거 상태다 — 그 뒤 기록장이 지웠거나(replay.deleted) 통째로 비운(replay.cleared)
   * 말을 여기서 되살리면 안 된다. 지운 말이 부활하는 것이 놓친 말을 못 줍는 것보다 나쁘다.
   */
  private mergeRescue(room: Room, replay?: { deleted: Set<string>; cleared: boolean }): number {
    if (replay?.cleared) return 0
    const saved = this.roomFromRescue(room.id)
    if (!saved) return 0
    let applied = 0
    const seen = new Set(room.messages.map((m) => m.id))
    let at: number | null = null
    let pending: ChatMessage[] = []
    const placePending = (before: number): void => {
      if (!pending.length) return
      room.messages.splice(before, 0, ...pending)
      pending = []
    }
    for (const m of saved.messages) {
      if (!m.id) continue
      if (replay?.deleted.has(m.id)) continue
      if (seen.has(m.id)) {
        const i = room.messages.findIndex((x) => x.id === m.id)
        if (i >= 0) {
          placePending(i)
          at = room.messages.findIndex((x) => x.id === m.id) + 1
        }
        continue
      }
      if (at === null) pending.push(m)
      else {
        room.messages.splice(at, 0, m)
        at++
      }
      seen.add(m.id)
      applied++
    }
    placePending(room.messages.length)
    if (room.messages.length > MAX_HISTORY) room.messages.splice(0, room.messages.length - MAX_HISTORY)
    return applied
  }

  /** 기록장 머리글만으로 방의 뼈대를 세운다(세션 파일이 없을 때의 마지막 수단). */
  private roomFromJournalHead(id: string): Room | null {
    try {
      const buf = readFileSync(this.journalPath(id))
      const first = splitLines(buf)[0]
      if (!first) return null
      const e = JSON.parse(first.toString('utf8')) as Record<string, unknown>
      if (e.op !== 'room' || !e.r || typeof e.r !== 'object') return null
      const room = roomFromFile(e.r as Record<string, unknown>)
      return room && !this.codeToId.has(room.code) ? room : null
    } catch {
      return null
    }
  }

  /**
   * 스냅샷 이후의 대화를 기록장에서 되살린다.
   * 같은 말을 두 번 넣지 않도록 id 로 거르고, 고침·지움·비움도 순서대로 다시 적용한다.
   *
   * 자리도 기록장이 정한다. 되살릴 말이 스냅샷의 것보다 앞설 수 있어서(반쪽 저장 뒤 복구)
   * 뒤에 붙이면 순서가 뒤집힌다. 시각으로 다시 세우는 것도 못 미덥다 — 같은 밀리초에 오간 말은
   * 가릴 수 없다. 그래서 기록장을 훑으며 '아는 말 바로 뒤'를 가리키는 자리를 옮겨 가고,
   * 모르는 말은 그 자리에 끼워 넣는다. 기록장이 곧 오간 차례이므로 이러면 그대로 복원된다.
   */
  private replayJournal(room: Room): { applied: number; deleted: Set<string>; cleared: boolean } {
    const p = this.journalPath(room.id)
    /** 지운 말의 id 와 비움 여부 — 비상 사본 병합이 지난 상태를 되살리지 않도록 넘겨준다. */
    const deleted = new Set<string>()
    let cleared = false
    if (!existsSync(p)) return { applied: 0, deleted, cleared }
    let applied = 0
    try {
      const seen = new Set(room.messages.map((m) => m.id))
      /** 다음에 모르는 말을 끼워 넣을 자리. 아직 아는 말을 못 만났으면 null. */
      let at: number | null = null
      /** 아는 말을 만나기 전에 나온 모르는 말들 — 그 아는 말 바로 앞에 들어가야 한다. */
      let pending: ChatMessage[] = []
      const placePending = (before: number): void => {
        if (!pending.length) return
        room.messages.splice(before, 0, ...pending)
        pending = []
      }
      // 통째로 문자열로 만들지 않는다 — 되살릴 것이 많은 방일수록 파일이 크고,
      // 문자열 한계에 걸리면 정작 복구가 필요한 순간에 통째로 실패한다.
      const buf = readFileSync(p)
      for (const raw of splitLines(buf)) {
        const line = raw.toString('utf8')
        if (!line.trim()) continue
        let e: Record<string, unknown>
        try {
          e = JSON.parse(line) as Record<string, unknown>
        } catch {
          continue // 내려가는 순간 반쯤 쓰인 줄 — 그 줄만 버린다
        }
        if (e.op === 'add' && e.m && typeof e.m === 'object') {
          const m = e.m as ChatMessage
          if (!m.id) continue
          if (seen.has(m.id)) {
            // 이미 스냅샷에 있는 말이다. 그 앞에 밀려 있던 모르는 말들이 바로 이 자리 앞에 들어간다.
            const i = room.messages.findIndex((x) => x.id === m.id)
            if (i >= 0) {
              placePending(i)
              at = room.messages.findIndex((x) => x.id === m.id) + 1
            }
            continue
          }
          if (at === null) {
            // 아직 기준점이 없다 — 아는 말을 만날 때까지 들고 있는다.
            pending.push(m)
          } else {
            room.messages.splice(at, 0, m)
            at++
          }
          seen.add(m.id)
          applied++
        } else if (e.op === 'edit' && typeof e.id === 'string') {
          const m = room.messages.find((x) => x.id === e.id) ?? pending.find((x) => x.id === e.id)
          if (m) {
            m.text = typeof e.text === 'string' ? e.text : m.text
            m.edited = true
            applied++
          }
        } else if (e.op === 'del' && typeof e.id === 'string') {
          deleted.add(e.id)
          const i = room.messages.findIndex((x) => x.id === e.id)
          if (i >= 0) {
            room.messages.splice(i, 1)
            if (at !== null && at > i) at--
            applied++
          } else {
            const j = pending.findIndex((x) => x.id === e.id)
            if (j >= 0) {
              pending.splice(j, 1)
              applied++
            }
          }
        } else if (e.op === 'room') {
          // 방 머리글 — 되살리기용이라 여기서는 넘긴다.
          continue
        } else if (e.op === 'clear') {
          room.messages = []
          seen.clear()
          pending = []
          at = 0
          cleared = true
          applied++
        }
      }
      // 끝까지 아는 말을 못 만났다 = 기록장이 스냅샷 뒤에 이어지는 몫이다. 뒤에 붙인다.
      placePending(room.messages.length)
      if (room.messages.length > MAX_HISTORY) room.messages.splice(0, room.messages.length - MAX_HISTORY)
    } catch (e) {
      console.error(`[rooms] ${room.id} 대화 기록장 복구 실패:`, e)
    }
    return { applied, deleted, cleared }
  }

  private loadAll(): void {
    try {
      if (!existsSync(this.roomDir)) return
      for (const f of readdirSync(this.roomDir)) {
        // 비상 사본은 본 저장본이 아니다 — 방으로 읽지 않고 아래에서 합치는 재료로만 쓴다.
        if (!f.endsWith('.json') || f.endsWith('.rescue.json')) continue
        try {
          const room = roomFromFile(JSON.parse(readFileSync(join(this.roomDir, f), 'utf8')))
          if (room) {
            // 스냅샷 이후에 오간 말을 이어붙인다 — 지난번에 저장되지 못한 몫이 여기 남아 있다.
            const back = this.replayJournal(room)
            if (back.applied) console.log(`[rooms] ${room.title || room.id}: 저장되지 않았던 대화 ${back.applied}건 복구`)
            // 기록장까지 놓친 말이 비상 사본에 남았을 수 있다(기록장 쓰기가 실패했던 방).
            const extra = this.mergeRescue(room, back)
            if (extra) {
              this.saveLoss.set(room.id, `기록장이 놓친 대화 ${extra}건을 비상 사본에서 되살렸습니다`)
              console.log(`[rooms] ${room.title || room.id}: 비상 사본에서 대화 ${extra}건 복구`)
            }
            this.rooms.set(room.id, room)
            this.codeToId.set(room.code, room.id)
            // 되살린 몫은 아직 스냅샷에 없다 — 저장 대상으로 표시해 다음 자동저장이 접어 넣게 한다.
            // (그러지 않으면 그 방은 조용한 동안 영영 저장되지 않고 기록장만 계속 불어난다.)
            this.savedAt.set(room.id, back.applied || extra ? 0 : room.lastActivityAt)
          }
        } catch (e) {
          this.saveLoss.set(f.replace(/\.json$/, ''), `세션 파일을 읽지 못했습니다: ${String(e)}`)
          console.error(`[rooms] ${f} 로드 실패:`, e)
        }
      }
      // 세션 파일 없이 기록장만 남은 방 — 되살린다.
      // (세션이 처음 저장되기 전에 서버가 내려갔거나, 디스크가 차 큰 저장만 계속 실패한 경우다.)
      for (const f of readdirSync(this.roomDir)) {
        if (!f.endsWith('.chat.jsonl')) continue
        const id = f.slice(0, -'.chat.jsonl'.length)
        if (this.rooms.has(id)) continue
        // 비상 사본이 있으면 그쪽이 온전한 그릇이다(맵·자료까지 담고 있다). 없으면 머리글로 뼈대만 세운다.
        const rescue = this.roomFromRescue(id)
        const rebuilt = rescue && !this.codeToId.has(rescue.code) ? rescue : this.roomFromJournalHead(id)
        if (!rebuilt) {
          this.saveLoss.set(id, '세션 파일도 머리글도 없어 되살리지 못한 대화 기록이 남아 있습니다')
          console.error(`[rooms] ${f}: 짝이 되는 세션 파일이 없습니다.`)
          continue
        }
        const back = this.replayJournal(rebuilt)
        if (rescue && rebuilt !== rescue) this.mergeRescue(rebuilt, back)
        this.rooms.set(rebuilt.id, rebuilt)
        this.codeToId.set(rebuilt.code, rebuilt.id)
        this.savedAt.set(rebuilt.id, 0) // 아직 본 저장본이 없다 — 다음 자동저장이 반드시 쓰게
        this.saveLoss.set(
          id,
          rescue
            ? `세션 파일이 없어 비상 사본과 대화 기록으로 되살렸습니다(대화 ${back.applied}건 복구)`
            : `세션 파일이 없어 대화 기록만으로 되살렸습니다(대화 ${back.applied}건 · 맵·자료는 복구 대상이 아닙니다)`
        )
        console.log(`[rooms] ${rebuilt.title || rebuilt.id}: 세션 파일 없이 대화 ${back.applied}건을 되살렸습니다.`)
      }
      // 기록장조차 없이 비상 사본만 남은 방 — 그것이라도 세운다.
      for (const f of readdirSync(this.roomDir)) {
        if (!f.endsWith('.rescue.json')) continue
        const id = f.slice(0, -'.rescue.json'.length)
        if (this.rooms.has(id)) continue
        const room = this.roomFromRescue(id)
        if (!room || this.codeToId.has(room.code)) {
          // 조용히 넘어가면 그 방이 왜 사라졌는지 아무도 모른다 — 사실만은 남긴다.
          this.saveLoss.set(id, '비상 사본만 남았는데 되살리지 못했습니다(손상되었거나 방 코드가 겹칩니다)')
          continue
        }
        this.rooms.set(room.id, room)
        this.codeToId.set(room.code, room.id)
        this.savedAt.set(room.id, 0)
        this.saveLoss.set(id, '본 저장본이 없어 비상 사본으로 되살렸습니다(덜어냈던 옛 대화는 복구하지 못했습니다)')
        console.log(`[rooms] ${room.title || room.id}: 비상 사본으로 되살렸습니다.`)
      }
      console.log(`[rooms] 영속 세션 ${this.rooms.size}개 로드`)
    } catch (e) {
      console.error('[rooms] 로드 실패:', e)
    }
  }

  /**
   * 방 1개 파일 저장(원자적 tmp→rename). 직렬화는 동기로 '그 시점 상태'를 캡처하고, 디스크 I/O 는 비동기로 처리한다.
   * 동기 직렬화 후 비동기 쓰기로 이벤트 루프 블로킹을 피한다.
   * flushing 가드로 이전 쓰기가 끝나기 전 같은 방을 다시 쓰지 않게 한다(겹쳐쓰기·tmp 경합 방지).
   */
  private flush(room: Room): Promise<void> {
    if (!this.persist) return Promise.resolve()
    // 지워진 방은 쓰지 않는다 — 예약된 뒤따라 쓰기가 삭제 뒤에 도착하면 지운 파일이 되살아난다.
    if (!this.rooms.has(room.id)) return Promise.resolve()
    const inFlight = this.flushing.get(room.id)
    if (inFlight) {
      // 앞선 쓰기가 아직 안 끝났다. 볼륨이 매달리면 이 표시가 영영 안 풀려 그 방만 조용히 저장을 멈춘다 —
      // 서버가 도는 동안에는 아무 티도 안 나다가 재시작하는 순간 그 사이 대화가 사라진다.
      // 오래 걸리면 알려서, 적어도 눈에는 띄게 한다(대화 자체는 기록장이 지킨다).
      const since = this.flushStartedAt.get(room.id) ?? 0
      if (since && Date.now() - since > STUCK_FLUSH_MS) {
        this.saveTrouble.set(room.id, `저장이 ${Math.round((Date.now() - since) / 1000)}초째 끝나지 않습니다(디스크 확인 필요)`)
      }
      // 지금 상태를 그냥 버리면 안 된다 — 진행 중인 쓰기는 그보다 옛 상태를 담고 있다.
      // 끝나는 대로 한 번 더 쓰도록 이어 붙인다(예약은 하나면 족하다).
      if (!this.queued.has(room.id)) {
        this.queued.add(room.id)
        return inFlight.then(() => {
          this.queued.delete(room.id)
          return this.flush(room)
        })
      }
      // 진행 중인 쓰기를 그대로 돌려준다 — 버리면 종료 때 '다 저장했다'는 거짓말이 된다.
      return inFlight
    }
    let json: string
    let at: number
    /** 이번 저장이 오래된 대화를 덜어낸 반쪽인가 — 그렇다면 기록장·본 저장본을 건드리면 안 된다. */
    let trimmedSave = false
    try {
      at = room.lastActivityAt
      json = JSON.stringify(roomToFile(room)) // 동기 직렬화 — 일관 스냅샷 캡처(이후 방이 바뀌어도 안전)
    } catch (e) {
      // 방이 너무 커져 문자열로 못 만드는 지경(오래된 방의 본문 박힌 이미지 등). 여기서 포기하면
      // 그 방은 이후 한 번도 저장되지 않고, 재시작하는 순간 마지막 저장 이후의 대화가 통째로 사라진다.
      // 그래서 최근 대화만 남겨서라도 반드시 저장한다 — 오래된 앞부분을 잃는 편이 뒷부분을 다 잃는 것보다 낫다.
      const kept = this.serializeTrimmed(room)
      if (!kept) {
        this.saveTrouble.set(room.id, `직렬화 실패: ${String(e)}`)
        console.error(`[rooms] ${room.id}(${room.title}) 직렬화 실패 — 줄여서도 저장하지 못했다:`, e)
        return Promise.resolve()
      }
      this.saveTrouble.set(
        room.id,
        `방이 너무 커서 온전한 저장이 실패했습니다 — 대화는 이전 저장본·기록장·비상 사본으로 지키는 중입니다`
      )
      console.error(`[rooms] ${room.id}(${room.title}) 너무 큼 — 최근 대화 스냅샷을 비상 사본에 둔다(덜어낸 ${kept.dropped}개는 이전 저장본과 기록장 몫).`)
      json = kept.json
      at = room.lastActivityAt
      trimmedSave = true
    }
    this.flushStartedAt.set(room.id, Date.now())
    // 이 스냅샷이 담아낸 지점 — 저장이 끝난 뒤 여기까지만 덜어낸다(그 사이 들어온 말은 남긴다).
    // 반쪽 저장이면 0 — 스냅샷이 담지 못한 대화의 유일한 사본이 기록장이므로 한 줄도 지우지 않는다.
    const cut = trimmedSave ? 0 : this.journalSize(room.id)
    // 반쪽 저장은 본 저장본을 덮지 않는다. 이전 온전 스냅샷은 기록장이 이미 덜어낸(그래서 다른 사본이 없는)
    // 옛 대화의 유일한 그릇이라, 반쪽으로 덮는 순간 그 대화가 디스크에서 사라진다. 비상 사본에 따로 둔다.
    const f = trimmedSave ? this.rescuePath(room.id) : join(this.roomDir, room.id + '.json')
    const tmp = f + '.tmp'
    const work = (async () => {
      try {
        await mkdir(this.roomDir, { recursive: true })
        await writeFile(tmp, json, 'utf8')
        await rename(tmp, f)
        // 쓰는 사이 방이 지워졌으면 방금 쓴 파일도 걷는다 — 지운 방이 다음 기동에서 되살아나지 않게.
        if (!this.rooms.has(room.id)) {
          try {
            await unlink(f)
          } catch {
            /* 이미 걷혔으면 그만 */
          }
          return
        }
        // 반쪽 저장은 '다 저장했다'가 아니다 — 다음 주기에 온전한 저장을 다시 노린다.
        if (!trimmedSave) {
          this.savedAt.set(room.id, at)
          // 비상 사본부터 걷는다. 기록장을 먼저 비우면, 그 사이 죽었을 때 '지웠다'는 기록 없는
          // 낡은 사본만 남아 다음 기동에서 지운 말이 되살아난다. 사본을 못 걷었으면 기록장도 남긴다.
          let rescueGone = true
          if (existsSync(this.rescuePath(room.id))) {
            try {
              await unlink(this.rescuePath(room.id))
            } catch (e) {
              rescueGone = false
              this.saveTrouble.set(room.id, `비상 사본 정리 실패: ${String(e)}`)
            }
          }
          if (rescueGone) {
            this.trimJournal(room.id, cut) // 스냅샷에 담긴 몫만 덜어낸다
            this.saveTrouble.delete(room.id)
          }
        }
      } catch (e) {
        // 디스크가 찼거나 볼륨이 떨어져 나간 경우다. 조용히 넘어가면 서버가 도는 동안에는 아무도 모르다가
        // 다시 시작하는 순간 그 사이의 대화가 전부 사라진다 — 관리 화면에서 보이게 남긴다.
        this.saveTrouble.set(room.id, `저장 실패: ${String(e)}`)
        console.error(`[rooms] ${room.id}(${room.title}) 저장 실패:`, e)
        try {
          await unlink(tmp)
        } catch {
          /* tmp 없음/이미 정리 — 무시 */
        }
      } finally {
        this.flushing.delete(room.id)
        this.flushStartedAt.delete(room.id)
      }
    })()
    this.flushing.set(room.id, work)
    return work
  }

  /**
   * 종료 직전 마무리 — 진행 중인 쓰기를 끝까지 기다린 뒤, 그 사이 바뀐 몫을 한 번 더 저장한다.
   * 두 번 도는 이유: 첫 판을 기다리는 동안 들어온 변경은 아직 어디에도 없다(대화만 기록장이 받아 준다).
   */
  async drain(): Promise<number> {
    if (!this.persist) return 0
    // 예약된 뒤따라 쓰기까지 가라앉을 때까지 — 진행 중인 것을 기다리면 그 뒤에 또 붙을 수 있다.
    for (let i = 0; i < 5 && this.flushing.size; i++) await Promise.all([...this.flushing.values()])
    return this.flushDirty()
  }

  /**
   * 통째로는 문자열이 되지 않는 방을, 오래된 대화를 덜어내며 될 때까지 줄여 직렬화한다.
   * 최근 대화부터 지키는 것이 목적이라 언제나 뒤쪽을 남긴다.
   */
  private serializeTrimmed(room: Room): { json: string; dropped: number } | null {
    const n = room.messages.length
    if (!n) return null // 대화 때문이 아니다 — 여기서 할 수 있는 일이 없다
    // 될 수 있는 대로 많이 남긴다. 하나도 안 남는 저장은 성공이 아니다 —
    // 그것을 성공으로 치면 빈 스냅샷이 그 방의 대화를 통째로 지운다.
    const tries: number[] = [n - 1]
    for (let k = Math.floor(n / 2); k >= 1; k = Math.floor(k / 2)) tries.push(k)
    for (const keep of tries) {
      if (keep < 1) continue
      try {
        const messages = room.messages.slice(-keep)
        const json = JSON.stringify(roomToFile({ ...room, messages } as Room))
        return { json, dropped: n - messages.length }
      } catch {
        /* 더 줄여 본다 */
      }
    }
    return null // 한 마디만 남겨도 안 된다 — 큰 것은 대화가 아니거나 최근 쪽에 있다
  }

  /** 저장이 말썽인 방들 — 관리 화면이 경고를 띄우는 데 쓴다. */
  saveTroubles(): { id: string; title: string; reason: string; lost?: boolean }[] {
    const out = [...this.saveLoss].map(([id, reason]) => ({ id, title: this.rooms.get(id)?.title ?? '', reason, lost: true }))
    for (const [id, reason] of this.saveTrouble) out.push({ id, title: this.rooms.get(id)?.title ?? '', reason, lost: false })
    return out
  }

  /** 변경된 방(lastActivityAt > 마지막 저장) 자동 저장(비동기 쓰기). 시작한 저장이 모두 끝나면 그 개수로 resolve. */
  async flushDirty(): Promise<number> {
    if (!this.persist) return 0
    const pending: Promise<void>[] = []
    for (const room of this.rooms.values()) {
      if (room.lastActivityAt > (this.savedAt.get(room.id) ?? 0)) pending.push(this.flush(room))
    }
    await Promise.all(pending)
    return pending.length
  }

  private removeFile(id: string): void {
    if (!this.persist) return
    try {
      const f = join(this.roomDir, id + '.json')
      if (existsSync(f)) unlinkSync(f)
      const j = this.journalPath(id)
      if (existsSync(j)) unlinkSync(j)
      const r = this.rescuePath(id)
      if (existsSync(r)) unlinkSync(r)
    } catch (e) {
      console.error(`[rooms] ${id} 파일 삭제 실패:`, e)
    }
    this.saveTrouble.delete(id)
    this.saveLoss.delete(id)
  }

  /** 세션 목록 항목(요청 계정 기준 owner 플래그). */
  private summaryFor(room: Room, accountId: string): RoomSummary {
    return {
      id: room.id,
      code: room.code,
      title: room.title,
      cardImage: room.cardImage,
      owner: room.ownerId === accountId,
      memberCount: room.members.size,
      online: [...room.participants.values()].filter((p) => p.connected).length,
      updatedAt: room.lastActivityAt
    }
  }

  private normalize(code: string): string {
    return code.trim().toUpperCase().replace(/\s+/g, '')
  }

  /** 방 생성 — 생성자는 GM·소유자. 고유 초대 코드 발급. accountId=소유자 계정(목록·권한), title/cardImage=세션 메타. */
  createRoom(host: {
    playerId: string
    nick: string
    color: string
    accountId?: string
    title?: string
    cardImage?: string
  }): { room: Room; self: Participant } {
    const id = randomUUID()
    let code = genCode()
    while (this.codeToId.has(code)) code = genCode()
    const self: Participant = {
      playerId: host.playerId,
      nick: host.nick.trim() || 'GM',
      color: host.color || DEFAULT_GM_COLOR,
      role: 'GM',
      connected: true
    }
    const now = Date.now()
    const firstMap = makeMap('맵 1')
    const ownerId = host.accountId || host.playerId
    const room: Room = {
      id,
      code,
      title: (host.title ?? '').trim().slice(0, 80) || '새 세션',
      ownerId,
      members: new Set([ownerId]),
      cardImage: capImage(host.cardImage),
      participants: new Map([[self.playerId, self]]),
      characters: new Map(),
      handouts: new Map(),
      maps: new Map([[firstMap.id, firstMap]]),
      activeMapId: firstMap.id,
      appearance: { ...DEFAULT_APPEARANCE },
      bgm: [],
      combat: null,
      channels: new Map(),
      messages: [],
      charRooms: new Map(),
      createdAt: now,
      lastActivityAt: now
    }
    this.rooms.set(id, room)
    this.codeToId.set(code, id)
    // 만들자마자 한 번 저장한다. 대화 기록장은 첫 마디부터 쓰이는데, 짝이 되는 세션 파일이 없으면
    // 부팅 때 아무도 그 기록장을 읽지 않는다 — 방을 만들고 바로 나눈 대화가 통째로 사라진다.
    void this.flush(room)
    return { room, self }
  }

  /**
   * 초대 코드로 입장. 이미 같은 playerId 가 있으면 재접속으로 처리(역할 유지, 닉/색 갱신).
   * 신규면 PL 로 추가.
   */
  joinByCode(
    code: string,
    player: { playerId: string; nick: string; color: string; accountId?: string }
  ): { room: Room; self: Participant } | { error: string } {
    const roomId = this.codeToId.get(this.normalize(code))
    if (!roomId) return { error: '존재하지 않는 초대 코드입니다.' }
    const room = this.rooms.get(roomId)
    if (!room) return { error: '방을 찾을 수 없습니다.' }
    return this.admit(room, player)
  }

  /** roomId 로 직접 입장(세션 목록 클릭) — 소유자/멤버만. 코드 없이 재입장. */
  enterRoom(
    roomId: string,
    player: { playerId: string; nick: string; color: string; accountId?: string }
  ): { room: Room; self: Participant } | { error: string } {
    const room = this.rooms.get(roomId)
    if (!room) return { error: '세션을 찾을 수 없습니다.' }
    const acct = player.accountId
    if (acct && room.ownerId !== acct && !room.members.has(acct)) {
      return { error: '이 세션의 멤버가 아닙니다. 초대 코드로 입장하세요.' }
    }
    return this.admit(room, player)
  }

  /** 공통 입장 처리: 멤버 등록 + 재접속/신규 참가자(소유자=GM, 그 외 PL). */
  private admit(
    room: Room,
    player: { playerId: string; nick: string; color: string; accountId?: string }
  ): { room: Room; self: Participant } {
    room.lastActivityAt = Date.now()
    if (player.accountId) room.members.add(player.accountId)
    const existing = room.participants.get(player.playerId)
    if (existing) {
      existing.connected = true
      if (player.nick.trim()) existing.nick = player.nick.trim()
      if (player.color) existing.color = player.color
      return { room, self: existing }
    }
    const isOwner = !!player.accountId && room.ownerId === player.accountId
    const self: Participant = {
      playerId: player.playerId,
      nick: player.nick.trim() || (isOwner ? 'GM' : '탐사자'),
      color: player.color || (isOwner ? DEFAULT_GM_COLOR : DEFAULT_PL_COLOR),
      role: isOwner ? 'GM' : 'PL', // 소유자는 재입장 시에도 GM 복원(릴레이 재시작 후 participants 비어도)
      connected: true
    }
    room.participants.set(self.playerId, self)
    return { room, self }
  }

  getRoom(roomId: string): Room | undefined {
    return this.rooms.get(roomId)
  }

  /** 연결 끊김 표시 — 참가자는 유지(재접속 대기). 방은 sweep 전까지 보존. */
  markDisconnected(roomId: string, playerId: string): Room | undefined {
    const room = this.rooms.get(roomId)
    if (!room) return undefined
    const p = room.participants.get(playerId)
    if (p) p.connected = false
    // connected 는 런타임 상태(디스크에 저장하지 않음)라 lastActivityAt 을 갱신하지 않는다. 갱신하면 끊김/재접속마다
    // 방이 dirty 로 잡혀 8초 자동저장이 방 전체 히스토리를 동기 재직렬화(이벤트 루프 블록)→핑 타임아웃→끊김 가속 루프가 된다.
    return room
  }

  /** 세션 복구 재접속 시 온라인 표시 복원 — 브리프 끊김으로 connected=false 였던 참가자를 다시 true 로. 변경된 방 반환. */
  markConnected(roomId: string, playerId: string): Room | undefined {
    const room = this.rooms.get(roomId)
    if (!room) return undefined
    const p = room.participants.get(playerId)
    if (!p || p.connected) return room // 없거나 이미 온라인이면 그대로
    p.connected = true
    // connected 는 런타임 상태라 dirty 로 잡지 않는다(markDisconnected 와 동일 — 재접속마다 전체 재직렬화 방지).
    return room
  }

  /** 명시적 퇴장 — 참가자·캐릭터 제거. 빈 방이면 즉시 정리. */
  leave(roomId: string, playerId: string): Room | undefined {
    const room = this.rooms.get(roomId)
    if (!room) return undefined
    room.participants.delete(playerId)
    room.characters.delete(playerId)
    room.lastActivityAt = Date.now()
    if (room.participants.size === 0 && !this.persist) {
      // 비영속: 빈 방 즉시 정리. 영속 모드는 방 유지(재입장 대기 · 소유자 삭제만 제거).
      this.rooms.delete(room.id)
      this.codeToId.delete(room.code)
      return undefined
    }
    return room
  }

  /**
   * 참가자 본인의 멤버십 탈퇴 — '내 세션 목록'(listForAccount)에서 이 방을 제거한다.
   * 소유자는 불가(소유자 없는 방 방지 — 소유자는 방 삭제를 사용). 채팅 이력은 보존(퇴장자의 과거 발화 유지 — leave/kick 과 동일).
   * 시트 데이터는 계정 라이브러리에 있으므로 방별 멤버십(charRooms)만 정리해도 손실 없음.
   * 같은 초대 코드로 다시 참가하면 members 에 재등록되어 복귀 가능(코드 재발급 없음 — 강퇴와 다름).
   */
  leaveMembership(roomId: string, accountId: string, playerId: string): { ok: true } | { error: string } {
    const room = this.rooms.get(roomId)
    if (!room) return { error: '세션을 찾을 수 없습니다.' }
    if (room.ownerId === accountId) return { error: '방장은 목록에서 나갈 수 없습니다. 방 삭제를 이용하세요.' }
    if (!room.members.has(accountId)) return { error: '이 세션의 멤버가 아닙니다.' }
    room.members.delete(accountId)
    room.participants.delete(playerId)
    room.characters.delete(playerId)
    room.charRooms.delete(playerId)
    room.lastActivityAt = Date.now() // dirty 마킹 — 자동저장(flushDirty)이 영속화
    return { ok: true }
  }

  /** 초대 코드 재발급(추방 시). 옛 코드 무효화 → 새 고유 코드 설정·반환. */
  reissueCode(roomId: string): string | undefined {
    const room = this.rooms.get(roomId)
    if (!room) return undefined
    this.codeToId.delete(room.code)
    let code = genCode()
    while (this.codeToId.has(code)) code = genCode()
    room.code = code
    this.codeToId.set(code, roomId)
    room.lastActivityAt = Date.now()
    return code
  }

  /** 방 외형 설정(방 GM 강제 — 권한 검증은 호출 측 relay). 정규화된 저장본 반환, 방 없으면 undefined. */
  setAppearance(roomId: string, ap: Partial<Appearance> | undefined): Appearance | undefined {
    const room = this.rooms.get(roomId)
    if (!room) return undefined
    room.appearance = normalizeAppearance(ap)
    room.lastActivityAt = Date.now()
    return room.appearance
  }

  /**
   * 방 주사위 연출 카드 설정/해제(GM 전용 — 권한 검증은 호출 측 relay). image 빈값이면 해제.
   * level 지정 시 그 성공 단계 연출 카드, 없으면 공통 연출 카드(레벨 미설정 폴백).
   * {ok,image,level} 반환(ok=false면 방 없음/무효 레벨). 크기 캡(애니 GIF/APNG/WebP 보존 — 재인코딩 안 함).
   */
  setCutIn(
    roomId: string,
    image: string | undefined,
    level?: SuccessLevel
  ): { ok: boolean; image?: string; level?: SuccessLevel } {
    const room = this.rooms.get(roomId)
    if (!room) return { ok: false }
    const capped = capImage(image)
    if (level !== undefined) {
      if (!CUTIN_LEVELS.includes(level)) return { ok: false } // 무효 레벨 무시
      const imgs = room.cutInImages ?? (room.cutInImages = {})
      if (capped) imgs[level] = capped
      else delete imgs[level]
      if (Object.keys(imgs).length === 0) room.cutInImages = undefined
      room.lastActivityAt = Date.now()
      return { ok: true, image: capped, level }
    }
    room.cutInImage = capped
    room.lastActivityAt = Date.now()
    return { ok: true, image: room.cutInImage }
  }

  /** ~문장~ 행동지문 색 설정/해제(GM 전용 — 권한 검증은 호출 측 relay). 빈/무효값이면 해제. {ok,color} 반환. */
  setDimColor(roomId: string, color: string | undefined): { ok: boolean; color?: string } {
    const room = this.rooms.get(roomId)
    if (!room) return { ok: false }
    room.dimColor = coerceDimColor(color)
    room.lastActivityAt = Date.now()
    return { ok: true, color: room.dimColor }
  }

  /** GM 커스텀 광기표 설정/해제(GM 전용 — 권한 검증은 호출 측 relay). 빈/무효면 해제(기본표). {ok,tables} 반환. */
  setMadnessTables(roomId: string, tables: unknown): { ok: boolean; tables?: MadnessTables } {
    const room = this.rooms.get(roomId)
    if (!room) return { ok: false }
    room.madnessTables = coerceMadnessTables(tables)
    room.lastActivityAt = Date.now()
    return { ok: true, tables: room.madnessTables }
  }

  /** 행운 깎기(CoC7 하우스룰) 사용 여부 설정(GM 전용 — 권한 검증은 호출 측 relay). {ok,enabled} 반환. */
  setLuckEnabled(roomId: string, enabled: boolean): { ok: boolean; enabled: boolean } {
    const room = this.rooms.get(roomId)
    if (!room) return { ok: false, enabled: true }
    room.luckEnabled = enabled
    room.lastActivityAt = Date.now()
    return { ok: true, enabled }
  }

  /** 일반 맵 VN 오버레이 표시 여부 설정(GM 전용 — 권한 검증은 호출 측 relay). {ok,enabled} 반환. */
  setVnOverlay(roomId: string, enabled: boolean): { ok: boolean; enabled: boolean } {
    const room = this.rooms.get(roomId)
    if (!room) return { ok: false, enabled: false }
    room.vnOverlay = enabled
    room.lastActivityAt = Date.now()
    return { ok: true, enabled }
  }

  // ===== BGM (다중, GM 제어·전원 동기화 — 권한 검증은 호출 측 relay) =====
  /** BGM 트랙 추가/교체(trackId 멱등 upsert · playing=true 스탬프). 갱신된 트랙 목록 반환, 무효/방 없으면 null. */
  setBgm(
    roomId: string,
    req:
      | {
          trackId?: unknown
          kind?: unknown
          src?: unknown
          title?: unknown
          loop?: unknown
          volume?: unknown
        }
      | undefined
  ): BgmState[] | null {
    const room = this.rooms.get(roomId)
    if (!room) return null
    const next = normalizeBgm(req)
    if (!next) return null // 무효 페이로드는 기존 상태 보존(무시)
    const i = room.bgm.findIndex((t) => t.trackId === next.trackId)
    if (i >= 0)
      room.bgm[i] = next // 같은 트랙 재로드(소스·볼륨 교체)
    else if (room.bgm.length < MAX_BGM_TRACKS)
      room.bgm.push(next) // 신규(최대 5)
    else return null // 5개 가득 — 무시(클라가 막지만 서버도 방어)
    room.lastActivityAt = Date.now()
    return room.bgm
  }

  /** 특정 BGM 트랙 재생/반복·볼륨 토글(소스 유지). 변경된 트랙 상태 반환, 해당 트랙 없으면 undefined. */
  controlBgm(
    roomId: string,
    req: { trackId?: unknown; playing?: unknown; loop?: unknown; volume?: unknown } | undefined
  ): { trackId: string; playing: boolean; loop: boolean; volume: number } | undefined {
    const room = this.rooms.get(roomId)
    if (!room || typeof req?.trackId !== 'string') return undefined
    const t = room.bgm.find((x) => x.trackId === req.trackId)
    if (!t) return undefined
    if (typeof req.playing === 'boolean') t.playing = req.playing
    if (typeof req.loop === 'boolean') t.loop = req.loop
    if (typeof req.volume === 'number' && Number.isFinite(req.volume))
      t.volume = Math.max(0, Math.min(1, req.volume))
    room.lastActivityAt = Date.now()
    return { trackId: t.trackId, playing: t.playing, loop: t.loop, volume: t.volume }
  }

  /** BGM 정지·해제 — trackId 지정 시 그 트랙만, 없으면 전체. 갱신된 트랙 목록 반환, 방 없으면 undefined. */
  clearBgm(roomId: string, trackId?: string): BgmState[] | undefined {
    const room = this.rooms.get(roomId)
    if (!room) return undefined
    room.bgm = trackId ? room.bgm.filter((t) => t.trackId !== trackId) : []
    room.lastActivityAt = Date.now()
    return room.bgm
  }

  /**
   * 전체 트랙을 권위적으로 교체 — GM '나만 듣기'→'전체 동기화' 전환 시 GM 로컬 트랙으로 방을 정확히 맞춰
   * 고아 트랙(이전에 멈췄지만 동기 누락된)으로 인한 PL 혼선을 제거. 로드 정규화(playing 보존·최대 5) 재사용.
   */
  replaceBgm(roomId: string, tracks: unknown): BgmState[] | undefined {
    const room = this.rooms.get(roomId)
    if (!room) return undefined
    room.bgm = coerceLoadedBgmList(tracks)
    room.lastActivityAt = Date.now()
    return room.bgm
  }

  // ===== GM 선택지 — 옵션 스크립트는 서버만 보관(비공개), 응답은 플레이어당 1회 =====
  /** 선택지 보관(GM 게시 시). 옵션엔 스크립트 포함(브로드캐스트본은 relay 가 제거). */
  setChoice(
    roomId: string,
    messageId: string,
    options: { id: string; label: string; script?: string }[]
  ): void {
    this.choices.set(`${roomId}:${messageId}`, { options, responders: new Set() })
  }
  /** 플레이어 선택 처리 — 1회만 허용. 통과 시 해당 옵션(스크립트 포함) 반환, 중복/무효면 null. */
  selectChoice(
    roomId: string,
    messageId: string,
    optionId: string,
    playerId: string
  ): { option: { id: string; label: string; script?: string } } | null {
    const c = this.choices.get(`${roomId}:${messageId}`)
    if (!c) return null
    if (c.responders.has(playerId)) return null // 이미 응답
    const option = c.options.find((o) => o.id === optionId)
    if (!option) return null
    c.responders.add(playerId)
    return { option }
  }

  // ===== 전투 (GM 제어·전원 동기화 — 권한 검증은 호출 측 relay) =====
  /** 전투 상태 전체 교체(GM). null/빈 목록=종료. 정규화 저장본 반환(종료면 null), 방 없으면 undefined. */
  setCombat(roomId: string, state: unknown): CombatState | null | undefined {
    const room = this.rooms.get(roomId)
    if (!room) return undefined
    const next = normalizeCombat(state)
    room.combat = next
    room.lastActivityAt = Date.now()
    return next
  }

  // ===== 그룹 채널 (GM 개설·멤버 라우팅 — 권한 검증은 호출 측 relay) =====
  /** 그룹 채널 개설(GM). id 서버 생성, 멤버는 현재 참가자만. 생성 채널 반환, 방 없거나 이름 빈값이면 undefined. */
  createChannel(roomId: string, req: { name?: unknown; members?: unknown } | undefined): Channel | undefined {
    const room = this.rooms.get(roomId)
    if (!room) return undefined
    const name = typeof req?.name === 'string' ? req.name.trim().slice(0, 80) : ''
    if (!name) return undefined
    const members = Array.isArray(req?.members)
      ? [
          ...new Set(
            req!.members.filter((m): m is string => typeof m === 'string' && room.participants.has(m))
          )
        ].slice(0, 64)
      : []
    const ch: Channel = { id: randomUUID(), name, members }
    room.channels.set(ch.id, ch)
    room.lastActivityAt = Date.now()
    return ch
  }

  /** 그룹 채널 삭제(GM). 있었으면 true. */
  removeChannel(roomId: string, id: string): boolean {
    const room = this.rooms.get(roomId)
    if (!room) return false
    const had = room.channels.delete(id)
    if (had) room.lastActivityAt = Date.now()
    return had
  }

  /** viewer 가 멤버이거나 GM 인 채널만(viewer 없으면 전체 — 테스트/하위호환). */
  channelsFor(room: Room, viewer?: { playerId: string; role: Participant['role'] }): Channel[] {
    const all = [...room.channels.values()]
    if (!viewer || viewer.role === 'GM') return all
    return all.filter((c) => c.members.includes(viewer.playerId))
  }

  /** 채널 메시지 전달 대상 playerId(멤버 + 모든 GM). 채널 없으면 빈 배열. */
  channelRecipients(roomId: string, channelId: string): string[] {
    const room = this.rooms.get(roomId)
    const ch = room?.channels.get(channelId)
    if (!room || !ch) return []
    const set = new Set<string>(ch.members)
    for (const p of room.participants.values()) if (p.role === 'GM') set.add(p.playerId)
    return [...set]
  }

  /** 채널 접근(발신) 권한: GM 또는 멤버. 채널 없으면 false. */
  canAccessChannel(roomId: string, channelId: string, playerId: string): boolean {
    const room = this.rooms.get(roomId)
    const ch = room?.channels.get(channelId)
    if (!room || !ch) return false
    return room.participants.get(playerId)?.role === 'GM' || ch.members.includes(playerId)
  }

  // ===== 방 불러오기 (GM 전용 — 권한 검증은 호출 측 relay) =====
  /**
   * .orpg 스냅샷의 장면(맵·자료·외형·BGM)을 방에 적용(전부 방어적 정규화).
   * 참가자·채팅은 라이브 상태라 건드리지 않음. 맵이 비면 빈 맵 1개 보장. 성공 시 true.
   */
  loadSnapshot(roomId: string, data: RoomLoadReq | undefined): boolean {
    const room = this.rooms.get(roomId)
    if (!room || !data || typeof data !== 'object') return false
    const maps = new Map<string, RoomMap>()
    for (const gm of Array.isArray(data.maps) ? data.maps : []) {
      const m = coerceLoadedMap(gm)
      if (m) maps.set(m.id, m)
    }
    if (maps.size === 0) {
      const m = makeMap('맵 1')
      maps.set(m.id, m)
    }
    room.maps = maps
    room.activeMapId =
      typeof data.activeMapId === 'string' && maps.has(data.activeMapId)
        ? data.activeMapId
        : (maps.keys().next().value as string)
    const handouts = new Map<string, Handout>()
    for (const h of Array.isArray(data.handouts) ? data.handouts : []) {
      const c = coerceLoadedHandout(h)
      if (c) handouts.set(c.id, c)
    }
    room.handouts = handouts
    room.appearance = normalizeAppearance(data.appearance)
    room.bgm = coerceLoadedBgmList(data.bgm)
    room.lastActivityAt = Date.now()
    return true
  }

  /** 서버 권위 메시지 누적 (id/time 은 호출 측에서 이미 스탬프). */
  addMessage(roomId: string, message: ChatMessage): void {
    const room = this.rooms.get(roomId)
    if (!room) return
    room.messages.push(message)
    if (room.messages.length > MAX_HISTORY) {
      room.messages.splice(0, room.messages.length - MAX_HISTORY)
    }
    room.lastActivityAt = Date.now()
    this.journal(roomId, { op: 'add', m: message })
  }

  /**
   * 채팅 메시지 수정 — 작성자 본인 또는 GM. 텍스트 메시지(speech/narration/script)만 수정 가능.
   * 성공 시 갱신된 메시지 반환(브로드캐스트용), 미존재·권한 없음·비텍스트면 undefined.
   */
  editMessage(
    roomId: string,
    id: string,
    text: string,
    byPlayerId: string,
    isGM: boolean
  ): ChatMessage | undefined {
    const room = this.rooms.get(roomId)
    if (!room) return undefined
    const msg = room.messages.find((m) => m.id === id)
    if (!msg || msg.deleted) return undefined
    if (msg.playerId !== byPlayerId && !isGM) return undefined // 작성자 또는 GM 만
    if (msg.kind !== 'speech' && msg.kind !== 'narration' && msg.kind !== 'script') return undefined // 텍스트만
    msg.text = text
    msg.edited = true
    room.lastActivityAt = Date.now()
    this.journal(roomId, { op: 'edit', id, text })
    return msg
  }

  /** 채팅 메시지 삭제 — GM 만. 툼스톤("삭제된 메시지") 없이 히스토리에서 완전 제거(깔끔 삭제). 성공 시 id 반환. */
  deleteMessage(roomId: string, id: string, isGM: boolean): string | undefined {
    const room = this.rooms.get(roomId)
    if (!room || !isGM) return undefined
    const i = room.messages.findIndex((m) => m.id === id)
    if (i < 0) return undefined
    room.messages.splice(i, 1) // 완전 제거(스냅샷·히스토리에 흔적 없음)
    room.lastActivityAt = Date.now()
    this.journal(roomId, { op: 'del', id })
    return id
  }

  /**
   * 캐릭터 프레즌스 서브셋 보관/갱신(char 의 playerId 는 호출 측에서 서버 권위로 스탬프됨).
   * 표정 인덱스는 standings 범위로 보정해 저장. 저장본 반환.
   */
  setCharacter(roomId: string, char: SharedCharacter): SharedCharacter | undefined {
    const room = this.rooms.get(roomId)
    if (!room) return undefined
    // 이미지 필드 캡(개수·크기) + 텍스트 길이 바운드 — 신뢰 못 할 클라 페이로드 방어.
    const standings = capImageList(char.standings)
    const headshots = char.headshots ? capImageList(char.headshots) : undefined
    const max = Math.max(0, standings.length - 1)
    const currentExpression = Math.min(Math.max(0, char.currentExpression), max)
    const stored: SharedCharacter = {
      ...char,
      charId: capId(char.charId) ?? '',
      name: typeof char.name === 'string' ? char.name.slice(0, 100) : '',
      color: typeof char.color === 'string' ? char.color.slice(0, 32) : '#7c9cff',
      nameColor: typeof char.nameColor === 'string' ? char.nameColor.slice(0, 32) : undefined,
      headshot: capImage(char.headshot),
      standings,
      headshots,
      currentExpression,
      // 스탠딩 표시 높이(px) — 유한수만, 40~4000 으로 클램프. 비유한/미설정은 undefined(기본 92%).
      standingHeight:
        typeof char.standingHeight === 'number' && Number.isFinite(char.standingHeight)
          ? Math.min(4000, Math.max(40, Math.round(char.standingHeight)))
          : undefined,
      bio: typeof char.bio === 'string' ? char.bio.slice(0, 500) : undefined // 자기소개 길이 바운드
    }
    room.characters.set(char.playerId, stored)
    room.lastActivityAt = Date.now()
    return stored
  }

  /** 표정 인덱스만 갱신(잦은 변경). 보정된 인덱스 반환, 보관된 캐릭터 없으면 undefined. */
  setExpression(roomId: string, playerId: string, index: number): number | undefined {
    const room = this.rooms.get(roomId)
    if (!room) return undefined
    const char = room.characters.get(playerId)
    if (!char) return undefined
    const max = Math.max(0, char.standings.length - 1)
    char.currentExpression = Math.min(Math.max(0, index), max)
    room.lastActivityAt = Date.now()
    return char.currentExpression
  }

  // ===== 핸드아웃 =====
  /**
   * 핸드아웃 생성/갱신. id 없으면 신규(randomUUID·createdAt), 있으면 기존 갱신(updatedAt 만 새로).
   * 저장본과 갱신 전 스냅샷(prev, 신규면 undefined)을 함께 반환 — 라우팅 대상 diff(가시성 변화)용.
   */
  upsertHandout(roomId: string, req: HandoutUpsertReq): { handout: Handout; prev?: Handout } | undefined {
    const room = this.rooms.get(roomId)
    if (!room) return undefined
    const now = Date.now()
    const existing = typeof req.id === 'string' ? room.handouts.get(req.id) : undefined
    const scope: HandoutScope = req.scope === 'all' || req.scope === 'targeted' ? req.scope : 'private'
    const handout: Handout = {
      // 기존이면 그 id 유지, 신규면 클라 제공 id 존중(GM 전용 경로 — 낙관적 선택용), 없으면 생성.
      id: existing?.id ?? (typeof req.id === 'string' && req.id ? req.id : randomUUID()),
      title: typeof req.title === 'string' ? req.title.slice(0, 200) : '',
      body: typeof req.body === 'string' ? req.body.slice(0, 20000) : '',
      image: capImage(req.image),
      imageAlign: req.imageAlign === 'center' || req.imageAlign === 'right' ? req.imageAlign : undefined,
      tags: Array.isArray(req.tags) ? req.tags.filter((t) => typeof t === 'string').slice(0, 40) : [],
      scope,
      targets:
        scope === 'targeted' && Array.isArray(req.targets)
          ? req.targets.filter((t) => typeof t === 'string').slice(0, 200)
          : [],
      createdAt: existing?.createdAt ?? now,
      updatedAt: now
    }
    const prev = existing ? { ...existing } : undefined
    room.handouts.set(handout.id, handout)
    room.lastActivityAt = now
    return { handout, prev }
  }

  /** 핸드아웃 삭제. 삭제된 핸드아웃(라우팅용 prev) 반환, 없으면 undefined. */
  deleteHandout(roomId: string, id: string): Handout | undefined {
    const room = this.rooms.get(roomId)
    if (!room) return undefined
    const prev = room.handouts.get(id)
    if (!prev) return undefined
    room.handouts.delete(id)
    room.lastActivityAt = Date.now()
    return prev
  }

  getHandout(roomId: string, id: string): Handout | undefined {
    return this.rooms.get(roomId)?.handouts.get(id)
  }

  /** viewer 가 볼 수 있는 핸드아웃만 반환. */
  handoutsFor(room: Room, viewer: { playerId: string; role: Participant['role'] }): Handout[] {
    return [...room.handouts.values()].filter((h) => canViewHandout(h, viewer))
  }

  // ===== 맵·토큰 (다중 맵) =====
  getMap(roomId: string, mapId: string): RoomMap | undefined {
    return this.rooms.get(roomId)?.maps.get(mapId)
  }

  /** 새 맵 생성. 저장본(와이어) 반환, 방 없으면 undefined. */
  createMap(roomId: string, name?: string): GameMap | undefined {
    const room = this.rooms.get(roomId)
    if (!room) return undefined
    const m = makeMap((name ?? '').trim() || `맵 ${room.maps.size + 1}`)
    room.maps.set(m.id, m)
    room.lastActivityAt = Date.now()
    return toWireMap(m)
  }

  /** 맵세트 복제(GM 전용). 원본의 배경/바탕/그리드/토큰/드로잉/텍스트/메타를 새 맵으로 깊은 복사(토큰 등은 새 id). */
  duplicateMap(roomId: string, mapId: string): GameMap | undefined {
    const room = this.rooms.get(roomId)
    const src = room?.maps.get(mapId)
    if (!room || !src) return undefined
    const m: RoomMap = {
      id: randomUUID(),
      name: src.name + ' 복사',
      background: src.background ? { ...src.background } : null,
      grid: { ...src.grid },
      tokens: new Map(),
      drawings: new Map(),
      texts: new Map(),
      vnBackground: src.vnBackground,
      vnBackgroundBlur: src.vnBackgroundBlur,
      vnLayers: src.vnLayers ? src.vnLayers.map((l) => ({ ...l })) : undefined,
      bgColor: src.bgColor,
      backdrop: src.backdrop ? { ...src.backdrop } : undefined,
      crossfade: src.crossfade,
      hiddenLayers: src.hiddenLayers ? [...src.hiddenLayers] : undefined,
      bgm: src.bgm ? src.bgm.map((t) => ({ ...t })) : undefined,
      importId: src.importId // 복제본이 남아 있는 동안 가져오기 배치가 살아 있게(연동 삭제 보수적)
    }
    for (const t of src.tokens.values()) {
      const id = randomUUID()
      m.tokens.set(id, { ...t, id })
    }
    for (const s of src.drawings.values()) {
      const id = randomUUID()
      m.drawings.set(id, { ...s, id })
    }
    for (const tx of src.texts.values()) {
      const id = randomUUID()
      m.texts.set(id, { ...tx, id })
    }
    // 표시 맵 제한 통합 토큰 — 원본 맵에 표시되던 배치는 복제 맵에서도 보이게 새 id 를 추가.
    for (const t of room.globalTokens?.values() ?? []) {
      if (t.mapIds?.includes(mapId)) t.mapIds = [...t.mapIds, m.id]
    }
    room.maps.set(m.id, m)
    room.lastActivityAt = Date.now()
    return toWireMap(m)
  }

  /** 맵 삭제(마지막 1개는 삭제 불가). 활성 맵 삭제 시 다른 맵으로 전환. {removed,activeMapId} 반환. */
  deleteMap(roomId: string, mapId: string): { removed: string; activeMapId: string } | undefined {
    const room = this.rooms.get(roomId)
    if (!room || !room.maps.has(mapId) || room.maps.size <= 1) return undefined
    room.maps.delete(mapId)
    if (room.activeMapId === mapId) room.activeMapId = room.maps.keys().next().value as string
    room.lastActivityAt = Date.now()
    return { removed: mapId, activeMapId: room.activeMapId }
  }

  /** 맵 이름 변경. {mapId,name} 반환, 맵 없으면 undefined. */
  /**
   * 맵세트 일괄 가져오기(GM 전용 — 권한 검증은 relay). 외부 파일에서 변환한 맵들을 coerceLoadedMap 으로
   * 정규화(이미지 캡·좌표 클램프 등)하고 새 id 를 부여해 추가한다. 방 전체 맵 상한 100·1회 60개로 제한.
   * 생성된 wire 맵 목록 반환(relay 가 map:added 로 브로드캐스트).
   */
  importMaps(roomId: string, mapsData: unknown): GameMap[] {
    const room = this.rooms.get(roomId)
    if (!room) return []
    const budget = Math.max(0, 100 - room.maps.size)
    const list = Array.isArray(mapsData) ? mapsData.slice(0, Math.min(60, budget)) : []
    const created: GameMap[] = []
    for (const raw of list) {
      if (!raw || typeof raw !== 'object') continue
      const m = coerceLoadedMap({ ...(raw as Record<string, unknown>), id: randomUUID() })
      if (!m) continue
      room.maps.set(m.id, m)
      created.push(toWireMap(m))
    }
    if (created.length) room.lastActivityAt = Date.now()
    return created
  }

  /**
   * 통합 레이어 일괄 가져오기(GM 전용 — 권한 검증은 relay). 맵세트 가져오기에 동반된 방 상주 패널을
   * coerceToken 으로 정규화하고 새 id 를 부여해 통합 레이어에 추가한다 — 낱개 upsert 는 z 를 레이어
   * 맨 앞으로 재배열해 무대 뒤(z<0) 배치가 소실되므로 z 를 보존하는 일괄 경로가 따로 필요하다.
   * 1회 100개, 총량은 맵당 토큰 상한과 동일. 저장 토큰 목록 반환(relay 가 token:state 로 브로드캐스트).
   * restrictMapIds: 표시 맵 제한 덮어쓰기 — importMaps 가 맵 id 를 재발급하므로 클라가 찍어 보낸
   * 옛 id 대신 실제 생성된 맵 id 로 서버가 다시 묶는다(배치의 통합 레이어는 그 맵들에서만 표시).
   */
  importGlobalTokens(roomId: string, tokensData: unknown, restrictMapIds?: string[]): Token[] {
    const room = this.rooms.get(roomId)
    if (!room) return []
    const coll = (room.globalTokens ??= new Map<string, Token>())
    const list = Array.isArray(tokensData) ? tokensData.slice(0, 100) : []
    const stored: Token[] = []
    for (const raw of list) {
      if (coll.size >= MAX_TOKENS_PER_MAP) break
      if (!raw || typeof raw !== 'object') continue
      const t = coerceToken({ ...(raw as Record<string, unknown>), id: randomUUID() })
      if (!t) continue
      // 표시 맵 제한은 서버가 항상 재부여 — 클라가 찍어 보낸 로컬 맵 id 는 재발급 전 값이라
      // 그대로 두면 어떤 맵에도 안 보이는 유령 토큰이 된다(맵이 안 들어왔으면 전체 표시로 해제).
      t.mapIds = restrictMapIds?.length ? restrictMapIds : undefined
      coll.set(t.id, t)
      stored.push(t)
    }
    if (stored.length) room.lastActivityAt = Date.now()
    return stored
  }

  renameMap(roomId: string, mapId: string, name: string): { mapId: string; name: string } | undefined {
    const room = this.rooms.get(roomId)
    const m = room?.maps.get(mapId)
    if (!room || !m) return undefined
    m.name = (typeof name === 'string' ? name.trim() : '') || m.name
    room.lastActivityAt = Date.now()
    return { mapId, name: m.name }
  }

  /** 활성 맵 전환. 새 활성 id 반환, 맵 없으면 undefined. */
  setActiveMap(roomId: string, mapId: string): string | undefined {
    const room = this.rooms.get(roomId)
    if (!room || !room.maps.has(mapId)) return undefined
    room.activeMapId = mapId
    room.lastActivityAt = Date.now()
    return mapId
  }

  // ===== 저장 슬롯 (반면 전체 명명 저장 · GM · 최대 3 · 영속) =====
  private slotMeta(room: Room): SaveSlotMeta[] {
    return (room.saveSlots ?? []).map((s) => ({ id: s.id, name: s.name, savedAt: s.savedAt }))
  }
  saveSlotsMeta(roomId: string): SaveSlotMeta[] {
    const room = this.rooms.get(roomId)
    return room ? this.slotMeta(room) : []
  }
  /** 현재 반면(맵·활성맵·BGM)을 명명 슬롯으로 저장(GM). 같은 이름이면 덮어쓰기, 아니면 추가(최대 3). 꽉 차면 undefined. */
  saveSlot(roomId: string, name: unknown): SaveSlotMeta[] | undefined {
    const room = this.rooms.get(roomId)
    if (!room) return undefined
    const slots = room.saveSlots ?? []
    const nm = (typeof name === 'string' ? name.trim() : '').slice(0, 60) || `저장 ${slots.length + 1}`
    const slot: SaveSlot = {
      id: randomUUID(),
      name: nm,
      savedAt: Date.now(),
      maps: [...room.maps.values()].map(toWireMap),
      activeMapId: room.activeMapId,
      bgm: room.bgm.map((t) => ({ ...t })),
      // 통합 레이어도 반면의 일부 — 함께 저장해야 로드 시 가져오기 배치의 맵·패널 짝이 유지된다.
      globalTokens: room.globalTokens ? [...room.globalTokens.values()].map((t) => ({ ...t })) : []
    }
    const i = slots.findIndex((s) => s.name === nm)
    if (i >= 0) {
      slot.id = slots[i].id
      slots[i] = slot // 같은 이름 덮어쓰기
    } else {
      if (slots.length >= 3) return undefined // 최대 3 슬롯
      slots.push(slot)
    }
    room.saveSlots = slots
    room.lastActivityAt = Date.now()
    return this.slotMeta(room)
  }
  /** 슬롯 로드 — 저장된 맵·활성맵·BGM 으로 반면 복원(GM). 성공 시 true(호출측이 전원 재싱크). */
  loadSlot(roomId: string, slotId: string): boolean {
    const room = this.rooms.get(roomId)
    const slot = room?.saveSlots?.find((s) => s.id === slotId)
    if (!room || !slot) return false
    const maps = new Map<string, RoomMap>()
    for (const g of slot.maps) {
      const m = coerceLoadedMap(g) // 깊은 복사·정규화
      if (m) maps.set(m.id, m)
    }
    if (!maps.size) return false
    room.maps = maps
    room.activeMapId = maps.has(slot.activeMapId)
      ? slot.activeMapId
      : (maps.keys().next().value as string)
    room.bgm = slot.bgm.map((t) => ({ ...t }))
    // 통합 레이어도 저장 시점으로 복원(반면 통째 교체와 정합·배치 짝 유지).
    // 구버전 슬롯(필드 없음)은 현재 통합 레이어를 유지한다.
    if (slot.globalTokens !== undefined)
      room.globalTokens = coerceGlobalTokens(slot.globalTokens) ?? new Map<string, Token>()
    room.lastActivityAt = Date.now()
    return true
  }
  /** 슬롯 삭제(GM). 삭제 후 메타 목록 반환. */
  deleteSlot(roomId: string, slotId: string): SaveSlotMeta[] | undefined {
    const room = this.rooms.get(roomId)
    if (!room) return undefined
    room.saveSlots = (room.saveSlots ?? []).filter((s) => s.id !== slotId)
    room.lastActivityAt = Date.now()
    return this.slotMeta(room)
  }

  // ===== 비주얼 카드 — GM 등록·전원 동기화 · 영속 =====
  /** 카드 추가/갱신(GM). id 있으면 갱신, 없으면 신규(최대 30). 이미지·음향 둘 다 없으면 무시. 정규화 목록 반환. */
  setVisualCard(roomId: string, req: unknown): VisualCard[] | undefined {
    const room = this.rooms.get(roomId)
    if (!room || !req || typeof req !== 'object') return undefined
    const o = req as Record<string, unknown>
    const name = (typeof o.name === 'string' ? o.name.trim() : '').slice(0, 40)
    if (!name) return undefined
    const image = capImage(o.image)
    const sound = capImage(o.sound)
    if (!image && !sound) return undefined
    const cards = room.visualCards ?? []
    const id = typeof o.id === 'string' && o.id ? o.id.slice(0, 60) : undefined
    const i = id ? cards.findIndex((c) => c.id === id) : -1
    const card: VisualCard = {
      id: id && i >= 0 ? id : randomUUID(),
      name,
      image,
      sound,
      soundSec: coerceSoundSec(o.soundSec, sound),
      displaySec: coerceDisplaySec(o.displaySec, image)
    }
    if (i >= 0) cards[i] = card
    else {
      if (cards.length >= 30) return undefined
      cards.push(card)
    }
    room.visualCards = cards
    room.lastActivityAt = Date.now()
    return cards
  }
  /** 카드 삭제(GM). 삭제 후 목록 반환. */
  deleteVisualCard(roomId: string, cardId: string): VisualCard[] | undefined {
    const room = this.rooms.get(roomId)
    if (!room) return undefined
    room.visualCards = (room.visualCards ?? []).filter((c) => c.id !== cardId)
    room.lastActivityAt = Date.now()
    return room.visualCards
  }
  /** 다이스 결과 라벨로 카드 찾기 — 라벨('대성공' 등)이 카드 이름과 정확히 일치하면 그 카드(트리거용). */
  findCardByTitle(roomId: string, text: string): VisualCard | undefined {
    const t = text.trim()
    if (!t) return undefined
    return this.rooms.get(roomId)?.visualCards?.find((c) => c.name === t)
  }
  /**
   * 채팅·스크립트 본문으로 카드 찾기 — 화면에 보이는 평문 기준으로 카드 이름이 '포함'되면 그 카드.
   * 문장 속 키워드·스크립트 본문 키워드도 발동한다. 여러 카드가 매칭되면 이름이 긴(더 구체적인) 카드
   * 우선, 동률은 등록순.
   */
  findCardInText(roomId: string, text: string): VisualCard | undefined {
    const t = stripChatMarkup(text).trim()
    if (!t) return undefined
    const cards = this.rooms.get(roomId)?.visualCards
    if (!cards?.length) return undefined
    let hit: VisualCard | undefined
    for (const c of cards) {
      if (!c.name || !t.includes(c.name)) continue
      if (!hit || c.name.length > hit.name.length) hit = c
    }
    return hit
  }
  /** id 로 카드 조회(수동 재생용). */
  getVisualCard(roomId: string, cardId: string): VisualCard | undefined {
    return this.rooms.get(roomId)?.visualCards?.find((c) => c.id === cardId)
  }

  /** 맵 배경 설정/해제(방어적 정규화). 저장본 반환, 맵 없으면 undefined. */
  setBackground(roomId: string, mapId: string, bg: MapBackground | null): MapBackground | null | undefined {
    const room = this.rooms.get(roomId)
    const m = room?.maps.get(mapId)
    if (!room || !m) return undefined
    m.background =
      bg && typeof bg === 'object'
        ? {
            image: capImage(bg.image),
            w: clampCoord(bg.w),
            h: clampCoord(bg.h),
            fit: bg.fit === 'contain' || bg.fit === 'cover' ? bg.fit : undefined
          }
        : null
    room.lastActivityAt = Date.now()
    return m.background
  }

  /**
   * 비주얼 노벨 무대 배경 설정/해제(GM 전용 — 권한 검증은 호출 측 relay).
   * image 빈값이면 해제. {ok,image} 반환(ok=false 면 맵 없음 → 미동작).
   */
  setVnBackground(roomId: string, mapId: string, image: string | undefined): { ok: boolean; image?: string } {
    const room = this.rooms.get(roomId)
    const m = room?.maps.get(mapId)
    if (!room || !m) return { ok: false }
    m.vnBackground = capImage(image)
    room.lastActivityAt = Date.now()
    return { ok: true, image: m.vnBackground }
  }

  /** VN 배경 흐림 강도 설정(GM 검증은 relay) — 0=없음. 저장값 반환({ok,blur}), 맵 없으면 ok:false. */
  setVnBgBlur(roomId: string, mapId: string, blur: number): { ok: boolean; blur?: number } {
    const room = this.rooms.get(roomId)
    const m = room?.maps.get(mapId)
    if (!room || !m) return { ok: false }
    m.vnBackgroundBlur = coerceVnBlur(blur)
    room.lastActivityAt = Date.now()
    return { ok: true, blur: m.vnBackgroundBlur }
  }

  /** 맵 배경 단색 설정/해제(GM 전용 — 권한 검증은 호출 측 relay). 빈/무효(비-hex)면 해제. {ok,color} 반환. */
  setMapBgColor(roomId: string, mapId: string, color: string | undefined): { ok: boolean; color?: string } {
    const room = this.rooms.get(roomId)
    const m = room?.maps.get(mapId)
    if (!room || !m) return { ok: false }
    m.bgColor = coerceDimColor(color)
    room.lastActivityAt = Date.now()
    return { ok: true, color: m.bgColor }
  }

  /** 맵 바탕(최후면 이미지+블러) 설정/해제(GM 전용 — 권한 검증은 호출 측 relay). null/무효면 해제. {ok,backdrop} 반환. */
  setMapBackdrop(
    roomId: string,
    mapId: string,
    backdrop: MapBackdrop | null
  ): { ok: boolean; backdrop?: MapBackdrop } {
    const room = this.rooms.get(roomId)
    const m = room?.maps.get(mapId)
    if (!room || !m) return { ok: false }
    m.backdrop = coerceBackdrop(backdrop)
    room.lastActivityAt = Date.now()
    return { ok: true, backdrop: m.backdrop }
  }

  /** 맵 레이어 표시/숨김 전체 교체(GM 전용 — 권한 검증은 relay). 무대 앞 밴드·무대 뒤를 맵 단위로 동기. */
  setMapLayerVis(roomId: string, mapId: string, hidden: unknown): { ok: boolean; hidden?: TokenLayer[] } {
    const room = this.rooms.get(roomId)
    const m = room?.maps.get(mapId)
    if (!room || !m) return { ok: false }
    m.hiddenLayers = coerceHiddenLayers(hidden)
    room.lastActivityAt = Date.now()
    return { ok: true, hidden: m.hiddenLayers }
  }

  /** 맵세트 메타(크로스페이드) 전체 교체(GM 전용 — 권한 검증은 relay). 미지정 필드는 해제. */
  setMapMeta(
    roomId: string,
    mapId: string,
    meta: { crossfade?: boolean }
  ): { ok: boolean; crossfade?: boolean } {
    const room = this.rooms.get(roomId)
    const m = room?.maps.get(mapId)
    if (!room || !m) return { ok: false }
    m.crossfade = meta?.crossfade === true ? true : undefined
    room.lastActivityAt = Date.now()
    return { ok: true, crossfade: m.crossfade }
  }

  /**
   * 맵세트 번들 BGM 저장/해제(GM 전용 — 권한 검증은 relay).
   * 'save'=현재 방 BGM(자산 참조)을 이 맵에 스냅샷(재업로드 없음 · 방이 이미 참조를 들고 있음),
   * 'clear'=번들 해제. {ok,bgm} 반환(bgm=null 이면 미저장). 맵 없으면 ok:false.
   */
  setMapBgm(roomId: string, mapId: string, op: 'save' | 'clear'): { ok: boolean; bgm?: BgmState[] | null } {
    const room = this.rooms.get(roomId)
    const m = room?.maps.get(mapId)
    if (!room || !m) return { ok: false }
    m.bgm = op === 'clear' ? undefined : room.bgm.map((t) => ({ ...t }))
    room.lastActivityAt = Date.now()
    return { ok: true, bgm: m.bgm ?? null }
  }

  /**
   * VN 무대 레이어 스택 전체 교체(GM 전용 — 권한 검증은 호출 측 relay).
   * 방어적 정규화(이미지 캡·개수 상한·z/opacity 클램프). {ok,layers} 반환(ok=false면 맵 없음).
   */
  setVnLayers(roomId: string, mapId: string, layers: unknown): { ok: boolean; layers?: VnLayer[] } {
    const room = this.rooms.get(roomId)
    const m = room?.maps.get(mapId)
    if (!room || !m) return { ok: false }
    m.vnLayers = coerceVnLayers(layers)
    room.lastActivityAt = Date.now()
    return { ok: true, layers: m.vnLayers ?? [] }
  }

  /** 맵 그리드 설정(방어적 정규화: size 8~512 클램프). 저장본 반환, 맵 없으면 undefined. */
  setGrid(roomId: string, mapId: string, grid: GridConfig): GridConfig | undefined {
    const room = this.rooms.get(roomId)
    const m = room?.maps.get(mapId)
    if (!room || !m) return undefined
    const size =
      typeof grid?.size === 'number' ? Math.round(Math.max(8, Math.min(512, grid.size))) : m.grid.size
    m.grid = { size, visible: grid?.visible !== false }
    room.lastActivityAt = Date.now()
    return m.grid
  }

  /** 토큰 컬렉션 해석 — GLOBAL_MAP_ID 면 통합 레이어(방 레벨·모든 맵 유지), 아니면 해당 맵의 tokens. */
  private tokenColl(room: Room, mapId: string): Map<string, Token> | undefined {
    if (mapId === GLOBAL_MAP_ID) return (room.globalTokens ??= new Map<string, Token>())
    return room.maps.get(mapId)?.tokens
  }

  /** 토큰 생성/갱신. id 없으면 신규(randomUUID), 있으면 기존 갱신. 저장본 반환, 맵/컬렉션 없으면 undefined. */
  upsertToken(roomId: string, mapId: string, req: TokenUpsertReq): Token | undefined {
    const room = this.rooms.get(roomId)
    const tokens = room ? this.tokenColl(room, mapId) : undefined
    if (!room || !tokens) return undefined
    const existing = typeof req.id === 'string' ? tokens.get(req.id) : undefined
    const layer = typeof req.layer === 'string' ? coerceLayer(req.layer) : (existing?.layer ?? 'token')
    // 같은 레이어 갱신이면 z 보존, 신규·레이어 이동이면 그 레이어 맨 앞으로(top+1).
    const z =
      existing && (existing.layer ?? 'token') === layer
        ? (existing.z ?? 0)
        : topZ(tokens.values(), layer) + 1
    // 좌표·크기는 유한·범위 클램프, 이미지/식별자는 캡. charPlayerId 는 GM 전용 경로라
    // 길이만 캡 — 이동 권한은 charPlayerId===playerId 일치로만 부여되어 잘못된 id 는 누구에게도 권한 없음.
    const token: Token = {
      id: existing?.id ?? (typeof req.id === 'string' && req.id ? req.id : randomUUID()),
      x: clampCoord(req.x, existing?.x ?? 0),
      y: clampCoord(req.y, existing?.y ?? 0),
      size:
        typeof req.size === 'number' && Number.isFinite(req.size) && req.size > 0
          ? Math.min(req.size, MAX_TOKEN_CELLS)
          : (existing?.size ?? 1),
      // 비정방 스트레치 비율(가로·세로 칸) — 0=해제, 양수=적용, 미지정=기존 보존(크기는 size=긴 변).
      w: req.w === 0 ? undefined : (coerceSpanCells(req.w) ?? existing?.w),
      h: req.h === 0 ? undefined : (coerceSpanCells(req.h) ?? existing?.h),
      rotation:
        typeof req.rotation === 'number' && Number.isFinite(req.rotation) ? req.rotation : existing?.rotation,
      charPlayerId: capId(req.charPlayerId) ?? existing?.charPlayerId,
      label: typeof req.label === 'string' ? req.label.slice(0, 200) : existing?.label,
      color: typeof req.color === 'string' ? req.color.slice(0, 32) : existing?.color,
      image: capImage(req.image) ?? existing?.image,
      layer,
      z,
      flipX: req.flipX === true ? true : req.flipX === false ? undefined : existing?.flipX,
      // 이름/UI 숨김 — 명시값이면 적용(true=숨김, false=해제), 미지정이면 기존 보존.
      hideName: req.hideName === true ? true : req.hideName === false ? undefined : existing?.hideName,
      hideUI: req.hideUI === true ? true : req.hideUI === false ? undefined : existing?.hideUI,
      // 이동/회전 권한 명단 — 배열이면 정규화 적용(빈 배열=해제), 미지정이면 기존 보존.
      allowedPlayers: Array.isArray(req.allowedPlayers)
        ? coercePlayerIds(req.allowedPlayers)
        : existing?.allowedPlayers,
      // 이미지 카드 — 배열이면 적용(최대 20장), 미지정이면 기존 보존. currentIndex 는 정수면 적용, 아니면 보존.
      images: Array.isArray(req.images) ? capImageList(req.images, 20) : existing?.images,
      currentIndex:
        typeof req.currentIndex === 'number' && Number.isInteger(req.currentIndex) && req.currentIndex >= 0
          ? req.currentIndex
          : existing?.currentIndex,
      // 패널 속성 — 불리언은 명시값 적용(true=on, false=해제), 미지정 시 보존. 문자열은 캡·빈값이면 해제.
      lockPos: req.lockPos === true ? true : req.lockPos === false ? undefined : existing?.lockPos,
      lockSize: req.lockSize === true ? true : req.lockSize === false ? undefined : existing?.lockSize,
      terrain: req.terrain === true ? true : req.terrain === false ? undefined : existing?.terrain,
      memo: typeof req.memo === 'string' ? req.memo.slice(0, 500) || undefined : existing?.memo,
      clickAction:
        typeof req.clickAction === 'string'
          ? req.clickAction.slice(0, 500) || undefined
          : existing?.clickAction,
      // 뒷면 이미지 — 문자열이면 적용(빈 문자열=해제), 미지정이면 기존 보존.
      backImage:
        typeof req.backImage === 'string'
          ? req.backImage
            ? capImage(req.backImage)
            : undefined
          : existing?.backImage,
      // 커스텀 상태바 — 배열이면 정규화 적용(빈 배열=해제), 미지정이면 기존 보존.
      bars: Array.isArray(req.bars) ? coerceBars(req.bars) : existing?.bars,
      statsPrivate:
        req.statsPrivate === true ? true : req.statsPrivate === false ? undefined : existing?.statsPrivate,
      // 가져오기 출처 태그·표시 맵 제한 — 편집(upsert)으로는 바뀌지 않는다(가져오기·로드에서만 부여).
      importId: existing?.importId,
      mapIds: existing?.mapIds,
      // 라이브 스탠딩 — 명시값이면 적용(true=on, false=해제), 미지정이면 기존 보존.
      liveStanding:
        req.liveStanding === true ? true : req.liveStanding === false ? undefined : existing?.liveStanding,
      // 버튼 토큰 교체 이미지 — 문자열이면 적용(빈 문자열=해제), 미지정이면 기존 보존(뒷면 이미지와 동일 규칙).
      hoverImage:
        typeof req.hoverImage === 'string'
          ? req.hoverImage
            ? capImage(req.hoverImage)
            : undefined
          : existing?.hoverImage,
      pressImage:
        typeof req.pressImage === 'string'
          ? req.pressImage
            ? capImage(req.pressImage)
            : undefined
          : existing?.pressImage,
      // 상태별 효과음 — 객체가 오면 정규화 적용(빈 객체=해제), 미지정이면 기존 보존.
      sounds: req.sounds !== undefined ? coerceSounds(req.sounds) : existing?.sounds,
      // 공개범위 — visibility 명시값 우선, 없으면 레거시 hidden(true=private·false=해제), 그래도 없으면 기존 보존.
      ...visFields(
        coerceVisibility(req.visibility) ??
          (req.hidden === true
            ? 'private'
            : req.hidden === false
              ? 'all'
              : existing?.visibility ?? (existing?.hidden ? 'private' : undefined))
      )
    }
    tokens.set(token.id, token)
    room.lastActivityAt = Date.now()
    return token
  }

  /** 토큰 이동(위치만). 보관된 토큰 없으면 undefined. 권한 검증은 호출 측(relay). */
  moveToken(roomId: string, mapId: string, id: string, x: number, y: number): Token | undefined {
    const room = this.rooms.get(roomId)
    const token = room ? this.tokenColl(room, mapId)?.get(id) : undefined
    if (!room || !token) return undefined
    token.x = clampCoord(x, token.x)
    token.y = clampCoord(y, token.y)
    room.lastActivityAt = Date.now()
    return token
  }

  /** 토큰 회전(각도만, 라디안). 보관된 토큰 없으면 undefined. 권한 검증은 호출 측(relay · 이동과 동일). */
  rotateToken(roomId: string, mapId: string, id: string, rotation: number): Token | undefined {
    const room = this.rooms.get(roomId)
    const token = room ? this.tokenColl(room, mapId)?.get(id) : undefined
    if (!room || !token) return undefined
    token.rotation = Number.isFinite(rotation) ? rotation : (token.rotation ?? 0)
    room.lastActivityAt = Date.now()
    return token
  }

  /** 토큰 크기(칸, 긴 변) 변경. 0.25~캡(MAX_TOKEN_CELLS) 칸으로 클램프 — 추가(upsertToken)와 같은 상한을 쓴다
   *  (다르면 '넣을 땐 되는데 조절하면 줄어드는' 토큰이 생긴다). 보관된 토큰 없으면 undefined. 권한 검증은 호출 측(relay · 이동과 동일). */
  resizeToken(roomId: string, mapId: string, id: string, size: number): Token | undefined {
    const room = this.rooms.get(roomId)
    const token = room ? this.tokenColl(room, mapId)?.get(id) : undefined
    if (!room || !token) return undefined
    if (Number.isFinite(size)) token.size = Math.max(0.25, Math.min(MAX_TOKEN_CELLS, size))
    room.lastActivityAt = Date.now()
    return token
  }

  /** 이미지 카드의 표시 이미지 인덱스 변경(images 범위로 클램프). 보관된 토큰 없으면 undefined. 권한 검증은 호출 측(relay · 이동과 동일). */
  setTokenImageIndex(roomId: string, mapId: string, id: string, index: number): Token | undefined {
    const room = this.rooms.get(roomId)
    const token = room ? this.tokenColl(room, mapId)?.get(id) : undefined
    if (!room || !token) return undefined
    const max = (token.images?.length ?? 1) - 1
    token.currentIndex = Math.max(0, Math.min(Math.floor(index), Math.max(0, max)))
    room.lastActivityAt = Date.now()
    return token
  }

  /** 토큰 삭제. 삭제된 토큰 반환, 없으면 undefined. */
  removeToken(roomId: string, mapId: string, id: string): Token | undefined {
    const room = this.rooms.get(roomId)
    const coll = room ? this.tokenColl(room, mapId) : undefined
    const prev = coll?.get(id)
    if (!room || !coll || !prev) return undefined
    coll.delete(id)
    room.lastActivityAt = Date.now()
    return prev
  }

  getToken(roomId: string, mapId: string, id: string): Token | undefined {
    const room = this.rooms.get(roomId)
    return room ? this.tokenColl(room, mapId)?.get(id) : undefined
  }

  /**
   * 토큰 z순서/레이어 변경(GM 전용 — 권한 검증은 호출 측 relay). layer 지정 시 그 레이어 맨 앞으로 이동,
   * 아니면 op 로 현재 레이어 내 정렬. 변경된 토큰(0~2개 · forward/backward 는 교환쌍) 반환 → relay 가 각각 token:state 송출.
   */
  reorderToken(
    roomId: string,
    mapId: string,
    id: string,
    req: { op?: TokenZOp; layer?: TokenLayer }
  ): Token[] {
    const room = this.rooms.get(roomId)
    const coll = room ? this.tokenColl(room, mapId) : undefined
    const t = coll?.get(id)
    if (!room || !coll || !t) return []
    const changed: Token[] = []
    const curLayer = t.layer ?? 'token'
    if (req.layer && coerceLayer(req.layer) !== curLayer) {
      const layer = coerceLayer(req.layer)
      // topZ 를 레이어 변경 전에 계산(아직 옛 레이어 → t 자신이 새 레이어 max 에 포함되지 않음).
      const z = topZ(coll.values(), layer) + 1 // 새 레이어 맨 앞으로
      t.layer = layer
      t.z = z
      changed.push(t)
    } else if (req.op) {
      const sibs = [...coll.values()].filter((x) => (x.layer ?? 'token') === curLayer)
      const myz = t.z ?? 0
      if (req.op === 'front') {
        const mx = Math.max(...sibs.map((s) => s.z ?? 0))
        if (myz < mx) {
          t.z = mx + 1
          changed.push(t)
        }
      } else if (req.op === 'back') {
        const mn = Math.min(...sibs.map((s) => s.z ?? 0))
        if (myz > mn) {
          t.z = mn - 1
          changed.push(t)
        }
      } else if (req.op === 'forward') {
        // 바로 위(다음으로 큰 z) 형제와 z 교환.
        const next = sibs.filter((s) => (s.z ?? 0) > myz).sort((a, b) => (a.z ?? 0) - (b.z ?? 0))[0]
        if (next) {
          const nz = next.z ?? 0
          next.z = myz
          t.z = nz
          changed.push(t, next)
        } else {
          // 밴드 맨 앞 → 한 밴드 앞으로 승격(그 밴드 맨 뒤에 붙임). 클라 applyReorder 미러.
          const bi = REORDER_BANDS.indexOf(curLayer)
          if (bi > 0) {
            const up = REORDER_BANDS[bi - 1]
            const ups = [...coll.values()].filter((x) => (x.layer ?? 'token') === up)
            t.layer = up
            t.z = (ups.length ? Math.min(...ups.map((s) => s.z ?? 0)) : 0) - 1
            changed.push(t)
          }
        }
      } else if (req.op === 'backward') {
        // 바로 아래(다음으로 작은 z) 형제와 z 교환.
        const prev = sibs.filter((s) => (s.z ?? 0) < myz).sort((a, b) => (b.z ?? 0) - (a.z ?? 0))[0]
        if (prev) {
          const pz = prev.z ?? 0
          prev.z = myz
          t.z = pz
          changed.push(t, prev)
        } else {
          // 밴드 맨 뒤 → 한 밴드 뒤로 강등(그 밴드 맨 앞에 붙임). bg→behind 면 무대 뒤로.
          const bi = REORDER_BANDS.indexOf(curLayer)
          if (bi >= 0 && bi < REORDER_BANDS.length - 1) {
            const down = REORDER_BANDS[bi + 1]
            const downs = [...coll.values()].filter((x) => (x.layer ?? 'token') === down)
            t.layer = down
            t.z = (downs.length ? Math.max(...downs.map((s) => s.z ?? 0)) : 0) + 1
            changed.push(t)
          }
        }
      }
    }
    if (changed.length) room.lastActivityAt = Date.now()
    return changed
  }

  // ===== 자유 드로잉 =====
  /**
   * 드로잉 획 추가(전원). points 는 유한 숫자만·짝수 길이로 정규화하고 4000개(2000점)로 상한,
   * width 는 1~40 클램프. playerId/color 는 호출 측(relay)이 참가자 정보로 스탬프. 저장본 반환.
   */
  addStroke(
    roomId: string,
    mapId: string,
    req: { id?: unknown; points: unknown; width?: unknown },
    author: { playerId: string; color: string }
  ): Stroke | undefined {
    const room = this.rooms.get(roomId)
    const m = room?.maps.get(mapId)
    if (!room || !m) return undefined
    const raw = Array.isArray(req.points) ? req.points : []
    const pts: number[] = []
    for (const v of raw) {
      if (typeof v === 'number' && Number.isFinite(v)) pts.push(v)
      if (pts.length >= 4000) break
    }
    if (pts.length % 2 !== 0) pts.pop()
    if (pts.length < 2) return undefined // 점이 너무 적으면 획 아님
    const width =
      typeof req.width === 'number' && Number.isFinite(req.width) ? Math.max(1, Math.min(40, req.width)) : 4
    const stroke: Stroke = {
      id: typeof req.id === 'string' && req.id ? req.id : randomUUID(),
      playerId: author.playerId,
      color: author.color,
      width,
      points: pts
    }
    m.drawings.set(stroke.id, stroke)
    room.lastActivityAt = Date.now()
    return stroke
  }

  getStroke(roomId: string, mapId: string, strokeId: string): Stroke | undefined {
    return this.getMap(roomId, mapId)?.drawings.get(strokeId)
  }

  /** 드로잉 획 삭제. 삭제된 획 반환, 없으면 undefined. 권한 검증은 호출 측(relay). */
  eraseStroke(roomId: string, mapId: string, strokeId: string): Stroke | undefined {
    const room = this.rooms.get(roomId)
    const m = room?.maps.get(mapId)
    const prev = m?.drawings.get(strokeId)
    if (!room || !m || !prev) return undefined
    m.drawings.delete(strokeId)
    room.lastActivityAt = Date.now()
    return prev
  }

  /** 맵의 모든 드로잉 삭제(GM 전용 — 호출 측 검증). 맵 있으면 true. */
  clearDrawings(roomId: string, mapId: string): boolean {
    const room = this.rooms.get(roomId)
    const m = room?.maps.get(mapId)
    if (!room || !m) return false
    m.drawings.clear()
    room.lastActivityAt = Date.now()
    return true
  }

  // ===== 맵 텍스트 라벨 =====
  /**
   * 맵 텍스트 생성/편집. id 없으면 신규(작성자=author.playerId), 있으면 기존 편집(텍스트·색·크기·굵기·위치만).
   * 권한 검증(편집은 작성자/GM)은 호출 측(relay). 텍스트가 비면 null(생성 안 함). 맵당 최대 500개.
   */
  upsertText(
    roomId: string,
    mapId: string,
    req: MapTextUpsertReq,
    author: { playerId: string }
  ): MapText | undefined {
    const room = this.rooms.get(roomId)
    const m = room?.maps.get(mapId)
    if (!room || !m) return undefined
    const existing = typeof req.id === 'string' ? m.texts.get(req.id) : undefined
    const text = typeof req.text === 'string' ? req.text.slice(0, 200) : ''
    if (!text) return undefined
    if (!existing && m.texts.size >= 500) return undefined // 폭주 방지 상한
    const label: MapText = {
      id: existing?.id ?? (typeof req.id === 'string' && req.id ? req.id : randomUUID()),
      playerId: existing?.playerId ?? author.playerId, // 작성자는 생성 시 고정(편집해도 불변)
      x: clampCoord(req.x, existing?.x ?? 0),
      y: clampCoord(req.y, existing?.y ?? 0),
      text,
      color:
        typeof req.color === 'string' && req.color ? req.color.slice(0, 32) : (existing?.color ?? '#ffffff'),
      size:
        typeof req.size === 'number' && Number.isFinite(req.size)
          ? Math.max(8, Math.min(200, req.size))
          : (existing?.size ?? 28),
      bold: req.bold === true ? true : req.bold === false ? undefined : existing?.bold
    }
    m.texts.set(label.id, label)
    room.lastActivityAt = Date.now()
    return label
  }

  /** 맵 텍스트 이동(위치만). 권한 검증(작성자/GM)은 호출 측(relay). */
  moveText(roomId: string, mapId: string, id: string, x: number, y: number): MapText | undefined {
    const room = this.rooms.get(roomId)
    const m = room?.maps.get(mapId)
    const t = m?.texts.get(id)
    if (!room || !m || !t) return undefined
    t.x = clampCoord(x, t.x)
    t.y = clampCoord(y, t.y)
    room.lastActivityAt = Date.now()
    return t
  }

  /** 맵 텍스트 삭제. 삭제된 텍스트 반환. 권한 검증(작성자/GM)은 호출 측(relay). */
  removeText(roomId: string, mapId: string, id: string): MapText | undefined {
    const room = this.rooms.get(roomId)
    const m = room?.maps.get(mapId)
    const prev = m?.texts.get(id)
    if (!room || !m || !prev) return undefined
    m.texts.delete(id)
    room.lastActivityAt = Date.now()
    return prev
  }

  getText(roomId: string, mapId: string, id: string): MapText | undefined {
    return this.getMap(roomId, mapId)?.texts.get(id)
  }

  /** 맵의 모든 텍스트 삭제(GM 전용 — 호출 측 검증). 맵 있으면 true. */
  clearTexts(roomId: string, mapId: string): boolean {
    const room = this.rooms.get(roomId)
    const m = room?.maps.get(mapId)
    if (!room || !m) return false
    m.texts.clear()
    room.lastActivityAt = Date.now()
    return true
  }

  // ===== 세션 목록·관리 (서버 영속) =====
  /** 계정의 세션 목록(소유 또는 참여) — 최근 활동 순. */
  listForAccount(accountId: string): RoomSummary[] {
    const out: RoomSummary[] = []
    for (const room of this.rooms.values()) {
      if (room.ownerId === accountId || room.members.has(accountId))
        out.push(this.summaryFor(room, accountId))
    }
    return out.sort((a, b) => b.updatedAt - a.updatedAt)
  }

  /** 세션 메타(이름·카드) 수정 — 소유자만. cardImage=null 이면 제거. 갱신 요약 반환. */
  setMeta(
    roomId: string,
    accountId: string,
    patch: { title?: string; cardImage?: string | null }
  ): RoomSummary | undefined {
    const room = this.rooms.get(roomId)
    if (!room || room.ownerId !== accountId) return undefined
    if (typeof patch.title === 'string' && patch.title.trim()) room.title = patch.title.trim().slice(0, 80)
    if (patch.cardImage === null) room.cardImage = undefined
    else if (typeof patch.cardImage === 'string' && patch.cardImage)
      room.cardImage = capImage(patch.cardImage) ?? room.cardImage
    room.lastActivityAt = Date.now()
    void this.flush(room)
    return this.summaryFor(room, accountId)
  }

  /** 세션 삭제 — 소유자만. 메모리·파일 제거. 알릴 대상(멤버·현재 참가자) 반환. */
  deleteRoom(roomId: string, accountId: string): { members: string[]; participants: string[] } | undefined {
    const room = this.rooms.get(roomId)
    if (!room || room.ownerId !== accountId) return undefined
    const members = [...room.members]
    const participants = [...room.participants.keys()]
    this.rooms.delete(roomId)
    this.codeToId.delete(room.code)
    this.savedAt.delete(roomId)
    this.removeFile(roomId)
    return { members, participants }
  }

  /**
   * 관리자 강제 삭제 — 소유자 검증을 생략하고 방을 제거(권한 검사는 호출 측 relay 가 admin 으로 수행).
   * 통지·정리에 쓰도록 소유자·멤버·현재 참가자를 반환. 없는 방이면 undefined.
   */
  adminDeleteRoom(roomId: string): { ownerId: string; members: string[]; participants: string[] } | undefined {
    const room = this.rooms.get(roomId)
    if (!room) return undefined
    const ownerId = room.ownerId
    const members = [...room.members]
    const participants = [...room.participants.keys()]
    this.rooms.delete(roomId)
    this.codeToId.delete(room.code)
    this.savedAt.delete(roomId)
    this.removeFile(roomId)
    return { ownerId, members, participants }
  }

  /**
   * 한 계정이 소유한 모든 세션방 삭제(계정 탈퇴 연쇄). 각 방의 참가자 목록(강제 퇴장 통지용)과 함께 반환.
   * 소유자가 사라진 방은 GM 권한을 행사할 주체가 없어 사실상 좀비 — 그래서 통째로 제거한다.
   */
  deleteOwnedBy(accountId: string): { id: string; participants: string[] }[] {
    if (!accountId) return []
    const out: { id: string; participants: string[] }[] = []
    for (const room of [...this.rooms.values()]) {
      if (room.ownerId !== accountId) continue
      const participants = [...room.participants.keys()]
      this.rooms.delete(room.id)
      this.codeToId.delete(room.code)
      this.savedAt.delete(room.id)
      this.removeFile(room.id)
      out.push({ id: room.id, participants })
    }
    return out
  }

  /** 세션 복사 — 소유자만. 장면(맵·자료·외형·BGM·카드)만 복제, 참가자·채팅·멤버는 초기화. 새 방 요약 반환. */
  duplicateRoom(roomId: string, accountId: string): RoomSummary | undefined {
    const src = this.rooms.get(roomId)
    if (!src || src.ownerId !== accountId) return undefined
    const id = randomUUID()
    let code = genCode()
    while (this.codeToId.has(code)) code = genCode()
    const now = Date.now()
    const maps = new Map<string, RoomMap>()
    for (const m of src.maps.values()) {
      const c = coerceLoadedMap(toWireMap(m)) // 깊은 복사(wire 왕복)
      if (c) maps.set(c.id, c)
    }
    const handouts = new Map<string, Handout>()
    for (const h of src.handouts.values()) handouts.set(h.id, { ...h })
    const room: Room = {
      id,
      code,
      title: src.title + ' (사본)',
      ownerId: accountId,
      members: new Set([accountId]),
      cardImage: src.cardImage,
      participants: new Map(),
      characters: new Map(),
      handouts,
      maps,
      activeMapId: maps.has(src.activeMapId) ? src.activeMapId : (maps.keys().next().value as string),
      appearance: { ...src.appearance },
      cutInImage: src.cutInImage,
      cutInImages: src.cutInImages ? { ...src.cutInImages } : undefined,
      dimColor: src.dimColor,
      madnessTables: src.madnessTables
        ? {
            realtimeTemp: [...src.madnessTables.realtimeTemp],
            realtimeIndef: [...src.madnessTables.realtimeIndef],
            summary: [...src.madnessTables.summary]
          }
        : undefined,
      luckEnabled: src.luckEnabled, // 행운 깎기 사용 여부 복제
      vnOverlay: src.vnOverlay, // VN 오버레이 표시 여부 복제
      bgm: src.bgm.map((t) => ({ ...t })),
      combat: null,
      channels: new Map(),
      messages: [],
      charRooms: new Map(),
      createdAt: now,
      lastActivityAt: now
    }
    this.rooms.set(id, room)
    this.codeToId.set(code, id)
    void this.flush(room)
    return this.summaryFor(room, accountId)
  }

  /** 세션 채팅 로그 전체 삭제 — 소유자만. 성공 시 true. */
  clearChat(roomId: string, accountId: string): boolean {
    const room = this.rooms.get(roomId)
    if (!room || room.ownerId !== accountId) return false
    room.messages = []
    room.lastActivityAt = Date.now()
    this.journal(roomId, { op: 'clear' })
    void this.flush(room)
    return true
  }

  participants(room: Room): Participant[] {
    return [...room.participants.values()]
  }

  /** viewer 지정 시 handouts 는 그 사람이 볼 수 있는 것만(없으면 전체 — 테스트/하위호환용). */
  snapshot(room: Room, viewer?: { playerId: string; role: Participant['role'] }): RoomState {
    // 히스토리는 뷰어별로 걸러 내보낸다 — 귓속말·비밀 메시지가 제3자 스냅샷에 실리지 않게(와이어 노출 차단).
    const visible = viewer
      ? room.messages.filter((m) =>
          canSeeMessage(m, viewer, (gid) => this.canAccessChannel(room.id, gid, viewer.playerId))
        )
      : room.messages
    const { messages, avatarPool } = packAvatars(visible) // 채팅 두상 풀 분리 — 스냅샷 크기 절감
    return {
      id: room.id,
      code: room.code,
      title: room.title,
      ownerId: room.ownerId,
      cardImage: room.cardImage,
      participants: this.participants(room),
      characters: [...room.characters.values()],
      messages,
      avatarPool, // 채팅 두상 풀 — 클라가 avatarRef 복원에 사용
      handouts: viewer ? this.handoutsFor(room, viewer) : [...room.handouts.values()],
      // 공개범위에 따라 뷰어별 표현(앞면/뒷면/미표시)으로 변환한다(클라 은닉 신뢰 X · 와이어 노출 차단).
      maps: [...room.maps.values()].map((m) => {
        const wire = toWireMap(m)
        if (!viewer) return wire
        return {
          ...wire,
          tokens: wire.tokens.map((t) => tokenForViewer(t, viewer)).filter((t): t is Token => t !== null)
        }
      }),
      activeMapId: room.activeMapId,
      appearance: room.appearance,
      cutInImage: room.cutInImage,
      cutInImages: room.cutInImages,
      dimColor: room.dimColor,
      madnessTables: room.madnessTables, // GM 커스텀 광기표
      luckEnabled: room.luckEnabled, // 행운 깎기 사용 여부
      vnOverlay: room.vnOverlay, // VN 오버레이 표시 여부
      bgm: room.bgm,
      combat: room.combat,
      channels: this.channelsFor(room, viewer),
      charRoomIds: viewer ? (room.charRooms.get(viewer.playerId) ?? []) : [], // 요청자의 이 방 시트 멤버십
      saveSlots: this.slotMeta(room), // 저장 슬롯 메타(목록 표시용)
      visualCards: room.visualCards ?? [], // 비주얼 카드 목록
      // 통합 레이어 토큰 — 맵을 넘어 유지. 공개범위/양면/상태비공개 필터를 맵 토큰과 동일 적용.
      globalTokens: room.globalTokens
        ? viewer
          ? [...room.globalTokens.values()]
              .map((t) => tokenForViewer(t, viewer))
              .filter((t): t is Token => t !== null)
          : [...room.globalTokens.values()]
        : []
    }
  }

  /** 방 시트 멤버십: playerId 의 이 방 charId 목록(없으면 []). */
  roomCharsFor(roomId: string, playerId: string): string[] {
    return this.rooms.get(roomId)?.charRooms.get(playerId) ?? []
  }

  /** 방에 내 시트 추가. 이미 있으면 무시. 갱신된 목록 반환(없으면 undefined). */
  addRoomChar(roomId: string, playerId: string, charId: string): string[] | undefined {
    const room = this.rooms.get(roomId)
    if (!room || !charId) return undefined
    const cur = room.charRooms.get(playerId) ?? []
    if (!cur.includes(charId)) {
      room.charRooms.set(playerId, [...cur, charId])
      room.lastActivityAt = Date.now()
    }
    return room.charRooms.get(playerId) ?? []
  }

  /** 방에서 내 시트 제거(라이브러리 원본은 유지). 갱신된 목록 반환. */
  removeRoomChar(roomId: string, playerId: string, charId: string): string[] | undefined {
    const room = this.rooms.get(roomId)
    if (!room) return undefined
    const cur = room.charRooms.get(playerId) ?? []
    room.charRooms.set(
      playerId,
      cur.filter((id) => id !== charId)
    )
    room.lastActivityAt = Date.now()
    return room.charRooms.get(playerId) ?? []
  }

  /** 접속자 없이 maxIdleMs 이상 방치된 방 정리. 정리된 roomId 목록 반환. 영속 모드는 정리 안 함(소유자 삭제만). */
  sweepStale(maxIdleMs: number, now = Date.now()): string[] {
    if (this.persist) return []
    const removed: string[] = []
    for (const room of this.rooms.values()) {
      const anyConnected = [...room.participants.values()].some((p) => p.connected)
      if (!anyConnected && now - room.lastActivityAt > maxIdleMs) {
        this.rooms.delete(room.id)
        this.codeToId.delete(room.code)
        removed.push(room.id)
      }
    }
    return removed
  }

  /** 진단용. */
  get roomCount(): number {
    return this.rooms.size
  }

  /**
   * 관리자 용량 산출 — 한 계정이 소유한 방들의 직렬화 바이트 합 + 참조 자산 해시 집합(방 개수 포함).
   * 직렬화 형식은 디스크 저장(roomToFile)과 동일해 실제 점유와 거의 일치한다.
   */
  usageForOwner(accountId: string): {
    count: number
    bytes: number
    refs: Set<string>
    list: { id: string; title?: string; code: string; bytes: number }[]
  } {
    let bytes = 0
    const refs = new Set<string>()
    const list: { id: string; title?: string; code: string; bytes: number }[] = []
    for (const room of this.rooms.values()) {
      if (room.ownerId !== accountId) continue
      try {
        const json = JSON.stringify(roomToFile(room))
        const b = Buffer.byteLength(json, 'utf8')
        bytes += b
        scanAssetRefs(json, refs)
        list.push({ id: room.id, title: room.title, code: room.code, bytes: b })
      } catch {
        /* 직렬화 실패 방어 — 해당 방만 건너뜀 */
      }
    }
    return { count: list.length, bytes, refs, list }
  }

  /**
   * 보유한 전 방에서 참조 중인 'asset:<해시>' 를 into 에 수집(자산 GC 라이브 집합).
   * 인메모리 방이 진실원본 — 디스크 flush 가 지연돼도(자동저장 주기) 최신 참조를 누락하지 않는다.
   */
  collectAssetRefs(into: Set<string>): void {
    for (const room of this.rooms.values()) {
      try {
        scanAssetRefs(JSON.stringify(roomToFile(room)), into)
      } catch {
        // 통째로는 문자열이 안 되는 방이다. 여기서 건너뛰면 그 방이 쓰는 이미지가 '아무도 안 쓴다'로
        // 판정돼 주기 정리에 지워진다 — 방은 멀쩡한데 그림만 사라진다. 그러니 조각으로 나눠 훑는다.
        try {
          for (const m of room.messages) scanAssetRefs(JSON.stringify(m), into)
        } catch {
          /* 메시지 하나가 이미 한계를 넘는 지경 — 아래 나머지라도 훑는다 */
        }
        for (const part of [
          () => [...room.maps.values()].map(toWireMap),
          () => [...room.handouts.values()],
          () => [...room.channels.values()],
          () => room.characters ?? [],
          () => [room.appearance, room.cutInImage, room.cutInImages, room.bgm, room.saveSlots, room.visualCards]
        ]) {
          try {
            scanAssetRefs(JSON.stringify(part()), into)
          } catch {
            /* 그 조각만 건너뜀 */
          }
        }
      }
    }
  }

  /** 멤버 본인 이전 — 이 계정이 소유한 모든 방을 영속 파일 형태(roomToFile = 전체 장면·채팅)로 내보낸다. */
  exportOwnedBy(accountId: string): Record<string, unknown>[] {
    if (!accountId) return []
    const out: Record<string, unknown>[] = []
    for (const room of this.rooms.values()) {
      if (room.ownerId === accountId) out.push(roomToFile(room))
    }
    return out
  }

  /**
   * 멤버 본인 이전(가져오기) — 내보낸 방 파일들을 이 계정 소유로 복원한다. 새 id·고유 코드를 발급하고
   * 소유자·멤버·참가자를 가져오는 계정만으로 재구성한다(옛 참가자 id 는 새 서버에 없으므로 코드로 재입장하게 둠).
   * 장면·채팅 기록은 그대로 보존. 반환=복원된 방 수.
   */
  importOwnedBy(accountId: string, files: unknown, ownerNick: string): number {
    if (!accountId || !Array.isArray(files)) return 0
    let imported = 0
    for (const f of files) {
      if (imported >= 200) break // 안전 상한
      const room = roomFromFile(f)
      if (!room) continue
      const id = randomUUID()
      let code = genCode()
      while (this.codeToId.has(code)) code = genCode()
      room.id = id
      room.code = code
      room.ownerId = accountId
      room.members = new Set([accountId])
      room.participants = new Map<string, Participant>([
        [
          accountId,
          { playerId: accountId, nick: (ownerNick || '탐사자').slice(0, 80), color: DEFAULT_PL_COLOR, role: 'GM', connected: false }
        ]
      ])
      room.charRooms = new Map() // 시트 멤버십은 옛 playerId 기준이라 초기화(소유자가 방에 다시 추가)
      room.lastActivityAt = Date.now()
      this.rooms.set(id, room)
      this.codeToId.set(code, id)
      void this.flush(room) // 즉시 영속
      imported++
    }
    return imported
  }
}
