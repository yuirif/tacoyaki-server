// 타코야키 박스 멀티플레이 릴레이 서버 진입점.
// 개발: npm run dev (tsx watch). 기본 포트 8787 (PORT 환경변수로 변경).
// 공개 배포(하이브리드 클라우드)용 환경변수:
//   CORS_ORIGINS 허용 origin 쉼표목록(예: https://app.example.com). 미설정 = 전체(*) — 로컬/개발용.
//   TLS_KEY/TLS_CERT PEM 키·인증서 파일 경로. 둘 다 있으면 wss(https)로 기동. (리버스 프록시 종단이면 불필요)
//   SESSION_TTL_DAYS 세션 토큰 유휴 만료일(기본 30). 활성 사용 시 슬라이딩 연장.
//   DATA_DIR 영속 데이터 폴더(기본 <cwd>/data). 클라우드에서는 볼륨을 마운트한 경로를 지정한다.
import { readFileSync, existsSync, mkdirSync, readdirSync, writeFileSync } from 'node:fs'
import { join, resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createHash } from 'node:crypto'
import { getHeapStatistics } from 'node:v8'
import { createRelay } from './relay'
import { createAuthStore } from './auth'
import { createCharacterStore } from './characters'
import { createAssetStore } from './assets'
import { createDmStore } from './dm'
import { createNotifStore } from './notifications'
import { createPostStore } from './posts'
import { createSessionLogStore } from './sessionlogs'
import { createDottownStore } from './dottown'
import { createEconomyStore } from './dottownEconomy'
import { createEstateStore } from './dottownEstate'
import { createMarketStore } from './market'
import { createCommunityStore } from './community'
import { createCommunityPostStore } from './communityPost'
import { createCommunityCharStore } from './communityChar'
import { createCommunityCatalog } from './communityCatalog'
import { createCommunityLedger } from './communityLedger'
import { createCommunityGiftStore } from './communityGift'
import { createCommunityEcon } from './communityEcon'
import { createCommunityGames } from './communityGame'
import { RoomStore } from './rooms'

const PORT = Number(process.env.PORT ?? 8787)
const SAVE_INTERVAL_MS = 8_000 // 8초마다 변경된 세션 자동저장

const corsOrigins = process.env.CORS_ORIGINS
  ? process.env.CORS_ORIGINS.split(',').map((s) => s.trim()).filter(Boolean)
  : null

// TLS: 키·인증서 둘 다 지정되면 직접 wss 종단. 로드 실패 시 평문으로 떨어지지 않고 종료한다.
let tls: { key: string; cert: string } | undefined
if (process.env.TLS_KEY && process.env.TLS_CERT) {
  try {
    tls = { key: readFileSync(process.env.TLS_KEY, 'utf8'), cert: readFileSync(process.env.TLS_CERT, 'utf8') }
  } catch (e) {
    console.error('[tls] 인증서/키 로드 실패. 평문으로 시작하지 않고 종료합니다:', e)
    process.exit(1)
  }
}

const sessionTtlMs = process.env.SESSION_TTL_DAYS
  ? Number(process.env.SESSION_TTL_DAYS) * 24 * 60 * 60 * 1000
  : undefined

// 웹판(브라우저 접속) 정적 루트 — WEB_ROOT 환경변수 > <cwd>/webdist. index.html 이 있어야 유효.
// 없으면 기존과 동일한 API 전용 서버(설치판만 접속) — 웹판을 안 쓰는 자가호스터에게 아무 변화 없음.
const webRootCandidate = process.env.WEB_ROOT ? resolve(process.env.WEB_ROOT) : resolve('webdist')
const webRoot = existsSync(join(webRootCandidate, 'index.html')) ? webRootCandidate : null

/**
 * 영속 데이터 폴더. 기본은 <cwd>/data 라 예전과 똑같이 동작하고, 클라우드에서는 DATA_DIR 로
 * 볼륨 마운트 경로를 가리키게 한다. 경로를 바꿀 수단이 없으면 볼륨을 잘못 붙였을 때 손쓸 방법이 없다.
 */
const dataDir = process.env.DATA_DIR ? resolve(process.env.DATA_DIR) : resolve('data')

/**
 * 데이터 폴더가 정말 살아남는 자리인지 확인해 로그로 알린다.
 *
 * 클라우드에서 볼륨을 안 붙이거나 마운트 경로를 잘못 적으면, 서버는 아무 말 없이 컨테이너의 임시
 * 폴더에 쓰고 다음 배포에 전부 사라진다. 한 번이라도 기동한 흔적을 남겨 두고, 그 흔적이 사라졌는데
 * 폴더도 비어 있으면 '새 폴더에 쓰고 있다'는 사실을 크게 남긴다.
 */
function checkDataDir(): { fresh: boolean; marked: boolean } {
  const marker = join(dataDir, '.tacoyaki-data')
  try {
    mkdirSync(dataDir, { recursive: true })
    const marked = existsSync(marker)
    // 마커 말고 실제 내용물이 있는지 — 예전 판에서 만든 폴더에는 마커가 없다.
    const entries = readdirSync(dataDir).filter((f) => f !== '.tacoyaki-data')
    const fresh = !marked && entries.length === 0
    if (!marked) writeFileSync(marker, new Date().toISOString(), 'utf8')
    return { fresh, marked }
  } catch (e) {
    console.error('[data] 데이터 폴더를 준비하지 못했습니다:', e)
    return { fresh: false, marked: false }
  }
}
const dataState = checkDataDir()

/**
 * 서버 파일이 한 판으로 갖춰졌는지 대조한다 — 어긋난 파일 이름 목록을 돌려준다.
 *
 * 새 판을 받을 때 src 폴더의 일부만 덮어쓰면, 새 파일이 부르는 함수가 낡은 파일에는 없어 그 기능을
 * 쓰는 첫 사람에게서 서버가 멈춘다. 겉으로는 잘 도는 서버라 원인을 찾기가 몹시 어렵다.
 * 배포본에는 파일별 대조표(.filelist.json)가 함께 들어 있으니, 켤 때 한 번 맞춰 보고 알려 준다.
 * 대조표가 없는 개발 저장소에서는 아무 일도 하지 않는다.
 */
function checkSourceSet(): string[] {
  const srcDir = dirname(fileURLToPath(import.meta.url))
  const listPath = join(srcDir, '.filelist.json')
  if (!existsSync(listPath)) return []
  try {
    const want = JSON.parse(readFileSync(listPath, 'utf8')) as Record<string, string>
    const hex = (b: Buffer): string => createHash('sha256').update(b).digest('hex')
    const odd: string[] = []
    for (const [name, hash] of Object.entries(want)) {
      const p = join(srcDir, name)
      if (!existsSync(p)) {
        odd.push(`${name} (없음)`)
        continue
      }
      const raw = readFileSync(p)
      if (hex(raw) === hash) continue
      // 줄끝(CRLF/LF)만 다른 사본은 같은 판이다 — 깃 설정(text=auto 등)이 커밋하며 줄끝을 바꿔도
      // 멀쩡한 배포를 어긋남으로 몰지 않게, CR 을 걷어낸 바이트로 한 번 더 맞춰 본다(대조표는 LF 기준).
      if (hex(Buffer.from(raw.toString('utf8').replace(/\r/g, ''), 'utf8')) === hash) continue
      odd.push(`${name} (다른 판)`)
    }
    return odd
  } catch {
    return [] // 대조표가 깨졌으면 검사를 건너뛴다 — 이 확인 때문에 서버가 안 켜지면 본말전도다.
  }
}

// 운영: 계정·캐릭터·세션방 영속(dataDir) + 로그인 필수. 멤버·관리자가 방을 만들 수 있고 생성자가 그 방의 GM(소유자)이 된다.
//   (전역 등급 admin/member/guest 는 호스팅 용량 보호용 축이다 — 손님은 승인 전까지 방을 만들 수 없고, 관리 화면은 관리자만 연다.)
// 세션방은 영속(소유자 삭제 전까지 유지) — 유휴 정리(sweep) 없음.
const authStore = createAuthStore({ sessionTtlMs, dataDir })
const charStore = createCharacterStore({ dataDir })
const roomStore = new RoomStore({ persist: true, dataDir })
const assetStore = createAssetStore({ dataDir })
const dmStore = createDmStore({ dataDir: join(dataDir, 'dm') })
const notifStore = createNotifStore({ dataDir: join(dataDir, 'notif') })
const postStore = createPostStore({ dataDir })
const sessionLogStore = createSessionLogStore({ dataDir })
const dottownStore = createDottownStore({ dataDir })
const economyStore = createEconomyStore({ dataDir })
// 광장 부동산(빈터 입주) — 반드시 영속(persist 기본 true)해야 재시작/재배포에 집이 사라지지 않는다.
//   코인 차감은 economy 원장으로 수렴, 집 위 라벨은 도트타운 표시 닉으로 해석(relay 와 동일 규칙).
const estateStore = createEstateStore({
  dataDir,
  charge: (id, amt, reason, ref) => economyStore.applyDelta(id, amt, reason, ref),
  resolveNick: (id) =>
    (id && (dottownStore.getNick(id) || authStore.getAccountById(id)?.nickname || authStore.getAccountById(id)?.username)) || ''
})
const marketStore = createMarketStore({ dataDir })
// 커뮤니티 — 서버 하나에 하나. 설정·글·캐릭터를 나눠 두되 자산 참조는 전부 상주 인덱스에 모아,
//   자산 회수의 참조 수집이 지금처럼 동기로 끝나게 한다.
const communityStore = createCommunityStore({ dataDir })
const communityPostStore = createCommunityPostStore({ dataDir })
const communityCharStore = createCommunityCharStore({ dataDir })
// 경제 — 도감(정의)·장부(기록)·선물 상자. 지갑과 소지품 자체는 캐릭터 샤드 안에 있다.
const communityCatalog = createCommunityCatalog({ dataDir })
const communityLedger = createCommunityLedger({ dataDir })
const communityGifts = createCommunityGiftStore({ dataDir })
const communityGames = createCommunityGames({ dataDir })
const communityEcon = createCommunityEcon({
  dataDir,
  community: communityStore,
  chars: communityCharStore,
  catalog: communityCatalog,
  ledger: communityLedger,
  gifts: communityGifts
})

const { httpServer, listAvatarRefs } = createRelay({
  requireAuth: true,
  // ⚠ 릴레이도 같은 폴더를 봐야 한다 — 관리 화면의 서버 데이터 내보내기/가져오기가 이 값으로 폴더를 훑는다.
  //   여기만 빠지면 볼륨을 다른 곳에 붙인 서버에서 '빈 백업'이 성공한 것처럼 내려간다.
  dataDir,
  // /health 의 data 필드('fresh'/'used') — 볼륨이 안 붙어 매 배포 새 폴더로 시작하는 서버를 밖에서 알아보게.
  dataFresh: dataState.fresh,
  auth: authStore,
  characters: charStore,
  rooms: roomStore,
  assets: assetStore,
  dm: dmStore,
  notif: notifStore,
  posts: postStore,
  sessionlogs: sessionLogStore,
  dottown: dottownStore,
  economy: economyStore,
  estate: estateStore,
  market: marketStore,
  community: communityStore,
  cmtyPosts: communityPostStore,
  cmtyChars: communityCharStore,
  cmtyCatalog: communityCatalog,
  cmtyLedger: communityLedger,
  cmtyGifts: communityGifts,
  cmtyEcon: communityEcon,
  cmtyGames: communityGames,
  corsOrigins,
  tls,
  webRoot,
  // 연결 진단: 접속/해제(+사유)·재접속 복구·주기 메모리·소켓 수를 호스트 로그로 남긴다.
  log: (...args) => console.log('[net]', ...args)
})

const save = setInterval(() => {
  // 커뮤니티는 목록 인덱스를 뭉쳐서 쓴다 — 주기 저장 때 밀린 것을 함께 내보낸다.
  communityStore.flush()
  communityPostStore.flush()
  communityCharStore.flush()
  communityCatalog.flush()
  communityLedger.flush()
  communityGifts.flush()
  communityEcon.flush()
  void roomStore.flushDirty().then((n) => {
    if (n) console.log(`[rooms] 자동저장 ${n}개 (총 ${roomStore.roomCount})`)
  })
}, SAVE_INTERVAL_MS)
save.unref() // 서버 종료를 막지 않도록

// 미참조(고아) 자산 정리 — 방·이미지·캐릭터·계정이 삭제돼 더 이상 어디서도 참조되지 않는 자산 파일을 회수(디스크 용량 관리).
// 콘텐츠 주소라 자산은 방·캐릭터 간 공유되므로, 전 방·캐릭터·계정에서 라이브 참조를 모은 뒤(mark) 그 집합에 없는 것만 지운다(sweep).
// 막 업로드돼 아직 참조에 박히기 전인 자산은 sweep 내부 유예(파일 mtime 기준)로 보존한다.
const ASSET_GC_INTERVAL_MS = 6 * 60 * 60 * 1000 // 6시간마다
const ASSET_GC_BOOT_DELAY_MS = 5 * 60 * 1000 // 부팅 5분 후 1차(초기 재접속·로드 안정화 대기)

function runAssetGc(): void {
  try {
    const live = new Set<string>()
    roomStore.collectAssetRefs(live)
    charStore.collectAssetRefs(live)
    authStore.collectAssetRefs(live)
    postStore.collectAssetRefs(live)
    sessionLogStore.collectAssetRefs(live)
    dottownStore.collectAssetRefs(live)
    economyStore.collectAssetRefs(live)
    marketStore.collectAssetRefs(live) // ⚠마켓 이미지(등록·보유) — 주기 GC 회수 방지
    communityStore.collectAssetRefs(live)
    communityPostStore.collectAssetRefs(live)
    communityCharStore.collectAssetRefs(live) // ⚠커뮤니티 이미지 — 안 실으면 최대 6시간 뒤 사라진다
    communityCatalog.collectAssetRefs(live) // ⚠아이템 그림·상점 배너
    communityGifts.collectAssetRefs(live) // ⚠보내는 중인 선물의 편지 그림
    communityGames.collectAssetRefs(live) // ⚠퀘스트 배너·완료 카드·장면 그림
    listAvatarRefs(live) // ⚠DM 목록이 옮겨 놓은 프사 — 계정 파일에는 원본이 남아 참조가 안 잡힌다
    const { removed, freed, deferred, failed } = assetStore.sweep(live)
    if (removed || failed) {
      console.log(
        `[assets] 고아 자산 ${removed}개 정리 · ${(freed / 1024 / 1024).toFixed(1)}MB 확보 ` +
          `(참조 ${live.size}개 보존 · 유예 ${deferred}개 · 실패 ${failed}개)`
      )
    }
  } catch (e) {
    console.error('[assets] 자산 GC 실패:', e)
  }
}

const bootGc = setTimeout(runAssetGc, ASSET_GC_BOOT_DELAY_MS)
bootGc.unref()
const gc = setInterval(runAssetGc, ASSET_GC_INTERVAL_MS)
gc.unref() // 서버 종료를 막지 않도록

/**
 * 종료 신호를 받으면 밀린 것부터 디스크에 내리고 나간다.
 * 호스팅은 새 판을 올릴 때마다 이 신호를 보내고 곧 프로세스를 끝낸다 — 그냥 죽으면 마지막 자동저장
 * 이후의 대화가 그대로 사라진다(메모리가 진실원본이라 그때까지는 아무 티도 나지 않는다).
 */
let shuttingDown = false
function shutdown(signal: string): void {
  if (shuttingDown) return
  shuttingDown = true
  console.log(`[server] ${signal} 신호를 받았습니다. 저장하고 종료합니다.`)
  // 새 일감을 먼저 끊는다 — 주기 저장이 한 번 더 끼어들거나 새 접속이 들어오면 마무리가 끝나지 않는다.
  clearInterval(save)
  try {
    httpServer.close()
  } catch {
    /* 이미 닫힘 */
  }
  try {
    communityStore.flush()
    communityPostStore.flush()
    communityCharStore.flush()
    communityCatalog.flush()
    communityLedger.flush()
    communityGifts.flush()
    communityEcon.flush()
  } catch (e) {
    console.error('[server] 커뮤니티 저장 실패:', e)
  }
  // 방 저장은 비동기다. 다 끝나면 나가되, 호스팅이 강제로 끊기 전에는 끝나도록 시간을 정해 둔다.
  const bail = setTimeout(() => {
    console.error('[server] 저장이 제때 끝나지 않아 그대로 종료합니다.')
    process.exit(0)
  }, 9_000)
  // drain: 진행 중인 쓰기를 끝까지 기다린 뒤, 그 사이 바뀐 몫을 한 번 더 저장한다.
  void roomStore
    .drain()
    .then((n) => console.log(`[server] 세션 ${n}개 저장 완료.`))
    .catch((e) => console.error('[server] 세션 저장 실패:', e))
    .finally(() => {
      clearTimeout(bail)
      process.exit(0)
    })
}
process.on('SIGTERM', () => shutdown('SIGTERM'))
process.on('SIGINT', () => shutdown('SIGINT'))

/**
 * 마지막 그물 — 어디서도 받지 못한 예외·거부로 서버가 통째로 내려가지 않게 한다.
 *
 * 요청 하나가 실패하는 것과 서버가 죽는 것은 무게가 다르다. 죽으면 그 순간 접속해 있던 사람이
 * 전부 끊기고, 자가 호스팅이면 주인이 손으로 다시 켜기 전까지 아무도 못 들어온다. 요청·소켓 단위
 * 방어는 각각 relay 쪽에 있고, 여기는 그 그물을 빠져나온 것만 받아 크게 남긴다.
 * 종료 중에는 원래 하던 마무리를 방해하지 않는다.
 */
process.on('unhandledRejection', (reason) => {
  console.error('[server] 처리되지 않은 거부. 서버는 계속 돌립니다:', reason)
})
process.on('uncaughtException', (err) => {
  console.error('[server] 처리되지 않은 예외. 서버는 계속 돌립니다:', err)
})

/**
 * 기동 자체가 실패하면 그때는 계속 돌 수 있는 상태가 아니다.
 *
 * 이 리스너가 없으면 포트 충돌 같은 실패가 위 그물로 흘러가 '계속 돌립니다'만 찍고, 남은 일이 없어
 * 프로세스가 곧 조용히 끝난다 — 창에는 성공처럼 보이고 호스팅에는 정상 종료로 보고된다.
 * 이미 듣고 있는 서버의 소켓 오류는 기동 실패가 아니므로 남기기만 한다.
 */
httpServer.on('error', (err: NodeJS.ErrnoException) => {
  if (httpServer.listening) {
    console.error('[server] 소켓 오류:', err)
    return
  }
  if (err.code === 'EADDRINUSE') {
    console.error(`[server] ⚠ 포트 ${PORT} 를 이미 다른 프로그램이 쓰고 있습니다. 서버 창이 이미 떠 있지 않은지 확인해 주세요.`)
  } else if (err.code === 'EACCES') {
    console.error(`[server] ⚠ 포트 ${PORT} 를 열 권한이 없습니다. 1024 보다 큰 번호로 PORT 를 바꿔 주세요.`)
  } else {
    console.error('[server] ⚠ 서버를 시작하지 못했습니다:', err)
  }
  process.exit(1)
})

/**
 * 메모리 천장 두 개를 켤 때 적어 둔다 — 이 서버가 쓸 수 있는 한도와, V8 이 스스로 잡은 힙 천장.
 *
 * 메모리로 죽는 것은 예외가 아니라서 어떤 그물로도 못 받는다. 프로세스가 그냥 사라지고 그 순간 접속해
 * 있던 사람이 전부 함께 튕긴다. 그런데 V8 은 컨테이너에 걸린 한도를 모르고 기계 전체를 기준으로 천장을
 * 잡기 때문에, 한도보다 높은 천장을 들고 있으면 정리할 때가 됐는데도 미루다 그대로 끝난다.
 * 두 수를 나란히 남겨 두면 그 어긋남이 눈에 보이고, 호스팅의 환경변수 하나로 맞출 수 있다.
 */
function reportMemoryCeiling(): void {
  const heapCapMB = Math.round(getHeapStatistics().heap_size_limit / 1048576)
  // 컨테이너 한도(cgroup v2 → v1 순). 한도가 없으면 'max' 이거나 파일이 없다.
  let limitMB = 0
  for (const p of ['/sys/fs/cgroup/memory.max', '/sys/fs/cgroup/memory/memory.limit_in_bytes']) {
    try {
      const n = Number(readFileSync(p, 'utf8').trim())
      if (Number.isFinite(n) && n > 0 && n < 64 * 1024 ** 3) {
        limitMB = Math.round(n / 1048576)
        break
      }
    } catch {
      /* 이 기계엔 없는 파일 — 다음 후보로 */
    }
  }
  if (!limitMB) {
    console.log(`[server] 메모리: 힙 천장 ${heapCapMB}MB (호스팅 한도 없음/미확인)`)
    return
  }
  console.log(`[server] 메모리: 호스팅 한도 ${limitMB}MB · 힙 천장 ${heapCapMB}MB`)
  if (heapCapMB > limitMB * 0.85) {
    console.warn(
      `[server] ⚠ 힙 천장(${heapCapMB}MB)이 호스팅 한도(${limitMB}MB)에 비해 높습니다. 메모리가 차면 서버가\n` +
        `[server] ⚠ 예고 없이 내려가고 접속해 있던 사람이 전부 끊깁니다. 환경변수에\n` +
        `[server] ⚠   NODE_OPTIONS=--max-old-space-size=${Math.floor((limitMB * 3) / 4)}\n` +
        '[server] ⚠ 을 넣어 주세요.'
    )
  }
}

httpServer.listen(PORT, () => {
  const scheme = tls ? 'wss' : 'ws'
  const cors = corsOrigins ? corsOrigins.join(', ') : '*'
  const web = webRoot ? `웹판 서빙(${webRoot})` : '웹판 없음(API 전용)'
  console.log(
    `타코야키 박스 릴레이 서버 listening on :${PORT} (${scheme} · CORS: ${cors} · ${web} · health: GET /health, Ctrl+C 종료)`
  )
  console.log(`[data] 영속 폴더: ${dataDir}`)
  reportMemoryCeiling()
  // 볼륨을 안 붙였거나 마운트 경로를 잘못 적으면 여기가 매 배포마다 새 폴더가 된다 — 조용히 지나가지 않는다.
  if (dataState.fresh) {
    console.warn(
      '[data] ⚠ 이 폴더가 비어 있습니다. 처음 켜는 서버라면 정상이지만, 쓰던 서버인데 이 줄이 보인다면\n' +
        '[data] ⚠ 볼륨이 안 붙었을 수 있습니다(계정·세션방이 사라져 보입니다). 마운트 경로가 위 폴더와 같은지 확인하세요.'
    )
  }
  // 파일을 일부만 덮어쓴 서버는 겉으로 멀쩡히 돌다가 그 기능을 쓰는 첫 사람에게서 멈춘다 — 켤 때 알린다.
  const oddFiles = checkSourceSet()
  if (oddFiles.length) {
    console.warn(
      `[server] ⚠ 서버 파일 ${oddFiles.length}개가 다른 판입니다: ${oddFiles.join(', ')}\n` +
        '[server] ⚠ 새 판의 src 폴더를 통째로 덮어써 주세요. 일부만 바꾸면 기능을 쓰는 순간 서버가 멈출 수 있습니다.'
    )
  }
})
