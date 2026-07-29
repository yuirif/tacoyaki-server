// 커뮤니티 선물 — 이미지와 편지를 붙여 보내고, 받는 쪽이 승낙해야 옮겨지는 상자.
//
// 핵심은 '보관'이다. 제안하는 순간 물건이 보내는 캐릭터의 소지품에서 빠져나와 이 상자로 들어온다.
// 그래서 같은 물건을 두 사람에게 보내는 일이 아예 성립하지 않는다 — 두 번째 제안은 손에 그게 없어서 실패한다.
// 예약 표도, 잠금도 필요 없어진다.
//
// 상자 안의 물건은 그 동안 누구의 것도 아니다. 그래서 어떤 통계에도 잡히지 않고, 창고로 쓸 이득이 없다.
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, unlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { collectAssetRefs as scanAssetRefs } from './assets'
import { MAIN_CID, isEntityId, stripControl, type Result } from './community'
import type { InvSlot } from './communityChar'

const MAX_LETTER = 1000
const MAX_ITEMS = 8
/** 캐릭터당 아직 답을 못 받은 발신·수신 수. 상자가 무한정 쌓이는 걸 막는다. */
export const MAX_PENDING_OUT = 10
export const MAX_PENDING_IN = 30
/** 답이 없으면 이 기간 뒤에 보낸 사람에게 돌아간다. */
export const GIFT_TTL = 7 * 24 * 60 * 60 * 1000

const ASSET_RE = /^asset:[a-f0-9]{64}$/

export type GiftStatus = 'pending' | 'accepted' | 'declined' | 'cancelled' | 'expired'

export interface Gift {
  id: string
  fromCharId: string
  fromCharName: string
  fromOwnerId: string
  toCharId: string
  toCharName: string
  toOwnerId: string
  /** 보관 중인 화폐. */
  g: number
  /** 보관 중인 물건 — 소지품에서 그대로 옮겨온 사본이다. */
  items: InvSlot[]
  letter: string
  image: string
  status: GiftStatus
  createdAt: number
  expiresAt: number
  resolvedAt: number
}

/** 목록에 필요한 만큼만. 편지 본문은 열 때 읽는다. */
export interface GiftBrief {
  id: string
  fromCharId: string
  fromCharName: string
  fromOwnerId: string
  toCharId: string
  toCharName: string
  toOwnerId: string
  g: number
  itemCount: number
  hasLetter: boolean
  status: GiftStatus
  createdAt: number
  expiresAt: number
  resolvedAt: number
  /** 이 선물이 쥐고 있는 자산 해시(접두 없음). */
  refs: string[]
}

export interface GiftInput {
  fromCharId: string
  fromCharName: string
  fromOwnerId: string
  toCharId: string
  toCharName: string
  toOwnerId: string
  g: number
  items: InvSlot[]
  letter: unknown
  image: unknown
}

export interface CommunityGiftStore {
  /** 상자를 만든다. 보내는 쪽 소지품에서 빼는 것과 같은 동기 구간 안에서 불러야 한다. */
  create(input: GiftInput, now: number): Gift
  get(id: string): Gift | null
  brief(id: string): GiftBrief | null
  /** 상태를 확정한다. 물건을 옮기는 일이 끝난 뒤에 부른다. */
  resolve(id: string, status: Exclude<GiftStatus, 'pending'>, now: number): Result<Gift>
  listFor(ownerId: string): { incoming: GiftBrief[]; outgoing: GiftBrief[] }
  pendingOut(charId: string): number
  pendingIn(charId: string): number
  /** 기한이 지난 것들. 돌려준 뒤 resolve('expired') 를 부르는 건 부르는 쪽 몫이다. */
  overdue(now: number): GiftBrief[]
  /** 이 캐릭터가 얽힌 미결 상자 — 보관 처리될 때 전부 돌려주기 위해. */
  pendingOf(charId: string): GiftBrief[]
  collectAssetRefs(into: Set<string>): void
  usage(): { pending: number; bytes: number }
  flush(): void
}

function multi(v: unknown, max: number): string {
  return typeof v === 'string' ? stripControl(v, true).trim().slice(0, max) : ''
}

function briefOf(g: Gift): GiftBrief {
  const refs = new Set<string>()
  scanAssetRefs(JSON.stringify({ image: g.image, items: g.items }), refs)
  return {
    id: g.id,
    fromCharId: g.fromCharId,
    fromCharName: g.fromCharName,
    fromOwnerId: g.fromOwnerId,
    toCharId: g.toCharId,
    toCharName: g.toCharName,
    toOwnerId: g.toOwnerId,
    g: g.g,
    itemCount: g.items.reduce((a, i) => a + i.qty, 0),
    hasLetter: !!g.letter,
    status: g.status,
    createdAt: g.createdAt,
    expiresAt: g.expiresAt,
    resolvedAt: g.resolvedAt,
    refs: [...refs]
  }
}

export function createCommunityGiftStore(opts?: { dataDir?: string; persist?: boolean }): CommunityGiftStore {
  const persist = opts?.persist !== false
  const root = join(opts?.dataDir ?? join(process.cwd(), 'data'), 'community', MAIN_CID)
  const giftDir = join(root, 'gift')
  const indexPath = join(root, 'giftIndex.json')

  let index: Record<string, GiftBrief> = {}
  /** 최근에 연 상자만 들고 있는다. 목록은 요약으로 충분하다. */
  const cache = new Map<string, Gift>()
  let indexDirty = false
  let timer: NodeJS.Timeout | null = null

  if (persist) {
    try {
      if (existsSync(indexPath)) {
        const d = JSON.parse(readFileSync(indexPath, 'utf8'))
        if (d && typeof d === 'object') index = d as Record<string, GiftBrief>
      }
    } catch (e) {
      console.error('[community/gift] 색인 로드 실패:', e)
    }
    // 색인에 없는 상자가 디스크에 남아 있으면 되살린다 — 색인만 잃고 물건을 잃지 않게.
    try {
      if (existsSync(giftDir)) {
        for (const f of readdirSync(giftDir)) {
          if (!f.endsWith('.json')) continue
          const id = f.slice(0, -5)
          if (index[id]) continue
          try {
            const g = JSON.parse(readFileSync(join(giftDir, f), 'utf8')) as Gift
            if (g?.id) {
              index[g.id] = briefOf(g)
              indexDirty = true
            }
          } catch {
            // 깨진 파일 하나가 나머지를 막지 않는다.
          }
        }
      }
    } catch (e) {
      console.error('[community/gift] 상자 훑기 실패:', e)
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
      console.error('[community/gift] 저장 실패:', path, e)
    }
  }

  function saveIndex(): void {
    indexDirty = false
    writeAtomic(root, indexPath, JSON.stringify(index))
  }
  function scheduleIndex(): void {
    indexDirty = true
    if (!persist || timer) return
    timer = setTimeout(() => {
      timer = null
      if (indexDirty) saveIndex()
    }, 4_000)
    timer.unref?.()
  }

  function saveGift(g: Gift): void {
    if (!isEntityId(g.id)) return
    writeAtomic(giftDir, join(giftDir, `${g.id}.json`), JSON.stringify(g))
    index[g.id] = briefOf(g)
    cache.set(g.id, g)
    if (cache.size > 200) cache.delete(cache.keys().next().value as string)
    scheduleIndex()
  }

  function load(id: string): Gift | null {
    if (!isEntityId(id)) return null
    const hit = cache.get(id)
    if (hit) return hit
    if (!persist) return null
    try {
      const p = join(giftDir, `${id}.json`)
      if (!existsSync(p)) return null
      const g = JSON.parse(readFileSync(p, 'utf8')) as Gift
      cache.set(id, g)
      return g
    } catch {
      return null
    }
  }

  return {
    create(input, now) {
      const gift: Gift = {
        id: randomUUID(),
        fromCharId: input.fromCharId,
        fromCharName: input.fromCharName,
        fromOwnerId: input.fromOwnerId,
        toCharId: input.toCharId,
        toCharName: input.toCharName,
        toOwnerId: input.toOwnerId,
        g: Math.max(0, Math.round(input.g) || 0),
        items: input.items.slice(0, MAX_ITEMS),
        letter: multi(input.letter, MAX_LETTER),
        image: typeof input.image === 'string' && ASSET_RE.test(input.image.trim()) ? input.image.trim() : '',
        status: 'pending',
        createdAt: now,
        expiresAt: now + GIFT_TTL,
        resolvedAt: 0
      }
      // 상자 파일을 먼저 쓴다. 보내는 쪽 파일보다 앞서야 어떤 중간 지점에서 멈춰도 물건이 사라지지 않는다.
      saveGift(gift)
      return gift
    },

    get: (id) => load(id),
    brief: (id) => index[id] ?? null,

    resolve(id, status, now) {
      const g = load(id)
      if (!g) return { ok: false, error: '선물을 찾을 수 없습니다.' }
      // 이미 끝난 상자는 두 번 열리지 않는다. 검사와 전이가 같은 동기 구간에 있어 이중 승낙이 불가능하다.
      if (g.status !== 'pending') return { ok: false, error: '이미 처리된 선물입니다.' }
      g.status = status
      g.resolvedAt = now
      // 옮겨진 뒤에는 상자가 비어야 한다 — 남겨 두면 통계와 자산 회수가 이중으로 센다.
      g.items = []
      g.g = 0
      saveGift(g)
      return { ok: true, value: g }
    },

    listFor(ownerId) {
      const all = Object.values(index)
      const recent = (a: GiftBrief, b: GiftBrief): number => b.createdAt - a.createdAt
      return {
        incoming: all.filter((x) => x.toOwnerId === ownerId && x.status === 'pending').sort(recent),
        outgoing: all.filter((x) => x.fromOwnerId === ownerId && x.status === 'pending').sort(recent)
      }
    },

    pendingOut: (charId) => Object.values(index).filter((x) => x.fromCharId === charId && x.status === 'pending').length,
    pendingIn: (charId) => Object.values(index).filter((x) => x.toCharId === charId && x.status === 'pending').length,

    overdue: (now) => Object.values(index).filter((x) => x.status === 'pending' && x.expiresAt <= now),

    pendingOf: (charId) =>
      Object.values(index).filter((x) => x.status === 'pending' && (x.fromCharId === charId || x.toCharId === charId)),

    collectAssetRefs(into) {
      // 상주 색인만 본다 — 상자 파일을 열지 않으므로 수집이 동기로 끝난다.
      for (const b of Object.values(index)) for (const r of b.refs) into.add(r)
    },

    usage() {
      const pending = Object.values(index).filter((x) => x.status === 'pending')
      return { pending: pending.length, bytes: Buffer.byteLength(JSON.stringify(index), 'utf8') }
    },

    flush() {
      if (timer) {
        clearTimeout(timer)
        timer = null
      }
      if (indexDirty) saveIndex()
    }
  }
}

/** 끝난 선물의 상자 파일을 지운다(색인은 남겨 기록으로 쓴다). 보관 정리에서만 부른다. */
export function purgeGiftFile(dataDir: string, id: string): void {
  if (!isEntityId(id)) return
  try {
    const p = join(dataDir, 'community', MAIN_CID, 'gift', `${id}.json`)
    if (existsSync(p)) unlinkSync(p)
  } catch {
    // 지우지 못해도 다음 정리에서 다시 시도한다.
  }
}

/** 편지 길이 상한 — 화면과 서버가 같은 값을 쓰도록 내보낸다. */
export const GIFT_LETTER_MAX = MAX_LETTER
export const GIFT_ITEMS_MAX = MAX_ITEMS
