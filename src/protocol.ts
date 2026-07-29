// 멀티플레이 와이어 프로토콜 (서버 ↔ 클라이언트 단일 계약).
// 클라이언트 미러: src/renderer/src/net/protocol.ts — 이벤트/페이로드 변경 시 양쪽 동기화.
//    ChatMessage 는 렌더러 lib/chat/types.ts 와 동일 구조(클라는 그쪽을 재사용).
import type { DiceResult, SuccessLevel } from './dice/types'

/** 서버 프로그램 버전(배포 스냅샷 날짜) — GET /health 의 ver 로 노출. 클라이언트가 자가호스팅
 *  서버의 구버전 여부를 판별하는 근거이므로, 서버 기능이 바뀔 때마다 그 날짜로 갱신한다. */
export const SERVER_VERSION = '2026-07-29'

export type ChatChannel = 'main' | 'ooc' | 'whisper' | 'group'
// script = /desc 프로필 없는 꾸미기 스크립트(클라가 아바타·이름 없이 꾸미기 마크업으로 렌더).
// madness = 광기의 발작 카드(클라가 표를 굴려 결과 payload 전송 — 서버는 그대로 중계).
// choice = GM 선택지 버튼 · luck = 행운 성공 전환 결과 카드.
export type MessageKind =
  | 'speech'
  | 'narration'
  | 'dice'
  | 'madness'
  | 'script'
  | 'system'
  | 'choice'
  | 'luck'

/** 광기의 발작(CoC 7판) 굴림 결과 — 렌더러 lib/chat/types 의 MadnessRoll 과 동일 구조(미러). */
export interface MadnessRoll {
  mode: 'realtime' | 'summary'
  /** 실시간 발작의 광기 종류 — 일시적/장기적. 요약은 없음. */
  insanity?: 'temporary' | 'indefinite'
  roll: number
  /** 표 항목 수(1dN 의 N · 표 길이 가변). 없으면 10. */
  sides?: number
  duration: number
  unit: string
  symptom: string
}

/**
 * GM 커스텀 광기표(재구성) — 실시간은 일시적/장기적 두 표, 요약은 한 표.
 * 각 표 항목 수 가변(GM 이 가감). 미설정/빈 표면 클라 기본 7판 표 폴백. GM 설정·전원 동기화.
 */
export interface MadnessTables {
  realtimeTemp: string[]
  realtimeIndef: string[]
  summary: string[]
}

export interface ChatMessage {
  id: string
  time: number // epoch ms
  channel: ChatChannel
  kind: MessageKind
  author?: string
  /** 발화자 playerId (서버 스탬프 · 캐릭터/아바타 매칭용). system 메시지는 없음. */
  playerId?: string
  color?: string
  /** 발화 당시 두상(서버가 발화 정체성 프레즌스에서 각인) — 서버 재시작·새 참가자에도 채팅 두상 보존. */
  avatar?: string
  /** 발화 당시 이름색(서버 각인). */
  nameColor?: string
  /** 두상 풀 인덱스 — 디스크/스냅샷에서만 avatar 대신 사용(중복 제거). 런타임·증분 메시지는 avatar 인라인. */
  avatarRef?: number
  text?: string
  dice?: DiceResult
  /** 광기의 발작 카드(kind='madness'). */
  madness?: MadnessRoll
  to?: string
  /** 그룹 채널 id — channel==='group' 일 때 어느 그룹 채널인지. */
  groupId?: string
  /** 비밀 메시지(GM+본인만). 공유 히스토리에 저장하지 않음. */
  secret?: boolean
  /** GM 1회성 NPC 발화 — 투명 두상으로 렌더(아바타·캐릭터 매칭 없음). */
  npc?: boolean
  /** GM 선택지 버튼(kind='choice') — 브로드캐스트본은 option.script 제거됨. 색은 게시 시 GM 지정. */
  choice?: {
    prompt: string
    options: { id: string; label: string; script?: string }[]
    btnColor?: string
    bgColor?: string
    textColor?: string
    promptColor?: string
  }
  /** 행운 성공 전환 결과 카드(kind='luck'). */
  luck?: { cost: number; remaining: number; command: string }
  /** 수정됨 표시 — 작성자/GM 이 본문을 고치면 true. */
  edited?: boolean
  /** 삭제됨 툼스톤 — GM 이 삭제하면 true(본문 제거, "삭제된 메시지"로 렌더). */
  deleted?: boolean
}

export type Role = 'GM' | 'PL'

/** 방 참가자 (서버 권위). connected=false 면 일시 이탈(재접속 대기). */
export interface Participant {
  playerId: string
  nick: string
  color: string
  role: Role
  connected: boolean
}

/** 시트 공개 범위 (렌더러 lib/coc/types 의 Visibility 와 동일 값). */
export type Visibility = 'public' | 'private' | 'hidden'

/**
 * 멀티플레이로 공유하는 캐릭터 "프레즌스 서브셋" (시트 전체가 아님).
 * 미연시 무대·로스터·채팅 아바타 표시에 필요한 최소 정보만 — 능력치·기능 등은 비공유(본인 로컬).
 * standings(data URL)는 용량이 크므로 입장/변경 시에만 char:update 로 1회 전송,
 * 잦은 표정 전환은 char:expr(인덱스만)로 전송한다.
 */
/** 토큰 위 표시용 캐릭터 수치 (HP/MP/SAN 현재·최대). 본인 시트에서 산출해 프레즌스로 공유. */
export interface TokenStats {
  hp: number
  hpMax: number
  mp: number
  mpMax: number
  san: number
  sanMax: number
  /** 상태 이상 마커 — 본인 시트 status 에서 동기(true 일 때만 전송). */
  majorWound?: boolean
  dying?: boolean
  tempInsane?: boolean
  indefInsane?: boolean
}

/** 프로필 링크(SNS 바이오용) — 라벨 + URL. 클라 protocol 과 미러. */
export interface ProfileLink {
  label: string
  url: string
}

/** 프로필 카드 색 커스텀(SNS 바이오) — 모두 hex(미설정 시 기본). 클라 protocol 과 미러. */
export interface ProfileTheme {
  /** 강조색 — 프사 테두리·헤더 윗 띠·링크 칩. */
  accent?: string
  /** 닉네임 글자색(미설정 시 강조색). */
  nameColor?: string
  /** 자기소개 글자색. */
  bioColor?: string
  /** 카드 전체 배경색(라이트/다크 사용자 고정). */
  bg?: string
}

export interface SharedCharacter {
  playerId: string // 소유자 (서버 권위 스탬프)
  charId: string
  name: string
  color: string
  /** 이름 표시색 — 플레이어 본인이 지정. 핑 색에도 사용. 없으면 테마 기본색. */
  nameColor?: string
  headshot?: string // data URL
  standings: string[] // data URL[]
  /** 스탠딩과 index 연동된 표정별 두상(채팅 아바타). headshots[i] 비면 headshot 폴백. */
  headshots?: string[]
  currentExpression: number
  /** VN 무대 스탠딩 표시 높이(px) — 미설정이면 기본(무대 92%). 캐릭터별 동기화. */
  standingHeight?: number
  visibility: Visibility
  stats?: TokenStats // 토큰 위 HP/MP/SAN 표시용(없으면 미표시)
  /** 계정 자기소개 — 참가자 프로필 팝업 표기용(발화·캐릭터와 무관한 계정 정보). */
  bio?: string
  /** 프로필 배너(헤더 이미지, data URL) — SNS 바이오 카드용. */
  banner?: string
  /** 프로필 링크 목록 — SNS 바이오 카드용. */
  links?: ProfileLink[]
  /** 프로필 카드 색 커스텀. */
  profileTheme?: ProfileTheme
}

/** char:update 요청 — playerId 는 서버가 소켓에서 스탬프(위조 방지)하므로 클라는 제외. */
export type CharUpdateReq = Omit<SharedCharacter, 'playerId'>

/**
 * 계정 영속용 캐릭터 시트 "전체". 서버는 내용을 해석하지 않고 불투명 블롭으로 저장 —
 * 도메인 타입(능력치·기능 등)은 렌더러 lib/coc/types 소유. id 만 보장. 클라 protocol 과 미러.
 */
export interface CharacterRecord {
  id: string
  [key: string]: unknown
}

/** 핸드아웃 공개 범위: private=GM만(비공개 draft) / all=전체 / targeted=특정 유저(비밀 핸드아웃). */
export type HandoutScope = 'private' | 'all' | 'targeted'

/**
 * 핸드아웃(자료) — 방 단위 GM 자료. 이미지는 PNG/GIF/APNG 보존을 위해 원본 data URL 그대로 보관
 * (캐릭터 두상/스탠딩과 달리 WebP 재인코딩하지 않음). 가시성 판정은 서버 권위(canViewHandout).
 */
/** 핸드아웃 메인 이미지 정렬. 없으면 left. */
export type HandoutImageAlign = 'left' | 'center' | 'right'

export interface Handout {
  id: string
  title: string
  body: string
  image?: string // data URL (PNG/GIF/APNG 보존)
  imageAlign?: HandoutImageAlign // 메인 이미지 좌/우/가운데 정렬. 없으면 left.
  tags: string[]
  scope: HandoutScope
  targets: string[] // playerId[] (scope==='targeted' 일 때 대상)
  createdAt: number
  updatedAt: number
}

/** handout:upsert 요청 (GM 전용). id 없으면 신규 생성, 있으면 갱신. */
export interface HandoutUpsertReq {
  id?: string
  title: string
  body: string
  image?: string
  imageAlign?: HandoutImageAlign
  tags?: string[]
  scope: HandoutScope
  targets?: string[]
}

/** 토큰/오브젝트 레이어. bg=배경 소품(그리드 아래) · token=캐릭터/NPC 토큰 · standing=전경 스탠딩(토큰 위). */
// 렌더 순서(뒤→앞): behind(무대 뒤) < 무대 이미지 < bg(하단) < token(중간) < standing(상단).
export type TokenLayer = 'behind' | 'bg' | 'token' | 'standing'

/** 통합 레이어 토큰의 가상 맵 id — 맵세트를 넘어 모든 맵세트에 유지되는 토큰을 이 sentinel 로 라우팅. */
export const GLOBAL_MAP_ID = '__global__'

/**
 * 토큰/레이어 크기 상한(칸) — 서버 정규화·클라 리사이즈 UI·맵세트 가져오기가 공유.
 * 실제 코코포리아 방 64개(오브제·마커 2706개)를 집계하니 긴 변이 최대 235칸, 필드는 320칸까지
 * 쓰인다(128칸 초과 3.4%). 상한이 128이면 그 대형 배경 레이어들이 가져오기에서 잘려
 * 중심만 남긴 채 작아지고, 다시 내보내도 원래 크기로 복구되지 않는다 — 실측 1125개 중 157개가
 * 그렇게 어긋났다. 여유를 둬 512 로 잡는다(폭주 좌표 방어는 유지).
 */
export const MAX_TOKEN_CELLS = 512

/** z순서 조정 연산. 같은 레이어 안에서 한 칸 앞/뒤(forward/backward) 또는 맨앞/맨뒤(front/back). */
export type TokenZOp = 'front' | 'back' | 'forward' | 'backward'

/**
 * 맵 토큰/오브젝트. 위치는 월드 좌표(px). 캐릭터 토큰이면 charPlayerId 로 roster 의 두상/수치/색/이동권한을
 * 참조하고, 없으면 NPC 토큰·이미지 오브젝트(label/color/image 직접 보관). size 는 그리드 칸 배수(1=1칸).
 * layer=렌더 레이어(기본 token), z=레이어 내 정렬 순서(클수록 앞 · 서버 권위).
 */
export interface Token {
  id: string
  x: number
  y: number
  size: number
  /** 비정방 스트레치 비율(가로 칸) — w·h 둘 다 있으면 그 비율로 늘려 그림. 크기는 여전히 size(긴 변). */
  w?: number
  /** 비정방 스트레치 비율(세로 칸). */
  h?: number
  /** 회전 각도(라디안). GM·소유 PL 이 회전 가능(token:rotate). 기본 0. */
  rotation?: number
  charPlayerId?: string
  label?: string
  color?: string
  image?: string // data URL (NPC 토큰·이미지 오브젝트)
  layer?: TokenLayer
  z?: number
  /** 좌우 반전(이미지 토큰 미러 · /). 기본 false. */
  flipX?: boolean
  /** 이름표 숨김(GM 전용 토글·전원 동기화). true 면 토큰 이름 미표시. */
  hideName?: boolean
  /** UI(HP/MP/SAN 바·상태 마커) 숨김(GM 전용 토글·전원 동기화). true 면 미표시. */
  hideUI?: boolean
  /** 이동/회전 권한을 부여받은 playerId 목록(GM 지정). 이 목록의 PL 은 GM 처럼 이동·회전 가능(이미지 토큰 포함). */
  allowedPlayers?: string[]
  /** 이미지 카드: 등록된 이미지 목록(asset:ref 또는 data URL). 비면 단일 image 토큰. */
  images?: string[]
  /** 이미지 카드에서 현재 표시 중인 images 인덱스(기본 0). */
  currentIndex?: number
  /** 위치 고정 — true 면 드래그 이동 불가(크기 고정과 조합해 '배치 고정'). GM 토글·전원 동기화. */
  lockPos?: boolean
  /** 크기 고정 — true 면 크기 조정 불가. GM 토글·전원 동기화. */
  lockSize?: boolean
  /** 바닥 고정 — true 면 포인터를 통과시켜 선택/드래그되지 않음(맵 바닥). */
  terrain?: boolean
  /** 호버 메모 — 커서를 올리면 뜨는 설명 텍스트. */
  memo?: string
  /** 클릭 동작 — 선택 도구에서 클릭 시 이 텍스트를 채팅으로 전송. */
  clickAction?: string
  /** 숨김 — true 면 PL 에게 미표시(GM 은 흐리게). GM 전용 토글·전원 동기화. private 공개범위의 레거시 별칭. */
  hidden?: boolean
  /** 공개범위 — all(전체·기본)·owner(나만: 소유자+GM)·private(비공개: GM만)·others(나 외 공개). GM 은 미리보기로 항상 열람. */
  visibility?: 'all' | 'owner' | 'private' | 'others'
  /** 양면 이미지(뒷면) — 공개범위상 앞면을 못 보는 뷰어에게 대신 보여주는 이미지(카드 뒤집기). 없으면 앞면 못 보는 뷰어에겐 미표시. */
  backImage?: string
  /** 커스텀 상태바(최대 8) — 토큰에 붙는 임의 게이지. 시트 HP/MP/SAN 바와 별개. */
  bars?: TokenBar[]
  /** 상태 비공개 — true 면 상태바·수치를 소유자·GM(미리보기) 외에는 못 봄(토큰 자체는 보임). */
  statsPrivate?: boolean
  /** 가져오기 출처 태그 — 같은 맵세트 파일에서 함께 들어온 맵·통합 레이어가 공유(연동 삭제용).
   *  편집으로는 안 바뀌고, 레이어 변환·복사로 만든 새 토큰에는 없다(사용자 소유로 간주). */
  importId?: string
  /** 표시 맵 제한(통합 레이어 전용) — 있으면 이 맵들에서만 그린다. 가져오기 배치가 원래 쓰던
   *  맵을 덮지 않게 가져온 맵 id 로 한정. 없으면 종전대로 모든 맵에 표시. 편집으로는 안 바뀐다. */
  mapIds?: string[]
  /** 라이브 스탠딩 토큰 — 캐릭터(charPlayerId)의 현재 표정 스탠딩 이미지를 그린다(로스터 참조 ·
   *  표정 교체 시 즉시 반영). 레이어 이동과 무관하게 이 플래그로만 판별. */
  liveStanding?: boolean
  /** 버튼 토큰: 마우스 hover 시 hoverImage, 클릭(press) 시 pressImage 로 바꿔 보여준다(뷰어별 로컬).
   *  기본(1번) 이미지는 image/images 사용. sounds=상태 진입 시 재생할 효과음(asset ref/data URL). */
  hoverImage?: string
  pressImage?: string
  sounds?: { base?: string; hover?: string; press?: string }
}

/** 토큰 커스텀 상태바 — 이름·현재/최대·색(없으면 인덱스 팔레트). 현재값이 최대의 80% 미만이면 빨간 경고색. */
export interface TokenBar {
  id: string
  label?: string
  cur: number
  max: number
  color?: string
}

/** token:upsert 요청 (GM 전용). id 없으면 신규 생성. mapId=대상 맵. layer=배치 레이어(이미지 오브젝트). */
export interface TokenUpsertReq {
  mapId: string
  id?: string
  x: number
  y: number
  size?: number
  w?: number
  h?: number
  rotation?: number
  charPlayerId?: string
  label?: string
  color?: string
  image?: string
  layer?: TokenLayer
  flipX?: boolean
  hideName?: boolean
  hideUI?: boolean
  allowedPlayers?: string[]
  images?: string[]
  currentIndex?: number
  lockPos?: boolean
  lockSize?: boolean
  terrain?: boolean
  memo?: string
  clickAction?: string
  hidden?: boolean
  visibility?: 'all' | 'owner' | 'private' | 'others'
  backImage?: string
  bars?: TokenBar[]
  statsPrivate?: boolean
  liveStanding?: boolean
  hoverImage?: string
  pressImage?: string
  sounds?: { base?: string; hover?: string; press?: string }
}

/** token:move 요청 (GM 또는 토큰 소유 PL). 잦은 이벤트 → 위치만 전송. mapId=대상 맵. */
export interface TokenMoveReq {
  mapId: string
  id: string
  x: number
  y: number
}

/** token:rotate 요청 (GM 또는 토큰 소유 PL · 이동과 동일 권한). rotation=라디안. mapId=대상 맵. */
export interface TokenRotateReq {
  mapId: string
  id: string
  rotation: number
}

/** token:resize 요청 — 크기(칸, 긴 변)만 전송·브로드캐스트. mapId=대상 맵. 이동·회전과 동일 권한(GM 또는 소유 PL). */
export interface TokenResizeReq {
  mapId: string
  id: string
  size: number
}

/** token:reorder 요청 (GM 전용). op=z순서 조정, layer=레이어 이동(지정 시 그 레이어 맨 앞으로). mapId=대상 맵. */
export interface TokenReorderReq {
  mapId: string
  id: string
  op?: TokenZOp
  layer?: TokenLayer
}

/** token:imageindex 요청 (GM 또는 토큰 소유 PL · 이동과 동일 권한). 이미지 카드의 표시 이미지 전환. index=images 인덱스. */
export interface TokenImageIndexReq {
  mapId: string
  id: string
  index: number
}

/** 방 배경(맵별 단일 배경). 이미지는 라이브러리 자산 원본 data URL. */
export interface MapBackground {
  image?: string
  w: number // 배경 자연 크기(px) — 그리드/배치 기준
  h: number
  /** 이미지 맞춤 — contain(비율 유지·여백)·cover(비율 유지·초과분 크롭). 없으면 fill(지정 치수에 늘림·비율 무시). */
  fit?: 'fill' | 'contain' | 'cover'
}

/** 맵 바탕(최후면 배경) — 화면 전체(무대 바깥 여백 포함)를 덮는 이미지 + 블러. image 없으면 바탕 없음. */
export interface MapBackdrop {
  image?: string
  blur?: number
}

/** 맵 그리드 설정(맵 단위, GM 제어). size=셀 한 변(월드 px, 토큰 size 1=1셀), visible=선 표시. */
export interface GridConfig {
  size: number
  visible: boolean
}

/**
 * 자유 드로잉 한 획. points=월드 좌표 평탄 배열 [x0,y0,x1,y1,...].
 * playerId/color=작성자(서버 스탬프), width=선 두께(월드 px). 맵별 세션 보관.
 */
export interface Stroke {
  id: string
  playerId: string
  color: string
  width: number
  points: number[]
}

/** map:draw 요청 — 새 획. id 는 클라 생성(낙관 반영·서버 에코 멱등), color/playerId 는 서버 스탬프. */
export interface DrawReq {
  mapId: string
  id: string
  points: number[]
  width?: number
  /** 그리기 색 — 없으면 서버가 참가자색으로 스탬프. */
  color?: string
}

/**
 * 맵 텍스트 라벨(자유 텍스트). 위치는 월드 좌표(px). playerId=작성자(서버 스탬프).
 * GM 은 모든 텍스트, PL 은 본인 텍스트만 편집·이동·삭제. 맵별 세션 보관(드로잉과 동일).
 */
export interface MapText {
  id: string
  playerId: string
  x: number
  y: number
  text: string
  color: string
  size: number
  bold?: boolean
}

/** map:text 요청 — 신규(ID 없음=서버 생성) 또는 편집. playerId 는 서버 스탬프(편집은 작성자/GM 만). */
export interface MapTextUpsertReq {
  mapId: string
  id?: string
  x: number
  y: number
  text: string
  color?: string
  size?: number
  bold?: boolean
}

/** 비주얼 노벨 무대 레이어 — vnBackground(맨 뒤) 위에 층층이 쌓는 이미지. z 작을수록 뒤. */
export interface VnLayer {
  id: string
  image: string // data URL
  z: number
  opacity?: number // 0~1 (기본 1)
  fit?: 'cover' | 'contain' // cover=화면 꽉 채움(기본·배경처럼) · contain=비율 맞춤(여백)
  front?: boolean // true=스탠딩 앞(오버레이 — 비/플레어 효과), 기본 false=스탠딩 뒤
  /** 가로 오프셋 — 무대 프레임 가로의 %(-100~100 · 기본 0=중앙). */
  x?: number
  /** 세로 오프셋 — 무대 프레임 세로의 %(-100~100 · 기본 0=중앙). */
  y?: number
  /** 배율 %(20~300 · 기본 100). */
  scale?: number
}

/** 맵세트 1개 — 자체 배경·그리드·토큰·드로잉 보유. 방은 여러 맵 + 활성 맵 1개. */
export interface GameMap {
  id: string
  name: string
  background: MapBackground | null
  grid: GridConfig
  tokens: Token[]
  /** 자유 드로잉 획(맵별 세션 보관). */
  drawings: Stroke[]
  /** 맵 텍스트 라벨(맵별 세션 보관). */
  texts: MapText[]
  /** 비주얼 노벨 무대 배경 이미지(data URL) — 맵세트별. 전술 맵 배경과 별개. GM이 우클릭으로 설정. */
  vnBackground?: string
  /** 비주얼 노벨 무대 배경 흐림 강도(0~40 · 기본 0). GM 설정·전원 동기화. */
  vnBackgroundBlur?: number
  /** 비주얼 노벨 무대 레이어 스택 — vnBackground 위에 z순으로 쌓임. GM 설정·전원 동기화. */
  vnLayers?: VnLayer[]
  /** 맵 배경 단색(여백 전체 포함) — 캔버스 전체를 이 색으로 채움. hex. 없으면 투명(앱 배경). */
  bgColor?: string
  /** 맵 바탕(최후면 이미지 + 블러) — 무대 바깥 여백까지 화면 전체를 덮음. 없으면 바탕 없음. */
  backdrop?: MapBackdrop
  /** 크로스페이드 — true 면 이 맵으로 전환 시 페이드 연출. */
  crossfade?: boolean
  /** 숨긴 레이어(무대 앞 밴드·무대 뒤) — GM 설정·맵 단위 전원 동기. 없으면 전부 표시. */
  hiddenLayers?: TokenLayer[]
  /**
   * 맵세트가 번들로 기억하는 BGM 스냅샷. undefined=미저장(반영해도 방 BGM 안 건드림),
   * []=무음으로 저장(반영 시 방 BGM 정지). 저장 시 현재 방 BGM(자산 참조)을 그대로 담는다.
   */
  bgm?: BgmState[]
  /** 가져오기 출처 태그 — 이 맵을 들여온 파일 배치 id. 배치의 마지막 맵이 삭제되면 같은 태그의 통합 레이어도 클라가 함께 정리. */
  importId?: string
}

/**
 * 방 외형(테마·다이스 연출 카드) — 방 GM 이 전원에 강제(동기화). 방 단위 보관·스냅샷 포함.
 * accent/diceStyle 은 와이어에선 문자열(렌더러 union 과 디커플) — 서버가 허용값으로 검증·정규화.
 */
export interface Appearance {
  theme: 'dark' | 'light'
  accent: string
  uiAccent: string // 직접 강조색 hex ('' = accent 프리셋)
  diceStyle: string
}

/** BGM 음원 종류. file=업로드 오디오, youtube=유튜브 영상. */
export type BgmKind = 'file' | 'youtube'

/**
 * 방 BGM 재생 상태 — GM 이 제어, 전원 동기화. 방 단위 보관·스냅샷 포함.
 * src 는 file 이면 오디오 data URL, youtube 면 영상 id. 볼륨/음소거는 클라 개인(비공유).
 * 트랙 변경(소스 포함)은 bgm:state, 재생/정지·반복 토글은 경량 bgm:control 로 송출.
 * 클라 protocol 과 미러.
 */
export interface BgmState {
  trackId: string // GM 라이브러리 트랙 식별(멱등)
  kind: BgmKind
  src: string // file: 오디오 data URL · youtube: 영상 id
  title: string
  loop: boolean
  playing: boolean
  /** 트랙 믹스 볼륨(0~1 · GM 설정·동기화). 개인 마스터 볼륨과 곱해 최종 볼륨. */
  volume: number
}

/** 전투 참가자(이니셔티브). initiative 내림차순 정렬 · charPlayerId 있으면 roster 두상/색/HP 참조. */
export interface Combatant {
  id: string
  name: string
  initiative: number
  charPlayerId?: string
  hp?: number // 수동 추적(주로 NPC)
  hpMax?: number
}

/** 방 전투 상태 — GM 권위·전원 동기화. null=전투 없음. 클라 protocol 과 미러. */
export interface CombatState {
  round: number // 1부터
  turn: number // initiative 정렬 순서의 현재 턴 인덱스
  combatants: Combatant[]
}

/**
 * 그룹 채널(GM 개설) — members(+GM)에게만 보이고 전달됨. 채널 자체는 영속,
 * 메시지는 휘발(귓속말처럼 공유 히스토리 미저장). 클라 protocol 과 미러.
 */
export interface Channel {
  id: string
  name: string
  members: string[] // playerId[] (GM 은 항상 접근)
}

/** 방 전체 스냅샷 (입장/재접속 ack 로 전달). handouts 는 요청자 기준으로 필터링됨. */
/** 비주얼 카드 — 이름·이미지·음향. 채팅 말미 타이틀 또는 수동으로 전원 화면에 오버레이 재생. image 없으면 음향만. */
export interface VisualCard {
  id: string
  name: string
  image?: string
  sound?: string
  /** 음향 재생 길이(초 · 1~600). 지정 시 그 시점에 페이드아웃으로 종료, 없으면 음원 끝까지. */
  soundSec?: number
  /** 카드 표시 시간(초 · 1~600). 지정 시 그 시점에 자동 소멸, 없으면 클릭할 때까지 표시. */
  displaySec?: number
}

export interface RoomState {
  id: string
  code: string
  /** 세션방 이름·소유자 계정·카드 이미지(서버 영속 메타). */
  title: string
  ownerId: string
  cardImage?: string
  participants: Participant[]
  characters: SharedCharacter[]
  messages: ChatMessage[]
  handouts: Handout[]
  /** 방의 모든 맵세트. */
  maps: GameMap[]
  /** 전원이 보는 활성 맵 id. */
  activeMapId: string
  /** 방 외형(방 GM 강제 테마·다이스 카드). 입장 시 클라가 적용. */
  appearance: Appearance
  /** 방 BGM 트랙들(GM 제어·전원 동기화). 빈 배열=정지/없음. 최대 5개 동시재생. 입장 시 클라가 적용. */
  bgm: BgmState[]
  /** 방 전투 상태(GM 제어·전원 동기화). null=전투 없음. */
  combat: CombatState | null
  /** 그룹 채널 목록 — 수신자가 멤버이거나 GM 인 채널만 필터링됨. */
  channels: Channel[]
  /** 방 주사위 연출 카드 이미지(data URL · GM 설정 · 전원 동일) — 레벨별 연출 카드 미설정 시 공통 폴백. */
  cutInImage?: string
  /** 성공 단계별 주사위 연출 카드 — 굴림 결과 단계에 맞는 연출 카드를 우선 표시. 미설정 단계는 cutInImage 폴백. */
  cutInImages?: Partial<Record<SuccessLevel, string>>
  /** ~문장~ 행동지문 색(GM 설정·전원 동기화). 빈값이면 글자색 따름(mk-dim-color CSS 변수). */
  dimColor?: string
  /** 요청자의 이 방 캐릭터 시트 멤버십 — 이 charId 들만 방에서 보임(라이브러리에서 가져온 것). */
  charRoomIds: string[]
  /** 저장 슬롯 메타(반면 전체 명명 저장 · 최대 3). 목록 표시용 — 맵 본문 제외. */
  saveSlots?: { id: string; name: string; savedAt: number }[]
  /** 비주얼 카드 목록 — GM 등록·전원 동기화. */
  visualCards?: VisualCard[]
  /** 통합 레이어 토큰 — 맵세트를 넘어 모든 맵세트에 유지·표시. */
  globalTokens?: Token[]
  /** GM 커스텀 광기표 — 미설정이면 클라 기본 7판 표 사용. 전원 동기화. */
  madnessTables?: MadnessTables
  /** 행운 깎기(CoC7 하우스룰) 사용 여부 — GM 토글·전원 동기화. 미설정/true=사용, false=비활성. */
  luckEnabled?: boolean
  /** 일반 맵 VN 오버레이(대사창+발화자 스탠딩) 표시 — GM 토글·전원 동기화. 미설정/false=꺼짐, true=켜짐. */
  vnOverlay?: boolean
  /** 채팅 두상 풀 — messages 의 avatarRef 가 가리키는 두상 data URL 목록(스냅샷 크기 절감). */
  avatarPool?: string[]
}

/** 세션 목록 항목(room:list). 카드·메타만 — 장면/채팅 본문은 입장 시 스냅샷으로. 클라 protocol 과 미러. */
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

/** create/join 성공 시 본인 + 방 스냅샷. */
export interface JoinedRoom {
  self: Participant
  room: RoomState
}

/**
 * 방 불러오기 요청(GM 전용) — .orpg 스냅샷의 "장면" 부분을 방에 적용.
 * 참가자·채팅 로그는 라이브 상태라 복원하지 않음(맵·자료·외형·BGM 만). 클라 protocol 과 미러.
 */
export interface RoomLoadReq {
  maps: GameMap[]
  activeMapId: string
  handouts: Handout[]
  appearance: Appearance
  bgm: BgmState[]
}

/** ack 콜백 공통 형태. */
export type Ack<T> = (res: AckResult<T>) => void
export type AckResult<T> = { ok: true; data: T } | { ok: false; error: string }

export interface CreateRoomReq {
  nick: string
  color: string
  /** 세션방 이름·카드 이미지(서버 영속 메타, 선택). */
  title?: string
  cardImage?: string
}
export interface JoinRoomReq {
  code: string
  nick: string
  color: string
}
export interface ChatSendReq {
  channel: ChatChannel
  text: string
  narration?: boolean
  to?: string // 귓속말 대상 playerId (서버가 대상에게만 전달)
  groupId?: string // 그룹 채널 id (channel==='group' — 서버가 멤버에게만 전달)
  secret?: boolean // 비밀 굴림/메시지 (GM+본인만)
  script?: boolean // /desc 프로필 없는 꾸미기 스크립트(kind='script', 주사위 파싱 안 함)
  npcName?: string // GM 1회성 NPC 이름 — GM 이고 비어있지 않으면 author 로 스탬프(투명 두상). PL 은 무시.
}

/**
 * 클라가 굴린 결과(시트 주사위/광기 등)를 그대로 중계 요청 — chat:send 와 달리 서버가 재굴림하지 않고
 * dice/madness payload 를 신뢰해 그대로 브로드캐스트한다(라벨·광기표 등 서버가 재현 못하는 결과 보존).
 * author/color/playerId 는 서버가 정체성으로 스탬프(위조 방지). 라우팅·히스토리 규칙은 chat:send 와 동일.
 */
export interface ChatRollReq {
  channel: ChatChannel
  kind: 'dice' | 'madness'
  dice?: DiceResult
  madness?: MadnessRoll
  to?: string
  groupId?: string
  secret?: boolean
}

/** 핸드셰이크 시 socket.handshake.auth 로 전달. */
export interface HandshakeAuth {
  /** 세션 토큰(계정 인증). requireAuth 모드에선 필수 — 없거나 무효면 연결 거부. */
  token?: string
  /** 재접속 식별 playerId(비인증 레거시/테스트 경로). 인증 시엔 서버가 account.id 로 대체. */
  playerId?: string
}

// ===== 도트타운 광장(Plaza) — 휘발 멀티플레이 =====
/** 광장 캐릭터 방향(평면 4방향 — 좌우는 클라가 flipX 로 구분). */
export type PlazaFacing = 'down' | 'up' | 'left' | 'right'

/**
 * 광장 액터(다른 유저에게 보이는 프레즌스). 위치 권위는 셀 정수({cx,cy}) — 네트워크엔 정수만 흘러
 * 부동소수 누적·역직렬화 흔들림이 없다. look=서버 보관 CharSave(불투명 외형 레이어 맵) — 서버는
 * 해석하지 않고 중계하며, 없으면 클라가 기본 더미로 렌더한다. 클라 protocol 과 미러.
 */
export interface PlazaActor {
  playerId: string
  nick: string
  color: string
  cx: number
  cy: number
  facing: PlazaFacing
  moving: boolean
  /** 알바 중 여부 — 다른 유저 화면에 "영업 중" 점원으로 표시. */
  working: boolean
  /** 알바 중인 가게 id(working 일 때) — 그 가게 건물의 점원 자리에 표시. */
  workShopId?: string
  look: unknown
}

/** 클라→서버 이동 의도(셀 정수·고빈도). moving=걷는 중(키 떼면 false 1회). seq=클라 단조증가. 클라 protocol 과 미러. */
export interface PlazaMoveReq {
  plazaId: string
  cx: number
  cy: number
  facing: PlazaFacing
  moving: boolean
  seq: number
}

/** 서버→클라 틱(배치). moves=이번 틱 변화 액터, enter=새로 들어온 액터(외형 포함), leave=퇴장 playerId.
 *  seq=그 액터의 마지막 처리 move seq(본인 클라의 에코/거부 판별용 — 타 클라는 무시). 클라 protocol 과 미러. */
export interface PlazaTick {
  plazaId: string
  moves: { playerId: string; cx: number; cy: number; facing: PlazaFacing; moving: boolean; working: boolean; workShopId?: string; seq?: number }[]
  enter: PlazaActor[]
  leave: string[]
}

/** 광장 잡담 1건(휘발). 발신자 머리 위 말풍선 + 하단 로그 공용. 색·닉은 서버 스탬프. 클라 protocol 과 미러. */
export interface PlazaChat {
  id: string
  time: number
  playerId: string
  nick: string
  color: string
  text: string
}

/** 광장 상호작용 엔티티(상점 건물·포탈) — 정적 맵 데이터. 자기 셀이 맨해튼 radius 이내면 진입 프롬프트. 클라 protocol 과 미러. */
export interface PlazaEntity {
  id: string
  kind: 'shop' | 'job' | 'portal' | 'fishing'
  cx: number
  cy: number
  radius: number
  label: string
  /** 알바·상품 스코프 가게 id(건물형 상점) — JOB_SHOPS·상점 카탈로그와 매칭. */
  shopId?: string
  /** 건물 도트 스프라이트(assets 상대 경로) — 있으면 무대에 건물로 렌더. */
  sprite?: string
  /** 건물 발자국(진입 불가 셀 직사각형) — fx,fy=좌상단 셀, fw,fh=칸 수. 서버·클라 동일 규칙으로 이동 차단. */
  fx?: number
  fy?: number
  fw?: number
  fh?: number
  /** 점원 표시 셀(건물 그래픽 뒤) — 이 가게 알바 중 유저(없으면 기본 점원 NPC)가 서는 칸. */
  clerkCx?: number
  clerkCy?: number
}

/** 광장 부동산 빈터(20칸·정적 위치 + 점유). 비어 있으면 ownerId 없음(입주 가능), 점유 시 건물(외형 style)로 렌더.
 *  공개 렌더는 paidUntil 을 생략(사생활) — 본인 조회 응답에만 포함. 클라 protocol 과 미러. */
export interface PlazaLot {
  index: number
  fx: number
  fy: number
  fw: number
  fh: number
  cx: number
  cy: number
  ownerId?: string
  ownerNick?: string
  style?: number
  tenancy?: 'jeonse' | 'wolse'
  paidUntil?: number
  leasedAt?: number
}

/** plaza:enter 응답 — 자기 액터 + 맵 크기(셀) + 현재 광장의 다른 액터들 + 상호작용 엔티티 + 부동산 빈터. 클라 protocol 과 미러. */
export interface PlazaJoined {
  plazaId: string
  self: PlazaActor
  cols: number
  rows: number
  actors: PlazaActor[]
  entities: PlazaEntity[]
  lots: PlazaLot[]
}

// ===== 도트타운 마이룸 실시간 방문(Room Presence) — 한 마이룸에 여러 방문자가 동시에 걷는 휘발 인스턴스 =====
/** 마이룸 방문 액터(광장 액터에서 상점/알바 필드 제외). 위치 권위=셀 정수. 클라 protocol 과 미러. */
export interface RoomActor {
  playerId: string
  nick: string
  color: string
  cx: number
  cy: number
  facing: PlazaFacing
  moving: boolean
  look: unknown
}

/** 클라→서버 방문 이동 의도(셀 정수·고빈도). roomId=방문 중인 방(소유자 id). 클라 protocol 과 미러. */
export interface RoomMoveReq {
  roomId: string
  cx: number
  cy: number
  facing: PlazaFacing
  moving: boolean
  seq: number
}

/** 서버→클라 방문 틱(배치). seq=그 액터의 마지막 처리 move seq(본인 에코/거부 판별용). 클라 protocol 과 미러. */
export interface RoomTick {
  roomId: string
  moves: { playerId: string; cx: number; cy: number; facing: PlazaFacing; moving: boolean; seq?: number }[]
  enter: RoomActor[]
  leave: string[]
}

/** 방문 잡담 1건(휘발). 클라 protocol 과 미러. */
export interface RoomChat {
  id: string
  time: number
  playerId: string
  nick: string
  color: string
  text: string
}

/** roomvisit:enter 응답 — 자기 액터 + 방 격자 크기(셀) + 현재 이 방의 다른 방문자들. 클라 protocol 과 미러. */
export interface RoomJoined {
  roomId: string
  self: RoomActor
  cols: number
  rows: number
  actors: RoomActor[]
}

export interface ClientToServerEvents {
  // 커뮤니티 — 보고 있는 게시판·글의 룸으로 갈아탄다. 이전 룸은 반드시 떠난 뒤 들어간다(이중 소속 누수 방지).
  'cmty:watch': (req: { boardId?: string; postId?: string }) => void
  'cmty:unwatch': () => void
  'room:create': (req: CreateRoomReq, ack: Ack<JoinedRoom>) => void
  'room:join': (req: JoinRoomReq, ack: Ack<JoinedRoom>) => void
  'room:leave': () => void
  // 세션방 목록·관리 (서버 영속, 인증 계정 기준). setMeta/delete/duplicate/clearChat=소유자만(서버 검증).
  'room:list': (ack: Ack<RoomSummary[]>) => void
  'room:enter': (req: { roomId: string; nick: string; color: string }, ack: Ack<JoinedRoom>) => void
  // 부재 멤버 목록(GM 전용) — 입장 이력은 있으나 지금 방에 없는 계정(부재 PL 시트로 스탠딩 배치용).
  'room:absentMembers': (ack: Ack<{ playerId: string; nick: string }[]>) => void
  'room:setMeta': (req: { roomId: string; title?: string; cardImage?: string | null }, ack: Ack<RoomSummary>) => void
  'room:delete': (req: { roomId: string }, ack: Ack<{ id: string }>) => void
  // 참가자 본인이 방 멤버십에서 탈퇴('내 세션 목록'에서 제거). 소유자는 불가(삭제/유지만).
  'room:leaveMembership': (req: { roomId: string }, ack: Ack<{ id: string }>) => void
  'room:duplicate': (req: { roomId: string }, ack: Ack<RoomSummary>) => void
  'room:clearChat': (req: { roomId: string }, ack: Ack<{ id: string }>) => void
  'chat:send': (req: ChatSendReq) => void
  // 클라가 굴린 결과(시트 주사위·광기) 중계 — 서버가 정체성 스탬프·라우팅·히스토리·브로드캐스트.
  'chat:roll': (req: ChatRollReq) => void
  // 행운 성공 전환 안내 — 서버가 정체성 스탬프 후 kind='luck' 카드로 브로드캐스트(공개·히스토리).
  'chat:luck': (req: { channel: ChatChannel; cost: number; remaining: number; command: string }) => void
  // GM 선택지 — 채팅에 버튼 선택지 게시. 서버는 옵션 스크립트를 숨기고 라벨만 브로드캐스트. 색은 그대로 전달.
  'chat:choice': (req: {
    prompt: string
    options: { id: string; label: string; script?: string }[]
    btnColor?: string
    bgColor?: string
    textColor?: string
    promptColor?: string
  }) => void
  // 플레이어가 선택지 버튼 클릭 — 1회만. 서버: GM 비공개 통지 +(스크립트 있으면)본인 출력 + choice:locked.
  'choice:select': (req: { messageId: string; optionId: string }) => void
  // 보낸 채팅 수정/삭제. 수정=작성자 본인 또는 GM(텍스트 메시지만), 삭제=GM 만. 서버가 검증 후 브로드캐스트.
  'chat:edit': (req: { id: string; text: string }) => void
  'chat:delete': (req: { id: string }) => void
  // 입력 중 표시(휘발) — 타이핑 시작/정지를 방 전체에 알림(저장 안 함). channel/groupId 로 어느 탭에서 치는지 전달.
  'chat:typing': (req: { typing: boolean; channel?: ChatChannel; groupId?: string }) => void
  // 캐릭터 프레즌스 공유. playerId 는 서버가 스탬프.
  'char:update': (req: CharUpdateReq) => void
  'char:expr': (req: { index: number }) => void
  // 캐릭터 시트 영속 (인증 계정 전용). 시트 전체를 계정에 저장/삭제.
  'char:save': (req: CharacterRecord) => void
  'char:delete': (req: { id: string }) => void
  // 방별 시트 멤버십 — 내 라이브러리 시트를 이 방에 추가/제거. 서버가 charRooms 영속 + room:char:list 응답.
  'room:char:add': (req: { charId: string }) => void
  'room:char:remove': (req: { charId: string }) => void
  // GM 시트 지급 — record 를 대상 플레이어 계정으로 복사 저장 + 그 방 멤버십에 추가.
  'room:char:grant': (req: { targetPlayerId: string; record: CharacterRecord }) => void
  // GM 시트 지급 취소·빼앗기 — 대상 플레이어의 계정·방에서 해당 시트를 회수(삭제).
  'room:char:revoke': (req: { targetPlayerId: string; charId: string }) => void
  // GM 전용 시트 열람: 같은 방 참가자의 전체 시트를 읽기전용으로 요청. 서버가 GM·동일 방 검증 후 sheet:data 응답.
  'sheet:request': (req: { playerId: string }) => void
  // GM 전용 시트 편집: 대상 참가자 시트를 GM 이 수정. 서버가 GM·동일 방 검증 후 대상 계정에 저장 + sheet:push 로 대상에 반영.
  'sheet:edit': (req: { targetPlayerId: string; character: CharacterRecord }) => void
  // 추방 (GM 전용).
  'room:kick': (req: { playerId: string }) => void
  // 외형: 방 GM 이 방의 테마·다이스 카드를 전원에 강제. 서버가 방 GM 검증·정규화.
  'room:appearance': (req: Appearance) => void
  // 방 주사위 연출 카드 (GM 전용): level 지정 시 그 성공 단계 연출 카드, 없으면 공통 연출 카드. image 없으면 해제. 전원 동기화.
  'room:cutin': (req: { image?: string; level?: SuccessLevel }) => void
  // GM 전용: 맵/비주얼노벨 탭 + (있으면)지정 맵으로 강제 이동. targets 지정 시 그 플레이어들만.
  'room:view': (req: { view: 'map' | 'vn'; mapId?: string; targets?: string[] }) => void
  // 각 클라가 현재 보는 맵/뷰를 서버에 보고 — GM 위치 표시용. 서버는 GM 에게만 room:positions 로 집계 전달.
  'room:where': (req: { mapId: string; view: 'map' | 'vn' }) => void
  // GM 전용: ~문장~ 행동지문 색 설정/해제(빈값=해제). 전원 동기화.
  'room:dim': (req: { color?: string }) => void
  'room:luck': (req: { enabled: boolean }) => void
  // GM 전용: 일반 맵 VN 오버레이 표시 토글. 전원 동기화.
  'room:vnoverlay': (req: { enabled: boolean }) => void
  // GM 커스텀 광기표 설정(GM 전용) — 서버 정규화 후 전원 동기화.
  'room:madness': (req: MadnessTables) => void
  // BGM (다중, GM 전용). set=트랙 추가/로드(소스 포함·최대 5), control=해당 트랙 재생/반복/볼륨 토글, clear=한 트랙(trackId) 또는 전체 정지.
  'bgm:set': (req: {
    trackId: string
    kind: BgmKind
    src: string
    title: string
    loop: boolean
    volume?: number
  }) => void
  'bgm:control': (req: { trackId: string; playing?: boolean; loop?: boolean; volume?: number }) => void
  'bgm:clear': (req?: { trackId?: string }) => void
  // 전체 트랙을 권위적으로 교체 — '나만 듣기'→'전체 동기화' 전환 시 GM 로컬 트랙으로 방을 정확히 맞춰 혼선 제거.
  'bgm:replace': (req: { tracks: BgmState[] }) => void
  // BGM 시크 (GM 전용). 재생 위치(초)를 전원에게 점프 명령. 위치는 비영속(transient broadcast).
  'bgm:seek': (req: { trackId: string; position: number }) => void
  // 전투 (GM 전용). 전체 상태 교체(시작·턴진행·HP·종료=null). 서버가 GM 검증·정규화 후 전원 동기화.
  'combat:set': (state: CombatState | null) => void
  // 그룹 채널 (GM 전용). create=개설(이름+멤버), remove=삭제. 서버가 멤버 기준 채널 목록 동기화.
  'channel:create': (req: { name: string; members: string[] }) => void
  'channel:remove': (req: { id: string }) => void
  // 방 불러오기 (GM 전용). 서버가 검증·적용 후 전원에 room:sync 풀 재싱크.
  'room:load': (req: RoomLoadReq) => void
  // 핸드아웃 (GM 전용). 소유/권한은 서버가 검증.
  'handout:upsert': (req: HandoutUpsertReq) => void
  'handout:delete': (req: { id: string }) => void
  'handout:focus': (req: { id: string }) => void
  // 맵·토큰 — 맵 관리·배경·그리드·배치·삭제는 GM, 이동은 GM 또는 토큰 소유 PL(서버 검증).
  'map:create': (req: { name?: string }) => void
  'map:delete': (req: { mapId: string }) => void
  'map:rename': (req: { mapId: string; name: string }) => void
  'map:activate': (req: { mapId: string }) => void
  'map:background': (req: { mapId: string; bg: MapBackground | null }) => void
  /** 비주얼 노벨 무대 배경 설정/해제 (GM 전용). image 없으면 해제. */
  'map:vnbg': (req: { mapId: string; image?: string }) => void
  /** 비주얼 노벨 무대 배경 흐림 강도 (GM 전용). 0=없음, 0~40 클램프. */
  'map:vnbgblur': (req: { mapId: string; blur: number }) => void
  /** 비주얼 노벨 무대 레이어 스택 전체 교체 (GM 전용). */
  'map:vnlayers': (req: { mapId: string; layers: VnLayer[] }) => void
  /** 맵 배경 단색 설정/해제 (GM 전용 · 여백 전체). color 없으면 해제(투명). */
  'map:bgcolor': (req: { mapId: string; color?: string }) => void
  /** 맵 바탕(최후면 이미지+블러) 설정/해제 (GM 전용 · 화면 전체). backdrop null 이면 해제. */
  'map:backdrop': (req: { mapId: string; backdrop: MapBackdrop | null }) => void
  'map:grid': (req: { mapId: string; grid: GridConfig }) => void
  /** 맵세트 메타 전체 교체 (GM 전용). crossfade 를 갱신(미지정=해제). */
  'map:meta': (req: { mapId: string; crossfade?: boolean }) => void
  /** 맵 레이어 표시/숨김 전체 교체 (GM 전용) — 무대 앞 밴드·무대 뒤를 맵 단위로 전원 동기. */
  'map:layervis': (req: { mapId: string; hidden: TokenLayer[] }) => void
  /**
   * 맵세트 번들 BGM 저장/해제 (GM 전용). op='save'=현재 방 BGM 을 이 맵에 스냅샷(재업로드 없음),
   * op='clear'=번들 해제. 서버가 map:bgm 으로 결과 브로드캐스트.
   */
  'map:bgm': (req: { mapId: string; op: 'save' | 'clear' }) => void
  /** 맵세트 복제 (GM 전용). 서버가 새 맵을 만들어 map:added 로 브로드캐스트. */
  'map:duplicate': (req: { mapId: string }) => void
  'map:save': (req: { name?: string }) => void
  'map:load': (req: { slotId: string }) => void
  'map:slotdelete': (req: { slotId: string }) => void
  'card:set': (req: VisualCard) => void
  'card:delete': (req: { id: string }) => void
  'card:play': (req: { id: string }) => void
  /** 맵세트 일괄 가져오기 (GM 전용). 외부 파일에서 변환한 맵들을 서버가 생성해 map:added 로 브로드캐스트.
   *  globalTokens=동반된 통합 레이어(방 상주 패널) — z 보존을 위해 일괄 저장 후 token:state 로 브로드캐스트. */
  'map:import': (req: { maps: GameMap[]; globalTokens?: Token[] }) => void
  'token:upsert': (req: TokenUpsertReq) => void
  'token:move': (req: TokenMoveReq) => void
  'token:rotate': (req: TokenRotateReq) => void
  'token:resize': (req: TokenResizeReq) => void
  'token:imageindex': (req: TokenImageIndexReq) => void
  'token:remove': (req: { mapId: string; id: string }) => void
  'token:reorder': (req: TokenReorderReq) => void
  // 자유 드로잉·핑 — 그리기=전원, 지우개=작성자/GM, 전체 지우기=GM, 핑=전원(휘발).
  'map:draw': (req: DrawReq) => void
  'map:draw:erase': (req: { mapId: string; strokeId: string }) => void
  'map:draw:clear': (req: { mapId: string }) => void
  // 맵 텍스트 — 생성=전원, 편집/이동/삭제=작성자/GM, 전체 지우기=GM(서버 검증).
  'map:text': (req: MapTextUpsertReq) => void
  'map:text:move': (req: { mapId: string; id: string; x: number; y: number }) => void
  'map:text:remove': (req: { mapId: string; id: string }) => void
  'map:text:clear': (req: { mapId: string }) => void
  'map:ping': (req: { mapId: string; x: number; y: number; color?: string }) => void
  // ===== 도트타운 광장(Plaza) =====
  // 입장 — 서버가 빈 스폰 셀 배치 + 멤버십 등록. ack=자기 액터+맵 크기+현재 액터들.
  //   spawnAtOwnerId: 그 유저의 집 현관 앞에서 스폰(내 집=내 id·방문 복귀=방문한 집 주인 id). 그 집이 없으면 중앙.
  'plaza:enter': (req: { plazaId?: string; spawnAtOwnerId?: string }, ack: Ack<PlazaJoined>) => void
  // 퇴장(명시적). disconnect 시엔 서버가 자동 정리.
  'plaza:leave': () => void
  // 이동 의도(고빈도·셀 단위) — ack 없음. 서버가 인접·쿨다운·경계 검증 후 다음 틱 반영(거부=무시).
  'plaza:move': (req: PlazaMoveReq) => void
  // 광장 잡담 — 서버가 길이·레이트리밋·정체성 검증 후 말풍선+로그로 라우팅.
  'plaza:say': (req: { text: string }) => void
  // 이모트(머리 위 감정표현) — 서버가 화이트리스트·쿨다운 검증 후 주변에 브로드캐스트.
  'plaza:emote': (req: { emote: string }) => void
  // ===== 도트타운 마이룸 실시간 방문(Room Presence) =====
  // 입장 — roomId=방 주인 id. ack=자기 액터+방 격자 크기+현재 이 방의 다른 방문자들.
  'roomvisit:enter': (req: { roomId: string }, ack: Ack<RoomJoined>) => void
  'roomvisit:leave': () => void
  'roomvisit:move': (req: RoomMoveReq) => void
  'roomvisit:say': (req: { text: string }) => void
  'roomvisit:emote': (req: { emote: string }) => void
  // 수동 프레즌스 상태 설정(인증 계정). 계정 영속 — 재접속 후에도 유지.
  'presence:set': (req: { status: PresenceStatus }, ack?: Ack<{ status: PresenceStatus }>) => void
}

/** DM(유저 간 다이렉트 메시지) 1건. from/to=userId(=계정 id). 그룹 메시지는 to='' + threadId 스탬프. */
export interface DmMessage {
  id: string
  from: string
  /** 그룹 메시지는 '' — 구버전 클라가 자기 앞 메시지가 아니라고 판단해 자연 무시(하위호환). */
  to: string
  text: string
  createdAt: number
  /** 그룹 DM 스레드 id. 1:1 메시지에는 없음(기존 스킴 유지). */
  threadId?: string
}

/** 수동 프레즌스 상태. invisible 은 본인에게만 노출(외부엔 오프라인으로 위장). */
export type PresenceStatus = 'online' | 'away' | 'session' | 'invisible'
/** 외부에 표시되는 상태(invisible 제외). */
export type PublicPresenceStatus = 'online' | 'away' | 'session'

/** 로비 알림 종류 — comment=내 블로그 글 댓글, reply=내 댓글 답글, guestbook=홈/로비 방명록,
 *  dtguestbook=도트타운 마이룸 방명록, friend=친구 신청/수락, dm=새 다이렉트 메시지(상대별 최신 1건). */
// 커뮤니티 알림은 종류를 하나로 두고 세부는 본문에 담는다 — 이름이 갈리면 딥링크가 런타임에만 깨진다.
export type NotifKind = 'comment' | 'reply' | 'guestbook' | 'dtguestbook' | 'friend' | 'dm' | 'cmty'
/** 로비 알림 1건 — 서버 notifications 저장 항목과 동일(읽음은 서버 권위). */
export interface NotifItem {
  id: string
  kind: NotifKind
  /** 알림을 발생시킨 사람(작성 시점 스냅샷 — 탈퇴해도 표시 유지). */
  actorId: string
  actorName: string
  actorAvatar?: string
  /** 이동 대상 참조 — comment/reply=postId, dm/friend=상대 userId. */
  ref?: string
  /** 본문 발췌(서버가 길이 캡). */
  text: string
  createdAt: number
  read: boolean
}

export interface ServerToClientEvents {
  // ===== 커뮤니티 =====
  // 게시판 목록·글 상세를 보고 있는 사람에게만 간다(룸: cmtyb:<게시판>, cmtyp:<글>).
  'cmty:post': (e: { boardId: string; op: 'new' | 'update' | 'remove'; postId: string }) => void
  'cmty:comment': (e: { postId: string; op: 'new' | 'edit' | 'remove'; comment?: unknown }) => void
  // 권한이 바뀐 사람만 다시 받아야 한다(룸: acct:<계정>).
  'cmty:perm': (e: { permVersion: number }) => void
  // 테마·명칭은 공개 설정이라 커뮤니티 룸 전체로. 세션방 참가자에게 새지 않도록 전역 emit 은 쓰지 않는다.
  'cmty:theme': (e: { theme: unknown }) => void
  'cmty:labels': (e: { labels: unknown }) => void
  'room:participants': (participants: Participant[]) => void
  'chat:new': (message: ChatMessage) => void
  // 채팅 수정/삭제 브로드캐스트 — 대상자(공개 히스토리 수신자 전체)에게 반영.
  'chat:edited': (req: { id: string; text: string }) => void
  'chat:deleted': (req: { id: string }) => void
  // 채팅 로그 전체 비움(소유자가 세션 채팅 삭제 시 입장 중인 클라가 로컬 채팅도 비움).
  'chat:clear': () => void
  // 입력 중 표시(휘발) — 발신자 제외 방 전체에 브로드캐스트. playerId 서버 스탬프. channel/groupId 로 탭별 분리.
  'chat:typing': (req: { playerId: string; typing: boolean; channel: ChatChannel; groupId?: string }) => void
  // ===== DM(유저 간 다이렉트 메시지) =====
  // 새 DM 도착 — 발신자·수신자 양쪽 개인룸으로(HTTP /dm/send 가 트리거).
  'dm:new': (message: DmMessage) => void
  // DM 수정/삭제 — 발신자·수신자(그룹은 멤버 전원) 개인룸으로(HTTP /dm/edit·/dm/delete 가 트리거).
  'dm:edited': (message: DmMessage) => void
  'dm:deleted': (req: { id: string; from: string; to: string; threadId?: string }) => void
  // DM 대화 개인 삭제 — 지운 사용자의 개인룸으로만(여러 세션 동기화용. 상대에겐 보내지 않음). 그룹은 threadId(peer='').
  'dm:cleared': (req: { peer: string; by: string; threadId?: string }) => void
  // 그룹 DM 메타 변경(생성/초대/나가기/계정탈퇴) — 멤버 전원(변동 당사자 포함) 개인룸으로. 클라는 /dm/list 재조회.
  'dm:group:update': (req: { threadId: string }) => void
  // 상대 온라인/오프라인·상태 전환(전체 브로드캐스트). status 는 online=true 일 때만(구클라는 무시).
  'dm:presence': (req: { userId: string; online: boolean; status?: PublicPresenceStatus }) => void
  // 접속 직후 스냅샷(접속자에게만). statuses=온라인 중 'online' 이 아닌 항목만. self=내 실상태(invisible 포함 — 본인 UI 시드).
  'dm:presence:init': (req: { online: string[]; statuses?: Record<string, PublicPresenceStatus>; self?: PresenceStatus }) => void
  // 새 알림 도착 — 대상 개인룸(user:<id>)으로만. 읽음은 서버 권위(HTTP /notif/read).
  'notif:new': (n: NotifItem) => void
  // 관리자가 등급을 바꾸면 대상 사용자의 접속 세션에 즉시 푸시(재로그인 없이 권한 반영).
  'role:changed': (req: { role: 'admin' | 'member' | 'guest' }) => void
  // 관리자가 아이디(username)를 바꾸면 대상 사용자의 접속 세션에 즉시 푸시(재로그인 없이 표시 갱신).
  'account:renamed': (req: { username: string }) => void
  // 친구 신청/수락/거절/끊기 발생 시 대상에게 목록 재조회 신호(페이로드 없음).
  'friend:update': () => void
  // 도트타운 마이룸/캐릭터가 갱신됨 — 그 방을 방문 중인 클라가 재조회(전체 브로드캐스트, 멤버십 상태 없음).
  'dottown:updated': (req: { ownerId: string }) => void
  // 도트타운 코인 잔액 변동 — 그 계정 개인룸(user:<id>)으로만. 클라는 이 푸시로만 잔액 갱신(낙관적 갱신 금지).
  'dottown:coin': (req: { balance: number }) => void
  // 도트타운 아르바이트 상태 변동 — 개인룸. shift=null 이면 대기(idle).
  'dottown:job': (req: { shift: { shopId: string; startAt: number; endAt: number; minutes: number; hourlyWage: number } | null }) => void
  // 캐릭터 프레즌스 브로드캐스트.
  'char:state': (char: SharedCharacter) => void
  'char:expr': (msg: { playerId: string; index: number }) => void
  // 캐릭터 시트 영속 — 계정의 전체 캐릭터 목록(연결 시 + 변경 시 계정 룸에 동기화).
  'char:library': (chars: CharacterRecord[]) => void
  // 관리자가 그 계정의 캐릭터를 전부 삭제 — 클라는 로컬 라이브러리를 비운다(빈 char:library 의 '시드 재업로드'와 구분).
  'char:wiped': () => void
  // 방별 시트 멤버십 갱신 — 해당 playerId 에게 그 방의 charId 목록 전달(본인 화면 필터 갱신).
  'room:char:list': (req: { playerId: string; charIds: string[] }) => void
  // GM 전용 시트 열람: 요청 GM 에게만 대상 참가자의 전체 캐릭터 시트 목록 전달.
  'sheet:data': (req: { playerId: string; characters: CharacterRecord[] }) => void
  // GM 시트 편집 결과를 대상 본인에게 푸시 — 대상 클라가 자기 캐릭터 레코드를 병합.
  'sheet:push': (req: { character: CharacterRecord }) => void
  // 선택지 응답 잠금 — 응답한 본인에게만: 그 선택지 메시지의 버튼을 잠그고 고른 옵션 표시.
  'choice:locked': (req: { messageId: string; optionId: string }) => void
  // 초대 코드 재발급 통지 (추방 시 남은 인원에게).
  'room:code': (code: string) => void
  'room:closed': (reason: string) => void
  // 외형 브로드캐스트: 방 GM 변경 시 방 전체에 강제 적용.
  'room:appearance': (ap: Appearance) => void
  // 방 주사위 연출 카드 브로드캐스트 — GM 설정 시 전원에 동기화(level=성공 단계, 없으면 공통).
  'room:cutin': (req: { image?: string; level?: SuccessLevel }) => void
  // GM 화면 강제 이동 브로드캐스트 — 맵/비주얼노벨 탭 + (있으면)그 맵으로 전환(대상=전원 또는 지정 인원).
  'room:view': (req: { view: 'map' | 'vn'; mapId?: string }) => void
  // 각 플레이어의 현재 맵 위치·뷰 집계 — GM 에게만 전달. positions[playerId]=mapId, views[playerId]=map|vn.
  'room:positions': (req: { positions: Record<string, string>; views?: Record<string, 'map' | 'vn'> }) => void
  // ~문장~ 행동지문 색 브로드캐스트 — GM 설정 시 전원 동기화(빈값=해제).
  'room:dim': (req: { color?: string }) => void
  'room:luck': (req: { enabled: boolean }) => void
  // VN 오버레이 표시 브로드캐스트 — GM 토글 시 전원 동기화.
  'room:vnoverlay': (req: { enabled: boolean }) => void
  // GM 커스텀 광기표 브로드캐스트.
  'room:madness': (req: MadnessTables) => void
  // BGM 브로드캐스트 (다중). state=트랙 목록 전체(소스 포함·추가/제거 시), control=경량 트랙 토글(재생/반복/볼륨).
  // roomId=발신 방 표식 — 수신 클라가 자기 방 방송인지 검증(방 이동 직후 이전 방 음악이 새는 것 차단). 구클라는 무시.
  'bgm:state': (tracks: BgmState[], roomId?: string) => void
  'bgm:control': (req: { trackId: string; playing: boolean; loop: boolean; volume: number }, roomId?: string) => void
  // BGM 시크 브로드캐스트 (GM 전용). 전원의 오디오를 지정 위치(초)로 점프 — 위치는 저장 안 함(transient).
  'bgm:seek': (req: { trackId: string; position: number }, roomId?: string) => void
  // 전투 브로드캐스트 — GM 변경 시 전원에 동기화. null=전투 종료.
  'combat:state': (state: CombatState | null) => void
  // 그룹 채널 목록 — 수신자가 멤버이거나 GM 인 채널만(개설/삭제 시 갱신).
  'channel:list': (channels: Channel[]) => void
  // 방 불러오기 풀 재싱크 — 적용된 방 스냅샷(핸드아웃은 수신자 기준 필터).
  'room:sync': (room: RoomState) => void
  // 핸드아웃 브로드캐스트 (대상 필터링됨). focus = 강제 포커스(대상 화면에 모달 자동 오픈).
  'handout:state': (handout: Handout) => void
  'handout:remove': (req: { id: string }) => void
  'handout:focus': (req: { id: string }) => void
  // 맵·토큰 브로드캐스트 (방 전체). 콘텐츠는 mapId 로 대상 맵 명시.
  'map:added': (map: GameMap) => void
  'map:slots': (req: { slots: { id: string; name: string; savedAt: number }[] }) => void
  'room:cards': (req: { cards: VisualCard[] }) => void
  'room:cardplay': (req: { card: VisualCard }) => void
  'map:removed': (req: { mapId: string }) => void
  'map:renamed': (req: { mapId: string; name: string }) => void
  'map:active': (req: { mapId: string }) => void
  'map:background': (req: { mapId: string; bg: MapBackground | null }) => void
  'map:vnbg': (req: { mapId: string; image?: string }) => void
  'map:vnbgblur': (req: { mapId: string; blur: number }) => void
  'map:vnlayers': (req: { mapId: string; layers: VnLayer[] }) => void
  'map:bgcolor': (req: { mapId: string; color?: string }) => void
  'map:backdrop': (req: { mapId: string; backdrop: MapBackdrop | null }) => void
  'map:grid': (req: { mapId: string; grid: GridConfig }) => void
  'map:meta': (req: { mapId: string; crossfade?: boolean }) => void
  /** 맵 레이어 표시/숨김 갱신 브로드캐스트. hidden=숨긴 밴드 목록(빈 배열=전부 표시). */
  'map:layervis': (req: { mapId: string; hidden: TokenLayer[] }) => void
  /** 맵세트 번들 BGM 갱신 브로드캐스트. bgm=null 이면 번들 해제(미저장). */
  'map:bgm': (req: { mapId: string; bgm: BgmState[] | null }) => void
  'token:state': (req: { mapId: string; token: Token }) => void
  'token:move': (req: TokenMoveReq) => void
  'token:rotate': (req: TokenRotateReq) => void
  'token:resize': (req: TokenResizeReq) => void
  'token:imageindex': (req: TokenImageIndexReq) => void
  'token:remove': (req: { mapId: string; id: string }) => void
  // 자유 드로잉·핑 브로드캐스트 — draw=새 획(서버 스탬프), ping=휘발(저장 안 함).
  'map:draw': (req: { mapId: string; stroke: Stroke }) => void
  'map:draw:erase': (req: { mapId: string; strokeId: string }) => void
  'map:draw:clear': (req: { mapId: string }) => void
  // 맵 텍스트 브로드캐스트 — state=신규/편집(서버 스탬프), move=이동, remove=삭제, clear=전체 지우기.
  'map:text:state': (req: { mapId: string; text: MapText }) => void
  'map:text:move': (req: { mapId: string; id: string; x: number; y: number }) => void
  'map:text:remove': (req: { mapId: string; id: string }) => void
  'map:text:clear': (req: { mapId: string }) => void
  'map:ping': (req: { mapId: string; x: number; y: number; playerId: string; color: string }) => void
  // ===== 도트타운 광장(Plaza) — 휘발 멀티플레이 =====
  // 틱 배치(기본 100ms) — 이동·입장·퇴장 델타. 위치 권위는 셀 정수, 화면 보간은 클라(본인 항목은 무시).
  'plaza:tick': (req: PlazaTick) => void
  // 광장 잡담 — 발신자 머리 위 말풍선 + 하단 로그(휘발).
  'plaza:msg': (req: PlazaChat) => void
  // 이모트 브로드캐스트 — 발신자 머리 위에 잠깐 표시(휘발).
  'plaza:emote': (req: { playerId: string; emote: string }) => void
  // 부동산 빈터 상태(입주·퇴거·외형·자동퇴거 시) — 광장 룸 전체에 최신 20칸 전송.
  'plaza:lots': (req: { plazaId: string; lots: PlazaLot[] }) => void
  // ===== 도트타운 마이룸 실시간 방문(Room Presence) — 휘발 멀티플레이 =====
  'roomvisit:tick': (req: RoomTick) => void
  'roomvisit:msg': (req: RoomChat) => void
  'roomvisit:emote': (req: { playerId: string; emote: string }) => void
}

/** 소켓별 서버 보관 데이터. */
export interface SocketData {
  playerId: string
  roomId?: string
  /** 현재 입장한 광장 인스턴스 id(없으면 광장 밖). 휘발 — disconnect 시 서버가 정리. */
  plazaId?: string
  /** 현재 방문 중인 마이룸 id(=방 주인 id, 없으면 방문 아님). 휘발 — disconnect 시 서버가 정리. */
  visitRoomId?: string
  /** 커뮤니티에서 지금 소속된 소켓룸 목록. 화면을 옮길 때 통째로 갈아끼워 소속이 쌓이지 않게 한다. */
  cmtyRooms?: string[]
  /** 인증된 계정(비인증 레거시/테스트면 없음). 전역 등급 admin/member/guest. */
  account?: { id: string; username: string; role: 'admin' | 'member' | 'guest' }
}
