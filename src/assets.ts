// 바이너리 자산 저장소 — 이미지·음원을 base64 data URL 로 방 상태에 박아 넣는 대신, 콘텐츠 해시로 한 번만 저장하고
// 'asset:<sha256>' 짧은 참조만 상태·스냅샷·방송에 싣는다. 디스크 기반 + 스트리밍 서빙이라 호스트 메모리를 아낀다.
//
// 접근 제어: 해시 자체가 추측 불가한 '캐퍼빌리티'라 별도 인증 없이 GET 으로 제공한다.
// 콘텐츠 주소(불변)라 GET 응답에 영구 캐시 헤더를 붙여 클라가 한 번만 받아 캐시한다.
import { createHash, randomUUID } from 'node:crypto'
import { mkdirSync, existsSync, readFileSync, writeFileSync, renameSync, statSync, unlinkSync, readdirSync } from 'node:fs'
import { writeFile, rename, mkdir } from 'node:fs/promises'
import { join } from 'node:path'

/** 자산 바이너리 단일 최대 크기(바이트). */
export const MAX_ASSET_BYTES = 130 * 1024 * 1024
/** sha256 16진수 해시 형식(경로 탈출·잘못된 키 차단). */
const HASH_RE = /^[a-f0-9]{64}$/
/** 상태·스냅샷에 박히는 'asset:<sha256>' 참조 추출용(자산 GC 라이브 집합 수집). */
const ASSET_REF_RE = /asset:([a-f0-9]{64})/g
/** 미참조 자산 청소 시, 막 업로드돼 아직 어디에도 박히지 않은 자산을 지우지 않기 위한 유예(기본 1시간). */
const DEFAULT_SWEEP_GRACE_MS = 60 * 60 * 1000

/** 청소 옵션 — 유예 길이와 기준 시각(테스트에서 시간을 밀어 넣는다). */
export interface SweepOpts {
  graceMs?: number
  now?: number
}
/** 청소(또는 계산) 결과 — 지운 것 / 확보 바이트 / 유예로 남긴 것 / 지우지 못한 것. */
export interface SweepResult {
  removed: number
  freed: number
  /** 미참조지만 아직 유예 중이라 손대지 않은 개수·바이트('지금은 회수 불가'를 사람에게 설명하는 근거). */
  deferred: number
  deferredBytes: number
  /** 지우려다 실패한 개수(파일 잠김·권한 등). 색인은 건드리지 않고 다음 회차에 재시도한다. */
  failed: number
}

/** 자산으로 저장을 허용하는 MIME 대분류 — 이 프로그램이 올리는 것은 이미지·음원·영상·폰트뿐이다. */
const MIME_FAMILY_RE = /^(image|audio|video|font)\/[\w.+-]+$/
/**
 * 문서로 해석될 수 있는 타입은 전부 차단한다. 자산은 API·웹판과 같은 오리진에서 서빙되므로,
 * 'text/html' 로 저장된 자산이 브라우저에서 문서로 열리면 그 오리진의 저장소(로그인 토큰)에 접근할 수 있다.
 * svg 는 확장자만 이미지일 뿐 스크립트를 품을 수 있어 같은 이유로 제외한다.
 */
const MIME_DENY_RE = /^image\/svg/i

/**
 * 업로드 MIME 정규화 — 허용 목록 밖은 'application/octet-stream' 으로 강등한다(거부가 아니라 강등:
 * 알 수 없는 타입도 저장은 되되 문서로 해석되지 않는다). 서빙 시 선언 타입이 그대로 나가므로 여기가 유일한 관문이다.
 */
/**
 * data URL(base64) → 그 바이트의 sha256 해시. put() 이 붙일 이름과 **정확히 같아야** 한다.
 *
 * 채팅 두상은 방 저장본엔 data URL 로 남고, 입장 스냅샷을 보낼 때만 자산으로 내부화된다.
 * 그래서 참조 수집기(asset: 문자열만 훑는다)는 그 자산을 못 찾아 '아무도 안 쓰는 파일'로 판정한다 —
 * 관리 화면의 '회수 가능'이 늘 비슷한 값으로 돌아오는 정체다. 이 함수로 그 data URL 도 라이브로 센다.
 * 규칙이 put 과 1바이트라도 어긋나면 반대로 '쓰고 있는 두상'을 지우게 되므로 테스트로 못박아 둔다.
 */
export function dataUrlHash(s: unknown): string | null {
  if (typeof s !== 'string' || !s.startsWith('data:')) return null
  const comma = s.indexOf(',')
  if (comma < 0) return null
  if (!/;base64$/i.test(s.slice(5, comma))) return null
  try {
    const bytes = Buffer.from(s.slice(comma + 1), 'base64')
    if (bytes.length === 0) return null
    return createHash('sha256').update(bytes).digest('hex')
  } catch {
    return null
  }
}

export function safeAssetMime(mime: unknown): string {
  if (typeof mime !== 'string') return 'application/octet-stream'
  // 'audio/mpeg; codecs=…' 처럼 파라미터가 붙어 오는 경우가 있어 앞부분만 본다.
  const base = mime.split(';')[0].trim().toLowerCase()
  if (!MIME_FAMILY_RE.test(base) || MIME_DENY_RE.test(base)) return 'application/octet-stream'
  return base
}

/** 임의 직렬화 문자열에서 'asset:<해시>' 참조를 모두 뽑아 into 에 추가(GC 라이브 집합 수집 — 방·캐릭터·계정 공용). */
export function collectAssetRefs(text: string, into: Set<string>): void {
  if (!text) return
  for (const m of text.matchAll(ASSET_REF_RE)) into.add(m[1])
}

export interface AssetStore {
  /** 바이트 저장(콘텐츠 해시·중복 제거) → 해시 반환. 디스크 쓰기는 비동기(이벤트 루프 비블로킹). */
  put(bytes: Buffer, mime: string): Promise<string>
  /** 서빙용 — 영속이면 {mime, path}(스트림), 인메모리면 {mime, bytes}. 없으면 null. */
  resolve(hash: string): { mime: string; path?: string; bytes?: Buffer } | null
  /** 테스트/검증용 — 바이트 직접 반환(영속이면 동기 읽기). 없으면 null. */
  read(hash: string): { bytes: Buffer; mime: string } | null
  /** 해시가 유효 형식인지(라우팅 방어). */
  isHash(hash: string): boolean
  /** 단일 자산 삭제(파일 + 색인). 삭제됐으면 true. */
  remove(hash: string): boolean
  /**
   * 미참조 자산 일괄 청소(mark-and-sweep). live=지금 어디서든 참조 중인 해시 집합(상위가 전 방·캐릭터·계정에서 수집).
   * 콘텐츠 주소라 자산은 방·캐릭터 간 공유되므로 '한 곳에서 지웠다'고 바로 지우면 안 됨 — 전역 라이브 집합에 없을 때만 회수.
   * graceMs 이내 생성(파일 mtime)된 자산은 '업로드 직후 아직 미참조' 가능성으로 보존(레이스 방지).
   * 반환: 삭제 개수·확보 바이트 + 유예로 남긴 것·지우지 못한 것.
   */
  sweep(live: Set<string>, opts?: SweepOpts): SweepResult
  /**
   * 지금 청소하면 얼마나 지워지는지만 계산(아무것도 지우지 않는다) — 관리 화면의 '회수 가능'.
   * sweep 과 같은 코드를 타므로 표시와 실제가 어긋나지 않는다.
   */
  orphanStats(live: Set<string>, opts?: SweepOpts): SweepResult
  /** 현재 보관 중인 전체 자산 해시(진단/테스트). */
  hashes(): string[]
  /** 단일 자산 바이트 크기(없으면 0). 관리자 용량 산출용. */
  sizeOf(hash: string): number
  /** 여러 자산 크기 일괄 조회(해시→바이트, 중복 제거). 없는 해시는 0. */
  sizesOf(hashes: Iterable<string>): Map<string, number>
  /** 전체 자산 디스크 사용량(파일 개수·바이트 합) — 관리자 진단 상단 요약. */
  totalBytes(): { count: number; bytes: number }
  maxBytes: number
}

/** persist:false 면 인메모리(테스트). dataDir 기본 = <cwd>/data. mime 은 index.json 에 별도 기록. */
export function createAssetStore(opts?: { dataDir?: string; persist?: boolean }): AssetStore {
  const persist = opts?.persist !== false
  const dir = join(opts?.dataDir ?? join(process.cwd(), 'data'), 'assets')
  const indexPath = join(dir, 'index.json')
  // 해시 → mime. 영속 모드에서도 메모리에 들고(서빙 시 빠른 조회), index.json 으로 영속.
  const mimes = new Map<string, string>()
  // 인메모리 모드 전용 바이트 보관.
  const memBytes = new Map<string, Buffer>()

  if (persist) {
    try {
      mkdirSync(dir, { recursive: true })
      if (existsSync(indexPath)) {
        const obj = JSON.parse(readFileSync(indexPath, 'utf8')) as Record<string, unknown>
        // 색인을 읽을 때도 정규화한다 — 예전에 저장된 문서형 MIME 이 남아 있어도 부팅 즉시 무해해진다.
        for (const [h, m] of Object.entries(obj)) if (HASH_RE.test(h) && typeof m === 'string') mimes.set(h, safeAssetMime(m))
      }
    } catch (e) {
      console.error('[assets] index.json 로드 실패. 빈 색인으로 시작:', e)
    }
  }

  /** 단일 자산 바이트(없으면 0) — 영속은 파일 stat, 인메모리는 버퍼 길이. */
  function assetSize(hash: string): number {
    if (!HASH_RE.test(hash)) return 0
    if (persist) {
      try {
        const st = statSync(join(dir, hash))
        return st.isFile() ? st.size : 0
      } catch {
        return 0
      }
    }
    return memBytes.get(hash)?.length ?? 0
  }

  /** mime 색인 영속(원자적). 자산 추가는 드물어 전체 재기록 허용. */
  function saveIndex(): void {
    if (!persist) return
    try {
      const tmp = indexPath + '.tmp'
      writeFileSync(tmp, JSON.stringify(Object.fromEntries(mimes)), 'utf8')
      renameSync(tmp, indexPath)
    } catch (e) {
      console.error('[assets] index.json 저장 실패:', e)
    }
  }

  /**
   * 미참조 자산 훑기 — 실제 삭제(apply=true)와 '얼마나 지울 수 있나' 계산(apply=false)이 같은 코드를 탄다.
   *
   * 이 둘이 갈라지면 회수 가능 용량은 잡히는데 정리를 눌러도 하나도 줄지 않는다. 표시 쪽이 단순히
   * (전체 − 참조중) 을 빼고, 실삭제 쪽은 만든 지 얼마 안 된 파일을 유예로 건너뛰기 때문이다. 같은 잣대를 쓴다.
   * 유예로 남긴 것(deferred)과 지우다 실패한 것(failed)을 따로 세어 호출 측이 사람에게 설명할 수 있게 한다.
   */
  function scan(live: Set<string>, opts: SweepOpts | undefined, apply: boolean): SweepResult {
    const graceMs = opts?.graceMs ?? DEFAULT_SWEEP_GRACE_MS
    const cutoff = (opts?.now ?? Date.now()) - graceMs
    // 디스크의 모든 자산 파일을 진실원본으로 — 색인에 없어도(쓰기 실패 등) 회수 대상에 포함.
    const all = new Set<string>(mimes.keys())
    for (const h of memBytes.keys()) all.add(h)
    const stale: string[] = [] // 해시 이름이 아닌 잔여 임시파일(업로드 실패 흔적) — 집계·회수 사각지대다
    if (persist) {
      try {
        for (const f of readdirSync(dir)) {
          if (HASH_RE.test(f)) all.add(f)
          else if (f.endsWith('.tmp')) stale.push(f)
        }
      } catch {
        /* 디렉터리 없음 — 회수할 것 없음 */
      }
    }
    let removed = 0
    let freed = 0
    let deferred = 0
    let deferredBytes = 0
    let failed = 0
    let indexDirty = false
    for (const hash of all) {
      if (live.has(hash)) continue
      if (persist) {
        const f = join(dir, hash)
        let size = 0
        try {
          const st = statSync(f)
          size = st.size
          if (st.mtimeMs > cutoff) {
            // 유예 — 막 올라온 자산은 보존(아직 어떤 참조에도 안 박혔을 수 있다).
            deferred++
            deferredBytes += size
            continue
          }
        } catch {
          // 파일이 이미 없다 — 색인만 남은 유령. 아래에서 색인을 정리한다.
          size = 0
        }
        if (size > 0) {
          if (!apply) {
            removed++
            freed += size
            continue // 계산만 — 색인·파일 어느 것도 건드리지 않는다
          }
          try {
            unlinkSync(f)
          } catch (e) {
            // 지우지 못했다(윈도 자가호스팅의 파일 잠김·권한 등). 색인을 지우면 파일은 남고 MIME 만
            // 잃어 이후 octet-stream 으로 강등된다 — 통계도 거짓이 된다. 그대로 두고 다음 회차에 재시도한다.
            failed++
            console.error(`[assets] ${hash.slice(0, 8)} 삭제 실패:`, e)
            continue
          }
          freed += size
        } else if (!apply) {
          // 색인만 남은 유령 — 지워도 디스크가 줄지 않으므로 회수량에 넣지 않는다.
          continue
        }
      } else if (!apply) {
        removed++
        freed += memBytes.get(hash)?.length ?? 0
        continue
      } else {
        freed += memBytes.get(hash)?.length ?? 0
      }
      if (mimes.delete(hash)) indexDirty = true
      memBytes.delete(hash)
      removed++
    }
    // 업로드 실패로 남은 임시파일 — 유예를 넘긴 것만 치운다(진행 중인 업로드를 건드리지 않게).
    for (const name of stale) {
      const f = join(dir, name)
      try {
        const st = statSync(f)
        if (st.mtimeMs > cutoff) {
          deferred++
          deferredBytes += st.size
          continue
        }
        if (!apply) {
          removed++
          freed += st.size
          continue
        }
        unlinkSync(f)
        removed++
        freed += st.size
      } catch {
        /* 이미 없음/권한 — 다음 회차 재시도 */
      }
    }
    if (indexDirty) saveIndex()
    return { removed, freed, deferred, deferredBytes, failed }
  }

  return {
    maxBytes: MAX_ASSET_BYTES,
    isHash: (h) => typeof h === 'string' && HASH_RE.test(h),

    async put(bytes, mime) {
      const hash = createHash('sha256').update(bytes).digest('hex')
      const safeMime = safeAssetMime(mime)
      if (mimes.has(hash)) {
        // 디스크 폴백으로 octet-stream 으로 잡혀 있던 항목을, 더 구체적인 MIME 으로 재업로드하면 승격(색인 보강).
        if (mimes.get(hash) === 'application/octet-stream' && safeMime !== 'application/octet-stream') {
          mimes.set(hash, safeMime)
          saveIndex()
        }
        return hash // 이미 있음(콘텐츠 동일) — 바이트 재기록 생략
      }
      if (persist) {
        const f = join(dir, hash)
        try {
          await mkdir(dir, { recursive: true })
          if (!existsSync(f)) {
            // 고유 임시명 — 같은 해시(같은 콘텐츠)를 여러 명이 동시에 올릴 때 '<해시>.tmp' 한 경로를 공유하면
            // 먼저 끝난 rename 이 임시파일을 치워 버려 뒤따른 rename 이 ENOENT 로 실패한다. 그 경합을 막는다.
            const tmp = `${f}.${randomUUID()}.tmp`
            try {
              await writeFile(tmp, bytes)
              await rename(tmp, f)
            } catch (e) {
              // 동시 업로드가 먼저 최종 파일을 만들었으면 성공으로 본다(콘텐츠 주소라 내용 동일 — 내 임시파일만 정리).
              try {
                unlinkSync(tmp)
              } catch {
                /* 이미 없음 */
              }
              if (!existsSync(f)) throw e
            }
          }
        } catch (e) {
          console.error(`[assets] ${hash.slice(0, 8)} 저장 실패:`, e)
          throw e
        }
      } else {
        memBytes.set(hash, bytes)
      }
      mimes.set(hash, safeMime)
      saveIndex()
      return hash
    },

    resolve(hash) {
      if (!HASH_RE.test(hash)) return null
      const mime = mimes.get(hash)
      if (persist) {
        const path = join(dir, hash)
        if (!existsSync(path)) return null
        // mime 색인이 (재시작·index.json 쓰기 실패로) 비어도 파일이 있으면 404 대신 서빙 — 색인도 보강한다.
        // (octet-stream 으로 내려가도 브라우저/Electron 의 콘텐츠 스니핑으로 대개 재생·표시되며, 404 무음보다 낫다.)
        if (!mime) {
          mimes.set(hash, 'application/octet-stream')
          return { mime: 'application/octet-stream', path }
        }
        return { mime, path }
      }
      if (!mime) return null
      const bytes = memBytes.get(hash)
      return bytes ? { mime, bytes } : null
    },

    read(hash) {
      if (!HASH_RE.test(hash)) return null
      const mime = mimes.get(hash)
      if (!mime) return null
      if (persist) {
        const path = join(dir, hash)
        try {
          if (!existsSync(path) || !statSync(path).isFile()) return null
          return { bytes: readFileSync(path), mime }
        } catch {
          return null
        }
      }
      const bytes = memBytes.get(hash)
      return bytes ? { bytes, mime } : null
    },

    remove(hash) {
      if (!HASH_RE.test(hash)) return false
      let existed = mimes.delete(hash)
      if (memBytes.delete(hash)) existed = true
      if (persist) {
        const f = join(dir, hash)
        try {
          if (existsSync(f)) {
            unlinkSync(f)
            existed = true
          }
        } catch (e) {
          console.error(`[assets] ${hash.slice(0, 8)} 삭제 실패:`, e)
        }
      }
      if (existed) saveIndex()
      return existed
    },

    sweep(live, opts) {
      return scan(live, opts, true)
    },

    orphanStats(live, opts) {
      return scan(live, opts, false)
    },

    hashes() {
      return [...mimes.keys()]
    },

    sizeOf: (hash) => assetSize(hash),

    sizesOf(hashList) {
      const out = new Map<string, number>()
      for (const h of hashList) if (!out.has(h)) out.set(h, assetSize(h))
      return out
    },

    totalBytes() {
      let count = 0
      let bytes = 0
      const seen = new Set<string>()
      if (persist) {
        try {
          for (const f of readdirSync(dir)) {
            if (!HASH_RE.test(f) || seen.has(f)) continue
            seen.add(f)
            const sz = assetSize(f)
            if (sz > 0) {
              count++
              bytes += sz
            }
          }
        } catch {
          /* 디렉터리 없음 — 보관 자산 없음 */
        }
      } else {
        for (const [h, b] of memBytes) {
          if (seen.has(h)) continue
          seen.add(h)
          count++
          bytes += b.length
        }
      }
      return { count, bytes }
    }
  }
}
