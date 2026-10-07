// 도트타운 UGC 마켓 — 유저 제작 가구/의상을 코인으로 사고판다(창작 경제).
// 이미지는 자산 스토어(asset:<sha256>)에 올라가고, 마켓은 '메타 + 파일 해시 맵'만 보관한다.
// ⚠자산 GC: 등록/보유 아이템의 파일 해시를 collectAssetRefs 로 라이브셋에 반드시 실어야 한다(안 그러면 최대 6시간 뒤 회수).
// 소유는 '스냅샷'(구매 시점의 파일 맵 복사)이라 판매자가 등록을 내려도 구매자는 계속 쓸 수 있다.
import { readFileSync, writeFileSync, mkdirSync, renameSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'

export type MarketKind = 'furniture' | 'clothes'

/** 가구 레이어(마이룸과 동일 의미). 의상엔 없음. */
export type MarketLayer = 'wall' | 'floor-back' | 'floor-front'
const LAYERS: MarketLayer[] = ['wall', 'floor-back', 'floor-front']

// ===== 한도 =====
const MAX_NAME = 40
const MAX_PRICE = 1_000_000
const MIN_PRICE = 0
const MAX_FILES = 12 // 한 아이템 파일 수 상한(의상 = 방향×모션)
const MAX_LISTINGS_PER_USER = 100
const HASH_RE = /^[a-f0-9]{64}$/

/** 의상 파일 키 화이트리스트 — cloth_<dir>_<motion>. front_idle 은 필수(대표). */
const CLOTHES_KEYS = new Set([
  'front_idle',
  'front_walk1',
  'front_walk2',
  'side_idle',
  'side_walk1',
  'side_walk2',
  'back_idle',
  'back_walk1',
  'back_walk2'
])

export interface MarketItem {
  id: string
  creatorId: string
  creatorName: string // 등록 시점 스냅샷(표시용)
  kind: MarketKind
  name: string
  price: number
  files: Record<string, string> // 키 → 자산 해시(bare, 'asset:' 접두 없음)
  layer?: MarketLayer // 가구 전용
  flippable?: boolean // 가구 전용
  createdAt: number
  hidden: boolean // 모더레이션: 목록에서 숨김(소유자는 계속 사용)
}

/** 구매 스냅샷 — 등록이 내려가도 소유자가 계속 쓰도록 파일 맵을 복사 보관. */
export interface OwnedMarketItem {
  id: string
  kind: MarketKind
  name: string
  files: Record<string, string>
  layer?: MarketLayer
  flippable?: boolean
  boughtAt: number
}

/** 등록 입력(파일은 이미 자산 스토어에 올라간 bare 해시). */
export interface SubmitInput {
  kind: unknown
  name: unknown
  price: unknown
  files: unknown // Record<key, hash>
  layer?: unknown
  flippable?: unknown
}

export type SubmitResult = { ok: true; item: MarketItem } | { ok: false; error: string }

export interface MarketStore {
  /** 공개 목록(숨김 제외). 최신 먼저. */
  list(): MarketItem[]
  /** 내 등록(숨김 포함). */
  mine(creatorId: string): MarketItem[]
  getItem(id: string): MarketItem | null
  /** 등록 — 메타 검증 + 파일 서명 도용 차단. 파일 유효성(PNG/치수/용량)은 호출측(relay)이 사전 검증. */
  submit(creatorId: string, creatorName: string, input: SubmitInput): SubmitResult
  /** 소유권 부여(구매 성공 후). 스냅샷 보관. */
  grantOwnership(buyerId: string, item: MarketItem): void
  owns(buyerId: string, itemId: string): boolean
  ownedItems(buyerId: string): OwnedMarketItem[]
  /** 등록 내리기/삭제 — 창작자 또는 관리자. 소유자 있으면 hidden 처리(스냅샷으로 계속 사용), 없으면 완전 삭제. */
  remove(itemId: string, requesterId: string, isAdmin: boolean): { ok: boolean; error?: string }
  /** 계정 탈퇴 연쇄 — 그 계정의 등록 + 보유 스냅샷 제거(타인 보유 스냅샷은 보존). */
  removeAll(accountId: string): void
  /** ⚠자산 GC 라이브셋 — 등록 + 보유 스냅샷의 모든 파일 해시(bare)를 into 에 추가. 두 sweep 지점 모두에서 호출 필수. */
  collectAssetRefs(into: Set<string>): void
  /** 관리자 용량 산출 — 그 계정의 등록 + 보유 스냅샷 직렬화 바이트 + 파일 해시. */
  usageFor(accountId: string): { bytes: number; refs: Set<string> }
}

interface PersistShape {
  items: Record<string, MarketItem>
  owned: Record<string, OwnedMarketItem[]>
}

function str(v: unknown, max: number): string {
  return typeof v === 'string' ? v.trim().slice(0, max) : ''
}
function isHash(v: unknown): v is string {
  return typeof v === 'string' && HASH_RE.test(v)
}
/** 파일 맵 정규화 — kind 별 키 화이트리스트 + 해시 형식 검증. front_idle(대표) 필수. */
function coerceFiles(kind: MarketKind, v: unknown): Record<string, string> | null {
  if (!v || typeof v !== 'object') return null
  const out: Record<string, string> = {}
  let n = 0
  for (const [k, h] of Object.entries(v as Record<string, unknown>)) {
    if (n >= MAX_FILES) break
    if (!isHash(h)) continue
    if (kind === 'furniture') {
      if (k !== 'sprite') continue
      out[k] = h
    } else {
      if (!CLOTHES_KEYS.has(k)) continue
      out[k] = h
    }
    n++
  }
  if (kind === 'furniture') return out.sprite ? out : null
  return out.front_idle ? out : null // 의상은 정면 idle 이 대표(필수)
}

export function createMarketStore(opts?: { dataDir?: string; persist?: boolean }): MarketStore {
  const persist = opts?.persist !== false
  const dataDir = opts?.dataDir ?? join(process.cwd(), 'data')
  const filePath = join(dataDir, 'dottown-market.json')

  let items: Record<string, MarketItem> = {}
  let owned: Record<string, OwnedMarketItem[]> = {}

  if (persist) {
    try {
      if (existsSync(filePath)) {
        const d = JSON.parse(readFileSync(filePath, 'utf8')) as PersistShape
        if (d.items && typeof d.items === 'object') {
          items = d.items
          // 구버전 데이터에 남은 신고자 목록 제거(미사용 필드·개인정보 정리).
          for (const it of Object.values(items)) delete (it as { reports?: unknown }).reports
        }
        if (d.owned && typeof d.owned === 'object') owned = d.owned
      }
    } catch (e) {
      console.error('[market] dottown-market.json 로드 실패. 빈 상태로 시작:', e)
    }
  }

  function save(): void {
    if (!persist) return
    try {
      mkdirSync(dataDir, { recursive: true })
      const tmp = filePath + '.tmp'
      writeFileSync(tmp, JSON.stringify({ items, owned }), 'utf8')
      renameSync(tmp, filePath)
    } catch (e) {
      console.error('[market] 저장 실패:', e)
    }
  }

  function snapshot(item: MarketItem, at: number): OwnedMarketItem {
    return {
      id: item.id,
      kind: item.kind,
      name: item.name,
      files: { ...item.files },
      ...(item.layer ? { layer: item.layer } : {}),
      ...(item.flippable !== undefined ? { flippable: item.flippable } : {}),
      boughtAt: at
    }
  }

  return {
    list() {
      return Object.values(items)
        .filter((i) => !i.hidden)
        .sort((a, b) => b.createdAt - a.createdAt)
    },
    mine(creatorId) {
      return Object.values(items)
        .filter((i) => i.creatorId === creatorId)
        .sort((a, b) => b.createdAt - a.createdAt)
    },
    getItem(id) {
      return (typeof id === 'string' && items[id]) || null
    },

    submit(creatorId, creatorName, input) {
      if (!creatorId) return { ok: false, error: '로그인이 필요합니다.' }
      const kind: MarketKind = input.kind === 'clothes' ? 'clothes' : input.kind === 'furniture' ? 'furniture' : 'furniture'
      if (input.kind !== 'clothes' && input.kind !== 'furniture') return { ok: false, error: '종류가 올바르지 않습니다.' }
      const name = str(input.name, MAX_NAME)
      if (!name) return { ok: false, error: '이름을 입력하세요.' }
      const rawPrice = input.price
      if (typeof rawPrice !== 'number' || !Number.isFinite(rawPrice) || rawPrice < MIN_PRICE || rawPrice > MAX_PRICE) {
        return { ok: false, error: '가격이 올바르지 않습니다.' }
      }
      const price = Math.floor(rawPrice)
      const files = coerceFiles(kind, input.files)
      if (!files) return { ok: false, error: '이미지 파일이 올바르지 않습니다.' }
      // 등록 수 상한(작은 서버 보호).
      if (Object.values(items).filter((i) => i.creatorId === creatorId).length >= MAX_LISTINGS_PER_USER) {
        return { ok: false, error: '등록 한도를 초과했습니다.' }
      }
      // 도용 차단 — 파일 해시가 이미 '다른 창작자'의 등록(숨김 포함)에 쓰였으면 한 장이라도 거부.
      //   (세트 서명 방식은 파일 하나만 바꿔 우회 가능 → 파일 단위로 검사.)
      const claimed = new Map<string, string>() // 해시 → 최초 창작자 id
      for (const it of Object.values(items)) for (const h of Object.values(it.files)) if (!claimed.has(h)) claimed.set(h, it.creatorId)
      for (const h of Object.values(files)) {
        const owner = claimed.get(h)
        if (owner && owner !== creatorId) return { ok: false, error: '다른 창작자가 이미 등록한 이미지가 포함돼 있어요.' }
      }
      const item: MarketItem = {
        id: 'm_' + randomUUID().replace(/-/g, '').slice(0, 16),
        creatorId,
        creatorName: creatorName.slice(0, MAX_NAME) || '창작자',
        kind,
        name,
        price,
        files,
        createdAt: Date.now(),
        hidden: false
      }
      if (kind === 'furniture') {
        item.layer = LAYERS.includes(input.layer as MarketLayer) ? (input.layer as MarketLayer) : 'floor-back'
        item.flippable = input.flippable === true
      }
      items[item.id] = item
      save()
      return { ok: true, item }
    },

    grantOwnership(buyerId, item) {
      if (!buyerId) return
      const list = owned[buyerId] ?? (owned[buyerId] = [])
      if (list.some((o) => o.id === item.id)) return // 멱등
      list.push(snapshot(item, Date.now()))
      save()
    },
    owns(buyerId, itemId) {
      return (owned[buyerId] ?? []).some((o) => o.id === itemId)
    },
    ownedItems(buyerId) {
      return (owned[buyerId] ?? []).map((o) => ({ ...o, files: { ...o.files } }))
    },

    remove(itemId, requesterId, isAdmin) {
      const item = items[itemId]
      if (!item) return { ok: true } // 멱등
      if (!isAdmin && item.creatorId !== requesterId) return { ok: false, error: '권한이 없습니다.' }
      // 소유자가 있으면 완전 삭제 대신 숨김(스냅샷으로 계속 사용 + GC 라이브 유지).
      const hasOwners = Object.values(owned).some((list) => list.some((o) => o.id === itemId))
      if (hasOwners) item.hidden = true
      else delete items[itemId]
      save()
      return { ok: true }
    },

    removeAll(accountId) {
      if (!accountId) return
      let changed = false
      for (const [id, item] of Object.entries(items)) {
        if (item.creatorId === accountId) {
          delete items[id]
          changed = true
        }
      }
      if (owned[accountId]) {
        delete owned[accountId]
        changed = true
      }
      if (changed) save()
    },

    collectAssetRefs(into) {
      for (const item of Object.values(items)) for (const h of Object.values(item.files)) into.add(h)
      for (const list of Object.values(owned)) for (const o of list) for (const h of Object.values(o.files)) into.add(h)
    },

    usageFor(accountId) {
      const myItems = Object.values(items).filter((i) => i.creatorId === accountId)
      const myOwned = owned[accountId] ?? []
      const refs = new Set<string>()
      for (const i of myItems) for (const h of Object.values(i.files)) refs.add(h)
      for (const o of myOwned) for (const h of Object.values(o.files)) refs.add(h)
      const bytes = Buffer.byteLength(JSON.stringify({ items: myItems, owned: myOwned }), 'utf8')
      return { bytes, refs }
    }
  }
}
