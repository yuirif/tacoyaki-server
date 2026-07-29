// 조사 엔진 — 격자(빙고)형과 선택지(장면)형.
//
// **격자**: 관리자가 행·열 범위를 칠해 구역을 만들고 구역마다 결과 후보를 둔다. 칸을 열면 그 구역에서 뽑는다.
//   주기 초기화에 크론을 두지 않는다. 지금 주기의 이름을 만들어 두고, 판을 읽을 때 저장된 이름과 다르면
//   그 자리에서 빈 판으로 갈아 끼운다. 전 계정을 도는 일도, 스케줄러도 없고, 잠수 계정은 비용이 0이다.
//
// **선택지**: 시작할 때 정의를 통째로 복사해 그 판에 동봉한다. 진행 중에 관리자가 장면을 지워도 끊기지 않고,
//   새 판부터 새 판본이 적용된다. 조건은 문자열 수식이 아니라 구조체다 — eval 을 쓰지 않기 위해서이자,
//   관리자가 문법을 모른 채 드롭다운으로 조립할 수 있게 하기 위해서다.
//
// 소모 순서는 **기간 → 동시 → 쿨다운 → 횟수 → 티켓 → 값**이고, 하나라도 걸리면 아무것도 소모하지 않는다.
import { randomUUID } from 'node:crypto'
import type { Result } from './community'
import type { CharDoc, CommunityCharStore } from './communityChar'
import type { CommunityCatalog } from './communityCatalog'
import type { CommunityEcon, OutcomeApplied } from './communityEcon'
import {
  MAX_STEPS,
  cycleKeyOf,
  emptyUsage,
  weightedPick,
  type CommunityGames,
  type GridDef,
  type GridState,
  type OutcomeCard,
  type OutcomeEffect,
  type SceneChoice,
  type SceneDef,
  type SceneNode,
  type SceneSession
} from './communityGame'
import { bumpUsage, checkRequirement, checkUsage } from './communityQuest'

export interface GridView {
  def: GridDef
  state: GridState
  /** 이번 주기에 몇 번 열 수 있고 몇 번 남았는가. */
  left: number
  blocked: string
  /** 완성된 줄과 아직 남은 줄. */
  lines: { key: string; label: string; done: boolean }[]
}

export interface OpenResult {
  view: GridView
  card: OutcomeCard
  applied: OutcomeApplied
  /** 이번에 완성된 줄과 전체 클리어 보너스. */
  bonus: { kind: 'line' | 'blackout'; label: string; applied: OutcomeApplied }[]
}

export interface SceneView {
  session: SceneSession
  node: SceneNode
  /** 지금 고를 수 있는 선택지만. 잠긴 것은 사유와 함께 남기되, 감추기로 정한 것은 아예 빼고 보낸다. */
  choices: { id: string; label: string; locked: boolean; reason: string; cost: SceneChoice['cost'] }[]
}

export interface CommunitySurveyDeps {
  chars: CommunityCharStore
  games: CommunityGames
  econ: CommunityEcon
  catalog: CommunityCatalog
  random?: () => number
}

export interface CommunitySurvey {
  gridView(accountId: string, charId: string, gridId: string, now: number): Result<GridView>
  open(accountId: string, charId: string, gridId: string, r: number, c: number, now: number): Result<OpenResult>

  sceneView(accountId: string, charId: string, sceneId: string, now: number): Result<SceneView>
  sceneStart(accountId: string, charId: string, sceneId: string, now: number): Result<SceneView>
  sceneChoose(accountId: string, charId: string, sceneId: string, choiceId: string, now: number): Result<{ view: SceneView; applied: OutcomeApplied[]; ended: boolean; endingLabel: string }>
  sceneAbandon(accountId: string, sceneId: string): Result<void>
}

/** 이 칸이 어느 구역인가. 겹쳐 칠했으면 나중에 칠한 것이 이긴다. */
function zoneAt(def: GridDef, r: number, c: number): GridDef['zones'][number] | null {
  let hit: GridDef['zones'][number] | null = null
  for (const z of def.zones) {
    if (r >= z.r0 && r <= z.r1 && c >= z.c0 && c <= z.c1) hit = z
  }
  return hit
}

/** 완성될 수 있는 줄 목록 — 가로·세로·대각 둘. */
function linesOf(def: GridDef): { key: string; label: string; cells: string[] }[] {
  const out: { key: string; label: string; cells: string[] }[] = []
  for (let r = 0; r < def.rows; r++) {
    out.push({ key: `r${r}`, label: `${r + 1}행`, cells: Array.from({ length: def.cols }, (_, c) => `${r},${c}`) })
  }
  for (let c = 0; c < def.cols; c++) {
    out.push({ key: `c${c}`, label: `${String.fromCharCode(65 + c)}열`, cells: Array.from({ length: def.rows }, (_, r) => `${r},${c}`) })
  }
  if (def.rows === def.cols) {
    out.push({ key: 'd0', label: '＼ 대각', cells: Array.from({ length: def.rows }, (_, i) => `${i},${i}`) })
    out.push({ key: 'd1', label: '／ 대각', cells: Array.from({ length: def.rows }, (_, i) => `${i},${def.cols - 1 - i}`) })
  }
  return out
}

export function createCommunitySurvey(deps: CommunitySurveyDeps): CommunitySurvey {
  const { chars, games, econ, catalog } = deps
  const rand = deps.random

  function hpKeyOf(): string {
    return chars.schema().fields.find((f) => f.systemRole === 'hp')?.key ?? ''
  }
  function countIn(doc: CharDoc, defId: string): number {
    let n = 0
    for (const s of doc.inv.slots) if (s?.defId === defId) n += s.qty
    return n
  }

  /** 지금 주기의 판. 저장된 주기가 지났으면 그 자리에서 새 판으로 갈아 끼운다. */
  function gridStateOf(meta: { grids: Record<string, GridState> }, def: GridDef, now: number): GridState {
    const wanted = cycleKeyOf(def.cycle, def.epoch, now)
    const cur = meta.grids[def.id]
    if (cur && cur.cycleKey === wanted) return cur
    const fresh: GridState = { cycleKey: wanted, opened: {}, lines: [], blackout: false }
    meta.grids[def.id] = fresh
    return fresh
  }

  function viewOf(def: GridDef, state: GridState, blocked: string, left: number): GridView {
    return {
      def,
      state,
      left,
      blocked,
      lines: linesOf(def).map((l) => ({ key: l.key, label: l.label, done: state.lines.includes(l.key) }))
    }
  }

  function leftOf(def: GridDef, counter: { windowKey: string; count: number; total: number }, now: number): number {
    if (def.usage.window.kind === 'none') return def.usage.totalCap > 0 ? Math.max(0, def.usage.totalCap - counter.total) : -1
    const wk = cycleKeyOf(def.usage.window.kind === 'day' ? 'daily' : 'weekly', 0, now)
    const used = counter.windowKey === wk ? counter.count : 0
    return Math.max(0, def.usage.window.count - used)
  }

  /** 조건 하나로 선택지를 재는 자리. 잠겼으면 왜 잠겼는지 돌려준다. */
  function lockReason(c: SceneChoice, doc: CharDoc, session: SceneSession, now: number): string {
    if (c.once && session.used.includes(`${session.nodeId}:${c.id}`)) return '이미 고른 길입니다.'
    for (const f of c.cond.flags) {
      const v = session.flags[f.key] ?? 0
      if (f.op === '>=' && v < f.value) return '아직 조건이 되지 않았습니다.'
      if (f.op === '<=' && v > f.value) return '아직 조건이 되지 않았습니다.'
      if (f.op === '==' && v !== f.value) return '아직 조건이 되지 않았습니다.'
    }
    const why = checkRequirement(c.cond, doc, hpKeyOf(), (d) => countIn(doc, d), (d) => catalog.item(d)?.name ?? '필요한 것', 0, now)
    if (why) return why
    if (c.cost.g > 0 && doc.wallet.g < c.cost.g) return '잔액이 모자랍니다.'
    for (const it of c.cost.items) if (countIn(doc, it.defId) < it.count) return '필요한 것이 모자랍니다.'
    return ''
  }

  function sceneViewOf(session: SceneSession, doc: CharDoc, now: number): SceneView | null {
    const node = session.snapshot.nodes.find((n) => n.id === session.nodeId)
    if (!node) return null
    return {
      session,
      node,
      choices: node.choices
        .map((c) => {
          const reason = lockReason(c, doc, session, now)
          return { id: c.id, label: c.label, locked: !!reason, reason, cost: c.cost }
        })
        .filter((c, i) => !(c.locked && node.choices[i].hideWhenLocked))
    }
  }

  return {
    gridView(accountId, charId, gridId, now) {
      const def = games.grid(gridId)
      if (!def || !def.enabled) return { ok: false, error: '조사판을 찾을 수 없습니다.' }
      const doc = chars.get(charId)
      if (!doc || doc.ownerId !== accountId) return { ok: false, error: '내 캐릭터만 쓸 수 있습니다.' }
      const r = chars.mutateMeta(accountId, (meta) => {
        const state = gridStateOf(meta, def, now)
        const counter = (meta.usage[gridId] ??= emptyUsage())
        return viewOf(def, state, checkUsage(def.usage, counter, 0, now), leftOf(def, counter, now))
      })
      return r.ok ? { ok: true, value: r.value } : { ok: false, error: r.error }
    },

    open(accountId, charId, gridId, row, col, now) {
      const def = games.grid(gridId)
      if (!def || !def.enabled) return { ok: false, error: '지금은 열 수 없습니다.' }
      if (row < 0 || row >= def.rows || col < 0 || col >= def.cols) return { ok: false, error: '없는 칸입니다.' }
      const cell = `${row},${col}`
      const bonus: OpenResult['bonus'] = []
      let card: OutcomeCard | null = null
      let applied: OutcomeApplied | null = null

      const r = chars.mutateOwned(accountId, charId, now, (doc, meta): GridView => {
        const state = gridStateOf(meta, def, now)
        if (state.opened[cell]) throw new Error('이미 연 칸입니다.')
        const zone = zoneAt(def, row, col)
        if (!zone) throw new Error('아직 아무것도 없는 자리입니다.')

        // 소모 순서 — 하나라도 걸리면 여기서 던져 아무것도 소모되지 않은 상태로 되돌아간다.
        const counter = (meta.usage[gridId] ??= emptyUsage())
        const blocked = checkUsage(def.usage, counter, 0, now)
        if (blocked) throw new Error(blocked)
        if (def.usage.ticket && countIn(doc, def.usage.ticket.defId) < def.usage.ticket.count) {
          throw new Error('조사에 쓸 것이 모자랍니다.')
        }
        if (def.cost.g > 0 && doc.wallet.g < def.cost.g) throw new Error('잔액이 모자랍니다.')
        for (const it of def.cost.items) if (countIn(doc, it.defId) < it.count) throw new Error('필요한 것이 모자랍니다.')

        const spend: OutcomeEffect = {
          g: -def.cost.g,
          items: [
            ...def.cost.items.map((i) => ({ defId: i.defId, count: -i.count })),
            ...(def.usage.ticket ? [{ defId: def.usage.ticket.defId, count: -def.usage.ticket.count }] : [])
          ],
          stats: [],
          hp: 0,
          flags: {},
          chance: []
        }
        if (spend.g || spend.items.length) econ.applyOutcome(doc, spend, 'survey', gridId, now)

        const pick = weightedPick(zone.pool.map((p) => ({ ...p })), rand)
        const found = def.cards.find((c) => c.id === pick?.cardId) ?? def.cards[0]
        card = found
        state.opened[cell] = { cardId: found.id, at: now }
        applied = econ.applyOutcome(doc, found.effect, 'survey', gridId, now)

        // 줄이 완성됐는지는 열고 난 뒤에 본다. 이미 받은 줄은 다시 세지 않는다.
        for (const l of linesOf(def)) {
          if (state.lines.includes(l.key)) continue
          if (!l.cells.every((k) => state.opened[k])) continue
          state.lines.push(l.key)
          if (def.lineBonus) bonus.push({ kind: 'line', label: l.label, applied: econ.applyOutcome(doc, def.lineBonus, 'survey', gridId, now) })
        }
        if (!state.blackout && Object.keys(state.opened).length >= def.rows * def.cols) {
          state.blackout = true
          if (def.blackoutBonus) bonus.push({ kind: 'blackout', label: '전체 클리어', applied: econ.applyOutcome(doc, def.blackoutBonus, 'survey', gridId, now) })
        }

        bumpUsage(def.usage, counter, now)
        return viewOf(def, state, '', leftOf(def, counter, now))
      })
      if (!r.ok) return { ok: false, error: r.error }
      return { ok: true, value: { view: r.value, card: card as unknown as OutcomeCard, applied: applied as unknown as OutcomeApplied, bonus } }
    },

    sceneView(accountId, charId, sceneId, now) {
      const doc = chars.get(charId)
      if (!doc || doc.ownerId !== accountId) return { ok: false, error: '내 캐릭터만 쓸 수 있습니다.' }
      const session = chars.meta(accountId).scenes[sceneId]
      if (!session || session.ended) return { ok: false, error: '진행 중인 조사가 없습니다.' }
      const view = sceneViewOf(session, doc, now)
      return view ? { ok: true, value: view } : { ok: false, error: '장면을 찾을 수 없습니다.' }
    },

    sceneStart(accountId, charId, sceneId, now) {
      const def = games.scene(sceneId)
      if (!def || !def.enabled) return { ok: false, error: '지금은 들어갈 수 없습니다.' }
      const start = def.nodes.find((n) => n.id === def.startNode)
      if (!start) return { ok: false, error: '시작 장면이 없습니다.' }

      let out: SceneView | null = null
      const r = chars.mutateOwned(accountId, charId, now, (doc, meta): SceneView => {
        const prev = meta.scenes[sceneId]
        if (prev && !prev.ended) throw new Error('이미 진행 중입니다. 이어서 하거나 그만두어야 합니다.')
        const counter = (meta.usage[sceneId] ??= emptyUsage())
        const blocked = checkUsage(def.usage, counter, 0, now)
        if (blocked) throw new Error(blocked)
        if (def.usage.ticket) {
          if (countIn(doc, def.usage.ticket.defId) < def.usage.ticket.count) throw new Error('들어가는 데 필요한 것이 모자랍니다.')
          econ.applyOutcome(
            doc,
            { g: 0, items: [{ defId: def.usage.ticket.defId, count: -def.usage.ticket.count }], stats: [], hp: 0, flags: {}, chance: [] },
            'survey',
            sceneId,
            now
          )
        }

        const session: SceneSession = {
          id: randomUUID(),
          sceneId,
          charId,
          // 시작 시점의 정의를 통째로 안고 간다 — 진행 중에 장면이 바뀌어도 이 판은 끊기지 않는다.
          snapshot: def,
          nodeId: start.id,
          flags: {},
          used: [],
          steps: 0,
          startedAt: now,
          ended: false,
          endingLabel: ''
        }
        if (start.onEnter) econ.applyOutcome(doc, start.onEnter, 'survey', sceneId, now)
        meta.scenes[sceneId] = session
        bumpUsage(def.usage, counter, now)
        const view = sceneViewOf(session, doc, now)
        if (!view) throw new Error('장면을 찾을 수 없습니다.')
        out = view
        return view
      })
      if (!r.ok) return { ok: false, error: r.error }
      return { ok: true, value: out as unknown as SceneView }
    },

    sceneChoose(accountId, charId, sceneId, choiceId, now) {
      const applied: OutcomeApplied[] = []
      let ended = false
      let endingLabel = ''

      const r = chars.mutateOwned(accountId, charId, now, (doc, meta): SceneView => {
        const session = meta.scenes[sceneId]
        if (!session || session.ended) throw new Error('진행 중인 조사가 없습니다.')
        if (session.charId !== charId) throw new Error('이 조사를 시작한 캐릭터가 아닙니다.')
        // 걸음 상한은 무한 루프 안전판이다. 검증기가 막지 못한 순환이 있어도 여기서 끝난다.
        if (session.steps >= MAX_STEPS) throw new Error('너무 오래 헤맸습니다. 조사를 마칩니다.')

        const node = session.snapshot.nodes.find((n) => n.id === session.nodeId)
        if (!node) throw new Error('장면을 찾을 수 없습니다.')

        // 같은 라벨을 여러 줄 둔 것은 확률 분기다. 무게가 있는 줄끼리만 겨룬다.
        const same = node.choices.filter((c) => c.id === choiceId || (c.weight > 0 && c.label === node.choices.find((x) => x.id === choiceId)?.label))
        const base = node.choices.find((c) => c.id === choiceId)
        if (!base) throw new Error('없는 선택지입니다.')
        const why = lockReason(base, doc, session, now)
        if (why) throw new Error(why)
        const chosen = same.length > 1 && same.every((c) => c.weight > 0) ? (weightedPick(same, rand) ?? base) : base

        if (base.cost.g > 0 || base.cost.items.length || base.cost.hp > 0) {
          applied.push(
            econ.applyOutcome(
              doc,
              {
                g: -base.cost.g,
                items: base.cost.items.map((i) => ({ defId: i.defId, count: -i.count })),
                stats: [],
                hp: -base.cost.hp,
                flags: {},
                chance: []
              },
              'survey',
              sceneId,
              now
            )
          )
        }
        if (chosen.effect) applied.push(econ.applyOutcome(doc, chosen.effect, 'survey', sceneId, now))
        for (const [k, v] of Object.entries(chosen.effect?.flags ?? {})) session.flags[k] = (session.flags[k] ?? 0) + v
        if (base.once) session.used.push(`${session.nodeId}:${base.id}`)
        session.steps += 1

        const nextId = chosen.next
        if (nextId === 'END') {
          session.ended = true
          ended = true
        } else {
          const next = session.snapshot.nodes.find((n) => n.id === nextId)
          if (!next) throw new Error('다음 장면을 찾을 수 없습니다.')
          session.nodeId = next.id
          if (next.onEnter) applied.push(econ.applyOutcome(doc, next.onEnter, 'survey', sceneId, now))
          for (const [k, v] of Object.entries(next.onEnter?.flags ?? {})) session.flags[k] = (session.flags[k] ?? 0) + v
          if (next.ending) {
            session.ended = true
            ended = true
            endingLabel = next.ending.label
            session.endingLabel = next.ending.label
            if (next.ending.effect) applied.push(econ.applyOutcome(doc, next.ending.effect, 'survey', sceneId, now))
          }
        }

        const view = sceneViewOf(session, doc, now)
        if (!view) throw new Error('장면을 찾을 수 없습니다.')
        return view
      })
      if (!r.ok) return { ok: false, error: r.error }
      return { ok: true, value: { view: r.value, applied, ended, endingLabel } }
    },

    sceneAbandon(accountId, sceneId) {
      const r = chars.mutateMeta(accountId, (meta) => {
        const s = meta.scenes[sceneId]
        // 그만두는 것은 되돌리는 것이 아니다 — 이미 치른 값과 받은 것은 그대로 둔다.
        if (s) s.ended = true
      })
      return r.ok ? { ok: true, value: undefined } : { ok: false, error: r.error }
    }
  }
}

/** 화면이 쓰는 장면 목록 요약(정의 전체를 보내지 않는다). */
export function sceneBrief(def: SceneDef): { id: string; name: string; desc: string; image: string; nodes: number; version: number } {
  return { id: def.id, name: def.name, desc: def.desc, image: def.image, nodes: def.nodes.length, version: def.version }
}
