// 커뮤니티 경제 — 지갑·소지품·상점·뽑기·선물·일괄 지급.
//
// 이 파일의 규칙은 하나다. **상태를 바꾸는 함수 안에는 기다리는 지점을 두지 않는다.**
// Node 는 한 줄로 흐르므로, 동기로 끝나는 본문은 그 자체가 나눌 수 없는 한 덩어리가 된다.
// 잔액을 확인하고 깎는 사이에 다른 요청이 끼어들 수 없으니, 같은 캐릭터로 스무 번을 동시에 눌러도
// 스무 번째에서 잔액이 모자라 멈춘다. 예약 표도 잠금도 쓰지 않는 이유가 이것이다.
//
// 두 번째 규칙은 '잃는 쪽으로 기울지 않는다'이다. 중간에 프로세스가 죽었을 때
// 물건이 겹쳐 보이는 것과 사라지는 것 중 하나를 골라야 하면 언제나 겹치는 쪽을 고른다.
// 겹친 건 기록을 보고 되돌릴 수 있지만, 사라진 건 무엇이 있었는지조차 알 수 없다.
import { randomUUID } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { MAIN_CID, type CommunityStore, type Result } from './community'
import { MAX_G, MAX_INV_CAP, MAX_MAILBOX, type CharDoc, type CommunityCharStore, type InvSlot } from './communityChar'
import type { CommunityCatalog, GachaTable, ItemDef } from './communityCatalog'
import type { CommunityLedger, LedgerItem, LedgerReason } from './communityLedger'
import { GIFT_ITEMS_MAX, type CommunityGiftStore, type Gift, type GiftStatus } from './communityGift'
import type { EffectItem, OutcomeEffect } from './communityGame'

const MAX_BATCH_TARGETS = 1000
const MAX_BATCH_KEEP = 100
const PREVIEW_TTL = 10 * 60 * 1000
/** 이 인원을 넘으면 개별 알림 대신 한 줄 요약만 남긴다 — 알림이 폭주하면 아무도 읽지 않는다. */
const NOTIFY_LIMIT = 100
const MAX_GACHA_PULL = 10

export interface EconView {
  wallet: { g: number; updatedAt: number }
  cap: number
  slots: (InvSlot | null)[]
  mailbox: InvSlot[]
  /** 칸을 줄여 잠긴 자리의 수. 꺼내기만 된다. */
  locked: number
  main: boolean
  pity: Record<string, number>
  dailyReady: boolean
}

export interface GrantContent {
  g?: number
  items?: { defId: string; qty: number }[]
}

export type BatchScope = 'all' | 'role' | 'chars' | 'mains'

export interface BatchSpec {
  kind: 'grant' | 'revoke'
  scope: BatchScope
  roleId: string
  charIds: string[]
  g: number
  items: { defId: string; qty: number }[]
  memo: string
  notifyEach: boolean
}

export interface BatchTarget {
  charId: string
  charName: string
  ownerId: string
  before: number
  after: number
  /** 칸이 없어 임시보관함으로 갈 개수. */
  willMail: number
  /** 회수인데 모자란 양. */
  shortfall: number
  skip: boolean
  reason: string
}

export interface BatchPreview {
  token: string
  spec: BatchSpec
  targets: BatchTarget[]
  warn: { overflow: number; shortfall: number; big: boolean; total: number }
  createdAt: number
}

export interface BatchOp {
  charId: string
  charName: string
  ownerId: string
  g: number
  items: { defId: string; name: string; qty: number }[]
}

export interface Batch {
  id: string
  at: number
  kind: 'grant' | 'revoke'
  byId: string
  byName: string
  memo: string
  /** 이 배치가 되돌린 원본. */
  undoOf: string
  /** 이 배치를 되돌린 배치. */
  undoneBy: string
  done: number
  skipped: number
  notes: string[]
  ops: BatchOp[]
}

export interface GachaResult {
  defId: string
  name: string
  icon: string
  rarity: number
  qty: number
  /** 겹칠 수 없는 물건을 또 뽑아 화폐로 바뀐 경우. */
  convertedG: number
  /** 천장으로 받은 것. */
  fromPity: boolean
  mailed: boolean
}

/** 놀이 결과를 반영한 뒤의 보고서. 화면은 전리품 나열보다 이 변화량을 앞세운다. */
export interface OutcomeApplied {
  g: number
  items: { defId: string; name: string; qty: number }[]
  hp: number
  stats: { key: string; label: string; value: number }[]
  /** 자리가 없어 못 넣은 몫. */
  leftover: EffectItem[]
  mailed: number
}

export interface EconDeps {
  community: CommunityStore
  chars: CommunityCharStore
  catalog: CommunityCatalog
  ledger: CommunityLedger
  gifts: CommunityGiftStore
  dataDir?: string
  persist?: boolean
  /** 0 이상 1 미만. 시험에서 결과를 붙박기 위해 갈아 끼운다. */
  random?: () => number
  /** 당사자에게 알린다(선물 도착·지급·회수). */
  notify?: (accountId: string, text: string, ref?: string) => void
}

export interface CommunityEcon {
  view(charId: string, now: number): EconView | null
  capOf(doc: CharDoc): number

  /** 승인되는 그 순간 한 번만. 다시 승인해도 두 번 주지 않는다. */
  grantInitial(charId: string, now: number): void
  /** 운영 지급·회수(단건). 사유가 없으면 거부한다. */
  adminGive(by: { id: string; name: string }, charId: string, content: GrantContent, memo: string, now: number): Result<EconView>
  adminTake(by: { id: string; name: string }, charId: string, content: GrantContent, memo: string, now: number): Result<EconView>
  setCapBonus(charId: string, bonus: number, now: number): Result<EconView>

  discard(ownerId: string, charId: string, uid: string, qty: number, now: number): Result<EconView>
  moveSlot(ownerId: string, charId: string, from: number, to: number, now: number): Result<EconView>
  fromMailbox(ownerId: string, charId: string, uid: string, now: number): Result<EconView>
  useItem(ownerId: string, charId: string, uid: string, now: number): Result<{ view: EconView; effects: { key: string; value: number }[]; look: string }>
  sellItem(ownerId: string, charId: string, uid: string, qty: number, now: number): Result<{ view: EconView; g: number }>

  buy(ownerId: string, charId: string, entryId: string, qty: number, now: number): Result<{ view: EconView; spent: number; mailed: boolean }>
  gacha(ownerId: string, charId: string, tableId: string, count: number, now: number): Result<{ view: EconView; results: GachaResult[]; pity: number }>
  odds(tableId: string, ownerId: string): Result<{ table: GachaTable; rows: { defId: string; name: string; icon: string; rarity: number; qty: number; chance: number }[]; pity: number; pityAt: number }>

  daily(ownerId: string, charId: string, now: number): Result<{ view: EconView; g: number }>
  /** 글·댓글이 올라올 때 대표 캐릭터에게 자동 정산. 조건이 안 맞으면 조용히 아무 일도 하지 않는다. */
  activity(accountId: string, kind: 'post' | 'comment', now: number): void

  giftOffer(
    ownerId: string,
    input: { fromCharId: string; toCharId: string; g: number; items: { uid: string; qty: number }[]; letter: unknown; image: unknown },
    now: number
  ): Result<Gift>
  giftRespond(ownerId: string, giftId: string, accept: boolean, now: number): Result<Gift>
  giftCancel(ownerId: string, giftId: string, now: number): Result<Gift>
  /** 기한이 지난 상자를 보낸 사람에게 되돌린다. 부팅 때와 주기적으로 부른다. */
  sweepGifts(now: number): number
  /** 이 캐릭터가 얽힌 미결 상자를 전부 되돌린다(보관 처리 시). */
  returnGiftsOf(charId: string, now: number): number

  batchPreview(spec: unknown, now: number): Result<BatchPreview>
  batchRun(by: { id: string; name: string }, token: string, now: number): Result<Batch>
  batchUndo(by: { id: string; name: string }, batchId: string, now: number): Result<Batch>
  /**
   * 놀이 결과를 캐릭터에 반영한다. **반드시 mutate 안에서** 부른다 —
   * 던지면 그 자리에서 통째로 되돌아가고, 반쯤 반영된 상태가 남지 않는다.
   *
   * 자리가 없어 못 넣은 몫은 leftover 로 돌려준다. 부르는 쪽이 그것을 보류로 둘지(퀘스트 수령),
   * 아니면 그 행동 자체를 물릴지(조사 한 칸 열기) 정한다.
   */
  applyOutcome(
    doc: CharDoc,
    effect: OutcomeEffect,
    reason: LedgerReason,
    ref: string,
    now: number,
    opts?: { allowPending?: boolean }
  ): OutcomeApplied

  batches(): Batch[]
  /**
   * 알림 통로를 나중에 꽂는다.
   * 저장소는 진입점이 영속 설정과 함께 만들고, 알림 배선은 릴레이가 쥐고 있어 두 시점이 어긋난다.
   */
  setNotify(fn: (accountId: string, text: string, ref?: string) => void): void

  circulation(): {
    gHeld: number
    gMinted: number
    gBurned: number
    chars: number
    items: { defId: string; name: string; rarity: number; held: number; minted: number; burned: number; sources: number }[]
  }
  flush(): void
}

// ===== 소지품 다루기 =====

function slotsOf(doc: CharDoc, cap: number): (InvSlot | null)[] {
  // 칸이 늘어난 경우를 위해 길이를 맞춘다. 줄어든 경우는 자르지 않는다 — 자르면 물건이 사라진다.
  while (doc.inv.slots.length < cap) doc.inv.slots.push(null)
  return doc.inv.slots
}

function countOf(doc: CharDoc, defId: string): number {
  let n = 0
  for (const s of doc.inv.slots) if (s?.defId === defId) n += s.qty
  return n
}

/** 정의에서 소지품 한 칸을 만든다 — 이름·그림·등급을 그때의 값으로 굳힌다. */
function slotFrom(def: ItemDef, qty: number, now: number): InvSlot {
  return { uid: randomUUID(), defId: def.id, qty, name: def.name, icon: def.icon, rarity: def.rarity, boundAt: now }
}

/**
 * 물건을 넣는다. 같은 것부터 겹치고, 다음에 빈 칸, 그래도 남으면 임시보관함으로.
 * 임시보관함까지 차면 남은 수를 돌려준다 — 부르는 쪽이 그때 판단한다.
 */
function addItems(doc: CharDoc, def: ItemDef, qty: number, cap: number, now: number): { placed: number; mailed: number; over: number } {
  let left = Math.max(0, Math.round(qty))
  let placed = 0
  let mailed = 0
  const slots = slotsOf(doc, cap)
  const stackMax = Math.max(1, def.stackMax)

  if (stackMax > 1) {
    for (let i = 0; i < Math.min(cap, slots.length) && left > 0; i++) {
      const s = slots[i]
      if (!s || s.defId !== def.id || s.qty >= stackMax) continue
      const room = Math.min(stackMax - s.qty, left)
      s.qty += room
      left -= room
      placed += room
    }
  }
  for (let i = 0; i < Math.min(cap, slots.length) && left > 0; i++) {
    if (slots[i]) continue
    const take = Math.min(stackMax, left)
    slots[i] = slotFrom(def, take, now)
    left -= take
    placed += take
  }
  while (left > 0 && doc.inv.mailbox.length < MAX_MAILBOX) {
    const take = Math.min(stackMax, left)
    doc.inv.mailbox.push(slotFrom(def, take, now))
    left -= take
    mailed += take
  }
  return { placed, mailed, over: left }
}

/** 이 수량을 받을 자리가 있는가(임시보관함 포함). */
function roomFor(doc: CharDoc, def: ItemDef, qty: number, cap: number): boolean {
  const stackMax = Math.max(1, def.stackMax)
  let room = 0
  const slots = doc.inv.slots
  for (let i = 0; i < cap; i++) {
    const s = slots[i]
    if (!s) room += stackMax
    else if (s.defId === def.id && s.qty < stackMax) room += stackMax - s.qty
    if (room >= qty) return true
  }
  room += (MAX_MAILBOX - doc.inv.mailbox.length) * stackMax
  return room >= qty
}

/** 정의 id 기준으로 필요한 만큼 뺀다(칸을 가리지 않는다). 모자라면 아무것도 빼지 않고 false. */
function takeByDef(doc: CharDoc, defId: string, qty: number): boolean {
  if (countOf(doc, defId) < qty) return false
  let left = qty
  for (let i = 0; i < doc.inv.slots.length && left > 0; i++) {
    const s = doc.inv.slots[i]
    if (!s || s.defId !== defId) continue
    const take = Math.min(s.qty, left)
    s.qty -= take
    left -= take
    if (s.qty <= 0) doc.inv.slots[i] = null
  }
  return true
}

function findByUid(doc: CharDoc, uid: string): { slot: InvSlot; at: number; where: 'slot' | 'mail' } | null {
  for (let i = 0; i < doc.inv.slots.length; i++) {
    const s = doc.inv.slots[i]
    if (s?.uid === uid) return { slot: s, at: i, where: 'slot' }
  }
  for (let i = 0; i < doc.inv.mailbox.length; i++) {
    const s = doc.inv.mailbox[i]
    if (s?.uid === uid) return { slot: s, at: i, where: 'mail' }
  }
  return null
}

function dayOf(now: number): string {
  const d = new Date(now)
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}

function ledgerItems(list: { defId: string; name: string; qty: number }[], sign: 1 | -1): LedgerItem[] {
  return list.map((i) => ({ defId: i.defId, name: i.name, qty: sign * i.qty }))
}

export function createCommunityEcon(deps: EconDeps): CommunityEcon {
  const { community, chars, catalog, ledger, gifts } = deps
  const persist = deps.persist !== false
  const rand = deps.random ?? Math.random
  let notifyFn = deps.notify ?? ((): void => {})
  const notify = (accountId: string, text: string, ref?: string): void => notifyFn(accountId, text, ref)
  const root = join(deps.dataDir ?? join(process.cwd(), 'data'), 'community', MAIN_CID)
  const batchPath = join(root, 'batches.json')

  let batchLog: Batch[] = []
  const previews = new Map<string, BatchPreview>()
  let batchDirty = false

  if (persist) {
    try {
      if (existsSync(batchPath)) {
        const d = JSON.parse(readFileSync(batchPath, 'utf8'))
        if (Array.isArray(d)) batchLog = d as Batch[]
      }
    } catch (e) {
      console.error('[community/econ] 배치 기록 로드 실패:', e)
    }
  }

  function saveBatches(): void {
    batchDirty = false
    if (!persist) return
    try {
      mkdirSync(root, { recursive: true })
      const tmp = batchPath + '.tmp'
      writeFileSync(tmp, JSON.stringify(batchLog.slice(-MAX_BATCH_KEEP)), 'utf8')
      renameSync(tmp, batchPath)
    } catch (e) {
      console.error('[community/econ] 배치 기록 저장 실패:', e)
    }
  }

  function econSet(): { initialG: number; invCapBase: number; dailyG: number; postG: number; commentG: number; dailyCapG: number; sellBack: boolean; payoutOn: boolean } {
    return (
      community.settings()?.econ ?? {
        initialG: 0,
        invCapBase: 30,
        dailyG: 0,
        postG: 0,
        commentG: 0,
        dailyCapG: 0,
        sellBack: false,
        payoutOn: false
      }
    )
  }

  function capOf(doc: CharDoc): number {
    return Math.min(MAX_INV_CAP, econSet().invCapBase + (doc.inv.capBonus || 0))
  }

  function viewOf(doc: CharDoc, now: number): EconView {
    const cap = capOf(doc)
    const meta = chars.meta(doc.ownerId)
    // 화면용 사본이라 문서를 건드리지 않는다 — 빈 칸은 여기서만 채워 보낸다.
    const slots = doc.inv.slots.slice()
    while (slots.length < cap) slots.push(null)
    // 칸이 줄어 잠긴 자리는 '물건이 든 채로 밀려난 것'만 센다. 빈 자리가 밀려난 건 알릴 일이 아니다.
    let locked = 0
    for (let i = cap; i < slots.length; i++) if (slots[i]) locked++
    return {
      wallet: { ...doc.wallet },
      cap,
      slots,
      mailbox: doc.inv.mailbox.slice(),
      locked,
      main: doc.main,
      pity: { ...meta.pity },
      dailyReady: econSet().dailyG > 0 && meta.dailyDay !== dayOf(now)
    }
  }

  /**
   * 잔액이 움직이는 유일한 자리. 음수와 상한을 여기서만 막으면 새는 곳이 생기지 않는다.
   * 실패는 throw 로 알린다 — 부르는 쪽이 mutate 안에 있어, 던지면 통째로 되돌아간다.
   */
  function applyG(doc: CharDoc, delta: number, now: number): number {
    const d = Math.round(delta)
    if (!Number.isFinite(d)) throw new Error('금액이 올바르지 않습니다.')
    const next = doc.wallet.g + d
    if (next < 0) throw new Error('잔액이 모자랍니다.')
    if (next > MAX_G) throw new Error('가질 수 있는 한도를 넘습니다.')
    doc.wallet.g = next
    doc.wallet.updatedAt = now
    return next
  }

  function record(
    doc: CharDoc,
    reason: LedgerReason,
    now: number,
    extra: { g?: number; items?: LedgerItem[]; ref?: string; byId?: string; byName?: string; memo?: string }
  ): void {
    ledger.append(
      {
        charId: doc.id,
        charName: doc.name,
        ownerId: doc.ownerId,
        reason,
        balance: doc.wallet.g,
        ...extra
      },
      now
    )
  }

  /** 지급 내용을 실제로 반영한다. 자리가 없으면 임시보관함으로 가고, 그것도 차면 던진다. */
  function applyGive(doc: CharDoc, content: GrantContent, now: number): { g: number; items: { defId: string; name: string; qty: number }[]; mailed: number } {
    const cap = capOf(doc)
    const out: { defId: string; name: string; qty: number }[] = []
    let mailed = 0
    const g = Math.round(content.g ?? 0)
    if (g) applyG(doc, g, now)
    for (const it of content.items ?? []) {
      const def = catalog.item(it.defId)
      if (!def) continue
      const qty = Math.max(1, Math.round(it.qty))
      const r = addItems(doc, def, qty, cap, now)
      if (r.over > 0) throw new Error(`${doc.name}: 소지품과 임시보관함이 모두 찼습니다.`)
      mailed += r.mailed
      out.push({ defId: def.id, name: def.name, qty })
    }
    return { g, items: out, mailed }
  }

  /** 회수. 모자라면 얼마가 모자란지 알려 준다(전부 무효로 만들지 않기 위해). */
  function applyTake(doc: CharDoc, content: GrantContent, now: number): { g: number; items: { defId: string; name: string; qty: number }[] } {
    const out: { defId: string; name: string; qty: number }[] = []
    const want = Math.round(content.g ?? 0)
    const g = Math.min(want, doc.wallet.g)
    if (g > 0) applyG(doc, -g, now)
    for (const it of content.items ?? []) {
      const def = catalog.item(it.defId)
      if (!def) continue
      const have = countOf(doc, it.defId)
      const qty = Math.min(Math.max(1, Math.round(it.qty)), have)
      if (qty <= 0) continue
      takeByDef(doc, it.defId, qty)
      out.push({ defId: it.defId, name: def.name, qty })
    }
    return { g, items: out }
  }

  function viewResult(charId: string, now: number): EconView | null {
    const doc = chars.get(charId)
    return doc ? viewOf(doc, now) : null
  }

  // ===== 선물 되돌리기 =====

  /** 상자에 든 것을 보낸 캐릭터에게 되돌린다. 칸이 없으면 임시보관함으로 간다. */
  function refund(gift: Gift, status: Exclude<GiftStatus, 'pending' | 'accepted'>, now: number): boolean {
    const target = chars.get(gift.fromCharId)
    if (!target) {
      // 보낸 캐릭터가 사라졌으면 되돌릴 곳이 없다. 상자만 닫고 기록에 남긴다.
      gifts.resolve(gift.id, status, now)
      return false
    }
    const items = gift.items.slice()
    const g = gift.g
    const r = chars.mutateAny(gift.fromCharId, now, (doc) => {
      const cap = capOf(doc)
      if (g) applyG(doc, g, now)
      for (const s of items) {
        const def = catalog.item(s.defId)
        // 정의가 사라진 물건도 그대로 돌려준다 — 사본으로 들고 있으므로 표시에 문제가 없다.
        if (def) {
          const res = addItems(doc, def, s.qty, cap, now)
          if (res.over > 0) doc.inv.mailbox.push({ ...s, uid: randomUUID() })
        } else if (doc.inv.mailbox.length < MAX_MAILBOX) {
          doc.inv.mailbox.push({ ...s, uid: randomUUID() })
        }
      }
      record(doc, 'gift-refund', now, {
        g: g || undefined,
        items: ledgerItems(items.map((s) => ({ defId: s.defId, name: s.name, qty: s.qty })), 1),
        ref: gift.id
      })
      return true
    })
    if (!r.ok) return false
    gifts.resolve(gift.id, status, now)
    return true
  }

  return {
    capOf,
    view: (charId, now) => viewResult(charId, now),

    grantInitial(charId, now) {
      const amount = econSet().initialG
      chars.mutateAny(charId, now, (doc) => {
        if (doc.initialGranted) return
        doc.initialGranted = true
        if (amount > 0) {
          applyG(doc, amount, now)
          record(doc, 'initial', now, { g: amount })
        }
      })
    },

    adminGive(by, charId, content, memo, now) {
      if (!memo.trim()) return { ok: false, error: '사유를 입력해 주세요.' }
      const r = chars.mutateAny(charId, now, (doc) => {
        const applied = applyGive(doc, content, now)
        record(doc, 'admin', now, {
          g: applied.g || undefined,
          items: ledgerItems(applied.items, 1),
          byId: by.id,
          byName: by.name,
          memo
        })
        return { ownerId: doc.ownerId, name: doc.name, mailed: applied.mailed, applied }
      })
      if (!r.ok) return { ok: false, error: r.error }
      const parts = [r.value.applied.g ? `${r.value.applied.g} G` : '', ...r.value.applied.items.map((i) => `${i.name} ${i.qty}`)].filter(Boolean)
      notify(r.value.ownerId, `${r.value.name}에게 지급: ${parts.join(', ')} (${memo})`, charId)
      return { ok: true, value: viewResult(charId, now) as EconView }
    },

    adminTake(by, charId, content, memo, now) {
      if (!memo.trim()) return { ok: false, error: '사유를 입력해 주세요.' }
      const r = chars.mutateAny(charId, now, (doc) => {
        const applied = applyTake(doc, content, now)
        if (!applied.g && !applied.items.length) throw new Error('회수할 것이 없습니다.')
        record(doc, 'admin', now, {
          g: applied.g ? -applied.g : undefined,
          items: ledgerItems(applied.items, -1),
          byId: by.id,
          byName: by.name,
          memo
        })
        return { ownerId: doc.ownerId, name: doc.name, applied }
      })
      if (!r.ok) return { ok: false, error: r.error }
      const parts = [r.value.applied.g ? `${r.value.applied.g} G` : '', ...r.value.applied.items.map((i) => `${i.name} ${i.qty}`)].filter(Boolean)
      notify(r.value.ownerId, `${r.value.name}에게서 회수: ${parts.join(', ')} (${memo})`, charId)
      return { ok: true, value: viewResult(charId, now) as EconView }
    },

    setCapBonus(charId, bonus, now) {
      const r = chars.mutateAny(charId, now, (doc) => {
        doc.inv.capBonus = Math.min(MAX_INV_CAP, Math.max(0, Math.round(bonus)))
      })
      if (!r.ok) return { ok: false, error: r.error }
      return { ok: true, value: viewResult(charId, now) as EconView }
    },

    discard(ownerId, charId, uid, qty, now) {
      const r = chars.mutateOwned(ownerId, charId, now, (doc) => {
        const hit = findByUid(doc, uid)
        if (!hit) throw new Error('없는 물건입니다.')
        const def = catalog.item(hit.slot.defId)
        if (def && !def.deletable) throw new Error('버릴 수 없는 물건입니다.')
        const take = Math.min(hit.slot.qty, Math.max(1, Math.round(qty)))
        hit.slot.qty -= take
        if (hit.slot.qty <= 0) {
          if (hit.where === 'slot') doc.inv.slots[hit.at] = null
          else doc.inv.mailbox.splice(hit.at, 1)
        }
        record(doc, 'discard', now, { items: [{ defId: hit.slot.defId, name: hit.slot.name, qty: -take }] })
      })
      if (!r.ok) return { ok: false, error: r.error }
      return { ok: true, value: viewResult(charId, now) as EconView }
    },

    moveSlot(ownerId, charId, from, to, now) {
      const r = chars.mutateOwned(ownerId, charId, now, (doc) => {
        const cap = capOf(doc)
        const slots = slotsOf(doc, cap)
        // 잠긴 자리에서 꺼내는 것은 되고, 그리로 넣는 것은 막는다.
        if (from < 0 || from >= slots.length || to < 0 || to >= cap) throw new Error('옮길 수 없는 자리입니다.')
        const a = slots[from]
        const b = slots[to]
        slots[to] = a
        slots[from] = b
      })
      if (!r.ok) return { ok: false, error: r.error }
      return { ok: true, value: viewResult(charId, now) as EconView }
    },

    fromMailbox(ownerId, charId, uid, now) {
      const r = chars.mutateOwned(ownerId, charId, now, (doc) => {
        const i = doc.inv.mailbox.findIndex((s) => s.uid === uid)
        if (i < 0) throw new Error('임시보관함에 없는 물건입니다.')
        const slot = doc.inv.mailbox[i]
        const def = catalog.item(slot.defId)
        const cap = capOf(doc)
        const slots = slotsOf(doc, cap)
        if (def && Math.max(1, def.stackMax) > 1) {
          for (let k = 0; k < cap && slot.qty > 0; k++) {
            const s = slots[k]
            if (!s || s.defId !== slot.defId || s.qty >= def.stackMax) continue
            const room = Math.min(def.stackMax - s.qty, slot.qty)
            s.qty += room
            slot.qty -= room
          }
        }
        if (slot.qty > 0) {
          const empty = slots.findIndex((s, k) => k < cap && !s)
          if (empty < 0) throw new Error('소지품에 빈 칸이 없습니다.')
          slots[empty] = slot
        }
        doc.inv.mailbox.splice(i, 1)
      })
      if (!r.ok) return { ok: false, error: r.error }
      return { ok: true, value: viewResult(charId, now) as EconView }
    },

    useItem(ownerId, charId, uid, now) {
      const applied: { key: string; value: number }[] = []
      let look = ''
      const r = chars.mutateOwned(ownerId, charId, now, (doc) => {
        const hit = findByUid(doc, uid)
        if (!hit) throw new Error('없는 물건입니다.')
        const def = catalog.item(hit.slot.defId)
        if (!def) throw new Error('쓸 수 없는 물건입니다.')
        if (!def.usable && !def.look) throw new Error('쓸 수 있는 물건이 아닙니다.')

        if (def.look) {
          if (doc.looks.some((l) => l.fullBody === def.look?.fullBody)) throw new Error('이미 가진 모습입니다.')
          if (doc.looks.length >= 20) throw new Error('옷장이 가득 찼습니다.')
          const id = randomUUID()
          doc.looks.push({ id, label: def.look.label, fullBody: def.look.fullBody })
          look = id
        }
        // 능력치 효과는 캐릭터 양식에 그 칸이 있을 때만 듣는다. 없으면 조용히 넘어간다.
        for (const e of def.effects) {
          const cur = typeof doc.stats[e.statKey] === 'number' ? (doc.stats[e.statKey] as number) : null
          if (cur === null) continue
          doc.stats[e.statKey] = cur + e.delta
          applied.push({ key: e.statKey, value: cur + e.delta })
        }
        // 효과가 양식의 최대치를 넘겨 버리지 않도록 같은 구간 안에서 다듬는다.
        const schema = chars.schema()
        for (const a of applied) {
          const f = schema.fields.find((x) => x.key === a.key)
          if (!f) continue
          a.value = Math.min(f.max, Math.max(f.min, a.value))
          doc.stats[a.key] = a.value
        }
        hit.slot.qty -= 1
        if (hit.slot.qty <= 0) {
          if (hit.where === 'slot') doc.inv.slots[hit.at] = null
          else doc.inv.mailbox.splice(hit.at, 1)
        }
        record(doc, 'use', now, { items: [{ defId: def.id, name: def.name, qty: -1 }] })
      })
      if (!r.ok) return { ok: false, error: r.error }
      return { ok: true, value: { view: viewResult(charId, now) as EconView, effects: applied, look } }
    },

    sellItem(ownerId, charId, uid, qty, now) {
      if (!econSet().sellBack) return { ok: false, error: '되팔기를 쓰지 않는 커뮤니티입니다.' }
      let gained = 0
      const r = chars.mutateOwned(ownerId, charId, now, (doc) => {
        const hit = findByUid(doc, uid)
        if (!hit) throw new Error('없는 물건입니다.')
        const def = catalog.item(hit.slot.defId)
        if (!def || def.sellBack <= 0) throw new Error('되팔 수 없는 물건입니다.')
        const take = Math.min(hit.slot.qty, Math.max(1, Math.round(qty)))
        gained = def.sellBack * take
        hit.slot.qty -= take
        if (hit.slot.qty <= 0) {
          if (hit.where === 'slot') doc.inv.slots[hit.at] = null
          else doc.inv.mailbox.splice(hit.at, 1)
        }
        applyG(doc, gained, now)
        record(doc, 'sell', now, { g: gained, items: [{ defId: def.id, name: def.name, qty: -take }] })
      })
      if (!r.ok) return { ok: false, error: r.error }
      return { ok: true, value: { view: viewResult(charId, now) as EconView, g: gained } }
    },

    buy(ownerId, charId, entryId, qty, now) {
      const entry = catalog.entry(entryId)
      if (!entry) return { ok: false, error: '진열을 찾을 수 없습니다.' }
      const shop = catalog.shops().find((s) => s.id === entry.shopId)
      const def = catalog.item(entry.defId)
      if (!def) return { ok: false, error: '아이템을 찾을 수 없습니다.' }
      const count = Math.min(99, Math.max(1, Math.round(qty)))

      // 값은 진열의 것만 쓴다 — 클라가 보낸 가격은 보지 않는다.
      if (!entry.enabled || !shop?.enabled) return { ok: false, error: '지금은 살 수 없는 물건입니다.' }
      if (entry.from && now < entry.from) return { ok: false, error: '아직 열리지 않은 진열입니다.' }
      if (entry.to && now > entry.to) return { ok: false, error: '기간이 끝난 진열입니다.' }
      if (entry.stock >= 0 && entry.stock < count) return { ok: false, error: '재고가 모자랍니다.' }

      let mailed = false
      const spent = entry.priceG * count
      // 상한은 계정과 캐릭터 둘 다에 센다. 계정 쪽이 없으면 부캐를 만들어 얼마든지 우회할 수 있다.
      const charKey = `${entryId}|${charId}`
      const r = chars.mutateOwned(ownerId, charId, now, (doc, meta) => {
        const boughtOwner = meta.buys[entryId] ?? 0
        const boughtChar = meta.buys[charKey] ?? 0
        if (entry.limitPerOwner > 0 && boughtOwner + count > entry.limitPerOwner) {
          throw new Error(`계정당 ${entry.limitPerOwner}개까지 살 수 있습니다.`)
        }
        if (entry.limitPerChar > 0 && boughtChar + count > entry.limitPerChar) {
          throw new Error(`캐릭터당 ${entry.limitPerChar}개까지 살 수 있습니다.`)
        }
        const total = entry.qty * count
        if (!roomFor(doc, def, total, capOf(doc))) throw new Error('소지품에 넣을 자리가 없습니다.')
        for (const c of entry.costItems) {
          if (countOf(doc, c.defId) < c.qty * count) throw new Error('교환할 아이템이 모자랍니다.')
        }
        if (spent > 0) applyG(doc, -spent, now)
        const paid: { defId: string; name: string; qty: number }[] = []
        for (const c of entry.costItems) {
          takeByDef(doc, c.defId, c.qty * count)
          paid.push({ defId: c.defId, name: catalog.item(c.defId)?.name ?? '', qty: c.qty * count })
        }
        const res = addItems(doc, def, total, capOf(doc), now)
        mailed = res.mailed > 0
        meta.buys[entryId] = boughtOwner + count
        meta.buys[charKey] = boughtChar + count
        record(doc, 'buy', now, {
          g: spent ? -spent : undefined,
          items: [...ledgerItems(paid, -1), { defId: def.id, name: def.name, qty: total }],
          ref: entryId
        })
      })
      if (!r.ok) return { ok: false, error: r.error }
      catalog.bumpSold(entryId, count)
      return { ok: true, value: { view: viewResult(charId, now) as EconView, spent, mailed } }
    },

    gacha(ownerId, charId, tableId, count, now) {
      const table = catalog.table(tableId)
      if (!table || !table.enabled) return { ok: false, error: '지금은 돌릴 수 없습니다.' }
      const pulls = Math.min(MAX_GACHA_PULL, Math.max(1, Math.round(count)))
      const total = table.entries.reduce((a, e) => a + e.weight, 0)
      if (total <= 0) return { ok: false, error: '뽑기 표가 비어 있습니다.' }

      const results: GachaResult[] = []
      let pityAfter = 0
      const r = chars.mutateOwned(ownerId, charId, now, (doc, meta) => {
        const costG = table.priceG * pulls
        if (costG > 0) applyG(doc, -costG, now)
        if (table.costItem) {
          const need = table.costItem.qty * pulls
          if (!takeByDef(doc, table.costItem.defId, need)) throw new Error('뽑기에 쓸 아이템이 모자랍니다.')
        }
        const cap = capOf(doc)
        const gained: LedgerItem[] = []
        let convertTotal = 0

        for (let i = 0; i < pulls; i++) {
          let pick: { defId: string; qty: number } | null = null
          let fromPity = false
          const counter = (meta.pity[tableId] ?? 0) + 1
          if (table.pity > 0 && counter >= table.pity) {
            pick = { defId: table.pityDefId, qty: table.pityQty }
            fromPity = true
            meta.pity[tableId] = 0
          } else {
            meta.pity[tableId] = counter
            let roll = rand() * total
            for (const e of table.entries) {
              roll -= e.weight
              if (roll <= 0) {
                pick = { defId: e.defId, qty: e.qty }
                break
              }
            }
            if (!pick) pick = { defId: table.entries[table.entries.length - 1].defId, qty: table.entries[table.entries.length - 1].qty }
          }
          const def = catalog.item(pick.defId)
          if (!def) continue

          // 겹칠 수 없는 물건을 또 뽑으면 화폐로 바꿔 준다 — 빈손으로 만들지 않는다.
          const duplicate = def.stackMax <= 1 && (countOf(doc, def.id) > 0 || results.some((x) => x.defId === def.id && !x.convertedG))
          if (duplicate && def.sellBack > 0) {
            applyG(doc, def.sellBack * pick.qty, now)
            convertTotal += def.sellBack * pick.qty
            results.push({ defId: def.id, name: def.name, icon: def.icon, rarity: def.rarity, qty: pick.qty, convertedG: def.sellBack * pick.qty, fromPity, mailed: false })
            continue
          }
          const res = addItems(doc, def, pick.qty, cap, now)
          if (res.over > 0) throw new Error('소지품과 임시보관함이 모두 찼습니다.')
          gained.push({ defId: def.id, name: def.name, qty: pick.qty })
          results.push({ defId: def.id, name: def.name, icon: def.icon, rarity: def.rarity, qty: pick.qty, convertedG: 0, fromPity, mailed: res.mailed > 0 })
        }
        pityAfter = meta.pity[tableId] ?? 0
        record(doc, 'gacha', now, {
          g: convertTotal - table.priceG * pulls || undefined,
          items: gained,
          ref: tableId,
          memo: table.tableHash
        })
      })
      if (!r.ok) return { ok: false, error: r.error }
      return { ok: true, value: { view: viewResult(charId, now) as EconView, results, pity: pityAfter } }
    },

    odds(tableId, ownerId) {
      const table = catalog.table(tableId)
      if (!table) return { ok: false, error: '뽑기를 찾을 수 없습니다.' }
      const total = table.entries.reduce((a, e) => a + e.weight, 0) || 1
      const rows = table.entries.map((e) => {
        const def = catalog.item(e.defId)
        return {
          defId: e.defId,
          name: def?.name ?? '',
          icon: def?.icon ?? '',
          rarity: def?.rarity ?? 1,
          qty: e.qty,
          chance: e.weight / total
        }
      })
      rows.sort((a, b) => b.rarity - a.rarity || b.chance - a.chance)
      return { ok: true, value: { table, rows, pity: chars.meta(ownerId).pity[tableId] ?? 0, pityAt: table.pity } }
    },

    daily(ownerId, charId, now) {
      const amount = econSet().dailyG
      if (amount <= 0) return { ok: false, error: '출석 보상을 쓰지 않는 커뮤니티입니다.' }
      const today = dayOf(now)
      const r = chars.mutateOwned(ownerId, charId, now, (doc, meta) => {
        if (meta.dailyDay === today) throw new Error('오늘은 이미 받았습니다.')
        meta.dailyDay = today
        applyG(doc, amount, now)
        record(doc, 'daily', now, { g: amount })
      })
      if (!r.ok) return { ok: false, error: r.error }
      return { ok: true, value: { view: viewResult(charId, now) as EconView, g: amount } }
    },

    activity(accountId, kind, now) {
      const set = econSet()
      const amount = kind === 'post' ? set.postG : set.commentG
      if (!set.payoutOn || amount <= 0) return
      const main = chars.mainOf(accountId)
      // 대표를 정하지 않았으면 어디로 넣을지 알 수 없다. 화면에서 안내만 하고 여기서는 넘어간다.
      if (!main) return
      const today = dayOf(now)
      chars.mutateOwned(accountId, main.id, now, (doc, meta) => {
        if (meta.earnedDay !== today) {
          meta.earnedDay = today
          meta.earnedG = 0
        }
        if (set.dailyCapG > 0 && meta.earnedG >= set.dailyCapG) return
        const give = set.dailyCapG > 0 ? Math.min(amount, set.dailyCapG - meta.earnedG) : amount
        if (give <= 0) return
        meta.earnedG += give
        applyG(doc, give, now)
        record(doc, 'activity', now, { g: give, memo: kind === 'post' ? '글' : '댓글' })
      })
    },

    giftOffer(ownerId, input, now) {
      const from = chars.get(input.fromCharId)
      const to = chars.get(input.toCharId)
      if (!from || !to) return { ok: false, error: '캐릭터를 찾을 수 없습니다.' }
      if (from.ownerId !== ownerId) return { ok: false, error: '내 캐릭터에서만 보낼 수 있습니다.' }
      if (from.id === to.id) return { ok: false, error: '자기 자신에게는 보낼 수 없습니다.' }
      if (to.status === 'retired') return { ok: false, error: '보관된 캐릭터에게는 보낼 수 없습니다.' }
      if (gifts.pendingOut(from.id) >= 10) return { ok: false, error: '아직 답을 못 받은 선물이 너무 많습니다.' }
      if (gifts.pendingIn(to.id) >= 30) return { ok: false, error: '상대의 선물함이 가득 찼습니다.' }

      const wantItems = (Array.isArray(input.items) ? input.items : []).slice(0, GIFT_ITEMS_MAX)
      const wantG = Math.max(0, Math.round(input.g) || 0)
      if (!wantG && !wantItems.length) return { ok: false, error: '보낼 것을 골라 주세요.' }

      const r = chars.mutateOwned(ownerId, input.fromCharId, now, (doc): Gift => {
        const escrow: InvSlot[] = []
        for (const w of wantItems) {
          const hit = findByUid(doc, w.uid)
          if (!hit) throw new Error('없는 물건이 섞여 있습니다.')
          const def = catalog.item(hit.slot.defId)
          if (def && !def.tradable) throw new Error(`${hit.slot.name}은(는) 건넬 수 없는 물건입니다.`)
          const take = Math.min(hit.slot.qty, Math.max(1, Math.round(w.qty)))
          escrow.push({ ...hit.slot, uid: randomUUID(), qty: take })
          hit.slot.qty -= take
          if (hit.slot.qty <= 0) {
            if (hit.where === 'slot') doc.inv.slots[hit.at] = null
            else doc.inv.mailbox.splice(hit.at, 1)
          }
        }
        if (wantG) applyG(doc, -wantG, now)

        // 상자를 먼저 만든 뒤 보내는 쪽 파일이 쓰인다. 어느 지점에서 멈춰도 물건이 사라지지 않는 순서다.
        const created = gifts.create(
          {
            fromCharId: from.id,
            fromCharName: from.name,
            fromOwnerId: from.ownerId,
            toCharId: to.id,
            toCharName: to.name,
            toOwnerId: to.ownerId,
            g: wantG,
            items: escrow,
            letter: input.letter,
            image: input.image
          },
          now
        )
        record(doc, 'gift-out', now, {
          g: wantG ? -wantG : undefined,
          items: ledgerItems(escrow.map((s) => ({ defId: s.defId, name: s.name, qty: s.qty })), -1),
          ref: created.id
        })
        return created
      })
      if (!r.ok) return { ok: false, error: r.error }
      notify(to.ownerId, `${from.name}이(가) ${to.name}에게 선물을 보냈습니다.`, r.value.id)
      return { ok: true, value: r.value }
    },

    giftRespond(ownerId, giftId, accept, now) {
      const gift = gifts.get(giftId)
      if (!gift) return { ok: false, error: '선물을 찾을 수 없습니다.' }
      if (gift.toOwnerId !== ownerId) return { ok: false, error: '내게 온 선물이 아닙니다.' }
      if (gift.status !== 'pending') return { ok: false, error: '이미 처리된 선물입니다.' }

      if (!accept) {
        if (!refund(gift, 'declined', now)) return { ok: false, error: '되돌리지 못했습니다.' }
        const done = gifts.get(giftId)
        notify(gift.fromOwnerId, `${gift.toCharName}이(가) 선물을 사양했습니다.`, giftId)
        return { ok: true, value: done ?? gift }
      }

      const items = gift.items.slice()
      const g = gift.g
      // 순서가 중요하다 — 받는 쪽 소지품을 먼저 확정하고, 그 다음에 상자를 닫는다.
      // 반대로 하면 그 사이에 멈췄을 때 물건이 아무 데도 없게 된다.
      const r = chars.mutateAny(gift.toCharId, now, (doc) => {
        if (doc.ownerId !== ownerId) throw new Error('내 캐릭터가 아닙니다.')
        const cap = capOf(doc)
        if (g) applyG(doc, g, now)
        for (const s of items) {
          const def = catalog.item(s.defId)
          if (def) {
            const res = addItems(doc, def, s.qty, cap, now)
            if (res.over > 0) throw new Error('소지품과 임시보관함이 모두 찼습니다.')
          } else if (doc.inv.mailbox.length < MAX_MAILBOX) {
            doc.inv.mailbox.push({ ...s, uid: randomUUID() })
          } else {
            throw new Error('임시보관함이 가득 찼습니다.')
          }
        }
        record(doc, 'gift-in', now, {
          g: g || undefined,
          items: ledgerItems(items.map((s) => ({ defId: s.defId, name: s.name, qty: s.qty })), 1),
          ref: giftId
        })
      })
      if (!r.ok) return { ok: false, error: r.error }
      const done = gifts.resolve(giftId, 'accepted', now)
      notify(gift.fromOwnerId, `${gift.toCharName}이(가) 선물을 받았습니다.`, giftId)
      return done.ok ? { ok: true, value: done.value } : { ok: false, error: done.error }
    },

    giftCancel(ownerId, giftId, now) {
      const gift = gifts.get(giftId)
      if (!gift) return { ok: false, error: '선물을 찾을 수 없습니다.' }
      if (gift.fromOwnerId !== ownerId) return { ok: false, error: '내가 보낸 선물이 아닙니다.' }
      if (gift.status !== 'pending') return { ok: false, error: '이미 처리된 선물입니다.' }
      if (!refund(gift, 'cancelled', now)) return { ok: false, error: '되돌리지 못했습니다.' }
      const done = gifts.get(giftId)
      return { ok: true, value: done ?? gift }
    },

    sweepGifts(now) {
      let n = 0
      for (const b of gifts.overdue(now)) {
        const gift = gifts.get(b.id)
        if (!gift) continue
        if (refund(gift, 'expired', now)) {
          notify(gift.fromOwnerId, `${gift.toCharName}에게 보낸 선물이 기한이 지나 돌아왔습니다.`, gift.id)
          n++
        }
      }
      return n
    },

    returnGiftsOf(charId, now) {
      let n = 0
      for (const b of gifts.pendingOf(charId)) {
        const gift = gifts.get(b.id)
        if (!gift) continue
        if (refund(gift, 'cancelled', now)) n++
      }
      return n
    },

    batchPreview(specRaw, now) {
      const r = (specRaw && typeof specRaw === 'object' ? specRaw : {}) as Record<string, unknown>
      const kind = r.kind === 'revoke' ? 'revoke' : 'grant'
      const scope: BatchScope =
        r.scope === 'role' || r.scope === 'chars' || r.scope === 'mains' ? r.scope : 'all'
      const memo = typeof r.memo === 'string' ? r.memo.trim().slice(0, 200) : ''
      if (!memo) return { ok: false, error: '사유를 입력해 주세요.' }
      const g = Math.max(0, Math.round(Number(r.g) || 0))
      const items: { defId: string; qty: number }[] = []
      for (const raw of Array.isArray(r.items) ? r.items.slice(0, 10) : []) {
        const x = (raw ?? {}) as Record<string, unknown>
        const defId = typeof x.defId === 'string' ? x.defId : ''
        const qty = Math.max(1, Math.round(Number(x.qty) || 0))
        if (catalog.item(defId)) items.push({ defId, qty })
      }
      if (!g && !items.length) return { ok: false, error: '지급하거나 회수할 것을 정해 주세요.' }

      const charIds = (Array.isArray(r.charIds) ? r.charIds : []).filter((x): x is string => typeof x === 'string').slice(0, MAX_BATCH_TARGETS)
      const roleId = typeof r.roleId === 'string' ? r.roleId : ''
      const spec: BatchSpec = { kind, scope, roleId, charIds, g, items, memo, notifyEach: r.notifyEach !== false }

      let pool = chars.all().filter((c) => c.status === 'approved')
      if (scope === 'chars') pool = pool.filter((c) => charIds.includes(c.id))
      else if (scope === 'mains') pool = pool.filter((c) => c.main)
      else if (scope === 'role') {
        pool = pool.filter((c) => community.member(c.ownerId)?.roleId === roleId)
      }
      if (pool.length > MAX_BATCH_TARGETS) pool = pool.slice(0, MAX_BATCH_TARGETS)

      const targets: BatchTarget[] = pool.map((doc) => {
        const cap = capOf(doc)
        let willMail = 0
        let shortfall = 0
        let skip = false
        let reason = ''
        if (kind === 'grant') {
          // 자리를 산술로 어림하지 않고 사본에 실제로 넣어 본다.
          // 겹치기·빈칸·임시보관함이 얽혀 있어, 계산으로 맞히려 들면 미리보기와 실행이 어긋난다.
          const sim = JSON.parse(JSON.stringify(doc)) as CharDoc
          for (const it of items) {
            const def = catalog.item(it.defId)
            if (!def) continue
            const res = addItems(sim, def, it.qty, cap, now)
            willMail += res.mailed
            if (res.over > 0) {
              skip = true
              reason = '소지품과 임시보관함이 모두 찼습니다.'
            }
          }
          if (doc.wallet.g + g > MAX_G) {
            skip = true
            reason = '가질 수 있는 한도를 넘습니다.'
          }
        } else {
          if (doc.wallet.g < g) shortfall += g - doc.wallet.g
          for (const it of items) {
            const have = countOf(doc, it.defId)
            if (have < it.qty) shortfall += it.qty - have
          }
          if (shortfall > 0 && doc.wallet.g === 0 && items.every((it) => countOf(doc, it.defId) === 0)) {
            skip = true
            reason = '가진 것이 없습니다.'
          }
        }
        return {
          charId: doc.id,
          charName: doc.name,
          ownerId: doc.ownerId,
          before: doc.wallet.g,
          after: kind === 'grant' ? Math.min(MAX_G, doc.wallet.g + g) : Math.max(0, doc.wallet.g - g),
          willMail,
          shortfall,
          skip,
          reason
        }
      })

      const preview: BatchPreview = {
        token: randomUUID(),
        spec,
        targets,
        warn: {
          overflow: targets.filter((t) => t.willMail > 0).length,
          shortfall: targets.filter((t) => t.shortfall > 0).length,
          big: targets.length > NOTIFY_LIMIT,
          total: targets.length
        },
        createdAt: now
      }
      // 오래된 미리보기는 흘려보낸다 — 잊힌 승인으로 나중에 실행되면 안 된다.
      for (const [k, v] of previews) if (now - v.createdAt > PREVIEW_TTL) previews.delete(k)
      previews.set(preview.token, preview)
      return { ok: true, value: preview }
    },

    batchRun(by, token, now) {
      const preview = previews.get(token)
      // 미리보기를 거치지 않은 실행은 아예 받지 않는다. 대상이 몇 명인지 모르는 채로 도는 일이 없게.
      if (!preview) return { ok: false, error: '미리보기를 먼저 확인해 주세요.' }
      if (now - preview.createdAt > PREVIEW_TTL) {
        previews.delete(token)
        return { ok: false, error: '미리보기가 오래돼 다시 확인해야 합니다.' }
      }
      previews.delete(token)

      const { spec } = preview
      const batch: Batch = {
        id: randomUUID(),
        at: now,
        kind: spec.kind,
        byId: by.id,
        byName: by.name,
        memo: spec.memo,
        undoOf: '',
        undoneBy: '',
        done: 0,
        skipped: 0,
        notes: [],
        ops: []
      }
      const notifyEach = spec.notifyEach && preview.targets.length <= NOTIFY_LIMIT

      chars.bulk(() => {
        for (const t of preview.targets) {
          if (t.skip) {
            batch.skipped++
            if (batch.notes.length < 50) batch.notes.push(`${t.charName}: ${t.reason}`)
            continue
          }
          const r = chars.mutateAny(t.charId, now, (doc) => {
            const applied =
              spec.kind === 'grant'
                ? applyGive(doc, { g: spec.g, items: spec.items }, now)
                : applyTake(doc, { g: spec.g, items: spec.items }, now)
            if (!applied.g && !applied.items.length) throw new Error('반영할 것이 없습니다.')
            record(doc, 'admin', now, {
              g: applied.g ? (spec.kind === 'grant' ? applied.g : -applied.g) : undefined,
              items: ledgerItems(applied.items, spec.kind === 'grant' ? 1 : -1),
              ref: batch.id,
              byId: by.id,
              byName: by.name,
              memo: spec.memo
            })
            return applied
          })
          if (!r.ok) {
            batch.skipped++
            if (batch.notes.length < 50) batch.notes.push(`${t.charName}: ${r.error}`)
            continue
          }
          batch.done++
          batch.ops.push({ charId: t.charId, charName: t.charName, ownerId: t.ownerId, g: r.value.g, items: r.value.items })
          if (notifyEach) {
            const word = spec.kind === 'grant' ? '지급' : '회수'
            notify(t.ownerId, `${t.charName} ${word}: ${[r.value.g ? `${r.value.g} G` : '', ...r.value.items.map((i) => `${i.name} ${i.qty}`)].filter(Boolean).join(', ')} (${spec.memo})`, t.charId)
          }
        }
      })

      batchLog.push(batch)
      if (batchLog.length > MAX_BATCH_KEEP) batchLog = batchLog.slice(-MAX_BATCH_KEEP)
      batchDirty = true
      saveBatches()
      return { ok: true, value: batch }
    },

    batchUndo(by, batchId, now) {
      const src = batchLog.find((b) => b.id === batchId)
      if (!src) return { ok: false, error: '배치를 찾을 수 없습니다.' }
      if (src.undoneBy) return { ok: false, error: '이미 되돌린 배치입니다.' }

      // 원본을 고치지 않는다 — 되돌리기도 하나의 기록으로 새로 남긴다.
      const batch: Batch = {
        id: randomUUID(),
        at: now,
        kind: src.kind === 'grant' ? 'revoke' : 'grant',
        byId: by.id,
        byName: by.name,
        memo: `되돌리기: ${src.memo}`,
        undoOf: src.id,
        undoneBy: '',
        done: 0,
        skipped: 0,
        notes: [],
        ops: []
      }

      chars.bulk(() => {
        for (const op of src.ops) {
          const r = chars.mutateAny(op.charId, now, (doc) => {
            const content = { g: op.g, items: op.items.map((i) => ({ defId: i.defId, qty: i.qty })) }
            const applied = batch.kind === 'grant' ? applyGive(doc, content, now) : applyTake(doc, content, now)
            record(doc, 'refund', now, {
              g: applied.g ? (batch.kind === 'grant' ? applied.g : -applied.g) : undefined,
              items: ledgerItems(applied.items, batch.kind === 'grant' ? 1 : -1),
              ref: batch.id,
              byId: by.id,
              byName: by.name,
              memo: batch.memo
            })
            return applied
          })
          if (!r.ok) {
            batch.skipped++
            if (batch.notes.length < 50) batch.notes.push(`${op.charName}: ${r.error}`)
            continue
          }
          // 이미 쓰거나 선물해 버린 몫은 되돌릴 수 없다. 얼마가 덜 돌아왔는지 그대로 남긴다.
          const want = op.items.reduce((a, i) => a + i.qty, 0)
          const got = r.value.items.reduce((a, i) => a + i.qty, 0)
          if (got < want || r.value.g < op.g) {
            if (batch.notes.length < 50) batch.notes.push(`${op.charName}: 일부만 되돌림`)
          }
          batch.done++
          batch.ops.push({ charId: op.charId, charName: op.charName, ownerId: op.ownerId, g: r.value.g, items: r.value.items })
        }
      })

      src.undoneBy = batch.id
      batchLog.push(batch)
      if (batchLog.length > MAX_BATCH_KEEP) batchLog = batchLog.slice(-MAX_BATCH_KEEP)
      batchDirty = true
      saveBatches()
      return { ok: true, value: batch }
    },

    applyOutcome(doc, effect, reason, ref, now, opts) {
      const cap = capOf(doc)
      const schema = chars.schema()
      const out: OutcomeApplied = { g: 0, items: [], hp: 0, stats: [], leftover: [], mailed: 0 }

      // 자리를 차지하지 않는 것부터 넣는다 — 칸이 없어도 화폐와 능력치는 언제나 들어가야 한다.
      if (effect.g) {
        // 상한을 넘기면 넘긴 만큼만 들어간다(던지면 나머지 보상까지 통째로 날아간다).
        const room = MAX_G - doc.wallet.g
        const give = effect.g > 0 ? Math.min(effect.g, room) : Math.max(effect.g, -doc.wallet.g)
        if (give) applyG(doc, give, now)
        out.g = give
      }
      for (const s of effect.stats) {
        const f = schema.fields.find((x) => x.key === s.key)
        if (!f || f.type === 'text' || f.type === 'select') continue
        const cur = typeof doc.stats[f.key] === 'number' ? (doc.stats[f.key] as number) : Number(f.def)
        const next = Math.min(f.max, Math.max(f.min, cur + s.delta))
        if (next === cur) continue
        doc.stats[f.key] = next
        out.stats.push({ key: f.key, label: f.label, value: next })
      }
      if (effect.hp) {
        // 체력은 '체력 칸'이 양식에 있을 때만 움직인다. 없으면 조용히 넘어간다.
        const f = schema.fields.find((x) => x.systemRole === 'hp')
        if (f) {
          const cur = typeof doc.stats[f.key] === 'number' ? (doc.stats[f.key] as number) : Number(f.def)
          const next = Math.min(f.max, Math.max(f.min, cur + effect.hp))
          doc.stats[f.key] = next
          out.hp = next - cur
        }
      }

      for (const it of effect.items) {
        const def = catalog.item(it.defId)
        if (!def) continue
        if (it.count > 0) {
          const res = addItems(doc, def, it.count, cap, now)
          out.mailed += res.mailed
          const got = res.placed + res.mailed
          if (got > 0) out.items.push({ defId: def.id, name: def.name, qty: got })
          if (res.over > 0) {
            if (!opts?.allowPending) throw new Error('소지품과 임시보관함이 모두 찼습니다.')
            out.leftover.push({ defId: def.id, count: res.over })
          }
        } else {
          // 음수는 잃는 것. 가진 만큼만 가져간다.
          const have = countOf(doc, it.defId)
          const take = Math.min(have, -it.count)
          if (take > 0) {
            takeByDef(doc, it.defId, take)
            out.items.push({ defId: def.id, name: def.name, qty: -take })
          }
        }
      }

      if (out.g || out.items.length) {
        record(doc, reason, now, {
          g: out.g || undefined,
          items: out.items.map((i) => ({ defId: i.defId, name: i.name, qty: i.qty })),
          ref
        })
      }
      return out
    },

    batches: () => batchLog.slice().reverse(),

    setNotify(fn) {
      notifyFn = fn
    },

    circulation() {
      const totals = ledger.totals()
      const held = new Map<string, number>()
      let gHeld = 0
      let count = 0
      for (const doc of chars.all()) {
        if (doc.status === 'retired') continue
        count++
        gHeld += doc.wallet.g
        for (const s of doc.inv.slots) if (s) held.set(s.defId, (held.get(s.defId) ?? 0) + s.qty)
        for (const s of doc.inv.mailbox) held.set(s.defId, (held.get(s.defId) ?? 0) + s.qty)
      }
      const items = catalog.items({ includeHidden: true }).map((def) => ({
        defId: def.id,
        name: def.name,
        rarity: def.rarity,
        held: held.get(def.id) ?? 0,
        minted: totals.itemMinted[def.id] ?? 0,
        burned: totals.itemBurned[def.id] ?? 0,
        sources: catalog.sourcesOf(def.id).length
      }))
      return { gHeld, gMinted: totals.gMinted, gBurned: totals.gBurned, chars: count, items }
    },

    flush() {
      if (batchDirty) saveBatches()
    }
  }
}
