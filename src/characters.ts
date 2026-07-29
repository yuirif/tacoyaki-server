// 계정별 캐릭터 시트 영속. 서버는 시트 내용을 해석하지 않고 불투명 블롭으로 저장한다
// (도메인 타입은 렌더러 소유). <dataDir>/characters/<accountId>.json = { characters: CharacterRecord[] }.
// auth.ts 와 동일한 파일 영속 패턴(원자적 쓰기) + 계정별 인메모리 캐시.
import { readFileSync, writeFileSync, mkdirSync, renameSync, existsSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { collectAssetRefs as scanAssetRefs } from './assets'
import type { CharacterRecord } from './protocol'

export interface CharacterStore {
  /** 계정의 전체 캐릭터 목록. */
  list(accountId: string): CharacterRecord[]
  /** 계정의 캐릭터 1개(id 기준). 없으면 undefined. */
  get(accountId: string, id: string): CharacterRecord | undefined
  /** 캐릭터 upsert(id 기준). 저장본 반환, 무효(빈 id) 면 undefined. */
  save(accountId: string, char: CharacterRecord): CharacterRecord | undefined
  /** 캐릭터 삭제. 삭제됐으면 true. */
  remove(accountId: string, id: string): boolean
  /** 한 계정의 캐릭터 전부 삭제(계정 탈퇴 연쇄). 삭제된 개수 반환. */
  removeAll(accountId: string): number
  /** 관리자 용량 산출 — 그 계정 시트의 직렬화 바이트 + 참조 자산 해시(시트 개수 포함). */
  usageFor(accountId: string): { count: number; bytes: number; refs: Set<string> }
  /** 보관된 전 캐릭터 시트에서 참조 중인 'asset:<해시>' 수집(자산 GC 라이브 집합). */
  collectAssetRefs(into: Set<string>): void
}

/** persist:false 면 파일 입출력 없이 인메모리(테스트). dataDir 기본 = <cwd>/data. */
export function createCharacterStore(opts?: { dataDir?: string; persist?: boolean }): CharacterStore {
  const persist = opts?.persist !== false
  const dataDir = opts?.dataDir ?? join(process.cwd(), 'data')
  const charDir = join(dataDir, 'characters')
  const cache = new Map<string, Map<string, CharacterRecord>>() // accountId -> (charId -> record)

  const fileFor = (accountId: string): string => join(charDir, accountId + '.json')

  function load(accountId: string): Map<string, CharacterRecord> {
    const cached = cache.get(accountId)
    if (cached) return cached
    const m = new Map<string, CharacterRecord>()
    if (persist) {
      try {
        const f = fileFor(accountId)
        if (existsSync(f)) {
          const data = JSON.parse(readFileSync(f, 'utf8')) as { characters?: CharacterRecord[] }
          if (Array.isArray(data.characters)) {
            for (const c of data.characters) if (c && typeof c.id === 'string' && c.id) m.set(c.id, c)
          }
        }
      } catch (e) {
        console.error(`[characters] ${accountId} 로드 실패 — 빈 목록으로 시작:`, e)
      }
    }
    cache.set(accountId, m)
    return m
  }

  function flush(accountId: string, m: Map<string, CharacterRecord>): void {
    if (!persist) return
    try {
      mkdirSync(charDir, { recursive: true })
      const f = fileFor(accountId)
      const tmp = f + '.tmp'
      writeFileSync(tmp, JSON.stringify({ characters: [...m.values()] }, null, 2), 'utf8') // 원자적(임시→rename)
      renameSync(tmp, f)
    } catch (e) {
      console.error(`[characters] ${accountId} 저장 실패:`, e)
    }
  }

  return {
    list(accountId) {
      return [...load(accountId).values()]
    },
    get(accountId, id) {
      return load(accountId).get(id)
    },
    save(accountId, char) {
      if (!char || typeof char.id !== 'string' || !char.id) return undefined
      const m = load(accountId)
      m.set(char.id, char)
      flush(accountId, m)
      return char
    },
    remove(accountId, id) {
      const m = load(accountId)
      if (!m.has(id)) return false
      m.delete(id)
      flush(accountId, m)
      return true
    },
    removeAll(accountId) {
      const m = load(accountId)
      const n = m.size
      m.clear()
      flush(accountId, m) // 빈 목록으로 덮어씀(파일 잔존하되 내용 비움 — 자산 GC 가 고아 자산 회수)
      cache.delete(accountId)
      return n
    },
    usageFor(accountId) {
      // 캐시에 있으면 그대로, 없으면 cache 를 채우지 않는 '읽기 전용' 로드 — 관리자 overview 가 전 계정(장기 미접속 포함)을
      // 메모리에 상주시키지 않게 한다(load 는 cache.set 으로 적재하므로 여기선 직접 읽는다).
      let list: CharacterRecord[]
      const cached = cache.get(accountId)
      if (cached) {
        list = [...cached.values()]
      } else if (persist) {
        list = []
        try {
          const f = fileFor(accountId)
          if (existsSync(f)) {
            const data = JSON.parse(readFileSync(f, 'utf8')) as { characters?: CharacterRecord[] }
            if (Array.isArray(data.characters)) list = data.characters.filter((c) => c && typeof c.id === 'string' && c.id)
          }
        } catch {
          list = []
        }
      } else {
        list = []
      }
      const json = JSON.stringify(list)
      const refs = new Set<string>()
      scanAssetRefs(json, refs)
      return { count: list.length, bytes: Buffer.byteLength(json, 'utf8'), refs }
    },
    collectAssetRefs(into) {
      if (persist) {
        try {
          if (!existsSync(charDir)) return
          for (const f of readdirSync(charDir)) {
            if (!f.endsWith('.json') || f.endsWith('.tmp')) continue
            try {
              scanAssetRefs(readFileSync(join(charDir, f), 'utf8'), into)
            } catch {
              /* 손상 파일 건너뜀 */
            }
          }
        } catch {
          /* 디렉터리 없음 */
        }
      } else {
        for (const m of cache.values()) for (const c of m.values()) scanAssetRefs(JSON.stringify(c), into)
      }
    }
  }
}
