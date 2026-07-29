// 렌더러 src/renderer/src/lib/dice/types.ts 의 미러본. 다이스 규칙·타입 변경 시 양쪽을 함께 고친다.
// ===== 다이스/판정 결과 타입 =====

export type SuccessLevel =
  | 'critical' // 대성공 (주사위 01)
  | 'extreme' // 극단적 성공 (≤ 목표/5)
  | 'hard' // 어려운 성공 (≤ 목표/2)
  | 'regular' // 일반 성공 (≤ 목표)
  | 'fail' // 실패
  | 'fumble' // 펌블(대실패)

/** 기능/능력 판정 결과 */
export interface CheckResult {
  kind: 'check'
  command: string // 원본 명령 (예: "CC<=60")
  /** 표시용 이름 — 시트에서 굴린 기능/무기 이름(예: "도서관 이용"). 카드 상단에 표기. 수동 굴림이면 없음. */
  name?: string
  roll: number // 최종 1d100 값 (보너스/페널티 적용 후)
  rolls?: number[] // 보너스/페널티 시 후보로 굴린 값들
  target: number
  level: SuccessLevel
  label: string // 한글 표시 ("어려운 성공")
  bonus?: number // 보너스 다이스 수 (음수=페널티)
  push?: boolean // 밀어붙이기 재시도 굴림 — 실패 시 대가가 큼
}

/** 이성(SAN) 판정 결과 */
export interface SanResult {
  kind: 'san'
  command: string
  /** 표시용 이름 — 예: "이성 판정". 카드 상단에 표기. */
  name?: string
  roll: number
  target: number
  level: SuccessLevel
  success: boolean
  loss: number // 실제 SAN 손실량
  lossExpr: string // 손실 식 ("1/1d6")
}

/** 단순 합산 굴림 (피해/혼합 등) */
export interface SumResult {
  kind: 'sum'
  command: string
  /** 표시용 이름 — 시트에서 굴린 무기 피해 등(예: "권총 피해"). 카드 상단에 표기. */
  name?: string
  rolls: number[]
  modifier: number
  total: number
}

/** 대결 판정 한쪽 — 자기 목표값에 1d100, 성공 단계 산출. */
export interface OpposedSide {
  roll: number
  target: number
  level: SuccessLevel
}

/** 대결 판정 결과 — 양측이 각자 굴려 성공 단계로 승부(동급이면 목표값 높은 쪽, 그래도 같으면 무). */
export interface OpposedResult {
  kind: 'opposed'
  command: string
  a: OpposedSide
  b: OpposedSide
  winner: 'a' | 'b' | 'draw'
}

export type DiceResult = CheckResult | SanResult | SumResult | OpposedResult

/** 성공 단계 한글 라벨 */
export const SUCCESS_LABEL: Record<SuccessLevel, string> = {
  critical: '대성공',
  extreme: '극단적 성공',
  hard: '어려운 성공',
  regular: '일반 성공',
  fail: '실패',
  fumble: '펌블'
}
