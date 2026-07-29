// 광장(Plaza) — 다수 유저가 동시에 존재하며 실시간으로 이동·잡담하는 휘발 인스턴스(서버 비영속).
// 마이룸(1인 권위·소유자만 편집)과 달리 공용 공간이다. 위치 권위는 셀 정수({cx,cy}) — 네트워크엔
//   정수만 흘러 부동소수 누적·역직렬화 흔들림이 없고 페이로드가 작다. 화면 보간은 클라가 한다.
// 서버 권위: 이동은 인접(상하좌우 1칸)·쿨다운·맵 경계로 검증해 워프/스피드핵/맵밖을 막는다(token:move 사상).
// 송신은 100ms 틱 배치 — 그 사이 모인 이동을 액터별로 합쳐 1회 송출하므로, 다수가 걸어도 부하가 평탄하다.
import { randomUUID } from 'node:crypto'
import type { PlazaActor, PlazaChat, PlazaEntity, PlazaFacing, PlazaJoined, PlazaMoveReq, PlazaTick } from './protocol'

// ===== 맵·밸런싱 상수 =====
export const PLAZA_ID = 'plaza-main' // 단일 인스턴스
// 맵 크기(타일 16px) — 원본 크기 건물이 겹치지 않을 만큼 넓다. 카메라는 플레이어를 따라가는 스크롤 맵.
export const PLAZA_COLS = 72 // 맵 가로
export const PLAZA_ROWS = 64 // 맵 세로
export const TILE = 16 // 지형 타일 크기(px). 건물 발자국·차단은 타일 단위, 액터 위치는 아래 px 단위.
export const PLAZA_W = PLAZA_COLS * TILE // 맵 가로(px) — 액터는 연속 px 로 이동(cx,cy=px)
export const PLAZA_H = PLAZA_ROWS * TILE // 맵 세로(px)

// 광장 상점 건물 6종 — 윗줄에 나란히. 발자국(fx,fy,fw,fh)은 진입 불가, 점원 칸(clerkCx,clerkCy)은 건물
//   그래픽 뒤에서 알바 중 유저(없으면 기본 점원 NPC)가 서는 자리. 상호작용 기준 셀(cx,cy)=정면 카운터 앞.
function shopBuilding(shopId: string, label: string, fx: number): PlazaEntity {
  return {
    id: 'shop-' + shopId,
    kind: 'shop',
    cx: fx + 2,
    cy: 6, // 발자국(y3~5) 바로 아래 정면 칸
    radius: 2,
    label,
    shopId,
    sprite: `plaza/shop_${shopId}.png`,
    fx,
    fy: 3,
    fw: 5,
    fh: 3,
    clerkCx: fx + 2,
    clerkCy: 5 // 발자국 맨 아랫줄 — 개구부에 얼굴이 수납되고 카운터가 하반신을 가리는 높이
  }
}
export const PLAZA_ENTITIES: PlazaEntity[] = [
  shopBuilding('bakery', '베이커리', 5),
  shopBuilding('cafe', '카페', 16),
  shopBuilding('restaurant', '레스토랑', 27),
  shopBuilding('flower', '꽃집', 38),
  shopBuilding('furniture', '가구점', 49),
  shopBuilding('handmade', '수제마켓', 60),
  // 낚시터 — 스프라이트·발자국 없는 상호작용 스팟(바닥 마커+간판). 근처에서 Space 로 낚시·요리 패널을 연다.
  { id: 'fishing', kind: 'fishing', cx: 36, cy: 54, radius: 1, label: '낚시터' }
  // 마이룸은 '빈터 입주(건물)'로 세운 건물을 통해서만 들어간다(광장에 별도 포탈 없음).
]

// 건물 발자국 → 진입 불가 셀 집합("x,y"). 서버 이동검증과 클라 예측이 같은 데이터(entities)에서 같은 규칙으로 계산.
export function blockedCellsOf(entities: PlazaEntity[]): Set<string> {
  const s = new Set<string>()
  for (const e of entities) {
    if (e.fx === undefined || e.fy === undefined || !e.fw || !e.fh) continue
    for (let y = e.fy; y < e.fy + e.fh; y++) for (let x = e.fx; x < e.fx + e.fw; x++) s.add(x + ',' + y)
  }
  return s
}
export const PLAZA_BLOCKED: ReadonlySet<string> = blockedCellsOf(PLAZA_ENTITIES)
const MAX_PLAYERS = 40 // 인스턴스 인원 상한(자가호스팅 부하·브로드캐스트 균형)
const TICK_MS = 100 // 틱 배치 간격(10Hz) — 이동은 이 틱으로 배치 브로드캐스트되어 인바운드 빈도와 무관하게 상한
const SAY_MAX_CHARS = 200 // 채팅 길이 상한
const SAY_WINDOW_MS = 5000 // 도배 슬라이딩 윈도
const SAY_WINDOW_MAX = 5 // 윈도당 최대 발화 수
const NICK_MAX = 24
const EMOTE_COOLDOWN_MS = 600 // 이모트 최소 간격(도배 억제)

// 이모트 화이트리스트 — 클라 임의 문자열 주입 차단(서버가 이 목록만 허용). 클라 피커의 상위집합으로
//   유지(항목은 빼지 않고 더한다 — 구버전 클라 피커의 이모트도 계속 통과해 하위호환). 순서는 무관(집합 검증).
export const PLAZA_EMOTES = [
  '❤️', '☺️', '😆', '😎', '👍', '✨', '🎉', // 애정·기쁨
  '🥺', '🥹', '🙏', '🫂', // 애교·부탁·위로
  '😢', '😭', '😳', // 슬픔·당황
  '😠', '😡', // 화남
  '💤', '❓', '🍽️' // 상태·기타
] as const
const EMOTE_SET: ReadonlySet<string> = new Set(PLAZA_EMOTES)

const FACINGS: readonly PlazaFacing[] = ['down', 'up', 'left', 'right']
function validFacing(f: unknown): f is PlazaFacing {
  return typeof f === 'string' && (FACINGS as readonly string[]).includes(f)
}

// 닉네임 색 — playerId 해시로 결정적 선택(전 클라 동일). 무대 가독성용 파스텔.
const NAME_COLORS = ['#7cc4ff', '#ffd479', '#9be58b', '#ff9ec4', '#c4a3ff', '#7be8d2', '#ffb38a', '#b6c2ff']
/** playerId → 결정적 색(전 클라 동일하게 보이도록 서버가 스탬프). */
export function colorFor(playerId: string): string {
  let h = 0
  for (let i = 0; i < playerId.length; i++) h = (h * 31 + playerId.charCodeAt(i)) >>> 0
  return NAME_COLORS[h % NAME_COLORS.length]
}

/** 정수 클램프(순수) — 비정상(NaN 등)은 lo. 액터 위치를 맵 px 경계 안으로 가둔다. */
export function clampPx(v: unknown, lo: number, hi: number): number {
  const n = typeof v === 'number' && Number.isFinite(v) ? Math.round(v) : lo
  return n < lo ? lo : n > hi ? hi : n
}

/** px 좌표가 차단 타일(건물·점유 빈터 발자국) 안인가 — 발끝 px → 타일(floor/16)로 판정. */
export function pxBlocked(px: number, py: number, blocked: ReadonlySet<string>): boolean {
  return blocked.has(Math.floor(px / TILE) + ',' + Math.floor(py / TILE))
}

/** 채팅 정규화(순수) — 공백 정리·길이 컷. 빈 문자열이면 null. */
export function sanitizeSay(text: unknown): string | null {
  if (typeof text !== 'string') return null
  const t = text.replace(/\s+/g, ' ').trim().slice(0, SAY_MAX_CHARS)
  return t || null
}

/** 빈 스폰 셀(순수) — 기준점(origin·기본 중앙)에서 바깥 링으로 스캔, 점유 셀 회피(혼잡 시 겹침 방지). 다 차면 기준점 폴백. */
export function nextFreeSpawn(
  occupied: Set<string>,
  cols: number,
  rows: number,
  origin?: { cx: number; cy: number }
): { cx: number; cy: number } {
  const c0 = origin ? clampPx(origin.cx, 0, cols - 1) : Math.floor(cols / 2)
  const r0 = origin ? clampPx(origin.cy, 0, rows - 1) : Math.floor(rows / 2)
  const maxR = Math.max(cols, rows)
  for (let radius = 0; radius < maxR; radius++) {
    for (let dy = -radius; dy <= radius; dy++) {
      for (let dx = -radius; dx <= radius; dx++) {
        if (Math.max(Math.abs(dx), Math.abs(dy)) !== radius) continue // 링 둘레만(중복 방지)
        const cx = c0 + dx
        const cy = r0 + dy
        if (cx < 0 || cy < 0 || cx >= cols || cy >= rows) continue
        if (!occupied.has(cx + ',' + cy)) return { cx, cy }
      }
    }
  }
  return { cx: c0, cy: r0 }
}

interface Actor {
  playerId: string
  nick: string
  color: string
  cx: number
  cy: number
  facing: PlazaFacing
  moving: boolean
  working: boolean
  workShopId?: string // 알바 중인 가게(working 일 때) — 그 건물 점원 자리 표시용
  look: unknown
  lastMoveAt: number
  lastEmoteAt: number
  /** 마지막으로 처리한 클라 move seq — 틱 moves 에 에코해 클라가 '순수 에코'와 '거부'를 구분(러버밴딩 방지). */
  lastSeq: number
  // 한 계정의 현재 소켓 집합(여러 창·재접속) — 비면 액터 제거. 한 창이 떠나도 다른 창이 있으면 유지.
  sockets: Set<string>
  // 도배 방어(per-actor 슬라이딩 윈도 + 직전 텍스트)
  sayWindowStart: number
  sayCount: number
  lastText: string
}

interface Instance {
  id: string
  actors: Map<string, Actor>
  changed: Set<string> // 이번 틱 이동/방향/걷기 변경
  entered: Set<string> // 이번 틱 신규 입장
  left: string[] // 이번 틱 퇴장
  timer: ReturnType<typeof setInterval> | null
}

export interface PlazaHub {
  /** 입장(또는 같은 계정 새 창/재접속). 가득 차면 ok:false. socketId 가 액터 소켓 집합에 추가된다.
   *  spawnCell(타일 셀) 지정 시 그 칸(또는 근처 빈 칸)에서 스폰 — 내 집/방문한 집 현관 앞 스폰용. */
  enter(
    playerId: string,
    nick: string,
    look: unknown,
    socketId: string,
    spawnCell?: { cx: number; cy: number }
  ): { ok: true; joined: PlazaJoined } | { ok: false; error: string }
  /** 명시적 퇴장(이 소켓만 분리 — 다른 창이 남아 있으면 액터 유지, 마지막이면 제거). */
  leave(playerId: string, socketId: string): void
  /** 연결 종료 정리(이 소켓만 분리 — leave 와 동일 시맨틱). */
  disconnect(playerId: string, socketId: string): void
  /** 이동 의도 처리(검증 통과 시 다음 틱에 반영). */
  move(playerId: string, req: PlazaMoveReq, at?: number): void
  /** 잡담 — 길이·도배 검증 통과 시 브로드캐스트할 메시지 반환. */
  say(playerId: string, text: unknown, at?: number): { ok: boolean; msg?: PlazaChat }
  /** 알바 상태 반영 — 변경 시 다음 틱에 working 전파(다른 유저 "영업 중" 표시). shopId=근무 가게(점원 자리 표시).
   *  presence(nick·look)를 주면 광장에 없던 유저도 점원 액터로 주입 — 탭 위치와 무관하게 카운터에 표시(알바 유지). */
  setWorking(playerId: string, working: boolean, shopId?: string, presence?: { nick?: string; look?: unknown }): void
  /** 동적 차단 셀 갱신(빈터 건물 발자국) — 이동검증에 정적 건물(PLAZA_BLOCKED)과 합쳐 반영. relay 가 부동산 변경 시 호출. */
  setLotBlocked(cells: ReadonlySet<string>): void
  /** 이모트 — 화이트리스트·쿨다운 검증 통과 시 브로드캐스트할 이모트 반환. */
  emote(playerId: string, emote: unknown, at?: number): { ok: boolean; emote?: string }
  /** 인스턴스 인원 수(HUD용). */
  count(plazaId: string): number
  /** 틱 1회(테스트·내부 인터벌 공용). 변화가 있으면 onTick 호출. */
  tickInstance(plazaId: string): void
  /** 모든 인터벌 정리(서버 종료). */
  dispose(): void
}

/**
 * 광장 허브 — 인스턴스 멤버십·이동검증·틱 배치를 소유한다. io 결합을 피해 onTick 콜백으로 송출만 위임.
 * tickMs=0 이면 자동 인터벌 비활성(테스트가 tickInstance 를 수동 호출). now 주입으로 쿨다운·도배 검증을 결정적으로.
 */
export function createPlazaHub(opts: {
  onTick: (plazaId: string, tick: PlazaTick) => void
  now?: () => number
  tickMs?: number
}): PlazaHub {
  const now = opts.now ?? Date.now
  const tickMs = opts.tickMs ?? TICK_MS
  const instances = new Map<string, Instance>()
  const byPlayer = new Map<string, string>() // playerId → plazaId(현재 입장한 인스턴스)
  // 이동 차단 셀 = 정적 건물(PLAZA_BLOCKED) ∪ 동적 빈터 건물(lotBlocked). 합집합은 변경 시에만 재계산(캐시).
  let lotBlocked: ReadonlySet<string> = new Set()
  let blockedUnion: Set<string> = new Set(PLAZA_BLOCKED)
  function rebuildBlocked(): void {
    blockedUnion = new Set(PLAZA_BLOCKED)
    for (const c of lotBlocked) blockedUnion.add(c)
  }

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

  function actorView(a: Actor): PlazaActor {
    return {
      playerId: a.playerId,
      nick: a.nick,
      color: a.color,
      cx: a.cx,
      cy: a.cy,
      facing: a.facing,
      moving: a.moving,
      working: a.working,
      ...(a.workShopId ? { workShopId: a.workShopId } : {}),
      look: a.look ?? null
    }
  }

  function enter(
    playerId: string,
    nick: string,
    look: unknown,
    socketId: string,
    spawnCell?: { cx: number; cy: number }
  ): { ok: true; joined: PlazaJoined } | { ok: false; error: string } {
    const inst = getInstance(PLAZA_ID)
    const cleanNick = (typeof nick === 'string' ? nick.trim().slice(0, NICK_MAX) : '') || '손님'
    let a = inst.actors.get(playerId)
    if (!a) {
      if (inst.actors.size >= MAX_PLAYERS)
        return { ok: false, error: '광장이 가득 찼어요. 잠시 후 다시 시도해 주세요.' }
      const occupied = new Set<string>(blockedUnion) // 건물·빈터 발자국 타일엔 스폰 금지
      for (const o of inst.actors.values()) occupied.add(Math.floor(o.cx / TILE) + ',' + Math.floor(o.cy / TILE)) // 액터 px → 타일
      // 집 현관 등 지정 스폰이 있으면 그 칸(막힌 발자국은 occupied 라 자동 회피)에서, 없으면 맵 중앙에서 빈 칸을 찾는다.
      const sp = nextFreeSpawn(occupied, PLAZA_COLS, PLAZA_ROWS, spawnCell)
      a = {
        playerId,
        nick: cleanNick,
        color: colorFor(playerId),
        cx: sp.cx * TILE + TILE / 2, // 빈 타일 중심 px 로 스폰
        cy: sp.cy * TILE + TILE / 2,
        facing: 'down',
        moving: false,
        working: false, // relay 가 입장 직후 economy.isWorking 으로 setWorking
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
      inst.left = inst.left.filter((p) => p !== playerId) // 같은 틱 재입장 → 직전 퇴장 취소
    } else {
      // 재입장(같은 계정 새 창·화면 재진입) — 위치 유지, 외형·닉 갱신 + 소켓 집합에 추가.
      a.sockets.add(socketId)
      a.nick = cleanNick
      a.look = look ?? a.look
      // seq 카운터 재정렬 — 새로 뜬 클라는 seq 를 0부터 다시 세므로, 잔존 lastSeq(높은 값)를 에코하면
      // 그 클라가 자기 에코를 영영 대조하지 못해 러버밴딩이 재발한다(근무 잔존/재진입 경로).
      a.lastSeq = 0
    }
    byPlayer.set(playerId, PLAZA_ID)
    startTimer(inst)
    const actors: PlazaActor[] = []
    for (const o of inst.actors.values()) if (o.playerId !== playerId) actors.push(actorView(o))
    return {
      ok: true,
      // lots 는 relay 가 estate 스냅샷으로 채운다(허브는 부동산을 모른다). 여기선 빈 배열 자리표시.
      joined: { plazaId: PLAZA_ID, self: actorView(a), cols: PLAZA_COLS, rows: PLAZA_ROWS, actors, entities: PLAZA_ENTITIES, lots: [] }
    }
  }

  function removeFrom(inst: Instance, playerId: string): void {
    if (inst.actors.delete(playerId)) {
      inst.changed.delete(playerId)
      inst.entered.delete(playerId)
      inst.left.push(playerId)
    }
  }

  // 소켓 1개 분리 — 액터의 마지막 소켓이면 제거(다른 창이 남아 있으면 유지). leave/disconnect 공용.
  //   keepIfWorking: 광장 탭 이탈(leave)은 근무 중이면 액터를 카운터에 유지(소켓 0이어도). 소켓 종료(disconnect)는 항상 정리(좀비 방지).
  function detach(playerId: string, socketId: string, keepIfWorking: boolean): void {
    const plazaId = byPlayer.get(playerId)
    if (!plazaId) return
    const inst = instances.get(plazaId)
    const a = inst?.actors.get(playerId)
    if (!inst || !a) {
      byPlayer.delete(playerId)
      return
    }
    const had = a.sockets.delete(socketId)
    if (a.sockets.size === 0) {
      // 근무 중이면 카운터에 유지 — (1) 광장 탭 이탈(leave) (2) 이 소켓이 이 액터 소속이 아니었던(주입된 소켓 없는
      //   점원·이미 탭을 뜬 근무자) 경우의 연결 끊김/재접속(blip). 정리는 퇴근(setWorking false)·계정 삭제(removeAll)로.
      if (a.working && (keepIfWorking || !had)) return
      byPlayer.delete(playerId)
      removeFrom(inst, playerId)
    }
  }

  function leave(playerId: string, socketId: string): void {
    detach(playerId, socketId, true) // 광장 탭 이탈 — 근무 중이면 점원 유지
  }

  function disconnect(playerId: string, socketId: string): void {
    detach(playerId, socketId, false) // 소켓 종료(앱 종료·연결 끊김) — 근무 중이라도 제거
  }

  function move(playerId: string, req: PlazaMoveReq, at = now()): void {
    const plazaId = byPlayer.get(playerId)
    if (!plazaId || !req) return
    const inst = instances.get(plazaId)
    const a = inst?.actors.get(playerId)
    if (!inst || !a) return
    // 연속 px 이동 — 맵 경계 안으로 클램프. 인바운드 빈도는 클라 스로틀(80ms) + 100ms 틱 배치로 이미 상한이라
    //   서버 쿨다운은 두지 않는다(정지·방향 전환 메시지를 떨구지 않기 위함).
    // seq 는 수용/거부와 무관하게 '처리했음'을 에코 — 클라가 이 seq 의 송신 좌표와 대조해 거부만 보정한다.
    if (typeof req.seq === 'number' && isFinite(req.seq) && req.seq > a.lastSeq) a.lastSeq = req.seq
    const cx = clampPx(req.cx, 0, PLAZA_W - 1)
    const cy = clampPx(req.cy, 0, PLAZA_H - 1)
    if (pxBlocked(cx, cy, blockedUnion)) {
      inst.changed.add(playerId) // 건물 발자국 안 = 거부(권위 좌표 에코 → 어긋난 클라가 보정)
      return
    }
    a.cx = cx
    a.cy = cy
    a.lastMoveAt = at
    if (validFacing(req.facing)) a.facing = req.facing
    a.moving = !!req.moving
    inst.changed.add(playerId)
  }

  function say(playerId: string, text: unknown, at = now()): { ok: boolean; msg?: PlazaChat } {
    const plazaId = byPlayer.get(playerId)
    if (!plazaId) return { ok: false }
    const inst = instances.get(plazaId)
    const a = inst?.actors.get(playerId)
    if (!inst || !a) return { ok: false }
    const t = sanitizeSay(text)
    if (!t) return { ok: false }
    // 도배: 5초 5건 슬라이딩 윈도 + 직전과 동일 텍스트 차단.
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

  function setWorking(playerId: string, working: boolean, shopId?: string, presence?: { nick?: string; look?: unknown }): void {
    const inst = getInstance(PLAZA_ID)
    let a = inst.actors.get(playerId)
    if (!a) {
      if (!working) return // 근무 종료인데 광장에 액터가 없으면 할 일 없음
      // 광장에 없던 유저가 근무 시작 — 저장된 외형으로 소켓 없는 점원 액터를 주입(탭 위치·미접속과 무관하게 카운터 유지).
      const shop = PLAZA_ENTITIES.find((e) => e.shopId === shopId)
      const ccx = shop?.clerkCx ?? Math.floor(PLAZA_COLS / 2)
      const ccy = shop?.clerkCy ?? Math.floor(PLAZA_ROWS / 2)
      a = {
        playerId,
        nick: (typeof presence?.nick === 'string' ? presence.nick.trim().slice(0, NICK_MAX) : '') || '점원',
        color: colorFor(playerId),
        cx: ccx * TILE + TILE / 2, // 점원 칸 중심 — 클라가 카운터에 고정(computeClerkPins)하지만 서버 좌표도 합리적으로
        cy: ccy * TILE + TILE / 2,
        facing: 'down',
        moving: false,
        working: false,
        look: presence?.look ?? null,
        lastMoveAt: 0,
        lastEmoteAt: 0,
        lastSeq: 0,
        sockets: new Set(), // 소켓 없음 — 근무 프레즌스(클라 미접속에도 카운터 유지)
        sayWindowStart: 0,
        sayCount: 0,
        lastText: ''
      }
      inst.actors.set(playerId, a)
      inst.entered.add(playerId)
      inst.left = inst.left.filter((p) => p !== playerId)
      byPlayer.set(playerId, PLAZA_ID)
      startTimer(inst)
    }
    const nextShop = working ? shopId : undefined
    if (a.working !== working || a.workShopId !== nextShop) {
      a.working = working
      a.workShopId = nextShop
      inst.changed.add(playerId) // 다음 틱에 working·근무 가게 전파
    }
    // 근무 종료 + 접속 소켓 없음 → 주입/잔류하던 점원 액터 정리(카운터에서 사라지고 기본 NPC 복귀).
    if (!working && a.sockets.size === 0) {
      byPlayer.delete(playerId)
      removeFrom(inst, playerId)
    }
  }

  function emote(playerId: string, emote: unknown, at = now()): { ok: boolean; emote?: string } {
    const plazaId = byPlayer.get(playerId)
    if (!plazaId) return { ok: false }
    const inst = instances.get(plazaId)
    const a = inst?.actors.get(playerId)
    if (!inst || !a) return { ok: false }
    if (typeof emote !== 'string' || !EMOTE_SET.has(emote)) return { ok: false } // 화이트리스트(임의 문자열 차단)
    if (at - a.lastEmoteAt < EMOTE_COOLDOWN_MS) return { ok: false } // 쿨다운(도배 억제)
    a.lastEmoteAt = at
    return { ok: true, emote }
  }

  function count(plazaId: string): number {
    return instances.get(plazaId)?.actors.size ?? 0
  }

  function tickInstance(plazaId: string): void {
    const inst = instances.get(plazaId)
    if (!inst) return
    if (inst.changed.size === 0 && inst.entered.size === 0 && inst.left.length === 0) {
      if (inst.actors.size === 0) stopTimer(inst) // 텅 빈 인스턴스 — 틱 정지(idle CPU 0)
      return
    }
    const moves: PlazaTick['moves'] = []
    for (const pid of inst.changed) {
      const a = inst.actors.get(pid)
      // 신규 입장은 enter 로 풀(외형 포함) 전송하므로 moves 중복 제외.
      if (a && !inst.entered.has(pid))
        moves.push({
          playerId: a.playerId,
          cx: a.cx,
          cy: a.cy,
          facing: a.facing,
          moving: a.moving,
          working: a.working,
          ...(a.workShopId ? { workShopId: a.workShopId } : {}),
          ...(a.lastSeq > 0 ? { seq: a.lastSeq } : {}) // 본인 클라의 에코/거부 판별용(타 클라는 무시)
        })
    }
    const enter: PlazaActor[] = []
    for (const pid of inst.entered) {
      const a = inst.actors.get(pid)
      if (a) enter.push(actorView(a))
    }
    const tick: PlazaTick = { plazaId, moves, enter, leave: inst.left }
    inst.changed.clear()
    inst.entered.clear()
    inst.left = []
    opts.onTick(plazaId, tick)
    if (inst.actors.size === 0) stopTimer(inst)
  }

  function setLotBlocked(cells: ReadonlySet<string>): void {
    lotBlocked = cells
    rebuildBlocked()
  }

  function dispose(): void {
    for (const inst of instances.values()) stopTimer(inst)
  }

  return { enter, leave, disconnect, move, say, setWorking, emote, count, tickInstance, setLotBlocked, dispose }
}
