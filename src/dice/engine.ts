// 렌더러 src/renderer/src/lib/dice/engine.ts 의 미러본. 다이스 규칙 변경 시 양쪽을 함께 고친다.
// 순수 함수 + RNG 주입 구조라 서버 권위 굴림에 그대로 쓴다.
import type { CheckResult, SanResult, SumResult, SuccessLevel, DiceResult, OpposedResult } from './types'
import { SUCCESS_LABEL } from './types'

/** [0,1) 난수 생성기 (테스트에서 주입 가능) */
export type RNG = () => number

const defaultRng: RNG = Math.random

/** 성공 단계 판정 (목표값=기능치, roll=1d100). */
export function successLevel(roll: number, target: number): SuccessLevel {
  if (roll === 1) return 'critical'
  const fumbleMin = target < 50 ? 96 : 100
  if (roll >= fumbleMin) return 'fumble'
  if (roll > target) return 'fail'
  if (roll <= Math.floor(target / 5)) return 'extreme'
  if (roll <= Math.floor(target / 2)) return 'hard'
  return 'regular'
}

function rollD100(rng: RNG): number {
  const v = Math.floor(rng() * 10) * 10 + Math.floor(rng() * 10)
  return v === 0 ? 100 : v
}

/** 한 판정에 걸 수 있는 보너스·페널티 주사위 수의 한계. 규칙이 인정하는 최대가 둘이다. */
export const MAX_BONUS_DICE = 2

export interface CheckOpts {
  bonus?: number // 양수=보너스 주사위, 음수=페널티 주사위(하나씩은 서로 지워진다)
  command?: string
  push?: boolean // 밀어붙이기 재시도 굴림
  rng?: RNG
}

/**
 * 기능/능력 판정 (보너스/페널티 주사위 지원).
 *
 * 규칙: 1자리 주사위 하나는 그대로 두고 **10자리 주사위를 하나 더 굴린다.**
 *   보너스면 그중 가장 좋은(낮은) 10자리를, 페널티면 가장 나쁜(높은) 10자리를 쓴다.
 *   1자리를 공유하므로 44 와 24 처럼 뒷자리가 같은 후보들 중에서 고르는 모양이 된다.
 *   보너스 하나와 페널티 하나는 서로 지워지므로, 부르는 쪽이 그 차(net)를 넘긴다.
 *
 * ⚠ 개수는 ±2 로 자른다. 규칙이 인정하는 최대가 둘이기도 하고,
 *   자르지 않으면 `CC+99999999<=50` 같은 입력 한 줄이 굴림 반복으로 서버를 멈춰 세운다.
 */
export function rollCheck(target: number, opts: CheckOpts = {}): CheckResult {
  const rng = opts.rng ?? defaultRng
  const bonus = Math.max(-MAX_BONUS_DICE, Math.min(MAX_BONUS_DICE, Math.trunc(opts.bonus ?? 0)))
  const units = Math.floor(rng() * 10)
  const tensCount = 1 + Math.abs(bonus)
  const candidates: number[] = []
  for (let i = 0; i < tensCount; i++) {
    const v = Math.floor(rng() * 10) * 10 + units
    candidates.push(v === 0 ? 100 : v)
  }
  let roll: number
  if (bonus > 0) roll = Math.min(...candidates)
  else if (bonus < 0) roll = Math.max(...candidates)
  else roll = candidates[0]
  const level = successLevel(roll, target)
  return {
    kind: 'check',
    command: opts.command ?? `CC<=${target}`,
    roll,
    rolls: candidates.length > 1 ? candidates : undefined,
    target,
    level,
    label: SUCCESS_LABEL[level],
    bonus: bonus !== 0 ? bonus : undefined,
    push: opts.push || undefined
  }
}

/**
 * 주사위 식 굴림 — 재귀 하강 평가기. `+ - * /`(우선순위·괄호), `NdM`, 키프/드롭(kh/kl/dh/dl),
 * 단항 부호 지원. 예) "1d6", "2d6+1", "1d3+1d6", "2d6*2", "(1d6+1)*3", "4d6kh3", "4d6dl1", "1d100/2".
 * 반환 modifier: 순수 가산식(곱/나눗셈·키프드롭 없음)이면 합−주사위합(=상수항), 아니면 0.
 * 흔한 주사위 표기를 폭넓게 수용하되 결과 모델(rolls/modifier/total)은 유지한다.
 */
export function rollExpr(expr: string, rng: RNG = defaultRng): { rolls: number[]; modifier: number; total: number } {
  const s = expr.replace(/\s+/g, '')
  const rolls: number[] = []
  let pos = 0
  let nonAdditive = false // 곱/나눗셈·키프드롭이 쓰였는지(쓰였으면 modifier 표시 생략)

  const peek = (): string => s[pos] ?? ''
  function readInt(): number | null {
    const start = pos
    while (pos < s.length && s[pos] >= '0' && s[pos] <= '9') pos++
    return pos === start ? null : parseInt(s.slice(start, pos), 10)
  }
  function rollDice(count: number, sides: number, mode: string | null, keep: number): number {
    const n = Math.max(0, Math.min(1000, count)) // 폭주 방지(최대 1000개)
    const sd = sides < 1 ? 1 : sides
    const results: number[] = []
    for (let i = 0; i < n; i++) results.push(1 + Math.floor(rng() * sd))
    let kept = results
    if (mode) {
      nonAdditive = true
      const sorted = [...results].sort((a, b) => a - b) // 오름차순
      const k = Math.max(0, Math.min(n, keep))
      if (mode === 'kh') kept = sorted.slice(n - k) // 높은 k개 유지
      else if (mode === 'kl') kept = sorted.slice(0, k) // 낮은 k개 유지
      else if (mode === 'dh') kept = sorted.slice(0, n - k) // 높은 k개 버림
      else if (mode === 'dl') kept = sorted.slice(k) // 낮은 k개 버림
    }
    for (const r of kept) rolls.push(r)
    return kept.reduce((a, b) => a + b, 0)
  }
  function parseFactor(): number {
    const ch = peek()
    if (ch === '+') { pos++; return parseFactor() }
    if (ch === '-') { pos++; return -parseFactor() }
    if (ch === '(') {
      pos++
      const v = parseExpr()
      if (peek() === ')') pos++
      return v
    }
    const n = readInt() // 주사위 개수(없으면 1) 또는 상수
    if (peek() === 'd' || peek() === 'D') {
      pos++
      const sides = readInt() ?? 0
      let mode: string | null = null
      let keep = 0
      const two = s.slice(pos, pos + 2).toLowerCase()
      if (two === 'kh' || two === 'kl' || two === 'dh' || two === 'dl') {
        pos += 2
        mode = two
        keep = readInt() ?? 1 // 개수 생략 시 1(예: 2d20kh = 유리한 1개)
      }
      return rollDice(n ?? 1, sides, mode, keep)
    }
    return n ?? 0
  }
  function parseTerm(): number {
    let v = parseFactor()
    for (;;) {
      const op = peek()
      if (op !== '*' && op !== '/') break
      pos++
      nonAdditive = true
      const r = parseFactor()
      v = op === '*' ? v * r : r === 0 ? 0 : v / r // 0 으로 나누기 = 0(식 오류 방어)
    }
    return v
  }
  function parseExpr(): number {
    let v = parseTerm()
    for (;;) {
      const op = peek()
      if (op !== '+' && op !== '-') break
      pos++
      const r = parseTerm()
      v = op === '+' ? v + r : v - r
    }
    return v
  }

  let total = parseExpr()
  total = Math.round(total * 1e6) / 1e6 // 나눗셈 부동소수 오차 정리
  const sumRolls = rolls.reduce((a, b) => a + b, 0)
  const modifier = nonAdditive ? 0 : total - sumRolls
  return { rolls, modifier, total }
}

export interface SumOpts {
  rng?: RNG
  command?: string
}

/** 단순 합산 굴림 (피해/혼합 등) */
export function rollSum(expr: string, opts: SumOpts = {}): SumResult {
  const { rolls, modifier, total } = rollExpr(expr, opts.rng ?? defaultRng)
  return { kind: 'sum', command: opts.command ?? expr, rolls, modifier, total }
}

/**
 * 인라인 굴림 [[식]] → 결과 숫자로 치환. 식이 주사위(NdM[+K])면 굴려서
 * [roll=합계|툴팁] 마크업으로 바꾼다(클라가 hover 로 상세 렌더). 주사위 식이 아니면 원문 그대로.
 * 반드시 송신 시 1회만 해석(멀티=서버 권위)해야 모든 화면에 같은 숫자가 고정된다. 채팅·스크립트 공통.
 */
export function resolveInlineRolls(text: string, rng: RNG = defaultRng): string {
  if (!text.includes('[[')) return text
  return text.replace(/\[\[([^[\]]{1,60})\]\]/g, (full, raw: string) => {
    const expr = raw.trim()
    if (!/^[\d\s+\-*/dDkKhHlL()]+$/.test(expr) || !/\d*d[1-9]\d*/i.test(expr)) return full // 주사위 식(안전 문자·1면 이상)만 치환
    const { rolls, modifier, total } = rollExpr(expr, rng)
    if (!rolls.length) return full
    // 순수 가산식이면 주사위 분해(4+1+1=6) 표시, 곱/나눗셈 등이면 합 분해 생략(식 → 결과).
    const sumRolls = rolls.reduce((a, b) => a + b, 0)
    const useBreakdown = sumRolls + modifier === total && (rolls.length > 1 || modifier !== 0)
    const detail = rolls.join('+') + (modifier ? (modifier > 0 ? '+' : '') + modifier : '')
    const tip = (useBreakdown ? `${expr} → ${detail} = ${total}` : `${expr} → ${total}`).replace(/[\]|]/g, '')
    return `[roll=${total}|${tip}]`
  })
}

export interface SanOpts {
  rng?: RNG
  command?: string
}

/** 이성(SAN) 판정. lossExpr = "성공측/실패측" (예: "1/1d6") */
export function rollSan(target: number, lossExpr: string, opts: SanOpts = {}): SanResult {
  const rng = opts.rng ?? defaultRng
  const roll = rollD100(rng)
  const level = successLevel(roll, target)
  const success = roll <= target || roll === 1
  const [sExpr, fExpr] = lossExpr.split('/')
  const expr = success ? sExpr : (fExpr ?? sExpr)
  const loss = rollExpr(expr, rng).total
  return {
    kind: 'san',
    command: opts.command ?? `SC ${lossExpr}<=${target}`,
    roll,
    target,
    level,
    success,
    loss,
    lossExpr
  }
}

/** 성공 단계 우열(클수록 우세) — 대결 승부 판정용. */
const LEVEL_RANK: Record<SuccessLevel, number> = {
  critical: 5,
  extreme: 4,
  hard: 3,
  regular: 2,
  fail: 1,
  fumble: 0
}
function isSuccessLevel(l: SuccessLevel): boolean {
  return l !== 'fail' && l !== 'fumble'
}

/**
 * 비주얼 카드 매칭용 키워드 후보 — 주사위 결과에서 카드 이름과 견줄 문자열들을 뽑는다.
 * 개별 단계 라벨("일반 성공" 등)과 함께 포괄 라벨("성공"/"실패")도 반환해, GM 이 "성공" 카드 하나만
 * 등록해도 모든 성공 판정에서 컷인이 뜨게 한다(더 구체적인 이름이 앞 = 우선 매칭).
 * chat:roll 로 온 결과는 커스텀 word/judge 도 실릴 수 있어 방어적으로 읽는다(선언 타입엔 없음).
 */
export function diceCardKeywords(dice: DiceResult): string[] {
  const out: string[] = []
  const add = (s: unknown): void => {
    if (typeof s === 'string') {
      const t = s.trim()
      if (t) out.push(t)
    }
  }
  const extra = dice as unknown as { word?: unknown; judge?: { ko?: unknown } }
  if (dice.kind === 'check') {
    add(dice.label) // 박제 한글(커스텀 프로필 라벨 우선)
    add(extra.word) // 커스텀 영문 워드(있으면)
    add(SUCCESS_LABEL[dice.level]) // 표준 단계 한글
    add(isSuccessLevel(dice.level) ? '성공' : '실패') // 포괄 키워드
  } else if (dice.kind === 'san') {
    add(extra.word)
    add(SUCCESS_LABEL[dice.level])
    add(dice.success ? '성공' : '실패')
  } else if (dice.kind === 'opposed') {
    const win = dice.winner === 'a' ? dice.a : dice.winner === 'b' ? dice.b : null
    if (win) {
      add(SUCCESS_LABEL[win.level])
      add(isSuccessLevel(win.level) ? '성공' : '실패')
    } else {
      add('무승부')
    }
  } else if (dice.kind === 'sum') {
    // 2d6 목표판정(클라가 judge 박제) — 그 한글 라벨로 매칭. 순수 합산(피해 등)은 성공/실패 개념 없음.
    add(extra.judge?.ko)
  }
  return [...new Set(out)] // 중복 제거(순서 유지)
}

export interface OpposedOpts {
  rng?: RNG
  command?: string
}

/**
 * 대결 판정 — 양측이 각자 목표값에 1d100. 성공이 실패를 이기고, 둘 다 성공이면
 * 성공 단계가 높은 쪽, 동급이면 목표값(기능치)이 높은 쪽이 승리. 둘 다 실패·완전 동률은 무승부.
 */
export function rollOpposed(targetA: number, targetB: number, opts: OpposedOpts = {}): OpposedResult {
  const rng = opts.rng ?? defaultRng
  const rollA = rollD100(rng)
  const rollB = rollD100(rng)
  const a = { roll: rollA, target: targetA, level: successLevel(rollA, targetA) }
  const b = { roll: rollB, target: targetB, level: successLevel(rollB, targetB) }
  const sa = isSuccessLevel(a.level)
  const sb = isSuccessLevel(b.level)
  let winner: 'a' | 'b' | 'draw'
  if (sa && !sb) winner = 'a'
  else if (sb && !sa) winner = 'b'
  else if (!sa && !sb) winner = 'draw'
  else if (LEVEL_RANK[a.level] !== LEVEL_RANK[b.level]) winner = LEVEL_RANK[a.level] > LEVEL_RANK[b.level] ? 'a' : 'b'
  else if (targetA !== targetB) winner = targetA > targetB ? 'a' : 'b'
  else winner = 'draw'
  return { kind: 'opposed', command: opts.command ?? `CBR(${targetA},${targetB})`, a, b, winner }
}

/**
 * 채팅 입력을 파싱해 판정 실행. 인식 못하면 null(=평문).
 * 지원: CC[+/-n]<=N, 1d100<=N, SC/SAN s/f<=N, 대결 CBR(a,b)·대결 a vs b, 밀어붙이기 push CC<=N, NdM(+K) 식
 */
export function parseCommand(input: string, rng: RNG = defaultRng): DiceResult | null {
  const s = input.trim()
  const direct = parseBareCommand(s, s, rng)
  if (direct) return direct
  // 후행 괄호 라벨 — 채팅 팔레트 형식 "CC<=50 (근력)". 라벨을 떼어 명령만 판정하고 라벨은 카드의
  // 이름(name)으로 박제한다(시트 굴림과 동일 표기). 여는 괄호 후보를 왼쪽부터 시도해, 명령 본문에
  // 괄호가 있는 형태(CBR(60,40)·2*(2d6+6) 등)에 라벨이 붙어도 올바른 분할을 찾는다.
  if (!/[)）]$/.test(s)) return null
  for (let i = 1; i < s.length - 1; i++) {
    const ch = s[i]
    if (ch !== '(' && ch !== '（') continue
    const body = s.slice(0, i).trim()
    if (!body) continue
    const label = s.slice(i + 1, s.length - 1).trim()
    // 라벨은 괄호 균형이 맞아야 한다 — "CC<=60 (근력) 2d6 (피해)" 처럼 명령 2개를 이어 쓴
    // 오입력이 첫 명령+오염된 이름으로 굴려지지 않게(불균형이면 평문 유지). "사격(권총)" 은 통과.
    if (!label || label.length > 60 || !balancedParens(label)) continue
    const r = parseBareCommand(body, s, rng)
    if (r) {
      if (r.kind !== 'opposed') r.name = label
      return r
    }
  }
  return null
}

/** 괄호(반각·전각) 짝이 맞는 문자열인지 — 라벨 후보 검증용. */
function balancedParens(t: string): boolean {
  let depth = 0
  for (const c of t) {
    if (c === '(' || c === '（') depth++
    else if (c === ')' || c === '）') {
      depth--
      if (depth < 0) return false
    }
  }
  return depth === 0
}

/** 라벨 없는 명령 본문 파싱 — command 에는 라벨 포함 원문을 그대로 박제한다. */
function parseBareCommand(s: string, command: string, rng: RNG): DiceResult | null {
  let m = s.match(/^(?:SC|SAN)\s+([0-9d+\-/]+)\s*<=\s*(\d+)$/i)
  if (m) return rollSan(parseInt(m[2], 10), m[1], { rng, command })
  // 대결: CBR(a,b) / 대결(a,b) / 대결 a vs b
  m = s.match(/^(?:CBR|대결)\s*\(\s*(\d+)\s*,\s*(\d+)\s*\)$/i)
  if (m) return rollOpposed(parseInt(m[1], 10), parseInt(m[2], 10), { rng, command })
  m = s.match(/^대결\s+(\d+)\s+vs\s+(\d+)$/i)
  if (m) return rollOpposed(parseInt(m[1], 10), parseInt(m[2], 10), { rng, command })
  // 밀어붙이기: "밀어붙이기 CC<=N" / "push CC<=N"
  m = s.match(/^(?:밀어붙이기|push)\s+(?:CC|1d100)\s*([+-]\d+)?\s*<=\s*(\d+)$/i)
  if (m) return rollCheck(parseInt(m[2], 10), { bonus: m[1] ? parseInt(m[1], 10) : 0, push: true, rng, command })
  m = s.match(/^(?:CC|1d100)\s*([+-]\d+)?\s*<=\s*(\d+)$/i)
  if (m) return rollCheck(parseInt(m[2], 10), { bonus: m[1] ? parseInt(m[1], 10) : 0, rng, command })
  // 합산 굴림 식: 안전 문자(숫자·d·키프드롭 kh/kl/dh/dl·+ - * / 괄호)로만 이뤄지고 주사위(NdM)를 포함.
  if (/d[1-9]/i.test(s) && /^[0-9dkhl+\-*/() ]+$/i.test(s)) return rollSum(s, { rng, command })
  return null
}
