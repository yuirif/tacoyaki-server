// 퀘스트(파견) 엔진 — 보내고, 기다리고, 결과를 확정하고, 받는다.
//
// 세 가지가 이 파일의 뼈대다.
//
// ① **결과는 만료되는 순간 확정한다. 수령할 때가 아니라.**
//    수령할 때 굴리면 결과가 마음에 안 들 때 받지 않고 관리자가 표를 고치길 기다리는 여지가 생긴다.
//    만료 시 확정하면 그때의 정의 판번호와 확률표 지문이 함께 박혀, 나중에 표가 바뀌어도 대조가 된다.
//
// ② **틱은 알림기일 뿐 진실이 아니다.** 읽는 모든 길이 `지금 >= 끝나는 때` 를 스스로 따지므로,
//    타이머가 한 번도 안 돌아도 기능은 정확하다. 판마다 타이머를 걸지 않고(재시작에 사라지고 수천 개가 된다)
//    끝나는 때를 모아 둔 배열 하나를 10초에 한 번 훑는다. 빌 때는 그마저 멈춘다.
//
// ③ **칸이 없어도 받을 수 있는 것은 받는다.** 전부 거절하면 화폐조차 못 받고 다시 누르기를 반복하게 되고,
//    남는 몫을 버리면 그게 곧 분쟁이 된다. 그래서 부분 수령 + 잔여 보류이고, 보류에는 만료를 두지 않는다.
import { randomUUID } from 'node:crypto'
import type { Result } from './community'
import type { CharDoc, CommunityCharStore } from './communityChar'
import type { CommunityCatalog } from './communityCatalog'
import type { CommunityEcon } from './communityEcon'
import {
  MAX_MINUTES,
  MIN_MINUTES,
  TIER_LABEL,
  cycleKeyOf,
  emptyUsage,
  pickTier,
  powerOf,
  rollEffect,
  tierProbs,
  weightedPick,
  type CommunityGames,
  type EffectItem,
  type QuestDef,
  type QuestRun,
  type Requirement,
  type Tier,
  type UsageRule
} from './communityGame'

/** 끝난 판을 계정마다 몇 개까지 남길지. 기록은 원장에 있으므로 여기 오래 둘 이유가 없다. */
const KEEP_DONE_RUNS = 30
const TICK_MS = 10_000

export interface QuestPreview {
  quest: QuestDef
  power: number
  probs: Record<Tier, number>
  /** 각 캐릭터가 지금 이 퀘스트에 나갈 수 있는가. */
  chars: { charId: string; name: string; ok: boolean; reason: string }[]
  /** 이 계정이 지금 막혀 있다면 그 사유. */
  blocked: string
}

export interface ClaimResult {
  run: QuestRun
  gained: { charId: string; charName: string; g: number; items: { name: string; qty: number }[]; hp: number; stats: { label: string; value: number }[] }[]
  pending: { g: number; items: EffectItem[] } | null
}

export interface CommunityQuestDeps {
  chars: CommunityCharStore
  games: CommunityGames
  econ: CommunityEcon
  /** 조건이 안 맞을 때 무엇이 모자란지 이름으로 말해 주기 위해 필요하다. */
  catalog: CommunityCatalog
  notify?: (accountId: string, text: string, ref?: string) => void
  /** 0 이상 1 미만. 시험에서 결과를 붙박기 위해 갈아 끼운다. */
  random?: () => number
}

export interface CommunityQuest {
  preview(accountId: string, questId: string, charIds: string[], now: number): Result<QuestPreview>
  dispatch(accountId: string, questId: string, charIds: string[], minutes: number, now: number): Result<QuestRun>
  /** 내 판 목록. 읽는 김에 만료된 것을 확정한다(틱을 기다리지 않는다). */
  runs(accountId: string, now: number): QuestRun[]
  claim(accountId: string, runId: string, now: number): Result<ClaimResult>
  cancel(accountId: string, runId: string, now: number): Result<QuestRun>
  /** 이 캐릭터가 지금 나가 있는가 — 보관 처리를 막는 데 쓴다. */
  isBusy(charId: string): boolean
  /** 만료된 판을 훑어 확정하고 아직 알리지 않은 것을 알린다. */
  tick(now: number): number
  start(): void
  stop(): void
  setNotify(fn: (accountId: string, text: string, ref?: string) => void): void
}

// ===== 조건 =====

/** 이 캐릭터가 조건에 맞는가. 맞지 않으면 왜 맞지 않는지 한 줄로 돌려준다. */
export function checkRequirement(
  req: Requirement,
  doc: CharDoc,
  hpKey: string,
  countOf: (defId: string) => number,
  nameOf: (defId: string) => string,
  lastAt: number,
  now: number
): string {
  for (const s of req.stats) {
    const v = doc.stats[s.key]
    const n = typeof v === 'number' ? v : Number(v)
    if (!Number.isFinite(n)) return '능력치가 없습니다.'
    if (s.op === '>=' && n < s.value) return `능력치가 모자랍니다(${s.key} ${n}/${s.value}).`
    if (s.op === '<=' && n > s.value) return `능력치가 너무 높습니다(${s.key} ${n}/${s.value}).`
    if (s.op === '==' && n !== s.value) return `능력치가 맞지 않습니다(${s.key} ${n}≠${s.value}).`
  }
  if (req.hpMin > 0 && hpKey) {
    const hp = typeof doc.stats[hpKey] === 'number' ? (doc.stats[hpKey] as number) : 0
    if (hp < req.hpMin) return `체력이 모자랍니다(${hp}/${req.hpMin}).`
  }
  for (const it of req.items) {
    if (countOf(it.defId) < it.count) return `${nameOf(it.defId)}이(가) 모자랍니다.`
  }
  if (req.tagsAll.length && !req.tagsAll.every((t) => doc.tags.includes(t))) return '태그 조건에 맞지 않습니다.'
  if (req.tagsAny.length && !req.tagsAny.some((t) => doc.tags.includes(t))) return '태그 조건에 맞지 않습니다.'
  if (req.notWithinMs > 0 && lastAt > 0 && now - lastAt < req.notWithinMs) {
    const left = Math.ceil((req.notWithinMs - (now - lastAt)) / 60_000)
    return `아직 쉬어야 합니다(${left}분 남음).`
  }
  return ''
}

/**
 * 이용 제한을 본다. 소모하지는 않는다 — 검사와 소모를 나눠 두면
 * '표를 먹고 횟수에서 막히는' 사고가 생기지 않는다(하나라도 걸리면 아무것도 소모하지 않는다).
 */
export function checkUsage(rule: UsageRule, counter: { lastAt: number; windowKey: string; count: number; total: number }, running: number, now: number): string {
  if (rule.openAt && now < rule.openAt) return '아직 열리지 않았습니다.'
  if (rule.closeAt && now > rule.closeAt) return '기간이 끝났습니다.'
  if (rule.concurrent > 0 && running >= rule.concurrent) return `동시에 ${rule.concurrent}건까지입니다.`
  if (rule.cooldownMs > 0 && counter.lastAt && now - counter.lastAt < rule.cooldownMs) {
    const left = Math.ceil((rule.cooldownMs - (now - counter.lastAt)) / 60_000)
    return `조금 더 기다려 주세요(${left}분).`
  }
  if (rule.window.kind !== 'none') {
    const wk = cycleKeyOf(rule.window.kind === 'day' ? 'daily' : 'weekly', 0, now)
    if (counter.windowKey === wk && counter.count >= rule.window.count) {
      return rule.window.kind === 'day' ? '오늘 몫을 다 썼습니다.' : '이번 주 몫을 다 썼습니다.'
    }
  }
  if (rule.totalCap > 0 && counter.total >= rule.totalCap) return '더는 참여할 수 없습니다.'
  return ''
}

/** 검사를 지난 뒤에만 부른다. 창이 바뀌었으면 세던 수를 0으로 되돌린다. */
export function bumpUsage(rule: UsageRule, counter: { lastAt: number; windowKey: string; count: number; total: number }, now: number): void {
  counter.lastAt = now
  counter.total += 1
  if (rule.window.kind === 'none') return
  const wk = cycleKeyOf(rule.window.kind === 'day' ? 'daily' : 'weekly', 0, now)
  if (counter.windowKey !== wk) {
    counter.windowKey = wk
    counter.count = 0
  }
  counter.count += 1
}

export function createCommunityQuest(deps: CommunityQuestDeps): CommunityQuest {
  const { chars, games, econ, catalog } = deps
  const rand = deps.random
  let notify = deps.notify ?? ((): void => {})
  let timer: NodeJS.Timeout | null = null

  function hpKeyOf(): string {
    return chars.schema().fields.find((f) => f.systemRole === 'hp')?.key ?? ''
  }

  function countIn(doc: CharDoc, defId: string): number {
    let n = 0
    for (const s of doc.inv.slots) if (s?.defId === defId) n += s.qty
    return n
  }

  /**
   * 결과를 확정한다. 이미 확정된 판은 손대지 않는다 — 두 번 굴리는 순간 이 시스템은 믿을 수 없게 된다.
   * 반드시 mutateMeta 안에서 부른다.
   */
  function resolve(run: QuestRun, now: number): boolean {
    if (run.status !== 'running' || now < run.endAt) return false
    if (run.result.length) return false
    const def = run.snapshot
    const results: QuestRun['result'] = []
    for (const charId of run.charIds) {
      const doc = chars.get(charId)
      const power = doc ? powerOf(def.statWeights, doc.stats) : 0
      const probs = tierProbs(power, def.difficulty, def.tuning)
      const tier = pickTier(probs, def.cards, rand)
      const inTier = def.cards.filter((c) => c.tier === tier)
      const card = weightedPick(inTier, rand) ?? def.cards[0]
      results.push({
        charId,
        charName: doc?.name ?? '',
        cardId: card.id,
        tier,
        // 확률 분기는 여기서 펴 둔다 — 수령할 때 다시 굴리면 결과가 흔들린다.
        effect: rollEffect(card.effect, rand)
      })
    }
    run.result = results
    run.status = 'resolved'
    run.resolvedAt = now
    return true
  }

  /** 끝난 판이 계정마다 무한히 쌓이지 않게 오래된 것부터 버린다. 기록은 원장에 남는다. */
  function prune(meta: { runs: Record<string, QuestRun> }): void {
    const done = Object.values(meta.runs)
      .filter((r) => r.status === 'claimed' || r.status === 'cancelled')
      .sort((a, b) => (b.claimedAt || b.resolvedAt || b.endAt) - (a.claimedAt || a.resolvedAt || a.endAt))
    for (const r of done.slice(KEEP_DONE_RUNS)) delete meta.runs[r.id]
  }

  function runningCount(meta: { runs: Record<string, QuestRun> }, questId: string): number {
    return Object.values(meta.runs).filter((r) => r.questId === questId && r.status === 'running').length
  }

  function busyChars(meta: { runs: Record<string, QuestRun> }): Set<string> {
    const s = new Set<string>()
    for (const r of Object.values(meta.runs)) {
      if (r.status === 'running') for (const c of r.charIds) s.add(c)
    }
    return s
  }

  /** 없는 것을 식별자로 말하면 아무 도움이 안 된다. 도감의 이름을 쓴다. */
  function nameOfItem(defId: string): string {
    return catalog.item(defId)?.name ?? '필요한 것'
  }

  const api: CommunityQuest = {
    preview(accountId, questId, charIds, now) {
      const quest = games.quest(questId)
      if (!quest) return { ok: false, error: '퀘스트를 찾을 수 없습니다.' }
      const meta = chars.meta(accountId)
      const hpKey = hpKeyOf()
      const busy = busyChars(meta)
      const counter = meta.usage[questId] ?? emptyUsage()

      const mine = chars.ownedBy(accountId).filter((c) => c.status === 'approved')
      const rows = mine.map((e) => {
        const doc = chars.get(e.id)
        if (!doc) return { charId: e.id, name: e.name, ok: false, reason: '캐릭터를 찾을 수 없습니다.' }
        if (busy.has(e.id)) return { charId: e.id, name: e.name, ok: false, reason: '이미 다른 곳에 나가 있습니다.' }
        if (quest.repeat === 'once-per-char' && counter.doneChars.includes(e.id)) {
          return { charId: e.id, name: e.name, ok: false, reason: '이미 한 번 다녀왔습니다.' }
        }
        const why = checkRequirement(quest.requirement, doc, hpKey, (d) => countIn(doc, d), nameOfItem, counter.lastAt, now)
        return { charId: e.id, name: e.name, ok: !why, reason: why }
      })

      // 고른 캐릭터가 없으면 나갈 수 있는 캐릭터를 기준으로 미리 보여 준다.
      const picked = charIds.length ? charIds : rows.filter((r) => r.ok).slice(0, 1).map((r) => r.charId)
      let power = 0
      for (const id of picked) {
        const doc = chars.get(id)
        if (doc) power += powerOf(quest.statWeights, doc.stats)
      }
      if (picked.length > 1) power *= 1 + (picked.length - 1) * 0.1

      let blocked = checkUsage(quest.usage, counter, runningCount(meta, questId), now)
      if (!blocked && quest.repeat === 'once-per-account' && counter.total > 0) blocked = '계정당 한 번만 참여할 수 있습니다.'

      return {
        ok: true,
        value: { quest, power, probs: tierProbs(power, quest.difficulty, quest.tuning), chars: rows, blocked }
      }
    },

    dispatch(accountId, questId, charIds, minutes, now) {
      const quest = games.quest(questId)
      if (!quest || !quest.enabled) return { ok: false, error: '지금은 나갈 수 없습니다.' }
      const ids = [...new Set(charIds)].slice(0, 8)
      if (!ids.length) return { ok: false, error: '내보낼 캐릭터를 골라 주세요.' }
      const min = quest.party.enabled ? quest.party.min : 1
      const max = quest.party.enabled ? quest.party.max : 1
      if (ids.length < min || ids.length > max) {
        return { ok: false, error: quest.party.enabled ? `${min}~${max}명으로 나갑니다.` : '한 명씩만 나갈 수 있습니다.' }
      }
      // 클라가 보낸 것은 분(minutes)뿐이다. 시각은 언제나 서버가 만든다.
      const mins = Math.min(MAX_MINUTES, Math.max(MIN_MINUTES, Math.round(minutes)))
      if (!quest.durations.includes(mins)) return { ok: false, error: '고를 수 없는 소요 시간입니다.' }

      const hpKey = hpKeyOf()

      // 값을 치르는 캐릭터를 기준으로 잡는다 — 이 헬퍼가 캐릭터 문서와 계정 카운터를 함께 스냅샷 뜨므로,
      // 중간에 조건이 걸려 던져도 치른 값이 남지 않는다.
      const r = chars.mutateOwned(accountId, ids[0], now, (payer, meta): QuestRun => {
        const counter = (meta.usage[questId] ??= emptyUsage())
        const blocked = checkUsage(quest.usage, counter, runningCount(meta, questId), now)
        if (blocked) throw new Error(blocked)
        if (quest.repeat === 'once-per-account' && counter.total > 0) throw new Error('계정당 한 번만 참여할 수 있습니다.')

        const busy = busyChars(meta)
        for (const id of ids) {
          const doc = chars.get(id)
          if (!doc) throw new Error('캐릭터를 찾을 수 없습니다.')
          if (doc.ownerId !== accountId) throw new Error('내 캐릭터만 내보낼 수 있습니다.')
          if (doc.status !== 'approved') throw new Error('승인된 캐릭터만 나갈 수 있습니다.')
          if (busy.has(id)) throw new Error(`${doc.name}은(는) 이미 다른 곳에 나가 있습니다.`)
          if (quest.repeat === 'once-per-char' && counter.doneChars.includes(id)) throw new Error(`${doc.name}은(는) 이미 다녀왔습니다.`)
          const why = checkRequirement(quest.requirement, doc, hpKey, (d) => countIn(doc, d), nameOfItem, counter.lastAt, now)
          if (why) throw new Error(`${doc.name}: ${why}`)
        }

        // 값은 대표 캐릭터(첫 번째)가 치른다. 여러 명에게 나눠 걷으면 되돌릴 지점이 늘어난다.
        if (quest.cost.g > 0 || quest.cost.items.length > 0 || quest.usage.ticket) {
          const cost = {
            g: -quest.cost.g,
            items: [
              ...quest.cost.items.map((i) => ({ defId: i.defId, count: -i.count })),
              ...(quest.usage.ticket ? [{ defId: quest.usage.ticket.defId, count: -quest.usage.ticket.count }] : [])
            ],
            stats: [],
            hp: 0,
            flags: {},
            chance: []
          }
          for (const need of [...quest.cost.items, ...(quest.usage.ticket ? [quest.usage.ticket] : [])]) {
            if (countIn(payer, need.defId) < need.count) throw new Error('필요한 것이 모자랍니다.')
          }
          if (payer.wallet.g < quest.cost.g) throw new Error('잔액이 모자랍니다.')
          econ.applyOutcome(payer, cost, 'quest', questId, now)
        }

        const run: QuestRun = {
          id: randomUUID(),
          questId,
          charIds: ids,
          snapshot: quest,
          startAt: now,
          endAt: now + mins * 60_000,
          status: 'running',
          result: [],
          pending: null,
          notified: false,
          resolvedAt: 0,
          claimedAt: 0
        }
        meta.runs[run.id] = run
        bumpUsage(quest.usage, counter, now)
        if (quest.repeat === 'once-per-char') for (const id of ids) if (!counter.doneChars.includes(id)) counter.doneChars.push(id)
        prune(meta)
        return run
      })
      if (!r.ok) return { ok: false, error: r.error }
      start()
      return { ok: true, value: r.value }
    },

    runs(accountId, now) {
      const meta = chars.meta(accountId)
      // 읽는 김에 확정한다. 틱이 한 번도 안 돌았어도 화면은 정확하다.
      const list = Object.values(meta.runs)
      if (list.some((r) => r.status === 'running' && now >= r.endAt)) {
        chars.mutateMeta(accountId, (m) => {
          for (const r of Object.values(m.runs)) resolve(r, now)
        })
      }
      return Object.values(chars.meta(accountId).runs).sort((a, b) => b.startAt - a.startAt)
    },

    claim(accountId, runId, now) {
      const meta0 = chars.meta(accountId)
      const run0 = meta0.runs[runId]
      if (!run0) return { ok: false, error: '파견을 찾을 수 없습니다.' }

      const gained: ClaimResult['gained'] = []
      let pending: ClaimResult['pending'] = null

      const r = chars.mutateMeta(accountId, (meta) => {
        const run = meta.runs[runId]
        if (!run) throw new Error('파견을 찾을 수 없습니다.')
        resolve(run, now)
        // 이미 다 받은 판을 또 누르면 같은 답을 돌려준다(같은 요청을 두 번 보내도 두 번 주지 않는다).
        if (run.status === 'claimed') return run
        if (run.status !== 'resolved') throw new Error('아직 진행 중입니다.')

        for (const res of run.result) {
          const doc = chars.get(res.charId)
          if (!doc || doc.ownerId !== accountId) continue
          const applied = econ.applyOutcome(doc, res.effect, 'quest', run.id, now, { allowPending: true })
          gained.push({
            charId: res.charId,
            charName: res.charName || doc.name,
            g: applied.g,
            items: applied.items.map((i) => ({ name: i.name, qty: i.qty })),
            hp: applied.hp,
            stats: applied.stats.map((s) => ({ label: s.label, value: s.value }))
          })
          if (applied.leftover.length) {
            // 못 받은 몫은 사라지지 않는다. 만료도 두지 않는다.
            const prev = run.pending ?? { g: 0, items: [] }
            for (const l of applied.leftover) {
              const hit = prev.items.find((x) => x.defId === l.defId)
              if (hit) hit.count += l.count
              else prev.items.push({ ...l })
            }
            run.pending = prev
          }
        }
        run.status = run.pending && run.pending.items.length ? 'resolved' : 'claimed'
        if (run.status === 'claimed') run.claimedAt = now
        pending = run.pending
        prune(meta)
        return run
      })
      if (!r.ok) return { ok: false, error: r.error }
      return { ok: true, value: { run: r.value, gained, pending } }
    },

    cancel(accountId, runId, now) {
      const r = chars.mutateMeta(accountId, (meta) => {
        const run = meta.runs[runId]
        if (!run) throw new Error('파견을 찾을 수 없습니다.')
        if (run.status !== 'running') throw new Error('이미 끝난 파견입니다.')
        // 되돌리는 것이 아니라 그만두는 것이다 — 치른 값은 돌려주지 않고, 보상도 없다.
        run.status = 'cancelled'
        run.resolvedAt = now
        prune(meta)
        return run
      })
      return r.ok ? { ok: true, value: r.value } : { ok: false, error: r.error }
    },

    isBusy(charId) {
      const doc = chars.get(charId)
      if (!doc) return false
      for (const r of Object.values(chars.meta(doc.ownerId).runs)) {
        if (r.status === 'running' && r.charIds.includes(charId)) return true
      }
      return false
    },

    tick(now) {
      let n = 0
      let anyRunning = false
      for (const accountId of chars.ownersWithMeta()) {
        const meta = chars.meta(accountId)
        const list = Object.values(meta.runs)
        if (!list.some((r) => r.status === 'running')) continue
        const due = list.filter((r) => r.status === 'running' && now >= r.endAt)
        if (!due.length) {
          anyRunning = true
          continue
        }
        chars.mutateMeta(accountId, (m) => {
          for (const r of Object.values(m.runs)) {
            if (resolve(r, now)) n++
            if (r.status === 'resolved' && !r.notified) {
              r.notified = true
              const best = r.result.map((x) => TIER_LABEL[x.tier]).join(' · ')
              // 파티도 한 건으로 묶어 알린다 — 사람 수만큼 종이 울리면 아무도 읽지 않는다.
              notify(accountId, `${r.snapshot.name} 결과가 나왔습니다 — ${best}`, r.id)
            }
            if (r.status === 'running') anyRunning = true
          }
        })
      }
      if (!anyRunning) stop()
      return n
    },

    start,
    stop,
    setNotify(fn) {
      notify = fn
    }
  }

  /** 끝나는 때가 하나라도 남아 있을 때만 돈다. 비면 스스로 멈춰 유휴 서버에서 비용이 0이 된다. */
  function start(): void {
    if (timer) return
    timer = setInterval(() => api.tick(Date.now()), TICK_MS)
    timer.unref?.()
  }
  function stop(): void {
    if (!timer) return
    clearInterval(timer)
    timer = null
  }

  return api
}
