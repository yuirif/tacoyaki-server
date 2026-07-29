// 유저별 알림 피드 저장소 — 로비 종 알림(댓글·답글·방명록·친구·DM)의 영속 원본(<dataDir>/notif/<userId>.json).
// DM 저장소와 동일 패턴(원자적 tmp→rename, 지연 로드, 파일별 직렬화 플러시). 실시간 push 는 relay.ts(notif:new)에서.
import { readFileSync } from 'node:fs'
import { mkdir, writeFile, rename, unlink } from 'node:fs/promises'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import type { NotifItem, NotifKind } from './protocol'

export interface NotifInput {
  kind: NotifKind
  /** 알림을 발생시킨 사람(작성 시점 스냅샷). */
  actor: { id: string; name: string; avatar?: string }
  /** 이동 대상 참조 — comment/reply=postId, dm/friend=상대 userId. */
  ref?: string
  text: string
}

export interface NotifStore {
  /** ownerId 에게 알림 추가. 자기 자신이 낸 소식(owner===actor)은 만들지 않는다(null).
   *  kind='dm' 은 같은 상대(actorId)의 기존 dm 항목을 교체(연속 메시지 도배 방지 — 최신 1건, 미읽음 재점등). */
  push(ownerId: string, n: NotifInput): NotifItem | null
  /** 최신순 전체 목록(상한 내). */
  list(ownerId: string): NotifItem[]
  unreadCount(ownerId: string): number
  /** ids 지정 시 해당 항목만, 없으면 전체 읽음 처리. 바뀐 개수 반환. */
  markRead(ownerId: string, ids?: string[]): number
  /** 알림 전체 지우기(피드 비움) — 지운 개수 반환. 파일은 유지(빈 목록으로 플러시). */
  clear(ownerId: string): number
  /** 계정 탈퇴 연쇄 — 그 사용자의 알림 파일·캐시 제거. */
  removeForUser(ownerId: string): void
}

const MAX_NOTIF = 200 // 유저당 보관 알림 상한(초과 시 오래된 것부터 버림)
const MAX_NOTIF_TEXT = 120 // 본문 발췌 길이 상한

export function createNotifStore(opts?: { dataDir?: string; persist?: boolean }): NotifStore {
  const persist = opts?.persist !== false
  const dataDir = opts?.dataDir ?? join(process.cwd(), 'data', 'notif')
  const cache = new Map<string, NotifItem[]>() // userId → items(오래된 것 → 최신 순으로 보관)
  const flushing = new Map<string, Promise<void>>() // userId → 진행 중 플러시(직렬화)

  function fileFor(userId: string): string {
    return join(dataDir, userId + '.json')
  }
  function read(userId: string): NotifItem[] {
    const hit = cache.get(userId)
    if (hit) return hit
    let items: NotifItem[] = []
    if (persist) {
      try {
        const parsed = JSON.parse(readFileSync(fileFor(userId), 'utf8'))
        if (parsed && Array.isArray(parsed.items)) items = parsed.items as NotifItem[]
      } catch {
        /* 없음/손상 → 빈 피드 */
      }
    }
    cache.set(userId, items)
    return items
  }
  function flush(userId: string): void {
    if (!persist) return
    const prev = flushing.get(userId) ?? Promise.resolve()
    const next = prev
      .then(async () => {
        try {
          await mkdir(dataDir, { recursive: true })
          const tmp = fileFor(userId) + '.tmp'
          await writeFile(tmp, JSON.stringify({ items: cache.get(userId) ?? [] }), 'utf8')
          await rename(tmp, fileFor(userId))
        } catch (e) {
          console.error('[notif] 저장 실패:', e)
        }
      })
      .finally(() => {
        if (flushing.get(userId) === next) flushing.delete(userId)
      })
    flushing.set(userId, next)
  }

  return {
    push(ownerId, n) {
      if (!ownerId || !n?.actor?.id) return null
      if (ownerId === n.actor.id) return null // 자기 알림 금지(셀프 댓글·본인 방명록 등)
      const text = (n.text ?? '').trim().slice(0, MAX_NOTIF_TEXT)
      const items = read(ownerId)
      // DM 은 상대별 최신 1건만 유지 — 같은 상대의 기존 항목을 제거 후 새로 추가(읽음이었어도 재점등).
      if (n.kind === 'dm') {
        const i = items.findIndex((x) => x.kind === 'dm' && x.actorId === n.actor.id)
        if (i >= 0) items.splice(i, 1)
      }
      const item: NotifItem = {
        id: randomUUID(),
        kind: n.kind,
        actorId: n.actor.id,
        actorName: (n.actor.name || '익명').slice(0, 60),
        ...(n.actor.avatar ? { actorAvatar: n.actor.avatar } : {}),
        ...(n.ref ? { ref: n.ref } : {}),
        text,
        createdAt: Date.now(),
        read: false
      }
      items.push(item)
      if (items.length > MAX_NOTIF) items.splice(0, items.length - MAX_NOTIF)
      cache.set(ownerId, items)
      flush(ownerId)
      return item
    },
    list(ownerId) {
      return [...read(ownerId)].reverse() // 최신순
    },
    unreadCount(ownerId) {
      return read(ownerId).reduce((n, x) => n + (x.read ? 0 : 1), 0)
    },
    markRead(ownerId, ids) {
      const items = read(ownerId)
      const want = ids ? new Set(ids) : null
      let changed = 0
      for (const x of items) {
        if (x.read) continue
        if (want && !want.has(x.id)) continue
        x.read = true
        changed++
      }
      if (changed) flush(ownerId)
      return changed
    },
    clear(ownerId) {
      const items = read(ownerId)
      const n = items.length
      if (!n) return 0
      items.length = 0 // 캐시 배열을 비우고 빈 목록으로 영속(파일은 유지 — removeForUser 와 달리 언링크 안 함)
      cache.set(ownerId, items)
      flush(ownerId)
      return n
    },
    removeForUser(ownerId) {
      cache.delete(ownerId)
      if (!persist) return
      const prev = flushing.get(ownerId) ?? Promise.resolve()
      const next = prev
        .then(async () => {
          try {
            await unlink(fileFor(ownerId))
          } catch {
            /* 이미 없음 — 무시 */
          }
        })
        .finally(() => {
          if (flushing.get(ownerId) === next) flushing.delete(ownerId)
        })
      flushing.set(ownerId, next)
    }
  }
}
