// 커뮤니티 놀이 정의 — 퀘스트(파견) · 격자 조사 · 선택지 조사.
//
// 이 파일에는 '무엇이 일어날 수 있는가'만 있고 '무엇이 일어났는가'는 없다.
// 진행 상태는 오너 샤드에 들어가고(같은 파일에 지갑·소지품이 있어야 보상 지급이 한 번의 쓰기로 끝난다),
// 여기 있는 정의는 파견이 시작되는 순간 통째로 복사돼 그 판에 동봉된다 —
// 진행 중에 관리자가 확률을 고쳐도 이미 나간 판은 흔들리지 않아야 하기 때문이다.
//
// 굴림은 백분율이 아니라 **가중치**로 받는다. 합이 100이 아니어도 정상이고, 보여 줄 때만 환산한다.
// 표시용 표를 따로 만들지 않고 굴림에 쓰는 표에서 파생시키므로, 보이는 확률과 실제가 어긋날 수 없다.
import { createHash, randomInt, randomUUID } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { collectAssetRefs as scanAssetRefs } from './assets'
import { MAIN_CID, stripControl, type Result } from './community'

// ===== 한도 =====
const MAX_QUESTS = 200
const MAX_GRIDS = 50
const MAX_SCENES = 50
const MAX_CARDS = 50
const MAX_ZONES = 20
const MAX_NODES = 300
const MAX_CHOICES = 12
const MAX_NAME = 40
const MAX_DESC = 1000
const MAX_BODY = 4000
const MAX_EFFECT_ITEMS = 6
const MAX_EFFECT_STATS = 6
const MAX_CHANCE = 4
/** 무한 루프 안전판. 이 걸음을 넘기면 그 판은 강제로 끝낸다. */
export const MAX_STEPS = 200
export const MIN_MINUTES = 30
export const MAX_MINUTES = 360

const ASSET_RE = /^asset:[a-f0-9]{64}$/

export type Tier = 'great' | 'ok' | 'fail'
export const TIERS: Tier[] = ['great', 'ok', 'fail']
export const TIER_LABEL: Record<Tier, string> = { great: '대성공', ok: '성공', fail: '실패' }

export interface EffectItem {
  defId: string
  count: number
}
export interface EffectStat {
  key: string
  delta: number
}

export interface OutcomeEffect {
  g: number
  items: EffectItem[]
  stats: EffectStat[]
  /** 시스템 체력 칸 증감. 양식에 체력이 없으면 조용히 넘어간다. */
  hp: number
  flags: Record<string, number>
  /** 설정 확률로 하위 효과 — 같은 카드 안에서 한 번 더 굴린다. */
  chance: { p: number; then: OutcomeEffect }[]
}

export interface OutcomeCard {
  id: string
  tier: Tier
  /** 같은 등급 안에서만 경쟁한다. 등급 사이 확률은 난이도가 정한다. */
  weight: number
  image: string
  text: string
  outcome: string
  effect: OutcomeEffect
}

export interface Requirement {
  stats: { key: string; op: '>=' | '<=' | '=='; value: number }[]
  items: EffectItem[]
  tagsAny: string[]
  tagsAll: string[]
  hpMin: number
  /** 최근 참여 쿨다운(밀리초). */
  notWithinMs: number
}

export interface UsageRule {
  cooldownMs: number
  window: { kind: 'day' | 'week' | 'none'; count: number }
  ticket: EffectItem | null
  concurrent: number
  totalCap: number
  openAt: number
  closeAt: number
}

export interface OutcomeTuning {
  baseGreat: number
  baseFail: number
  slope: number
  capGreat: number
  floorFail: number
}

export const DEFAULT_TUNING: OutcomeTuning = {
  baseGreat: 0.1,
  baseFail: 0.25,
  slope: 0.02,
  capGreat: 0.4,
  floorFail: 0.05
}

export interface QuestDef {
  id: string
  /** 고칠 때마다 오른다. 판에 동봉된 값과 견주면 '굴린 뒤에 표를 고쳤는지'가 드러난다. */
  version: number
  boardId: string
  name: string
  desc: string
  image: string
  difficulty: number
  durations: number[]
  requirement: Requirement
  cost: { g: number; items: EffectItem[] }
  party: { enabled: boolean; min: number; max: number }
  repeat: 'unlimited' | 'once-per-char' | 'once-per-account'
  usage: UsageRule
  /** 어떤 능력치가 얼마나 도움이 되는가. 여기 없는 칸은 결과에 영향을 주지 않는다. */
  statWeights: Record<string, number>
  cards: OutcomeCard[]
  tuning: OutcomeTuning
  enabled: boolean
  /** 확률표의 지문 — 바뀌면 값이 바뀐다. */
  tableHash: string
  updatedAt: number
}

export interface GridZone {
  id: string
  name: string
  color: string
  r0: number
  c0: number
  r1: number
  c1: number
  pool: { cardId: string; weight: number }[]
}

export interface GridDef {
  id: string
  version: number
  boardId: string
  name: string
  desc: string
  image: string
  rows: number
  cols: number
  zones: GridZone[]
  cards: OutcomeCard[]
  cost: { g: number; items: EffectItem[] }
  usage: UsageRule
  cycle: 'daily' | 'weekly' | 'manual'
  /** manual 주기에서 관리자가 판을 새로 깔 때 올린다. */
  epoch: number
  lineBonus: OutcomeEffect | null
  blackoutBonus: OutcomeEffect | null
  enabled: boolean
  tableHash: string
  updatedAt: number
}

export interface SceneChoice {
  id: string
  label: string
  cond: Requirement & { flags: { key: string; op: '>=' | '<=' | '=='; value: number }[] }
  cost: { g: number; items: EffectItem[]; hp: number }
  effect: OutcomeEffect | null
  next: string
  /** 같은 라벨을 여러 줄 두면 가중치로 갈린다. */
  weight: number
  once: boolean
  hideWhenLocked: boolean
}

export interface SceneNode {
  id: string
  title: string
  image: string
  body: string
  onEnter: OutcomeEffect | null
  choices: SceneChoice[]
  ending: { label: string; effect: OutcomeEffect | null } | null
}

export interface SceneDef {
  id: string
  version: number
  boardId: string
  name: string
  desc: string
  image: string
  startNode: string
  nodes: SceneNode[]
  usage: UsageRule
  enabled: boolean
  updatedAt: number
}

// ===== 진행 상태 =====
// 정의가 아니라 '지금 벌어지고 있는 일'이다. 저장은 오너 샤드 안 — 지갑·소지품과 같은 파일이라
// 보상 지급과 상태 갱신이 한 번의 쓰기로 끝난다.

export interface QuestRun {
  id: string
  questId: string
  charIds: string[]
  /** 파견 시점의 정의 사본. 이후 관리자가 확률을 고쳐도 이 판은 흔들리지 않는다. */
  snapshot: QuestDef
  startAt: number
  endAt: number
  status: 'running' | 'resolved' | 'claimed' | 'cancelled'
  /** 만료를 처음 본 순간 확정된다. 두 번 굴리지 않는다. */
  result: { charId: string; charName: string; cardId: string; tier: Tier; effect: OutcomeEffect }[]
  /** 칸이 없어 아직 못 받은 몫. 만료를 두지 않는다. */
  pending: { g: number; items: EffectItem[] } | null
  notified: boolean
  resolvedAt: number
  claimedAt: number
}

export interface GridState {
  /** 이 값이 지금 주기와 다르면 읽는 그 자리에서 빈 판으로 갈아 끼운다. */
  cycleKey: string
  /** 'r,c' → 나온 카드. */
  opened: Record<string, { cardId: string; at: number }>
  /** 이미 받은 줄 보너스(가로 r0·세로 c0·대각 d0/d1). */
  lines: string[]
  blackout: boolean
}

export interface SceneSession {
  id: string
  sceneId: string
  charId: string
  /** 시작 시점의 정의 사본 — 진행 중 관리자가 장면을 지워도 끊기지 않는다. */
  snapshot: SceneDef
  nodeId: string
  flags: Record<string, number>
  /** 한 번만 고를 수 있는 선택지 중 이미 쓴 것들('노드:선택지'). */
  used: string[]
  steps: number
  startedAt: number
  ended: boolean
  endingLabel: string
}

/** 이용 제한 카운터. 정의 id 하나에 하나씩. */
export interface UsageCounter {
  lastAt: number
  windowKey: string
  count: number
  total: number
  /** 한 번만 할 수 있는 놀이에서 이미 마친 캐릭터. */
  doneChars: string[]
}

export function emptyUsage(): UsageCounter {
  return { lastAt: 0, windowKey: '', count: 0, total: 0, doneChars: [] }
}

export interface GamesDoc {
  quests: QuestDef[]
  grids: GridDef[]
  scenes: SceneDef[]
  updatedAt: number
}

/** 검증기가 돌려주는 한 줄. 셀 좌표를 함께 줘야 관리자가 어디를 고칠지 안다. */
export interface CheckIssue {
  level: 'error' | 'warn'
  nodeId: string
  choiceId: string
  message: string
}

export interface CommunityGames {
  all(): GamesDoc
  quests(opts?: { boardId?: string; includeDisabled?: boolean }): QuestDef[]
  quest(id: string): QuestDef | null
  saveQuest(input: unknown, now: number): Result<QuestDef>
  removeQuest(id: string, now: number): Result<QuestDef>

  grids(opts?: { boardId?: string; includeDisabled?: boolean }): GridDef[]
  grid(id: string): GridDef | null
  saveGrid(input: unknown, now: number): Result<GridDef>
  removeGrid(id: string, now: number): Result<GridDef>

  scenes(opts?: { boardId?: string; includeDisabled?: boolean }): SceneDef[]
  scene(id: string): SceneDef | null
  saveScene(input: unknown, now: number): Result<SceneDef>
  removeScene(id: string, now: number): Result<SceneDef>
  /** 적용 전 반드시 지나는 검사. 오류가 하나라도 있으면 저장을 막는다. */
  checkScene(input: unknown): CheckIssue[]

  /** 이 아이템이 어느 놀이에서 나오는가 — 도감의 획득처 탭이 쓴다. */
  sourcesOf(defId: string): { kind: 'quest' | 'survey'; id: string; name: string; chance: number; qty: number }[]

  collectAssetRefs(into: Set<string>): void
  usage(): { quests: number; grids: number; scenes: number; bytes: number }
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
function frac(v: unknown, lo: number, hi: number, def: number): number {
  if (typeof v !== 'number' || !Number.isFinite(v)) return def
  return Math.min(hi, Math.max(lo, v))
}
function bool(v: unknown, def = false): boolean {
  return typeof v === 'boolean' ? v : def
}
/**
 * 식별자 칸. 관리자가 이야기 진행 표시(플래그)에 붙이는 이름은 대개 한국어라
 * 글자 종류를 유니코드로 봐야 한다 — `\w` 만 쓰면 한글이 통째로 지워져 조건이 조용히 사라진다.
 */
function key(v: unknown): string {
  return line(v, 40).replace(/[^\p{L}\p{N}_.-]/gu, '')
}

function effectItems(v: unknown, max = MAX_EFFECT_ITEMS): EffectItem[] {
  if (!Array.isArray(v)) return []
  const out: EffectItem[] = []
  for (const raw of v.slice(0, max)) {
    const r = (raw ?? {}) as Record<string, unknown>
    const defId = line(r.defId, 64)
    const count = num(r.count ?? r.qty, 1, 9999, 1)
    if (defId && !out.some((x) => x.defId === defId)) out.push({ defId, count })
  }
  return out
}

export function normEffect(v: unknown, depth = 0): OutcomeEffect {
  const r = (v && typeof v === 'object' ? v : {}) as Record<string, unknown>
  const flags: Record<string, number> = {}
  if (r.flags && typeof r.flags === 'object') {
    for (const [k, val] of Object.entries(r.flags as Record<string, unknown>).slice(0, 12)) {
      const kk = key(k)
      if (kk) flags[kk] = num(val, -1_000_000, 1_000_000, 0)
    }
  }
  return {
    g: num(r.g, -1_000_000_000, 1_000_000_000, 0),
    items: effectItems(r.items),
    stats: Array.isArray(r.stats)
      ? (r.stats.slice(0, MAX_EFFECT_STATS).map((s) => {
          const x = (s ?? {}) as Record<string, unknown>
          return { key: key(x.key), delta: num(x.delta, -1_000_000, 1_000_000, 0) }
        }).filter((s) => s.key && s.delta !== 0) as EffectStat[])
      : [],
    hp: num(r.hp, -1_000_000, 1_000_000, 0),
    flags,
    // 확률 분기는 한 겹까지만 편다. 더 깊어지면 관리자도 결과를 못 읽는다.
    chance:
      depth >= 1 || !Array.isArray(r.chance)
        ? []
        : r.chance.slice(0, MAX_CHANCE).map((c) => {
            const x = (c ?? {}) as Record<string, unknown>
            return { p: frac(x.p, 0, 1, 0), then: normEffect(x.then, depth + 1) }
          }).filter((c) => c.p > 0)
  }
}

export function emptyEffect(): OutcomeEffect {
  return { g: 0, items: [], stats: [], hp: 0, flags: {}, chance: [] }
}

/** 아무 일도 일어나지 않는 효과인가 — 저장할지 말지 가른다. */
function effectIsEmpty(e: OutcomeEffect): boolean {
  return !e.g && !e.items.length && !e.stats.length && !e.hp && !Object.keys(e.flags).length && !e.chance.length
}

function normRequirement(v: unknown): Requirement {
  const r = (v && typeof v === 'object' ? v : {}) as Record<string, unknown>
  const tags = (x: unknown): string[] =>
    Array.isArray(x) ? (x.map((t) => line(t, 20)).filter(Boolean).slice(0, 8) as string[]) : []
  return {
    stats: Array.isArray(r.stats)
      ? (r.stats.slice(0, MAX_EFFECT_STATS).map((s) => {
          const x = (s ?? {}) as Record<string, unknown>
          const op = x.op === '<=' || x.op === '==' ? x.op : '>='
          return { key: key(x.key), op, value: num(x.value, -1_000_000, 1_000_000, 0) }
        }).filter((s) => s.key) as Requirement['stats'])
      : [],
    items: effectItems(r.items),
    tagsAny: tags(r.tagsAny),
    tagsAll: tags(r.tagsAll),
    hpMin: num(r.hpMin, 0, 1_000_000, 0),
    notWithinMs: num(r.notWithinMs, 0, 30 * 24 * 3600_000, 0)
  }
}

function normUsage(v: unknown): UsageRule {
  const r = (v && typeof v === 'object' ? v : {}) as Record<string, unknown>
  const w = (r.window && typeof r.window === 'object' ? r.window : {}) as Record<string, unknown>
  const ticket = effectItems(r.ticket ? [r.ticket] : [])
  return {
    cooldownMs: num(r.cooldownMs, 0, 30 * 24 * 3600_000, 0),
    window: {
      kind: w.kind === 'day' || w.kind === 'week' ? w.kind : 'none',
      count: num(w.count, 1, 1000, 1)
    },
    ticket: ticket.length ? ticket[0] : null,
    concurrent: num(r.concurrent, 0, 100, 0),
    totalCap: num(r.totalCap, 0, 100_000, 0),
    openAt: num(r.openAt, 0, Number.MAX_SAFE_INTEGER, 0),
    closeAt: num(r.closeAt, 0, Number.MAX_SAFE_INTEGER, 0)
  }
}

function normCards(v: unknown): OutcomeCard[] {
  if (!Array.isArray(v)) return []
  const out: OutcomeCard[] = []
  const seen = new Set<string>()
  for (const raw of v.slice(0, MAX_CARDS)) {
    const r = (raw ?? {}) as Record<string, unknown>
    const id = line(r.id, 64) || randomUUID()
    if (seen.has(id)) continue
    seen.add(id)
    const tier: Tier = r.tier === 'great' || r.tier === 'fail' ? r.tier : 'ok'
    out.push({
      id,
      tier,
      weight: num(r.weight, 0, 1_000_000, 100),
      image: assetRef(r.image),
      text: multi(r.text, MAX_DESC),
      outcome: line(r.outcome, 120),
      effect: normEffect(r.effect)
    })
  }
  return out
}

function normTuning(v: unknown): OutcomeTuning {
  const r = (v && typeof v === 'object' ? v : {}) as Record<string, unknown>
  return {
    baseGreat: frac(r.baseGreat, 0, 1, DEFAULT_TUNING.baseGreat),
    baseFail: frac(r.baseFail, 0, 1, DEFAULT_TUNING.baseFail),
    slope: frac(r.slope, 0, 0.5, DEFAULT_TUNING.slope),
    capGreat: frac(r.capGreat, 0, 1, DEFAULT_TUNING.capGreat),
    // 어떤 능력치를 쌓아도 실패가 완전히 사라지지는 않게 한다 — 확정 파밍을 막고 긴장을 남긴다.
    floorFail: frac(r.floorFail, 0.01, 1, DEFAULT_TUNING.floorFail)
  }
}

/** 확률표의 지문. 카드 무게·조율값만 본다(문구나 그림이 바뀐 것으로는 변하지 않는다). */
function hashTable(cards: OutcomeCard[], tuning: OutcomeTuning, difficulty: number): string {
  const body = cards
    .map((c) => `${c.tier}:${c.weight}:${c.effect.g}:${c.effect.items.map((i) => i.defId + 'x' + i.count).join('+')}`)
    .sort()
    .join('|')
  return createHash('sha256')
    .update(`${body}#${difficulty}#${tuning.baseGreat}:${tuning.baseFail}:${tuning.slope}:${tuning.capGreat}:${tuning.floorFail}`)
    .digest('hex')
    .slice(0, 16)
}

// ===== 굴림 =====

/**
 * 가중 추첨. 나머지 연산으로 범위를 줄이면 앞쪽 항목이 미세하게 더 나오므로 randomInt 를 그대로 쓴다.
 * rand 를 넣으면 시험에서 결과를 붙박을 수 있다.
 */
export function weightedPick<T extends { weight: number }>(rows: T[], rand?: () => number): T | null {
  const total = rows.reduce((s, r) => s + Math.max(0, Math.floor(r.weight)), 0)
  if (total <= 0) return null
  let roll = rand ? Math.floor(rand() * total) : randomInt(0, total)
  for (const r of rows) {
    const w = Math.max(0, Math.floor(r.weight))
    if (roll < w) return r
    roll -= w
  }
  return rows[rows.length - 1]
}

/** 능력치를 얼마나 쌓았는가. 정의에 무게가 없는 칸은 세지 않는다. */
export function powerOf(statWeights: Record<string, number>, stats: Record<string, number | string>): number {
  let p = 0
  for (const [k, w] of Object.entries(statWeights)) {
    const v = stats[k]
    if (typeof v === 'number') p += w * v
  }
  return p
}

/**
 * 등급 확률. 난이도와의 차이가 클수록 대성공이 오르고 실패가 내린다 —
 * 다만 바닥과 천장이 있어, 아무리 쌓아도 실패가 사라지지는 않는다.
 */
export function tierProbs(power: number, difficulty: number, tuning: OutcomeTuning): Record<Tier, number> {
  const margin = power - difficulty
  const great = Math.min(tuning.capGreat, Math.max(0, tuning.baseGreat + margin * tuning.slope))
  const fail = Math.min(1, Math.max(tuning.floorFail, tuning.baseFail - margin * tuning.slope))
  const ok = Math.max(0, 1 - great - fail)
  return { great, ok, fail }
}

/** 등급을 하나 고른다. 그 등급에 카드가 없으면 있는 등급으로 물러난다. */
export function pickTier(probs: Record<Tier, number>, cards: OutcomeCard[], rand?: () => number): Tier {
  const roll = rand ? rand() : randomInt(0, 1_000_000) / 1_000_000
  let acc = 0
  for (const t of TIERS) {
    acc += probs[t]
    if (roll < acc && cards.some((c) => c.tier === t)) return t
  }
  for (const t of TIERS) if (cards.some((c) => c.tier === t)) return t
  return 'ok'
}

/** 확률 분기를 펴서 실제로 일어난 것만 남긴 효과. */
export function rollEffect(e: OutcomeEffect, rand?: () => number): OutcomeEffect {
  const out: OutcomeEffect = {
    g: e.g,
    items: e.items.map((i) => ({ ...i })),
    stats: e.stats.map((s) => ({ ...s })),
    hp: e.hp,
    flags: { ...e.flags },
    chance: []
  }
  for (const c of e.chance) {
    const roll = rand ? rand() : randomInt(0, 1_000_000) / 1_000_000
    if (roll >= c.p) continue
    const sub = rollEffect(c.then, rand)
    out.g += sub.g
    out.hp += sub.hp
    for (const i of sub.items) {
      const hit = out.items.find((x) => x.defId === i.defId)
      if (hit) hit.count += i.count
      else out.items.push({ ...i })
    }
    for (const s of sub.stats) {
      const hit = out.stats.find((x) => x.key === s.key)
      if (hit) hit.delta += s.delta
      else out.stats.push({ ...s })
    }
    for (const [k, v] of Object.entries(sub.flags)) out.flags[k] = (out.flags[k] ?? 0) + v
  }
  return out
}

/** 지금 이 주기의 이름. 이 값이 달라지면 판을 새로 깐다(크론 없이 읽는 순간 초기화). */
export function cycleKeyOf(cycle: 'daily' | 'weekly' | 'manual', epoch: number, now: number): string {
  if (cycle === 'manual') return `manual:${epoch}`
  const d = new Date(now)
  if (cycle === 'daily') {
    return `daily:${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
  }
  // 주는 목요일이 든 주를 그 해의 몇 번째 주로 세는 셈법(ISO)을 따른다.
  const t = new Date(Date.UTC(d.getFullYear(), d.getMonth(), d.getDate()))
  const day = t.getUTCDay() || 7
  t.setUTCDate(t.getUTCDate() + 4 - day)
  const y0 = new Date(Date.UTC(t.getUTCFullYear(), 0, 1))
  const wk = Math.ceil(((t.getTime() - y0.getTime()) / 86_400_000 + 1) / 7)
  return `weekly:${t.getUTCFullYear()}-W${String(wk).padStart(2, '0')}`
}

// ===== 저장소 =====

export function createCommunityGames(opts?: { dataDir?: string; persist?: boolean }): CommunityGames {
  const persist = opts?.persist !== false
  const root = join(opts?.dataDir ?? join(process.cwd(), 'data'), 'community', MAIN_CID)
  const path = join(root, 'games.json')

  let doc: GamesDoc = { quests: [], grids: [], scenes: [], updatedAt: 0 }

  if (persist) {
    try {
      if (existsSync(path)) {
        const d = JSON.parse(readFileSync(path, 'utf8')) as Partial<GamesDoc>
        doc = {
          quests: Array.isArray(d.quests) ? d.quests : [],
          grids: Array.isArray(d.grids) ? d.grids : [],
          scenes: Array.isArray(d.scenes) ? d.scenes : [],
          updatedAt: Number(d.updatedAt) || 0
        }
      }
    } catch (e) {
      console.error('[community/games] 로드 실패. 빈 상태로 시작:', e)
    }
  }

  function save(now: number): void {
    doc.updatedAt = now
    if (!persist) return
    try {
      mkdirSync(root, { recursive: true })
      const tmp = path + '.tmp'
      writeFileSync(tmp, JSON.stringify(doc), 'utf8')
      renameSync(tmp, path)
    } catch (e) {
      console.error('[community/games] 저장 실패:', e)
    }
  }

  function normScene(input: unknown, prev: SceneDef | null, now: number): SceneDef {
    const r = (input && typeof input === 'object' ? input : {}) as Record<string, unknown>
    const nodes: SceneNode[] = []
    const seen = new Set<string>()
    for (const raw of Array.isArray(r.nodes) ? r.nodes.slice(0, MAX_NODES) : []) {
      const n = (raw ?? {}) as Record<string, unknown>
      const id = line(n.id, 40)
      if (!id || seen.has(id)) continue
      seen.add(id)
      const choices: SceneChoice[] = []
      const cseen = new Set<string>()
      for (const c0 of Array.isArray(n.choices) ? n.choices.slice(0, MAX_CHOICES) : []) {
        const c = (c0 ?? {}) as Record<string, unknown>
        const cid = line(c.id, 40) || `c${choices.length + 1}`
        if (cseen.has(cid)) continue
        cseen.add(cid)
        const cond = normRequirement(c.cond)
        const flagsRaw = (c.cond && typeof c.cond === 'object' ? (c.cond as Record<string, unknown>).flags : null) ?? []
        const eff = normEffect(c.effect)
        choices.push({
          id: cid,
          label: line(c.label, 80) || '계속',
          cond: {
            ...cond,
            flags: Array.isArray(flagsRaw)
              ? (flagsRaw.slice(0, 6).map((f) => {
                  const x = (f ?? {}) as Record<string, unknown>
                  const op = x.op === '<=' || x.op === '==' ? x.op : '>='
                  return { key: key(x.key), op, value: num(x.value, -1_000_000, 1_000_000, 0) }
                }).filter((f) => f.key) as SceneChoice['cond']['flags'])
              : []
          },
          cost: {
            g: num((c.cost as Record<string, unknown> | undefined)?.g, 0, 1_000_000_000, 0),
            items: effectItems((c.cost as Record<string, unknown> | undefined)?.items),
            hp: num((c.cost as Record<string, unknown> | undefined)?.hp, 0, 1_000_000, 0)
          },
          effect: effectIsEmpty(eff) ? null : eff,
          next: line(c.next, 40) || 'END',
          weight: num(c.weight, 0, 1_000_000, 0),
          once: bool(c.once),
          hideWhenLocked: bool(c.hideWhenLocked)
        })
      }
      const onEnter = normEffect(n.onEnter)
      const endRaw = (n.ending ?? null) as Record<string, unknown> | null
      const endEff = endRaw ? normEffect(endRaw.effect) : emptyEffect()
      nodes.push({
        id,
        title: line(n.title, MAX_NAME),
        image: assetRef(n.image),
        body: multi(n.body, MAX_BODY),
        onEnter: effectIsEmpty(onEnter) ? null : onEnter,
        choices,
        ending: endRaw && line(endRaw.label, MAX_NAME) ? { label: line(endRaw.label, MAX_NAME), effect: effectIsEmpty(endEff) ? null : endEff } : null
      })
    }
    return {
      id: prev?.id ?? randomUUID(),
      version: (prev?.version ?? 0) + 1,
      boardId: line(r.boardId, 64) || prev?.boardId || '',
      name: line(r.name, MAX_NAME) || prev?.name || '',
      desc: multi(r.desc, MAX_DESC),
      image: assetRef(r.image),
      startNode: line(r.startNode, 40) || nodes[0]?.id || '',
      nodes,
      usage: normUsage(r.usage),
      enabled: bool(r.enabled, true),
      updatedAt: now
    }
  }

  /**
   * 저장 전 검사. 오류는 곧 '유저가 막다른 곳에 갇힌다'는 뜻이라 하나라도 있으면 저장하지 않는다.
   * 경고는 막지 않되 관리자에게 보여 준다.
   */
  function checkScene(def: SceneDef): CheckIssue[] {
    const issues: CheckIssue[] = []
    const ids = new Set(def.nodes.map((n) => n.id))
    if (!def.nodes.length) issues.push({ level: 'error', nodeId: '', choiceId: '', message: '장면이 하나도 없습니다.' })
    if (!def.startNode || !ids.has(def.startNode)) {
      issues.push({ level: 'error', nodeId: def.startNode, choiceId: '', message: '시작 장면이 없거나 목록에 없는 이름입니다.' })
    }
    for (const n of def.nodes) {
      if (!n.choices.length && !n.ending) {
        issues.push({ level: 'error', nodeId: n.id, choiceId: '', message: '선택지도 엔딩도 없어 여기서 멈춥니다.' })
      }
      if (n.choices.length > 8) {
        issues.push({ level: 'warn', nodeId: n.id, choiceId: '', message: `선택지가 ${n.choices.length}개라 좁은 화면에서 읽기 어렵습니다.` })
      }
      if (n.body.length > 2000) {
        issues.push({ level: 'warn', nodeId: n.id, choiceId: '', message: '본문이 2,000자를 넘습니다.' })
      }
      for (const c of n.choices) {
        if (c.next !== 'END' && !ids.has(c.next)) {
          issues.push({ level: 'error', nodeId: n.id, choiceId: c.id, message: `다음 장면 "${c.next}" 이(가) 없습니다.` })
        }
        // 값을 치르지 않는데 무언가를 주는 선택지가 자기 자리로 돌아오면 무한히 긁을 수 있다.
        const gains = (c.effect?.g ?? 0) > 0 || (c.effect?.items.length ?? 0) > 0
        const pays = c.cost.g > 0 || c.cost.items.length > 0 || c.cost.hp > 0
        if (gains && !pays && !c.once && (c.next === n.id || c.next === def.startNode)) {
          issues.push({ level: 'error', nodeId: n.id, choiceId: c.id, message: '값을 치르지 않고 보상만 주면서 제자리로 돌아옵니다(무한 반복).' })
        }
      }
    }
    // 시작에서 걸어 닿을 수 있는 곳과 끝날 수 있는지.
    const seen = new Set<string>()
    const stack = def.startNode && ids.has(def.startNode) ? [def.startNode] : []
    let canEnd = false
    while (stack.length) {
      const id = stack.pop() as string
      if (seen.has(id)) continue
      seen.add(id)
      const n = def.nodes.find((x) => x.id === id)
      if (!n) continue
      if (n.ending || n.choices.some((c) => c.next === 'END')) canEnd = true
      for (const c of n.choices) if (c.next !== 'END' && ids.has(c.next)) stack.push(c.next)
    }
    if (def.nodes.length && !canEnd) {
      issues.push({ level: 'error', nodeId: '', choiceId: '', message: '어느 길로 가도 끝나지 않습니다.' })
    }
    for (const n of def.nodes) {
      if (!seen.has(n.id)) issues.push({ level: 'warn', nodeId: n.id, choiceId: '', message: '시작에서 닿을 수 없는 장면입니다.' })
    }
    return issues
  }

  return {
    all: () => doc,

    quests: (o) =>
      doc.quests
        .filter((q) => (!o?.boardId || q.boardId === o.boardId) && (o?.includeDisabled || q.enabled))
        .sort((a, b) => a.difficulty - b.difficulty),
    quest: (id) => doc.quests.find((q) => q.id === id) ?? null,

    saveQuest(input, now) {
      const r = (input && typeof input === 'object' ? input : {}) as Record<string, unknown>
      const id = line(r.id, 64)
      const prev = id ? doc.quests.find((q) => q.id === id) : null
      if (id && !prev) return { ok: false, error: '퀘스트를 찾을 수 없습니다.' }
      const name = line(r.name, MAX_NAME)
      if (!name) return { ok: false, error: '이름을 입력해 주세요.' }
      if (!prev && doc.quests.length >= MAX_QUESTS) return { ok: false, error: `퀘스트는 ${MAX_QUESTS}개까지입니다.` }

      const cards = normCards(r.cards)
      if (!cards.length) return { ok: false, error: '완료 카드를 하나 이상 넣어 주세요.' }

      const durations = (Array.isArray(r.durations) ? r.durations : [])
        .map((d) => num(d, MIN_MINUTES, MAX_MINUTES, MIN_MINUTES))
        .filter((d, i, a) => a.indexOf(d) === i)
        .sort((a, b) => a - b)
        .slice(0, 6)
      if (!durations.length) return { ok: false, error: '소요 시간을 하나 이상 정해 주세요.' }

      const weights: Record<string, number> = {}
      if (r.statWeights && typeof r.statWeights === 'object') {
        for (const [k, w] of Object.entries(r.statWeights as Record<string, unknown>).slice(0, 12)) {
          const kk = key(k)
          const ww = frac(w, -100, 100, 0)
          if (kk && ww !== 0) weights[kk] = ww
        }
      }

      const tuning = normTuning(r.tuning)
      const difficulty = num(r.difficulty, 0, 1000, 0)
      const party = (r.party ?? {}) as Record<string, unknown>
      const next: QuestDef = {
        id: prev?.id ?? randomUUID(),
        version: (prev?.version ?? 0) + 1,
        boardId: line(r.boardId, 64) || prev?.boardId || '',
        name,
        desc: multi(r.desc, MAX_DESC),
        image: assetRef(r.image),
        difficulty,
        durations,
        requirement: normRequirement(r.requirement),
        cost: { g: num((r.cost as Record<string, unknown> | undefined)?.g, 0, 1_000_000_000, 0), items: effectItems((r.cost as Record<string, unknown> | undefined)?.items) },
        party: {
          enabled: bool(party.enabled),
          min: num(party.min, 1, 8, 1),
          max: num(party.max, 1, 8, 1)
        },
        repeat: r.repeat === 'once-per-char' || r.repeat === 'once-per-account' ? r.repeat : 'unlimited',
        usage: normUsage(r.usage),
        statWeights: weights,
        cards,
        tuning,
        enabled: bool(r.enabled, true),
        tableHash: hashTable(cards, tuning, difficulty),
        updatedAt: now
      }
      if (next.party.max < next.party.min) next.party.max = next.party.min
      if (prev) doc.quests[doc.quests.indexOf(prev)] = next
      else doc.quests.push(next)
      save(now)
      return { ok: true, value: next }
    },

    removeQuest(id, now) {
      const q = doc.quests.find((x) => x.id === id)
      if (!q) return { ok: false, error: '퀘스트를 찾을 수 없습니다.' }
      doc.quests.splice(doc.quests.indexOf(q), 1)
      save(now)
      return { ok: true, value: q }
    },

    grids: (o) =>
      doc.grids.filter((g) => (!o?.boardId || g.boardId === o.boardId) && (o?.includeDisabled || g.enabled)),
    grid: (id) => doc.grids.find((g) => g.id === id) ?? null,

    saveGrid(input, now) {
      const r = (input && typeof input === 'object' ? input : {}) as Record<string, unknown>
      const id = line(r.id, 64)
      const prev = id ? doc.grids.find((g) => g.id === id) : null
      if (id && !prev) return { ok: false, error: '조사판을 찾을 수 없습니다.' }
      const name = line(r.name, MAX_NAME)
      if (!name) return { ok: false, error: '이름을 입력해 주세요.' }
      if (!prev && doc.grids.length >= MAX_GRIDS) return { ok: false, error: `조사판은 ${MAX_GRIDS}개까지입니다.` }

      const rows = num(r.rows, 2, 10, 5)
      const cols = num(r.cols, 2, 10, 5)
      const cards = normCards(r.cards)
      if (!cards.length) return { ok: false, error: '결과 카드를 하나 이상 넣어 주세요.' }
      const cardIds = new Set(cards.map((c) => c.id))

      const zones: GridZone[] = []
      for (const raw of Array.isArray(r.zones) ? r.zones.slice(0, MAX_ZONES) : []) {
        const z = (raw ?? {}) as Record<string, unknown>
        const r0 = num(z.r0, 0, rows - 1, 0)
        const c0 = num(z.c0, 0, cols - 1, 0)
        zones.push({
          id: line(z.id, 64) || randomUUID(),
          name: line(z.name, MAX_NAME) || '구역',
          color: line(z.color, 20),
          r0,
          c0,
          r1: num(z.r1, r0, rows - 1, r0),
          c1: num(z.c1, c0, cols - 1, c0),
          pool: (Array.isArray(z.pool) ? z.pool.slice(0, MAX_CARDS) : [])
            .map((p) => {
              const x = (p ?? {}) as Record<string, unknown>
              return { cardId: line(x.cardId, 64), weight: num(x.weight, 0, 1_000_000, 100) }
            })
            .filter((p) => cardIds.has(p.cardId) && p.weight > 0)
        })
      }
      if (!zones.length) return { ok: false, error: '조사 구역을 하나 이상 칠해 주세요.' }
      if (zones.some((z) => !z.pool.length)) return { ok: false, error: '결과가 하나도 없는 구역이 있습니다.' }

      const tuning = normTuning(r.tuning)
      const lb = normEffect(r.lineBonus)
      const bb = normEffect(r.blackoutBonus)
      const next: GridDef = {
        id: prev?.id ?? randomUUID(),
        version: (prev?.version ?? 0) + 1,
        boardId: line(r.boardId, 64) || prev?.boardId || '',
        name,
        desc: multi(r.desc, MAX_DESC),
        image: assetRef(r.image),
        rows,
        cols,
        zones,
        cards,
        cost: { g: num((r.cost as Record<string, unknown> | undefined)?.g, 0, 1_000_000_000, 0), items: effectItems((r.cost as Record<string, unknown> | undefined)?.items) },
        usage: normUsage(r.usage),
        cycle: r.cycle === 'weekly' || r.cycle === 'manual' ? r.cycle : 'daily',
        // 판을 새로 깔라는 뜻이면 세대를 올린다. 다음에 여는 사람부터 빈 판을 본다.
        epoch: bool(r.resetNow) ? (prev?.epoch ?? 0) + 1 : (prev?.epoch ?? 0),
        lineBonus: effectIsEmpty(lb) ? null : lb,
        blackoutBonus: effectIsEmpty(bb) ? null : bb,
        enabled: bool(r.enabled, true),
        tableHash: hashTable(cards, tuning, 0),
        updatedAt: now
      }
      if (prev) doc.grids[doc.grids.indexOf(prev)] = next
      else doc.grids.push(next)
      save(now)
      return { ok: true, value: next }
    },

    removeGrid(id, now) {
      const g = doc.grids.find((x) => x.id === id)
      if (!g) return { ok: false, error: '조사판을 찾을 수 없습니다.' }
      doc.grids.splice(doc.grids.indexOf(g), 1)
      save(now)
      return { ok: true, value: g }
    },

    scenes: (o) =>
      doc.scenes.filter((s) => (!o?.boardId || s.boardId === o.boardId) && (o?.includeDisabled || s.enabled)),
    scene: (id) => doc.scenes.find((s) => s.id === id) ?? null,

    saveScene(input, now) {
      const r = (input && typeof input === 'object' ? input : {}) as Record<string, unknown>
      const id = line(r.id, 64)
      const prev = id ? doc.scenes.find((s) => s.id === id) : null
      if (id && !prev) return { ok: false, error: '조사를 찾을 수 없습니다.' }
      if (!line(r.name, MAX_NAME) && !prev?.name) return { ok: false, error: '이름을 입력해 주세요.' }
      if (!prev && doc.scenes.length >= MAX_SCENES) return { ok: false, error: `선택지 조사는 ${MAX_SCENES}개까지입니다.` }

      const next = normScene(input, prev ?? null, now)
      const issues = checkScene(next)
      const errors = issues.filter((i) => i.level === 'error')
      // 검사를 지나지 않은 것은 저장하지 않는다 — 막다른 곳에 갇히는 것은 유저 몫이 된다.
      if (errors.length) return { ok: false, error: `검사에서 ${errors.length}건이 걸렸습니다: ${errors[0].message}` }
      if (prev) doc.scenes[doc.scenes.indexOf(prev)] = next
      else doc.scenes.push(next)
      save(now)
      return { ok: true, value: next }
    },

    removeScene(id, now) {
      const s = doc.scenes.find((x) => x.id === id)
      if (!s) return { ok: false, error: '조사를 찾을 수 없습니다.' }
      doc.scenes.splice(doc.scenes.indexOf(s), 1)
      save(now)
      return { ok: true, value: s }
    },

    checkScene: (input) => checkScene(normScene(input, null, 0)),

    sourcesOf(defId) {
      const out: { kind: 'quest' | 'survey'; id: string; name: string; chance: number; qty: number }[] = []
      for (const q of doc.quests) {
        // 등급 안에서의 경쟁만 본다 — 등급 사이 확률은 캐릭터 능력치에 따라 달라져 한 값으로 적을 수 없다.
        for (const t of TIERS) {
          const inTier = q.cards.filter((c) => c.tier === t)
          const total = inTier.reduce((a, c) => a + c.weight, 0)
          if (total <= 0) continue
          for (const c of inTier) {
            const hit = c.effect.items.find((i) => i.defId === defId)
            if (hit) out.push({ kind: 'quest', id: q.id, name: `${q.name} · ${TIER_LABEL[t]}`, chance: c.weight / total, qty: hit.count })
          }
        }
      }
      for (const g of doc.grids) {
        for (const z of g.zones) {
          const total = z.pool.reduce((a, p) => a + p.weight, 0)
          if (total <= 0) continue
          for (const p of z.pool) {
            const card = g.cards.find((c) => c.id === p.cardId)
            const hit = card?.effect.items.find((i) => i.defId === defId)
            if (hit) out.push({ kind: 'survey', id: g.id, name: `${g.name} · ${z.name}`, chance: p.weight / total, qty: hit.count })
          }
        }
      }
      for (const s of doc.scenes) {
        for (const n of s.nodes) {
          const effs = [n.onEnter, n.ending?.effect ?? null, ...n.choices.map((c) => c.effect)]
          for (const e of effs) {
            const hit = e?.items.find((i) => i.defId === defId)
            if (hit) {
              out.push({ kind: 'survey', id: s.id, name: `${s.name} · ${n.title || n.id}`, chance: 1, qty: hit.count })
              break
            }
          }
        }
      }
      return out
    },

    collectAssetRefs(into) {
      scanAssetRefs(JSON.stringify(doc), into)
    },

    usage: () => ({
      quests: doc.quests.length,
      grids: doc.grids.length,
      scenes: doc.scenes.length,
      bytes: Buffer.byteLength(JSON.stringify(doc), 'utf8')
    }),

    flush() {
      // 정의는 바뀔 때마다 바로 쓴다. 밀어 둘 것이 없다.
    }
  }
}
