// 커뮤니티 HTTP 라우트 — relay 의 라우트 사슬에서 갈라져 나온 묶음.
//
// 라우트가 마흔 개 남짓이라 본체에 늘어놓지 않고 여기 표로 모은다. 표로 두는 이유는 길이만이 아니다.
// 각 항목이 '어떤 권한이 필요한가'를 자기 옆에 적게 되어, 권한 검사를 빠뜨린 라우트가 눈에 띈다.
// 권한 판정은 community 의 can() 하나만 쓴다 — 여기에 다른 검사 경로를 만들지 않는다.
import type { IncomingMessage, ServerResponse } from 'node:http'
import type { PermCtx, Board, PermKey } from './community'
import type { PostSummary, SaveInput } from './communityPost'
import { ECON_ROUTES } from './communityEconRoutes'
import { GAME_ROUTES } from './communityGameRoutes'
import {
  JSON_H,
  fail,
  from,
  n,
  ok,
  s,
  type CommunityRouteDeps,
  type Ctx,
  type Reply,
  type Route
} from './communityRouteKit'

export type { CommunityRouteDeps } from './communityRouteKit'

/** 글이 속한 게시판. 권한 스코프를 잡을 때 쓴다. */
function boardOfPost(d: CommunityRouteDeps, postId: string): Board | null {
  const sum = d.posts.summary(postId)
  return sum ? d.community.board(sum.boardId) : null
}

/**
 * 이 사람이 이 캐릭터로 말할 수 있는가.
 * 이름은 클라가 보낸 값을 쓰지 않고 서버가 가진 것으로 덮는다 — 이름만 갈아 끼워 남인 척하는 길을 막는다.
 * 이 문화에서 '누가 말했는가'는 곧 그 사람의 신원이라, 여기가 뚫리면 뒤에서 되돌릴 방법이 없다.
 */
function speakingAs(c: Ctx, d: CommunityRouteDeps, raw: unknown): { ok: true; charId: string; charName: string } | { ok: false; error: string } {
  // 보통 커뮤니티에는 캐릭터 명의가 없다 — 무엇이 와도 계정 명의로 접는다(옛 자료가 남아 있어도).
  if (d.community.settings()?.mode === 'basic') return { ok: true, charId: '', charName: '' }
  const charId = s(raw, 64)
  if (!charId) return { ok: true, charId: '', charName: '' }
  const doc = d.chars.get(charId)
  if (!doc) return { ok: false, error: '캐릭터를 찾을 수 없습니다.' }
  // 운영이 세운 NPC 는 캐릭터 담당 권한이 있는 사람이 대신 말한다.
  if (doc.ownerId !== c.account.id && !(doc.npc && c.can('cmty.manageChars'))) return { ok: false, error: '내 캐릭터로만 쓸 수 있습니다.' }
  if (doc.status !== 'approved') return { ok: false, error: '승인된 캐릭터로만 쓸 수 있습니다.' }
  return { ok: true, charId, charName: doc.name }
}

const RATING_RANK: Record<string, number> = { all: 0, r15: 1, r19: 2 }

/** 게시판에 걸린 수위는 그 게시판 글의 하한이다 — 더 높게는 적을 수 있어도 더 낮게는 못 적는다. */
function ratingFloor(boardRating: string | undefined, want: unknown): string {
  const w = typeof want === 'string' && want in RATING_RANK ? want : 'all'
  const f = boardRating && boardRating in RATING_RANK ? boardRating : 'all'
  return RATING_RANK[w] >= RATING_RANK[f] ? w : f
}

/** 발화 정체를 담은 것들의 공통 모양 — 익명 처리를 글·댓글에 같은 방식으로 걸기 위한 최소 형태. */
interface Spoken {
  authorId: string
  authorNick: string
  authorAvatar: string
  charId: string
  charName: string
}

/**
 * 익명 게시판에서 쓴 사람을 지운다.
 * 화면에서 숨기는 것으로는 익명이 되지 않는다(응답에 이름이 들어 있으면 그것으로 끝이다) —
 * 반드시 나가기 전에 지운다. 본인과 식별 권한이 있는 운영진에게는 그대로 보인다.
 */
function anonymize<T extends Spoken>(x: T, c: Ctx, board: Board | null): T {
  if (!board?.anonymous) return x
  if (x.authorId === c.account.id || c.can('board.viewSecret', board)) return x
  return { ...x, authorId: '', authorNick: '익명', authorAvatar: '', charId: '', charName: '' }
}

/**
 * 소켓 룸으로 나가는 댓글 사본 — 받을 사람을 고를 수 없으므로 나가기 전에 지운다.
 * 익명 게시판이면 쓴 사람을, 비밀 댓글이면 본문을 지워 '무언가 달렸다'만 알린다(열람은 HTTP 가 권한대로).
 */
function maskLive<T extends Spoken & { secret?: boolean; text: string; images: string[] }>(x: T, c: Ctx): T {
  let out = x
  if (out.secret) out = { ...out, text: '', images: [] }
  if (c.board?.anonymous) out = { ...out, authorId: '', authorNick: '익명', authorAvatar: '', charId: '', charName: '' }
  return out
}

/** 이 사람이 이 글을 볼 수 있는가 — 공개 범위와 게시판 권한을 함께 본다. */
function canSeePost(c: Ctx, authorId: string, visibility: string): boolean {
  if (visibility === 'all') return true
  if (!c.member) return false
  if (visibility === 'member') return true
  // 비밀글은 쓴 사람과 열람 권한이 있는 운영진만.
  return authorId === c.account.id || c.can('board.viewSecret')
}

const BOARD_ROUTES: Record<string, Route> = {
  /**
   * 이 서버가 커뮤니티를 쓰는가만 묻는다. 로비가 바탕화면을 그리기 전에 한 번 부르므로
   * 부트스트랩처럼 무겁지 않아야 한다.
   */
  '/cmty/state': {
    need: 'login',
    run(_b, _c, d) {
      return ok({ enabled: d.community.enabled() })
    }
  },

  // ── 열람 ────────────────────────────────────────────────────────────────
  '/cmty/bootstrap': {
    need: 'login',
    run(_b, c, d) {
      const set = d.community.settings()
      if (!set) {
        // 아직 없다 — 서버 주인에게만 개설 화면을 띄운다.
        return ok({ community: null, canCreate: c.isAppAdmin })
      }
      const permCtx = { accountId: c.account.id, isAppAdmin: c.isAppAdmin, member: c.member, now: c.now }
      const boards = d.community.visibleBoards(permCtx)
      const snap = d.community.permSnapshot(permCtx)
      // 보통 커뮤니티는 캐릭터·경제 몫을 아예 싣지 않는다 — 모드를 모르는 옛 클라도 메뉴가 없으면 그 화면에 못 간다.
      const oc = set.mode !== 'basic'
      return ok({
        enabled: true,
        community: {
          cid: set.cid,
          mode: set.mode,
          name: set.name,
          tagline: set.tagline,
          logo: set.logo,
          stage: set.stage,
          joinMode: set.joinMode,
          theme: set.theme,
          labels: set.labels,
          roles: set.roles,
          categories: set.categories,
          menu: oc ? set.menu : set.menu.filter((m) => !m.builtin || m.builtin === 'home'),
          permVersion: set.permVersion,
          hasApplyForm: set.applyForm.length > 0
        },
        boards,
        member: c.member,
        perms: snap.cmty,
        boardPerms: snap.boards,
        myChars: oc ? d.chars.ownedBy(c.account.id) : [],
        statSchema: oc ? d.chars.schema() : null,
        econ: oc ? set.econ : null,
        // 첫 화면에서 바로 보여야 하는 것들 — 선물함에 뭔가 와 있는지, 대표 캐릭터를 정했는지.
        pendingGifts: oc ? d.gifts.listFor(c.account.id).incoming.length : 0,
        hasMain: oc ? !!d.chars.mainOf(c.account.id) : false,
        // 게시판마다 마지막 글이 언제인지 — 화면이 '내가 본 때'와 견줘 ●NEW 를 가른다.
        lastPostAt: d.posts.lastPostAt(c.now)
      })
    }
  },

  '/cmty/applyForm': {
    need: 'login',
    run(_b, _c, d) {
      const set = d.community.settings()
      // 심사용 숨김 칸은 신청자에게 보내지 않는다.
      return ok({ fields: (set?.applyForm ?? []).filter((f) => !f.staffOnly) })
    }
  },

  '/cmty/post/list': {
    need: 'board.read',
    scope: 'boardId',
    run(b, c, d) {
      const boardId = s(b.boardId, 64)
      const r = d.posts.list(boardId, {
        page: n(b.page, 1),
        perPage: n(b.perPage, 20),
        prefix: s(b.prefix, 20) || undefined,
        tag: s(b.tag, 30) || undefined,
        authorId: s(b.authorId, 64) || undefined,
        charId: s(b.charId, 64) || undefined,
        q: s(b.q, 60) || undefined,
        includeDrafts: c.account.id
      })
      const keep = (x: { authorId: string; visibility: string }): boolean => canSeePost(c, x.authorId, x.visibility)
      const mask = (x: PostSummary): PostSummary => anonymize(x, c, c.board)
      return ok({ ...r, items: r.items.filter(keep).map(mask), notices: r.notices.filter(keep).map(mask) })
    }
  },

  '/cmty/post/get': {
    need: 'board.read',
    scope: 'postId',
    run(b, c, d) {
      const postId = s(b.postId, 64)
      const got = d.posts.get(postId)
      if (!got || (got.post.deletedAt && !c.can('board.deleteAny'))) return fail('글을 찾을 수 없습니다.', 404)
      if (!canSeePost(c, got.post.authorId, got.post.visibility)) return fail('볼 수 없는 글입니다.', 403)
      const mine = got.post.authorId === c.account.id
      if (got.post.draft && !mine) return fail('글을 찾을 수 없습니다.', 404)
      // 예약한 글은 그때가 오기 전까지 주소를 알아도 열리지 않는다 — 목록에서만 감추면 예약이 아니다.
      if (got.post.publishAt > c.now && !mine && !c.can('board.deleteAny')) return fail('글을 찾을 수 없습니다.', 404)
      const canSecret = mine || c.can('board.viewSecret')
      return ok({
        post: anonymize(got.post, c, c.board),
        // 비밀 댓글은 쓴 사람·글 주인·열람 권한자만. 나머지에게는 자리만 남긴다.
        comments: got.comments.map((cm) =>
          anonymize(cm.secret && !canSecret && cm.authorId !== c.account.id ? { ...cm, text: '', images: [] } : cm, c, c.board)
        ),
        liked: got.post.likes.includes(c.account.id)
      })
    }
  },

  '/cmty/char/list': {
    need: 'login',
    run(b, _c, d) {
      return ok({
        items: d.chars.list({
          ownerId: s(b.ownerId, 64) || undefined,
          tag: s(b.tag, 30) || undefined,
          q: s(b.q, 40) || undefined,
          includeRetired: b.includeRetired === true
        })
      })
    }
  },

  '/cmty/char/get': {
    need: 'login',
    run(b, _c, d) {
      const doc = d.chars.view(s(b.charId, 64))
      if (!doc) return fail('캐릭터를 찾을 수 없습니다.', 404)
      return ok({ char: doc, body: d.chars.bodyOf(doc.id) })
    }
  },

  // ── 가입 ────────────────────────────────────────────────────────────────
  '/cmty/join': {
    need: 'login',
    run(b, c, d) {
      const r = d.community.join(c.account.id, s(b.nick, 20), (b.answers ?? {}) as Record<string, unknown>, c.now)
      if (!r.ok) return fail(r.error)
      const set = d.community.settings()
      if (r.value.application && set) {
        // 심사가 필요한 가입은 운영진에게 알린다.
        for (const m of d.community.members()) {
          if (m.accountId === c.account.id) continue
          if (!d.community.can('cmty.approveJoin', { accountId: m.accountId, isAppAdmin: false, member: m, board: null, now: c.now })) continue
          d.notify(m.accountId, { kind: 'cmty', actor: d.actorOf(c.account), ref: 'join', text: '가입 신청이 들어왔습니다.' })
        }
      }
      return ok({ member: r.value.member, pending: !!r.value.application })
    }
  },

  // ── 글 ──────────────────────────────────────────────────────────────────
  '/cmty/post/save': {
    need: 'board.write',
    scope: 'boardId',
    rate: 'social',
    run(b, c, d) {
      const postId = s(b.postId, 64)
      if (postId) {
        const sum = d.posts.summary(postId)
        if (!sum) return fail('글을 찾을 수 없습니다.', 404)
        // 수정은 내 글이거나 남의 글 수정 권한이 있어야 한다.
        const mine = sum.authorId === c.account.id
        if (!mine && !c.can('board.editAny')) return fail('수정할 수 없습니다.', 403)
        if (mine && !c.can('board.edit')) return fail('수정할 수 없습니다.', 403)
      }
      if (b.visibility === 'secret' && !c.can('board.secret')) return fail('비밀글을 쓸 수 없습니다.', 403)
      const hasImages = !!s(b.cover, 80) || (Array.isArray(b.gallery) && b.gallery.length > 0)
      if (hasImages && !c.can('board.attach')) return fail('이미지를 첨부할 수 없습니다.', 403)

      const who = speakingAs(c, d, b.charId)
      if (!who.ok) return fail(who.error, 403)

      const nick = c.member?.nick || c.account.nickname || c.account.username
      // 본문의 각 칸은 저장소가 형태별로 다시 검사한다 — 여기서는 게시판·발화자·수위만 확정해 넘긴다.
      const input = {
        ...b,
        boardId: s(b.boardId, 64),
        charId: who.charId,
        charName: who.charName,
        rating: ratingFloor(c.board?.rating, b.rating)
      } as SaveInput
      const r = d.posts.save({ id: c.account.id, nick, avatar: c.account.avatar ?? '' }, input, c.now)
      if (!r.ok) return fail(r.error)
      if (!postId && !r.value.draft) {
        d.community.bumpStat(c.account.id, 'posts', 1, c.now)
        // 활동 정산 — 대표 캐릭터가 없거나 꺼져 있으면 조용히 아무 일도 하지 않는다.
        // 보통 커뮤니티는 경제 자체가 닫혀 있다 — 아무도 볼 수 없는 지갑이 몰래 자라게 두지 않는다.
        if (d.community.settings()?.mode !== 'basic') d.econ.activity(c.account.id, 'post', c.now)
        // 구독자에게만 새 글을 알린다(전원 알림은 곧 알림을 무시하게 만든다).
        for (const sub of d.community.subscribers(r.value.boardId, c.account.id)) {
          d.notify(sub, { kind: 'cmty', actor: d.actorOf(c.account), ref: r.value.id, text: r.value.title })
        }
      }
      d.emitTo('cmtyb:' + r.value.boardId, 'cmty:post', { boardId: r.value.boardId, op: postId ? 'update' : 'new', postId: r.value.id })
      return ok({ post: r.value })
    }
  },

  '/cmty/post/remove': {
    need: 'board.read',
    scope: 'postId',
    run(b, c, d) {
      const postId = s(b.postId, 64)
      const sum = d.posts.summary(postId)
      if (!sum) return fail('글을 찾을 수 없습니다.', 404)
      if (sum.authorId !== c.account.id && !c.can('board.deleteAny')) return fail('삭제할 수 없습니다.', 403)
      const r = d.posts.remove(postId, c.account.id, c.now)
      if (!r.ok) return fail(r.error)
      if (sum.authorId !== c.account.id) c.audit('post.remove', sum.title, { type: 'post', id: postId })
      d.emitTo('cmtyb:' + sum.boardId, 'cmty:post', { boardId: sum.boardId, op: 'remove', postId })
      return ok({ post: r.value })
    }
  },

  '/cmty/post/restore': {
    need: 'board.deleteAny',
    scope: 'postId',
    run(b, c, d) {
      // 관리자가 아니면 자기가 지운 것만 되살릴 수 있다.
      const ownOnly = c.member?.roleId !== 'owner' && !c.isAppAdmin
      const r = d.posts.restore(s(b.postId, 64), c.account.id, ownOnly)
      if (r.ok) c.audit('post.restore', r.value.title, { type: 'post', id: r.value.id })
      return from(r, 'post')
    }
  },

  '/cmty/post/notice': {
    need: 'board.notice',
    scope: 'postId',
    run(b, c, d) {
      const board = c.board
      const r = d.posts.setNotice(s(b.postId, 64), n(b.level, 0) as 0 | 1 | 2, board?.noticeMax ?? 3)
      if (r.ok) c.audit('post.notice', `${r.value.title} → ${n(b.level, 0)}`, { type: 'post', id: r.value.id })
      return from(r, 'post')
    }
  },

  '/cmty/post/status': {
    need: 'board.read',
    scope: 'postId',
    run(b, c, d) {
      const postId = s(b.postId, 64)
      const sum = d.posts.summary(postId)
      if (!sum) return fail('글을 찾을 수 없습니다.', 404)
      // 스레드 상태(모집중·진행중·마감)는 글쓴이와 운영진이 바꾼다.
      if (sum.authorId !== c.account.id && !c.can('board.deleteAny')) return fail('바꿀 수 없습니다.', 403)
      const st = b.status === 'recruit' || b.status === 'running' || b.status === 'closed' ? b.status : 'running'
      return from(d.posts.setStatus(postId, st), 'post')
    }
  },

  '/cmty/post/comments': {
    need: 'board.read',
    scope: 'postId',
    run(b, c, d) {
      const postId = s(b.postId, 64)
      const sum = d.posts.summary(postId)
      if (!sum) return fail('글을 찾을 수 없습니다.', 404)
      // 댓글을 닫는 것은 글쓴이의 몫이다. 운영진은 정리 목적으로만 손댄다.
      if (sum.authorId !== c.account.id && !c.can('board.deleteAny')) return fail('바꿀 수 없습니다.', 403)
      const r = d.posts.setCommentsClosed(postId, b.closed === true)
      if (r.ok) d.emitTo('cmtyb:' + sum.boardId, 'cmty:post', { boardId: sum.boardId, op: 'update', postId })
      return from(r, 'post')
    }
  },

  '/cmty/post/like': {
    need: 'board.read',
    scope: 'postId',
    rate: 'social',
    run(b, c, d) {
      const r = d.posts.like(s(b.postId, 64), c.account.id)
      return r.ok ? ok(r.value) : fail(r.error)
    }
  },

  '/cmty/post/view': {
    need: 'board.read',
    scope: 'postId',
    rate: 'social',
    run(b, _c, d) {
      d.posts.addView(s(b.postId, 64))
      return ok()
    }
  },

  // ── 댓글 ────────────────────────────────────────────────────────────────
  '/cmty/comment/add': {
    need: 'board.comment',
    scope: 'postId',
    rate: 'social',
    run(b, c, d) {
      const postId = s(b.postId, 64)
      const sum = d.posts.summary(postId)
      if (!sum) return fail('글을 찾을 수 없습니다.', 404)
      if (Array.isArray(b.images) && b.images.length && !c.can('board.attach')) return fail('이미지를 첨부할 수 없습니다.', 403)
      if (b.secret === true && !c.can('board.secret')) return fail('비밀 댓글을 쓸 수 없습니다.', 403)
      if (sum.status === 'closed') return fail('마감된 글에는 댓글을 달 수 없습니다.')
      const who = speakingAs(c, d, b.charId)
      if (!who.ok) return fail(who.error, 403)

      const nick = c.member?.nick || c.account.nickname || c.account.username
      const body = { ...b, charId: who.charId, charName: who.charName }
      const r = d.posts.addComment(postId, { id: c.account.id, nick, avatar: c.account.avatar ?? '' }, body, c.now)
      if (!r.ok) return fail(r.error)
      d.community.bumpStat(c.account.id, 'comments', 1, c.now)
      if (d.community.settings()?.mode !== 'basic') d.econ.activity(c.account.id, 'comment', c.now)

      const actor = d.actorOf(c.account)
      const parent = r.value.parentId ? d.posts.comments(postId).find((x) => x.id === r.value.parentId) : null
      // 답글이면 이어받은 상대에게, 그리고 글 주인에게. 같은 사람이면 한 번만 간다.
      if (parent && parent.authorId !== c.account.id) {
        d.notify(parent.authorId, { kind: 'cmty', actor, ref: postId, text: r.value.text })
        d.community.bumpStat(parent.authorId, 'received', 1, c.now)
      }
      if (sum.authorId !== parent?.authorId) {
        d.notify(sum.authorId, { kind: 'cmty', actor, ref: postId, text: r.value.text })
        d.community.bumpStat(sum.authorId, 'received', 1, c.now)
      }
      d.emitTo('cmtyp:' + postId, 'cmty:comment', { postId, op: 'new', comment: maskLive(r.value, c) })
      return ok({ comment: r.value })
    }
  },

  '/cmty/comment/edit': {
    need: 'board.comment',
    scope: 'postId',
    rate: 'social',
    run(b, c, d) {
      const postId = s(b.postId, 64)
      const r = d.posts.editComment(s(b.commentId, 64), postId, c.account.id, b.text, c.now)
      if (r.ok) d.emitTo('cmtyp:' + postId, 'cmty:comment', { postId, op: 'edit', comment: maskLive(r.value, c) })
      return from(r, 'comment')
    }
  },

  '/cmty/comment/remove': {
    need: 'board.read',
    scope: 'postId',
    run(b, c, d) {
      const postId = s(b.postId, 64)
      const r = d.posts.removeComment(s(b.commentId, 64), postId, c.account.id, c.can('board.deleteAny'), c.now)
      if (r.ok) d.emitTo('cmtyp:' + postId, 'cmty:comment', { postId, op: 'remove', comment: maskLive(r.value, c) })
      return from(r, 'comment')
    }
  },

  '/cmty/report': {
    need: 'member',
    rate: 'social',
    run(b, c, d) {
      const r = d.posts.report(c.account.id, b, c.now)
      if (!r.ok) return fail(r.error)
      for (const m of d.community.members()) {
        if (!d.community.can('cmty.handleReport', { accountId: m.accountId, isAppAdmin: false, member: m, board: null, now: c.now })) continue
        d.notify(m.accountId, { kind: 'cmty', actor: d.actorOf(c.account), ref: 'report', text: '신고가 접수됐습니다.' })
      }
      return ok({ report: r.value })
    }
  },

  // ── 게시판 개인 설정 ────────────────────────────────────────────────────
  '/cmty/board/read': {
    need: 'member',
    run(b, c, d) {
      d.community.markRead(c.account.id, s(b.boardId, 64), c.now)
      return ok()
    }
  },
  '/cmty/board/sub': {
    need: 'member',
    run(b, c, d) {
      const r = d.community.toggleSub(c.account.id, s(b.boardId, 64))
      return r.ok ? ok({ subs: r.value }) : fail(r.error)
    }
  },

  // ── 캐릭터 ──────────────────────────────────────────────────────────────
  '/cmty/char/save': {
    need: 'member',
    rate: 'social',
    run(b, c, d) {
      const r = d.chars.save(c.account.id, b, c.now)
      return from(r, 'char')
    }
  },
  '/cmty/char/remove': {
    need: 'member',
    run(b, c, d) {
      const charId = s(b.charId, 64)
      const doc = d.chars.get(charId)
      if (!doc) return fail('캐릭터를 찾을 수 없습니다.', 404)
      if (doc.ownerId !== c.account.id && !c.can('cmty.manageChars')) return fail('보관할 수 없습니다.', 403)
      // 나가 있는 캐릭터를 보관하면 그 판이 영영 끝나지 않는다. 먼저 그만두게 한다.
      if (d.quest.isBusy(charId)) return fail('파견 중입니다. 먼저 파견을 그만두어 주세요.')
      const r = d.chars.remove(charId, c.now)
      // 보관으로 넘어가면 얽혀 있던 선물이 영영 열리지 않는다. 먼저 전부 되돌린다.
      if (r.ok) d.econ.returnGiftsOf(charId, c.now)
      return from(r, 'char')
    }
  },
  '/cmty/char/look': {
    need: 'member',
    run(b, c, d) {
      const charId = s(b.charId, 64)
      const doc = d.chars.get(charId)
      if (!doc) return fail('캐릭터를 찾을 수 없습니다.', 404)
      if (doc.ownerId !== c.account.id) return fail('내 캐릭터만 바꿀 수 있습니다.', 403)
      if (b.op === 'add') return from(d.chars.addLook(charId, s(b.label, 40), b.fullBody, c.now), 'look')
      if (b.op === 'remove') return from(d.chars.removeLook(charId, s(b.lookId, 64), c.now), 'char')
      return from(d.chars.setLook(charId, s(b.lookId, 64), c.now), 'char')
    }
  },
  '/cmty/char/relation': {
    need: 'member',
    run(b, c, d) {
      const charId = s(b.charId, 64)
      const doc = d.chars.get(charId)
      if (!doc) return fail('캐릭터를 찾을 수 없습니다.', 404)
      if (doc.ownerId !== c.account.id) return fail('내 캐릭터의 관계만 바꿀 수 있습니다.', 403)
      const other = s(b.toCharId, 64)
      if (b.op === 'accept') {
        const r = d.chars.acceptRelation(charId, other, c.now)
        return from(r, 'relation')
      }
      if (b.op === 'remove') {
        const r = d.chars.removeRelation(charId, other)
        return r.ok ? ok() : fail(r.error)
      }
      const r = d.chars.proposeRelation(charId, other, s(b.label, 40), s(b.note, 500), c.now)
      if (r.ok && r.value.status === 'pending') {
        const target = d.chars.get(other)
        // 관계는 상대 오너의 합의가 원칙이라, 제안이 왔다는 사실을 반드시 알린다.
        if (target) d.notify(target.ownerId, { kind: 'cmty', actor: d.actorOf(c.account), ref: other, text: `관계 제안: ${r.value.label}` })
      }
      return from(r, 'relation')
    }
  },

  // ── 운영 ────────────────────────────────────────────────────────────────
  '/cmty/admin/create': {
    need: 'login',
    run(b, c, d) {
      if (!c.isAppAdmin) return fail('서버 주인만 커뮤니티를 열 수 있습니다.', 403)
      // 성격은 열 때 한 번 정해진다. 화면은 보통 커뮤니티만 내준다 — oc 값은 자캐 판이 열리기 전까지
      // 시험 하네스만 쓰는 뒷문이다(서버 주인 자격이 있어야만 닿는다).
      const set = d.community.ensure(c.account.id, c.now, b.mode === 'oc' ? 'oc' : 'basic')
      c.audit('community.create', set.name)
      return ok({ community: set })
    }
  },
  '/cmty/admin/mode': {
    need: 'login',
    run(b, c, d) {
      // 성격 전환은 화면 구성이 통째로 바뀌는 일이라 커뮤니티 역할이 아니라 서버 주인의 몫이다.
      if (!c.isAppAdmin) return fail('서버 주인만 커뮤니티 성격을 바꿀 수 있습니다.', 403)
      // 자캐 쪽은 아직 다듬는 중이다 — 코드는 있어도 문은 열지 않는다(보통 판으로 접는 방향만 연다).
      if (b.mode === 'oc') return fail('자캐(캐릭터) 커뮤니티는 아직 개발 중이라 이용할 수 없습니다.')
      const r = d.community.setMode(b.mode, c.now)
      if (!r.ok) return fail(r.error)
      c.audit('community.mode', r.value.mode === 'oc' ? '캐릭터 커뮤니티' : '보통 커뮤니티')
      // 보고 있던 화면들이 새 구성을 받아 오게 한다(붙박이 메뉴·게시판·권한 스냅샷이 전부 달라진다).
      d.emitTo('cmty:main', 'cmty:perm', { permVersion: r.value.permVersion })
      return ok({ community: { mode: r.value.mode } })
    }
  },
  '/cmty/admin/settings': {
    need: 'cmty.manageBoards',
    run(b, c, d) {
      const r = d.community.saveSettings(b, c.now)
      if (r.ok) c.audit('community.settings')
      return from(r, 'community')
    }
  },
  '/cmty/admin/tree': {
    need: 'cmty.manageBoards',
    run(b, c, d) {
      const prev = d.community.settings()
      // 두 사람이 동시에 트리를 저장하면 나중 것이 먼저 것을 통째로 덮는다. 판을 대조해 막는다.
      if (prev && n(b.updatedAt, 0) && n(b.updatedAt, 0) !== prev.updatedAt) {
        return fail('다른 운영진이 방금 구성을 바꿨습니다. 새로고침 후 다시 저장해 주세요.', 409)
      }
      const r = d.community.saveTree(b, c.now)
      if (r.ok) c.audit('board.tree', `분류 ${r.value.categories.length} · 게시판 ${r.value.boards.length}`)
      return from(r, 'community')
    }
  },
  '/cmty/admin/board/remove': {
    need: 'cmty.manageBoards',
    run(b, c, d) {
      const boardId = s(b.boardId, 64)
      const board = d.community.board(boardId)
      if (!board) return fail('없는 게시판입니다.', 404)
      const mode = b.mode === 'move' || b.mode === 'purge' ? b.mode : 'trash'
      const moveTo = s(b.moveTo, 64)
      if (mode === 'move' && !d.community.board(moveTo)) return fail('옮길 게시판을 골라 주세요.')
      const r = d.community.removeBoard(boardId, c.now)
      if (!r.ok) return fail(r.error)
      const moved = d.posts.boardRemoved(boardId, mode, moveTo, c.now)
      c.audit('board.remove', `${board.name} (글 ${moved}건 · ${mode})`, { type: 'board', id: boardId, name: board.name })
      return ok({ board: r.value, affected: moved })
    }
  },
  '/cmty/admin/roles': {
    need: 'cmty.manageRoles',
    run(b, c, d) {
      const r = d.community.saveRoles(b.roles, c.now)
      if (r.ok) c.audit('role.save', r.value.map((x) => x.name).join(', '))
      return from(r, 'roles')
    }
  },
  '/cmty/admin/theme': {
    need: 'cmty.manageTheme',
    run(b, c, d) {
      const r = d.community.saveTheme(b.theme, c.now)
      if (r.ok) {
        c.audit('theme.save')
        d.emitTo('cmty:main', 'cmty:theme', { theme: r.value })
      }
      return from(r, 'theme')
    }
  },
  '/cmty/admin/labels': {
    need: 'cmty.manageLabels',
    run(b, c, d) {
      const r = d.community.saveLabels(b.labels, c.now)
      if (r.ok) {
        c.audit('labels.save')
        d.emitTo('cmty:main', 'cmty:labels', { labels: r.value })
      }
      return from(r, 'labels')
    }
  },
  '/cmty/admin/members': {
    need: 'cmty.manageMembers',
    run(_b, _c, d) {
      const chars = new Map<string, number>()
      for (const e of d.chars.list({ includeRetired: true })) chars.set(e.ownerId, (chars.get(e.ownerId) ?? 0) + 1)
      return ok({ members: d.community.members().map((m) => ({ ...m, charCount: chars.get(m.accountId) ?? 0 })) })
    }
  },
  '/cmty/admin/member/role': {
    need: 'cmty.manageMembers',
    run(b, c, d) {
      const tier = d.community.role(c.member?.roleId ?? '')?.tier ?? (c.isAppAdmin ? -1 : 99)
      const target = s(b.accountId, 64)
      const r = d.community.setRole(c.account.id, tier, target, s(b.roleId, 40), c.now)
      if (r.ok) {
        c.audit('member.role', `→ ${s(b.roleId, 40)}`, { type: 'member', id: target })
        d.emitAccount(target, 'cmty:perm', { permVersion: d.community.settings()?.permVersion ?? 0 })
      }
      return from(r, 'member')
    }
  },
  '/cmty/admin/member/perms': {
    need: 'cmty.manageMembers',
    run(b, c, d) {
      const target = s(b.accountId, 64)
      const r = d.community.setMemberPerms(target, b.perms, b.boardPerms)
      if (r.ok) {
        c.audit('member.perms', '개별 권한 편집', { type: 'member', id: target })
        d.emitAccount(target, 'cmty:perm', { permVersion: d.community.settings()?.permVersion ?? 0 })
      }
      return from(r, 'member')
    }
  },
  '/cmty/admin/member/sanction': {
    need: 'cmty.sanction',
    run(b, c, d) {
      const tier = d.community.role(c.member?.roleId ?? '')?.tier ?? (c.isAppAdmin ? -1 : 99)
      const target = s(b.accountId, 64)
      const r = b.clear === true
        ? d.community.clearSanction(tier, target)
        : d.community.sanction(c.account.id, tier, target, b, c.now)
      if (r.ok) {
        c.audit(b.clear === true ? 'member.sanction.clear' : 'member.sanction', s(b.reason, 200), { type: 'member', id: target })
        d.emitAccount(target, 'cmty:perm', { permVersion: d.community.settings()?.permVersion ?? 0 })
      }
      return from(r, 'member')
    }
  },
  '/cmty/admin/applications': {
    need: 'cmty.approveJoin',
    run(_b, _c, d) {
      return ok({ applications: d.community.applications() })
    }
  },
  '/cmty/admin/application/decide': {
    need: 'cmty.approveJoin',
    run(b, c, d) {
      const appId = s(b.appId, 64)
      const app = d.community.applications().find((x) => x.id === appId)
      const approve = b.approve === true
      const r = d.community.decideApplication(c.account.id, appId, approve, s(b.note, 200), c.now)
      if (!r.ok) return fail(r.error)
      c.audit(approve ? 'join.approve' : 'join.reject', s(b.note, 200), { type: 'member', id: app?.accountId })
      if (app) {
        d.notify(app.accountId, {
          kind: 'cmty',
          actor: d.actorOf(c.account),
          ref: 'join',
          text: approve ? '가입이 승인됐습니다.' : `가입이 반려됐습니다. ${s(b.note, 100)}`
        })
      }
      return ok({ member: r.value })
    }
  },
  '/cmty/admin/schema': {
    need: 'cmty.manageChars',
    run(b, c, d) {
      const r = d.chars.saveSchema(b.schema, c.now)
      if (r.ok) c.audit('stat.schema', `칸 ${r.value.fields.length}개`)
      return from(r, 'schema')
    }
  },
  '/cmty/admin/char/status': {
    need: 'cmty.manageChars',
    run(b, c, d) {
      const charId = s(b.charId, 64)
      const doc = d.chars.get(charId)
      const st = b.status === 'approved' || b.status === 'pending' || b.status === 'draft' || b.status === 'retired' ? b.status : 'approved'
      const r = d.chars.setStatus(charId, st, c.now)
      if (r.ok) {
        // 승인되는 그 순간에 초기 자금이 들어간다. 다시 승인해도 두 번 주지 않는다.
        if (st === 'approved') d.econ.grantInitial(charId, c.now)
        if (st === 'retired') d.econ.returnGiftsOf(charId, c.now)
        c.audit('char.status', st, { type: 'char', id: charId, name: doc?.name })
        if (doc) {
          d.notify(doc.ownerId, { kind: 'cmty', actor: d.actorOf(c.account), ref: charId, text: `${doc.name}: ${st === 'approved' ? '승인됐습니다.' : '상태가 바뀌었습니다.'}` })
          // 오너가 들고 있는 스냅샷이 낡았다고 알린다 — 승인 직후 소지품·상점이 '승인된 캐릭터가 없다'고 하지 않게.
          d.emitAccount(doc.ownerId, 'cmty:perm', { permVersion: d.community.settings()?.permVersion ?? 0 })
        }
      }
      return from(r, 'char')
    }
  },
  '/cmty/admin/char/stats': {
    need: 'cmty.manageChars',
    run(b, c, d) {
      const charId = s(b.charId, 64)
      const memo = s(b.memo, 200)
      const r = d.chars.adjustStats(charId, b.adjusts, memo, c.now)
      if (!r.ok) return fail(r.error)
      const detail = r.value.changed.map((x) => `${x.key} ${x.delta !== undefined ? (x.delta > 0 ? '+' : '') + x.delta : '= ' + x.value}`).join(', ')
      c.audit('char.stats', `${detail} (${memo})`, { type: 'char', id: charId, name: r.value.doc.name })
      // 조용한 조정을 막는다 — 대상 오너에게 반드시 알린다.
      d.notify(r.value.doc.ownerId, { kind: 'cmty', actor: d.actorOf(c.account), ref: charId, text: `${r.value.doc.name} 능력치 조정: ${detail} (${memo})` })
      return ok({ char: r.value.doc, changed: r.value.changed })
    }
  },
  '/cmty/admin/reports': {
    need: 'cmty.handleReport',
    run(b, _c, d) {
      return ok({ reports: d.posts.reports(s(b.status, 20) || undefined) })
    }
  },
  '/cmty/admin/report/resolve': {
    need: 'cmty.handleReport',
    run(b, c, d) {
      const action = b.action === 'dismissed' ? 'dismissed' : 'resolved'
      const r = d.posts.resolveReport(s(b.reportId, 64), c.account.id, action, s(b.note, 200), c.now)
      if (r.ok) c.audit('report.' + action, s(b.note, 200), { type: 'report', id: r.value.id })
      return from(r, 'report')
    }
  },
  '/cmty/admin/trash': {
    need: 'cmty.manageBoards',
    run(_b, _c, d) {
      return ok({ items: d.posts.trashList() })
    }
  },
  '/cmty/admin/audit': {
    need: 'cmty.viewAudit',
    run(b, _c, d) {
      return ok({ items: d.community.auditList(n(b.limit, 50), b.before === undefined ? undefined : n(b.before, 0)) })
    }
  }
}

const ROUTES: Record<string, Route> = { ...BOARD_ROUTES, ...ECON_ROUTES, ...GAME_ROUTES }

/**
 * 캐릭터 커뮤니티에서만 여는 길.
 * 보통(basic) 커뮤니티는 게시판만 쓰므로, 캐릭터·경제·놀이 쪽은 존재하지 않는 것으로 답한다 —
 * 화면에서 숨기는 것만으로는 손으로 빚은 요청까지 막지 못한다.
 */
const OC_ONLY = new Set<string>([
  ...Object.keys(ECON_ROUTES),
  ...Object.keys(GAME_ROUTES),
  '/cmty/char/list',
  '/cmty/char/get',
  '/cmty/char/save',
  '/cmty/char/remove',
  '/cmty/char/look',
  '/cmty/char/relation',
  '/cmty/admin/schema',
  '/cmty/admin/char/status',
  '/cmty/admin/char/stats'
])

/**
 * 커뮤니티 라우트 처리기. 이 요청을 맡았으면 true 를 돌려준다(응답까지 끝냈다는 뜻).
 * relay 의 라우트 사슬에서 '웹 정적 서빙보다 앞'에 꽂아야 한다.
 */
export function createCommunityRoutes(d: CommunityRouteDeps) {
  return function handle(req: IncomingMessage, res: ServerResponse): boolean {
    if (req.method !== 'POST' || !req.url || !req.url.startsWith('/cmty/')) return false
    const route = ROUTES[req.url]
    if (!route) return false

    void d.readJsonBody(req).then((body) => {
      const send = (r: Reply): void => {
        res.writeHead(r.status ?? 200, JSON_H)
        res.end(JSON.stringify(r.body))
      }
      const account = typeof body.token === 'string' ? d.auth.verifyToken(body.token) : null
      if (!account) return send(fail('인증이 필요합니다.', 401))
      // 서버 주인이 커뮤니티를 꺼 두면 여기서 전부 멈춘다.
      // 다만 '켜져 있나'를 묻는 길은 열어 둬야 클라가 아이콘을 감출 수 있다.
      if (!d.community.enabled() && req.url !== '/cmty/state') {
        if (req.url === '/cmty/bootstrap') return send(ok({ enabled: false, community: null, canCreate: false }))
        return send(fail('이 서버는 커뮤니티 기능을 쓰지 않습니다.', 403))
      }
      // 보통 커뮤니티에는 캐릭터·경제·놀이 길이 없다. 커뮤니티가 아직 없을 때도 같은 답을 준다.
      if (OC_ONLY.has(req.url ?? '') && d.community.settings()?.mode !== 'oc') {
        return send(fail('이 커뮤니티에서는 쓰지 않는 기능입니다.', 404))
      }
      if (route.rate === 'social' && d.socialLimited(account.id, res)) return
      if (route.rate === 'econ' && d.econLimited(account.id, res)) return

      const now = d.now()
      const isAppAdmin = account.role === 'admin'
      const member = d.community.member(account.id)
      // 권한이 게시판 단위면 스코프를 잡는다. 글에서 얻는 경우 그 글이 속한 게시판을 따라간다.
      const board =
        route.scope === 'boardId'
          ? d.community.board(s(body.boardId, 64))
          : route.scope === 'postId'
            ? boardOfPost(d, s(body.postId, 64))
            : null
      if (route.scope && !board) return send(fail('게시판을 찾을 수 없습니다.', 404))

      const base: Omit<PermCtx, 'board'> = { accountId: account.id, isAppAdmin, member, now }
      const can = (perm: PermKey, b2?: Board | null): boolean =>
        d.community.can(perm, { ...base, board: b2 === undefined ? board : b2 })

      if (route.need !== 'login') {
        if (!d.community.settings()) return send(fail('아직 커뮤니티가 없습니다.', 404))
        if (route.need === 'member') {
          if (!member) return send(fail('커뮤니티에 가입해 주세요.', 403))
        } else if (!can(route.need)) {
          return send(fail('권한이 없습니다.', 403))
        }
      }

      const ctx: Ctx = {
        account,
        member,
        isAppAdmin,
        board,
        now,
        can,
        audit: (action, detail, target) =>
          d.community.audit(
            {
              actorId: account.id,
              actorName: member?.nick || account.nickname || account.username,
              // 역할을 받지 않은 서버 주인의 개입을 구분해 남긴다.
              ...(isAppAdmin && !member ? { asAdmin: true } : {}),
              action,
              ...(detail ? { detail } : {}),
              ...(target?.type ? { targetType: target.type } : {}),
              ...(target?.id ? { targetId: target.id } : {}),
              ...(target?.name ? { targetName: target.name } : {})
            },
            now
          )
      }

      try {
        send(route.run(body, ctx, d))
      } catch (e) {
        console.error('[community] 라우트 오류:', req.url, e)
        send(fail('처리에 실패했습니다.', 500))
      }
    })
    return true
  }
}
