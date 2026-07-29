// 도트타운(확장팩) 서버 영속 — 계정당 마이룸 레이아웃 1개 + 캐릭터 외형(참조 id+tint) 1개.
// 단일 파일 영속(<dataDir>/dottown.json, 원자적 tmp→rename) — posts.ts 와 동일 패턴.
// 저장은 '메타만'(furnitureId·좌표·tint·rev) — 가구/캐릭터 PNG 는 각 클라이언트의 로컬 에셋팩(dottown://)에서
//   해석하므로 서버는 이미지를 다루지 않는다(자산 GC 무관). asset 참조가 생기는 경우에도
//   collectAssetRefs 가 자동으로 건지도록 일반 스캔으로 계약을 유지한다.
import { readFileSync, writeFileSync, mkdirSync, renameSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { collectAssetRefs as scanAssetRefs } from './assets'

// ===== 한도(작은 서버 보호) =====
const MAX_FURNITURE = 400 // 방당 배치 인스턴스 상한
const MAX_ID = 80 // 식별자(furnitureId/wallpaperId/레이어 id) 길이
const MAX_DIM = 1024 // 방 치수(gp) 상한 — 거대 방 방지
const MIN_DIM = 16 // 방 치수 하한
const MAX_LAYER_SLOTS = 24 // 캐릭터 레이어 슬롯 수 상한
const PRESET_SLOTS = 6 // 저장 슬롯 수(마이룸/캐릭터 각각)
const MAX_GUESTBOOK = 200 // 방당 방명록 보관 상한(오래된 것부터 절삭)
const MAX_GB_MSG = 300 // 방명록 글자 수 상한
const MAX_GB_NAME = 40 // 방명록 작성자 이름 길이 상한
const MAX_SOCIAL_IDS = 10_000 // likes/visitors/rewarded 배열 방어적 상한(작은 서버 보호)

/** 가구 레이어 — wall=벽면(맨 뒤), floor-back=캐릭터 뒤, floor-front=캐릭터 앞. (z=2 는 캐릭터 standing 자리) */
export type FurnitureLayer = 'wall' | 'floor-back' | 'floor-front'
export const ROOM_LAYER_ORDER: Record<FurnitureLayer, number> = { wall: 0, 'floor-back': 1, 'floor-front': 3 }
const LAYERS: FurnitureLayer[] = ['wall', 'floor-back', 'floor-front']

/** 배치된 가구 1개 — 좌표/크기는 게임픽셀(gp). image 가 아닌 furnitureId 참조만 저장. */
export interface PlacedFurniture {
  id: string
  furnitureId: string
  x: number
  y: number
  z: number
  layer: FurnitureLayer
  flipped: boolean
}
/** 방 물리 규격(게임픽셀). */
export interface RoomDimensions {
  floorW: number
  floorH: number
  wallH: number
}
// 손그림 방 배경(room/1/bg.png = 214×188)과 1:1 정합 — 벽/바닥 경계는 아트 세로 중앙(y≈94, 벽 94 + 바닥 94 = 188).
//   클라 roomLayout.ts DEFAULT_ROOM 과 동일 값(미러). 클라가 dims 를 보내면 coerceDims 가 그 값을 쓰고, 이건 미전송 폴백.
export const DEFAULT_ROOM: RoomDimensions = { floorW: 214, floorH: 94, wallH: 94 }

/** 방 전체 레이아웃(계정당 1개) — 서버 저장 단위. */
export interface RoomLayout {
  ownerId: string
  dims: RoomDimensions
  wallpaperId: string
  flooringId: string
  placed: PlacedFurniture[]
  updatedAt: number
  rev: number // 낙관적 동시성(같은 계정 다중 창)
}

/** 캐릭터 외형 — 슬롯 → { 선택 id, 틴트 hex, 위치오프셋 } + 몸·의상 사이즈. 합성 결과가 아니라 참조만. */
export interface CharSave {
  ownerId: string
  /** 몸·의상 사이즈(캐릭터 단위). 미지정=L(구버전 호환). */
  size?: 'L' | 'S'
  layers: Record<string, { id: string | null; tint?: string; offsetX?: number; offsetY?: number }>
  updatedAt: number
}

/** 저장 슬롯(프리셋) — 마이룸/캐릭터를 6칸에 스냅샷해두고 불러온다. 내용은 각각 RoomLayout/CharSave 를 그대로 담는다. */
export interface RoomPresetSlot {
  savedAt: number
  layout: RoomLayout
}
export interface CharPresetSlot {
  savedAt: number
  char: CharSave
}

/** 마이룸 방명록 글 1개(로비 방명록과 동일 형태). */
export interface RoomGuestEntry {
  id: string
  authorId: string
  authorName: string
  authorAvatar?: string
  message: string
  createdAt: number
}
/** 마이룸 소셜 상태 — 좋아요·방문·방명록. 소유주 인기 지표(서버 권위·비포터블: /me 이전에서 제외). */
export interface RoomSocial {
  ownerId: string
  likes: string[] // 좋아요 누른 고유 계정 id(토글)
  visitors: string[] // 방문한 고유 계정 id(본인 제외)
  rewarded: string[] // 좋아요 코인 보상을 이미 받은 계정 id(쌍당 1회 — 파밍 차단)
  guestbook: RoomGuestEntry[]
}
/** 방문자/소유주 관점 소셜 요약(클라 표시용). */
export interface SocialSummary {
  likes: number
  visits: number
  liked: boolean // 요청자가 좋아요를 눌렀는지
  guestbook: RoomGuestEntry[]
}

export type RoomSaveResult =
  | { ok: true; layout: RoomLayout }
  | { ok: false; error: string; layout?: RoomLayout } // 충돌 시 현재 서버본 동봉

export interface DottownStore {
  /** 대상 계정의 방 레이아웃(없으면 null). */
  getRoom(userId: string): RoomLayout | null
  /** 방 저장(소유자) — rev 일치 시에만 반영(불일치=충돌). 성공 시 rev 증가된 레이아웃 반환. */
  saveRoom(ownerId: string, input: unknown): RoomSaveResult
  /** 대상 계정의 캐릭터 외형(없으면 null). */
  getChar(userId: string): CharSave | null
  /** 캐릭터 외형 저장(소유자). */
  saveChar(ownerId: string, input: unknown): { ok: boolean; char?: CharSave }
  /** 대상 계정의 도트타운 표시 닉네임(없으면 ''). */
  getNick(userId: string): string
  /** 도트타운 표시 닉네임 저장(소유자) — 빈 값이면 해제(계정 닉네임 폴백). 정규화된 닉 반환. */
  setNick(ownerId: string, input: unknown): { ok: boolean; nick: string }

  // ===== 저장 슬롯(마이룸/캐릭터 프리셋 각 6개) =====
  /** 마이룸 프리셋 6칸(빈 칸=null). */
  listRoomPresets(userId: string): (RoomPresetSlot | null)[]
  /** 마이룸 프리셋 저장(현재 방 스냅샷). slot 0..5. */
  saveRoomPreset(userId: string, slot: number, input: unknown): { ok: boolean; presets?: (RoomPresetSlot | null)[]; error?: string }
  /** 마이룸 프리셋 삭제. */
  deleteRoomPreset(userId: string, slot: number): { ok: boolean; presets?: (RoomPresetSlot | null)[]; error?: string }
  /** 캐릭터 프리셋 6칸(빈 칸=null). */
  listCharPresets(userId: string): (CharPresetSlot | null)[]
  /** 캐릭터 프리셋 저장(현재 외형 스냅샷). slot 0..5. */
  saveCharPreset(userId: string, slot: number, input: unknown): { ok: boolean; presets?: (CharPresetSlot | null)[]; error?: string }
  /** 캐릭터 프리셋 삭제. */
  deleteCharPreset(userId: string, slot: number): { ok: boolean; presets?: (CharPresetSlot | null)[]; error?: string }

  /** 계정 탈퇴 연쇄 — 그 계정의 방·캐릭터 제거. */
  removeAll(userId: string): void
  /** 자산 GC 라이브 집합 수집(현재는 메타만이라 보통 비지만, 미래 asset 참조 대비 일반 스캔). */
  collectAssetRefs(into: Set<string>): void
  /** 관리자 용량 산출 — 그 계정의 방+캐릭터 직렬화 바이트 + 참조 자산. */
  usageFor(userId: string): { bytes: number; refs: Set<string> }
  /** 멤버 본인 이전(내보내기) — 그 계정의 방·캐릭터·저장 슬롯 깊은 복사. */
  exportFor(userId: string): {
    room: RoomLayout | null
    char: CharSave | null
    nick: string | null
    roomPresets: (RoomPresetSlot | null)[]
    charPresets: (CharPresetSlot | null)[]
  }
  /** 멤버 본인 이전(가져오기) — 내보낸 방·캐릭터를 이 계정 소유로 복원. */
  importFor(userId: string, data: unknown): void

  // ===== 소셜(좋아요·방문·방명록·인기) =====
  /** 소유주 관점 요약(내가 받은 좋아요·방문·방명록). */
  ownSocial(userId: string): SocialSummary
  /** 방문 기록(고유 계정, 본인 제외) + 방문자 관점 요약. */
  recordVisit(ownerId: string, visitorId: string): SocialSummary
  /** 좋아요 토글(본인 방 불가). reward=이 계정의 최초 좋아요라 코인 보상 대상(쌍당 1회). */
  toggleLike(ownerId: string, likerId: string): { ok: boolean; liked: boolean; likes: number; reward: boolean; error?: string }
  /** 방명록 남기기(방문자). */
  addGuest(
    ownerId: string,
    author: { id: string; name: string; avatar?: string },
    message: string
  ): { ok: boolean; guestbook?: RoomGuestEntry[]; error?: string }
  /** 방명록 삭제(방 주인 또는 작성자만). */
  removeGuest(ownerId: string, requesterId: string, entryId: string): { ok: boolean; guestbook?: RoomGuestEntry[]; error?: string }
  /** 인기 마이룸 랭킹(좋아요 우선, 방문수 차순). */
  topRooms(limit: number): Array<{ ownerId: string; likes: number; visits: number }>
}

interface PersistShape {
  rooms: Record<string, RoomLayout>
  chars: Record<string, CharSave>
  social?: Record<string, RoomSocial>
  roomPresets?: Record<string, (RoomPresetSlot | null)[]>
  charPresets?: Record<string, (CharPresetSlot | null)[]>
  nicks?: Record<string, string>
}

/** 도트타운 표시 닉네임 정규화 — 공백 정리·길이 컷·개행 제거. 빈 문자열이면 폴백(계정 닉네임) 사용. */
const NICK_MAX = 16
export function sanitizeNick(v: unknown): string {
  if (typeof v !== 'string') return ''
  return v.replace(/\s+/g, ' ').trim().slice(0, NICK_MAX)
}

// ===== 검증 헬퍼(방어적 — 클라 입력을 신뢰하지 않음) =====
function clampInt(v: unknown, min: number, max: number, dflt: number): number {
  const n = typeof v === 'number' && Number.isFinite(v) ? Math.round(v) : dflt
  return Math.max(min, Math.min(max, n))
}
function str(v: unknown, max: number): string {
  return typeof v === 'string' ? v.slice(0, max) : ''
}
function isHex(v: unknown): v is string {
  return typeof v === 'string' && /^#[0-9a-fA-F]{3,8}$/.test(v)
}
function coerceDims(v: unknown): RoomDimensions {
  const o = v && typeof v === 'object' ? (v as Record<string, unknown>) : {}
  return {
    floorW: clampInt(o.floorW, MIN_DIM, MAX_DIM, DEFAULT_ROOM.floorW),
    floorH: clampInt(o.floorH, MIN_DIM, MAX_DIM, DEFAULT_ROOM.floorH),
    wallH: clampInt(o.wallH, 0, MAX_DIM, DEFAULT_ROOM.wallH)
  }
}
function coercePlaced(v: unknown, dims: RoomDimensions): PlacedFurniture[] {
  if (!Array.isArray(v)) return []
  const out: PlacedFurniture[] = []
  const maxY = dims.wallH + dims.floorH
  for (const raw of v) {
    if (out.length >= MAX_FURNITURE) break
    if (!raw || typeof raw !== 'object') continue
    const o = raw as Record<string, unknown>
    const furnitureId = str(o.furnitureId, MAX_ID)
    if (!furnitureId) continue
    const layer: FurnitureLayer = LAYERS.includes(o.layer as FurnitureLayer) ? (o.layer as FurnitureLayer) : 'floor-back'
    out.push({
      id: typeof o.id === 'string' && /^[\w-]{1,64}$/.test(o.id) ? o.id : randomUUID(),
      furnitureId,
      x: clampInt(o.x, 0, dims.floorW, 0),
      y: clampInt(o.y, 0, maxY, 0),
      z: clampInt(o.z, -100000, 100000, 0),
      layer,
      flipped: o.flipped === true
    })
  }
  return out
}
function coerceLayout(ownerId: string, input: unknown): Omit<RoomLayout, 'updatedAt' | 'rev'> & { rev?: unknown } {
  const o = input && typeof input === 'object' ? (input as Record<string, unknown>) : {}
  const dims = coerceDims(o.dims)
  return {
    ownerId,
    dims,
    wallpaperId: str(o.wallpaperId, MAX_ID),
    flooringId: str(o.flooringId, MAX_ID),
    placed: coercePlaced(o.placed, dims),
    rev: o.rev
  }
}
/** 부위 위치 오프셋 정규화 — 유한 정수, ±24px 로 클램프(픽셀 캔버스 안쪽 미세조정). 없으면 undefined. */
function coerceOffset(v: unknown): number | undefined {
  if (typeof v !== 'number' || !Number.isFinite(v)) return undefined
  const n = Math.round(v)
  if (n === 0) return undefined
  return Math.max(-24, Math.min(24, n))
}
function coerceChar(ownerId: string, input: unknown): CharSave {
  const o = input && typeof input === 'object' ? (input as Record<string, unknown>) : {}
  const inLayers = o.layers && typeof o.layers === 'object' ? (o.layers as Record<string, unknown>) : {}
  const layers: Record<string, { id: string | null; tint?: string; offsetX?: number; offsetY?: number }> = {}
  let n = 0
  for (const [slot, val] of Object.entries(inLayers)) {
    if (n >= MAX_LAYER_SLOTS) break
    const key = str(slot, MAX_ID)
    if (!key || !val || typeof val !== 'object') continue
    const lv = val as Record<string, unknown>
    const id = typeof lv.id === 'string' ? lv.id.slice(0, MAX_ID) : null
    const tint = isHex(lv.tint) ? lv.tint : undefined
    const offsetX = coerceOffset(lv.offsetX)
    const offsetY = coerceOffset(lv.offsetY)
    layers[key] = {
      id,
      ...(tint ? { tint } : {}),
      ...(offsetX !== undefined ? { offsetX } : {}),
      ...(offsetY !== undefined ? { offsetY } : {})
    }
    n++
  }
  const size = o.size === 'S' ? 'S' : o.size === 'L' ? 'L' : undefined
  return { ownerId, ...(size ? { size } : {}), layers, updatedAt: Date.now() }
}
/** 디스크에서 읽은 소셜 맵 방어적 정규화(배열/길이 보장). */
function coerceSocialMap(v: unknown): Record<string, RoomSocial> {
  const out: Record<string, RoomSocial> = {}
  if (!v || typeof v !== 'object') return out
  const idList = (x: unknown): string[] =>
    Array.isArray(x) ? (x.filter((s) => typeof s === 'string') as string[]).slice(0, MAX_SOCIAL_IDS) : []
  for (const [k, raw] of Object.entries(v as Record<string, unknown>)) {
    if (!raw || typeof raw !== 'object') continue
    const o = raw as Record<string, unknown>
    const gb: RoomGuestEntry[] = Array.isArray(o.guestbook)
      ? (o.guestbook as unknown[])
          .filter((e): e is Record<string, unknown> => !!e && typeof e === 'object')
          .map((g) => ({
            id: typeof g.id === 'string' ? g.id : randomUUID(),
            authorId: typeof g.authorId === 'string' ? g.authorId : '',
            authorName: typeof g.authorName === 'string' ? g.authorName.slice(0, MAX_GB_NAME) : '사용자',
            authorAvatar: typeof g.authorAvatar === 'string' ? g.authorAvatar : undefined,
            message: typeof g.message === 'string' ? g.message.slice(0, MAX_GB_MSG) : '',
            createdAt: typeof g.createdAt === 'number' ? g.createdAt : 0
          }))
          .slice(-MAX_GUESTBOOK)
      : []
    out[k] = { ownerId: k, likes: idList(o.likes), visitors: idList(o.visitors), rewarded: idList(o.rewarded), guestbook: gb }
  }
  return out
}

/** 슬롯 번호 검증(0..PRESET_SLOTS-1) — 그 외는 -1. */
function slotIdx(v: unknown): number {
  const n = typeof v === 'number' && Number.isInteger(v) ? v : -1
  return n >= 0 && n < PRESET_SLOTS ? n : -1
}
/** 방 프리셋 저장용 정규화 — coerceLayout 로 방어 + rev 0(프리셋은 낙관적 동시성 무관). */
function toPresetLayout(userId: string, input: unknown): RoomLayout {
  const draft = coerceLayout(userId, input)
  return {
    ownerId: userId,
    dims: draft.dims,
    wallpaperId: draft.wallpaperId,
    flooringId: draft.flooringId,
    placed: draft.placed,
    updatedAt: Date.now(),
    rev: 0
  }
}
/** 디스크에서 읽은 방 프리셋 맵 방어적 정규화(6칸·내용 coerce). */
function coerceRoomPresets(v: unknown): Record<string, (RoomPresetSlot | null)[]> {
  const out: Record<string, (RoomPresetSlot | null)[]> = {}
  if (!v || typeof v !== 'object') return out
  for (const [k, raw] of Object.entries(v as Record<string, unknown>)) {
    if (!Array.isArray(raw)) continue
    const arr: (RoomPresetSlot | null)[] = []
    for (let i = 0; i < PRESET_SLOTS; i++) {
      const s = raw[i]
      if (s && typeof s === 'object' && (s as Record<string, unknown>).layout) {
        const o = s as Record<string, unknown>
        arr.push({ savedAt: typeof o.savedAt === 'number' ? o.savedAt : 0, layout: toPresetLayout(k, o.layout) })
      } else arr.push(null)
    }
    out[k] = arr
  }
  return out
}
/** 디스크에서 읽은 캐릭터 프리셋 맵 방어적 정규화(6칸·내용 coerce). */
function coerceCharPresets(v: unknown): Record<string, (CharPresetSlot | null)[]> {
  const out: Record<string, (CharPresetSlot | null)[]> = {}
  if (!v || typeof v !== 'object') return out
  for (const [k, raw] of Object.entries(v as Record<string, unknown>)) {
    if (!Array.isArray(raw)) continue
    const arr: (CharPresetSlot | null)[] = []
    for (let i = 0; i < PRESET_SLOTS; i++) {
      const s = raw[i]
      if (s && typeof s === 'object' && (s as Record<string, unknown>).char) {
        const o = s as Record<string, unknown>
        arr.push({ savedAt: typeof o.savedAt === 'number' ? o.savedAt : 0, char: coerceChar(k, o.char) })
      } else arr.push(null)
    }
    out[k] = arr
  }
  return out
}

/** persist:false 면 인메모리(테스트). dataDir 기본 = <cwd>/data. */
export function createDottownStore(opts?: { dataDir?: string; persist?: boolean }): DottownStore {
  const persist = opts?.persist !== false
  const dataDir = opts?.dataDir ?? join(process.cwd(), 'data')
  const filePath = join(dataDir, 'dottown.json')

  let rooms: Record<string, RoomLayout> = {}
  let chars: Record<string, CharSave> = {}
  let social: Record<string, RoomSocial> = {}
  let roomPresets: Record<string, (RoomPresetSlot | null)[]> = {}
  let charPresets: Record<string, (CharPresetSlot | null)[]> = {}
  const nicks: Record<string, string> = {} // 계정 → 도트타운 표시 닉네임(광장/방 아바타 라벨). 빈 값이면 계정 닉네임으로 폴백.

  if (persist) {
    try {
      if (existsSync(filePath)) {
        const data = JSON.parse(readFileSync(filePath, 'utf8')) as PersistShape
        if (data.rooms && typeof data.rooms === 'object') rooms = data.rooms
        if (data.chars && typeof data.chars === 'object') chars = data.chars
        social = coerceSocialMap(data.social)
        roomPresets = coerceRoomPresets(data.roomPresets)
        charPresets = coerceCharPresets(data.charPresets)
        if (data.nicks && typeof data.nicks === 'object') {
          for (const [k, v] of Object.entries(data.nicks)) {
            const n = sanitizeNick(v)
            if (n) nicks[k] = n
          }
        }
      }
    } catch (e) {
      console.error('[dottown] dottown.json 로드 실패 — 빈 상태로 시작:', e)
    }
  }

  function save(): void {
    if (!persist) return
    try {
      mkdirSync(dataDir, { recursive: true })
      const tmp = filePath + '.tmp'
      writeFileSync(tmp, JSON.stringify({ rooms, chars, social, roomPresets, charPresets, nicks }), 'utf8')
      renameSync(tmp, filePath)
    } catch (e) {
      console.error('[dottown] 저장 실패:', e)
    }
  }

  /** 프리셋 6칸 읽기(복제본 — 외부 변형 방지). */
  function readRoomPresets(userId: string): (RoomPresetSlot | null)[] {
    const arr = roomPresets[userId]
    const out: (RoomPresetSlot | null)[] = []
    for (let i = 0; i < PRESET_SLOTS; i++) {
      const s = arr?.[i]
      out.push(s ? { savedAt: s.savedAt, layout: { ...s.layout, dims: { ...s.layout.dims }, placed: s.layout.placed.map((p) => ({ ...p })) } } : null)
    }
    return out
  }
  function readCharPresets(userId: string): (CharPresetSlot | null)[] {
    const arr = charPresets[userId]
    const out: (CharPresetSlot | null)[] = []
    for (let i = 0; i < PRESET_SLOTS; i++) {
      const s = arr?.[i]
      out.push(s ? { savedAt: s.savedAt, char: { ...s.char, layers: structuredClone(s.char.layers) } } : null)
    }
    return out
  }
  function ensureRoomPresetArr(userId: string): (RoomPresetSlot | null)[] {
    let arr = roomPresets[userId]
    if (!arr) {
      arr = new Array(PRESET_SLOTS).fill(null)
      roomPresets[userId] = arr
    }
    return arr
  }
  function ensureCharPresetArr(userId: string): (CharPresetSlot | null)[] {
    let arr = charPresets[userId]
    if (!arr) {
      arr = new Array(PRESET_SLOTS).fill(null)
      charPresets[userId] = arr
    }
    return arr
  }

  /** 소유주의 소셜 레코드(없으면 생성) — 변경(쓰기) 메서드에서만 사용. */
  function socialOf(ownerId: string): RoomSocial {
    let s = social[ownerId]
    if (!s) {
      s = { ownerId, likes: [], visitors: [], rewarded: [], guestbook: [] }
      social[ownerId] = s
    }
    return s
  }
  /** 소셜 요약(읽기 전용 — 미존재 시 빈 요약). viewerId 가 좋아요 목록에 있으면 liked=true. */
  function summarize(s: RoomSocial | undefined, viewerId: string): SocialSummary {
    return {
      likes: s ? s.likes.length : 0,
      visits: s ? s.visitors.length : 0,
      liked: !!s && !!viewerId && s.likes.includes(viewerId),
      guestbook: s ? s.guestbook.map((e) => ({ ...e })) : []
    }
  }

  return {
    getRoom(userId) {
      return (userId && rooms[userId]) || null
    },

    saveRoom(ownerId, input) {
      if (!ownerId) return { ok: false, error: '로그인이 필요합니다.' }
      const draft = coerceLayout(ownerId, input)
      const prev = rooms[ownerId]
      // 낙관적 동시성 — 기존 방이 있으면 클라가 보낸 rev 가 서버 rev 와 일치해야 함(다른 창에서 먼저 저장 시 충돌).
      const sentRev = typeof draft.rev === 'number' ? draft.rev : 0
      if (prev && prev.rev !== sentRev) {
        return { ok: false, error: '다른 곳에서 먼저 수정됐어요. 새로고침 후 다시 저장해 주세요.', layout: prev }
      }
      const layout: RoomLayout = {
        ownerId,
        dims: draft.dims,
        wallpaperId: draft.wallpaperId,
        flooringId: draft.flooringId,
        placed: draft.placed,
        updatedAt: Date.now(),
        rev: (prev?.rev ?? 0) + 1
      }
      rooms[ownerId] = layout
      save()
      return { ok: true, layout }
    },

    getChar(userId) {
      return (userId && chars[userId]) || null
    },

    saveChar(ownerId, input) {
      if (!ownerId) return { ok: false }
      const char = coerceChar(ownerId, input)
      chars[ownerId] = char
      save()
      return { ok: true, char }
    },

    getNick(userId) {
      return (userId && nicks[userId]) || ''
    },

    setNick(ownerId, input) {
      if (!ownerId) return { ok: false, nick: '' }
      const nick = sanitizeNick(input)
      if (nick) nicks[ownerId] = nick
      else delete nicks[ownerId] // 빈 값 = 해제 → 계정 닉네임 폴백
      save()
      return { ok: true, nick }
    },

    // ===== 저장 슬롯 =====
    listRoomPresets(userId) {
      return userId ? readRoomPresets(userId) : []
    },
    saveRoomPreset(userId, slot, input) {
      if (!userId) return { ok: false, error: '로그인이 필요합니다.' }
      const i = slotIdx(slot)
      if (i < 0) return { ok: false, error: '잘못된 슬롯이에요.' }
      ensureRoomPresetArr(userId)[i] = { savedAt: Date.now(), layout: toPresetLayout(userId, input) }
      save()
      return { ok: true, presets: readRoomPresets(userId) }
    },
    deleteRoomPreset(userId, slot) {
      if (!userId) return { ok: false, error: '로그인이 필요합니다.' }
      const i = slotIdx(slot)
      if (i < 0) return { ok: false, error: '잘못된 슬롯이에요.' }
      const arr = roomPresets[userId]
      if (arr && arr[i]) {
        arr[i] = null
        save()
      }
      return { ok: true, presets: readRoomPresets(userId) }
    },
    listCharPresets(userId) {
      return userId ? readCharPresets(userId) : []
    },
    saveCharPreset(userId, slot, input) {
      if (!userId) return { ok: false, error: '로그인이 필요합니다.' }
      const i = slotIdx(slot)
      if (i < 0) return { ok: false, error: '잘못된 슬롯이에요.' }
      ensureCharPresetArr(userId)[i] = { savedAt: Date.now(), char: coerceChar(userId, input) }
      save()
      return { ok: true, presets: readCharPresets(userId) }
    },
    deleteCharPreset(userId, slot) {
      if (!userId) return { ok: false, error: '로그인이 필요합니다.' }
      const i = slotIdx(slot)
      if (i < 0) return { ok: false, error: '잘못된 슬롯이에요.' }
      const arr = charPresets[userId]
      if (arr && arr[i]) {
        arr[i] = null
        save()
      }
      return { ok: true, presets: readCharPresets(userId) }
    },

    removeAll(userId) {
      if (!userId) return
      let changed = false
      if (rooms[userId]) {
        delete rooms[userId]
        changed = true
      }
      if (chars[userId]) {
        delete chars[userId]
        changed = true
      }
      if (social[userId]) {
        delete social[userId]
        changed = true
      }
      if (roomPresets[userId]) {
        delete roomPresets[userId]
        changed = true
      }
      if (charPresets[userId]) {
        delete charPresets[userId]
        changed = true
      }
      if (nicks[userId]) {
        delete nicks[userId]
        changed = true
      }
      // 다른 방들에 남은 이 계정의 흔적(좋아요·방문·보상·작성한 방명록) 제거.
      for (const s of Object.values(social)) {
        const before = s.likes.length + s.visitors.length + s.rewarded.length + s.guestbook.length
        s.likes = s.likes.filter((id) => id !== userId)
        s.visitors = s.visitors.filter((id) => id !== userId)
        s.rewarded = s.rewarded.filter((id) => id !== userId)
        s.guestbook = s.guestbook.filter((e) => e.authorId !== userId)
        if (s.likes.length + s.visitors.length + s.rewarded.length + s.guestbook.length !== before) changed = true
      }
      if (changed) save()
    },

    collectAssetRefs(into) {
      scanAssetRefs(JSON.stringify({ rooms, chars, social }), into)
    },

    usageFor(userId) {
      const soc = social[userId]
      // 방명록의 authorAvatar 는 '방문자'(타인)의 자산 참조 — 소유주 용량/자산으로 오귀속하지 않도록 제외.
      const socialForUsage = soc
        ? {
            ...soc,
            guestbook: soc.guestbook.map((e) => ({
              id: e.id,
              authorId: e.authorId,
              authorName: e.authorName,
              message: e.message,
              createdAt: e.createdAt
            }))
          }
        : null
      const payload = {
        room: rooms[userId] ?? null,
        char: chars[userId] ?? null,
        social: socialForUsage,
        roomPresets: roomPresets[userId] ?? null,
        charPresets: charPresets[userId] ?? null
      }
      const json = JSON.stringify(payload)
      const refs = new Set<string>()
      scanAssetRefs(json, refs)
      return { bytes: Buffer.byteLength(json, 'utf8'), refs }
    },

    exportFor(userId) {
      const room = rooms[userId]
      const char = chars[userId]
      return {
        room: room ? { ...room, dims: { ...room.dims }, placed: room.placed.map((p) => ({ ...p })) } : null,
        char: char ? { ...char, layers: structuredClone(char.layers) } : null,
        nick: nicks[userId] ?? null,
        roomPresets: readRoomPresets(userId),
        charPresets: readCharPresets(userId)
      }
    },

    importFor(userId, data) {
      if (!userId || !data || typeof data !== 'object') return
      const o = data as Record<string, unknown>
      let changed = false
      if (o.room && typeof o.room === 'object') {
        const draft = coerceLayout(userId, o.room)
        rooms[userId] = {
          ownerId: userId,
          dims: draft.dims,
          wallpaperId: draft.wallpaperId,
          flooringId: draft.flooringId,
          placed: draft.placed,
          updatedAt: Date.now(),
          rev: (rooms[userId]?.rev ?? 0) + 1 // 가져오기는 항상 새 rev(기존 창의 낙관적 저장과 충돌 회피)
        }
        changed = true
      }
      if (o.char && typeof o.char === 'object') {
        chars[userId] = coerceChar(userId, o.char)
        changed = true
      }
      if (typeof o.nick === 'string') {
        const n = sanitizeNick(o.nick)
        if (n) nicks[userId] = n
        else delete nicks[userId]
        changed = true
      }
      // 저장 슬롯도 이전 대상 — 본인 데이터라 복원(coerce 로 방어).
      if (Array.isArray(o.roomPresets)) {
        roomPresets[userId] = coerceRoomPresets({ [userId]: o.roomPresets })[userId] ?? new Array(PRESET_SLOTS).fill(null)
        changed = true
      }
      if (Array.isArray(o.charPresets)) {
        charPresets[userId] = coerceCharPresets({ [userId]: o.charPresets })[userId] ?? new Array(PRESET_SLOTS).fill(null)
        changed = true
      }
      if (changed) save()
      // 소셜(좋아요·방문·방명록)은 타인의 행위라 이전 대상이 아님 — 의도적으로 복원하지 않음(위조 방지).
    },

    // ===== 소셜 =====
    ownSocial(userId) {
      return summarize(social[userId], '')
    },

    recordVisit(ownerId, visitorId) {
      if (!ownerId) return summarize(undefined, visitorId)
      // 본인 방문·비로그인은 카운트하지 않음(요약만 반환, 레코드 생성 안 함).
      if (!visitorId || visitorId === ownerId) return summarize(social[ownerId], visitorId)
      const s = socialOf(ownerId)
      if (!s.visitors.includes(visitorId)) {
        if (s.visitors.length < MAX_SOCIAL_IDS) s.visitors.push(visitorId)
        save()
      }
      return summarize(s, visitorId)
    },

    toggleLike(ownerId, likerId) {
      if (!ownerId || !likerId) return { ok: false, liked: false, likes: 0, reward: false, error: '대상이 필요합니다.' }
      if (ownerId === likerId) {
        return { ok: false, liked: false, likes: social[ownerId]?.likes.length ?? 0, reward: false, error: '내 방에는 좋아요를 누를 수 없어요.' }
      }
      const s = socialOf(ownerId)
      const i = s.likes.indexOf(likerId)
      let liked: boolean
      let reward = false
      if (i >= 0) {
        s.likes.splice(i, 1)
        liked = false
      } else if (s.likes.length < MAX_SOCIAL_IDS) {
        s.likes.push(likerId)
        liked = true
        // 코인 보상은 (소유주, 좋아요누른이) 쌍당 최초 1회 — 껐다 켜기 파밍 차단.
        if (!s.rewarded.includes(likerId)) {
          if (s.rewarded.length < MAX_SOCIAL_IDS) s.rewarded.push(likerId)
          reward = true
        }
      } else {
        liked = false // 상한 도달 — 좋아요 미기록(보상도 없음, liked 표시도 실제 기록과 일치)
      }
      save()
      return { ok: true, liked, likes: s.likes.length, reward }
    },

    addGuest(ownerId, author, message) {
      if (!ownerId || !author?.id) return { ok: false, error: '대상이 필요합니다.' }
      const msg = (typeof message === 'string' ? message : '').trim().slice(0, MAX_GB_MSG)
      if (!msg) return { ok: false, error: '내용을 입력하세요.' }
      const s = socialOf(ownerId)
      const entry: RoomGuestEntry = {
        id: randomUUID(),
        authorId: author.id,
        authorName: (author.name || '사용자').slice(0, MAX_GB_NAME),
        authorAvatar: typeof author.avatar === 'string' ? author.avatar : undefined,
        message: msg,
        createdAt: Date.now()
      }
      s.guestbook.push(entry)
      if (s.guestbook.length > MAX_GUESTBOOK) s.guestbook = s.guestbook.slice(s.guestbook.length - MAX_GUESTBOOK)
      save()
      return { ok: true, guestbook: s.guestbook.map((e) => ({ ...e })) }
    },

    removeGuest(ownerId, requesterId, entryId) {
      const s = social[ownerId]
      if (!s) return { ok: true, guestbook: [] }
      const entry = s.guestbook.find((e) => e.id === entryId)
      if (!entry) return { ok: true, guestbook: s.guestbook.map((e) => ({ ...e })) } // 이미 없음 — 멱등
      // 방 주인(대상=요청자) 또는 작성자만 삭제 가능.
      if (requesterId !== ownerId && requesterId !== entry.authorId) return { ok: false, error: '삭제 권한이 없습니다.' }
      s.guestbook = s.guestbook.filter((e) => e.id !== entryId)
      save()
      return { ok: true, guestbook: s.guestbook.map((e) => ({ ...e })) }
    },

    topRooms(limit) {
      const n = Math.max(1, Math.min(100, Math.floor(limit) || 10))
      return Object.values(social)
        .map((s) => ({ ownerId: s.ownerId, likes: s.likes.length, visits: s.visitors.length }))
        .filter((r) => r.likes > 0 || r.visits > 0)
        .sort((a, b) => b.likes - a.likes || b.visits - a.visits)
        .slice(0, n)
    }
  }
}
