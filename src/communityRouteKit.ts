// 커뮤니티 라우트 표가 공유하는 것들 — 형태·문맥·의존물·짧은 도우미.
//
// 라우트 묶음이 둘로 갈리면서(게시판 쪽 / 경제 쪽) 두 파일이 서로를 부르게 됐다.
// 서로 부르는 모양은 로딩 순서에 따라 값이 비어 오는 사고를 부르므로, 공유물만 여기로 떼어 낸다.
import type { IncomingMessage, ServerResponse } from 'node:http'
import type { AuthStore, PublicAccount } from './auth'
import type { Board, CommunityMember, CommunityStore, PermKey } from './community'
import type { CommunityPostStore } from './communityPost'
import type { CommunityCharStore } from './communityChar'
import type { CommunityCatalog } from './communityCatalog'
import type { CommunityEcon } from './communityEcon'
import type { CommunityLedger } from './communityLedger'
import type { CommunityGiftStore } from './communityGift'
import type { CommunityGames } from './communityGame'
import type { CommunityQuest } from './communityQuest'
import type { CommunitySurvey } from './communitySurvey'

export const JSON_H = { 'content-type': 'application/json' }

export interface CommunityRouteDeps {
  auth: AuthStore
  community: CommunityStore
  posts: CommunityPostStore
  chars: CommunityCharStore
  catalog: CommunityCatalog
  econ: CommunityEcon
  ledger: CommunityLedger
  gifts: CommunityGiftStore
  games: CommunityGames
  quest: CommunityQuest
  survey: CommunitySurvey
  readJsonBody: (req: IncomingMessage) => Promise<Record<string, unknown>>
  /** 개인 대상 알림(저장 + 푸시). 커뮤니티는 종류를 'cmty' 하나로 쓰고 세부는 본문에 담는다. */
  notify: (ownerId: string, item: { kind: string; actor: unknown; ref?: string; text?: string }) => void
  actorOf: (account: PublicAccount) => unknown
  /** 게시판·글 룸으로 실시간 사건을 흘린다. */
  emitTo: (room: string, event: string, payload: unknown) => void
  /** 계정 단위 푸시(권한·명칭 변경 등 그 사람만 다시 받아야 하는 것). */
  emitAccount: (accountId: string, event: string, payload: unknown) => void
  socialLimited: (accountId: string, res: ServerResponse) => boolean
  econLimited: (accountId: string, res: ServerResponse) => boolean
  now: () => number
}

/** 라우트 하나의 실행 결과 — 그대로 JSON 으로 나간다. */
export type Reply = { status?: number; body: Record<string, unknown> }

export interface Ctx {
  account: PublicAccount
  member: CommunityMember | null
  isAppAdmin: boolean
  board: Board | null
  now: number
  /** 이 문맥에서의 권한 판정 — 라우트가 추가 검사에 쓴다. */
  can: (perm: PermKey, board?: Board | null) => boolean
  /** 운영 행위 기록. 앱 관리자 자격으로 통과했으면 그 사실이 함께 남는다. */
  audit: (action: string, detail?: string, target?: { type?: string; id?: string; name?: string }) => void
}

export interface Route {
  /**
   * 'login'  로그인만 하면 된다(가입 전 열람 포함)
   * 'member' 커뮤니티 멤버여야 한다
   * 그 외    그 권한이 있어야 한다
   */
  need: 'login' | 'member' | PermKey
  /** 게시판 스코프를 본문의 어느 값에서 얻는가. 권한이 게시판 단위일 때 필요하다. */
  scope?: 'boardId' | 'postId'
  rate?: 'social' | 'econ'
  run: (b: Record<string, unknown>, c: Ctx, d: CommunityRouteDeps) => Reply
}

export const s = (v: unknown, max = 200): string => (typeof v === 'string' ? v.slice(0, max) : '')
export const n = (v: unknown, def = 0): number => (typeof v === 'number' && Number.isFinite(v) ? v : def)
export const ok = (body: Record<string, unknown> = {}): Reply => ({ body: { ok: true, ...body } })
export const fail = (error: string, status = 400): Reply => ({ status, body: { ok: false, error } })
export const from = <T>(r: { ok: true; value: T } | { ok: false; error: string }, key: string): Reply =>
  r.ok ? ok({ [key]: r.value }) : fail(r.error)

/** 이 사람이 다루려는 캐릭터가 자기 것인지. 아니면 운영 권한이 있어야 한다. */
export function ownsOrStaff(c: Ctx, d: CommunityRouteDeps, charId: string): boolean {
  const doc = d.chars.get(charId)
  if (!doc) return false
  return doc.ownerId === c.account.id || c.can('cmty.manageChars')
}
