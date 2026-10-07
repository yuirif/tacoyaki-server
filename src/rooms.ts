// 방 스토어 — 서버가 방/참가자/메시지의 진실원본.
// 세션방 영속: persist 모드면 방을 <dataDir>/rooms/<id>.json 에 저장(장면·메타·멤버·전체 채팅).
// 시작 시 로드, 변경 시 주기적 자동저장(lastActivityAt 기준 dirty flush). 방은 소유자 삭제 전까지 유지(유휴 정리 안 함).
import { randomUUID } from 'node:crypto'
import {
  readFileSync,
  existsSync,
  readdirSync,
  unlinkSync,
  appendFileSync,
  writeFileSync,
  statSync,
  mkdirSync,
  truncateSync,
  openSync,
  readSync,
  closeSync
} from 'node:fs'
import { mkdir, writeFile, rename, unlink } from 'node:fs/promises'
import { join } from 'node:path'
import { capImage, capImageList, capId, clampCoord } from './limits'
import { collectAssetRefs as scanAssetRefs, dataUrlHash } from './assets'
import type {
  Appearance,
  BgmState,
  Channel,
  Combatant,
  CombatState,
  ChatMessage,
  DeckCard,
  DeckUpsertReq,
  DeckView,
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
  TokenPlacePlReq,
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
/**
 * 방이 메모리에 들고 있는 대화 수 — 입장할 때 통째로 내려보내는 몫이라 무한정 늘릴 수 없다.
 * 여기서 넘치는 앞부분은 **버리지 않고** 보관소(<방>.archive.NNN.jsonl)로 옮긴다(evictOldest).
 * 보관분은 채팅 창의 '보관된 이전 대화 불러오기'로 언제든 되읽는다.
 */
// ⚠ 클라 런타임 상한(src/renderer/src/store/useChatStore.ts 의 RUNTIME_CHAT_LIMIT)과 같은 값이어야 한다.
// 클라가 더 작으면 입장할 때 받은 앞부분을 도로 버려 화면·내보내기에서 대화가 사라진다.
const MAX_HISTORY = 20000
/** 보관소 한 조각의 크기 상한 — 넘으면 다음 번호로 넘어간다(되읽을 때 한 조각만 읽으면 되게). */
const ARCHIVE_PART_BYTES = 8 * 1024 * 1024
/** 보관소 조각 번호 상한. 여기 닿으면 마지막 조각을 계속 키운다 — 늦게 읽힐지언정 잃지는 않는다. */
const ARCHIVE_PART_MAX = 999
/** 되읽기 한 번에 훑는 보관 줄 수 상한 — 볼 수 없는 대화만 이어져도 요청 하나가 오래 붙들지 않게. */
const ARCHIVE_SCAN_LIMIT = 4000
/** 되읽기 한 번에 돌려주는 대화 수 상한. */
const ARCHIVE_PAGE_MAX = 500
/** 계정 이전 내보내기에 실을 보관 대화 수 상한 — 통째로 메모리에 올리는 길이라 끝을 둔다. */
const ARCHIVE_EXPORT_MAX = 200_000
/** 읽어 둔 채로 들고 있는 보관 조각 수 — 여러 사람이 서로 다른 방을 번갈아 읽어도 재파싱이 잦지 않게. */
const ARCHIVE_PAGE_CACHE = 4
/** 보관 조각의 두상 사전 줄에서 열쇠(자산 해시)만 뽑는다 — 그림 목록을 조각에서 되세울 때 쓴다. */
const ARCHIVE_AVATAR_KEY_RE = /"op":"av","k":"([0-9a-f]{64})"/g
/** 한 번에 보관소로 옮기는 대화 수 상한 — 쓰기가 막혔을 때 매 마디마다 밀린 전량을 다시 직렬화하지 않게. */
const ARCHIVE_APPEND_MAX = 2000
/** 보관에 실패한 방이 다시 시도하기까지 쉬는 시간 — 막힌 디스크를 말 한 마디마다 두드리지 않게. */
const ARCHIVE_RETRY_MS = 30_000
/**
 * 보관이 막혀도 방이 메모리에 들고 있을 수 있는 마지막 선.
 * 여기 닿으면 사본 없이 앞부분을 버린다 — 아까운 일이지만, 그대로 두면 그 방 하나가 서버를 세워
 * 다른 모든 방의 최근 대화까지 함께 잃는다. 버린 사실은 관리 화면에 지워지지 않는 경고로 남긴다.
 */
const MAX_HISTORY_HARD = MAX_HISTORY * 2
/** 캐릭터 보관대 상한 — 한 방에서 오간 저널이 아무리 많아도 이만큼만 남긴다(오래된 것부터 덜어 낸다). */
const MAX_CHAR_POOL = 200
/** 한 사람이 보관대에 남길 수 있는 항목 수 — 공용 상한만 있으면 한 사람이 charId 를 바꿔 가며
 *  풀 전체를 채워 다른 사람·GM 의 항목(토큰·화자 각인의 근거)을 조용히 밀어낼 수 있다. */
const MAX_CHAR_POOL_PER_PLAYER = 16
/** 맵당 오브젝트 개수 상한 — 방 상태 팽창 방어(coerceLoadedMap 모든 진입점 적용). */
const MAX_TOKENS_PER_MAP = 2000
/** 1인당 참가자 창작 오브젝트(ownerPlayerId 스탬프) 상한 — 방 전체(모든 맵) 합산. 초과 배치는 무시. */
const MAX_PL_OBJECTS_PER_PLAYER = 30
/** 방이 들고 있는 GM 선택지 개수 상한 — 넘으면 오래된 것부터 버린다(옵션 스크립트가 무거워 무제한 불가). */
const MAX_ROOM_CHOICES = 100
const MAX_DRAWINGS_PER_MAP = 2000
/** 방이 들고 있는 덱 수 상한 — 방 파일과 입장 스냅샷에 통째로 실리므로 끝을 둔다. */
const MAX_DECKS = 12
/** 방이 들고 있는 비주얼 카드 수 상한. 화자를 갈라 같은 이름으로 여러 장을 두는 쓰임이 생겨 넉넉히 잡는다. */
const MAX_VISUAL_CARDS = 60
/** 카드 한 장에 매어 둘 수 있는 화자 수 — 목록이 방 파일과 스냅샷에 그대로 실리므로 끝을 둔다. */
const MAX_CARD_SPEAKERS = 16
/** 한 덱의 카드 정의 수 상한(그림이 붙을 수 있어 넉넉하되 무한은 아니게). */
const MAX_DECK_CARDS = 120
/** 같은 카드를 몇 장까지 넣을 수 있는지 — 남은 더미가 카드 정의 수보다 지나치게 부풀지 않게. */
const MAX_DECK_CARD_COUNT = 99
/** 한 덱의 총 장수 상한(count 합) — 섞기가 만드는 배열의 크기. */
const MAX_DECK_TOTAL = 400
/** 한 번에 뽑을 수 있는 장수. */
const MAX_DECK_DRAW = 10
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
  /**
   * 공동 GM 계정 id — 소유자가 방 안에서 지정한다. 영속.
   *
   * 소유자는 언제나 GM 이므로 여기 담지 않는다(담으면 양도할 때 두 곳을 맞춰야 하는 이중 원본이 된다).
   * 참가자 레코드의 role 은 이 집합에서 파생된다 — 나갔다 들어와도, 서버가 다시 켜져도 자격이 남는다.
   */
  gmIds: Set<string>
  members: Set<string> // 참여한 적 있는 계정 id(목록용 · 소유자 포함)
  cardImage?: string // 세션 카드 이미지(1200×600 data URL)
  participants: Map<string, Participant> // key: playerId
  characters: Map<string, SharedCharacter> // key: playerId (프레즌스 서브셋 · 지금 장착한 캐릭터 한 명)
  /**
   * 캐릭터 보관대 — key: playerId + charId. 로스터에서 밀려난 캐릭터도 여기 남아,
   * 맵에 놓아 둔 그 캐릭터의 토큰이 이름·색·두상·수치를 잃지 않는다. 영속.
   */
  charPool: Map<string, SharedCharacter>
  handouts: Map<string, Handout> // key: handout id (GM 자료)
  maps: Map<string, RoomMap> // key: map id (맵세트)
  activeMapId: string // 전원이 보는 활성 맵
  appearance: Appearance // 방 GM 강제 테마·다이스 카드
  cutInImage?: string // 방 주사위 연출 카드 이미지(data URL · GM 설정 · 레벨별 미설정 시 공통 폴백)
  cutInImages?: Partial<Record<SuccessLevel, string>> // 성공 단계별 연출 카드(GM 설정 · 전원 동기화)
  dimColor?: string // ~문장~ 행동지문 색(GM 설정 · 전원 동기화 · hex)
  madnessTables?: MadnessTables // GM 커스텀 광기표 — 미설정이면 클라 기본 표. 전원 동기화·영속.
  /**
   * 입실 잠금(공사중). 켜면 방을 만든 사람 말고는 못 들어온다 — 준비 중인 방에 초대 코드를 아는
   * 사람이 불쑥 들어오는 것을 막는다. 이미 들어와 있는 사람은 내보내지 않는다. 영속.
   */
  locked?: boolean
  luckEnabled?: boolean // 행운 깎기(CoC7 하우스룰) 사용 여부 — GM 토글·전원 동기화·영속. 미설정=사용(기본).
  vnOverlay?: boolean // 일반 맵 위 VN 오버레이(대사창+발화자 스탠딩) 표시 — GM 토글·전원 동기화·영속. 미설정=꺼짐.
  plObjects?: boolean // 참가자 오브젝트 추가 허용(이미지 토큰·스티커) — GM 토글·전원 동기화·영속. 미설정=꺼짐.
  /**
   * GM 의 귓속말 열람. 켜 두면 그 뒤로 오가는 1:1 귓속말이 GM 에게도 전달된다 — GM 토글·전원 동기화·영속.
   * 미설정=꺼짐. 열림 여부는 방 설정이 아니라 말마다 찍히는 각인(ChatMessage.gmVisible)이 정하므로,
   * 켜기 전에 오간 말은 나중에 켜도 열리지 않는다(뒤늦게 지난 사생활이 통째로 드러나지 않게).
   */
  gmSeeWhispers?: boolean
  bgm: BgmState[] // 방 BGM 트랙들 (다중, GM 제어·전원 동기화 · 최대 5)
  combat: CombatState | null // 방 전투 상태 (GM 제어·전원 동기화 · in-memory, 비영속)
  saveSlots?: SaveSlot[] // 저장 슬롯(반면 전체 명명 저장 · GM · 최대 3 · 영속)
  visualCards?: VisualCard[] // 비주얼 카드 — GM 등록·전원 동기화 · 영속
  /**
   * 덱(카드 뭉치) — GM 이 만들고 방 전원이 뽑는다. 영속.
   * 남은 더미(draw)는 서버만 들고 있는다 — 내보내면 다음에 무엇이 나올지가 그대로 새어 나간다.
   */
  decks?: Deck[]
  globalTokens?: Map<string, Token> // 통합 레이어 — 맵세트를 넘어 모든 맵세트에 유지되는 토큰. key=token id · 영속
  channels: Map<string, Channel> // 그룹 채널(GM 개설·영속). key=channelId
  /** GM 선택지 — key=선택지 메시지 id. 옵션(스크립트 포함·비공개) + 이미 응답한 사람. 영속.
   *  영속이 아니면 서버가 한 번 재시작하는 순간 화면에 남은 선택지 카드가 전부 죽은 단추가 된다
   *  (눌러도 서버가 모르는 선택지라 조용히 무시). 최근 MAX_ROOM_CHOICES 개만 보관. */
  choices?: Map<string, { options: { id: string; label: string; script?: string }[]; responders: Map<string, string> }>
  messages: ChatMessage[]
  /** 방별 캐릭터 시트 멤버십 — playerId(=계정) → 이 방에 속한 charId[]. 영속. 시트 데이터는 계정 라이브러리에. */
  charRooms: Map<string, string[]>
  createdAt: number
  lastActivityAt: number
}

/**
 * 덱의 서버 보관본 — 공개본(DeckView)에 '남은 더미'를 더한 것.
 * draw 는 카드 정의 id 를 장수만큼 늘어놓고 섞은 배열이며, 뒤에서 하나씩 꺼내 쓴다.
 */
interface Deck {
  id: string
  name: string
  cards: DeckCard[]
  /** 남은 더미(정의 id · 뒤에서 뽑는다). 서버 밖으로 내보내지 않는다. */
  draw: string[]
  /**
   * 버린 더미(뽑은 순서). by 가 있으면 '비밀로' 뽑은 것이라 그 사람과 GM 에게만 보인다 —
   * 없으면 공개 뽑기라 전원이 본다. 게임 규칙에는 쓰이지 않는 표시용이라 사람마다 잘라 보내도 안전하다
   * (섞기·자동 섞기는 언제나 카드 정의에서 한 벌을 새로 만든다).
   */
  discard: { id: string; by?: string }[]
  announce: boolean
  reshuffle: boolean
  revealCards: boolean
  who: 'all' | 'gm'
  createdAt: number
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
  /**
   * 이 카드를 쓸 화자들(보관대 키 = poolKey(playerId, charId)). 비었거나 없으면 누구의 발화에도 뜬다.
   *
   * ⚠ charId 만으로는 사람을 못 가린다 — 캐릭터를 장착하지 않은 발화의 charId 는 사람마다 값이 같은
   *    'owner' 고정 문자열이다. 그래서 보관대와 같은 (사람, 캐릭터) 쌍을 열쇠로 쓴다.
   */
  for?: string[]
}

/** 카드를 고를 때 보는 발화자. 서버가 발화 시점에 각인한 값을 그대로 넘긴다(클라 전송값이 아니다). */
export interface CardSpeaker {
  playerId?: string
  charId?: string
}

/** 세션방 목록 항목(room:list). 카드·메타만 — 장면/채팅 본문은 입장 시 스냅샷으로. 클라 protocol 과 미러. */
export interface RoomSummary {
  id: string
  code: string
  title: string
  cardImage?: string
  owner: boolean // 요청 계정이 소유자인지(삭제·복사·이름 변경은 소유자만)
  gm?: boolean // 요청 계정이 이 방의 GM 인지(소유자 또는 공동 GM). 옛 서버는 안 보낸다
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
/**
 * 이 계정이 그 방의 GM 인가 — 소유자이거나 공동 GM 으로 지정된 사람.
 *
 * 방 안의 권한은 참가자 레코드의 role 이 정하고, 그 role 은 입장할 때 이 함수로 정해진다.
 * 방 밖(입장 자격·잠금 통과·세션 목록)에서는 참가자 레코드가 없을 수 있어 이 함수를 직접 쓴다.
 */
export function isGm(room: { ownerId: string; gmIds: Set<string> }, accountId: string | undefined): boolean {
  return !!accountId && (room.ownerId === accountId || room.gmIds.has(accountId))
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
      color: typeof o.color === 'string' ? o.color.slice(0, 16) || undefined : undefined,
      link: o.link === 'hp' || o.link === 'mp' || o.link === 'san' ? o.link : undefined
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
    charId: capId(o.charId),
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
    // 클릭 연출 카드 묶임 — 디스크 로드·방 불러오기에서도 보존(빠뜨리면 재시작마다 버튼이 풀린다).
    clickCardId: typeof o.clickCardId === 'string' ? o.clickCardId.slice(0, 64) || undefined : undefined,
    backImage: capImage(o.backImage),
    bars: coerceBars(o.bars),
    statsPrivate: o.statsPrivate === true ? true : undefined,
    importId: capId(o.importId), // 가져오기 출처 태그(로드·가져오기 보존)
    ownerPlayerId: capId(o.ownerPlayerId), // 참가자 창작 오브젝트 소유자(로드 보존 — 재시작해도 제 것만 만진다)
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
    imageAlign: o.imageAlign === 'center' || o.imageAlign === 'right' ? o.imageAlign : undefined,
    folder: typeof o.folder === 'string' && o.folder ? o.folder.slice(0, 60) : undefined,
    // 정렬 키가 없으면 없는 그대로 둔다 — 옛 데이터는 createdAt 폴백으로 생성순 유지.
    sortKey: typeof o.sortKey === 'number' && Number.isFinite(o.sortKey) ? o.sortKey : undefined,
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
/**
 * 이 방의 채팅 두상이 자산 저장소에 어떤 이름으로 들어가 있는지 모아 준다(자산 GC 라이브 집합).
 *
 * 두상은 방에는 data URL 로 남고, 입장 스냅샷을 보낼 때만 자산으로 내부화된다. 그래서 'asset:' 문자열만
 * 훑는 수집기는 그 파일을 못 찾아 '아무도 안 쓴다'고 판정한다. 같은 두상이 수천 줄에 반복되므로
 * 문자열→해시 결과를 방 단위로 기억해 두 번 계산하지 않는다.
 */
function collectAvatarHashes(room: Room, into: Set<string>): void {
  const memo = new Map<string, string | null>()
  for (const m of room.messages) {
    const a = m.avatar
    if (typeof a !== 'string' || !a.startsWith('data:')) continue
    let h = memo.get(a)
    if (h === undefined) {
      h = dataUrlHash(a)
      memo.set(a, h)
    }
    if (h) into.add(h)
  }
}

export function canSeeMessage(
  m: ChatMessage,
  viewer: { playerId: string; role: Participant['role'] },
  canAccessGroup?: (groupId: string) => boolean
): boolean {
  if (m.secret) return m.playerId === viewer.playerId || viewer.role === 'GM'
  // 귓속말은 주고받은 두 사람만. 단 발화 당시 방이 GM 열람을 켜 두었다면(각인) GM 도 본다 —
  // 지금의 방 설정이 아니라 각인을 보므로, 설정을 켠다고 지난 귓속말이 소급해서 열리지 않는다.
  if (m.channel === 'whisper')
    return (
      m.playerId === viewer.playerId ||
      m.to === viewer.playerId ||
      (m.gmVisible === true && viewer.role === 'GM')
    )
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
  'box', 'bubble', 'bar', 'img', 'dim', 'roll', 'css'
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

/** 덱 카드 정의 정규화 — 이름 필수(60캡)·설명 300캡·장수 1~99·그림 용량 캡. */
function coerceDeckCards(v: unknown): DeckCard[] {
  if (!Array.isArray(v)) return []
  const out: DeckCard[] = []
  let total = 0
  for (const c of v) {
    if (out.length >= MAX_DECK_CARDS || total >= MAX_DECK_TOTAL) break
    if (!c || typeof c !== 'object') continue
    const o = c as Record<string, unknown>
    const name = (typeof o.name === 'string' ? o.name.trim() : '').slice(0, 60)
    if (!name) continue
    const text = (typeof o.text === 'string' ? o.text.trim() : '').slice(0, 300)
    const raw = typeof o.count === 'number' && Number.isFinite(o.count) ? Math.round(o.count) : 1
    // 총 장수 상한에 걸리면 남은 자리만큼만 넣는다 — 통째로 버리면 카드가 조용히 사라진다.
    const count = Math.max(1, Math.min(MAX_DECK_CARD_COUNT, raw, MAX_DECK_TOTAL - total))
    total += count
    const card: DeckCard = { id: capId(o.id) || randomUUID(), name }
    const image = capImage(o.image)
    if (image) card.image = image
    if (text) card.text = text
    if (count > 1) card.count = count
    out.push(card)
  }
  return out
}

/** 카드 정의를 장수만큼 늘어놓는다 — 섞기 전의 한 벌. */
function deckPile(cards: DeckCard[]): string[] {
  const out: string[] = []
  for (const c of cards) for (let i = 0; i < Math.max(1, c.count ?? 1); i++) out.push(c.id)
  return out
}

/** 제자리 섞기(피셔-예이츠). 뽑기는 배열 뒤에서 꺼내므로 앞뒤 치우침 없이 고르게 섞여야 한다. */
function shufflePile(pile: string[]): string[] {
  for (let i = pile.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1))
    ;[pile[i], pile[j]] = [pile[j], pile[i]]
  }
  return pile
}

/** 덱의 총 장수(count 합) — 남은 장수와 함께 '몇 장 중 몇 장'을 보여 주는 데 쓴다. */
function deckTotal(d: Deck): number {
  let n = 0
  for (const c of d.cards) n += Math.max(1, c.count ?? 1)
  return n
}

/**
 * 덱 → 참가자에게 내보낼 공개본.
 * 남은 더미의 순서는 절대 싣지 않는다 — 실으면 다음에 나올 카드가 그대로 보인다.
 * 카드 목록을 감춘 덱은 GM 에게만 정의를 보인다(무엇이 들었는지가 놀이의 일부일 수 있다).
 */
function deckView(d: Deck, viewer?: { role: Participant['role']; playerId?: string }): DeckView {
  const hide = !d.revealCards && viewer?.role !== 'GM'
  // '비밀로' 뽑은 카드는 뽑은 사람과 GM 에게만. 남은 장수는 모두에게 알린다(그것까지 감추면 판이 어긋난다).
  const seen = (e: { id: string; by?: string }): boolean =>
    !e.by || viewer?.role === 'GM' || e.by === viewer?.playerId
  return {
    id: d.id,
    name: d.name,
    cards: hide ? [] : d.cards,
    remaining: d.draw.length,
    total: deckTotal(d),
    discard: hide ? [] : d.discard.filter(seen).map((e) => e.id),
    announce: d.announce,
    reshuffle: d.reshuffle,
    revealCards: d.revealCards,
    who: d.who,
    createdAt: d.createdAt
  }
}

/** 덱 배열 정규화(로드용) — 최대 MAX_DECKS, 이름 필수·40캡. 남은 더미는 정의에 없는 id 를 걷어낸다. */
function coerceDecks(v: unknown): Deck[] | undefined {
  if (!Array.isArray(v)) return undefined
  const out: Deck[] = []
  for (const raw of v) {
    if (out.length >= MAX_DECKS) break
    if (!raw || typeof raw !== 'object') continue
    const o = raw as Record<string, unknown>
    const name = (typeof o.name === 'string' ? o.name.trim() : '').slice(0, 40)
    if (!name) continue
    const cards = coerceDeckCards(o.cards)
    const ids = new Set(cards.map((c) => c.id))
    /** 저장본의 더미에서 지금 정의에 있는 카드만 남긴다 — 정의가 바뀐 뒤 되살릴 때 유령 카드를 막는다. */
    const keep = (x: unknown): string[] =>
      (Array.isArray(x) ? x : []).filter((id): id is string => typeof id === 'string' && ids.has(id)).slice(0, MAX_DECK_TOTAL)
    out.push({
      id: capId(o.id) || randomUUID(),
      name,
      cards,
      // draw 가 아예 없는 파일(내보내기본)은 한 벌을 새로 섞는다. 빈 배열은 '다 뽑았다'는 뜻이라 그대로 둔다.
      draw: Array.isArray(o.draw) ? keep(o.draw) : shufflePile(deckPile(cards)),
      // 버린 더미는 옛 저장본에서 문자열 배열로 온다 — 그때는 공개 뽑기로 본다.
      discard: (Array.isArray(o.discard) ? o.discard : [])
        .map((e) => (typeof e === 'string' ? { id: e } : (e as { id?: unknown; by?: unknown })))
        .filter((e): e is { id: string; by?: string } => typeof e?.id === 'string' && ids.has(e.id))
        .map((e) => (typeof e.by === 'string' ? { id: e.id, by: e.by } : { id: e.id }))
        .slice(0, MAX_DECK_TOTAL),
      announce: o.announce !== false,
      reshuffle: o.reshuffle === true,
      revealCards: o.revealCards !== false,
      who: o.who === 'gm' ? 'gm' : 'all',
      createdAt: typeof o.createdAt === 'number' ? o.createdAt : Date.now()
    })
  }
  return out.length ? out : undefined
}

/**
 * 카드 화자 목록 정규화 — 문자열 열쇠만, 중복 제거, 개수·길이 캡. 빈 결과=undefined(전원 공용).
 *
 * ⚠ 이 함수를 지나는 자리가 둘이다(와이어 진입 setVisualCard, 디스크 로드 coerceVisualCards).
 *    한쪽만 태우면 '설정 직후엔 되는데 서버를 다시 켜면 전원에게 뜬다'가 된다 — 제한이 풀리는
 *    방향이라 눈에 잘 안 띄고, 감춰 둔 연출이 새어 나가는 쪽으로 어긋난다.
 */
function coerceCardSpeakers(v: unknown): string[] | undefined {
  if (!Array.isArray(v)) return undefined
  const out: string[] = []
  for (const k of v) {
    if (out.length >= MAX_CARD_SPEAKERS) break
    if (typeof k !== 'string') continue
    const key = k.trim()
    // ⚠ 긴 열쇠는 자르지 않고 버린다. 잘라 두면 그 열쇠는 어떤 화자와도 안 맞아, 카드가 '아무에게도
    //    안 뜨는' 상태로 조용히 남는다. 정상 열쇠는 (사람 id + 캐릭터 id) 라 여든 자를 넘지 않는다.
    if (!key || key.length > 200 || out.includes(key)) continue
    out.push(key)
  }
  return out.length ? out : undefined
}

/** 비주얼 카드 배열 정규화(로드용) — 개수 상한, 이름 필수·40캡, 이미지/음향 캡·둘 다 없으면 제외. 빈 결과=undefined. */
function coerceVisualCards(v: unknown): VisualCard[] | undefined {
  if (!Array.isArray(v)) return undefined
  const out: VisualCard[] = []
  for (const c of v) {
    if (out.length >= MAX_VISUAL_CARDS) break
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
      displaySec: coerceDisplaySec(o.displaySec, image),
      for: coerceCardSpeakers(o.for)
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

/**
 * 보관대에 담을 몫만 남긴다.
 *
 * 보관대는 방 파일에 저장되고 입장할 때 전원에게 전달되므로, **토큰이 그리는 데 쓰는 것만** 담는다.
 * 배너(계정 배너 · 1.2MB 캡)와 표정별 두상 묶음(최대 24장)은 토큰과 무관한데, 그냥 복사하면 사람×캐릭터
 * 조합만큼 중복돼 방 파일과 입장 전송이 수십 MB 로 부푼다.
 */
function poolSubset(c: SharedCharacter): SharedCharacter {
  return {
    playerId: c.playerId,
    charId: c.charId,
    name: c.name,
    color: c.color,
    nameColor: c.nameColor,
    headshot: c.headshot, // 원형 토큰 그림
    headshots: c.headshots, // 표정별 두상 — 보관대 화자의 채팅 두상 각인이 표정을 따라가게 함께 담는다
    standings: c.standings, // 스탠딩 토큰(자산 참조라 가볍다)
    currentExpression: c.currentExpression,
    standingHeight: c.standingHeight,
    stats: c.stats, // 토큰 위 HP/MP/SAN 바
    visibility: c.visibility
  }
}

/** 파일에서 읽은 보관대 — 형태를 깎고 상한까지 적용해 되살린다. */
function loadCharPool(v: unknown): Map<string, SharedCharacter> {
  const out = new Map<string, SharedCharacter>()
  if (!Array.isArray(v)) return out
  for (const raw of v) {
    if (out.size >= MAX_CHAR_POOL) break
    const c = raw as SharedCharacter | null
    const key = poolKey(c?.playerId, c?.charId)
    if (!key || !c) continue
    out.set(key, poolSubset({
      ...c,
      name: typeof c.name === 'string' ? c.name.slice(0, 100) : '',
      color: typeof c.color === 'string' ? c.color.slice(0, 32) : '#7c9cff',
      headshot: capImage(c.headshot),
      headshots: c.headshots ? capImageList(c.headshots) : undefined,
      standings: capImageList(c.standings)
    }))
  }
  return out
}

/** 보관대 상한 적용 — 넘치면 오래 안 쓴 앞자리부터 덜어 낸다. */
function trimCharPool(room: Room): void {
  if (room.charPool.size <= MAX_CHAR_POOL) return
  const drop = room.charPool.size - MAX_CHAR_POOL
  let n = 0
  for (const k of [...room.charPool.keys()]) {
    if (n++ >= drop) break
    room.charPool.delete(k)
  }
}

/**
 * 캐릭터 보관대 색인 키 — 사람과 캐릭터를 함께 잡는다. 둘 중 하나라도 비면 담지 않는다.
 * 앞자리 길이를 붙여 잇는 이유: 구분자 한 글자로 이으면 그 글자가 id 안에 섞였을 때
 * 다른 조합이 같은 키가 되어 남의 캐릭터를 가리키게 된다.
 */
function poolKey(playerId: string | undefined, charId: string | undefined): string {
  return playerId && charId ? playerId.length + ':' + playerId + charId : ''
}

/** 방 → 영속 파일(JSON). 장면·메타·멤버·전체 채팅. 참가자/프레즌스는 런타임이라 제외. */
function roomToFile(room: Room): Record<string, unknown> {
  const { messages, avatarPool } = packAvatars(room.messages) // 채팅 두상 풀 분리 — 파일 크기 절감
  return {
    id: room.id,
    code: room.code,
    title: room.title,
    ownerId: room.ownerId,
    gmIds: [...room.gmIds],
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
    locked: room.locked, // 입실 잠금(공사중)
    vnOverlay: room.vnOverlay, // 일반 맵 VN 오버레이 표시 여부
    plObjects: room.plObjects, // 참가자 오브젝트 추가 허용 여부
    gmSeeWhispers: room.gmSeeWhispers, // GM 귓속말 열람 여부
    bgm: room.bgm,
    channels: [...room.channels.values()],
    // 캐릭터 보관대 — 맵 토큰이 charId 로 참조하므로 재시작 뒤에도 있어야 토큰이 이름·수치를 되찾는다.
    charPool: [...room.charPool.values()],
    messages,
    avatarPool, // 채팅 두상 풀
    charRooms: Object.fromEntries(room.charRooms), // 방별 시트 멤버십
    saveSlots: room.saveSlots ?? [], // 저장 슬롯(반면 전체 명명 저장 · 최대 3)
    visualCards: room.visualCards ?? [], // 비주얼 카드 — 이미지/음향
    decks: room.decks, // 덱 — 남은 더미까지(재시작해도 진행 중인 판이 이어지게)
    globalTokens: room.globalTokens ? [...room.globalTokens.values()] : [], // 통합 레이어 토큰
    // GM 선택지 — 재시작 뒤에도 화면에 남은 선택지 카드가 계속 눌리게(옵션 스크립트는 여기에만 있다).
    choices: room.choices
      ? [...room.choices].map(([mid, c]) => ({
          mid,
          options: c.options,
          // 누가 무엇을 골랐는지까지 남긴다 — 고른 사람만 알면 재입장한 화면이 '무엇을 골랐는지' 못 되살린다.
          responders: [...c.responders].map(([pid, oid]) => [pid, oid])
        }))
      : [],
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
    // 공동 GM 이 없던 시절의 파일에는 이 항목이 없다 — 빈 집합으로 읽으면 소유자만 GM 이던 그대로다.
    gmIds: new Set(Array.isArray(o.gmIds) ? (o.gmIds as unknown[]).filter((x): x is string => typeof x === 'string') : []),
    members: new Set(
      Array.isArray(o.members) ? o.members.filter((m): m is string => typeof m === 'string') : []
    ),
    cardImage: typeof o.cardImage === 'string' && o.cardImage ? o.cardImage : undefined,
    participants, // 영속 복원된 세션 멤버(전부 오프라인) — 재접속 시 admit 이 connected 갱신
    characters: new Map(),
    // 로스터(characters)는 접속 중인 사람의 것이라 비우고 시작하지만, 보관대는 맵 토큰이 참조하므로 되살린다.
    // 파일에서 온 값도 같은 규칙으로 깎는다 — 다른 필드는 전부 캡을 거치는데 여기만 날것으로 두면
    // 멤버가 올린 번들 하나로 방 파일·입장 전송이 통째로 부푼다.
    charPool: loadCharPool(o.charPool),
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
    locked: o.locked === true ? true : undefined, // 입실 잠금(공사중)
    luckEnabled: typeof o.luckEnabled === 'boolean' ? o.luckEnabled : undefined, // 행운 깎기 사용 여부(미설정=기본 사용)
    vnOverlay: typeof o.vnOverlay === 'boolean' ? o.vnOverlay : undefined, // VN 오버레이 표시 여부(미설정=꺼짐)
    plObjects: typeof o.plObjects === 'boolean' ? o.plObjects : undefined, // 참가자 오브젝트 추가 허용(미설정=꺼짐)
    gmSeeWhispers: o.gmSeeWhispers === true ? true : undefined, // GM 귓속말 열람 여부(미설정=꺼짐)
    bgm: coerceLoadedBgmList(o.bgm),
    combat: null, // 전투는 in-memory(비영속) — 재시작 시 초기화
    saveSlots: coerceSaveSlots(o.saveSlots), // 저장 슬롯 복원(최대 3)
    visualCards: coerceVisualCards(o.visualCards), // 비주얼 카드 복원
    decks: coerceDecks(o.decks), // 덱 복원(정의에 없는 카드는 더미에서 걷어낸다)
    globalTokens: coerceGlobalTokens(o.globalTokens), // 통합 레이어 토큰 복원
    choices: coerceChoices(o.choices), // GM 선택지 복원(옵션 스크립트·이미 응답한 사람)
    channels: coerceChannels(o.channels),
    messages,
    charRooms,
    createdAt: typeof o.createdAt === 'number' ? o.createdAt : now,
    lastActivityAt: typeof o.lastActivityAt === 'number' ? o.lastActivityAt : now
  }
}

/** GM 선택지 정규화(로드용) — 메시지 id·옵션 필수, 개수·길이 캡. 구버전 저장본엔 없음(undefined). */
function coerceChoices(
  v: unknown
): Map<string, { options: { id: string; label: string; script?: string }[]; responders: Map<string, string> }> | undefined {
  if (!Array.isArray(v) || v.length === 0) return undefined
  const out = new Map<string, { options: { id: string; label: string; script?: string }[]; responders: Map<string, string> }>()
  for (const raw of v as Record<string, unknown>[]) {
    if (out.size >= MAX_ROOM_CHOICES) break
    if (!raw || typeof raw !== 'object' || typeof raw.mid !== 'string' || !raw.mid) continue
    const options: { id: string; label: string; script?: string }[] = []
    for (const o of Array.isArray(raw.options) ? (raw.options as Record<string, unknown>[]) : []) {
      if (options.length >= 10) break
      if (!o || typeof o.id !== 'string' || !o.id || typeof o.label !== 'string') continue
      options.push({
        id: o.id.slice(0, 40),
        label: o.label.slice(0, 200),
        script: typeof o.script === 'string' && o.script ? o.script.slice(0, 4000) : undefined
      })
    }
    if (!options.length) continue
    // 구버전 저장본은 id 문자열 배열(누가 골랐는지만) — 그때는 고른 항목을 알 수 없으므로 빈 값으로 둔다.
    const responders = new Map<string, string>()
    for (const r of Array.isArray(raw.responders) ? raw.responders : []) {
      if (typeof r === 'string' && r) responders.set(r, '')
      else if (Array.isArray(r) && typeof r[0] === 'string' && r[0]) responders.set(r[0], typeof r[1] === 'string' ? r[1] : '')
    }
    out.set(raw.mid, { options, responders })
  }
  return out.size ? out : undefined
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
  /**
   * 방마다 지금 쓰고 있는 보관소 조각 — 번호·크기와, 그 조각에 이미 적어 둔 두상 열쇠.
   * 대화 한 마디마다 폴더를 다시 훑지 않기 위해 들고 있는다(같은 그림을 조각 안에서 두 번 적지 않는 데도 쓴다).
   */
  private archiveTips = new Map<string, { part: number; size: number; keys: Set<string> }>()
  /**
   * 보관된 대화가 붙잡고 있는 자산 해시 — 채팅에 붙인 그림은 본문에 'asset:<해시>' 참조로만 남는다.
   * 이걸 세어 두지 않으면 자산 청소가 '아무도 안 쓰는 파일'로 보고 지워, 대화는 남았는데 그림만 사라진다.
   */
  private archiveRefs = new Map<string, Set<string>>()
  /** 방금 읽어 둔 조각들 — 나눠 읽기가 같은 파일을 회차마다 다시 파싱하지 않게(여러 사람이 번갈아 읽어도 견디게 몇 칸). */
  private archivePages: { roomId: string; part: number; size: number; messages: ChatMessage[] }[] = []
  /** 보관소가 없다고 확인된 방 — 대부분의 방이 여기 든다. 매 입장마다 폴더를 다시 훑지 않으려고 기억해 둔다. */
  private archiveNone = new Set<string>()
  /**
   * 보관 쓰기가 막힌 방과 다음에 다시 시도할 시각.
   * 막힌 채로 말이 올 때마다 두드리면 그 동기 쓰기가 서버 전체를 붙든다 — 잠시 쉬었다 다시 본다.
   */
  private archiveRetryAt = new Map<string, number>()
  /**
   * 보관 쪽 말썽 — 방 저장(.json)이 잘된다고 지워지면 안 된다.
   * saveTrouble 은 저장이 성공할 때마다 비워지므로, 보관소만 막힌 상태가 그 틈에 감춰지는 것을 막는다.
   */
  private archiveTrouble = new Map<string, string>()

  /** persist:true 면 <dataDir>/rooms/*.json 로드·자동저장. 기본 비영속(테스트 안전). */
  /** 보관 쓰기가 막혔을 때 다시 시도하기까지 쉬는 시간(ms). 테스트가 기다리지 않도록 열어 둔다. */
  private readonly archiveRetryMs: number

  constructor(opts?: { persist?: boolean; dataDir?: string; archiveRetryMs?: number }) {
    this.persist = opts?.persist === true
    this.roomDir = join(opts?.dataDir ?? join(process.cwd(), 'data'), 'rooms')
    this.archiveRetryMs = opts?.archiveRetryMs ?? ARCHIVE_RETRY_MS
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
   * 마지막 저장 이후가 통째로 사라진다.
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

  // ── 대화 보관소 ──
  // 방이 메모리에 들고 있을 수 있는 대화 수에는 끝이 있지만, 오간 말에는 끝이 없어야 한다.
  // 그래서 라이브 창에서 밀려나는 앞부분을 지우지 않고 여기로 옮긴다. 이 파일은 한 번 쓰면
  // 방을 지우거나 소유자가 채팅을 비울 때 말고는 줄지 않는다(스냅샷·기록장과 달리 정리 대상이 아니다).
  //
  // 한 줄이 대화 하나이며, 두상처럼 큰 값은 같은 조각 안에서 한 번만 적고 뒤에서는 열쇠로만 가리킨다
  // (같은 두상이 만 번 반복되면 보관소가 대화가 아니라 그림으로 가득 차기 때문).

  /** 보관소 조각 경로. 번호가 클수록 최근 몫이다. */
  private archivePath(id: string, part: number): string {
    return join(this.roomDir, id + '.archive.' + String(part).padStart(3, '0') + '.jsonl')
  }

  /** 이 방의 보관소 조각 번호(오름차순). 없으면 빈 배열. */
  private archiveParts(id: string): number[] {
    try {
      if (!existsSync(this.roomDir)) return []
      const head = id + '.archive.'
      const out: number[] = []
      for (const f of readdirSync(this.roomDir)) {
        if (!f.startsWith(head) || !f.endsWith('.jsonl')) continue
        const n = Number(f.slice(head.length, -'.jsonl'.length))
        if (Number.isInteger(n) && n > 0) out.push(n)
      }
      return out.sort((a, b) => a - b)
    } catch {
      return []
    }
  }

  /** 보관된 대화가 붙잡고 있는 자산 목록 파일. 조각과 함께 나고 함께 걷힌다. */
  private archiveRefsPath(id: string): string {
    return join(this.roomDir, id + '.archive.refs')
  }

  /**
   * 이 방의 보관 대화가 붙잡고 있는 자산 해시 집합.
   * 목록 파일이 없으면 조각을 한 번 통째로 훑어 세우고 파일로 남긴다(이 판 이전에 쌓인 보관소 대비).
   */
  private archiveRefSet(roomId: string): Set<string> {
    const cached = this.archiveRefs.get(roomId)
    if (cached) return cached
    const out = new Set<string>()
    let loaded = false
    try {
      for (const line of splitLines(readFileSync(this.archiveRefsPath(roomId)))) {
        const h = line.toString('utf8').trim()
        if (h) out.add(h)
      }
      loaded = true
    } catch {
      loaded = false // 목록이 아직 없다 — 아래에서 세운다
    }
    if (!loaded) {
      const parts = this.archiveParts(roomId)
      if (parts.length) {
        for (const p of parts) {
          try {
            const text = readFileSync(this.archivePath(roomId, p), 'utf8')
            scanAssetRefs(text, out) // 본문에 참조로 남은 그림
            // 사전에 통째로 실린 두상 — 덧붙일 때와 같은 기준으로 세야 목록이 어긋나지 않는다.
            for (const mt of text.matchAll(ARCHIVE_AVATAR_KEY_RE)) out.add(mt[1])
          } catch {
            /* 조각 하나를 못 읽어도 나머지는 센다 */
          }
        }
        try {
          writeFileSync(this.archiveRefsPath(roomId), [...out].map((h) => h + '\n').join(''), 'utf8')
        } catch {
          /* 못 남겨도 이번 가동 동안은 메모리로 버틴다 */
        }
      }
    }
    this.archiveRefs.set(roomId, out)
    return out
  }

  /** 지금 쓰고 있는 조각(없으면 폴더를 한 번 훑어 세운다). 이후로는 들고 있는 값만 쓴다. */
  private archiveTip(roomId: string): { part: number; size: number; keys: Set<string> } {
    let tip = this.archiveTips.get(roomId)
    if (!tip) {
      const parts = this.archiveParts(roomId)
      const part = parts.length ? parts[parts.length - 1] : 1
      let size = 0
      try {
        size = statSync(this.archivePath(roomId, part)).size
      } catch {
        size = 0 // 아직 없는 조각 — 0 부터 시작
      }
      if (size > 0) {
        // 끝 줄이 개행으로 닫혔는지 본다 — 정전으로 반쪽만 남은 줄 뒤에 다음 몫을 그대로 이어 붙이면
        // 두 줄이 한 줄로 붙어 함께 못 읽게 되는데, 새로 붙인 쪽은 이미 메모리에서 덜어낸 뒤라 사본이 없다.
        // 반쪽 줄은 개행으로 닫아 그 줄 하나만 잃는 것으로 끝낸다(그쪽은 스냅샷·기록장에 남아 있다).
        try {
          const fd = openSync(this.archivePath(roomId, part), 'r')
          try {
            const last = Buffer.alloc(1)
            readSync(fd, last, 0, 1, size - 1)
            if (last[0] !== 0x0a) {
              appendFileSync(this.archivePath(roomId, part), '\n', 'utf8')
              size += 1
            }
          } finally {
            closeSync(fd)
          }
        } catch {
          /* 못 보면 그대로 이어 쓴다 — 확인 실패가 보관 자체를 막지는 않게 */
        }
      }
      // 이어 쓰는 조각의 두상 사전은 비운 채로 시작한다 — 이미 적힌 그림을 한 번 더 적을 뿐 손실은 없다.
      tip = { part, size, keys: new Set<string>() }
      this.archiveTips.set(roomId, tip)
    }
    return tip
  }

  /**
   * 대화를 보관소 끝에 덧붙인다. 성공하면 true — **false 면 부르는 쪽은 메모리에서 덜어내면 안 된다.**
   * 큰 두상은 이 조각에 처음 나올 때만 통째로 적고, 그 뒤로는 열쇠로만 가리킨다.
   */
  private archiveAppend(roomId: string, messages: ChatMessage[]): boolean {
    if (!this.persist || !messages.length) return true
    // 실패하면 여기까지 되잘라 '디스크에는 적혔는데 아무도 모르는' 반쪽 상태를 남기지 않는다.
    // 그 상태를 두면 다음 회차가 같은 앞부분을 통째로 다시 적어 조각이 눈덩이처럼 붇는다.
    const undo: { part: number; size: number }[] = []
    try {
      this.ensureRoomDir()
      const tip = this.archiveTip(roomId)
      const refs = this.archiveRefSet(roomId)
      // 쓰기가 끝나기 전에는 들고 있는 값을 고치지 않는다 — 실패했는데 '적었다'고 표시해 두면,
      // 다음 시도에서 두상 사전 줄을 건너뛰어 그 그림이 어디에도 없게 된다.
      let part = tip.part
      let size = tip.size
      const keys = new Set(tip.keys) // 조각이 바뀌면 두상 사전도 새로 시작한다
      const addedRefs = new Set<string>()
      let body = ''
      let pending = 0 // 아직 안 내보낸 몫의 바이트 수 — 조각 상한은 이것까지 세어야 걸린다
      /** 모인 몫을 지금 조각에 내보낸다. 실패하면 catch 가 되돌린다. */
      const emit = (): void => {
        if (!body) return
        let before = 0
        try {
          before = statSync(this.archivePath(roomId, part)).size
        } catch {
          before = 0 // 아직 없는 조각
        }
        undo.push({ part, size: before })
        appendFileSync(this.archivePath(roomId, part), body, 'utf8')
        size += pending
        pending = 0
        // 이 대화가 붙잡고 있는 그림도 함께 적어 둔다 — 자산 청소가 살아 있는 그림으로 세게 한다.
        // 본문에 참조로 남는 그림(asset:…)과, 사전에 통째로 실린 두상 둘 다 세야 한다.
        const fresh = new Set<string>()
        scanAssetRefs(body, fresh)
        for (const k of keys) if (!refs.has(k)) fresh.add(k)
        const add = [...fresh].filter((h) => !refs.has(h) && !addedRefs.has(h))
        if (add.length) {
          appendFileSync(this.archiveRefsPath(roomId), add.map((h) => h + '\n').join(''), 'utf8')
          for (const h of add) addedRefs.add(h)
        }
        body = ''
      }
      /** 한 줄을 모아 두고 그 길이만큼 센다. */
      const push = (line: string): void => {
        body += line + '\n'
        pending += Buffer.byteLength(line, 'utf8') + 1
      }
      for (const m of messages) {
        // 한 번에 큰 묶음이 들어와도(계정 이전 가져오기 등) 조각 상한을 지킨다 — 넘치면 그 자리에서 조각을 넘긴다.
        if (size + pending >= ARCHIVE_PART_BYTES && part < ARCHIVE_PART_MAX) {
          emit()
          part++
          size = 0
          keys.clear()
        }
        const key = m.avatar ? dataUrlHash(m.avatar) : null
        if (!key) {
          push(JSON.stringify({ op: 'm', m }))
          continue
        }
        if (!keys.has(key)) {
          push(JSON.stringify({ op: 'av', k: key, d: m.avatar }))
          keys.add(key)
        }
        const lean: ChatMessage = { ...m }
        delete lean.avatar
        push(JSON.stringify({ op: 'm', m: lean, a: key }))
      }
      emit()
      // 여기까지 왔으면 확정 — 이제야 들고 있는 값을 옮긴다.
      tip.part = part
      tip.size = size
      tip.keys.clear()
      for (const k of keys) tip.keys.add(k)
      for (const h of addedRefs) refs.add(h)
      this.archiveNone.delete(roomId)
      this.archiveTrouble.delete(roomId) // 다시 써진다 — 막혔다는 표시를 걷는다
      return true
    } catch (e) {
      // 나가다 만 몫을 되잘라 없던 일로 만든다(되자르기까지 실패하면 아래 알림으로 남는다).
      for (const u of undo.reverse()) {
        try {
          truncateSync(this.archivePath(roomId, u.part), u.size)
        } catch {
          // 되자르기 실패 — 중복이 남을 수 있고(읽을 때 같은 id 를 걸러 낸다), 꼬리가 반쪽 줄로
          // 끊겨 있을 수도 있다. 들고 있던 조각 정보를 버려, 다음 시도가 꼬리부터 다시 살피게 한다.
          this.archiveTips.delete(roomId)
        }
      }
      // 여기서 실패했다는 것은 덜어낼 대화의 갈 곳이 없다는 뜻이다. 관리 화면에 남기고,
      // 부르는 쪽은 메모리에 그대로 둔다(줄지 않는 대신 잃지도 않는다).
      // 방 저장(.json)이 잘되면 saveTrouble 은 비워지므로, 보관 쪽 사유는 따로 들고 있어야 감춰지지 않는다.
      const first = !this.archiveTrouble.has(roomId)
      this.archiveTrouble.set(roomId, `대화 보관소 쓰기 실패: ${String(e)}`)
      // 로그는 처음 한 번만 — 말이 올 때마다 스택을 찍으면 진짜 원인이 그 안에 묻힌다(재시도는 쉬었다 한다).
      if (first) console.error(`[rooms] ${roomId} 대화 보관 실패. 오래된 대화를 메모리에 그대로 둔다:`, e)
      return false
    }
  }

  /**
   * 보관소 조각 하나를 통째로 읽어 대화 목록으로 되돌린다(두상 사전 해소 포함). 깨진 줄은 건너뛴다.
   * 방금 읽은 조각 하나는 들고 있는다 — 나눠 읽기는 같은 조각을 여러 번 훑으므로,
   * 캐시가 없으면 한 번 넘길 때마다 8MB 파일을 다시 읽고 다시 파싱해 서버가 그 동안 멈춘다.
   */
  private archiveRead(roomId: string, part: number): ChatMessage[] {
    let size = -1
    try {
      size = statSync(this.archivePath(roomId, part)).size
    } catch {
      return []
    }
    const hit = this.archivePages.find((p) => p.roomId === roomId && p.part === part && p.size === size)
    if (hit) return hit.messages
    let lines: Buffer[]
    try {
      lines = splitLines(readFileSync(this.archivePath(roomId, part)))
    } catch {
      return []
    }
    const pool = new Map<string, string>()
    const out: ChatMessage[] = []
    for (const line of lines) {
      if (!line.length) continue
      try {
        const e = JSON.parse(line.toString('utf8')) as Record<string, unknown>
        if (e.op === 'av') {
          if (typeof e.k === 'string' && typeof e.d === 'string') pool.set(e.k, e.d)
          continue
        }
        if (e.op !== 'm' || !e.m || typeof e.m !== 'object') continue
        const m = e.m as ChatMessage
        if (typeof m.id !== 'string' || !m.id) continue
        if (typeof e.a === 'string') {
          const avatar = pool.get(e.a)
          if (avatar) m.avatar = avatar
        }
        out.push(m)
      } catch {
        /* 줄 하나가 깨져도 나머지는 살린다 */
      }
    }
    this.archivePages.unshift({ roomId, part, size, messages: out })
    if (this.archivePages.length > ARCHIVE_PAGE_CACHE) this.archivePages.length = ARCHIVE_PAGE_CACHE
    return out
  }

  /**
   * 라이브 창에서 넘치는 앞부분을 보관소로 옮기고 메모리에서 덜어낸다.
   * 보관에 실패하면 덜어내지 않는다 — 사본 없이 지우면 그 대화는 어디에도 남지 않는다.
   */
  private evictOldest(room: Room, keep: number): void {
    if (room.messages.length <= keep) return
    if (Date.now() >= (this.archiveRetryAt.get(room.id) ?? 0)) {
      // 한 번에 옮기는 몫에 끝을 둔다 — 쓰기가 막혀 있으면 실패할 때마다 밀린 전량을 다시 직렬화하게 되고,
      // 그 비용이 쌓인 만큼 커져(동기 실행이라) 방 하나가 서버 전체를 붙든다.
      // 다만 잘 써지는 동안에는 다 옮길 때까지 배치를 이어 간다 — 계정 이전 가져오기처럼 한 번에
      // 수만 건이 올 때 한 배치만 옮기고 손을 놓으면, 나머지가 아래 마지막 선에서 사본 없이 잘려 나간다.
      while (room.messages.length > keep) {
        const take = Math.min(room.messages.length - keep, ARCHIVE_APPEND_MAX)
        if (!this.archiveAppend(room.id, room.messages.slice(0, take))) {
          this.archiveRetryAt.set(room.id, Date.now() + this.archiveRetryMs)
          break
        }
        this.archiveRetryAt.delete(room.id)
        room.messages.splice(0, take)
      }
      if (room.messages.length <= keep) return
    }
    // 보관이 막힌 동안에도 마지막 선은 있어야 한다. 여기까지 왔다면 디스크가 이미 망가진 상태다 —
    // 그대로 두면 이 방이 부풀어 서버가 죽고, 그러면 다른 방들의 최근 대화까지 함께 잃는다.
    const over = room.messages.length - MAX_HISTORY_HARD
    if (over > 0) {
      room.messages.splice(0, over)
      this.saveLoss.set(
        room.id,
        `대화 보관소에 쓰지 못해 오래된 대화를 덜어냈습니다. 디스크 여유와 데이터 폴더 권한을 확인해 주세요.`
      )
    }
  }

  /** 방의 보관소를 걷는다 — 방을 지우거나 소유자가 채팅을 비울 때만. */
  private removeArchive(id: string): void {
    if (!this.persist) return
    for (const p of this.archiveParts(id)) {
      try {
        unlinkSync(this.archivePath(id, p))
      } catch {
        /* 이미 없으면 그만 */
      }
    }
    try {
      unlinkSync(this.archiveRefsPath(id)) // 그림 목록도 함께 — 남겨 두면 지운 방의 그림을 영영 붙잡는다
    } catch {
      /* 이미 없으면 그만 */
    }
    this.archiveTips.delete(id)
    this.archiveRefs.delete(id)
    this.archiveNone.delete(id)
    this.archiveRetryAt.delete(id)
    this.archiveTrouble.delete(id)
    this.archivePages = this.archivePages.filter((p) => p.roomId !== id)
  }

  /** 보관소에 담긴 대화가 있는지(채팅 창의 '더 불러오기' 표시 여부). */
  hasArchive(roomId: string): boolean {
    if (!this.persist) return false
    if (this.archiveNone.has(roomId)) return false // 없다고 이미 확인한 방(대부분이 여기)
    if (this.archiveTips.has(roomId)) return true // 이 판에서 보관해 본 방
    // 조각은 1번부터 나고 지워지지 않는다 — 폴더를 통째로 훑기 전에 첫 조각부터 본다(입장마다 도는 길이다).
    try {
      if (existsSync(this.archivePath(roomId, 1))) return true
    } catch {
      /* 아래에서 다시 본다 */
    }
    if (this.archiveParts(roomId).length > 0) return true
    this.archiveNone.add(roomId) // 다음 입장부터는 폴더를 다시 훑지 않는다(보관이 시작되면 지워진다)
    return false
  }

  /**
   * 보관 대화 되읽기(입장 스냅샷과 같은 꼴) — 열람권 필터와 두상 풀 분리까지 마친 결과.
   * 방이 없거나 그 사람이 방에 없으면 null.
   */
  archivedFor(
    roomId: string,
    viewer: { playerId: string; role: Participant['role'] },
    cursor: { part: number; line: number } | null,
    limit: number
  ): { messages: ChatMessage[]; avatarPool: string[]; cursor: { part: number; line: number } | null } | null {
    const room = this.rooms.get(roomId)
    if (!room) return null
    const got = this.archivedBefore(roomId, cursor, limit, (m) =>
      canSeeMessage(m, viewer, (gid) => this.canAccessChannel(roomId, gid, viewer.playerId))
    )
    const { messages, avatarPool } = packAvatars(got.messages)
    return { messages, avatarPool, cursor: got.cursor }
  }

  /**
   * 보관된 대화를 처음부터 끝까지(그 사람이 볼 수 있는 것만). 계정 이전용 내보내기가 쓴다.
   * 통째로 메모리에 올리는 길이라 상한을 둔다 — 넘치면 최근 쪽을 남기고 truncated 로 알린다.
   */
  archivedAll(
    roomId: string,
    viewer: { playerId: string; role: Participant['role'] },
    max = ARCHIVE_EXPORT_MAX
  ): { messages: ChatMessage[]; truncated: boolean } {
    const parts = this.archiveParts(roomId)
    if (!parts.length) return { messages: [], truncated: false }
    // 방장은 지금 접속 중이 아니어도 그 방의 GM 이다 — 라이브 몫을 거르는 규칙과 같아야
    // 자기 방 그룹 대화가 보관분에서만 조용히 빠지는 일이 없다(exportOwnedBy 와 짝).
    // 다만 **지운 채널까지 통과시키면 안 된다** — 라이브 몫은 지울 때 함께 사라지지만 보관분은 남아 있어서,
    // 그냥 두면 '지웠다'고 한 그룹 대화가 내보내기 파일에서만 되살아난다.
    const room = this.rooms.get(roomId)
    const canSee = (m: ChatMessage): boolean =>
      canSeeMessage(
        m,
        viewer,
        (gid) =>
          !!room?.channels.has(gid) &&
          (viewer.role === 'GM' || this.canAccessChannel(roomId, gid, viewer.playerId))
      )
    const out: ChatMessage[] = []
    // 서버가 갑자기 죽었다 살아난 회차에는 같은 말이 조각에 두 번 적혀 있을 수 있다 — 내보내기에는 한 번만 싣는다.
    const seen = new Set<string>()
    let truncated = false
    // 뒤에서부터 채운다 — 상한에 걸리면 최근 쪽이 남아야 한다.
    for (let i = parts.length - 1; i >= 0; i--) {
      const chunk = this.archiveRead(roomId, parts[i]).filter((m) => {
        if (!canSee(m) || seen.has(m.id)) return false
        seen.add(m.id)
        return true
      })
      if (out.length + chunk.length > max) {
        out.unshift(...chunk.slice(chunk.length - (max - out.length)))
        truncated = true
        break
      }
      out.unshift(...chunk)
    }
    return { messages: out, truncated }
  }

  /** 방별 보관소 크기(바이트) — 관리 화면 표시용. */
  archiveBytes(roomId: string): number {
    let sum = 0
    for (const p of this.archiveParts(roomId)) {
      try {
        sum += statSync(this.archivePath(roomId, p)).size
      } catch {
        /* 세는 사이 사라졌으면 그만 */
      }
    }
    return sum
  }

  /**
   * 보관된 대화를 뒤에서부터 되읽는다(오래된 순으로 정렬해 돌려준다).
   * cursor 는 다음 요청에 그대로 돌려주면 되는 표식이며, null 이면 보관소의 맨 끝부터 읽는다.
   * 볼 수 없는 대화(귓속말·비밀·남의 그룹)는 여기서 걸러 내보낸다 — 화면 은닉을 믿지 않는다.
   */
  archivedBefore(
    roomId: string,
    cursor: { part: number; line: number } | null,
    limit: number,
    canSee: (m: ChatMessage) => boolean
  ): { messages: ChatMessage[]; cursor: { part: number; line: number } | null } {
    const parts = this.archiveParts(roomId)
    if (!parts.length) return { messages: [], cursor: null }
    // 정수로 못 박는다 — 소수가 새어 들어오면 줄 번호가 소수가 되고, 그 표식은 다음 요청에서 거부돼
    // 되읽기가 그 자리에서 영영 멈춘다.
    const want = Math.max(1, Math.min(ARCHIVE_PAGE_MAX, Math.floor(Number(limit) || 0) || 1))
    let pi = parts.length - 1
    let line = -1 // -1 = 이 조각의 끝에서부터
    if (cursor) {
      pi = parts.indexOf(cursor.part)
      if (pi < 0) return { messages: [], cursor: null } // 그 사이 걷힌 조각 — 더 줄 것이 없다
      line = cursor.line
    }
    const out: ChatMessage[] = []
    // 서버가 갑자기 죽었다 살아난 회차에는 같은 말이 조각에 두 번 적혀 있을 수 있다 — 한 묶음 안에서는 한 번만 담는다.
    const seen = new Set<string>()
    let scanned = 0
    while (pi >= 0 && out.length < want && scanned < ARCHIVE_SCAN_LIMIT) {
      const all = this.archiveRead(roomId, parts[pi])
      if (line < 0 || line > all.length) line = all.length
      if (line === 0) {
        pi--
        line = -1
        continue
      }
      const from = Math.max(0, line - (want - out.length))
      out.unshift(
        ...all.slice(from, line).filter((m) => {
          if (!canSee(m) || seen.has(m.id)) return false
          seen.add(m.id)
          return true
        })
      )
      scanned += line - from
      line = from
      if (line === 0) {
        pi--
        line = -1
      }
    }
    return { messages: out, cursor: pi >= 0 ? { part: parts[pi], line } : null }
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
    this.evictOldest(room, MAX_HISTORY)
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
      this.evictOldest(room, MAX_HISTORY)
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
        console.error(`[rooms] ${room.id}(${room.title}) 직렬화 실패. 줄여서도 저장하지 못했다:`, e)
        return Promise.resolve()
      }
      this.saveTrouble.set(
        room.id,
        `방이 너무 커서 온전한 저장이 실패했습니다. 대화는 이전 저장본·기록장·비상 사본으로 지키는 중입니다`
      )
      console.error(`[rooms] ${room.id}(${room.title}) 너무 큼. 최근 대화 스냅샷을 비상 사본에 둔다(덜어낸 ${kept.dropped}개는 이전 저장본과 기록장 몫).`)
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
    // 보관 쪽 말썽은 따로 들고 있다 — 방 저장이 잘된다고 함께 지워지면 막힌 보관소를 아무도 모른다.
    for (const [id, reason] of this.archiveTrouble)
      out.push({ id, title: this.rooms.get(id)?.title ?? '', reason, lost: false })
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
      this.removeArchive(id) // 방을 지우면 보관해 둔 대화도 함께 걷는다
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
      gm: isGm(room, accountId), // 소유자 전용 동작(삭제·복사·이름)과 GM 표시를 가르기 위해 따로 싣는다
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
      gmIds: new Set(),
      members: new Set([ownerId]),
      cardImage: capImage(host.cardImage),
      participants: new Map([[self.playerId, self]]),
      characters: new Map(),
      charPool: new Map(),
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
    const shut = this.lockedOut(room, player)
    if (shut) return shut
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
    if (acct && !isGm(room, acct) && !room.members.has(acct)) {
      return { error: '이 세션의 멤버가 아닙니다. 초대 코드로 입장하세요.' }
    }
    const shut = this.lockedOut(room, player)
    if (shut) return shut
    return this.admit(room, player)
  }

  /**
   * 잠긴 방인가 — 방을 만든 사람 말고는 못 들어온다.
   *
   * 이미 들어와 있던 사람(끊겼다 돌아오는 사람 포함)은 통과시킨다. 잠금은 '준비 중이니 새로 들어오지
   * 말라'는 뜻이지, 하던 사람을 끊는 기능이 아니다 — 그렇게 하면 GM 이 잠근 순간 방이 텅 빈다.
   */
  private lockedOut(
    room: Room,
    player: { playerId: string; accountId?: string }
  ): { error: string } | null {
    if (!room.locked) return null
    if (isGm(room, player.accountId)) return null
    if (room.participants.has(player.playerId)) return null
    return { error: '지금은 준비 중이라 들어올 수 없습니다. 방을 만든 사람에게 물어봐 주세요.' }
  }

  /** 공통 입장 처리: 멤버 등록 + 재접속/신규 참가자(소유자=GM, 그 외 PL). */
  private admit(
    room: Room,
    player: { playerId: string; nick: string; color: string; accountId?: string }
  ): { room: Room; self: Participant } {
    room.lastActivityAt = Date.now()
    if (player.accountId) room.members.add(player.accountId)
    const gm = isGm(room, player.accountId)
    const existing = room.participants.get(player.playerId)
    if (existing) {
      existing.connected = true
      if (player.nick.trim()) existing.nick = player.nick.trim()
      if (player.color) existing.color = player.color
      // 자리를 비운 사이에 GM 을 받았거나 잃었을 수 있다 — 자격의 진실원본은 gmIds 이므로 여기서 맞춘다.
      if (player.accountId) existing.role = gm ? 'GM' : 'PL'
      return { room, self: existing }
    }
    const self: Participant = {
      playerId: player.playerId,
      nick: player.nick.trim() || (gm ? 'GM' : '탐사자'),
      color: player.color || (gm ? DEFAULT_GM_COLOR : DEFAULT_PL_COLOR),
      role: gm ? 'GM' : 'PL', // 소유자·공동 GM 은 재입장 시에도 복원(릴레이 재시작 후 participants 비어도)
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
    // 스스로 목록에서 빠진 사람의 GM 자격도 함께 거둔다 — 남겨 두면 초대 코드로 다시 들어오는 순간
    // 아무도 지정하지 않았는데 조용히 GM 으로 돌아온다.
    room.gmIds.delete(accountId)
    room.participants.delete(playerId)
    room.characters.delete(playerId)
    // 아주 떠난 사람의 보관대 몫도 걷는다 — 안 걷으면 그 사람 그림이 방 파일과 입장 전송에 영원히 남는다.
    this.dropPooledFor(room, playerId)
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

  /**
   * 입실 잠금(공사중) 설정 — 방을 만든 사람 말고는 못 들어오게 한다.
   * 이미 들어와 있는 사람은 내보내지 않는다(준비 중에 문만 닫는 것이지 쫓아내는 기능이 아니다).
   */
  setLocked(roomId: string, locked: boolean): { ok: boolean; locked: boolean } {
    const room = this.rooms.get(roomId)
    if (!room) return { ok: false, locked: false }
    room.locked = locked || undefined
    room.lastActivityAt = Date.now()
    return { ok: true, locked }
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

  /** 참가자 오브젝트 추가 허용 설정(GM 전용 — 권한 검증은 호출 측 relay). {ok,enabled} 반환. */
  setPlObjects(roomId: string, enabled: boolean): { ok: boolean; enabled: boolean } {
    const room = this.rooms.get(roomId)
    if (!room) return { ok: false, enabled: false }
    room.plObjects = enabled
    room.lastActivityAt = Date.now()
    return { ok: true, enabled }
  }

  /**
   * GM 귓속말 열람 설정(GM 전용 — 권한 검증은 호출 측 relay). {ok,enabled} 반환.
   * 켜고 끄는 것은 앞으로 오갈 말에만 미친다 — 이미 오간 말의 각인은 손대지 않는다.
   */
  setGmSeeWhispers(roomId: string, enabled: boolean): { ok: boolean; enabled: boolean } {
    const room = this.rooms.get(roomId)
    if (!room) return { ok: false, enabled: false }
    room.gmSeeWhispers = enabled || undefined
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
    const room = this.rooms.get(roomId)
    if (!room) return
    const map = (room.choices ??= new Map())
    map.set(messageId, { options, responders: new Map() })
    // 오래된 것부터 버린다 — 옵션 스크립트는 한 건에 수십 KB 까지 갈 수 있어 무제한이면 방 파일이 붓는다.
    while (map.size > MAX_ROOM_CHOICES) {
      const oldest = map.keys().next().value
      if (oldest === undefined) break
      map.delete(oldest)
    }
  }
  /** 플레이어 선택 처리 — 1회만 허용. 통과 시 해당 옵션(스크립트 포함) 반환, 중복/무효면 null. */
  selectChoice(
    roomId: string,
    messageId: string,
    optionId: string,
    playerId: string
  ): { option: { id: string; label: string; script?: string } } | null {
    const c = this.rooms.get(roomId)?.choices?.get(messageId)
    if (!c) return null
    if (c.responders.has(playerId)) return null // 이미 응답
    const option = c.options.find((o) => o.id === optionId)
    if (!option) return null
    c.responders.set(playerId, option.id)
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
    if (had) {
      // 그룹 대화도 함께 지운다 — 채널이 없으면 열람 권한을 판정할 근거가 사라져 GM 조차 다시 볼 수 없다.
      // 남겨 두면 아무도 못 보는 기록이 방 저장본에만 계속 쌓인다.
      //
      // 보관소로 이미 옮겨진 몫은 손대지 않는다. 보관소는 '오간 말은 지우지 않는다'가 약속인 곳이고,
      // 되읽기는 canAccessChannel 이 없는 채널을 언제나 거절하므로(그래서 아무에게도 안 보인다)
      // 여기서 그 파일을 다시 쓰는 것보다 그대로 두는 편이 안전하다.
      const gone = room.messages.filter((m) => m.channel === 'group' && m.groupId === id)
      if (gone.length) {
        room.messages = room.messages.filter((m) => !(m.channel === 'group' && m.groupId === id))
        for (const m of gone) this.journal(roomId, { op: 'del', id: m.id })
      }
      room.lastActivityAt = Date.now()
    }
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
    this.evictOldest(room, MAX_HISTORY) // 넘치는 앞부분은 버리지 않고 보관소로
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
    // 지금 장착한 캐릭터는 곧 갈아입히면 로스터에서 밀려난다. 맵에 토큰을 놓아 둔 캐릭터가 그때
    // 이름·색·두상·수치를 잃지 않도록, 캐릭터별로도 한 벌 남겨 둔다(같은 값의 사본).
    if (stored.charId) this.setPooledCharacter(room, stored)
    room.lastActivityAt = Date.now()
    return stored
  }

  /**
   * 캐릭터 보관대 — (playerId, charId) 로 색인한다. 로스터가 '지금 말하는 캐릭터' 한 명만 담는 것과 달리,
   * 여기에는 이 방에서 쓰인 적 있는 캐릭터가 함께 남는다. 맵 토큰이 charId 로 자기 캐릭터를 찾을 때 본다.
   */
  private setPooledCharacter(room: Room, char: SharedCharacter): void {
    const key = poolKey(char.playerId, char.charId)
    if (!key) return
    // 지운 뒤 다시 넣어 '가장 최근'이 맨 뒤로 가게 한다 — Map 은 이미 있는 키를 덮어써도 자리를 안 바꾼다.
    // 그대로 두면 아래 축출이 '오래 안 쓴 것'이 아니라 '먼저 담긴 것'을 버려, 지금 쓰는 캐릭터가 밀려난다.
    room.charPool.delete(key)
    // 1인당 할당량부터 정리한다 — 넘치는 몫은 그 사람의 가장 오래된 자기 항목에서만 걷어,
    // 한 사람의 등록 폭주가 남의 보관대를 밀어내지 못하게 한다(방 공용 상한은 마지막 방어선).
    const head = char.playerId.length + ':' + char.playerId
    const mine = [...room.charPool.keys()].filter((k) => k.startsWith(head))
    for (let i = 0; i <= mine.length - MAX_CHAR_POOL_PER_PLAYER; i++) room.charPool.delete(mine[i])
    room.charPool.set(key, poolSubset(char))
    trimCharPool(room)
  }

  /** 방을 아주 떠난 사람의 보관대 몫을 걷는다(재접속이 아니라 멤버십이 끊긴 경우). */
  private dropPooledFor(room: Room, playerId: string): void {
    const head = playerId.length + ':' + playerId
    for (const k of [...room.charPool.keys()]) if (k.startsWith(head)) room.charPool.delete(k)
  }

  /** 보관대에 담긴 캐릭터 전부(스냅샷·입장 전달용). */
  charPool(roomId: string): SharedCharacter[] {
    const room = this.rooms.get(roomId)
    return room ? [...room.charPool.values()] : []
  }

  /**
   * 보관대에서 한 사람의 캐릭터 한 벌을 찾는다 — 메시지에 실려 온 charId 를 화자로 각인할 때 쓴다.
   * 키가 (playerId, charId) 라 남의 캐릭터는 애초에 닿지 않는다.
   */
  pooledCharacter(roomId: string, playerId: string, charId: string): SharedCharacter | undefined {
    const room = this.rooms.get(roomId)
    return room?.charPool.get(poolKey(playerId, charId))
  }

  /**
   * 장착 슬롯(room.characters)은 건드리지 않고 보관대에만 담는다 — 분리 창이 제 화자를 등록하는 길.
   * 값 깎기(이미지 캡·길이 바운드)는 setCharacter 와 같은 규칙을 태워야 하므로 여기서 직접 한다.
   */
  poolCharacter(roomId: string, char: SharedCharacter): SharedCharacter | undefined {
    const room = this.rooms.get(roomId)
    if (!room) return undefined
    const standings = capImageList(char.standings)
    const max = Math.max(0, standings.length - 1)
    const stored: SharedCharacter = {
      ...char,
      charId: capId(char.charId) ?? '',
      name: typeof char.name === 'string' ? char.name.slice(0, 100) : '',
      color: typeof char.color === 'string' ? char.color.slice(0, 32) : '#7c9cff',
      nameColor: typeof char.nameColor === 'string' ? char.nameColor.slice(0, 32) : undefined,
      headshot: capImage(char.headshot),
      headshots: char.headshots ? capImageList(char.headshots) : undefined,
      standings,
      currentExpression: Math.min(Math.max(0, char.currentExpression), max),
      standingHeight:
        typeof char.standingHeight === 'number' && Number.isFinite(char.standingHeight)
          ? Math.min(4000, Math.max(40, Math.round(char.standingHeight)))
          : undefined
    }
    if (!stored.charId) return undefined
    this.setPooledCharacter(room, stored)
    room.lastActivityAt = Date.now()
    return room.charPool.get(poolKey(stored.playerId, stored.charId))
  }

  /**
   * 스탠딩을 뺀 정체성만 갱신(가벼운 발행). 같은 캐릭터를 계속 쓰는 중이면 보관 중인 스탠딩을 그대로 두고,
   * 다른 캐릭터로 갈아입었으면 옛 스탠딩을 비운다(남겨 두면 무대에 엉뚱한 캐릭터의 그림이 선다).
   * 비운 자리는 뒤이어 오는 char:update 가 채운다. 보관본이 아직 없으면 스탠딩 없는 상태로 새로 만든다.
   */
  mergeIdentity(roomId: string, ident: Omit<SharedCharacter, 'standings'>): SharedCharacter | undefined {
    const room = this.rooms.get(roomId)
    if (!room) return undefined
    const prev = room.characters.get(ident.playerId)
    const sameChar = !!prev && prev.charId === (capId(ident.charId) ?? '')
    return this.setCharacter(roomId, {
      ...ident,
      standings: sameChar ? prev.standings : [],
      // 표정은 남는 스탠딩 범위 안에서만 뜻이 있다 — 갈아입은 직후엔 0 으로(setCharacter 가 다시 보정).
      currentExpression: sameChar ? ident.currentExpression : 0
    })
  }

  /** 표정 인덱스만 갱신(잦은 변경). 보정된 인덱스 반환, 보관된 캐릭터 없으면 undefined. */
  setExpression(roomId: string, playerId: string, index: number): number | undefined {
    const room = this.rooms.get(roomId)
    if (!room) return undefined
    const char = room.characters.get(playerId)
    if (!char) return undefined
    const max = Math.max(0, char.standings.length - 1)
    char.currentExpression = Math.min(Math.max(0, index), max)
    // 표정은 보관대 사본에도 따라 붙인다 — 사본이 낡으면 이 캐릭터를 charId 로 각인한 다음 말의
    // 두상이 옛 표정으로 남는다(잦은 전환이지만 사본 교체는 Map 두 번 손대는 값싼 일).
    if (char.charId) this.setPooledCharacter(room, char)
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
    // 정렬 키는 요청으로 안 받는다(재배치는 handout:reorder 전용) — 기존 값 보존, 신규는 맨 끝.
    // 키 없는 옛 핸드아웃은 createdAt 으로 정렬되므로 최댓값은 sortKey·createdAt 을 함께 본다.
    let sortKey = existing?.sortKey
    if (!existing) {
      let max = 0
      for (const h of room.handouts.values()) {
        if (typeof h.sortKey === 'number' && h.sortKey > max) max = h.sortKey
        if (h.createdAt > max) max = h.createdAt
      }
      sortKey = max + 1
    }
    const handout: Handout = {
      // 기존이면 그 id 유지, 신규면 클라 제공 id 존중(GM 전용 경로 — 낙관적 선택용), 없으면 생성.
      id: existing?.id ?? (typeof req.id === 'string' && req.id ? req.id : randomUUID()),
      title: typeof req.title === 'string' ? req.title.slice(0, 200) : '',
      body: typeof req.body === 'string' ? req.body.slice(0, 20000) : '',
      image: capImage(req.image),
      imageAlign: req.imageAlign === 'center' || req.imageAlign === 'right' ? req.imageAlign : undefined,
      // 빈 문자열은 폴더 해제. 키가 아예 없으면 기존 폴더 유지(옛 클라 요청이 폴더를 걷어내지 않게).
      folder:
        typeof req.folder === 'string' ? req.folder.trim().slice(0, 60) || undefined : existing?.folder,
      sortKey,
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

  /**
   * 핸드아웃 순서 변경 — 대상을 beforeId 앞(없으면 맨 끝)으로. 전체를 (sortKey ?? createdAt)
   * 오름차순으로 놓고 이웃 둘의 중간값을 새 키로 준다. 중간값이 이웃과 같아질 만큼 간격이
   * 좁아지면 전체를 0..n 으로 재번호. 반환은 키가 바뀐 핸드아웃들(평소 1개 · 재번호 시 전부) —
   * 호출 측이 그대로 재방송한다. 방·대상이 없으면 undefined.
   */
  reorderHandout(roomId: string, id: string, beforeId?: string): Handout[] | undefined {
    const room = this.rooms.get(roomId)
    if (!room) return undefined
    const target = room.handouts.get(id)
    if (!target) return undefined
    if (beforeId === id) return [] // 자기 앞으로 = 제자리
    const keyOf = (h: Handout): number => h.sortKey ?? h.createdAt
    const rest = [...room.handouts.values()]
      .filter((h) => h.id !== id)
      .sort((a, b) => keyOf(a) - keyOf(b) || a.createdAt - b.createdAt || (a.id < b.id ? -1 : 1))
    const at = typeof beforeId === 'string' ? rest.findIndex((h) => h.id === beforeId) : -1
    const idx = at === -1 ? rest.length : at // beforeId 없음(삭제됨 포함)=맨 끝
    const prev = idx > 0 ? keyOf(rest[idx - 1]) : undefined
    const next = idx < rest.length ? keyOf(rest[idx]) : undefined
    let key: number
    if (prev !== undefined && next !== undefined) key = (prev + next) / 2
    else if (next !== undefined) key = next - 1
    else if (prev !== undefined) key = prev + 1
    else key = 0 // 혼자 남은 목록 — 어떤 키든 무방
    room.lastActivityAt = Date.now()
    // 간격 소진 — 중간값이 이웃과 겹치면(부동소수 정밀도 바닥) 새 차례대로 전체 재번호.
    if (key === prev || key === next) {
      rest.splice(idx, 0, target)
      rest.forEach((h, i) => {
        h.sortKey = i
      })
      return rest
    }
    target.sortKey = key
    return [target]
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

  /**
   * 새 맵 생성. 저장본(와이어) + 표시 맵 목록이 바뀐 통합 토큰들을 함께 반환(방 없으면 undefined).
   *
   * 가져오기로 들어온 통합 레이어에는 '이 맵들에서만 보임'(mapIds)이 박혀 있다. 그래서 새 맵세트를
   * 만들 때 이어받지 않으면 통합 레이어가 아무것도 안 보이는 빈 판이 나온다 — 바로 아래 duplicateMap
   * 과 짝을 맞춘다. 만든 사람이 보고 있던 맵에 보이던 것만 이어받는다(전부 이어받으면 서로 다른
   * 배치를 두 번 가져온 방에서 새 맵에 두 배치가 겹쳐 쏟아진다).
   *
   * ⚠ 기준 맵은 부르는 쪽이 알려 준다(baseMapId). 맵 전환은 개인 뷰라 room.activeMapId 는 전원 강제
   *   이동 때만 움직이므로, 그 값을 기준으로 삼으면 만든 사람 화면과 다른 맵에서 이어받는다 —
   *   클라 미러는 자기 화면 기준으로 이어붙이므로 두 쪽이 서로 다른 결과를 갖게 된다.
   */
  createMap(roomId: string, name?: string, baseMapId?: string): { map: GameMap; touchedGlobals: Token[] } | undefined {
    const room = this.rooms.get(roomId)
    if (!room) return undefined
    const m = makeMap((name ?? '').trim() || `맵 ${room.maps.size + 1}`)
    // 알려 준 기준 맵이 실재할 때만 쓴다(구버전 클라·잘못된 id 는 종전대로 활성 맵).
    const base = baseMapId && room.maps.has(baseMapId) ? baseMapId : room.activeMapId
    const touchedGlobals: Token[] = []
    for (const t of room.globalTokens?.values() ?? []) {
      if (t.mapIds?.includes(base)) {
        t.mapIds = [...t.mapIds, m.id]
        touchedGlobals.push(t)
      }
    }
    room.maps.set(m.id, m)
    room.lastActivityAt = Date.now()
    return { map: toWireMap(m), touchedGlobals }
  }

  /** 맵세트 복제(GM 전용). 원본의 배경/바탕/그리드/토큰/드로잉/텍스트/메타를 새 맵으로 깊은 복사(토큰 등은 새 id). */
  duplicateMap(roomId: string, mapId: string): { map: GameMap; touchedGlobals: Token[] } | undefined {
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
    const touchedGlobals: Token[] = []
    for (const t of room.globalTokens?.values() ?? []) {
      if (t.mapIds?.includes(mapId)) {
        t.mapIds = [...t.mapIds, m.id]
        touchedGlobals.push(t)
      }
    }
    room.maps.set(m.id, m)
    room.lastActivityAt = Date.now()
    return { map: toWireMap(m), touchedGlobals }
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
  /** 카드 추가/갱신(GM). id 있으면 갱신, 없으면 신규(MAX_VISUAL_CARDS 까지). 이미지·음향 둘 다 없으면 무시. 정규화 목록 반환. */
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
      displaySec: coerceDisplaySec(o.displaySec, image),
      for: coerceCardSpeakers(o.for)
    }
    if (i >= 0) cards[i] = card
    else {
      if (cards.length >= MAX_VISUAL_CARDS) return undefined
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

  // ===== 덱(카드 뭉치 · GM 이 만들고 방 전원이 뽑는다 — 권한 검증은 호출 측 relay) =====
  /** 이 방의 덱 목록. 뷰어를 주면 그 사람에게 보일 몫으로, 주지 않으면 가장 좁게(감춘 덱은 카드·버린 더미를 비워) 내보낸다. */
  decksFor(roomId: string, viewer?: { role: Participant['role']; playerId?: string }): DeckView[] {
    return (this.rooms.get(roomId)?.decks ?? []).map((d) => deckView(d, viewer))
  }

  /** 덱 하나 찾기(내부 보관본) — 뽑기 권한 판정에 쓴다. */
  getDeck(roomId: string, deckId: string): Deck | undefined {
    return this.rooms.get(roomId)?.decks?.find((d) => d.id === deckId)
  }

  /**
   * 덱 만들기/고치기(GM). id 없으면 새 덱.
   *
   * 카드 구성이 달라졌을 때만 더미를 다시 섞는다 — 이름이나 설정만 고쳤는데 진행 중인 판이
   * 처음으로 되돌아가면 곤란하기 때문이다. 상한을 넘으면 undefined(호출 측이 조용히 무시).
   */
  upsertDeck(roomId: string, req: DeckUpsertReq): Deck | undefined {
    const room = this.rooms.get(roomId)
    if (!room) return undefined
    const name = (typeof req?.name === 'string' ? req.name.trim() : '').slice(0, 40)
    if (!name) return undefined
    const cards = coerceDeckCards(req.cards)
    if (!cards.length) return undefined
    const decks = room.decks ?? []
    const id = capId(req.id)
    const at = id ? decks.findIndex((d) => d.id === id) : -1
    const prev = at >= 0 ? decks[at] : undefined
    if (!prev && decks.length >= MAX_DECKS) return undefined

    /** 카드 구성이 그대로인지 — 장수까지 같아야 '안 바뀐 것'으로 본다. */
    const sameCards =
      !!prev &&
      prev.cards.length === cards.length &&
      prev.cards.every((c, i) => c.id === cards[i].id && (c.count ?? 1) === (cards[i].count ?? 1))

    const deck: Deck = {
      id: prev?.id ?? id ?? randomUUID(),
      name,
      cards,
      draw: sameCards ? prev.draw : shufflePile(deckPile(cards)),
      discard: sameCards ? prev.discard : [],
      announce: req.announce !== false,
      reshuffle: req.reshuffle === true,
      revealCards: req.revealCards !== false,
      who: req.who === 'gm' ? 'gm' : 'all',
      createdAt: prev?.createdAt ?? Date.now()
    }
    if (at >= 0) decks[at] = deck
    else decks.push(deck)
    room.decks = decks
    room.lastActivityAt = Date.now()
    return deck
  }

  /** 덱 삭제(GM). 지웠으면 true. */
  deleteDeck(roomId: string, deckId: string): boolean {
    const room = this.rooms.get(roomId)
    if (!room?.decks) return false
    const next = room.decks.filter((d) => d.id !== deckId)
    if (next.length === room.decks.length) return false
    room.decks = next.length ? next : undefined
    room.lastActivityAt = Date.now()
    return true
  }

  /** 다시 섞기(GM) — 버린 더미까지 걷어 한 벌을 새로 섞는다. */
  shuffleDeck(roomId: string, deckId: string): Deck | undefined {
    const room = this.rooms.get(roomId)
    const deck = room?.decks?.find((d) => d.id === deckId)
    if (!room || !deck) return undefined
    deck.draw = shufflePile(deckPile(deck.cards))
    deck.discard = []
    room.lastActivityAt = Date.now()
    return deck
  }

  /**
   * 뽑기 — 서버가 더미에서 꺼낸다.
   *
   * 클라이언트가 결과를 만들어 보내는 방식이면 남은 장수를 무시하고 얼마든지 뽑아낼 수 있고,
   * 여러 사람이 같은 순간에 뽑으면 같은 카드가 두 번 나온다. 그래서 더미도 뽑기도 서버에만 둔다.
   * 더미가 모자라면 있는 만큼만 준다(자동 섞기가 켜져 있으면 걷어서 다시 섞고 이어 뽑는다).
   */
  drawFromDeck(
    roomId: string,
    deckId: string,
    count: number,
    /** '비밀로' 뽑았으면 뽑은 사람 playerId — 버린 더미에 각인해 그 사람과 GM 에게만 보인다. */
    secretBy?: string
  ): { deck: Deck; cards: DeckCard[] } | undefined {
    const room = this.rooms.get(roomId)
    const deck = room?.decks?.find((d) => d.id === deckId)
    if (!room || !deck) return undefined
    const want = Math.max(1, Math.min(MAX_DECK_DRAW, Math.round(count) || 1))
    const byId = new Map(deck.cards.map((c) => [c.id, c]))
    const drawn: DeckCard[] = []
    for (let i = 0; i < want; i++) {
      if (!deck.draw.length) {
        if (!deck.reshuffle || !deck.cards.length) break
        // 자동 섞기 — 카드 정의에서 한 벌을 새로 만들어 섞고 버린 더미를 비운다(discard 를 걷어 쓰지 않는다).
        // 정의가 하나도 없으면 만들 것이 없어 여기서 끝난다.
        deck.draw = shufflePile(deckPile(deck.cards))
        deck.discard = []
      }
      const id = deck.draw.pop()
      if (!id) break
      const card = byId.get(id)
      if (!card) continue // 정의가 사라진 유령 카드는 조용히 건너뛴다
      deck.discard.push(secretBy ? { id, by: secretBy } : { id })
      drawn.push(card)
    }
    if (!drawn.length) return undefined
    room.lastActivityAt = Date.now()
    return { deck, cards: drawn }
  }

  /**
   * 이번 발화에서 볼 카드 뭉치를 둘로 나눈다 — [이 화자에게 매어 둔 것, 누구에게나 열린 것].
   *
   * ⚠ 나누는 일이 먼저고 고르는 일이 나중이다. 이름 구체성으로 한 장을 먼저 뽑고 나서 화자를
   *    걸러 내면, 공용 '대성공' 카드가 이겨서 뽑힌 뒤 그 자리에서 탈락해 **아무것도 안 뜬다**.
   *    화자에게 매어 둔 카드가 하나라도 걸리면 공용은 아예 보지 않는다.
   */
  private cardTiers(roomId: string, sp?: CardSpeaker): [VisualCard[], VisualCard[]] {
    const cards = this.rooms.get(roomId)?.visualCards
    if (!cards?.length) return [[], []]
    const key = poolKey(sp?.playerId, sp?.charId)
    const mine: VisualCard[] = []
    const shared: VisualCard[] = []
    for (const c of cards) {
      if (!c.for?.length) shared.push(c)
      // 화자를 알 수 없는 발화(GM 의 1회성 NPC·charId 를 안 싣는 옛 클라)는 열쇠가 빈 문자열이라
      // 어느 화자 카드에도 걸리지 않는다 — 공용 카드만 뜬다. '모르면 통과'로 두면 매어 둔 뜻이 없어진다.
      else if (key && c.for.includes(key)) mine.push(c)
    }
    return [mine, shared]
  }

  /** 다이스 결과 라벨로 카드 찾기 — 라벨('대성공' 등)이 카드 이름과 정확히 일치하면 그 카드(트리거용). */
  findCardByTitle(roomId: string, text: string, sp?: CardSpeaker): VisualCard | undefined {
    const t = text.trim()
    if (!t) return undefined
    for (const tier of this.cardTiers(roomId, sp)) {
      const hit = tier.find((c) => c.name === t)
      if (hit) return hit
    }
    return undefined
  }

  /**
   * 판정 결과로 카드 찾기 — 이름이 딱 떨어지지 않아도 발동한다.
   *
   * 카드 이름이 '성공' 처럼 결과 라벨과 **정확히 같아야만** 뜨게 두면, GM 이 '성공 컷인'·'대성공!'
   * 처럼 지은 카드는 영영 안 떠서 판정 컷인은 사실상 못 쓰고 텍스트로 부르는 길만 남는다.
   *
   * 그래서 '이름에 그 라벨이 들어 있으면' 발동으로 넓히되, 한 가지를 지킨다: '대성공!' 은 '성공'
   * 카드로도 읽히므로, 카드마다 **이름에 들어 있는 라벨 중 가장 긴 것**을 그 카드의 뜻으로 보고
   * 그것이 이번 결과의 라벨일 때만 튼다. 일반 성공에 '대성공!' 카드가 새어 나오지 않는다.
   *
   * @param keys 이번 결과의 라벨들(구체적인 것이 앞).
   * @param allKeys 이 룰에서 나올 수 있는 라벨 전부 — 어느 라벨이 더 구체적인지 견주는 데 쓴다.
   * @param sp 이번 발화의 화자 — 매어 둔 카드를 먼저 본다.
   */
  findCardForResult(roomId: string, keys: string[], allKeys: string[], sp?: CardSpeaker): VisualCard | undefined {
    if (!keys.length) return undefined
    // keys 는 구체적인 것이 앞이다('대성공' → '성공'). 그 차례를 점수로 삼아, 더 구체적인 라벨을 뜻하는
    // 카드가 언제나 이긴다. 등록 순서로 이기게 두면 '성공' 카드를 먼저 만든 방에서 대성공에도 그것이 뜬다.
    const rank = new Map(keys.map((k, i) => [k, i]))
    const pick = (cards: VisualCard[]): VisualCard | undefined => {
      let hit: VisualCard | undefined
      let hitRank = Number.MAX_SAFE_INTEGER
      let hitExact = false
      for (const c of cards) {
        const name = (c.name ?? '').trim()
        if (!name) continue
        // 이름이 라벨 그대로면 그 라벨을 뜻하는 것이 분명하다. 아니면 이름이 품은 라벨 중 가장 긴 것으로 본다.
        const exact = rank.has(name)
        let best = ''
        if (!exact) for (const k of allKeys) if (k && name.includes(k) && k.length > best.length) best = k
        const key = exact ? name : best
        const r = key ? rank.get(key) : undefined
        if (r === undefined) continue
        // 같은 구체성이면 이름이 라벨과 똑같은 쪽을 먼저, 그다음은 등록순.
        if (r < hitRank || (r === hitRank && exact && !hitExact)) {
          hit = c
          hitRank = r
          hitExact = exact
        }
      }
      return hit
    }
    for (const tier of this.cardTiers(roomId, sp)) {
      const hit = pick(tier)
      if (hit) return hit
    }
    return undefined
  }
  /**
   * 채팅·스크립트 본문으로 카드 찾기 — 화면에 보이는 평문 기준으로 카드 이름이 '포함'되면 그 카드.
   * 문장 속 키워드·스크립트 본문 키워드도 발동한다. 여러 카드가 매칭되면 이름이 긴(더 구체적인) 카드
   * 우선, 동률은 등록순. 화자에게 매어 둔 카드가 걸리면 공용보다 먼저다.
   */
  findCardInText(roomId: string, text: string, sp?: CardSpeaker): VisualCard | undefined {
    const t = stripChatMarkup(text).trim()
    if (!t) return undefined
    for (const tier of this.cardTiers(roomId, sp)) {
      let hit: VisualCard | undefined
      for (const c of tier) {
        if (!c.name || !t.includes(c.name)) continue
        if (!hit || c.name.length > hit.name.length) hit = c
      }
      if (hit) return hit
    }
    return undefined
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
      charId: capId(req.charId) ?? existing?.charId,
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
      // 클릭 연출 카드 — 문자열이면 적용(빈 문자열=해제), 미지정이면 기존 보존. 실존 카드 검사는
      // 재생 시점(card:trigger)에 한다 — 카드를 먼저 지웠다 다시 만들어도 묶임이 살아 있게.
      clickCardId:
        typeof req.clickCardId === 'string'
          ? req.clickCardId.slice(0, 64) || undefined
          : existing?.clickCardId,
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
      // 가져오기 출처 태그 — 편집(upsert)으로는 바뀌지 않는다(가져오기·로드에서만 부여).
      importId: existing?.importId,
      // 참가자 창작 오브젝트 소유자 — 편집으로는 바뀌지 않는다(참가자 배치에서만 서버가 스탬프).
      ownerPlayerId: existing?.ownerPlayerId,
      // 표시 맵 제한 — null 이면 해제(모든 맵에 표시), 배열이면 그 목록, 미지정이면 기존 보존.
      // 가져오기가 박아 둔 제한을 사람이 풀 수 있어야 한다(못 풀면 새 맵세트가 빈 판으로 보인다).
      mapIds:
        req.mapIds === null
          ? undefined
          : Array.isArray(req.mapIds)
            ? req.mapIds.filter((x): x is string => typeof x === 'string' && !!x).slice(0, 200)
            : existing?.mapIds,
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

  /**
   * 참가자 오브젝트 배치/갱신 — 요청 필드를 화이트리스트로만 옮겨 upsertToken 에 태운다(클램프·이미지 캡 공유).
   * 신규면 ownerPlayerId=playerId 를 스탬프하고, id 가 기존 토큰이면 그 토큰의 소유자가 본인일 때만 갱신한다
   * (GM·다른 참가자의 토큰을 덮어쓰는 길 차단). 통합 레이어(GLOBAL_MAP_ID)는 방을 넘어 남으므로 배치 거부.
   * 방 설정(plObjects) 검사는 호출 측(relay).
   */
  placePlToken(roomId: string, mapId: string, playerId: string, req: TokenPlacePlReq): Token | undefined {
    const room = this.rooms.get(roomId)
    if (!room || mapId === GLOBAL_MAP_ID) return undefined
    const tokens = this.tokenColl(room, mapId)
    if (!tokens) return undefined
    // id 는 길이 캡을 넘으면 통째로 무시(신규 취급) — 거대한 문자열이 키로 남는 것 방지.
    const reqId = typeof req.id === 'string' && req.id && req.id.length <= 200 ? req.id : undefined
    const existing = reqId ? tokens.get(reqId) : undefined
    if (existing && existing.ownerPlayerId !== playerId) return undefined // 남의 토큰 갱신 금지
    if (!existing) {
      // 1인당 참가자 오브젝트 상한(방 전체·모든 맵 합산) — 초과 배치는 무시.
      let mine = 0
      for (const m of room.maps.values())
        for (const t of m.tokens.values()) if (t.ownerPlayerId === playerId) mine++
      if (mine >= MAX_PL_OBJECTS_PER_PLAYER) return undefined
    }
    // 안전 부분집합만 복사 — 공개범위·상태바·클릭 동작·권한 명단 등 GM 전용 필드는 여기서 원천 차단.
    const safe: TokenUpsertReq = {
      mapId,
      id: reqId,
      x: req.x,
      y: req.y,
      size: req.size,
      w: req.w,
      h: req.h,
      rotation: req.rotation,
      label: req.label,
      color: req.color,
      image: req.image,
      images: req.images,
      flipX: req.flipX,
      layer: req.layer // 정규화(coerceLayer)는 upsertToken 이 담당
    }
    const token = this.upsertToken(roomId, mapId, safe)
    if (!token) return undefined
    // 신규 배치에만 소유자 각인 — upsertToken 이 저장한 그 객체에 직접 남긴다(요청으로는 못 바꾼다).
    if (!existing) token.ownerPlayerId = playerId
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
   * 지금 보고 있는 화면의 겹침 순서 — 통합 레이어와 그 맵의 레이어를 한 줄로 세워 뒤→앞으로 돌려준다.
   *
   * 화면은 두 컬렉션을 한 배열에 담아 밴드별로 z 순으로 그린다. 순서를 매기는 쪽도 같은 줄을 보아야
   * 목록에서 끌어 놓은 자리와 실제로 그려지는 자리가 어긋나지 않는다.
   * z 가 같은 것끼리는 통합 레이어를 뒤에 두어 그리는 쪽의 순서(통합 먼저 넣고 맵 토큰을 얹는다)를 따른다.
   */
  private sceneStack(room: Room, sceneMapId: string): { token: Token; mapId: string }[] {
    const rows: { token: Token; mapId: string; seq: number }[] = []
    let seq = 0
    for (const t of room.globalTokens?.values() ?? [])
      // 표시 맵이 지정된 통합 레이어는 그 맵에서만 그려진다 — 안 보이는 것이 줄에 끼면 순번을 먹는다.
      if (!t.mapIds || t.mapIds.includes(sceneMapId)) rows.push({ token: t, mapId: GLOBAL_MAP_ID, seq: seq++ })
    if (sceneMapId !== GLOBAL_MAP_ID)
      for (const t of room.maps.get(sceneMapId)?.tokens.values() ?? [])
        rows.push({ token: t, mapId: sceneMapId, seq: seq++ })
    rows.sort((a, b) => {
      const d = LAYER_ORDER[a.token.layer ?? 'token'] - LAYER_ORDER[b.token.layer ?? 'token']
      if (d !== 0) return d
      const dz = (a.token.z ?? 0) - (b.token.z ?? 0)
      return dz !== 0 ? dz : a.seq - b.seq
    })
    return rows.map(({ token, mapId }) => ({ token, mapId }))
  }

  /**
   * 한 줄로 세운 순서를 z 로 다시 굳힌다 — 밴드마다, 고정하지 않은 것들에만 새 값을 매긴다.
   *
   * 밖에서 가져온 맵세트는 여러 오브젝트가 같은 z 를 쓰는 일이 흔한데, 그러면 '한 칸 앞으로'가 그 무리를
   * 통째로 건너뛰어 끌어 놓은 자리에 내려앉지 않는다. 자리를 옮길 때마다 번호를 다시 매겨 같은 값을 없앤다.
   *
   * ⚠ pinned 는 '건드리면 안 되는 컬렉션'이다. 통합 레이어는 모든 맵이 함께 쓰므로, 이 맵에서 순서를
   * 바꿨다고 통합 레이어의 z 를 다시 매기면 **다른 맵의 겹침이 소리 없이 뒤바뀐다**. 그래서 맵 토큰을
   * 옮길 때는 통합 레이어를 고정하고, 고정된 이웃 사이의 빈 자리에 소수로 끼워 넣는다(z 는 실수여도 된다).
   * 값이 실제로 달라진 것만 돌려주므로, 이미 정돈된 줄에서는 움직인 언저리만 다시 방송된다.
   */
  private renumber(
    stack: { token: Token; mapId: string }[],
    pinned?: string
  ): { mapId: string; token: Token }[] {
    const changed: { mapId: string; token: Token }[] = []
    const byBand = new Map<TokenLayer, { token: Token; mapId: string }[]>()
    for (const row of stack) {
      const band = row.token.layer ?? 'token'
      const list = byBand.get(band)
      if (list) list.push(row)
      else byBand.set(band, [row])
    }
    for (const rows of byBand.values()) {
      // 고정된 이웃을 경계로 잘라, 그 사이의 자유로운 것들에만 값을 나눠 준다.
      let i = 0
      while (i < rows.length) {
        if (pinned !== undefined && rows[i].mapId === pinned) {
          i++
          continue
        }
        let j = i
        while (j < rows.length && !(pinned !== undefined && rows[j].mapId === pinned)) j++
        const lo = i > 0 ? (rows[i - 1].token.z ?? 0) : undefined
        const hi = j < rows.length ? (rows[j].token.z ?? 0) : undefined
        const n = j - i
        // 양쪽 경계가 없으면 1,2,3…, 한쪽만 있으면 그 옆으로 1씩, 둘 다 있으면 사이를 n+1 등분한다.
        const from = lo ?? (hi !== undefined ? hi - (n + 1) : 0)
        const to = hi ?? from + (n + 1)
        const step = to > from ? (to - from) / (n + 1) : 1
        for (let k = 0; k < n; k++) {
          const row = rows[i + k]
          const z = from + step * (k + 1)
          if (row.token.z !== z) {
            row.token.z = z
            changed.push({ mapId: row.mapId, token: row.token })
          }
        }
        i = j
      }
    }
    return changed
  }

  /**
   * 토큰 z순서/레이어 변경(GM 전용 — 권한 검증은 호출 측 relay). layer 지정 시 그 레이어 맨 앞으로 이동,
   * op='moveTo' 면 targetId 옆자리로 한 번에, forward/backward 는 한 칸씩,
   * front/back 은 무대 같은 쪽의 끝까지 간다(그리는 방식이 같은 밴드 안에서 — 원형 두상은 token 밴드에 머문다).
   * 변경된 토큰을 그것이 속한 컬렉션(mapId)과 함께 반환 → relay 가 각각 token:state 송출.
   */
  reorderToken(
    roomId: string,
    mapId: string,
    id: string,
    req: { op?: TokenZOp; layer?: TokenLayer; sceneMapId?: string; targetId?: string; side?: 'front' | 'back' }
  ): { mapId: string; token: Token }[] {
    const room = this.rooms.get(roomId)
    const coll = room ? this.tokenColl(room, mapId) : undefined
    const t = coll?.get(id)
    if (!room || !coll || !t) return []
    // 겹침은 통합 레이어와 이 맵의 레이어가 한 줄로 섞여 그려진다 — 순서도 그 한 줄 위에서 매긴다.
    // 부르는 쪽이 보고 있는 맵을 알려 주지 않으면(구버전 클라) 예전처럼 제 컬렉션 안에서만 다룬다.
    const sceneMapId = req.sceneMapId ?? (mapId === GLOBAL_MAP_ID ? undefined : mapId)
    const stack = sceneMapId
      ? this.sceneStack(room, sceneMapId)
      : [...coll.values()]
          .sort(
            (a, b) =>
              LAYER_ORDER[a.layer ?? 'token'] - LAYER_ORDER[b.layer ?? 'token'] || (a.z ?? 0) - (b.z ?? 0)
          )
          .map((token) => ({ token, mapId }))
    const changed: { mapId: string; token: Token }[] = []
    const curLayer = t.layer ?? 'token'
    /** 이 토큰이 속한 컬렉션 — 한 줄에 섞여 있어도 방송은 제 컬렉션으로 나가야 한다. */
    const collOf = (x: Token): string => stack.find((r) => r.token === x)?.mapId ?? mapId
    /** 무대 앞(bg·token·standing)과 무대 뒤(behind)는 서로 순서를 섞지 않는다 — 무대 이미지가 사이에 있다. */
    const sameSide = (a: TokenLayer, b: TokenLayer): boolean => (a === 'behind') === (b === 'behind')
    /**
     * 겹침을 옮길 때 넘나들 수 있는 밴드인지. 밴드는 순서만 정하는 것이 아니라 **그리는 방식**도 정한다 —
     * token 밴드만 원형 두상(이름·수치 바)으로 그리고 나머지는 직사각 이미지다. 그래서 순서를 바꾸려다
     * 이 경계를 넘으면 두상이 통째로 다른 그림이 된다. 밴드를 바꾸는 것은 '무대 앞뒤 보내기'처럼
     * 사용자가 그렇게 하겠다고 고른 길(req.layer)에만 맡긴다.
     */
    const sameKind = (a: TokenLayer, b: TokenLayer): boolean => (a === 'token') === (b === 'token')
    /** 옮긴 토큰이 통합 레이어면 맵 토큰을, 맵 토큰이면 통합 레이어를 고정한다(다른 맵을 흔들지 않게). */
    const pinned = mapId === GLOBAL_MAP_ID ? sceneMapId : GLOBAL_MAP_ID
    /**
     * 끌어 놓은 자리에 맞는 밴드. 원형 두상은 제 밴드에 머물고, 이미지는 무대 뒤(behind)와
     * 캐릭터보다 뒤(bg)·앞(standing) 중 놓인 자리에 맞는 것을 고른다. 캐릭터 토큰이 하나도 없으면
     * 앞뒤를 가를 기준이 없으므로 놓은 대상의 밴드를 그대로 따른다.
     */
    const bandFor = (line: Token[], idx: number, target: Token): TokenLayer => {
      if (curLayer === 'token') return 'token'
      const tl = target.layer ?? 'token'
      if (tl === 'behind') return 'behind'
      const lastChar = line.reduce((acc, x, i) => (x !== t && (x.layer ?? 'token') === 'token' ? i : acc), -1)
      if (lastChar < 0) return sameKind(tl, curLayer) ? tl : curLayer
      return idx > lastChar ? 'standing' : 'bg'
    }
    if (req.layer && coerceLayer(req.layer) !== curLayer) {
      const layer = coerceLayer(req.layer)
      // topZ 를 레이어 변경 전에 계산(아직 옛 레이어 → t 자신이 새 레이어 max 에 포함되지 않음).
      const z = topZ(coll.values(), layer) + 1 // 새 레이어 맨 앞으로
      t.layer = layer
      t.z = z
      changed.push({ mapId, token: t })
    } else if (req.op === 'moveTo') {
      // 목록에서 끌어 놓은 자리로 한 번에. 예전에는 '한 칸씩'을 그 수만큼 연달아 보내야 했는데,
      // 같은 z 가 섞여 있으면 한 칸이 여러 칸을 뛰어 엉뚱한 데 내려앉았다.
      const target = req.targetId ? stack.find((r) => r.token.id === req.targetId)?.token : undefined
      if (target && target !== t) {
        const line = stack.map((r) => r.token)
        const from = line.indexOf(t)
        let at = line.indexOf(target)
        if (from >= 0 && at >= 0) {
          // 줄은 뒤→앞 순이다. 'front'=대상보다 앞(뒤에서 셀 때 한 칸 뒤에), 'back'=대상보다 뒤.
          if (req.side === 'front') at += 1
          line.splice(from, 1)
          if (from < at) at -= 1
          line.splice(at, 0, t)
          // 놓인 자리에 맞는 밴드를 고른다. 다만 그리는 방식이 다른 밴드(token ↔ 이미지)로는 넘어가지
          // 않는다 — 겹침만 바꾸려다 원형 두상이 직사각 이미지가 되어서는 안 된다.
          const band = bandFor(line, line.indexOf(t), target)
          if (band !== curLayer) {
            t.layer = band
            changed.push({ mapId: collOf(t), token: t })
          }
          for (const row of this.renumber(line.map((token) => ({ token, mapId: collOf(token) })), pinned))
            if (!changed.some((c) => c.token === row.token)) changed.push(row)
        }
      }
    } else if (req.op) {
      const sibs = stack.map((r) => r.token).filter((x) => (x.layer ?? 'token') === curLayer)
      /** 한 칸 넘어갈 수 있는 다음 밴드 — 그리는 방식이 같은 것만 고른다(건너뛰면 두상이 이미지가 된다). */
      const nextBand = (dir: 1 | -1): TokenLayer | undefined => {
        for (let i = REORDER_BANDS.indexOf(curLayer) + dir; i >= 0 && i < REORDER_BANDS.length; i += dir) {
          const b = REORDER_BANDS[i]
          if (sameKind(b, curLayer)) return b
        }
        return undefined
      }
      const myz = t.z ?? 0
      if (req.op === 'front' || req.op === 'back') {
        // 맨 앞·맨 뒤는 무대 같은 쪽의 끝까지 간다. 예전에는 제 밴드 안에서만 움직여, 눌러도 위에 있는
        // 밴드에 가려 '아무 일도 안 일어난' 것처럼 보였다. 다만 그리는 방식은 지킨다 — 원형 두상은
        // token 밴드에 머물고, 이미지는 캐릭터보다 앞(standing)·뒤(bg)·무대 뒤(behind) 안에서만 옮긴다.
        // 끝으로 보내는 것뿐이라 번호를 다시 매기지 않는다(한 번 누를 때마다 줄 전체를 다시 방송하게 된다).
        const side = stack.map((r) => r.token).filter((x) => x !== t && sameSide(x.layer ?? 'token', curLayer))
        const band: TokenLayer =
          curLayer === 'token'
            ? 'token'
            : curLayer === 'behind'
              ? 'behind'
              : req.op === 'front' && side.some((x) => !sameKind(x.layer ?? 'token', curLayer) || (x.layer ?? 'token') === 'standing')
                ? 'standing'
                : 'bg'
        const peers = side.filter((x) => (x.layer ?? 'token') === band).map((x) => x.z ?? 0)
        const edge = peers.length ? (req.op === 'front' ? Math.max(...peers) : Math.min(...peers)) : 0
        const z = req.op === 'front' ? edge + 1 : edge - 1
        if (curLayer !== band || t.z !== z) {
          t.layer = band
          t.z = z
          changed.push({ mapId: collOf(t), token: t })
        }
      } else if (req.op === 'forward') {
        // 바로 위(다음으로 큰 z) 형제와 z 교환.
        const next = sibs.filter((s) => (s.z ?? 0) > myz).sort((a, b) => (a.z ?? 0) - (b.z ?? 0))[0]
        if (next) {
          const nz = next.z ?? 0
          next.z = myz
          t.z = nz
          changed.push({ mapId: collOf(t), token: t }, { mapId: collOf(next), token: next })
        } else {
          // 밴드 맨 앞 → 그리는 방식이 같은 다음 밴드로 승격(그 밴드 맨 뒤에 붙임). 클라 planReorder 미러.
          const up = nextBand(-1)
          if (up) {
            const ups = stack.map((r) => r.token).filter((x) => (x.layer ?? 'token') === up)
            t.layer = up
            t.z = (ups.length ? Math.min(...ups.map((s) => s.z ?? 0)) : 0) - 1
            changed.push({ mapId: collOf(t), token: t })
          }
        }
      } else if (req.op === 'backward') {
        // 바로 아래(다음으로 작은 z) 형제와 z 교환.
        const prev = sibs.filter((s) => (s.z ?? 0) < myz).sort((a, b) => (b.z ?? 0) - (a.z ?? 0))[0]
        if (prev) {
          const pz = prev.z ?? 0
          prev.z = myz
          t.z = pz
          changed.push({ mapId: collOf(t), token: t }, { mapId: collOf(prev), token: prev })
        } else {
          // 밴드 맨 뒤 → 그리는 방식이 같은 다음 밴드로 강등(그 밴드 맨 앞에 붙임). bg→behind 면 무대 뒤로.
          const down = nextBand(1)
          if (down) {
            const downs = stack.map((r) => r.token).filter((x) => (x.layer ?? 'token') === down)
            t.layer = down
            t.z = (downs.length ? Math.max(...downs.map((s) => s.z ?? 0)) : 0) + 1
            changed.push({ mapId: collOf(t), token: t })
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
      if (isGm(room, accountId) || room.members.has(accountId))
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

  /**
   * 공동 GM 지정·해제 — 소유자만. 대상은 이 방에 한 번이라도 들어온 계정이어야 한다.
   *
   * 지금 방에 있는 사람이면 참가자 레코드의 role 까지 그 자리에서 맞춘다. 방 안의 권한 검사는
   * 전부 role 을 보므로, 여기서 안 맞추면 다음에 다시 들어올 때까지 권한이 따라오지 않는다.
   * 소유자는 대상이 될 수 없다 — 이미 GM 이고, 지정을 해제한다는 말이 성립하지 않는다.
   */
  setGm(roomId: string, ownerId: string, targetId: string, on: boolean): { error: string } | { ok: true } {
    const room = this.rooms.get(roomId)
    if (!room) return { error: '세션을 찾을 수 없습니다.' }
    if (room.ownerId !== ownerId) return { error: '방을 만든 사람만 GM 을 지정할 수 있습니다.' }
    if (!targetId || targetId === room.ownerId) return { error: '방을 만든 사람은 언제나 GM 입니다.' }
    if (on && !room.members.has(targetId) && !room.participants.has(targetId))
      return { error: '이 세션에 들어온 적 없는 사람입니다.' }
    if (on) room.gmIds.add(targetId)
    else room.gmIds.delete(targetId)
    const p = room.participants.get(targetId)
    if (p) p.role = on ? 'GM' : 'PL'
    room.lastActivityAt = Date.now()
    void this.flush(room)
    return { ok: true }
  }

  /**
   * 방 양도 — 소유자만. 대상이 새 소유자가 되고, 넘긴 사람은 공동 GM 으로 남는다.
   *
   * 넘긴 사람을 PL 로 떨어뜨리지 않는 이유는 단순하다. 양도는 보통 '오늘은 네가 진행해'라는 뜻이지
   * '나는 이제 손을 뗀다'가 아니고, 잘못 눌렀을 때 되돌릴 사람이 방 안에 아무도 남지 않으면 곤란하다.
   * 되돌리려면 새 소유자가 다시 양도하면 된다.
   */
  transferOwner(roomId: string, ownerId: string, targetId: string): { error: string } | { ok: true } {
    const room = this.rooms.get(roomId)
    if (!room) return { error: '세션을 찾을 수 없습니다.' }
    if (room.ownerId !== ownerId) return { error: '방을 만든 사람만 양도할 수 있습니다.' }
    if (!targetId || targetId === ownerId) return { error: '자기 자신에게는 넘길 수 없습니다.' }
    if (!room.members.has(targetId) && !room.participants.has(targetId))
      return { error: '이 세션에 들어온 적 없는 사람입니다.' }
    room.ownerId = targetId
    room.members.add(targetId)
    room.members.add(ownerId) // 넘긴 사람이 '내 세션 목록'에서 사라지지 않게
    room.gmIds.delete(targetId) // 새 소유자는 소유자라서 GM 이다 — 공동 GM 명단에 겹쳐 두지 않는다
    room.gmIds.add(ownerId)
    const np = room.participants.get(targetId)
    if (np) np.role = 'GM'
    room.lastActivityAt = Date.now()
    void this.flush(room)
    return { ok: true }
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
      gmIds: new Set(), // 사본은 만든 사람 혼자로 시작 — 원본의 공동 GM 을 자동으로 물려주지 않는다
      members: new Set([accountId]),
      cardImage: src.cardImage,
      participants: new Map(),
      characters: new Map(),
      // 토큰은 그대로 복사되므로 보관대도 함께 옮긴다 — 아니면 복사한 방에서 토큰이 이름을 잃는다.
      charPool: new Map(src.charPool),
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
      // 잠금은 복제본에 옮기지 않는다 — 복사한 방은 새로 준비하는 방이라 문을 열어 둔 채 시작한다.
      luckEnabled: src.luckEnabled, // 행운 깎기 사용 여부 복제
      vnOverlay: src.vnOverlay, // VN 오버레이 표시 여부 복제
      plObjects: src.plObjects, // 참가자 오브젝트 추가 허용 여부 복제
      gmSeeWhispers: src.gmSeeWhispers, // GM 귓속말 열람 여부 복제(대화는 복제하지 않으므로 각인은 따라가지 않는다)
      // 덱은 정의만 옮기고 판은 처음부터 — 복사한 방은 새로 시작하는 방이다.
      decks: src.decks?.map((d) => ({ ...d, cards: d.cards.map((c) => ({ ...c })), draw: shufflePile(deckPile(d.cards)), discard: [] })),
      // 비주얼 카드도 옮긴다. 매어 둔 화자(for)는 보관대를 함께 복사하므로 사본에서도 그대로 가리킨다.
      visualCards: src.visualCards?.map((c) => ({ ...c, ...(c.for ? { for: [...c.for] } : {}) })),
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

  /** 세션 채팅 로그 전체 삭제 — 소유자만. 보관해 둔 지난 대화까지 함께 지운다. 성공 시 true. */
  clearChat(roomId: string, accountId: string): boolean {
    const room = this.rooms.get(roomId)
    if (!room || room.ownerId !== accountId) return false
    room.messages = []
    room.lastActivityAt = Date.now()
    this.journal(roomId, { op: 'clear' })
    // '비우기'는 되돌릴 수 없는 손짓이다 — 보관소만 남겨 두면 '더 불러오기'로 지운 말이 도로 올라온다.
    this.removeArchive(roomId)
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
      gmIds: [...room.gmIds],
      cardImage: room.cardImage,
      participants: this.participants(room),
      characters: [...room.characters.values()],
      // 로스터에 없는(지금 아무도 장착하지 않은) 캐릭터도 함께 — 그 캐릭터의 토큰이 이름·수치를 그린다.
      charPool: [...room.charPool.values()],
      messages,
      archived: this.hasArchive(room.id), // 이보다 앞선 대화가 보관소에 남아 있는가
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
      locked: room.locked, // 입실 잠금(공사중)
      luckEnabled: room.luckEnabled, // 행운 깎기 사용 여부
      vnOverlay: room.vnOverlay, // VN 오버레이 표시 여부
      // 참가자 오브젝트 추가 허용 — 항상 불리언으로 실어, 필드 유무로 클라가 구서버(기능 없음)를 가려낸다.
      plObjects: room.plObjects === true,
      gmSeeWhispers: room.gmSeeWhispers, // GM 귓속말 열람 여부
      bgm: room.bgm,
      combat: room.combat,
      channels: this.channelsFor(room, viewer),
      charRoomIds: viewer ? (room.charRooms.get(viewer.playerId) ?? []) : [], // 요청자의 이 방 시트 멤버십
      // 이 뷰어가 이미 고른 선택지(메시지 id → 옵션 id) — 재입장해도 잠금이 되살아난다.
      // 없으면 이미 답한 사람에게 버튼이 다시 열리고, 눌러 본 항목이 '선택했습니다'로 잘못 남는다.
      // 값이 빈 문자열이면 '고르긴 했는데 무엇인지 모른다'(구버전 저장본)는 뜻이다.
      choiceLocks: viewer
        ? Object.fromEntries(
            [...(room.choices?.entries() ?? [])]
              .filter(([, c]) => c.responders.has(viewer.playerId))
              .map(([mid, c]) => [mid, c.responders.get(viewer.playerId) ?? ''])
          )
        : {},
      saveSlots: this.slotMeta(room), // 저장 슬롯 메타(목록 표시용)
      visualCards: room.visualCards ?? [], // 비주얼 카드 목록
      decks: this.decksFor(room.id, viewer), // 덱 공개본(남은 더미의 순서는 빠진다)
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
        // 보관소도 이 방이 쓰는 자리다 — 빼고 세면 관리 화면의 용량이 실제보다 작게 보인다.
        const b = Buffer.byteLength(json, 'utf8') + this.archiveBytes(room.id)
        bytes += b
        scanAssetRefs(json, refs)
        collectAvatarHashes(room, refs)
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
      // 보관소로 옮겨 둔 대화가 붙잡고 있는 그림 — 메모리의 room.messages 에는 이미 없다.
      // 이걸 빼먹으면 '아무도 안 쓰는 파일'로 판정돼, 대화는 되읽히는데 그림만 빈칸이 된다.
      if (this.persist) for (const h of this.archiveRefSet(room.id)) into.add(h)
      collectAvatarHashes(room, into)
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
          // Map 을 그대로 넘기면 '{}' 로 직렬화돼 아무것도 못 훑는다 — 값 배열로 펴서 넘긴다.
          () => [...room.characters.values()],
          () => [...room.charPool.values()],
          // ⚠ 덱 카드 그림을 여기 빠뜨리면 주기 자산 회수가 '쓰는 데 없는 파일'로 보고 지운다 — 덱은 멀쩡한데 그림만 사라진다.
          () => [room.appearance, room.cutInImage, room.cutInImages, room.bgm, room.saveSlots, room.visualCards, room.decks]
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

  /**
   * 멤버 본인 이전 — 이 계정이 소유한 모든 방을 영속 파일 형태(roomToFile = 전체 장면·채팅)로 내보낸다.
   *
   * ⚠ 채팅은 앱 화면과 **같은 열람 규칙**(canSeeMessage)으로 거른다. 귓속말이 방 기록에 영속되면서,
   *   방장이라도 화면에서는 볼 수 없게 막아 둔 남의 귓속말이 내보내기 파일로는 원문 그대로 빠져나갔다.
   *   저장(roomToFile)은 그대로 전부 담아야 하므로 여기서만 걸러 낸다.
   */
  exportOwnedBy(accountId: string): Record<string, unknown>[] {
    if (!accountId) return []
    const out: Record<string, unknown>[] = []
    for (const room of this.rooms.values()) {
      if (room.ownerId !== accountId) continue
      // 방 소유자는 그 방의 GM 이다(지금 접속 중이 아니어도 재입장하면 GM).
      const viewer = { playerId: accountId, role: room.participants.get(accountId)?.role ?? ('GM' as const) }
      const visible = room.messages.filter((m) =>
        canSeeMessage(
          m,
          viewer,
          // 방장은 지금 접속 중이 아니어도 GM 이다 — 참가자 목록으로만 판정하면 자기 방 그룹 로그가 내보내기에서 빠진다.
          // 지운 채널은 통과시키지 않는다(보관분을 거르는 archivedAll 과 같은 규칙이어야 두 길이 어긋나지 않는다).
          (gid) =>
            room.channels.has(gid) && (viewer.role === 'GM' || this.canAccessChannel(room.id, gid, accountId))
        )
      )
      // 보관소로 옮겨 둔 지난 대화까지 함께 싣는다 — 계정을 옮기면서 세션 앞부분을 잃지 않게.
      const archived = this.archivedAll(room.id, viewer)
      if (archived.truncated)
        console.warn(`[rooms] ${room.id}(${room.title}) 보관 대화가 너무 많아 내보내기에 최근 몫만 실었다.`)
      // 상한 경계에서 서버가 갑자기 죽은 직후에는 같은 말이 보관소와 라이브 양쪽에 남아 있을 수 있다 —
      // 파일에는 한 번만 싣는다(보관 쪽을 남겨야 시간순이 그대로다).
      const packed = new Set(archived.messages.map((m) => m.id))
      const live = packed.size ? visible.filter((m) => !packed.has(m.id)) : visible
      // 남은 더미의 순서는 파일로도 내보내지 않는다 — 디스크 저장과 달리 이 파일은 사람 손에 들어간다.
      // 되살릴 때는 순서가 없으므로 새로 섞인다(coerceDecks).
      const decks = room.decks?.map(({ draw: _draw, ...rest }) => rest)
      out.push(roomToFile({ ...room, decks, messages: [...archived.messages, ...live] } as Room))
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
      // 예전 판에서 만든 파일에는 같은 말이 두 번 실려 있을 수 있다 — 여기서 한 번만 남긴다.
      if (room.messages.length) {
        const seen = new Set<string>()
        room.messages = room.messages.filter((m) => {
          if (!m.id || seen.has(m.id)) return false
          seen.add(m.id)
          return true
        })
      }
      const id = randomUUID()
      let code = genCode()
      while (this.codeToId.has(code)) code = genCode()
      room.id = id
      room.code = code
      room.ownerId = accountId
      // 공동 GM 은 옛 서버의 계정 id 라 이 서버에서는 남이거나 없는 사람이다 — 비우고 시작한다.
      room.gmIds = new Set()
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
      // 옛 서버에서 보관소에 있던 몫까지 함께 실려 오므로 방이 상한을 넘길 수 있다.
      // 여기서 곧바로 이 서버의 보관소로 옮겨 둔다 — 안 그러면 입장 스냅샷이 통째로 그만큼 커진다.
      this.evictOldest(room, MAX_HISTORY)
      void this.flush(room) // 즉시 영속
      imported++
    }
    return imported
  }
}
