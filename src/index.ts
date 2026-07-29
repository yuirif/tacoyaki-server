// 타코야키 박스 멀티플레이 릴레이 서버 진입점.
// 개발: npm run dev (tsx watch). 기본 포트 8787 (PORT 환경변수로 변경).
// 공개 배포(하이브리드 클라우드)용 환경변수:
//   CORS_ORIGINS 허용 origin 쉼표목록(예: https://app.example.com). 미설정 = 전체(*) — 로컬/개발용.
//   TLS_KEY/TLS_CERT PEM 키·인증서 파일 경로. 둘 다 있으면 wss(https)로 기동. (리버스 프록시 종단이면 불필요)
//   SESSION_TTL_DAYS 세션 토큰 유휴 만료일(기본 30). 활성 사용 시 슬라이딩 연장.
import { readFileSync, existsSync } from 'node:fs'
import { join, resolve } from 'node:path'
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
    console.error('[tls] 인증서/키 로드 실패 — 평문으로 시작하지 않고 종료합니다:', e)
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

// 운영: 계정·캐릭터·세션방 영속(<cwd>/data) + 로그인 필수. 누구나 방을 만들 수 있고 생성자가 그 방의 GM(소유자)이 된다.
//   (자가호스팅 배포라 중앙 관리자가 없으므로 전역 admin 역할은 권한에 쓰지 않는다. role 필드는 호환용으로만 둔다.)
// 세션방은 영속(소유자 삭제 전까지 유지) — 유휴 정리(sweep) 없음.
const authStore = createAuthStore({ sessionTtlMs })
const charStore = createCharacterStore()
const roomStore = new RoomStore({ persist: true })
const assetStore = createAssetStore()
const dmStore = createDmStore()
const notifStore = createNotifStore()
const postStore = createPostStore()
const sessionLogStore = createSessionLogStore()
const dottownStore = createDottownStore()
const economyStore = createEconomyStore()
// 광장 부동산(빈터 입주) — 반드시 영속(persist 기본 true)해야 재시작/재배포에 집이 사라지지 않는다.
//   코인 차감은 economy 원장으로 수렴, 집 위 라벨은 도트타운 표시 닉으로 해석(relay 와 동일 규칙).
const estateStore = createEstateStore({
  charge: (id, amt, reason, ref) => economyStore.applyDelta(id, amt, reason, ref),
  resolveNick: (id) =>
    (id && (dottownStore.getNick(id) || authStore.getAccountById(id)?.nickname || authStore.getAccountById(id)?.username)) || ''
})
const marketStore = createMarketStore()
// 커뮤니티 — 서버 하나에 하나. 설정·글·캐릭터를 나눠 두되 자산 참조는 전부 상주 인덱스에 모아,
//   자산 회수의 참조 수집이 지금처럼 동기로 끝나게 한다.
const communityStore = createCommunityStore()
const communityPostStore = createCommunityPostStore()
const communityCharStore = createCommunityCharStore()
// 경제 — 도감(정의)·장부(기록)·선물 상자. 지갑과 소지품 자체는 캐릭터 샤드 안에 있다.
const communityCatalog = createCommunityCatalog()
const communityLedger = createCommunityLedger()
const communityGifts = createCommunityGiftStore()
const communityGames = createCommunityGames()
const communityEcon = createCommunityEcon({
  community: communityStore,
  chars: communityCharStore,
  catalog: communityCatalog,
  ledger: communityLedger,
  gifts: communityGifts
})

const { httpServer } = createRelay({
  requireAuth: true,
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
    marketStore.collectAssetRefs(live)
    communityStore.collectAssetRefs(live)
    communityPostStore.collectAssetRefs(live)
    communityCharStore.collectAssetRefs(live) // ⚠커뮤니티 이미지 — 안 실으면 최대 6시간 뒤 사라진다 // ⚠UGC 마켓 이미지(등록/보유) — 주기 GC 회수 방지
    communityCatalog.collectAssetRefs(live) // ⚠아이템 그림·상점 배너
    communityGifts.collectAssetRefs(live) // ⚠보내는 중인 선물의 편지 그림
    communityGames.collectAssetRefs(live) // ⚠퀘스트 배너·완료 카드·장면 그림
    const { removed, freed } = assetStore.sweep(live)
    if (removed) {
      console.log(`[assets] 고아 자산 ${removed}개 정리 · ${(freed / 1024 / 1024).toFixed(1)}MB 확보 (참조 ${live.size}개 보존)`)
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
  console.log(`[server] ${signal} — 저장하고 종료합니다.`)
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

httpServer.listen(PORT, () => {
  const scheme = tls ? 'wss' : 'ws'
  const cors = corsOrigins ? corsOrigins.join(', ') : '*'
  const web = webRoot ? `웹판 서빙(${webRoot})` : '웹판 없음(API 전용)'
  console.log(
    `타코야키 박스 릴레이 서버 listening on :${PORT} (${scheme} · CORS: ${cors} · ${web} · health: GET /health, Ctrl+C 종료)`
  )
})
