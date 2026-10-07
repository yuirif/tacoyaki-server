// 도트타운 광장 부동산 — 빈터 20개에 유저가 마이룸 건물을 세운다(계정당 1채). 영속(서버 재시작 보존).
// 매매: 전세(1회 1000코인·환불 없음)/일세(하루 10코인·연체 시 자동 퇴거). 코인 차감은 주입된 charge(economy.applyDelta)
//   한 곳으로 수렴해 원장·잔액 정합을 economy 와 공유한다. 실제 마이룸(dottown.ts)은 건드리지 않고, 광장에 보이는
//   '건물'만 세우고/뺀다. 위치(발자국)는 정적(LOT_DEFS), 점유·외형·납부만 변한다.
import { readFileSync, writeFileSync, mkdirSync, renameSync, existsSync } from 'node:fs'
import { join } from 'node:path'

export type Tenancy = 'jeonse' | 'wolse'

/** 빈터 정의(정적 위치) — fx,fy=발자국 좌상단 셀, fw,fh=칸 수, cx,cy=상호작용/현관 셀(발자국 앞·걷기 가능). */
export interface LotDef {
  index: number
  fx: number
  fy: number
  fw: number
  fh: number
  cx: number
  cy: number
}

/** 렌더/스냅샷용 빈터(정적 위치 + 점유 정보). 공개 렌더는 paidUntil/leasedAt 을 생략(사생활). */
export interface EstateLot extends LotDef {
  ownerId?: string
  ownerNick?: string
  style?: number
  tenancy?: Tenancy
  paidUntil?: number // 일세 납부 마감(본인 조회에만 포함). 전세는 생략.
  leasedAt?: number
}

export const LOT_COUNT = 20
export const JEONSE_PRICE = 1000 // 전세(1회·환불 없음)
export const WOLSE_DAILY = 10 // 일세(하루=24시간당)
export const BUILDING_STYLES = 8 // 건물 외형 선택지(0..7)
const DAY_MS = 24 * 60 * 60 * 1000
const GRACE_MS = DAY_MS // 마감 후 이만큼 더 지나면 자동 퇴거(연체 유예 1일)
const PREPAY_DAYS = 7 // 일세 선납 상한(이만큼까지 미리 낼 수 있음)

// 빈터 20개 배치 — 5열 × 4행. 원본 크기 집(선명·큼)이 겹치지 않게 넓게 배치. 발자국 6×3, 현관은 발자국 바로 아래 중앙(걷기 가능).
const LOT_COLS = [6, 19, 32, 45, 58]
const LOT_ROWS = [16, 29, 42, 55]
export const LOT_DEFS: LotDef[] = LOT_ROWS.flatMap((fy, r) =>
  LOT_COLS.map((fx, c): LotDef => {
    const index = r * LOT_COLS.length + c
    return { index, fx, fy, fw: 6, fh: 3, cx: fx + 3, cy: fy + 3 }
  })
)
const LOT_BY_INDEX = new Map(LOT_DEFS.map((d) => [d.index, d]))

/** 점유 레코드(영속 저장 단위). */
interface Occupancy {
  ownerId: string
  ownerNick: string
  style: number
  tenancy: Tenancy
  leasedAt: number
  paidUntil: number // 전세는 Number.MAX_SAFE_INTEGER
}

/** 코인 차감/환급 결과(economy.applyDelta 미러). */
export type ChargeResult = { ok: boolean; balance: number; error?: string }

export interface EstateStore {
  /** 전체 20칸 공개 렌더(점유 병합·paidUntil 제외). */
  lots(): EstateLot[]
  /** 내 소유 빈터(없으면 null·paidUntil 포함). */
  myLot(accountId: string): EstateLot | null
  /** 입주 — 계정당 1채·빈 칸·잔액 검사 후 charge. 성공 시 건물 세움. */
  lease(
    accountId: string,
    nick: string,
    index: number,
    tenancy: Tenancy,
    style: number
  ): { ok: boolean; error?: string; lot?: EstateLot; balance?: number }
  /** 건물 외형 변경(무료·소유자만). */
  setStyle(accountId: string, style: number): { ok: boolean; error?: string }
  /** 일세 납부(하루치·선납 상한까지). 전세는 불가. */
  payRent(accountId: string): { ok: boolean; error?: string; paidUntil?: number; balance?: number }
  /** 자진 퇴거(환불 없음). had=뺄 집이 있었는지. */
  moveOut(accountId: string): { ok: boolean; had: boolean }
  /** 연체 일세 자동 퇴거(주기 호출) — 뺀 칸 index 목록. */
  sweep(): number[]
  /** 점유 건물 발자국 셀 집합("x,y") — 광장 이동 차단용. */
  blockedCells(): Set<string>
  /** 계정 삭제 연쇄 — 소유 건물 제거. */
  removeAll(accountId: string): void
}

export function createEstateStore(opts: {
  charge: (accountId: string, amount: number, reason: 'lease' | 'rent', ref?: string) => ChargeResult
  /** 소유자의 현재 표시 닉네임 해석(집 위 라벨용) — 도트타운 닉 반영. 빈 문자열이면 저장된 ownerNick 폴백. */
  resolveNick?: (ownerId: string) => string
  dataDir?: string
  persist?: boolean
  now?: () => number
}): EstateStore {
  const persist = opts.persist !== false
  const dataDir = opts.dataDir ?? join(process.cwd(), 'data')
  const filePath = join(dataDir, 'dottown-estate.json')
  const now = opts.now ?? Date.now
  const charge = opts.charge
  const resolveNick = opts.resolveNick

  const lots = new Map<number, Occupancy>() // index → 점유
  const byOwner = new Map<string, number>() // ownerId → index

  if (persist) {
    try {
      if (existsSync(filePath)) {
        const d = JSON.parse(readFileSync(filePath, 'utf8')) as { lots?: Record<string, Occupancy> }
        if (d.lots && typeof d.lots === 'object') {
          for (const [k, v] of Object.entries(d.lots)) {
            const index = Number(k)
            if (!LOT_BY_INDEX.has(index) || !v || typeof v !== 'object' || typeof v.ownerId !== 'string') continue
            const occ: Occupancy = {
              ownerId: v.ownerId,
              ownerNick: typeof v.ownerNick === 'string' ? v.ownerNick : '',
              style: clampStyle(v.style),
              tenancy: v.tenancy === 'wolse' ? 'wolse' : 'jeonse',
              leasedAt: typeof v.leasedAt === 'number' ? v.leasedAt : now(),
              paidUntil: typeof v.paidUntil === 'number' ? v.paidUntil : Number.MAX_SAFE_INTEGER
            }
            lots.set(index, occ)
            byOwner.set(occ.ownerId, index) // 계정당 1채라 마지막 것만(정상 데이터면 유일)
          }
        }
      }
    } catch (e) {
      console.error('[dottown-estate] 로드 실패. 빈 상태로 시작:', e)
    }
  }

  function save(): void {
    if (!persist) return
    try {
      mkdirSync(dataDir, { recursive: true })
      const obj: Record<string, Occupancy> = {}
      for (const [k, v] of lots) obj[k] = v
      const tmp = filePath + '.tmp'
      writeFileSync(tmp, JSON.stringify({ lots: obj }), 'utf8')
      renameSync(tmp, filePath)
    } catch (e) {
      console.error('[dottown-estate] 저장 실패:', e)
    }
  }

  function clampStyle(v: unknown): number {
    const n = typeof v === 'number' && Number.isFinite(v) ? Math.floor(v) : 0
    return Math.max(0, Math.min(BUILDING_STYLES - 1, n))
  }

  function viewOf(def: LotDef, includePaid: boolean): EstateLot {
    const occ = lots.get(def.index)
    if (!occ) return { ...def }
    return {
      ...def,
      ownerId: occ.ownerId,
      ownerNick: resolveNick?.(occ.ownerId) || occ.ownerNick, // 현재 표시 닉(도트타운 닉) 우선, 폴백=저장된 닉
      style: occ.style,
      tenancy: occ.tenancy,
      leasedAt: occ.leasedAt,
      ...(includePaid && occ.tenancy === 'wolse' ? { paidUntil: occ.paidUntil } : {})
    }
  }

  return {
    lots: () => LOT_DEFS.map((d) => viewOf(d, false)),

    myLot: (accountId) => {
      const index = byOwner.get(accountId)
      if (index === undefined) return null
      const def = LOT_BY_INDEX.get(index)
      return def ? viewOf(def, true) : null
    },

    lease: (accountId, nick, index, tenancy, style) => {
      if (!accountId) return { ok: false, error: '계정이 필요합니다.' }
      const def = LOT_BY_INDEX.get(index)
      if (!def) return { ok: false, error: '없는 빈터예요.' }
      if (tenancy !== 'jeonse' && tenancy !== 'wolse') return { ok: false, error: '매매 종류가 올바르지 않아요.' }
      if (byOwner.has(accountId)) return { ok: false, error: '이미 광장에 집이 있어요. 먼저 방을 빼주세요.' }
      if (lots.has(index)) return { ok: false, error: '이미 다른 분이 입주한 빈터예요.' }
      const price = tenancy === 'jeonse' ? JEONSE_PRICE : WOLSE_DAILY
      const r = charge(accountId, -price, 'lease', 'lot' + index)
      if (!r.ok) return { ok: false, error: r.error ?? '코인이 부족해요.', balance: r.balance }
      const at = now()
      const occ: Occupancy = {
        ownerId: accountId,
        ownerNick: (typeof nick === 'string' ? nick.trim().slice(0, 24) : '') || '주민',
        style: clampStyle(style),
        tenancy,
        leasedAt: at,
        paidUntil: tenancy === 'jeonse' ? Number.MAX_SAFE_INTEGER : at + DAY_MS // 일세 첫날 포함
      }
      lots.set(index, occ)
      byOwner.set(accountId, index)
      save()
      return { ok: true, lot: viewOf(def, true), balance: r.balance }
    },

    setStyle: (accountId, style) => {
      const index = byOwner.get(accountId)
      if (index === undefined) return { ok: false, error: '광장에 집이 없어요.' }
      const occ = lots.get(index)
      if (!occ) return { ok: false, error: '광장에 집이 없어요.' }
      occ.style = clampStyle(style)
      save()
      return { ok: true }
    },

    payRent: (accountId) => {
      const index = byOwner.get(accountId)
      if (index === undefined) return { ok: false, error: '광장에 집이 없어요.' }
      const occ = lots.get(index)
      if (!occ) return { ok: false, error: '광장에 집이 없어요.' }
      if (occ.tenancy !== 'wolse') return { ok: false, error: '전세는 일세를 낼 필요가 없어요.' }
      const at = now()
      const cap = at + PREPAY_DAYS * DAY_MS
      if (occ.paidUntil >= cap) return { ok: false, error: '이미 충분히 미리 납부했어요.' }
      const r = charge(accountId, -WOLSE_DAILY, 'rent', 'lot' + index)
      if (!r.ok) return { ok: false, error: r.error ?? '코인이 부족해요.', balance: r.balance }
      occ.paidUntil = Math.min(cap, Math.max(at, occ.paidUntil) + DAY_MS)
      save()
      return { ok: true, paidUntil: occ.paidUntil, balance: r.balance }
    },

    moveOut: (accountId) => {
      const index = byOwner.get(accountId)
      if (index === undefined) return { ok: true, had: false }
      lots.delete(index)
      byOwner.delete(accountId)
      save()
      return { ok: true, had: true }
    },

    sweep: () => {
      const at = now()
      const evicted: number[] = []
      for (const [index, occ] of lots) {
        if (occ.tenancy === 'wolse' && at > occ.paidUntil + GRACE_MS) evicted.push(index)
      }
      for (const index of evicted) {
        const occ = lots.get(index)
        if (occ) byOwner.delete(occ.ownerId)
        lots.delete(index)
      }
      if (evicted.length) save()
      return evicted
    },

    blockedCells: () => {
      const s = new Set<string>()
      for (const index of lots.keys()) {
        const def = LOT_BY_INDEX.get(index)
        if (!def) continue
        for (let y = def.fy; y < def.fy + def.fh; y++) for (let x = def.fx; x < def.fx + def.fw; x++) s.add(x + ',' + y)
      }
      return s
    },

    removeAll: (accountId) => {
      const index = byOwner.get(accountId)
      if (index === undefined) return
      lots.delete(index)
      byOwner.delete(accountId)
      save()
    }
  }
}
