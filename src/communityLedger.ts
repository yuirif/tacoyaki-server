// 커뮤니티 경제 원장 — 화폐·아이템이 움직인 사실을 한 줄씩 덧붙이기만 하는 장부.
//
// 고치거나 지우는 길을 아예 만들지 않는다. 관리자와 러너가 다투는 자리는 대개 "받았다/안 줬다"이고,
// 그 다툼을 끝내는 건 잔액이 아니라 '언제 무엇이 왜 움직였는가'의 기록이기 때문이다.
//
// 각 줄은 앞줄의 해시를 품는다. 파일을 직접 손대 한 줄을 고치면 그 뒤가 전부 어긋나 검증에서 걸린다.
// 다만 이건 '부주의한 손댐'을 잡는 장치이지, 서버를 쥔 사람이 마음먹고 전체를 다시 쓰는 것까지 막지는 못한다.
// 그 한계는 화면에도 그대로 적어 둔다 — 실제보다 강해 보이는 안전장치가 가장 나쁘다.
import { createHash } from 'node:crypto'
import { appendFileSync, existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync, renameSync } from 'node:fs'
import { join } from 'node:path'
import { MAIN_CID } from './community'

/** 왜 움직였는가. 화면의 묶음과 유통량 집계가 이 값 하나로 갈린다. */
export type LedgerReason =
  | 'initial'
  | 'admin'
  | 'buy'
  | 'sell'
  | 'gacha'
  | 'gift-out'
  | 'gift-in'
  | 'gift-refund'
  | 'quest'
  | 'survey'
  | 'daily'
  | 'activity'
  | 'discard'
  | 'use'
  | 'refund'
  | 'repair'

/** 새로 생겼는가(mint) · 사라졌는가(burn) · 사람 사이를 옮겼을 뿐인가(move). */
export type LedgerFlow = 'mint' | 'burn' | 'move'

/** 선물처럼 주인만 바뀌는 사건은 발행·소각 어느 쪽으로도 세지 않는다. */
const MOVE_REASONS: ReadonlySet<LedgerReason> = new Set<LedgerReason>(['gift-out', 'gift-in', 'gift-refund'])

export interface LedgerItem {
  defId: string
  name: string
  /** 부호 있는 수량 — 들어오면 양수, 나가면 음수. */
  qty: number
}

export interface LedgerEntry {
  seq: number
  at: number
  /** 앞줄의 해시. 첫 줄은 빈 문자열. */
  prev: string
  hash: string
  charId: string
  charName: string
  ownerId: string
  reason: LedgerReason
  flow: LedgerFlow
  /** 부호 있는 화폐 증감. */
  g?: number
  /** 이 줄이 반영된 뒤의 잔액. */
  balance?: number
  items?: LedgerItem[]
  /** 사건의 출처(진열 id·뽑기 id·선물 id·배치 id). */
  ref?: string
  /** 운영 개입이면 집행자와 사유. */
  byId?: string
  byName?: string
  memo?: string
}

export type LedgerInput = Omit<LedgerEntry, 'seq' | 'at' | 'prev' | 'hash' | 'flow'>

export interface LedgerQuery {
  charId?: string
  ownerId?: string
  reason?: LedgerReason
  limit?: number
  /** 이 seq 보다 앞의 것만(더 보기). */
  before?: number
}

/** 유통량 감시용 누계. 매 줄에서 갱신되므로 따로 훑을 일이 없다. */
export interface LedgerTotals {
  gMinted: number
  gBurned: number
  itemMinted: Record<string, number>
  itemBurned: Record<string, number>
  seq: number
}

export interface CommunityLedger {
  append(input: LedgerInput, now: number): LedgerEntry
  recent(q: LedgerQuery): LedgerEntry[]
  totals(): LedgerTotals
  /** 메모리에 들고 있는 구간의 사슬이 성한지. broken 이 있으면 그 seq 부터 어긋났다는 뜻. */
  verify(): { ok: boolean; checked: number; brokenAt?: number }
  flush(): void
}

/** 조회는 최근 구간 안에서만 한다 — 장부 전체를 메모리에 올리면 오래된 커뮤에서 부팅이 무너진다. */
const KEEP_IN_MEMORY = 2000
/** 부팅 때 거슬러 읽을 월 파일 수. */
const BOOT_FILES = 3

function monthOf(at: number): string {
  const d = new Date(at)
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`
}

function flowOf(reason: LedgerReason, g: number, items: LedgerItem[]): LedgerFlow {
  if (MOVE_REASONS.has(reason)) return 'move'
  const sum = g + items.reduce((a, i) => a + i.qty, 0)
  return sum >= 0 ? 'mint' : 'burn'
}

/**
 * 해시 대상 — 줄에서 hash 만 뺀 나머지 전부.
 * 사유(memo)와 집행자 이름까지 넣는 이유는, 다툼이 벌어지는 자리가 대개 금액이 아니라 '왜'이기 때문이다.
 * 키 순서가 곧 계약이라 목록으로 한 번만 적어 둔다.
 */
function digestOf(e: Omit<LedgerEntry, 'hash'>): string {
  const body = JSON.stringify([
    e.seq,
    e.at,
    e.prev,
    e.charId,
    e.charName,
    e.ownerId,
    e.reason,
    e.flow,
    e.g ?? 0,
    e.balance ?? 0,
    e.items ?? [],
    e.ref ?? '',
    e.byId ?? '',
    e.byName ?? '',
    e.memo ?? ''
  ])
  return createHash('sha256').update(body).digest('hex')
}

export function createCommunityLedger(opts?: { dataDir?: string; persist?: boolean }): CommunityLedger {
  const persist = opts?.persist !== false
  const root = join(opts?.dataDir ?? join(process.cwd(), 'data'), 'community', MAIN_CID, 'ledger')
  const statePath = join(root, 'state.json')

  let seq = 0
  let lastHash = ''
  let totals: LedgerTotals = { gMinted: 0, gBurned: 0, itemMinted: {}, itemBurned: {}, seq: 0 }
  const recentBuf: LedgerEntry[] = []
  let stateDirty = false
  let timer: NodeJS.Timeout | null = null

  function loadState(): void {
    try {
      if (!existsSync(statePath)) return
      const d = JSON.parse(readFileSync(statePath, 'utf8')) as Partial<LedgerTotals> & { lastHash?: string }
      totals = {
        gMinted: Number(d.gMinted) || 0,
        gBurned: Number(d.gBurned) || 0,
        itemMinted: (d.itemMinted && typeof d.itemMinted === 'object' ? d.itemMinted : {}) as Record<string, number>,
        itemBurned: (d.itemBurned && typeof d.itemBurned === 'object' ? d.itemBurned : {}) as Record<string, number>,
        seq: Number(d.seq) || 0
      }
      seq = totals.seq
      lastHash = typeof d.lastHash === 'string' ? d.lastHash : ''
    } catch (e) {
      console.error('[community/ledger] 상태 로드 실패:', e)
    }
  }

  function loadRecent(): void {
    try {
      if (!existsSync(root)) return
      const files = readdirSync(root)
        .filter((f) => f.endsWith('.jsonl'))
        .sort()
        .slice(-BOOT_FILES)
      for (const f of files) {
        for (const raw of readFileSync(join(root, f), 'utf8').split('\n')) {
          if (!raw.trim()) continue
          try {
            recentBuf.push(JSON.parse(raw) as LedgerEntry)
          } catch {
            // 쓰다 만 줄 하나가 나머지 장부를 못 읽게 만들면 안 된다.
          }
        }
      }
      if (recentBuf.length > KEEP_IN_MEMORY) recentBuf.splice(0, recentBuf.length - KEEP_IN_MEMORY)
      const tail = recentBuf[recentBuf.length - 1]
      // 상태 파일이 없거나 뒤처져 있으면 장부 자체를 진실로 삼는다.
      if (tail && tail.seq >= seq) {
        seq = tail.seq
        lastHash = tail.hash
      }
    } catch (e) {
      console.error('[community/ledger] 장부 로드 실패:', e)
    }
  }

  if (persist) {
    loadState()
    loadRecent()
  }

  function saveState(): void {
    stateDirty = false
    if (!persist) return
    try {
      mkdirSync(root, { recursive: true })
      const tmp = statePath + '.tmp'
      writeFileSync(tmp, JSON.stringify({ ...totals, seq, lastHash }), 'utf8')
      renameSync(tmp, statePath)
    } catch (e) {
      console.error('[community/ledger] 상태 저장 실패:', e)
    }
  }

  function scheduleState(): void {
    stateDirty = true
    if (!persist || timer) return
    timer = setTimeout(() => {
      timer = null
      if (stateDirty) saveState()
    }, 5_000)
    timer.unref?.()
  }

  return {
    append(input, now) {
      const items = (input.items ?? []).filter((i) => i && i.defId && i.qty !== 0)
      const g = typeof input.g === 'number' && Number.isFinite(input.g) ? Math.round(input.g) : 0
      const entry: LedgerEntry = {
        seq: ++seq,
        at: now,
        prev: lastHash,
        hash: '',
        charId: input.charId,
        charName: input.charName,
        ownerId: input.ownerId,
        reason: input.reason,
        flow: flowOf(input.reason, g, items),
        ...(g ? { g } : {}),
        ...(typeof input.balance === 'number' ? { balance: Math.round(input.balance) } : {}),
        ...(items.length ? { items } : {}),
        ...(input.ref ? { ref: input.ref } : {}),
        ...(input.byId ? { byId: input.byId } : {}),
        ...(input.byName ? { byName: input.byName } : {}),
        ...(input.memo ? { memo: input.memo } : {})
      }
      entry.hash = digestOf(entry)
      lastHash = entry.hash

      if (entry.flow !== 'move') {
        if (g > 0) totals.gMinted += g
        else if (g < 0) totals.gBurned += -g
        for (const it of items) {
          if (it.qty > 0) totals.itemMinted[it.defId] = (totals.itemMinted[it.defId] ?? 0) + it.qty
          else totals.itemBurned[it.defId] = (totals.itemBurned[it.defId] ?? 0) + -it.qty
        }
      }
      totals.seq = seq

      recentBuf.push(entry)
      if (recentBuf.length > KEEP_IN_MEMORY) recentBuf.shift()

      if (persist) {
        try {
          mkdirSync(root, { recursive: true })
          appendFileSync(join(root, `${monthOf(now)}.jsonl`), JSON.stringify(entry) + '\n', 'utf8')
        } catch (e) {
          console.error('[community/ledger] 기록 실패:', e)
        }
      }
      scheduleState()
      return entry
    },

    recent(q) {
      const limit = Math.min(200, Math.max(1, q.limit ?? 50))
      const out: LedgerEntry[] = []
      for (let i = recentBuf.length - 1; i >= 0 && out.length < limit; i--) {
        const e = recentBuf[i]
        if (q.before !== undefined && e.seq >= q.before) continue
        if (q.charId && e.charId !== q.charId) continue
        if (q.ownerId && e.ownerId !== q.ownerId) continue
        if (q.reason && e.reason !== q.reason) continue
        out.push(e)
      }
      return out
    },

    totals: () => ({ ...totals, itemMinted: { ...totals.itemMinted }, itemBurned: { ...totals.itemBurned } }),

    verify() {
      let checked = 0
      // 첫 줄도 자기 해시를 다시 계산해 본다. 앞줄과의 연결만 보면 맨 앞 한 줄은 얼마든지 고칠 수 있다.
      for (let i = 0; i < recentBuf.length; i++) {
        const e = recentBuf[i]
        checked++
        if (i > 0 && e.prev !== recentBuf[i - 1].hash) return { ok: false, checked, brokenAt: e.seq }
        const { hash, ...rest } = e
        if (digestOf(rest) !== hash) return { ok: false, checked, brokenAt: e.seq }
      }
      return { ok: true, checked }
    },

    flush() {
      if (timer) {
        clearTimeout(timer)
        timer = null
      }
      if (stateDirty) saveState()
    }
  }
}
