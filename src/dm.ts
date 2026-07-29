// 유저 간 DM(다이렉트 메시지) 저장소 — 대화는 두 userId 정렬쌍 키 파일에 영속(<dataDir>/dm/<a__b>.json).
// 계정·캐릭터 저장소와 동일 패턴(원자적 tmp→rename, 지연 로드). 실시간 전달은 relay.ts(소켓 개인룸)에서.
import { readFileSync, existsSync, readdirSync } from 'node:fs'
import { mkdir, writeFile, rename, unlink } from 'node:fs/promises'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import type { DmMessage } from './protocol'

export interface DmConversationSummary {
  peerId: string
  last: string
  lastFrom: string
  updatedAt: number
}

/** 그룹 DM 메타 — 파일(<dataDir>/groups/<threadId>.json)에 messages/cleared 와 함께 영속. */
export interface DmGroupMeta {
  threadId: string
  /** 참가자 userId 목록(중복 없음). 비면 그룹 소멸(파일 삭제). */
  members: string[]
  title?: string
  createdAt: number
}

/** 그룹 DM 목록 요약 — /dm/list 동봉용. 빈 그룹(메시지 0)도 포함(방금 만든 그룹이 보여야 함). */
export interface DmGroupSummary {
  threadId: string
  title?: string
  members: string[]
  last: string
  lastFrom: string
  updatedAt: number
}

export interface DmStore {
  /** from→to 메시지 추가. 같은 사람/빈 텍스트면 null. */
  append(from: string, to: string, text: string): DmMessage | null
  /** 두 사람의 전체 대화(시간순). */
  thread(a: string, b: string): DmMessage[]
  /** userId 가 참여한 대화별 요약(상대·마지막 메시지·시각, 최신순). */
  list(userId: string): DmConversationSummary[]
  /** from 의 메시지(msgId) 본문 수정 — 본인 메시지만. 성공 시 갱신된 메시지, 아니면 null. */
  edit(from: string, peer: string, msgId: string, text: string): DmMessage | null
  /** from 의 메시지(msgId) 삭제 — 본인 메시지만. 성공 시 true. */
  remove(from: string, peer: string, msgId: string): boolean
  /**
   * userId 가 자신의 목록에서 peer 와의 대화를 지움(개인 단위 · 현재까지를 가림).
   * 상대 시점은 유지되고 새 메시지는 다시 보인다. 양쪽 모두 지우면 파일을 삭제해 용량을 회수. 처리했으면 true.
   */
  clearFor(userId: string, peer: string): boolean
  /** 한 사용자의 모든 1:1 대화 삭제(계정 탈퇴 연쇄) — 상대 쪽 파일에서도 제거. 삭제된 대화의 상대 id 목록 반환(상대에게 정리 신호용).
   *  그룹 대화는 건드리지 않는다(그룹 탈퇴는 leaveAllGroups — 잔존 멤버 대화 보존). */
  removeForUser(userId: string): string[]

  // ===== 그룹(단체) DM — threadId 기반. 1:1 pairKey 스킴과 별도 네임스페이스('g:'+threadId, groups/ 하위 파일). =====
  /** 그룹 생성 — creator 자동 포함·중복 제거. 총원 2~MAX_GROUP_MEMBERS 아니면 null. */
  createGroup(creator: string, members: string[], title?: string): DmGroupMeta | null
  /** 그룹 메타 조회(복사본). 없으면 null. */
  group(threadId: string): DmGroupMeta | null
  /** 그룹 메시지 추가 — 멤버만. 반환 메시지는 to='' + threadId 스탬프. */
  appendGroup(from: string, threadId: string, text: string): DmMessage | null
  /** 그룹 전체 대화(개인 가림 컷 적용). 비멤버는 null(빈 대화와 구분 — 접근 거부). */
  groupThread(userId: string, threadId: string): DmMessage[] | null
  /** 그룹 메시지 수정 — 멤버 + 본인 메시지만. */
  editGroup(from: string, threadId: string, msgId: string, text: string): DmMessage | null
  /** 그룹 메시지 삭제 — 멤버 + 본인 메시지만. */
  removeGroup(from: string, threadId: string, msgId: string): boolean
  /** 초대 — inviter 가 멤버·대상이 비멤버·정원 내일 때. 초대된 사람에겐 합류 이전 히스토리를 가린다. */
  invite(inviter: string, threadId: string, userId: string): DmGroupMeta | null
  /** 나가기 — 멤버에서 제거. 마지막 멤버가 나가면 파일 삭제(deleted=true). */
  leave(userId: string, threadId: string): { ok: boolean; deleted: boolean; remaining: string[] }
  /** 그룹 대화 개인 삭제(현재까지 가림). 전원이 가려도 파일은 유지(멤버십이 존재 근거). */
  clearForGroup(userId: string, threadId: string): boolean
  /** userId 가 속한 그룹 요약 목록(최신순). 빈 그룹 포함. */
  listGroups(userId: string): DmGroupSummary[]
  /** 계정 탈퇴 연쇄 — 속한 모든 그룹에서 나간다. 각 그룹의 잔존 멤버 목록 반환(재조회 신호 대상). */
  leaveAllGroups(userId: string): { threadId: string; remaining: string[] }[]
}

const MAX_TEXT = 2000 // 메시지 1건 길이 상한
const MAX_MESSAGES = 1000 // 대화당 보관 메시지 상한(초과 시 오래된 것부터 버림)
export const MAX_GROUP_MEMBERS = 16 // 그룹 DM 정원(본인 포함)
const MAX_GROUP_TITLE = 40 // 그룹 제목 길이 상한

/** 두 userId → 파일 키(정렬쌍, 충돌 회피용 구분자 '__'). */
function pairKey(a: string, b: string): string {
  return [a, b].sort().join('__')
}

/** 그룹 threadId → 내부 키. 1:1 pairKey 와 절대 겹치지 않게 접두사로 네임스페이스 분리. */
function gkey(threadId: string): string {
  return 'g:' + threadId
}
function isGroupKey(key: string): boolean {
  return key.startsWith('g:')
}

export function createDmStore(opts?: { dataDir?: string; persist?: boolean }): DmStore {
  const persist = opts?.persist !== false
  const dataDir = opts?.dataDir ?? join(process.cwd(), 'data', 'dm')
  const groupsDir = join(dataDir, 'groups') // 그룹 파일 하위 디렉터리(1:1 파일명 파싱과 격리)
  const cache = new Map<string, DmMessage[]>() // key(pairKey | 'g:'+threadId) → messages
  // key → { userId: 가린 기준시각 }. 이 값보다 createdAt 이 작거나 같은 메시지는 그 사용자에게 보이지 않는다(개인 대화 삭제).
  const clearedCache = new Map<string, Record<string, number>>()
  const byUser = new Map<string, Set<string>>() // userId → key 집합(list/listGroups 색인)
  const groupMeta = new Map<string, DmGroupMeta>() // threadId → 그룹 메타(멤버·제목)
  const flushing = new Map<string, Promise<void>>() // key → 진행 중 플러시(직렬화)
  let indexed = false

  function fileFor(key: string): string {
    return isGroupKey(key) ? join(groupsDir, key.slice(2) + '.json') : join(dataDir, key + '.json')
  }
  function indexPair(key: string): void {
    const i = key.indexOf('__')
    if (i < 0) return
    const a = key.slice(0, i)
    const b = key.slice(i + 2)
    if (!byUser.has(a)) byUser.set(a, new Set())
    if (!byUser.has(b)) byUser.set(b, new Set())
    byUser.get(a)!.add(key)
    byUser.get(b)!.add(key)
  }
  /** 그룹 멤버 전원을 byUser 색인에 등록. */
  function indexGroup(meta: DmGroupMeta): void {
    const key = gkey(meta.threadId)
    for (const m of meta.members) {
      if (!byUser.has(m)) byUser.set(m, new Set())
      byUser.get(m)!.add(key)
    }
  }
  // 시작 시 색인 — 1:1 은 파일명만(본문 지연 로드), 그룹은 members 를 알아야 하므로 파일을 읽어 메타만 취한다.
  function ensureIndex(): void {
    if (indexed) return
    indexed = true
    if (!persist) return
    try {
      if (existsSync(dataDir)) {
        for (const f of readdirSync(dataDir)) {
          if (f.endsWith('.json') && !f.endsWith('.tmp')) indexPair(f.slice(0, -5))
        }
      }
    } catch {
      /* 무시 */
    }
    try {
      if (existsSync(groupsDir)) {
        for (const f of readdirSync(groupsDir)) {
          if (!f.endsWith('.json') || f.endsWith('.tmp')) continue
          const threadId = f.slice(0, -5)
          try {
            const parsed = JSON.parse(readFileSync(join(groupsDir, f), 'utf8'))
            const members = Array.isArray(parsed?.members)
              ? (parsed.members as unknown[]).filter((x): x is string => typeof x === 'string' && !!x)
              : []
            if (!members.length) continue // 손상/빈 그룹 — 색인하지 않음
            const meta: DmGroupMeta = {
              threadId,
              members,
              ...(typeof parsed.title === 'string' && parsed.title ? { title: parsed.title } : {}),
              createdAt: typeof parsed.createdAt === 'number' ? parsed.createdAt : 0
            }
            groupMeta.set(threadId, meta)
            if (parsed.cleared && typeof parsed.cleared === 'object') {
              clearedCache.set(gkey(threadId), parsed.cleared as Record<string, number>)
            }
            indexGroup(meta) // messages 는 버림 — read() 지연 로드 유지(1:1 과 동일 메모리 프로파일)
          } catch {
            /* 손상 파일 — 건너뜀 */
          }
        }
      }
    } catch {
      /* 무시 */
    }
  }
  function read(key: string): DmMessage[] {
    const hit = cache.get(key)
    if (hit) return hit
    let msgs: DmMessage[] = []
    let cleared: Record<string, number> = {}
    if (persist) {
      try {
        const parsed = JSON.parse(readFileSync(fileFor(key), 'utf8'))
        if (parsed && Array.isArray(parsed.messages)) msgs = parsed.messages as DmMessage[]
        if (parsed && parsed.cleared && typeof parsed.cleared === 'object') {
          cleared = parsed.cleared as Record<string, number>
        }
      } catch {
        /* 없음/손상 → 빈 대화 */
      }
    }
    cache.set(key, msgs)
    if (!clearedCache.has(key)) clearedCache.set(key, cleared)
    return msgs
  }
  /** userId 의 가린 기준시각(없으면 0). read 로 로드 보장 후 조회. */
  function clearedAt(key: string, userId: string): number {
    read(key)
    return clearedCache.get(key)?.[userId] ?? 0
  }
  // 비동기 플러시 — 같은 대화는 직렬화하고, 쓰기 시점의 cache 전체를 기록(누락 방지). 그룹은 메타(멤버·제목)도 함께.
  function flush(key: string): void {
    if (!persist) return
    const prev = flushing.get(key) ?? Promise.resolve()
    const next = prev
      .then(async () => {
        try {
          await mkdir(isGroupKey(key) ? groupsDir : dataDir, { recursive: true })
          const tmp = fileFor(key) + '.tmp'
          const meta = isGroupKey(key) ? groupMeta.get(key.slice(2)) : undefined
          const payload = meta
            ? {
                members: meta.members,
                ...(meta.title ? { title: meta.title } : {}),
                createdAt: meta.createdAt,
                messages: cache.get(key) ?? [],
                cleared: clearedCache.get(key) ?? {}
              }
            : { messages: cache.get(key) ?? [], cleared: clearedCache.get(key) ?? {} }
          await writeFile(tmp, JSON.stringify(payload), 'utf8')
          await rename(tmp, fileFor(key))
        } catch (e) {
          console.error('[dm] 저장 실패:', e)
        }
      })
      .finally(() => {
        if (flushing.get(key) === next) flushing.delete(key)
      })
    flushing.set(key, next)
  }
  /** 대화 파일·캐시·색인 통째로 제거(양쪽 모두 삭제했거나 계정 탈퇴 시 — 용량 회수). 삭제는 진행 중 플러시 뒤에 직렬화. */
  function dropThread(key: string): void {
    cache.delete(key)
    clearedCache.delete(key)
    if (isGroupKey(key)) {
      // 그룹 — 메타의 멤버 색인에서 제거(잘못된 '__' 파싱으로 새지 않게 반드시 여기서 분기).
      const meta = groupMeta.get(key.slice(2))
      if (meta) for (const m of meta.members) byUser.get(m)?.delete(key)
      groupMeta.delete(key.slice(2))
    } else {
      const i = key.indexOf('__')
      if (i >= 0) {
        byUser.get(key.slice(0, i))?.delete(key)
        byUser.get(key.slice(i + 2))?.delete(key)
      }
    }
    if (!persist) return
    const prev = flushing.get(key) ?? Promise.resolve()
    const next = prev
      .then(async () => {
        try {
          await unlink(fileFor(key))
        } catch {
          /* 이미 없음 — 무시 */
        }
      })
      .finally(() => {
        if (flushing.get(key) === next) flushing.delete(key)
      })
    flushing.set(key, next)
  }

  return {
    append(from, to, text) {
      ensureIndex()
      const t = text.trim().slice(0, MAX_TEXT)
      if (!t || !from || !to || from === to) return null
      const key = pairKey(from, to)
      const msgs = read(key)
      const msg: DmMessage = { id: randomUUID(), from, to, text: t, createdAt: Date.now() }
      msgs.push(msg)
      if (msgs.length > MAX_MESSAGES) msgs.splice(0, msgs.length - MAX_MESSAGES)
      cache.set(key, msgs)
      indexPair(key)
      flush(key)
      return msg
    },
    thread(a, b) {
      ensureIndex()
      const key = pairKey(a, b)
      const msgs = read(key)
      const cut = clearedAt(key, a)
      return cut ? msgs.filter((m) => m.createdAt > cut) : msgs.slice()
    },
    list(userId) {
      ensureIndex()
      const keys = byUser.get(userId)
      if (!keys) return []
      const out: DmConversationSummary[] = []
      for (const key of keys) {
        if (isGroupKey(key)) continue // 그룹은 listGroups 가 담당(1:1 요약 형식 오염 방지)
        const msgs = read(key)
        if (!msgs.length) continue
        const cut = clearedCache.get(key)?.[userId] ?? 0
        const visible = cut ? msgs.filter((m) => m.createdAt > cut) : msgs
        if (!visible.length) continue // 이 사용자가 지운 대화(상대가 새 메시지를 보내기 전까지 숨김)
        const i = key.indexOf('__')
        const a = key.slice(0, i)
        const b = key.slice(i + 2)
        const peerId = a === userId ? b : a
        const last = visible[visible.length - 1]
        out.push({ peerId, last: last.text, lastFrom: last.from, updatedAt: last.createdAt })
      }
      out.sort((x, y) => y.updatedAt - x.updatedAt)
      return out
    },
    edit(from, peer, msgId, text) {
      ensureIndex()
      const t = text.trim().slice(0, MAX_TEXT)
      if (!t || !from || !peer || from === peer) return null
      const key = pairKey(from, peer)
      const msgs = read(key)
      const m = msgs.find((x) => x.id === msgId)
      if (!m || m.from !== from) return null // 본인 메시지만
      m.text = t
      cache.set(key, msgs)
      flush(key)
      return m
    },
    remove(from, peer, msgId) {
      ensureIndex()
      if (!from || !peer || from === peer) return false
      const key = pairKey(from, peer)
      const msgs = read(key)
      const i = msgs.findIndex((x) => x.id === msgId)
      if (i < 0 || msgs[i].from !== from) return false // 본인 메시지만
      msgs.splice(i, 1)
      cache.set(key, msgs)
      flush(key)
      return true
    },
    clearFor(userId, peer) {
      ensureIndex()
      if (!userId || !peer || userId === peer) return false
      const key = pairKey(userId, peer)
      const msgs = read(key)
      if (!msgs.length) return false // 대화 없음 — 지울 것 없음
      const last = msgs[msgs.length - 1].createdAt
      const cleared = clearedCache.get(key) ?? {}
      cleared[userId] = Math.max(cleared[userId] ?? 0, last) // 현재까지 가림(이후 새 메시지는 다시 보임)
      clearedCache.set(key, cleared)
      const i = key.indexOf('__')
      const a = key.slice(0, i)
      const b = key.slice(i + 2)
      // 양쪽 모두 마지막 메시지까지 가렸으면 누구에게도 안 보임 → 파일 삭제(용량 회수).
      if ((cleared[a] ?? 0) >= last && (cleared[b] ?? 0) >= last) dropThread(key)
      else flush(key)
      return true
    },
    removeForUser(userId) {
      ensureIndex()
      const keys = byUser.get(userId)
      if (!keys) return []
      const peers: string[] = []
      for (const key of [...keys]) {
        if (isGroupKey(key)) continue // 그룹은 통째 삭제 금지(잔존 멤버 대화 보존) — leaveAllGroups 가 담당
        const i = key.indexOf('__')
        const a = key.slice(0, i)
        const b = key.slice(i + 2)
        const peer = a === userId ? b : a
        if (peer && peer !== userId) peers.push(peer) // 상대 id 수집(정리 신호 대상)
        dropThread(key) // 양쪽 색인에서 제거 + 파일 삭제
      }
      // 그룹 키는 leaveAllGroups(leave)가 개별 제거하므로 byUser 집합은 여기서 통째로 지우지 않는다.
      return peers
    },

    createGroup(creator, members, title) {
      ensureIndex()
      if (!creator) return null
      const uniq = [...new Set([creator, ...members])].filter((x) => typeof x === 'string' && !!x)
      if (uniq.length < 2 || uniq.length > MAX_GROUP_MEMBERS) return null
      // 제어문자 제거(문자코드 판정 — 제어문자 리터럴이 든 정규식 회피) + trim + 길이 캡.
      const t = [...(title ?? '')]
        .filter((c) => c.charCodeAt(0) >= 32 && c.charCodeAt(0) !== 127)
        .join('')
        .trim()
        .slice(0, MAX_GROUP_TITLE)
      const meta: DmGroupMeta = {
        threadId: randomUUID(),
        members: uniq,
        ...(t ? { title: t } : {}),
        createdAt: Date.now()
      }
      groupMeta.set(meta.threadId, meta)
      const key = gkey(meta.threadId)
      cache.set(key, [])
      clearedCache.set(key, {})
      indexGroup(meta)
      flush(key)
      return { ...meta, members: [...meta.members] }
    },
    group(threadId) {
      ensureIndex()
      const meta = groupMeta.get(threadId)
      return meta ? { ...meta, members: [...meta.members] } : null
    },
    appendGroup(from, threadId, text) {
      ensureIndex()
      const meta = groupMeta.get(threadId)
      if (!meta || !from || !meta.members.includes(from)) return null
      const t = text.trim().slice(0, MAX_TEXT)
      if (!t) return null
      const key = gkey(threadId)
      const msgs = read(key)
      // to='' — 구버전 클라가 자기 앞 메시지가 아니라고 판단해 자연 무시(하위호환 지렛대).
      const msg: DmMessage = { id: randomUUID(), from, to: '', text: t, createdAt: Date.now(), threadId }
      msgs.push(msg)
      if (msgs.length > MAX_MESSAGES) msgs.splice(0, msgs.length - MAX_MESSAGES)
      cache.set(key, msgs)
      flush(key)
      return msg
    },
    groupThread(userId, threadId) {
      ensureIndex()
      const meta = groupMeta.get(threadId)
      if (!meta || !userId || !meta.members.includes(userId)) return null // 비멤버 — 접근 거부(null)
      const key = gkey(threadId)
      const msgs = read(key)
      const cut = clearedAt(key, userId)
      return cut ? msgs.filter((m) => m.createdAt > cut) : msgs.slice()
    },
    editGroup(from, threadId, msgId, text) {
      ensureIndex()
      const meta = groupMeta.get(threadId)
      if (!meta || !from || !meta.members.includes(from)) return null
      const t = text.trim().slice(0, MAX_TEXT)
      if (!t) return null
      const key = gkey(threadId)
      const msgs = read(key)
      const m = msgs.find((x) => x.id === msgId)
      if (!m || m.from !== from) return null // 본인 메시지만
      m.text = t
      cache.set(key, msgs)
      flush(key)
      return m
    },
    removeGroup(from, threadId, msgId) {
      ensureIndex()
      const meta = groupMeta.get(threadId)
      if (!meta || !from || !meta.members.includes(from)) return false
      const key = gkey(threadId)
      const msgs = read(key)
      const i = msgs.findIndex((x) => x.id === msgId)
      if (i < 0 || msgs[i].from !== from) return false // 본인 메시지만
      msgs.splice(i, 1)
      cache.set(key, msgs)
      flush(key)
      return true
    },
    invite(inviter, threadId, userId) {
      ensureIndex()
      const meta = groupMeta.get(threadId)
      if (!meta || !inviter || !userId) return null
      if (!meta.members.includes(inviter)) return null // 멤버만 초대 가능
      if (meta.members.includes(userId)) return null // 이미 멤버
      if (meta.members.length >= MAX_GROUP_MEMBERS) return null // 정원 초과
      meta.members.push(userId)
      const key = gkey(threadId)
      const msgs = read(key)
      // 합류 이전 히스토리 가림 — 기존 cleared 메커니즘 재사용(서버 시각 기준·클라 시계 무관).
      const cleared = clearedCache.get(key) ?? {}
      cleared[userId] = msgs.length ? msgs[msgs.length - 1].createdAt : 0
      clearedCache.set(key, cleared)
      if (!byUser.has(userId)) byUser.set(userId, new Set())
      byUser.get(userId)!.add(key)
      flush(key)
      return { ...meta, members: [...meta.members] }
    },
    leave(userId, threadId) {
      ensureIndex()
      const meta = groupMeta.get(threadId)
      if (!meta || !userId || !meta.members.includes(userId)) return { ok: false, deleted: false, remaining: [] }
      meta.members = meta.members.filter((m) => m !== userId)
      const key = gkey(threadId)
      byUser.get(userId)?.delete(key)
      // 가림 기준도 제거 — 재초대되면 invite 가 그 시점 기준으로 다시 설정한다.
      const cleared = clearedCache.get(key)
      if (cleared) delete cleared[userId]
      if (meta.members.length === 0) {
        dropThread(key) // 마지막 멤버 퇴장 — 파일 삭제(용량 회수)
        return { ok: true, deleted: true, remaining: [] }
      }
      flush(key)
      return { ok: true, deleted: false, remaining: [...meta.members] }
    },
    clearForGroup(userId, threadId) {
      ensureIndex()
      const meta = groupMeta.get(threadId)
      if (!meta || !userId || !meta.members.includes(userId)) return false
      const key = gkey(threadId)
      const msgs = read(key)
      if (!msgs.length) return false // 가릴 것 없음
      const cleared = clearedCache.get(key) ?? {}
      cleared[userId] = Math.max(cleared[userId] ?? 0, msgs[msgs.length - 1].createdAt)
      clearedCache.set(key, cleared)
      flush(key) // 전원이 가려도 파일 유지 — 멤버십(메타)이 그룹 존재의 근거
      return true
    },
    listGroups(userId) {
      ensureIndex()
      const keys = byUser.get(userId)
      if (!keys) return []
      const out: DmGroupSummary[] = []
      for (const key of keys) {
        if (!isGroupKey(key)) continue
        const meta = groupMeta.get(key.slice(2))
        if (!meta) continue
        const msgs = read(key)
        const cut = clearedCache.get(key)?.[userId] ?? 0
        const visible = cut ? msgs.filter((m) => m.createdAt > cut) : msgs
        const last = visible[visible.length - 1]
        out.push({
          threadId: meta.threadId,
          ...(meta.title ? { title: meta.title } : {}),
          members: [...meta.members],
          last: last?.text ?? '',
          lastFrom: last?.from ?? '',
          updatedAt: last?.createdAt ?? meta.createdAt // 빈 그룹도 목록에 노출(방금 만든 그룹)
        })
      }
      out.sort((x, y) => y.updatedAt - x.updatedAt)
      return out
    },
    leaveAllGroups(userId) {
      ensureIndex()
      // byUser 가 아니라 groupMeta 전체 스캔 — removeForUser 와의 호출 순서 의존을 없앤다.
      const mine = [...groupMeta.values()].filter((g) => g.members.includes(userId))
      const out: { threadId: string; remaining: string[] }[] = []
      for (const g of mine) {
        const r = this.leave(userId, g.threadId)
        if (r.ok) out.push({ threadId: g.threadId, remaining: r.remaining })
      }
      return out
    }
  }
}
