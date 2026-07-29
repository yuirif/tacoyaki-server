// 커뮤니티 도감 — 아이템·상점 진열·뽑기 표의 '정의'.
//
// 정의와 소유는 엄격히 나눈다. 여기 있는 건 설계도이고, 실제 물건은 캐릭터 소지품 안에 사본으로 들어간다.
// 그래서 관리자가 아이템 이름을 바꾸거나 진열을 내려도 이미 남의 손에 있는 물건은 멀쩡하다.
//
// 파일 하나에 전부 담는다(정의는 수백 건 규모라 나눌 이유가 없다). 대신 자산 참조가 이 상주 구조 안에만
// 있어야 한다 — 지연 로드 파일에 숨으면 자산 회수가 그것을 못 보고 아이템 그림을 지운다.
import { createHash, randomUUID } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { collectAssetRefs as scanAssetRefs } from './assets'
import { MAIN_CID, stripControl, type Result } from './community'

// ===== 한도 =====
const MAX_ITEMS = 500
const MAX_SHOPS = 20
const MAX_ENTRIES = 200
const MAX_TABLES = 20
const MAX_GACHA_ENTRIES = 100
const MAX_COST_ITEMS = 4
const MAX_EFFECTS = 6
const MAX_NAME = 40
const MAX_DESC = 500
const MAX_STACK = 9999

const ASSET_RE = /^asset:[a-f0-9]{64}$/

export type Rarity = 1 | 2 | 3 | 4 | 5

export interface ItemEffect {
  /** 능력치 양식의 키. 없는 키면 사용 시 조용히 넘어간다. */
  statKey: string
  delta: number
}

export interface ItemLook {
  label: string
  fullBody: string
}

export interface ItemDef {
  id: string
  name: string
  desc: string
  icon: string
  category: string
  rarity: Rarity
  stackMax: number
  /** 선물·교환에 쓸 수 있는가. */
  tradable: boolean
  /** 본인이 버릴 수 있는가. 이야기상 지울 수 없는 물건을 위해. */
  deletable: boolean
  /** 쓰면 사라지며 효과를 낸다. */
  usable: boolean
  effects: ItemEffect[]
  /** 옷장에 새 모습을 더해 주는 물건. */
  look: ItemLook | null
  /** 되팔 때 받는 값. 0 이면 되팔 수 없다. */
  sellBack: number
  /** 목록에서 감춘다. 이미 가진 사람은 그대로 쓴다. */
  hidden: boolean
  createdAt: number
  updatedAt: number
}

export interface Shop {
  id: string
  name: string
  desc: string
  banner: string
  enabled: boolean
  order: number
}

export interface CostItem {
  defId: string
  qty: number
}

export interface ShopEntry {
  id: string
  shopId: string
  defId: string
  qty: number
  priceG: number
  /** 물건으로 치르는 값. 화폐와 함께 걸 수도 있다. */
  costItems: CostItem[]
  /** -1 = 무제한. */
  stock: number
  sold: number
  /** 0 = 제한 없음. */
  limitPerChar: number
  limitPerOwner: number
  /** 0 = 기간 제한 없음. */
  from: number
  to: number
  enabled: boolean
  order: number
}

export interface GachaEntry {
  defId: string
  qty: number
  weight: number
}

export interface GachaTable {
  id: string
  name: string
  desc: string
  banner: string
  priceG: number
  costItem: CostItem | null
  /** 몇 번째에 반드시 주는가. 0 이면 천장 없음. */
  pity: number
  pityDefId: string
  pityQty: number
  entries: GachaEntry[]
  enabled: boolean
  order: number
  /** 확률표가 바뀌면 값이 바뀐다 — 유저에게 '표가 언제 바뀌었나'를 보일 근거. */
  tableHash: string
  updatedAt: number
}

/** 이 아이템을 어디서 얻을 수 있는가. 수기 태그를 두지 않고 정의에서 그때그때 훑어 만든다. */
export type DropSource =
  | { kind: 'shop'; id: string; name: string; priceG: number; costItems: CostItem[]; qty: number; enabled: boolean }
  | { kind: 'gacha'; id: string; name: string; chance: number; qty: number; enabled: boolean }
  | { kind: 'gacha-pity'; id: string; name: string; pity: number; qty: number }
  | { kind: 'grant'; id: string; at: number; count: number }
  | { kind: 'quest'; id: string; name: string; chance: number; qty: number }
  | { kind: 'survey'; id: string; name: string; chance: number; qty: number }

export interface CatalogDoc {
  items: ItemDef[]
  shops: Shop[]
  entries: ShopEntry[]
  tables: GachaTable[]
  updatedAt: number
}

export interface CommunityCatalog {
  all(): CatalogDoc
  items(opts?: { includeHidden?: boolean }): ItemDef[]
  item(id: string): ItemDef | null
  saveItem(input: unknown, now: number): Result<ItemDef>
  removeItem(id: string): Result<ItemDef>

  shops(): Shop[]
  saveShop(input: unknown, now: number): Result<Shop>
  removeShop(id: string, now: number): Result<Shop>

  entries(shopId?: string): ShopEntry[]
  entry(id: string): ShopEntry | null
  saveEntry(input: unknown, now: number): Result<ShopEntry>
  removeEntry(id: string, now: number): Result<ShopEntry>
  /** 팔린 수량을 올린다. 재고가 있으면 그만큼 줄어든 셈이다. */
  bumpSold(entryId: string, qty: number): void

  tables(): GachaTable[]
  table(id: string): GachaTable | null
  saveTable(input: unknown, now: number): Result<GachaTable>
  removeTable(id: string, now: number): Result<GachaTable>

  /** 이 아이템의 획득처 전부. 외부 엔진(퀘스트·조사)이 붙으면 그쪽 목록이 뒤에 이어진다. */
  sourcesOf(defId: string): DropSource[]
  /** 퀘스트·조사처럼 나중에 붙는 엔진이 자기 획득처를 알려 주는 자리. */
  addSourceProvider(fn: (defId: string) => DropSource[]): void

  collectAssetRefs(into: Set<string>): void
  usage(): { items: number; bytes: number }
  flush(): void
}

// ===== 정규화 =====
function line(v: unknown, max: number): string {
  return typeof v === 'string' ? stripControl(v, false).trim().slice(0, max) : ''
}
function multi(v: unknown, max: number): string {
  return typeof v === 'string' ? stripControl(v, true).trim().slice(0, max) : ''
}
function assetRef(v: unknown): string {
  return typeof v === 'string' && ASSET_RE.test(v.trim()) ? v.trim() : ''
}
function num(v: unknown, lo: number, hi: number, def: number): number {
  if (typeof v !== 'number' || !Number.isFinite(v)) return def
  return Math.min(hi, Math.max(lo, Math.round(v)))
}
function bool(v: unknown, def = false): boolean {
  return typeof v === 'boolean' ? v : def
}
function costList(v: unknown): CostItem[] {
  if (!Array.isArray(v)) return []
  const out: CostItem[] = []
  for (const raw of v.slice(0, MAX_COST_ITEMS)) {
    const r = (raw ?? {}) as Record<string, unknown>
    const defId = line(r.defId, 64)
    const qty = num(r.qty, 1, MAX_STACK, 1)
    if (defId && !out.some((x) => x.defId === defId)) out.push({ defId, qty })
  }
  return out
}

/** 확률표의 지문. 무게 목록만 보며, 이름이나 설명이 바뀐 것으로는 값이 변하지 않는다. */
function hashTable(entries: GachaEntry[], pity: number, pityDefId: string): string {
  const body = entries
    .map((e) => `${e.defId}:${e.qty}:${e.weight}`)
    .sort()
    .join('|')
  return createHash('sha256').update(`${body}#${pity}:${pityDefId}`).digest('hex').slice(0, 16)
}

export function createCommunityCatalog(opts?: { dataDir?: string; persist?: boolean }): CommunityCatalog {
  const persist = opts?.persist !== false
  const root = join(opts?.dataDir ?? join(process.cwd(), 'data'), 'community', MAIN_CID)
  const path = join(root, 'catalog.json')

  let doc: CatalogDoc = { items: [], shops: [], entries: [], tables: [], updatedAt: 0 }
  const providers: ((defId: string) => DropSource[])[] = []
  let dirty = false
  let timer: NodeJS.Timeout | null = null

  if (persist) {
    try {
      if (existsSync(path)) {
        const d = JSON.parse(readFileSync(path, 'utf8')) as Partial<CatalogDoc>
        doc = {
          items: Array.isArray(d.items) ? d.items : [],
          shops: Array.isArray(d.shops) ? d.shops : [],
          entries: Array.isArray(d.entries) ? d.entries : [],
          tables: Array.isArray(d.tables) ? d.tables : [],
          updatedAt: Number(d.updatedAt) || 0
        }
      }
    } catch (e) {
      console.error('[community/catalog] 로드 실패 — 빈 도감으로 시작:', e)
    }
  }

  function write(): void {
    dirty = false
    if (!persist) return
    try {
      mkdirSync(root, { recursive: true })
      const tmp = path + '.tmp'
      writeFileSync(tmp, JSON.stringify(doc), 'utf8')
      renameSync(tmp, path)
    } catch (e) {
      console.error('[community/catalog] 저장 실패:', e)
    }
  }

  /** 정의 변경은 바로 쓴다. 판매 수량처럼 잦은 값만 뭉쳐 쓴다. */
  function save(now: number): void {
    doc.updatedAt = now
    write()
  }
  function schedule(): void {
    dirty = true
    if (!persist || timer) return
    timer = setTimeout(() => {
      timer = null
      if (dirty) write()
    }, 3_000)
    timer.unref?.()
  }

  function findItem(id: string): ItemDef | null {
    return doc.items.find((x) => x.id === id) ?? null
  }

  return {
    all: () => doc,

    items(o) {
      const list = o?.includeHidden ? doc.items : doc.items.filter((x) => !x.hidden)
      return list.slice().sort((a, b) => b.rarity - a.rarity || a.name.localeCompare(b.name))
    },
    item: (id) => findItem(id),

    saveItem(input, now) {
      const r = (input && typeof input === 'object' ? input : {}) as Record<string, unknown>
      const id = line(r.id, 64)
      const item = id ? findItem(id) : null
      if (id && !item) return { ok: false, error: '아이템을 찾을 수 없습니다.' }
      const name = line(r.name, MAX_NAME)
      if (!name) return { ok: false, error: '이름을 입력해 주세요.' }
      if (!item && doc.items.length >= MAX_ITEMS) return { ok: false, error: `아이템은 ${MAX_ITEMS}종까지입니다.` }

      const lookBody = assetRef((r.look as Record<string, unknown> | undefined)?.fullBody)
      const next: ItemDef = {
        id: item?.id ?? randomUUID(),
        name,
        desc: multi(r.desc, MAX_DESC),
        icon: assetRef(r.icon),
        category: line(r.category, MAX_NAME),
        rarity: num(r.rarity, 1, 5, 1) as Rarity,
        // 옷장 모습은 겹쳐 쌓을 수 없다 — 같은 옷을 두 벌 가진다는 게 성립하지 않는다.
        stackMax: lookBody ? 1 : num(r.stackMax, 1, MAX_STACK, 99),
        tradable: bool(r.tradable, true),
        deletable: bool(r.deletable, true),
        usable: bool(r.usable, false),
        effects: Array.isArray(r.effects)
          ? (r.effects.slice(0, MAX_EFFECTS).map((e) => {
              const x = (e ?? {}) as Record<string, unknown>
              return { statKey: line(x.statKey, 30), delta: num(x.delta, -1_000_000, 1_000_000, 0) }
            }).filter((e) => e.statKey && e.delta !== 0) as ItemEffect[])
          : [],
        look: lookBody ? { label: line((r.look as Record<string, unknown>).label, MAX_NAME) || name, fullBody: lookBody } : null,
        sellBack: num(r.sellBack, 0, 1_000_000, 0),
        hidden: bool(r.hidden, false),
        createdAt: item?.createdAt ?? now,
        updatedAt: now
      }
      if (item) doc.items[doc.items.indexOf(item)] = next
      else doc.items.push(next)
      save(now)
      return { ok: true, value: next }
    },

    removeItem(id) {
      const item = findItem(id)
      if (!item) return { ok: false, error: '아이템을 찾을 수 없습니다.' }
      // 진열이나 뽑기가 아직 이 아이템을 가리키면 지우지 않는다 — 가리키는 쪽이 빈 곳을 보게 된다.
      const used =
        doc.entries.some((e) => e.defId === id || e.costItems.some((c) => c.defId === id)) ||
        doc.tables.some((t) => t.pityDefId === id || t.costItem?.defId === id || t.entries.some((e) => e.defId === id))
      if (used) return { ok: false, error: '상점이나 뽑기에 걸려 있습니다. 먼저 그곳에서 내려 주세요.' }
      doc.items.splice(doc.items.indexOf(item), 1)
      save(item.updatedAt)
      return { ok: true, value: item }
    },

    shops: () => doc.shops.slice().sort((a, b) => a.order - b.order),

    saveShop(input, now) {
      const r = (input && typeof input === 'object' ? input : {}) as Record<string, unknown>
      const id = line(r.id, 64)
      const cur = id ? doc.shops.find((x) => x.id === id) : null
      if (id && !cur) return { ok: false, error: '상점을 찾을 수 없습니다.' }
      const name = line(r.name, MAX_NAME)
      if (!name) return { ok: false, error: '이름을 입력해 주세요.' }
      if (!cur && doc.shops.length >= MAX_SHOPS) return { ok: false, error: `상점은 ${MAX_SHOPS}개까지입니다.` }
      const next: Shop = {
        id: cur?.id ?? randomUUID(),
        name,
        desc: multi(r.desc, MAX_DESC),
        banner: assetRef(r.banner),
        enabled: bool(r.enabled, true),
        order: num(r.order, 0, 999, cur?.order ?? doc.shops.length)
      }
      if (cur) doc.shops[doc.shops.indexOf(cur)] = next
      else doc.shops.push(next)
      save(now)
      return { ok: true, value: next }
    },

    removeShop(id, now) {
      const cur = doc.shops.find((x) => x.id === id)
      if (!cur) return { ok: false, error: '상점을 찾을 수 없습니다.' }
      doc.shops.splice(doc.shops.indexOf(cur), 1)
      doc.entries = doc.entries.filter((e) => e.shopId !== id)
      save(now)
      return { ok: true, value: cur }
    },

    entries: (shopId) =>
      doc.entries.filter((e) => !shopId || e.shopId === shopId).sort((a, b) => a.order - b.order),
    entry: (id) => doc.entries.find((e) => e.id === id) ?? null,

    saveEntry(input, now) {
      const r = (input && typeof input === 'object' ? input : {}) as Record<string, unknown>
      const id = line(r.id, 64)
      const cur = id ? doc.entries.find((x) => x.id === id) : null
      if (id && !cur) return { ok: false, error: '진열을 찾을 수 없습니다.' }
      const shopId = line(r.shopId, 64) || cur?.shopId || ''
      if (!doc.shops.some((s) => s.id === shopId)) return { ok: false, error: '상점을 골라 주세요.' }
      const defId = line(r.defId, 64) || cur?.defId || ''
      if (!findItem(defId)) return { ok: false, error: '아이템을 골라 주세요.' }
      if (!cur && doc.entries.length >= MAX_ENTRIES) return { ok: false, error: `진열은 ${MAX_ENTRIES}칸까지입니다.` }

      const priceG = num(r.priceG, 0, 1_000_000_000, 0)
      const costItems = costList(r.costItems).filter((c) => !!findItem(c.defId))
      // 값이 아무것도 없으면 상점이 아니라 나눔이 된다. 실수로 전부 무료가 되는 걸 막는다.
      if (priceG === 0 && costItems.length === 0) return { ok: false, error: '가격이나 교환 아이템 중 하나는 정해야 합니다.' }

      const next: ShopEntry = {
        id: cur?.id ?? randomUUID(),
        shopId,
        defId,
        qty: num(r.qty, 1, MAX_STACK, 1),
        priceG,
        costItems,
        stock: r.stock === undefined ? (cur?.stock ?? -1) : num(r.stock, -1, 1_000_000, -1),
        sold: cur?.sold ?? 0,
        limitPerChar: num(r.limitPerChar, 0, 10_000, cur?.limitPerChar ?? 0),
        limitPerOwner: num(r.limitPerOwner, 0, 10_000, cur?.limitPerOwner ?? 0),
        from: num(r.from, 0, Number.MAX_SAFE_INTEGER, 0),
        to: num(r.to, 0, Number.MAX_SAFE_INTEGER, 0),
        enabled: bool(r.enabled, true),
        order: num(r.order, 0, 999, cur?.order ?? doc.entries.length)
      }
      if (cur) doc.entries[doc.entries.indexOf(cur)] = next
      else doc.entries.push(next)
      save(now)
      return { ok: true, value: next }
    },

    removeEntry(id, now) {
      const cur = doc.entries.find((x) => x.id === id)
      if (!cur) return { ok: false, error: '진열을 찾을 수 없습니다.' }
      doc.entries.splice(doc.entries.indexOf(cur), 1)
      save(now)
      return { ok: true, value: cur }
    },

    bumpSold(entryId, qty) {
      const e = doc.entries.find((x) => x.id === entryId)
      if (!e) return
      e.sold += qty
      if (e.stock >= 0) e.stock = Math.max(0, e.stock - qty)
      // 재고는 메모리가 즉시 정확하다. 파일 쓰기는 뭉쳐서 하며, 그 사이에 죽으면 재고가 조금 넉넉해질 뿐이다.
      schedule()
    },

    tables: () => doc.tables.slice().sort((a, b) => a.order - b.order),
    table: (id) => doc.tables.find((t) => t.id === id) ?? null,

    saveTable(input, now) {
      const r = (input && typeof input === 'object' ? input : {}) as Record<string, unknown>
      const id = line(r.id, 64)
      const cur = id ? doc.tables.find((x) => x.id === id) : null
      if (id && !cur) return { ok: false, error: '뽑기를 찾을 수 없습니다.' }
      const name = line(r.name, MAX_NAME)
      if (!name) return { ok: false, error: '이름을 입력해 주세요.' }
      if (!cur && doc.tables.length >= MAX_TABLES) return { ok: false, error: `뽑기는 ${MAX_TABLES}개까지입니다.` }

      const entries: GachaEntry[] = []
      for (const raw of Array.isArray(r.entries) ? r.entries.slice(0, MAX_GACHA_ENTRIES) : []) {
        const x = (raw ?? {}) as Record<string, unknown>
        const defId = line(x.defId, 64)
        if (!defId || !findItem(defId)) continue
        const weight = num(x.weight, 0, 1_000_000, 0)
        if (weight <= 0) continue
        entries.push({ defId, qty: num(x.qty, 1, MAX_STACK, 1), weight })
      }
      if (!entries.length) return { ok: false, error: '뽑기 항목을 하나 이상 넣어 주세요.' }

      const priceG = num(r.priceG, 0, 1_000_000_000, 0)
      const costItemRaw = costList(r.costItem ? [r.costItem] : [])
      const costItem = costItemRaw.length && findItem(costItemRaw[0].defId) ? costItemRaw[0] : null
      if (priceG === 0 && !costItem) return { ok: false, error: '뽑기 값을 정해 주세요.' }

      const pity = num(r.pity, 0, 1000, 0)
      const pityDefId = line(r.pityDefId, 64)
      // 천장을 걸었으면 그때 무엇을 주는지도 있어야 한다. 없으면 천장이 아무 일도 하지 않는다.
      if (pity > 0 && !findItem(pityDefId)) return { ok: false, error: '천장에서 줄 아이템을 골라 주세요.' }

      const next: GachaTable = {
        id: cur?.id ?? randomUUID(),
        name,
        desc: multi(r.desc, MAX_DESC),
        banner: assetRef(r.banner),
        priceG,
        costItem,
        pity,
        pityDefId: pity > 0 ? pityDefId : '',
        pityQty: pity > 0 ? num(r.pityQty, 1, MAX_STACK, 1) : 0,
        entries,
        enabled: bool(r.enabled, true),
        order: num(r.order, 0, 999, cur?.order ?? doc.tables.length),
        tableHash: hashTable(entries, pity, pity > 0 ? pityDefId : ''),
        updatedAt: now
      }
      if (cur) doc.tables[doc.tables.indexOf(cur)] = next
      else doc.tables.push(next)
      save(now)
      return { ok: true, value: next }
    },

    removeTable(id, now) {
      const cur = doc.tables.find((x) => x.id === id)
      if (!cur) return { ok: false, error: '뽑기를 찾을 수 없습니다.' }
      doc.tables.splice(doc.tables.indexOf(cur), 1)
      save(now)
      return { ok: true, value: cur }
    },

    sourcesOf(defId) {
      const out: DropSource[] = []
      for (const e of doc.entries) {
        if (e.defId !== defId) continue
        const shop = doc.shops.find((s) => s.id === e.shopId)
        out.push({
          kind: 'shop',
          id: e.id,
          name: shop?.name ?? '상점',
          priceG: e.priceG,
          costItems: e.costItems,
          qty: e.qty,
          enabled: e.enabled && (shop?.enabled ?? false)
        })
      }
      for (const t of doc.tables) {
        const total = t.entries.reduce((a, x) => a + x.weight, 0)
        for (const x of t.entries) {
          if (x.defId !== defId || total <= 0) continue
          out.push({ kind: 'gacha', id: t.id, name: t.name, chance: x.weight / total, qty: x.qty, enabled: t.enabled })
        }
        if (t.pity > 0 && t.pityDefId === defId) {
          out.push({ kind: 'gacha-pity', id: t.id, name: t.name, pity: t.pity, qty: t.pityQty })
        }
      }
      for (const p of providers) {
        try {
          out.push(...p(defId))
        } catch {
          // 붙어 있는 엔진 하나가 터져도 나머지 획득처는 보여야 한다.
        }
      }
      return out
    },

    addSourceProvider(fn) {
      providers.push(fn)
    },

    collectAssetRefs(into) {
      scanAssetRefs(JSON.stringify(doc), into)
    },

    usage: () => ({ items: doc.items.length, bytes: Buffer.byteLength(JSON.stringify(doc), 'utf8') }),

    flush() {
      if (timer) {
        clearTimeout(timer)
        timer = null
      }
      if (dirty) write()
    }
  }
}
