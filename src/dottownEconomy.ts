// 도트타운 경제(확장팩) — 코인 지갑·원장·아르바이트(서버 권위 타이머)·NPC 상점(소유권)·일일 보상.
// 서버 권위 절대: 잔액·타이머·거래는 서버가 진실원본, 클라는 표시만. 단일 파일 영속(dottown-economy.json, tmp→rename).
// 모든 잔액 변동은 원자적 applyDelta 한 곳으로 수렴(음수 차단·정수 검증) + 계정별 원장 append(최근 N건).
import { readFileSync, writeFileSync, mkdirSync, renameSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'

// ===== 한도·밸런싱 상수 =====
const LEDGER_MAX = 100 // 계정당 원장 보관(초과 시 오래된 것부터 절삭)
const MAX_BALANCE = 100_000_000 // 잔액 상한(오버플로/표시 안전)
const MINUTE_MS = 60_000

const DAILY_BASE = 40 // 일일 보상 기본
const DAILY_STREAK_BONUS = 10 // 연속 출석 1일당 가산
const DAILY_STREAK_MAX = 7 // 가산 상한(7일)

/** 아르바이트 가게 — 시급 차등. */
export interface JobShopDef {
  id: string
  name: string
  hourlyWage: number
}
// 시급은 경제 인플레를 억제하는 수준으로 낮게 잡되, 가게별 차등은 둔다.
export const JOB_SHOPS: JobShopDef[] = [
  { id: 'bakery', name: '베이커리', hourlyWage: 30 },
  { id: 'flower', name: '꽃집', hourlyWage: 35 },
  { id: 'cafe', name: '카페', hourlyWage: 40 },
  { id: 'furniture', name: '가구점', hourlyWage: 48 },
  { id: 'restaurant', name: '레스토랑', hourlyWage: 55 },
  { id: 'handmade', name: '수제마켓', hourlyWage: 60 }
]
/** 근무 시간 선택지(분) — 30분·1시간·3시간. 걸어두는 방치형이라 분 단위. */
export const JOB_DURATIONS = [30, 60, 180] as const
export type JobMinutes = (typeof JOB_DURATIONS)[number]

/** NPC 상점 아이템 — 마이룸 가구/벽지/바닥의 '프리미엄'(유료) 세트. 무료 기본세트와 별개.
 *  shop=파는 건물(광장 상점 스코프) — 미지정은 가구점 취급. */
export interface ShopItemDef {
  itemId: string // 에셋팩 폴더 id(furniture/<id> 또는 wallpaper|flooring/<id>)
  kind: 'furniture' | 'wallpaper' | 'flooring'
  price: number
  shop?: string
}
export const SHOP_CATALOG: ShopItemDef[] = [
  // 가구점 — 기존 프리미엄 세트
  { itemId: 'sofa', kind: 'furniture', price: 220, shop: 'furniture' },
  { itemId: 'bed', kind: 'furniture', price: 260, shop: 'furniture' },
  { itemId: 'table', kind: 'furniture', price: 140, shop: 'furniture' },
  { itemId: 'bookshelf', kind: 'furniture', price: 200, shop: 'furniture' },
  { itemId: 'tv', kind: 'furniture', price: 300, shop: 'furniture' },
  { itemId: 'rug2', kind: 'furniture', price: 120, shop: 'furniture' },
  // 벽지/바닥 타일은 전부 무료(클라 팔레트에 자유 선택) — 카탈로그에 넣으면 저장 게이트가 미구매 선택을
  //   403 으로 거부해 클라 무료 정책과 충돌하므로 프리미엄 목록에서 제외한다.
  // 테마 상점 — 각 건물이 파는 마이룸 가구(에셋은 확장팩 베이킹)
  { itemId: 'bread_shelf', kind: 'furniture', price: 160, shop: 'bakery' },
  { itemId: 'bread_basket', kind: 'furniture', price: 90, shop: 'bakery' },
  { itemId: 'oven', kind: 'furniture', price: 240, shop: 'bakery' },
  { itemId: 'cafe_table', kind: 'furniture', price: 150, shop: 'cafe' },
  { itemId: 'coffee_machine', kind: 'furniture', price: 260, shop: 'cafe' },
  { itemId: 'cafe_menuboard', kind: 'furniture', price: 110, shop: 'cafe' },
  { itemId: 'dining_set', kind: 'furniture', price: 280, shop: 'restaurant' },
  { itemId: 'food_cart', kind: 'furniture', price: 200, shop: 'restaurant' },
  { itemId: 'wine_shelf', kind: 'furniture', price: 230, shop: 'restaurant' },
  { itemId: 'flower_pot', kind: 'furniture', price: 80, shop: 'flower' },
  { itemId: 'flower_stand', kind: 'furniture', price: 170, shop: 'flower' },
  { itemId: 'hanging_plant', kind: 'furniture', price: 130, shop: 'flower' }
]
const PREMIUM_IDS = new Set(SHOP_CATALOG.map((s) => s.itemId))

// ===== 요리·낚시(미니게임) + 재료 인벤토리 =====
/** 스택형 아이템 정의(재료). */
export interface ItemDef {
  id: string
  name: string
}
export const INGREDIENTS: ItemDef[] = [
  { id: 'anchovy', name: '멸치' },
  { id: 'mackerel', name: '고등어' },
  { id: 'tuna', name: '참치' }
]
const ITEM_NAME = new Map(INGREDIENTS.map((i) => [i.id, i.name]))
/** 낚시 확률 테이블(가중치) — 흔할수록 큼. */
const FISH_TABLE: { id: string; weight: number }[] = [
  { id: 'anchovy', weight: 60 },
  { id: 'mackerel', weight: 30 },
  { id: 'tuna', weight: 10 }
]
const FISH_TOTAL_WEIGHT = FISH_TABLE.reduce((s, f) => s + f.weight, 0)
// 낚시 쿨다운 없음 — 파밍 억제는 입질 대기(2~5초)와 경제 레이트리밋(계정당 10초 30건)이 담당한다.
const FISH_COOLDOWN_MS = 0
const BITE_MIN_MS = 2000 // 던진 뒤 입질까지 최소 대기
const BITE_MAX_MS = 5000 // 입질까지 최대 대기
const PULL_WINDOW_MS = 1000 // 입질 후 당기기 제한시간(클라 "!" 표시 기준)
const PULL_GRACE_MS = 800 // 서버 판정 여유(네트워크 지연) — 허용창 = PULL_WINDOW_MS + PULL_GRACE_MS
/** 물고기 즉시 판매 단가 — 알바 시급(30~60/h)과 균형을 맞춘 소액. */
export const FISH_PRICES: Record<string, number> = { anchovy: 1, mackerel: 3, tuna: 10 }
const MAX_STACK = 9999 // 아이템 수량 상한

/** 요리 레시피 — 재료(itemId→수량) 소비 → 코인 보상(즉시 판매). */
export interface Recipe {
  id: string
  name: string
  inputs: Record<string, number>
  coin: number
}
export const RECIPES: Recipe[] = [
  { id: 'grilled', name: '생선구이', inputs: { anchovy: 2 }, coin: 30 },
  { id: 'sushi', name: '초밥', inputs: { anchovy: 1, mackerel: 1 }, coin: 70 },
  { id: 'sashimi', name: '회', inputs: { tuna: 1 }, coin: 150 }
]

export type CoinReason = 'job' | 'buy' | 'daily' | 'admin' | 'refund' | 'cook' | 'fish' | 'like' | 'sale' | 'lease' | 'rent'

export interface CoinTxn {
  id: string
  delta: number
  reason: CoinReason
  ref?: string
  balanceAfter: number
  at: number
}
export interface Wallet {
  balance: number
  updatedAt: number
}
export type JobShiftStatus = 'working' | 'done'
export interface JobShift {
  accountId: string
  shopId: string
  startAt: number
  endAt: number
  minutes: number
  hourlyWage: number // 시작 시점 스냅샷
  status: JobShiftStatus // 'done' 은 저장하지 않고 now>=endAt 으로 파생(아래 viewShift)
}
interface DailyState {
  lastDate: string // 'YYYY-MM-DD'(UTC 기준 — dayStr 산출값). 같은 날 재수령 차단.
  streak: number
}

export interface SpendResult {
  ok: boolean
  balance: number
  error?: string
  txnId?: string
}

export interface EconStore {
  /** 클라 일괄 상태(위젯 오픈 시 1회) — 잔액·소유·진행 알바·일일·정의(가게/시간/상점). */
  snapshot(accountId: string): EconSnapshot
  balanceOf(accountId: string): number
  /** 원자적 잔액 변경(단일 진입점) — 음수 차단·정수 검증. admin/내부 공용. */
  applyDelta(accountId: string, delta: number, reason: CoinReason, ref?: string): SpendResult
  /** 계정 간 이체(마켓 구매) — 구매자 -amount, 창작자 +(amount-fee), fee 는 소각(sink). 실패 시 자동 롤백. */
  transfer(
    fromId: string,
    toId: string,
    amount: number,
    fee: number
  ): { ok: boolean; error?: string; fromBalance: number; toBalance: number }
  /** 일일 보상 수령 — 같은 날 재수령 거부, 연속 출석 streak 가산. */
  claimDaily(accountId: string): { ok: boolean; amount?: number; streak?: number; balance: number; error?: string }
  /** 알바 시작 — 이미 근무중이면 거부. */
  startJob(accountId: string, shopId: string, minutes: number): { ok: boolean; shift?: JobShift; error?: string }
  /** 진행 중 알바(없으면 null) — done 파생 상태 포함. */
  jobOf(accountId: string): (JobShift & { done: boolean; remainingMs: number }) | null
  /** 퇴근(정산) — now>=endAt 재검증 후 지급. */
  finishJob(accountId: string): { ok: boolean; payout?: number; balance: number; error?: string }
  /** 근무 취소(보상 없음). had=취소 전 진행 중이던 shift 가 있었는지(불필요한 브로드캐스트 억제용). */
  cancelJob(accountId: string): { ok: boolean; had: boolean }
  /** 근무중 여부(마이룸 비움·이동 제약 게이트용). */
  isWorking(accountId: string): boolean
  /** 상점 구매 — 코인 소각(sink) + 소유권 부여. 이미 보유/잔액부족/미상품 거부. */
  buy(accountId: string, itemId: string): { ok: boolean; balance: number; owned?: string[]; error?: string }
  ownedOf(accountId: string): string[]
  isOwned(accountId: string, itemId: string): boolean
  isPremium(itemId: string): boolean
  /** 배치 검증 — 프리미엄인데 미보유면 false(소유권 게이트). 무료/소유면 true. */
  canPlace(accountId: string, itemId: string): boolean
  ledgerOf(accountId: string): CoinTxn[]
  /** 재료 인벤토리(itemId→수량). */
  inventoryOf(accountId: string): Record<string, number>
  /** 낚싯대 던지기 — 쿨다운(던진 시점 기산) 확인 후 입질 시각을 서버가 랜덤 결정. */
  castFish(accountId: string): { ok: boolean; biteIn?: number; pullWindowMs?: number; cooldownMs?: number; readyIn?: number; error?: string }
  /** 당기기 — 입질 시간창(서버 권위) 안이면 가중치 랜덤 어획, 이르거나 늦으면 도망. 판정은 1회. */
  pullFish(accountId: string): { ok: boolean; caught?: boolean; reason?: 'early' | 'late'; item?: string; name?: string; error?: string }
  /** 물고기 판매 — itemId 생략 시 전량. 코인 지급 성공 후에만 인벤 차감(잔액 상한 실패 시 보존). */
  sellFish(accountId: string, itemId?: string): { ok: boolean; coin?: number; balance: number; inventory?: Record<string, number>; error?: string }
  /** 요리 — 레시피 재료를 소비하고 코인 보상(즉시 판매). 재료 부족/없는 레시피 거부. */
  cook(accountId: string, recipeId: string): { ok: boolean; coin?: number; balance: number; error?: string }
  /** 계정 탈퇴 연쇄 — 지갑·원장·소유·알바·일일 제거. */
  removeAll(accountId: string): void
  /** 자산 GC(메타만이라 비어있지만 계약 유지). */
  collectAssetRefs(into: Set<string>): void
  /** 관리자 용량 산출. */
  usageFor(accountId: string): { bytes: number; refs: Set<string> }
  /** 멤버 본인 이전(내보내기) — 지갑·소유·일일. (원장·알바는 휘발성/감사용이라 제외) */
  exportFor(accountId: string): { wallet: Wallet | null; owned: string[]; daily: DailyState | null }
  /** 멤버 본인 이전(가져오기). */
  importFor(accountId: string, data: unknown): void
}

export interface EconSnapshot {
  balance: number
  owned: string[]
  job: (JobShift & { done: boolean; remainingMs: number }) | null
  daily: { claimable: boolean; streak: number }
  shops: JobShopDef[]
  /** 현재 다른 유저가 근무 중이라 시작 불가한 가게 id(가게별 1명 독점) — 클라 UI 비활성화용. */
  busyShops: string[]
  durations: number[]
  catalog: ShopItemDef[]
  ledger: CoinTxn[]
  inventory: Record<string, number>
  ingredients: ItemDef[]
  recipes: Recipe[]
  fishReadyIn: number // 낚시 재시도까지 남은 ms(0=지금 가능)
  fishPrices: Record<string, number> // 물고기 즉시 판매 단가(itemId→코인)
}

interface PersistShape {
  wallets: Record<string, Wallet>
  jobs: Record<string, JobShift>
  owned: Record<string, string[]>
  daily: Record<string, DailyState>
  ledger: Record<string, CoinTxn[]>
  inv?: Record<string, Record<string, number>>
  lastFish?: Record<string, number>
}

/** 'YYYY-MM-DD'(UTC 기준 — 시계조작 무의미 + DST 무관. UTC 일자는 항상 24h라 now()-24h 가 정확히 전날). */
function dayStr(ms: number): string {
  const d = new Date(ms)
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}-${String(d.getUTCDate()).padStart(2, '0')}`
}

export function createEconomyStore(opts?: { dataDir?: string; persist?: boolean; now?: () => number; rand?: () => number }): EconStore {
  const persist = opts?.persist !== false
  const dataDir = opts?.dataDir ?? join(process.cwd(), 'data')
  const filePath = join(dataDir, 'dottown-economy.json')
  const now = opts?.now ?? Date.now
  const rand = opts?.rand ?? Math.random

  let wallets: Record<string, Wallet> = {}
  let jobs: Record<string, JobShift> = {}
  let owned: Record<string, string[]> = {}
  let daily: Record<string, DailyState> = {}
  let ledger: Record<string, CoinTxn[]> = {}
  let inv: Record<string, Record<string, number>> = {}
  let lastFish: Record<string, number> = {}
  // 진행 중 낚시 세션(계정당 1개) — 휘발. 재시작 시 소실돼도 쿨다운(lastFish)은 남아 손실은 최대 1사이클.
  const fishCasts: Record<string, { castAt: number; biteAt: number }> = {}

  if (persist) {
    try {
      if (existsSync(filePath)) {
        const d = JSON.parse(readFileSync(filePath, 'utf8')) as PersistShape
        if (d.wallets && typeof d.wallets === 'object') wallets = d.wallets
        if (d.jobs && typeof d.jobs === 'object') jobs = d.jobs
        if (d.owned && typeof d.owned === 'object') owned = d.owned
        if (d.daily && typeof d.daily === 'object') daily = d.daily
        if (d.ledger && typeof d.ledger === 'object') ledger = d.ledger
        if (d.inv && typeof d.inv === 'object') inv = d.inv
        if (d.lastFish && typeof d.lastFish === 'object') lastFish = d.lastFish
      }
    } catch (e) {
      console.error('[dottown-econ] 로드 실패. 빈 상태로 시작:', e)
    }
  }

  function save(): void {
    if (!persist) return
    try {
      mkdirSync(dataDir, { recursive: true })
      const tmp = filePath + '.tmp'
      writeFileSync(tmp, JSON.stringify({ wallets, jobs, owned, daily, ledger, inv, lastFish }), 'utf8')
      renameSync(tmp, filePath)
    } catch (e) {
      console.error('[dottown-econ] 저장 실패:', e)
    }
  }

  /** 낚시 재시도까지 남은 ms(0=지금 가능). */
  function fishReadyIn(id: string): number {
    const last = lastFish[id] ?? 0
    return Math.max(0, FISH_COOLDOWN_MS - (now() - last))
  }

  /** 가중치 랜덤으로 물고기 1종 선택. */
  function pickFish(): string {
    let roll = rand() * FISH_TOTAL_WEIGHT
    let picked = FISH_TABLE[0].id
    for (const f of FISH_TABLE) {
      if (roll < f.weight) {
        picked = f.id
        break
      }
      roll -= f.weight
    }
    return picked
  }

  function walletOf(id: string): Wallet {
    let w = wallets[id]
    if (!w) {
      w = { balance: 0, updatedAt: now() }
      wallets[id] = w
    }
    return w
  }

  function appendLedger(id: string, txn: CoinTxn): void {
    const list = ledger[id] ?? (ledger[id] = [])
    list.push(txn)
    if (list.length > LEDGER_MAX) list.splice(0, list.length - LEDGER_MAX)
  }

  /** 원자적 잔액 변경(단일 진입점). Node 단일 스레드라 함수 본문 내 인터리브 없음 → 그 자체로 원자적. */
  function applyDelta(id: string, delta: number, reason: CoinReason, ref?: string): SpendResult {
    if (!id) return { ok: false, balance: 0, error: '계정이 필요합니다.' }
    if (!Number.isInteger(delta)) return { ok: false, balance: walletOf(id).balance, error: '금액 오류' }
    const w = walletOf(id)
    const next = w.balance + delta
    if (next < 0) return { ok: false, balance: w.balance, error: '코인이 부족합니다.' }
    if (next > MAX_BALANCE) return { ok: false, balance: w.balance, error: '잔액 한도를 초과했습니다.' }
    w.balance = next
    w.updatedAt = now()
    const txn: CoinTxn = { id: randomUUID(), delta, reason, ref, balanceAfter: next, at: w.updatedAt }
    appendLedger(id, txn)
    save()
    return { ok: true, balance: next, txnId: txn.id }
  }

  /** 진행 알바를 done/remaining 파생 포함해 반환. */
  function viewShift(id: string): (JobShift & { done: boolean; remainingMs: number }) | null {
    const s = jobs[id]
    if (!s) return null
    const remainingMs = Math.max(0, s.endAt - now())
    return { ...s, done: remainingMs <= 0, remainingMs }
  }

  /** 현재 근무 중(아직 안 끝난)인 가게 id 집합 — 가게별 1명 독점 UI 표시용. */
  function busyShopIds(): string[] {
    const t = now()
    const busy = new Set<string>()
    for (const s of Object.values(jobs)) if (t < s.endAt) busy.add(s.shopId)
    return [...busy]
  }

  function snapshot(id: string): EconSnapshot {
    const today = dayStr(now())
    const d = daily[id]
    return {
      balance: walletOf(id).balance,
      owned: [...(owned[id] ?? [])],
      job: viewShift(id),
      daily: { claimable: !d || d.lastDate !== today, streak: d?.streak ?? 0 },
      shops: JOB_SHOPS,
      busyShops: busyShopIds(),
      durations: [...JOB_DURATIONS],
      catalog: SHOP_CATALOG,
      ledger: [...(ledger[id] ?? [])].reverse(), // 최신 먼저
      inventory: { ...(inv[id] ?? {}) },
      ingredients: INGREDIENTS,
      recipes: RECIPES,
      fishReadyIn: fishReadyIn(id),
      fishPrices: FISH_PRICES
    }
  }

  return {
    snapshot,
    balanceOf: (id) => walletOf(id).balance,
    applyDelta,

    transfer(fromId, toId, amount, fee) {
      if (!fromId || !toId) return { ok: false, error: '계정이 필요합니다.', fromBalance: 0, toBalance: 0 }
      if (fromId === toId) return { ok: false, error: '자기 자신에게는 이체할 수 없어요.', fromBalance: walletOf(fromId).balance, toBalance: walletOf(toId).balance }
      if (!Number.isInteger(amount) || amount <= 0) return { ok: false, error: '금액 오류', fromBalance: walletOf(fromId).balance, toBalance: walletOf(toId).balance }
      if (!Number.isInteger(fee) || fee < 0 || fee >= amount) return { ok: false, error: '수수료 오류', fromBalance: walletOf(fromId).balance, toBalance: walletOf(toId).balance }
      // 1) 구매자 소각(잔액 부족 시 거부).
      const debit = applyDelta(fromId, -amount, 'buy', toId)
      if (!debit.ok) return { ok: false, error: debit.error, fromBalance: debit.balance, toBalance: walletOf(toId).balance }
      // 2) 창작자 지급(수수료 소각 = 지급액은 amount-fee). 실패 시 구매자 환불(원자성 보전).
      const credit = applyDelta(toId, amount - fee, 'sale', fromId)
      if (!credit.ok) {
        applyDelta(fromId, amount, 'refund', toId) // 롤백
        return { ok: false, error: credit.error, fromBalance: walletOf(fromId).balance, toBalance: credit.balance }
      }
      return { ok: true, fromBalance: debit.balance, toBalance: credit.balance }
    },

    claimDaily(id) {
      if (!id) return { ok: false, balance: 0, error: '계정이 필요합니다.' }
      const today = dayStr(now())
      const d = daily[id]
      if (d && d.lastDate === today) return { ok: false, balance: walletOf(id).balance, error: '오늘은 이미 받았어요.' }
      // 연속 출석: 어제면 streak+1, 아니면 1.
      const yesterday = dayStr(now() - 24 * 60 * 60 * 1000)
      const streak = d && d.lastDate === yesterday ? d.streak + 1 : 1
      const amount = DAILY_BASE + Math.min(streak - 1, DAILY_STREAK_MAX) * DAILY_STREAK_BONUS
      const r = applyDelta(id, amount, 'daily')
      if (!r.ok) return { ok: false, balance: r.balance, error: r.error }
      daily[id] = { lastDate: today, streak }
      save()
      return { ok: true, amount, streak, balance: r.balance }
    },

    startJob(id, shopId, minutes) {
      if (!id) return { ok: false, error: '계정이 필요합니다.' }
      if (jobs[id]) return { ok: false, error: '이미 근무 중이에요.' }
      const shop = JOB_SHOPS.find((s) => s.id === shopId)
      if (!shop) return { ok: false, error: '없는 가게예요.' }
      if (!JOB_DURATIONS.includes(minutes as JobMinutes)) return { ok: false, error: '근무 시간이 올바르지 않아요.' }
      // 가게별 1명 독점 — 다른 계정이 이 가게에서 근무 중(아직 안 끝남)이면 거부.
      const t0 = now()
      for (const [otherId, s] of Object.entries(jobs)) {
        if (otherId !== id && s.shopId === shopId && t0 < s.endAt) {
          return { ok: false, error: '지금은 다른 분이 이 가게에서 근무 중이에요.' }
        }
      }
      const startAt = now()
      const shift: JobShift = {
        accountId: id,
        shopId,
        startAt,
        endAt: startAt + minutes * MINUTE_MS,
        minutes,
        hourlyWage: shop.hourlyWage,
        status: 'working'
      }
      jobs[id] = shift
      save()
      return { ok: true, shift }
    },

    jobOf: (id) => viewShift(id),

    finishJob(id) {
      const s = jobs[id]
      if (!s) return { ok: false, balance: walletOf(id).balance, error: '근무 중이 아니에요.' }
      if (now() < s.endAt) return { ok: false, balance: walletOf(id).balance, error: '아직 근무 시간이 안 끝났어요.' }
      const payout = Math.floor((s.hourlyWage * s.minutes) / 60)
      const r = applyDelta(id, payout, 'job', s.shopId)
      if (!r.ok) return { ok: false, balance: r.balance, error: r.error }
      delete jobs[id]
      save()
      return { ok: true, payout, balance: r.balance }
    },

    cancelJob(id) {
      const had = !!jobs[id]
      if (had) {
        delete jobs[id]
        save()
      }
      return { ok: true, had }
    },

    isWorking: (id) => !!jobs[id],

    buy(id, itemId) {
      if (!id) return { ok: false, balance: 0, error: '계정이 필요합니다.' }
      const item = SHOP_CATALOG.find((s) => s.itemId === itemId)
      if (!item) return { ok: false, balance: walletOf(id).balance, error: '상점에 없는 아이템이에요.' }
      const list = owned[id] ?? (owned[id] = [])
      if (list.includes(itemId)) return { ok: false, balance: walletOf(id).balance, error: '이미 가지고 있어요.' }
      // 구매 코인은 소각(NPC 는 계정이 아님 → transfer 아님). 잔액 부족 시 applyDelta 가 거부.
      const r = applyDelta(id, -item.price, 'buy', itemId)
      if (!r.ok) return { ok: false, balance: r.balance, error: r.error }
      list.push(itemId)
      save()
      return { ok: true, balance: r.balance, owned: [...list] }
    },

    ownedOf: (id) => [...(owned[id] ?? [])],
    isOwned: (id, itemId) => (owned[id] ?? []).includes(itemId),
    isPremium: (itemId) => PREMIUM_IDS.has(itemId),
    canPlace: (id, itemId) => !PREMIUM_IDS.has(itemId) || (owned[id] ?? []).includes(itemId),
    ledgerOf: (id) => [...(ledger[id] ?? [])].reverse(),

    inventoryOf: (id) => ({ ...(inv[id] ?? {}) }),

    castFish(id) {
      if (!id) return { ok: false, error: '계정이 필요합니다.' }
      if (jobs[id]) return { ok: false, error: '근무 중에는 낚시할 수 없어요. 퇴근 후 이용해 주세요.' }
      const ready = fishReadyIn(id)
      if (ready > 0) return { ok: false, readyIn: ready, error: '아직 낚싯대를 던질 수 없어요.' }
      const at = now()
      const biteIn = BITE_MIN_MS + Math.floor(rand() * (BITE_MAX_MS - BITE_MIN_MS))
      fishCasts[id] = { castAt: at, biteAt: at + biteIn } // 기존 세션은 덮어씀(방치 = 포기)
      lastFish[id] = at // 쿨다운은 던진 시점 기산 — 성공·실패·방치와 무관하게 사이클 고정(만료 정산 불필요)
      save()
      return { ok: true, biteIn, pullWindowMs: PULL_WINDOW_MS, cooldownMs: FISH_COOLDOWN_MS }
    },

    pullFish(id) {
      if (!id) return { ok: false, error: '계정이 필요합니다.' }
      const cast = fishCasts[id]
      if (!cast) return { ok: false, error: '던져둔 낚싯대가 없어요. 다시 던져 주세요.' }
      delete fishCasts[id] // 판정은 1회 — 결과와 무관하게 세션 소멸
      const t = now()
      if (t < cast.biteAt) return { ok: true, caught: false, reason: 'early' }
      if (t > cast.biteAt + PULL_WINDOW_MS + PULL_GRACE_MS) return { ok: true, caught: false, reason: 'late' }
      const picked = pickFish()
      const bag = inv[id] ?? (inv[id] = {})
      bag[picked] = Math.min(MAX_STACK, (bag[picked] ?? 0) + 1)
      save()
      return { ok: true, caught: true, item: picked, name: ITEM_NAME.get(picked) ?? picked }
    },

    sellFish(id, itemId) {
      if (!id) return { ok: false, balance: 0, error: '계정이 필요합니다.' }
      if (jobs[id]) return { ok: false, balance: walletOf(id).balance, error: '근무 중에는 판매할 수 없어요. 퇴근 후 이용해 주세요.' }
      if (itemId !== undefined && FISH_PRICES[itemId] === undefined)
        return { ok: false, balance: walletOf(id).balance, error: '팔 수 없는 물건이에요.' }
      const bag = inv[id] ?? {}
      const targets = itemId ? [itemId] : Object.keys(bag).filter((it) => FISH_PRICES[it] !== undefined)
      let total = 0
      for (const it of targets) total += FISH_PRICES[it] * (bag[it] ?? 0)
      if (total <= 0) return { ok: false, balance: walletOf(id).balance, error: '팔 물고기가 없어요.' }
      // 코인 지급 먼저 — 실패(잔액 한도 등) 시 물고기를 보존하고 즉시 반환.
      const r = applyDelta(id, total, 'fish', itemId ?? 'all')
      if (!r.ok) return { ok: false, balance: r.balance, error: r.error }
      for (const it of targets) delete bag[it]
      save()
      return { ok: true, coin: total, balance: r.balance, inventory: { ...bag } }
    },

    cook(id, recipeId) {
      if (!id) return { ok: false, balance: 0, error: '계정이 필요합니다.' }
      if (jobs[id]) return { ok: false, balance: walletOf(id).balance, error: '근무 중에는 요리할 수 없어요. 퇴근 후 이용해 주세요.' }
      const recipe = RECIPES.find((r) => r.id === recipeId)
      if (!recipe) return { ok: false, balance: walletOf(id).balance, error: '없는 레시피예요.' }
      const bag = inv[id] ?? {}
      // 재료 충분한지 먼저 검사(부분 소비 방지).
      for (const [item, qty] of Object.entries(recipe.inputs)) {
        if ((bag[item] ?? 0) < qty) {
          return { ok: false, balance: walletOf(id).balance, error: '재료가 부족해요.' }
        }
      }
      // 코인 보상 먼저 — 실패(잔액 한도 등) 시 재료를 보존하고 즉시 반환(재료 손실 방지).
      const r = applyDelta(id, recipe.coin, 'cook', recipe.id)
      if (!r.ok) return { ok: false, balance: r.balance, error: r.error }
      // 성공 시에만 재료 소비.
      for (const [item, qty] of Object.entries(recipe.inputs)) {
        bag[item] -= qty
        if (bag[item] <= 0) delete bag[item]
      }
      save()
      return { ok: true, coin: recipe.coin, balance: r.balance }
    },

    removeAll(id) {
      if (!id) return
      delete fishCasts[id] // 휘발 세션도 정리(비영속이라 changed 집계 불필요)
      let changed = false
      for (const map of [wallets, jobs, owned, daily, ledger, inv, lastFish] as Record<string, unknown>[]) {
        if (map[id] !== undefined) {
          delete map[id]
          changed = true
        }
      }
      if (changed) save()
    },

    collectAssetRefs() {
      /* 경제는 메타만 — 자산 참조 없음(계약 유지용 no-op) */
    },

    usageFor(id) {
      const payload = { wallet: wallets[id] ?? null, owned: owned[id] ?? [], daily: daily[id] ?? null, ledger: ledger[id] ?? [], inv: inv[id] ?? {} }
      const json = JSON.stringify(payload)
      return { bytes: Buffer.byteLength(json, 'utf8'), refs: new Set<string>() }
    },

    exportFor(id) {
      return {
        wallet: wallets[id] ? { ...wallets[id] } : null,
        owned: [...(owned[id] ?? [])],
        daily: daily[id] ? { ...daily[id] } : null
      }
    },

    importFor(id, data) {
      if (!id || !data || typeof data !== 'object') return
      const o = data as Record<string, unknown>
      let changed = false
      if (o.wallet && typeof o.wallet === 'object') {
        const w = o.wallet as Record<string, unknown>
        const bal = typeof w.balance === 'number' && Number.isFinite(w.balance) ? Math.max(0, Math.min(MAX_BALANCE, Math.floor(w.balance))) : 0
        wallets[id] = { balance: bal, updatedAt: now() }
        changed = true
      }
      if (Array.isArray(o.owned)) {
        owned[id] = (o.owned as unknown[]).filter((x): x is string => typeof x === 'string' && PREMIUM_IDS.has(x)).slice(0, 500)
        changed = true
      }
      if (o.daily && typeof o.daily === 'object') {
        const dy = o.daily as Record<string, unknown>
        if (typeof dy.lastDate === 'string') {
          daily[id] = { lastDate: dy.lastDate.slice(0, 10), streak: typeof dy.streak === 'number' ? Math.max(0, Math.floor(dy.streak)) : 0 }
          changed = true
        }
      }
      if (changed) save()
    }
  }
}
