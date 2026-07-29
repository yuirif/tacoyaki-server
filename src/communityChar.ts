// 커뮤니티 캐릭터 — 시트·능력치·옷장(룩)·관계.
//
// 저장은 오너 계정 단위로 묶는다(owner/<계정>.json). 의미상 캐릭터의 것이지만 물리적으로 한 파일에 모여 있으면,
// 뒤에 붙을 지갑·소지품까지 한 번의 쓰기로 끝나 중간에 프로세스가 죽어도 절반만 반영되는 창이 생기지 않는다.
// 목록에 필요한 요약과 자산 참조는 charIndex.json 에 상주시킨다 — 자산 회수 수집이 동기이기 때문이다.
//
// 능력치의 편집 권한이 이 파일의 핵심 경계다. 체력처럼 시스템이 깎는 값을 본인이 고칠 수 있으면
// 뒤에 올 퀘스트·조사가 통째로 무의미해진다. 그래서 저장 경로에서 양식의 소유 축을 보고 걸러낸다.
import { readFileSync, writeFileSync, mkdirSync, renameSync, existsSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { collectAssetRefs as scanAssetRefs } from './assets'
import { MAIN_CID, isEntityId, stripControl, type Result } from './community'
import type { GridState, QuestRun, SceneSession, UsageCounter } from './communityGame'

// ===== 한도 =====
const MAX_NAME = 40
const MAX_ONELINE = 80
const MAX_TAGS = 10
const MAX_TAG = 20
const MAX_LOOKS = 20
const MAX_RELATIONS = 60
const MAX_STAT_FIELDS = 24
const MAX_PROFILE_VALUE = 4000
const MAX_MEMO = 200
const MAX_CHARS_PER_ACCOUNT = 8
const MAX_CHARS_TOTAL = 2000
/** 표시가 안전한 자리수까지만. 이 위로는 화면과 합산이 모두 미덥지 않아진다. */
export const MAX_G = 1_000_000_000
export const MAX_INV_CAP = 200
export const MAX_MAILBOX = 100
export const MAX_STACK = 9999

const ASSET_RE = /^asset:[a-f0-9]{64}$/
const YT_ID_RE = /^[\w-]{6,20}$/

export type StatType = 'number' | 'gauge' | 'text' | 'select'
/** 누가 이 칸을 고칠 수 있는가 — user 는 본인, admin 은 운영진, system 은 게임 진행만. */
export type StatOwner = 'user' | 'admin' | 'system'
/** 시스템이 이 칸을 어떤 의미로 쓰는가. 지정된 칸만 퀘스트·조사가 건드린다. */
export type SystemRole = 'hp' | 'stamina' | 'exp' | 'level'
export type StatVisibility = 'public' | 'members' | 'owner' | 'staff'

export interface StatField {
  /** 이름과 분리된 불변 식별자 — 표시명을 바꿔도 값이 따라온다. */
  key: string
  label: string
  type: StatType
  group: string
  min: number
  max: number
  def: number | string
  options: string[]
  visibility: StatVisibility
  owner: StatOwner
  systemRole: SystemRole | ''
  order: number
}
export interface StatSchema {
  ver: number
  fields: StatField[]
  updatedAt: number
}

export type CharStatus = 'draft' | 'pending' | 'approved' | 'retired'

export interface CharLook {
  id: string
  label: string
  fullBody: string
}

export interface Relation {
  toCharId: string
  label: string
  note: string
  /** 상대 오너가 받아들이기 전에는 한쪽 주장일 뿐이다. */
  status: 'pending' | 'accepted'
  at: number
}

export interface CharBgm {
  kind: 'file' | 'yt'
  src: string
  loop: boolean
  volume: number
}

/**
 * 소지품 한 칸. 이름·그림·등급은 '받은 그 순간'의 사본이다 —
 * 관리자가 나중에 정의를 고치거나 지워도 이미 남의 손에 있는 물건이 이름 없는 빈칸이 되지 않는다.
 */
export interface InvSlot {
  uid: string
  defId: string
  qty: number
  name: string
  icon: string
  rarity: number
  boundAt: number
}

export interface InvState {
  /** 커뮤 기본 칸 수에 더해지는 이 캐릭터만의 여유분. */
  capBonus: number
  /** 길이 = 그때의 칸 수. 자리를 비워 두는 것이 정상이라 null 을 그대로 둔다. */
  slots: (InvSlot | null)[]
  /** 칸이 없어 못 받은 물건이 머무는 곳. 만료가 없다 — 보상이 사라지는 것이 최악이다. */
  mailbox: InvSlot[]
}

export interface Wallet {
  g: number
  updatedAt: number
}

/**
 * 계정 단위 카운터. 캐릭터가 아니라 사람에게 붙어야 하는 값만 여기 둔다 —
 * 구매 상한을 캐릭터에만 걸면 부캐를 만들어 우회할 수 있다.
 */
export interface OwnerMeta {
  /** 진열 id → 이 계정이 지금까지 산 수량. */
  buys: Record<string, number>
  /** 뽑기 테이블 id → 천장까지 남은 계산에 쓰는 누적 횟수. */
  pity: Record<string, number>
  /** 출석을 마지막으로 받은 날(서버 기준 YYYY-MM-DD). */
  dailyDay: string
  /** 오늘 자동 정산으로 받은 누계와 그 날짜. */
  earnedDay: string
  earnedG: number
  /** 진행 중이거나 최근에 끝난 파견. */
  runs: Record<string, QuestRun>
  /** 조사판 id → 지금 주기의 판. */
  grids: Record<string, GridState>
  /** 선택지 조사 id → 진행 중인 판(정의당 하나). */
  scenes: Record<string, SceneSession>
  /** 놀이 정의 id → 이용 제한 카운터. */
  usage: Record<string, UsageCounter>
}

export function emptyMeta(): OwnerMeta {
  return { buys: {}, pity: {}, dailyDay: '', earnedDay: '', earnedG: 0, runs: {}, grids: {}, scenes: {}, usage: {} }
}

export interface CharDoc {
  id: string
  ownerId: string
  name: string
  oneLine: string
  tags: string[]
  /** 기본 전신. 옷장에서 룩을 고르면 표시만 그 룩으로 바뀐다. */
  fullBody: string
  bust: string
  thumb: string
  /** 캐릭터 게시판 글과의 연결. */
  postId: string
  profile: Record<string, string>
  stats: Record<string, number | string>
  statsVer: number
  looks: CharLook[]
  activeLookId: string
  relations: Relation[]
  bgm: CharBgm | null
  status: CharStatus
  /** 운영진이 서사용으로 두는 공용 캐릭터. 오너 개인 소유가 아니다. */
  npc: boolean
  /** 지갑·소지품은 뜻으로는 캐릭터의 것이고, 자리로는 오너 파일 안에 있다(한 번의 쓰기로 끝내기 위해). */
  wallet: Wallet
  inv: InvState
  /** 글·댓글 자동 정산이 흘러들어갈 캐릭터. 계정당 한 체. */
  main: boolean
  /** 초기 자금을 이미 받았는가 — 승인을 취소했다 다시 해도 두 번 주지 않는다. */
  initialGranted: boolean
  createdAt: number
  updatedAt: number
}

/** 목록·자산 회수를 위해 상주하는 요약. */
export interface CharIndexEntry {
  id: string
  ownerId: string
  name: string
  oneLine: string
  tags: string[]
  thumb: string
  bust: string
  status: CharStatus
  npc: boolean
  postId: string
  /** 이 캐릭터가 쓰는 자산 해시(접두 없음). */
  refs: string[]
  createdAt: number
  updatedAt: number
}

export interface CharListOpts {
  ownerId?: string
  tag?: string
  status?: CharStatus
  q?: string
  includeRetired?: boolean
}

export interface StatAdjust {
  key: string
  delta?: number
  value?: number | string
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
function tagList(v: unknown): string[] {
  if (!Array.isArray(v)) return []
  const out: string[] = []
  for (const raw of v) {
    const s = line(raw, MAX_TAG).replace(/^#/, '')
    if (s && !out.includes(s)) out.push(s)
    if (out.length >= MAX_TAGS) break
  }
  return out
}
function normBgm(v: unknown): CharBgm | null {
  if (!v || typeof v !== 'object') return null
  const r = v as Record<string, unknown>
  const loop = bool(r.loop, true)
  const volume = num(r.volume, 0, 100, 70) / 100
  if (r.kind === 'file') {
    const src = assetRef(r.src)
    return src ? { kind: 'file', src, loop, volume } : null
  }
  if (r.kind === 'yt') {
    const src = line(r.src, 20)
    return YT_ID_RE.test(src) ? { kind: 'yt', src, loop, volume } : null
  }
  return null
}

function normSlot(v: unknown): InvSlot | null {
  if (!v || typeof v !== 'object') return null
  const r = v as Record<string, unknown>
  const defId = line(r.defId, 64)
  const qty = num(r.qty, 1, 9999, 0)
  if (!defId || qty < 1) return null
  return {
    uid: line(r.uid, 64) || randomUUID(),
    defId,
    qty,
    name: line(r.name, MAX_NAME),
    icon: assetRef(r.icon),
    rarity: num(r.rarity, 1, 5, 1),
    boundAt: num(r.boundAt, 0, Number.MAX_SAFE_INTEGER, 0)
  }
}

/**
 * 구버전 파일에 없던 지갑·소지품 칸을 채운다.
 * 없는 채로 두면 경제 경로가 첫 접근에서 전부 터지므로, 읽는 지점에서 한 번에 메운다.
 */
function ensureEcon(doc: CharDoc): CharDoc {
  const w = doc.wallet as Wallet | undefined
  doc.wallet = { g: num(w?.g, 0, MAX_G, 0), updatedAt: num(w?.updatedAt, 0, Number.MAX_SAFE_INTEGER, 0) }
  const iv = doc.inv as InvState | undefined
  doc.inv = {
    capBonus: num(iv?.capBonus, 0, MAX_INV_CAP, 0),
    slots: Array.isArray(iv?.slots) ? iv.slots.slice(0, MAX_INV_CAP).map(normSlot) : [],
    mailbox: Array.isArray(iv?.mailbox)
      ? (iv.mailbox.slice(0, MAX_MAILBOX).map(normSlot).filter(Boolean) as InvSlot[])
      : []
  }
  doc.main = doc.main === true
  doc.initialGranted = doc.initialGranted === true
  return doc
}

function normMeta(v: unknown): OwnerMeta {
  const r = (v && typeof v === 'object' ? v : {}) as Record<string, unknown>
  const dict = (x: unknown): Record<string, number> => {
    const out: Record<string, number> = {}
    if (!x || typeof x !== 'object') return out
    for (const [k, val] of Object.entries(x as Record<string, unknown>)) {
      if (!line(k, 64)) continue
      const n2 = num(val, 0, 1_000_000, 0)
      if (n2 > 0) out[k] = n2
    }
    return out
  }
  const obj = <T,>(x: unknown): Record<string, T> => (x && typeof x === 'object' ? (x as Record<string, T>) : {})
  return {
    buys: dict(r.buys),
    pity: dict(r.pity),
    dailyDay: line(r.dailyDay, 10),
    earnedDay: line(r.earnedDay, 10),
    earnedG: num(r.earnedG, 0, MAX_G, 0),
    // 진행 상태는 서버가 만든 것만 들어오므로 형태를 다시 훑지 않는다(구조가 깊고, 사용자 입력이 아니다).
    runs: obj<QuestRun>(r.runs),
    grids: obj<GridState>(r.grids),
    scenes: obj<SceneSession>(r.scenes),
    usage: obj<UsageCounter>(r.usage)
  }
}

/** 기본 능력치 양식 — 관리자가 그대로 쓰거나 칸을 고친다. 체력만 시스템 칸으로 잡아 둔다. */
export function defaultStatSchema(now: number): StatSchema {
  return {
    ver: 1,
    updatedAt: now,
    fields: [
      { key: 'hp', label: '체력', type: 'gauge', group: '상태', min: 0, max: 100, def: 100, options: [], visibility: 'public', owner: 'system', systemRole: 'hp', order: 0 },
      { key: 'str', label: '근력', type: 'number', group: '능력', min: 1, max: 10, def: 3, options: [], visibility: 'public', owner: 'user', systemRole: '', order: 1 },
      { key: 'agi', label: '민첩', type: 'number', group: '능력', min: 1, max: 10, def: 3, options: [], visibility: 'public', owner: 'user', systemRole: '', order: 2 },
      { key: 'int', label: '지능', type: 'number', group: '능력', min: 1, max: 10, def: 3, options: [], visibility: 'public', owner: 'user', systemRole: '', order: 3 }
    ]
  }
}

function normStatSchema(v: unknown, now: number): StatSchema {
  const r = (v && typeof v === 'object' ? v : {}) as Record<string, unknown>
  const raw = Array.isArray(r.fields) ? r.fields : []
  const fields: StatField[] = []
  const seen = new Set<string>()
  const usedRoles = new Set<string>()
  for (const item of raw.slice(0, MAX_STAT_FIELDS)) {
    const f = (item ?? {}) as Record<string, unknown>
    const key = line(f.key, 30).replace(/[^\w.-]/g, '')
    if (!key || seen.has(key)) continue
    seen.add(key)
    const type: StatType = f.type === 'gauge' || f.type === 'text' || f.type === 'select' ? f.type : 'number'
    const owner: StatOwner = f.owner === 'admin' || f.owner === 'system' ? f.owner : 'user'
    let systemRole: SystemRole | '' =
      f.systemRole === 'hp' || f.systemRole === 'stamina' || f.systemRole === 'exp' || f.systemRole === 'level'
        ? f.systemRole
        : ''
    // 같은 시스템 의미를 두 칸이 가지면 어느 쪽을 깎아야 할지 알 수 없다.
    if (systemRole && usedRoles.has(systemRole)) systemRole = ''
    if (systemRole) usedRoles.add(systemRole)
    const min = num(f.min, -1_000_000, 1_000_000, 0)
    const max = num(f.max, min, 1_000_000, Math.max(min, 100))
    fields.push({
      key,
      label: line(f.label, MAX_NAME) || key,
      type,
      group: line(f.group, MAX_NAME),
      min,
      max,
      def: type === 'text' || type === 'select' ? line(f.def, 200) : num(f.def, min, max, min),
      options: Array.isArray(f.options) ? f.options.map((o) => line(o, 60)).filter(Boolean).slice(0, 40) : [],
      visibility:
        f.visibility === 'members' || f.visibility === 'owner' || f.visibility === 'staff' ? f.visibility : 'public',
      // 시스템 의미가 붙은 칸은 본인이 고칠 수 없다 — 자기 체력을 스스로 채우는 길을 막는다.
      owner: systemRole ? 'system' : owner,
      systemRole,
      order: num(f.order, 0, 999, fields.length)
    })
  }
  fields.sort((a, b) => a.order - b.order)
  return { ver: num(r.ver, 1, Number.MAX_SAFE_INTEGER, 1), fields: fields.length ? fields : defaultStatSchema(now).fields, updatedAt: now }
}

/**
 * 저장된 값을 현재 양식에 비춰 보여 줄 값만 뽑는다.
 * 원본은 파괴적으로 갱신하지 않는다 — 관리자가 칸을 지웠다 되돌리면 값이 돌아와야 한다.
 */
export function projectStats(schema: StatSchema, raw: Record<string, number | string>): Record<string, number | string> {
  const out: Record<string, number | string> = {}
  for (const f of schema.fields) {
    const v = raw[f.key]
    if (f.type === 'text') out[f.key] = typeof v === 'string' ? v.slice(0, 200) : String(f.def)
    else if (f.type === 'select') out[f.key] = typeof v === 'string' && f.options.includes(v) ? v : String(f.def)
    else out[f.key] = typeof v === 'number' && Number.isFinite(v) ? Math.min(f.max, Math.max(f.min, Math.round(v))) : Number(f.def)
  }
  return out
}

function indexOf(doc: CharDoc): CharIndexEntry {
  const refs = new Set<string>()
  scanAssetRefs(JSON.stringify({ f: doc.fullBody, b: doc.bust, t: doc.thumb, l: doc.looks, p: doc.profile, g: doc.bgm }), refs)
  return {
    id: doc.id,
    ownerId: doc.ownerId,
    name: doc.name,
    oneLine: doc.oneLine,
    tags: doc.tags.slice(),
    thumb: doc.thumb,
    bust: doc.bust,
    status: doc.status,
    npc: doc.npc,
    postId: doc.postId,
    refs: [...refs],
    createdAt: doc.createdAt,
    updatedAt: doc.updatedAt
  }
}

export interface CommunityCharStore {
  schema(): StatSchema
  saveSchema(input: unknown, now: number): Result<StatSchema>

  list(opts: CharListOpts): CharIndexEntry[]
  get(charId: string): CharDoc | null
  /** 표시용 — 능력치를 현재 양식에 맞춰 투영한 사본. */
  view(charId: string): CharDoc | null
  ownedBy(accountId: string): CharIndexEntry[]

  /** 오너가 자기 캐릭터를 저장한다. 시스템·운영 전용 칸은 조용히 무시한다. */
  save(ownerId: string, input: unknown, now: number): Result<CharDoc>
  /** 운영진이 능력치를 조정한다. 사유가 없으면 거부하고 기록을 남긴다. */
  adjustStats(charId: string, adjusts: unknown, memo: string, now: number): Result<{ doc: CharDoc; changed: StatAdjust[] }>
  /** 게임 진행(퀘스트·조사)이 시스템 칸을 바꾼다. 양식에 그 의미가 없으면 아무 일도 하지 않는다. */
  applySystemStat(charId: string, role: SystemRole, delta: number, now: number): number | null
  setStatus(charId: string, status: CharStatus, now: number): Result<CharDoc>
  remove(charId: string, now: number): Result<CharDoc>

  setLook(charId: string, lookId: string, now: number): Result<CharDoc>
  addLook(charId: string, label: string, fullBody: unknown, now: number): Result<CharLook>
  removeLook(charId: string, lookId: string, now: number): Result<CharDoc>
  /** 지금 화면에 보여야 할 전신(룩을 골랐으면 그 룩). */
  bodyOf(charId: string): string

  /**
   * 오너 본인의 캐릭터를 고친다. 남의 캐릭터면 손도 대지 않는다 —
   * 소유 검사를 이 안에 가둬 두면, 라우트가 본문의 charId 를 그대로 넘겨도 사고가 나지 않는다.
   */
  mutateOwned<T>(ownerId: string, charId: string, now: number, fn: (doc: CharDoc, meta: OwnerMeta) => T): Result<T>
  /** 운영진 개입·게임 진행이 고친다. 호출하는 쪽이 권한을 이미 확인했다는 전제다. */
  mutateAny<T>(charId: string, now: number, fn: (doc: CharDoc, meta: OwnerMeta) => T): Result<T>
  /** 사람에게 붙는 카운터 읽기(쓰기는 mutate 안에서만). */
  meta(accountId: string): OwnerMeta
  /** 캐릭터를 끼지 않는 계정 단위 변경(파견 확정·주기 초기화 같은 것). */
  mutateMeta<T>(accountId: string, fn: (meta: OwnerMeta) => T): Result<T>
  /** 진행 중인 판이 있는 계정들 — 부팅 후 마감 배열을 다시 세울 때 쓴다. */
  ownersWithMeta(): string[]
  /** 자동 정산이 흘러들어갈 대표 캐릭터를 정한다. 계정당 한 체뿐이라 나머지는 내린다. */
  setMain(ownerId: string, charId: string, now: number): Result<CharDoc>
  /** 그 계정의 대표 캐릭터(없으면 null). */
  mainOf(accountId: string): CharDoc | null
  /** 전 캐릭터 순회 — 유통량 집계와 일괄 지급 대상 산출에 쓴다. */
  all(): CharDoc[]
  /**
   * 여러 캐릭터를 연달아 고칠 때 파일 쓰기를 끝에 한 번으로 모은다.
   * 일괄 지급이 500체를 훑으면 계정 수만큼만 쓰게 되어, 느린 디스크에서 서버가 멎지 않는다.
   */
  bulk<T>(fn: () => T): T

  proposeRelation(charId: string, toCharId: string, label: string, note: string, now: number): Result<Relation>
  acceptRelation(charId: string, fromCharId: string, now: number): Result<Relation>
  removeRelation(charId: string, toCharId: string): Result<void>

  collectAssetRefs(into: Set<string>): void
  removeAll(accountId: string, now: number): void
  usageFor(accountId: string): { bytes: number; refs: Set<string> }
  usage(): { chars: number; bytes: number }
  flush(): void
}

export function createCommunityCharStore(opts?: { dataDir?: string; persist?: boolean }): CommunityCharStore {
  const persist = opts?.persist !== false
  const root = join(opts?.dataDir ?? join(process.cwd(), 'data'), 'community', MAIN_CID)
  const ownerDir = join(root, 'owner')
  const indexPath = join(root, 'charIndex.json')
  const schemaPath = join(root, 'statSchema.json')

  /** 계정 → 그 계정의 캐릭터들. 지갑·소지품도 이 안에 들어 있어 경제 조작이 한 번의 쓰기로 끝난다. */
  const shards = new Map<string, Record<string, CharDoc>>()
  /** 계정 → 사람에게 붙는 카운터(구매 상한·천장·출석). 캐릭터와 같은 파일에 저장된다. */
  const metas = new Map<string, OwnerMeta>()
  let index: Record<string, CharIndexEntry> = {}
  let schema: StatSchema = defaultStatSchema(0)
  const dirtyOwners = new Set<string>()
  let indexDirty = false
  let timer: NodeJS.Timeout | null = null

  if (persist) {
    try {
      if (existsSync(schemaPath)) schema = normStatSchema(JSON.parse(readFileSync(schemaPath, 'utf8')), 0)
      if (existsSync(indexPath)) {
        const d = JSON.parse(readFileSync(indexPath, 'utf8'))
        if (d && typeof d === 'object') index = d as Record<string, CharIndexEntry>
      }
      if (existsSync(ownerDir)) {
        for (const f of readdirSync(ownerDir)) {
          if (!f.endsWith('.json')) continue
          const d = JSON.parse(readFileSync(join(ownerDir, f), 'utf8')) as { chars?: Record<string, CharDoc>; meta?: unknown }
          const key = f.slice(0, -5)
          if (d?.chars) {
            for (const doc of Object.values(d.chars)) ensureEcon(doc)
            shards.set(key, d.chars)
          }
          metas.set(key, normMeta(d?.meta))
        }
      }
    } catch (e) {
      console.error('[community/char] 로드 실패 — 빈 상태로 시작:', e)
    }
  }

  function writeAtomic(dir: string, path: string, data: string): void {
    if (!persist) return
    try {
      mkdirSync(dir, { recursive: true })
      const tmp = path + '.tmp'
      writeFileSync(tmp, data, 'utf8')
      renameSync(tmp, path)
    } catch (e) {
      console.error('[community/char] 저장 실패:', path, e)
    }
  }

  function saveOwner(accountId: string): void {
    dirtyOwners.delete(accountId)
    // 파일명이 되므로 형식을 검사한다(경로 탈출 차단).
    if (!/^[\w-]{1,64}$/.test(accountId)) return
    writeAtomic(
      ownerDir,
      join(ownerDir, `${accountId}.json`),
      JSON.stringify({ chars: shards.get(accountId) ?? {}, meta: metas.get(accountId) ?? emptyMeta() })
    )
  }
  function saveIndex(): void {
    indexDirty = false
    writeAtomic(root, indexPath, JSON.stringify(index))
  }

  /** 일괄 작업 동안에는 파일 쓰기를 미룬다(끝에서 계정마다 한 번씩만 쓴다). */
  let holdWrites = 0

  /** 목록 인덱스는 갱신이 잦아 뭉쳐 쓰고, 캐릭터 문서는 잃으면 안 되므로 바로 쓴다. */
  function touch(doc: CharDoc): void {
    index[doc.id] = indexOf(doc)
    indexDirty = true
    dirtyOwners.add(doc.ownerId)
    if (holdWrites === 0) saveOwner(doc.ownerId)
    if (!persist || timer) return
    timer = setTimeout(() => {
      timer = null
      if (indexDirty) saveIndex()
    }, 8_000)
    timer.unref?.()
  }

  function shard(accountId: string): Record<string, CharDoc> {
    let s = shards.get(accountId)
    if (!s) {
      s = {}
      shards.set(accountId, s)
    }
    return s
  }

  function metaOf(accountId: string): OwnerMeta {
    let m = metas.get(accountId)
    if (!m) {
      m = emptyMeta()
      metas.set(accountId, m)
    }
    return m
  }

  /**
   * 경제 조작의 유일한 통로.
   *
   * 세 가지를 여기서 한꺼번에 보장한다 —
   *  ① fn 은 동기다. 안에서 기다리는 지점이 없으므로 그 사이에 다른 요청이 끼어들 수 없고,
   *    따라서 잔액을 확인하고 깎는 사이에 두 번 사는 일이 성립하지 않는다.
   *  ② fn 이 던지면 시작 시점의 사본으로 되돌린다. 절반만 반영된 상태가 남지 않는다.
   *  ③ 성공하면 그 자리에서 파일을 쓴다 — 지갑이 뒤로 밀린 채 프로세스가 죽는 일을 만들지 않는다.
   */
  function runMutation<T>(doc: CharDoc, fn: (doc: CharDoc, meta: OwnerMeta) => T, now: number): Result<T> {
    const meta = metaOf(doc.ownerId)
    const snapDoc = JSON.stringify(doc)
    const snapMeta = JSON.stringify(meta)
    try {
      const value = fn(doc, meta)
      doc.updatedAt = now
      touch(doc)
      return { ok: true, value }
    } catch (e) {
      const s = shards.get(doc.ownerId)
      if (s) s[doc.id] = JSON.parse(snapDoc) as CharDoc
      metas.set(doc.ownerId, JSON.parse(snapMeta) as OwnerMeta)
      return { ok: false, error: e instanceof Error ? e.message : '처리에 실패했습니다.' }
    }
  }

  function find(charId: string): CharDoc | null {
    if (!isEntityId(charId)) return null
    const e = index[charId]
    if (e) {
      const doc = shards.get(e.ownerId)?.[charId]
      if (doc) return doc
    }
    for (const s of shards.values()) if (s[charId]) return s[charId]
    return null
  }

  function totalChars(): number {
    return Object.keys(index).length
  }

  return {
    schema: () => schema,

    saveSchema(input, now) {
      const next = normStatSchema(input, now)
      next.ver = schema.ver + 1
      schema = next
      writeAtomic(root, schemaPath, JSON.stringify(schema))
      return { ok: true, value: schema }
    },

    list(o) {
      const q = line(o.q, 40).toLowerCase()
      return Object.values(index)
        .filter((e) => {
          if (!o.includeRetired && e.status === 'retired') return false
          if (o.ownerId && e.ownerId !== o.ownerId) return false
          if (o.status && e.status !== o.status) return false
          if (o.tag && !e.tags.includes(o.tag)) return false
          if (q && !`${e.name} ${e.oneLine} ${e.tags.join(' ')}`.toLowerCase().includes(q)) return false
          return true
        })
        .sort((a, b) => b.createdAt - a.createdAt)
    },

    get: (charId) => find(charId),

    view(charId) {
      const doc = find(charId)
      if (!doc) return null
      return { ...doc, stats: projectStats(schema, doc.stats) }
    },

    ownedBy: (accountId) => Object.values(index).filter((e) => e.ownerId === accountId),

    save(ownerId, input, now) {
      const r = (input && typeof input === 'object' ? input : {}) as Record<string, unknown>
      const charId = line(r.charId, 64)
      let doc = charId ? find(charId) : null
      if (charId && !doc) return { ok: false, error: '캐릭터를 찾을 수 없습니다.' }
      if (doc && doc.ownerId !== ownerId) return { ok: false, error: '내 캐릭터만 수정할 수 있습니다.' }
      if (doc && doc.status === 'retired') return { ok: false, error: '보관된 캐릭터는 수정할 수 없습니다.' }

      const name = line(r.name, MAX_NAME)
      if (!name) return { ok: false, error: '이름을 입력해 주세요.' }

      if (!doc) {
        const mine = Object.values(index).filter((e) => e.ownerId === ownerId && e.status !== 'retired')
        if (mine.length >= MAX_CHARS_PER_ACCOUNT) return { ok: false, error: `캐릭터는 ${MAX_CHARS_PER_ACCOUNT}체까지입니다.` }
        if (totalChars() >= MAX_CHARS_TOTAL) return { ok: false, error: '커뮤니티 캐릭터 수가 한도에 닿았습니다.' }
        doc = {
          id: randomUUID(),
          ownerId,
          name,
          oneLine: '',
          tags: [],
          fullBody: '',
          bust: '',
          thumb: '',
          postId: '',
          profile: {},
          stats: projectStats(schema, {}),
          statsVer: schema.ver,
          looks: [],
          activeLookId: '',
          relations: [],
          bgm: null,
          status: 'draft',
          npc: false,
          wallet: { g: 0, updatedAt: now },
          inv: { capBonus: 0, slots: [], mailbox: [] },
          main: false,
          initialGranted: false,
          createdAt: now,
          updatedAt: now
        }
        shard(ownerId)[doc.id] = doc
      }

      doc.name = name
      doc.oneLine = line(r.oneLine, MAX_ONELINE)
      doc.tags = tagList(r.tags)
      doc.fullBody = assetRef(r.fullBody)
      doc.bust = assetRef(r.bust)
      doc.thumb = assetRef(r.thumb) || doc.thumb
      doc.postId = line(r.postId, 64)
      doc.bgm = normBgm(r.bgm)
      if (r.profile && typeof r.profile === 'object') {
        const prof: Record<string, string> = {}
        for (const [k, v] of Object.entries(r.profile as Record<string, unknown>)) {
          const key = line(k, 40)
          if (key) prof[key] = multi(v, MAX_PROFILE_VALUE)
        }
        doc.profile = prof
      }
      // ★ 능력치 — 양식에서 '본인이 고칠 수 있는' 칸만 받는다.
      //   그 외 칸이 섞여 와도 오류로 만들지 않고 조용히 버린다(구버전 클라가 통째로 보내도 깨지지 않게).
      if (r.stats && typeof r.stats === 'object') {
        const incoming = r.stats as Record<string, unknown>
        for (const f of schema.fields) {
          if (f.owner !== 'user') continue
          const v = incoming[f.key]
          if (v === undefined) continue
          if (f.type === 'text') doc.stats[f.key] = multi(v, 200)
          else if (f.type === 'select') doc.stats[f.key] = f.options.includes(String(v)) ? String(v) : String(f.def)
          else doc.stats[f.key] = num(v, f.min, f.max, Number(f.def))
        }
      }
      doc.statsVer = schema.ver
      doc.updatedAt = now
      touch(doc)
      return { ok: true, value: doc }
    },

    adjustStats(charId, adjusts, memo, now) {
      const doc = find(charId)
      if (!doc) return { ok: false, error: '캐릭터를 찾을 수 없습니다.' }
      // 남의 능력치를 말없이 고치는 길을 막는다 — 사유는 기록과 알림에 그대로 실린다.
      const m = line(memo, MAX_MEMO)
      if (!m) return { ok: false, error: '조정 사유를 입력해 주세요.' }
      if (!Array.isArray(adjusts)) return { ok: false, error: '조정 내용이 올바르지 않습니다.' }
      const changed: StatAdjust[] = []
      for (const raw of adjusts.slice(0, MAX_STAT_FIELDS)) {
        const a = (raw ?? {}) as Record<string, unknown>
        const key = line(a.key, 30)
        const f = schema.fields.find((x) => x.key === key)
        if (!f) continue
        if (f.type === 'text' || f.type === 'select') {
          if (typeof a.value !== 'string') continue
          const v = f.type === 'select' ? (f.options.includes(a.value) ? a.value : String(f.def)) : multi(a.value, 200)
          doc.stats[key] = v
          changed.push({ key, value: v })
        } else {
          const cur = typeof doc.stats[key] === 'number' ? (doc.stats[key] as number) : Number(f.def)
          const next =
            typeof a.value === 'number' ? num(a.value, f.min, f.max, cur) : num(cur + num(a.delta, -1e6, 1e6, 0), f.min, f.max, cur)
          if (next === cur) continue
          doc.stats[key] = next
          changed.push({ key, delta: next - cur, value: next })
        }
      }
      if (!changed.length) return { ok: false, error: '바뀐 값이 없습니다.' }
      doc.updatedAt = now
      touch(doc)
      return { ok: true, value: { doc, changed } }
    },

    applySystemStat(charId, role, delta, now) {
      const doc = find(charId)
      if (!doc) return null
      const f = schema.fields.find((x) => x.systemRole === role)
      if (!f) return null // 양식에 그 의미가 없으면 아무 일도 하지 않는다
      const cur = typeof doc.stats[f.key] === 'number' ? (doc.stats[f.key] as number) : Number(f.def)
      const next = Math.min(f.max, Math.max(f.min, Math.round(cur + delta)))
      if (next === cur) return cur
      doc.stats[f.key] = next
      doc.updatedAt = now
      touch(doc)
      return next
    },

    setStatus(charId, status, now) {
      const doc = find(charId)
      if (!doc) return { ok: false, error: '캐릭터를 찾을 수 없습니다.' }
      if (status !== 'draft' && status !== 'pending' && status !== 'approved' && status !== 'retired') {
        return { ok: false, error: '상태가 올바르지 않습니다.' }
      }
      doc.status = status
      doc.updatedAt = now
      touch(doc)
      return { ok: true, value: doc }
    },

    remove(charId, now) {
      const doc = find(charId)
      if (!doc) return { ok: false, error: '캐릭터를 찾을 수 없습니다.' }
      // 지우지 않고 보관 상태로 넘긴다 — 이미 남의 로그와 역극에 등장한 캐릭터를 지우면 그 글이 깨진다.
      doc.status = 'retired'
      doc.updatedAt = now
      touch(doc)
      return { ok: true, value: doc }
    },

    setLook(charId, lookId, now) {
      const doc = find(charId)
      if (!doc) return { ok: false, error: '캐릭터를 찾을 수 없습니다.' }
      if (lookId && !doc.looks.some((l) => l.id === lookId)) return { ok: false, error: '없는 모습입니다.' }
      doc.activeLookId = lookId
      doc.updatedAt = now
      touch(doc)
      return { ok: true, value: doc }
    },

    addLook(charId, label, fullBody, now) {
      const doc = find(charId)
      if (!doc) return { ok: false, error: '캐릭터를 찾을 수 없습니다.' }
      if (doc.looks.length >= MAX_LOOKS) return { ok: false, error: `모습은 ${MAX_LOOKS}개까지입니다.` }
      const body = assetRef(fullBody)
      if (!body) return { ok: false, error: '전신 이미지를 올려 주세요.' }
      const look: CharLook = { id: randomUUID(), label: line(label, MAX_NAME) || '새 모습', fullBody: body }
      doc.looks.push(look)
      doc.updatedAt = now
      touch(doc)
      return { ok: true, value: look }
    },

    removeLook(charId, lookId, now) {
      const doc = find(charId)
      if (!doc) return { ok: false, error: '캐릭터를 찾을 수 없습니다.' }
      const i = doc.looks.findIndex((l) => l.id === lookId)
      if (i < 0) return { ok: false, error: '없는 모습입니다.' }
      doc.looks.splice(i, 1)
      if (doc.activeLookId === lookId) doc.activeLookId = ''
      doc.updatedAt = now
      touch(doc)
      return { ok: true, value: doc }
    },

    bodyOf(charId) {
      const doc = find(charId)
      if (!doc) return ''
      const look = doc.looks.find((l) => l.id === doc.activeLookId)
      return look ? look.fullBody : doc.fullBody
    },

    mutateOwned(ownerId, charId, now, fn) {
      const doc = find(charId)
      if (!doc) return { ok: false, error: '캐릭터를 찾을 수 없습니다.' }
      if (doc.ownerId !== ownerId) return { ok: false, error: '내 캐릭터만 다룰 수 있습니다.' }
      if (doc.status === 'retired') return { ok: false, error: '보관된 캐릭터입니다.' }
      return runMutation(doc, fn, now)
    },

    mutateAny(charId, now, fn) {
      const doc = find(charId)
      if (!doc) return { ok: false, error: '캐릭터를 찾을 수 없습니다.' }
      return runMutation(doc, fn, now)
    },

    meta: (accountId) => metaOf(accountId),

    mutateMeta(accountId, fn) {
      const meta = metaOf(accountId)
      const snap = JSON.stringify(meta)
      try {
        const value = fn(meta)
        dirtyOwners.add(accountId)
        if (holdWrites === 0) saveOwner(accountId)
        return { ok: true, value }
      } catch (e) {
        metas.set(accountId, JSON.parse(snap) as OwnerMeta)
        return { ok: false, error: e instanceof Error ? e.message : '처리에 실패했습니다.' }
      }
    },

    ownersWithMeta: () => [...metas.keys()],

    setMain(ownerId, charId, now) {
      const doc = find(charId)
      if (!doc) return { ok: false, error: '캐릭터를 찾을 수 없습니다.' }
      if (doc.ownerId !== ownerId) return { ok: false, error: '내 캐릭터만 정할 수 있습니다.' }
      if (doc.status !== 'approved') return { ok: false, error: '승인된 캐릭터만 대표가 될 수 있습니다.' }
      for (const other of Object.values(shard(ownerId))) other.main = other.id === charId
      doc.updatedAt = now
      touch(doc)
      return { ok: true, value: doc }
    },

    mainOf(accountId) {
      const s = shards.get(accountId)
      if (!s) return null
      for (const doc of Object.values(s)) if (doc.main && doc.status === 'approved') return doc
      return null
    },

    all() {
      const out: CharDoc[] = []
      for (const s of shards.values()) for (const doc of Object.values(s)) out.push(doc)
      return out
    },

    bulk(fn) {
      holdWrites++
      try {
        return fn()
      } finally {
        holdWrites--
        if (holdWrites === 0) {
          for (const o of [...dirtyOwners]) saveOwner(o)
          if (indexDirty) saveIndex()
        }
      }
    },

    proposeRelation(charId, toCharId, label, note, now) {
      const doc = find(charId)
      const target = find(toCharId)
      if (!doc || !target) return { ok: false, error: '캐릭터를 찾을 수 없습니다.' }
      if (charId === toCharId) return { ok: false, error: '자기 자신과는 맺을 수 없습니다.' }
      if (doc.relations.length >= MAX_RELATIONS) return { ok: false, error: `관계는 ${MAX_RELATIONS}개까지입니다.` }
      const l = line(label, MAX_NAME)
      if (!l) return { ok: false, error: '관계 이름을 입력해 주세요.' }
      const rel: Relation = {
        toCharId,
        label: l,
        note: multi(note, 500),
        // 같은 오너의 두 캐릭터 사이라면 합의를 물을 상대가 없다.
        status: doc.ownerId === target.ownerId ? 'accepted' : 'pending',
        at: now
      }
      const i = doc.relations.findIndex((x) => x.toCharId === toCharId)
      if (i >= 0) doc.relations[i] = rel
      else doc.relations.push(rel)
      doc.updatedAt = now
      touch(doc)
      return { ok: true, value: rel }
    },

    acceptRelation(charId, fromCharId, now) {
      const doc = find(charId)
      const from = find(fromCharId)
      if (!doc || !from) return { ok: false, error: '캐릭터를 찾을 수 없습니다.' }
      const src = from.relations.find((r) => r.toCharId === charId)
      if (!src) return { ok: false, error: '받을 관계가 없습니다.' }
      src.status = 'accepted'
      from.updatedAt = now
      touch(from)
      // 받아들이면 반대쪽에도 같은 관계를 남긴다(한쪽만 보이면 관계도가 어긋난다).
      const mine: Relation = { toCharId: fromCharId, label: src.label, note: '', status: 'accepted', at: now }
      const i = doc.relations.findIndex((r) => r.toCharId === fromCharId)
      if (i >= 0) doc.relations[i] = { ...doc.relations[i], status: 'accepted' }
      else doc.relations.push(mine)
      doc.updatedAt = now
      touch(doc)
      return { ok: true, value: src }
    },

    removeRelation(charId, toCharId) {
      const doc = find(charId)
      if (!doc) return { ok: false, error: '캐릭터를 찾을 수 없습니다.' }
      doc.relations = doc.relations.filter((r) => r.toCharId !== toCharId)
      touch(doc)
      return { ok: true, value: undefined }
    },

    collectAssetRefs(into) {
      // 상주 인덱스만 본다 — 캐릭터 문서를 열지 않으므로 수집이 동기로 끝난다.
      for (const e of Object.values(index)) for (const r of e.refs) into.add(r)
    },

    removeAll(accountId, now) {
      const s = shards.get(accountId)
      if (!s) return
      // 캐릭터를 지우지 않고 보관으로 넘긴다 — 남의 로그·역극에 이미 등장했기 때문이다.
      for (const doc of Object.values(s)) {
        doc.status = 'retired'
        doc.updatedAt = now
        index[doc.id] = indexOf(doc)
      }
      indexDirty = true
      saveOwner(accountId)
      saveIndex()
    },

    usageFor(accountId) {
      const refs = new Set<string>()
      for (const e of Object.values(index)) if (e.ownerId === accountId) for (const r of e.refs) refs.add(r)
      const bytes = Buffer.byteLength(JSON.stringify(shards.get(accountId) ?? {}), 'utf8')
      return { bytes, refs }
    },

    usage() {
      let bytes = 0
      for (const s of shards.values()) bytes += Buffer.byteLength(JSON.stringify(s), 'utf8')
      return { chars: Object.values(index).filter((e) => e.status !== 'retired').length, bytes }
    },

    flush() {
      if (timer) {
        clearTimeout(timer)
        timer = null
      }
      for (const o of [...dirtyOwners]) saveOwner(o)
      if (indexDirty) saveIndex()
    }
  }
}
