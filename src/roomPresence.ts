// 마이룸 실시간 방문 — 한 마이룸(roomId=소유자 id)에 여러 방문자가 동시에 걸어다니고 잡담·이모트하는 휘발 인스턴스.
// 광장(plaza.ts)과 동일한 서버권위 셀정수·100ms 틱 배치 방식. 방 레이아웃은 dottown.ts(영속), 방문자 위치는 여기(휘발).
// 광장과 달리 상점/부동산/알바가 없다(순수 프레즌스). 이동검증·채팅정규화·스폰·색은 plaza 순수 헬퍼를 재사용한다.
//
// 좌표는 클라 렌더 방(손그림 room/1/bg.png = 214×188, 벽94+바닥94)에 맞춘 '픽셀'이다 — 액터는 연속 px 로 이동.
//   클라 DEFAULT_ROOM { floorW:214, floorH:94, wallH:94 }(src/plugins/dottown/src/lib/roomLayout.ts)과 커플링:
//   발끝은 벽 밴드(y<94) 아래 바닥(y 94~188)에만 머문다. 좌우/상하 여백은 클라 VisitRoomStage 와 동일.
// 멤버십은 '소켓 단위'로 추적(socketRoom) — 한 계정(playerId)이 여러 창으로 서로 다른 방에 있어도 방별 액터가
//   독립적으로 유지·정리돼 방 전환 시 이전 방에 고스트 액터/인스턴스가 새지 않는다.
import { randomUUID } from 'node:crypto'
import { clampPx, sanitizeSay, colorFor } from './plaza'
import type { RoomActor, RoomChat, RoomJoined, RoomMoveReq, RoomTick, PlazaFacing } from './protocol'

// ── 마이룸 바닥(px) — 클라 DEFAULT_ROOM(방 214×188·벽 94) 미러. 발끝은 벽 밴드(y<94) 아래에만. ──
export const ROOM_W = 214 // 방 가로(px)
export const ROOM_WALL = 94 // 벽 높이(=바닥 시작 y)
export const ROOM_H = 188 // 방 세로(px) = wallH + floorH
const FEET = 14 // 좌우 발끝 여백(스프라이트가 벽 밖으로 잘리지 않게)
const R_MIN_X = FEET
const R_MAX_X = ROOM_W - FEET // 발끝 x [14, 200]
const R_MIN_Y = ROOM_WALL + 6 // 벽 바로 아래 여백
const R_MAX_Y = ROOM_H - 4 // 발끝 y [100, 184]
const SPAWN_X = Math.round(ROOM_W / 2) // 107 — 방 중앙
const SPAWN_Y = 155 // 매트 위(바닥 하단쪽) — 첫 스폰 위치

// 첫 스폰 px — 매트 위 중앙 하단 근처, 이미 선 방문자와 24px 이상 떨어진 첫 자리(혼잡하면 링 확장).
function roomSpawn(taken: { x: number; y: number }[]): { cx: number; cy: number } {
  const near = (x: number, y: number): boolean => taken.some((t) => Math.abs(t.x - x) + Math.abs(t.y - y) < 24)
  const ring: [number, number][] = [[0, 0], [28, 0], [-28, 0], [0, -24], [28, -24], [-28, -24], [56, 0], [-56, 0], [0, -48]]
  for (const [dx, dy] of ring) {
    const x = clampPx(SPAWN_X + dx, R_MIN_X, R_MAX_X)
    const y = clampPx(SPAWN_Y + dy, R_MIN_Y, R_MAX_Y)
    if (!near(x, y)) return { cx: x, cy: y }
  }
  return { cx: clampPx(SPAWN_X, R_MIN_X, R_MAX_X), cy: clampPx(SPAWN_Y, R_MIN_Y, R_MAX_Y) }
}

const MAX_PER_ROOM = 20 // 한 방 동시 방문자 상한
const TICK_MS = 100
const EMOTE_COOLDOWN_MS = 600
const SAY_WINDOW_MS = 5000
const SAY_WINDOW_MAX = 5
const NICK_MAX = 24

// 이모트 화이트리스트 — 광장과 동일 집합(서버가 검증). 광장 변경과 무관하게 동일 유지하도록 여기 독립 정의.
const ROOM_EMOTES: ReadonlySet<string> = new Set([
  '❤️', '☺️', '😆', '😎', '👍', '✨', '🎉', '🥺', '🥹', '🙏', '🫂', '😢', '😭', '😳', '😠', '😡', '💤', '❓', '🍽️'
])

const FACINGS: readonly PlazaFacing[] = ['down', 'up', 'left', 'right']
function validFacing(f: unknown): f is PlazaFacing {
  return typeof f === 'string' && (FACINGS as readonly string[]).includes(f)
}

interface Actor {
  playerId: string
  nick: string
  color: string
  cx: number
  cy: number
  facing: PlazaFacing
  moving: boolean
  look: unknown
  lastMoveAt: number
  lastEmoteAt: number
  /** 마지막으로 처리한 클라 move seq — 틱 moves 에 에코해 클라가 '순수 에코'와 '거부'를 구분(러버밴딩 방지). */
  lastSeq: number
  sockets: Set<string> // 이 방에 있는 이 계정의 소켓들(여러 창). 비면 액터 제거.
  sayWindowStart: number
  sayCount: number
  lastText: string
}

interface Instance {
  id: string // roomId(소유자 id)
  actors: Map<string, Actor>
  changed: Set<string>
  entered: Set<string>
  left: string[]
  timer: ReturnType<typeof setInterval> | null
}

export interface RoomPresenceHub {
  enter(roomId: string, playerId: string, nick: string, look: unknown, socketId: string): { ok: true; joined: RoomJoined } | { ok: false; error: string }
  leave(playerId: string, socketId: string): void
  disconnect(playerId: string, socketId: string): void
  move(roomId: string, playerId: string, req: RoomMoveReq, at?: number): void
  say(roomId: string, playerId: string, text: unknown, at?: number): { ok: boolean; msg?: RoomChat }
  emote(roomId: string, playerId: string, emote: unknown, at?: number): { ok: boolean; emote?: string }
  count(roomId: string): number
  /** 이 소켓이 현재 있는 방(없으면 undefined) — 테스트/진단용. */
  roomOfSocket(socketId: string): string | undefined
  /** 계정 강제 이탈(알바 시작 등) — 이 playerId 의 모든 방 액터 제거 + 소켓 멤버십 정리(다음 틱 leave 브로드캐스트). */
  kick(playerId: string): void
  tickInstance(roomId: string): void
  dispose(): void
}

/**
 * 마이룸 방문 프레즌스 허브 — 방(roomId)별 인스턴스 멤버십·이동검증·틱 배치. io 결합 회피(onTick 콜백으로 송출 위임).
 * tickMs=0 이면 자동 인터벌 비활성(테스트가 tickInstance 수동 호출). now 주입으로 결정적 검증.
 */
export function createRoomPresenceHub(opts: {
  onTick: (roomId: string, tick: RoomTick) => void
  now?: () => number
  tickMs?: number
}): RoomPresenceHub {
  const now = opts.now ?? Date.now
  const tickMs = opts.tickMs ?? TICK_MS
  const instances = new Map<string, Instance>()
  const socketRoom = new Map<string, string>() // socketId → 현재 방(소켓은 동시 1방). 멤버십의 진실원본.

  function getInstance(id: string): Instance {
    let inst = instances.get(id)
    if (!inst) {
      inst = { id, actors: new Map(), changed: new Set(), entered: new Set(), left: [], timer: null }
      instances.set(id, inst)
    }
    return inst
  }
  function startTimer(inst: Instance): void {
    if (inst.timer || tickMs <= 0) return
    inst.timer = setInterval(() => tickInstance(inst.id), tickMs)
    if (typeof inst.timer.unref === 'function') inst.timer.unref()
  }
  function stopTimer(inst: Instance): void {
    if (inst.timer) {
      clearInterval(inst.timer)
      inst.timer = null
    }
  }

  function actorView(a: Actor): RoomActor {
    return { playerId: a.playerId, nick: a.nick, color: a.color, cx: a.cx, cy: a.cy, facing: a.facing, moving: a.moving, look: a.look ?? null }
  }

  function removeFrom(inst: Instance, playerId: string): void {
    if (inst.actors.delete(playerId)) {
      inst.changed.delete(playerId)
      inst.entered.delete(playerId)
      inst.left.push(playerId)
    }
  }

  // 특정 방에서 이 소켓만 분리 — 그 방 액터의 마지막 소켓이면 액터 제거(방문자 퇴장 예약).
  function detachSocket(roomId: string, playerId: string, socketId: string): void {
    const inst = instances.get(roomId)
    const a = inst?.actors.get(playerId)
    if (!inst || !a) return
    a.sockets.delete(socketId)
    if (a.sockets.size === 0) removeFrom(inst, playerId)
  }

  function enter(
    roomId: string,
    playerId: string,
    nick: string,
    look: unknown,
    socketId: string
  ): { ok: true; joined: RoomJoined } | { ok: false; error: string } {
    if (typeof roomId !== 'string' || !roomId) return { ok: false, error: '방을 찾을 수 없어요.' }
    // 이 소켓이 다른 방에 있었으면(방 전환) 그 방에서 이 소켓만 뺀다 — 다른 창(다른 소켓)의 그 방 소속은 유지.
    const prev = socketRoom.get(socketId)
    if (prev && prev !== roomId) detachSocket(prev, playerId, socketId)
    const inst = getInstance(roomId)
    const cleanNick = (typeof nick === 'string' ? nick.trim().slice(0, NICK_MAX) : '') || '손님'
    let a = inst.actors.get(playerId)
    if (!a) {
      if (inst.actors.size >= MAX_PER_ROOM) return { ok: false, error: '이 방이 가득 찼어요. 잠시 후 다시 시도해 주세요.' }
      const sp = roomSpawn([...inst.actors.values()].map((o) => ({ x: o.cx, y: o.cy })))
      a = {
        playerId,
        nick: cleanNick,
        color: colorFor(playerId),
        cx: sp.cx,
        cy: sp.cy,
        facing: 'down',
        moving: false,
        look: look ?? null,
        lastMoveAt: 0,
        lastEmoteAt: 0,
        lastSeq: 0,
        sockets: new Set([socketId]),
        sayWindowStart: 0,
        sayCount: 0,
        lastText: ''
      }
      inst.actors.set(playerId, a)
      inst.entered.add(playerId)
      inst.left = inst.left.filter((p) => p !== playerId)
    } else {
      a.sockets.add(socketId)
      a.nick = cleanNick
      a.look = look ?? a.look
      // seq 카운터 재정렬 — 새 클라는 0부터 다시 세므로 잔존 lastSeq 에코가 헛보정을 만들지 않게(광장과 동일).
      a.lastSeq = 0
    }
    socketRoom.set(socketId, roomId)
    startTimer(inst)
    const actors: RoomActor[] = []
    for (const o of inst.actors.values()) if (o.playerId !== playerId) actors.push(actorView(o))
    return { ok: true, joined: { roomId, self: actorView(a), cols: ROOM_W, rows: ROOM_H, actors } }
  }

  // 소켓 1개 분리(명시 퇴장/연결 종료 공용) — 그 소켓이 있던 방에서만 정리.
  function detach(playerId: string, socketId: string): void {
    const roomId = socketRoom.get(socketId)
    if (!roomId) return
    socketRoom.delete(socketId)
    detachSocket(roomId, playerId, socketId)
  }
  function leave(playerId: string, socketId: string): void {
    detach(playerId, socketId)
  }
  function disconnect(playerId: string, socketId: string): void {
    detach(playerId, socketId)
  }

  function move(roomId: string, playerId: string, req: RoomMoveReq, at = now()): void {
    const inst = instances.get(roomId)
    const a = inst?.actors.get(playerId)
    if (!inst || !a || !req) return
    // 연속 px 이동 — 바닥(벽 아래) 경계 안으로 클램프. 인바운드 빈도는 클라 스로틀 + 100ms 틱 배치로 이미 상한.
    // seq 는 수용/클램프와 무관하게 '처리했음'을 에코 — 클라가 송신 좌표와 대조해 거부만 보정한다.
    if (typeof req.seq === 'number' && isFinite(req.seq) && req.seq > a.lastSeq) a.lastSeq = req.seq
    a.cx = clampPx(req.cx, R_MIN_X, R_MAX_X)
    a.cy = clampPx(req.cy, R_MIN_Y, R_MAX_Y)
    a.lastMoveAt = at
    if (validFacing(req.facing)) a.facing = req.facing
    a.moving = !!req.moving
    inst.changed.add(playerId)
  }

  function say(roomId: string, playerId: string, text: unknown, at = now()): { ok: boolean; msg?: RoomChat } {
    const inst = instances.get(roomId)
    const a = inst?.actors.get(playerId)
    if (!inst || !a) return { ok: false }
    const t = sanitizeSay(text)
    if (!t) return { ok: false }
    if (at - a.sayWindowStart > SAY_WINDOW_MS) {
      a.sayWindowStart = at
      a.sayCount = 0
    }
    if (a.sayCount >= SAY_WINDOW_MAX) return { ok: false }
    if (t === a.lastText) return { ok: false }
    a.sayCount++
    a.lastText = t
    return { ok: true, msg: { id: randomUUID(), time: at, playerId, nick: a.nick, color: a.color, text: t } }
  }

  function emote(roomId: string, playerId: string, emote: unknown, at = now()): { ok: boolean; emote?: string } {
    const inst = instances.get(roomId)
    const a = inst?.actors.get(playerId)
    if (!inst || !a) return { ok: false }
    if (typeof emote !== 'string' || !ROOM_EMOTES.has(emote)) return { ok: false }
    if (at - a.lastEmoteAt < EMOTE_COOLDOWN_MS) return { ok: false }
    a.lastEmoteAt = at
    return { ok: true, emote }
  }

  function count(roomId: string): number {
    return instances.get(roomId)?.actors.size ?? 0
  }
  function roomOfSocket(socketId: string): string | undefined {
    return socketRoom.get(socketId)
  }
  // 계정 강제 이탈 — 이 playerId 가 들어가 있는 모든 방에서 액터를 제거하고 그 소켓 멤버십을 정리한다.
  //   알바 시작 시 호출: 근무 중엔 어떤 마이룸 라이브에도 아바타로 남지 않게(타인 화면서 즉시 사라짐).
  function kick(playerId: string): void {
    for (const inst of instances.values()) {
      const a = inst.actors.get(playerId)
      if (!a) continue
      for (const sid of a.sockets) socketRoom.delete(sid)
      removeFrom(inst, playerId) // 다음 틱에 leave 브로드캐스트
    }
  }

  function tickInstance(roomId: string): void {
    const inst = instances.get(roomId)
    if (!inst) return
    if (inst.changed.size === 0 && inst.entered.size === 0 && inst.left.length === 0) {
      if (inst.actors.size === 0) {
        stopTimer(inst)
        instances.delete(inst.id)
      }
      return
    }
    const moves: RoomTick['moves'] = []
    for (const pid of inst.changed) {
      const a = inst.actors.get(pid)
      if (a && !inst.entered.has(pid))
        moves.push({
          playerId: a.playerId,
          cx: a.cx,
          cy: a.cy,
          facing: a.facing,
          moving: a.moving,
          ...(a.lastSeq > 0 ? { seq: a.lastSeq } : {}) // 본인 클라의 에코/거부 판별용(타 클라는 무시)
        })
    }
    const enter: RoomActor[] = []
    for (const pid of inst.entered) {
      const a = inst.actors.get(pid)
      if (a) enter.push(actorView(a))
    }
    const tick: RoomTick = { roomId, moves, enter, leave: inst.left }
    inst.changed.clear()
    inst.entered.clear()
    inst.left = []
    opts.onTick(roomId, tick)
    if (inst.actors.size === 0) {
      stopTimer(inst)
      instances.delete(inst.id)
    }
  }

  function dispose(): void {
    for (const inst of instances.values()) stopTimer(inst)
  }

  return { enter, leave, disconnect, move, say, emote, count, roomOfSocket, kick, tickInstance, dispose }
}
