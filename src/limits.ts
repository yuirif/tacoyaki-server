// 서버측 입력 한도 — 신뢰할 수 없는 클라이언트로부터 메모리·소켓버퍼·브로드캐스트 폭증을 막는 보안 방어선.
// 단일 프레임 자체는 socket.io maxHttpBufferSize(relay 의 48MB)가 막고, 여기서는 "저장·재브로드캐스트되는"
// 개별 필드를 캡한다. 단일 이미지 캡은 클라(lib/image.ts HANDOUT_IMAGE_MAX_CHARS)와 동일 120MB로 맞춰
// 정상 업로드는 거부하지 않는다(큰 움짤·이미지 수용 — APNG/WebP 고용량 애니).

/** 이미지 data URL 단일 필드 최대 길이(문자 ≈ 바이트). 클라 HANDOUT_IMAGE_MAX_CHARS 와 동일. 큰 움짤 수용(120MB). */
export const MAX_IMAGE_CHARS = 120 * 1024 * 1024

/** 캐릭터 스탠딩/표정 두상 배열 개수 상한(스탠딩 개수제한). */
export const MAX_STANDINGS = 24

/** 월드 좌표 절대 한도(px) — NaN/Infinity·초대형 좌표 차단(token:move/upsert·핑). */
export const MAX_WORLD_COORD = 1_000_000

/** charPlayerId 등 식별자 문자열 최대 길이(거대 문자열 방어). */
export const MAX_ID_CHARS = 200

/**
 * 채팅 메시지 본문 최대 길이(꾸미기 마크업 포함). 매우 긴 단일 메시지 폭주 방어.
 * 채팅 이미지 첨부([img=data URL])를 수용하려면 base64 한 장(축소본 ≈ 수십~수백 KB)이 들어갈 여유가 필요.
 */
export const MAX_CHAT_CHARS = 300_000

/** 캡 이하 이미지 data URL 만 통과(초과·비문자 → undefined 로 드롭). */
export function capImage(v: unknown, max = MAX_IMAGE_CHARS): string | undefined {
  return typeof v === 'string' && v.length <= max ? v : undefined
}

/**
 * '자산 참조여야 하는' 미디어 필드(BGM·맵배경·VN배경 등) 전용 가드 — 거대 인라인 data URL 이면 true(드롭 대상).
 * 정상 미디어는 /asset(HTTP)로 올려 'asset:<hash>' 참조(수십 바이트)로 오므로, 1MB 넘는 인라인 data: 는
 * 클라 업로드 실패 폴백·구버전·공격 중 하나다. 저장·재브로드캐스트 전에 떨궈 메모리 과다 사용을 차단한다.
 * 참조('asset:')·유튜브 id·작은 인라인은 통과(false).
 */
export const MAX_INLINE_MEDIA_CHARS = 1024 * 1024
export function isOversizedInline(v: unknown, max = MAX_INLINE_MEDIA_CHARS): boolean {
  return typeof v === 'string' && v.startsWith('data:') && v.length > max
}

/**
 * 이미지 data URL 배열 정규화: 문자열만·각 항목 캡·개수 상한.
 * 빈 문자열(폴백 표시 마커)도 보존한다. 비배열 → [].
 */
export function capImageList(v: unknown, maxCount = MAX_STANDINGS, maxEach = MAX_IMAGE_CHARS): string[] {
  if (!Array.isArray(v)) return []
  const out: string[] = []
  for (const s of v) {
    if (typeof s === 'string' && s.length <= maxEach) out.push(s)
    if (out.length >= maxCount) break
  }
  return out
}

/** 유한 좌표인지(검증용 — clamp 없이 거부할 때). NaN/Infinity 제외. */
export function isFiniteCoord(v: unknown): v is number {
  return typeof v === 'number' && Number.isFinite(v)
}

/** 유한 숫자만, [-MAX_WORLD_COORD, MAX_WORLD_COORD] 로 클램프. 비유한 → fallback. */
export function clampCoord(v: unknown, fallback = 0): number {
  if (!isFiniteCoord(v)) return fallback
  return Math.max(-MAX_WORLD_COORD, Math.min(MAX_WORLD_COORD, v))
}

/** 식별자 문자열 캡(길이 초과·비문자 → undefined). */
export function capId(v: unknown, max = MAX_ID_CHARS): string | undefined {
  return typeof v === 'string' && v.length <= max ? v : undefined
}
