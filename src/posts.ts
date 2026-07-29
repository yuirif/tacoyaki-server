// 블로그/게시글 저장소 — 사용자가 자기 로비에 올리는 글(게시판·태그·대표이미지·댓글·좋아요).
// 단일 파일 영속(<dataDir>/posts.json, 원자적 tmp→rename) — 계정 저장소(auth.ts)와 동일 패턴.
// 본문 HTML 은 타인이 열람하므로 저장 시 화이트리스트로 강하게 정규화한다(저장형 XSS 차단 — 보안 경계).
import { readFileSync, writeFileSync, mkdirSync, renameSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { collectAssetRefs as scanAssetRefs } from './assets'
import { htmlToText } from './htmlText'

// ===== 한도(작은 서버 보호) =====
const MAX_POSTS_PER_USER = 500
const MAX_BOARDS = 40
const MAX_BOARD_NAME = 40
const MAX_TITLE = 200
const MAX_HTML = 400_000 // 본문 HTML 길이 상한(이미지는 asset 참조라 작음 — 인라인 data 폭주 방지)
const MAX_TAGS = 12
const MAX_TAG = 30
const MAX_COMMENTS = 500 // 글당 댓글 보관 상한(초과 시 오래된 것부터)
const MAX_COMMENT = 1000
const MAX_COVER = 1_400_000 // 대표 이미지 data URL 상한(보통은 asset 참조)

// ===== 본문 HTML 새니타이저(화이트리스트) =====
// 에디터가 생성하는 서식 태그만 허용. 그 외 태그는 마커만 제거(텍스트는 보존). 위험 요소는 통째 제거.
const ALLOWED_TAGS = new Set([
  'p', 'br', 'div', 'span', 'b', 'strong', 'i', 'em', 'u', 's', 'strike',
  'blockquote', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'ul', 'ol', 'li', 'a', 'img', 'hr', 'code', 'pre',
  // 위·아래 첨자와 형광 표시 — 편집기 툴바가 내는 서식.
  // font 는 넣지 않는다 — 색·크기를 속성으로 들고 오는데 속성은 전부 걷어내므로 빈 껍데기만 남는다.
  'sub', 'sup', 'mark'
])
// 여는~닫는 태그를 통째로 제거할 위험 요소(스크립트·스타일·삽입 프레임 등).
const DROP_BLOCKS = [
  'script', 'style', 'title', 'textarea', 'noscript', 'iframe', 'object',
  'embed', 'svg', 'math', 'form', 'head', 'link', 'meta', 'base', 'button', 'input', 'select'
]
// 허용 인라인 style 속성 — 값에 url(/expression/주석/스킴 없을 때만(CSS 주입 차단).
// width/max-width=본문 이미지 크기 조절, border-color=구분선(hr) 색,
// margin/padding/border=들여쓰기(인용 블록), float/display=본문 이미지 정렬.
const ALLOWED_STYLE_PROPS = new Set([
  'text-align', 'color', 'background-color', 'font-size', 'font-weight',
  'font-style', 'text-decoration', 'font-family', 'line-height', 'letter-spacing',
  'width', 'max-width', 'height', 'border-color', 'border-top-color',
  'margin', 'margin-left', 'margin-right', 'margin-top', 'margin-bottom',
  'padding', 'padding-left', 'text-indent', 'border', 'float', 'clear',
  'display', 'vertical-align'
])
/**
 * 음수를 받아서는 안 되는 속성 — 여백을 크게 음수로 주면 본문이 글 밖으로 삐져나가
 * 다른 화면 요소를 덮는다. 글쓴이가 남의 화면을 가리는 길을 열지 않는다.
 */
const NO_NEGATIVE_PROPS = new Set([
  'margin', 'margin-left', 'margin-right', 'margin-top', 'margin-bottom',
  'padding', 'padding-left', 'text-indent', 'width', 'max-width', 'height', 'letter-spacing'
])
/** display 는 이미지 정렬(가운데=block)에만 쓴다 — 그 밖의 값은 받지 않는다. */
const DISPLAY_VALUES = new Set(['block', 'inline', 'inline-block', 'none'])

/** 속성값 이스케이프(쌍따옴표 컨텍스트). */
function escAttr(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
}

/** 링크 URL — http(s)·mailto 만(javascript:·data: 차단). 스킴 없는 도메인은 https 부여. 아니면 null. */
function safeLinkUrl(v: string): string | null {
  const s = v.trim()
  if (/^https?:\/\//i.test(s) || /^mailto:/i.test(s)) return s.slice(0, 2000)
  if (/^[\w.-]+\.[a-z]{2,}(\/|$|\?)/i.test(s)) return 'https://' + s.slice(0, 1990)
  return null
}

/** 이미지 src — asset 참조·data:image·https 만. 아니면 null. */
function safeImgUrl(v: string): string | null {
  const s = v.trim()
  if (/^asset:[a-f0-9]{64}$/i.test(s)) return s
  if (/^data:image\/[a-z0-9.+-]+[;,]/i.test(s)) return s.slice(0, MAX_COVER)
  if (/^https:\/\//i.test(s)) return s.slice(0, 2000)
  return null
}

/** 인라인 style — 허용 속성·안전한 값만 남김. */
function sanitizeStyle(v: string): string {
  const out: string[] = []
  for (const decl of v.split(';')) {
    const idx = decl.indexOf(':')
    if (idx < 0) continue
    const prop = decl.slice(0, idx).trim().toLowerCase()
    if (!ALLOWED_STYLE_PROPS.has(prop)) continue
    const value = decl.slice(idx + 1).trim()
    if (/url\s*\(|expression|javascript:|@import|\/\*|<|>/i.test(value)) continue
    // 음수 여백은 본문 밖으로 내용을 밀어 다른 화면을 덮는 데 쓰인다.
    if (NO_NEGATIVE_PROPS.has(prop) && /-\s*[\d.]/.test(value)) continue
    if (prop === 'display' && !DISPLAY_VALUES.has(value.toLowerCase())) continue
    const clean = value.slice(0, 120).replace(/["']/g, '')
    if (clean) out.push(`${prop}: ${clean}`)
  }
  return out.join('; ')
}

/** 태그별 허용 속성만 재구성(on* 핸들러·class·임의 속성 전부 차단). */
function sanitizeAttrs(tag: string, raw: string): string {
  const out: string[] = []
  const re = /([a-zA-Z_:][\w:.-]*)\s*=\s*("([^"]*)"|'([^']*)'|([^\s"'>]+))/g
  let m: RegExpExecArray | null
  while ((m = re.exec(raw))) {
    const attr = m[1].toLowerCase()
    const val = m[3] ?? m[4] ?? m[5] ?? ''
    if (attr.startsWith('on')) continue // 이벤트 핸들러 차단
    if (tag === 'a' && attr === 'href') {
      const u = safeLinkUrl(val)
      // 링크는 항상 새 창(target=_blank) — Electron 메인 창이 통째로 외부 URL 로 이동하는 것 방지(창 열기 핸들러가 외부 브라우저로 전달).
      if (u) out.push(`href="${escAttr(u)}" target="_blank" rel="noopener noreferrer"`)
    } else if (tag === 'img' && attr === 'src') {
      const u = safeImgUrl(val)
      if (u) out.push(`src="${escAttr(u)}"`)
    } else if (tag === 'img' && attr === 'alt') {
      out.push(`alt="${escAttr(val.slice(0, 120))}"`)
    } else if (attr === 'style') {
      const s = sanitizeStyle(val)
      if (s) out.push(`style="${escAttr(s)}"`)
    }
    // 그 외 속성(class·id·data-*·target 등)은 전부 차단(주입 표면 최소화).
  }
  return out.length ? ' ' + out.join(' ') : ''
}

/**
 * 정규화 결과 길이의 하드 상한. 입력은 이미 MAX_HTML 로 자르지만, 아래에서 남은 '<' 를 '&lt;' 로 바꾸므로
 * 최악(전부 '<')에는 4배까지 늘 수 있다. 토큰 경계에서만 끊어 태그가 반토막 나지 않게 한다.
 */
const MAX_HTML_OUT = MAX_HTML * 2

/** 태그로 해석되지 않은 잔여 '<' 를 무해한 문자로. 이미 재작성된 허용 태그에는 닿지 않는다(조각 단위로만 호출). */
function escapeLooseLt(s: string): string {
  return s.replace(/</g, '&lt;')
}

/** 본문 HTML 을 화이트리스트로 정규화 — 저장 전 1회. 타인 열람용이라 저장형 XSS 의 유일한 차단막. */
export function sanitizePostHtml(input: unknown): string {
  if (typeof input !== 'string') return ''
  // 길이 제한은 '들어올 때' 한 번만 건다. 정규화가 끝난 뒤에 자르면 안전하게 재작성된 태그가
  // 절단면에서 다시 미종료 태그가 되어, 렌더 시 뒤따르는 마크업이 속성으로 빨려 들어간다.
  let html = input.slice(0, MAX_HTML)
  // 1) 주석·CDATA 제거.
  html = html.replace(/<!--[\s\S]*?-->/g, '')
  // 2) 위험 블록 통째 제거(여는~닫는). 닫힘 없는 잔여 여는/닫는 태그도 제거.
  for (const t of DROP_BLOCKS) {
    html = html.replace(new RegExp(`<${t}\\b[\\s\\S]*?<\\/${t}\\s*>`, 'gi'), '')
    html = html.replace(new RegExp(`<${t}\\b[^>]*>`, 'gi'), '')
    html = html.replace(new RegExp(`<\\/${t}\\s*>`, 'gi'), '')
  }
  // 3) 태그 단위 재작성 — 비허용 태그는 마커 제거(내부 텍스트 보존), 허용 태그는 속성 정규화.
  //    태그 사이 조각은 이스케이프한다. '>' 로 닫히지 않은 조각(예: '<img src=x onerror=…' 처럼 끝이 잘린 것)은
  //    태그로 매칭되지 않아 이 조각에 남으므로, 여기서 함께 무해해진다.
  const tagRe = /<(\/?)([a-zA-Z][a-zA-Z0-9]*)\b([^>]*)>/g
  let out = ''
  let last = 0
  let m: RegExpExecArray | null
  while ((m = tagRe.exec(html))) {
    out += escapeLooseLt(html.slice(last, m.index))
    last = tagRe.lastIndex
    const name = m[2].toLowerCase()
    if (ALLOWED_TAGS.has(name)) {
      out += m[1] ? `</${name}>` : `<${name}${sanitizeAttrs(name, m[3])}>`
    }
    if (out.length > MAX_HTML_OUT) return out // 토큰 경계 — 태그가 쪼개지지 않는다
  }
  out += escapeLooseLt(html.slice(last))
  // 여기까지 왔다면 초과분은 전부 마지막 텍스트 조각에서 나온 것이다(태그를 붙일 때마다 위에서 검사했으므로).
  // 텍스트를 자르는 것은 주입 위험이 없다 — 반쪽으로 잘린 문자 참조만 정리한다.
  if (out.length > MAX_HTML_OUT) out = out.slice(0, MAX_HTML_OUT).replace(/&[a-z]{0,3}$/i, '')
  return out
}

/** 본문에서 평문 발췌(목록 표시용). */
function excerptOf(html: string): string {
  return htmlToText(html, 140)
}

// ===== 모델 =====
export interface Board {
  id: string
  name: string
}
export interface PostComment {
  id: string
  authorId: string
  authorName: string
  authorAvatar?: string
  text: string
  createdAt: number
  updatedAt?: number
  /** 답글이면 부모(최상위) 댓글 id. 1단 깊이만 — 답글의 답글은 같은 부모에 매달린다. 기존 댓글엔 없음(=최상위). */
  parentId?: string
}
export interface Post {
  id: string
  authorId: string
  boardId: string
  tags: string[]
  title: string
  html: string
  cover?: string
  visibility: 'public' | 'private'
  draft: boolean
  createdAt: number
  updatedAt: number
  likes: string[]
  comments: PostComment[]
}
/** 목록 표시용 요약(본문 제외 — 가벼움). */
export interface PostSummary {
  id: string
  authorId: string
  boardId: string
  tags: string[]
  title: string
  cover?: string
  excerpt: string
  visibility: 'public' | 'private'
  draft: boolean
  createdAt: number
  updatedAt: number
  likeCount: number
  commentCount: number
}
/** 상세 보기(본문·댓글 포함, 좋아요는 수+내가 눌렀는지). */
export interface PostDetail {
  id: string
  authorId: string
  boardId: string
  tags: string[]
  title: string
  html: string
  cover?: string
  visibility: 'public' | 'private'
  draft: boolean
  createdAt: number
  updatedAt: number
  likeCount: number
  comments: PostComment[]
}

export interface PostInput {
  id?: string
  boardId?: string
  tags?: unknown
  title?: string
  html?: string
  cover?: string
  visibility?: string
  draft?: boolean
}

export type PostSaveResult = { ok: true; post: PostDetail } | { ok: false; error: string }

export interface PostStore {
  /** target 의 글 목록 + 게시판. viewerId===target 이면 비공개·임시저장 포함, 아니면 공개·비임시만. */
  listFor(viewerId: string | null, targetId: string): { posts: PostSummary[]; boards: Board[] }
  /** 글 상세 — 비공개/임시저장은 작성자만. 권한 없으면 null. */
  get(viewerId: string | null, postId: string): { post: PostDetail; liked: boolean } | null
  /** 작성/수정(작성자) — id 있고 소유면 수정, 아니면 새 글. */
  save(authorId: string, input: PostInput): PostSaveResult
  /** 글 삭제(작성자). 삭제했으면 true. */
  remove(authorId: string, postId: string): boolean
  /** 좋아요 토글(로그인 누구나). 대상 열람 권한 있을 때만. */
  toggleLike(userId: string, postId: string): { liked: boolean; count: number } | null
  /** 댓글 작성(로그인 누구나) — 작성자 표시정보는 스냅샷. parentId 가 유효한 최상위 댓글이면 답글로.
   *  반환에 글 메타(주인·제목)와 부모 작성자를 동봉 — 호출부(알림 생성)가 재조회 없이 쓴다. */
  addComment(
    author: { id: string; name: string; avatar?: string },
    postId: string,
    text: string,
    parentId?: string
  ): { comment: PostComment; post: { id: string; authorId: string; title: string }; parentAuthorId?: string } | null
  /** 댓글 수정(댓글 작성자만). */
  editComment(userId: string, postId: string, commentId: string, text: string): PostComment | null
  /** 댓글 삭제(댓글 작성자 또는 글 주인). */
  removeComment(userId: string, postId: string, commentId: string): boolean
  /** 게시판 목록 교체(작성자) — 사라진 게시판의 글은 미분류('')로. */
  setBoards(userId: string, boards: unknown): Board[]
  /** 계정 탈퇴 연쇄 — 그 사용자의 글·게시판 제거 + 타인 글에 남긴 댓글/좋아요 제거. */
  removeAll(userId: string): void
  /** 관리자 용량 산출 — 그 사용자의 글·게시판 직렬화 바이트 + 참조 자산 해시(글 개수 포함). */
  usageFor(userId: string): { count: number; bytes: number; refs: Set<string> }
  /** 멤버 본인 이전 — 그 사용자의 글·게시판 전체를 깊은 복사로 내보낸다(다른 서버로 이전용). */
  exportFor(accountId: string): { posts: Post[]; boards: Board[] }
  /** 멤버 본인 이전(가져오기) — 내보낸 글·게시판을 이 계정 소유로 복원(새 글 id·본문 재새니타이즈). 복원 글 수 반환. */
  importFor(accountId: string, posts: unknown, boards: unknown): number
  /** 자산 GC 라이브 집합 수집(본문·대표이미지의 'asset:<해시>'). */
  collectAssetRefs(into: Set<string>): void
}

interface PersistShape {
  posts: Post[]
  boards: Record<string, Board[]>
}

/** 태그 배열 정규화 — 트림·중복 제거·길이/개수 캡. */
function sanitizeTags(v: unknown): string[] {
  if (!Array.isArray(v)) return []
  const out: string[] = []
  const seen = new Set<string>()
  for (const t of v) {
    if (typeof t !== 'string') continue
    const tag = t.trim().replace(/^#/, '').slice(0, MAX_TAG)
    if (!tag || seen.has(tag.toLowerCase())) continue
    seen.add(tag.toLowerCase())
    out.push(tag)
    if (out.length >= MAX_TAGS) break
  }
  return out
}

/** persist:false 면 인메모리(테스트). dataDir 기본 = <cwd>/data. */
export function createPostStore(opts?: { dataDir?: string; persist?: boolean }): PostStore {
  const persist = opts?.persist !== false
  const dataDir = opts?.dataDir ?? join(process.cwd(), 'data')
  const filePath = join(dataDir, 'posts.json')

  let posts: Post[] = []
  let boards: Record<string, Board[]> = {}

  if (persist) {
    try {
      if (existsSync(filePath)) {
        const data = JSON.parse(readFileSync(filePath, 'utf8')) as PersistShape
        if (Array.isArray(data.posts)) posts = data.posts
        if (data.boards && typeof data.boards === 'object') boards = data.boards
      }
    } catch (e) {
      console.error('[posts] posts.json 로드 실패 — 빈 목록으로 시작:', e)
    }
  }

  function save(): void {
    if (!persist) return
    try {
      mkdirSync(dataDir, { recursive: true })
      const tmp = filePath + '.tmp'
      writeFileSync(tmp, JSON.stringify({ posts, boards }), 'utf8')
      renameSync(tmp, filePath)
    } catch (e) {
      console.error('[posts] 저장 실패:', e)
    }
  }

  const findPost = (id: string): Post | undefined => posts.find((p) => p.id === id)
  const boardsOf = (userId: string): Board[] => boards[userId] ?? []

  /** viewer 가 글을 열람할 수 있는지(공개·비임시이거나 작성자). */
  const canView = (viewerId: string | null, p: Post): boolean =>
    viewerId === p.authorId || (p.visibility === 'public' && !p.draft)

  const summarize = (p: Post): PostSummary => ({
    id: p.id,
    authorId: p.authorId,
    boardId: p.boardId,
    tags: p.tags,
    title: p.title,
    cover: p.cover,
    excerpt: excerptOf(p.html),
    visibility: p.visibility,
    draft: p.draft,
    createdAt: p.createdAt,
    updatedAt: p.updatedAt,
    likeCount: p.likes.length,
    commentCount: p.comments.length
  })
  const detail = (p: Post): PostDetail => ({
    id: p.id,
    authorId: p.authorId,
    boardId: p.boardId,
    tags: p.tags,
    title: p.title,
    html: p.html,
    cover: p.cover,
    visibility: p.visibility,
    draft: p.draft,
    createdAt: p.createdAt,
    updatedAt: p.updatedAt,
    likeCount: p.likes.length,
    comments: p.comments
  })

  return {
    listFor(viewerId, targetId) {
      if (!targetId) return { posts: [], boards: [] }
      const isOwner = viewerId === targetId
      const list = posts
        .filter((p) => p.authorId === targetId && (isOwner || (p.visibility === 'public' && !p.draft)))
        .sort((a, b) => b.createdAt - a.createdAt)
        .map(summarize)
      return { posts: list, boards: boardsOf(targetId) }
    },

    get(viewerId, postId) {
      const p = findPost(postId)
      if (!p || !canView(viewerId, p)) return null
      return { post: detail(p), liked: !!viewerId && p.likes.includes(viewerId) }
    },

    save(authorId, input) {
      if (!authorId) return { ok: false, error: '로그인이 필요합니다.' }
      const title = typeof input.title === 'string' ? input.title.trim().slice(0, MAX_TITLE) : ''
      const html = sanitizePostHtml(input.html)
      const tags = sanitizeTags(input.tags)
      // 빈 본문 판정 — 태그 제거 + &nbsp; 정규화 후 평문이 비고 제목도 없으면 거부. 이미지 단독 글은 허용.
      const bodyText = html.replace(/<[^>]+>/g, '').replace(/&nbsp;/gi, ' ').trim()
      if (!title && !bodyText && !/<img\b/i.test(html)) return { ok: false, error: '제목이나 내용을 입력하세요.' }
      const visibility = input.visibility === 'private' ? 'private' : 'public'
      const draft = input.draft === true
      const cover = typeof input.cover === 'string' && input.cover ? safeImgUrl(input.cover) ?? undefined : undefined
      // 게시판 — 작성자의 게시판 목록에 있는 id 만 인정(없으면 미분류).
      const boardId =
        typeof input.boardId === 'string' && boardsOf(authorId).some((b) => b.id === input.boardId)
          ? input.boardId
          : ''
      const now = Date.now()

      if (input.id) {
        const p = findPost(input.id)
        if (!p) return { ok: false, error: '글을 찾을 수 없습니다.' }
        if (p.authorId !== authorId) return { ok: false, error: '수정 권한이 없습니다.' }
        p.title = title
        p.html = html
        p.tags = tags
        p.visibility = visibility
        p.draft = draft
        p.cover = cover
        p.boardId = boardId
        p.updatedAt = now
        save()
        return { ok: true, post: detail(p) }
      }

      // 새 글 — 사용자별 보관 상한(초과 시 가장 오래된 본인 글 제거).
      const mine = posts.filter((p) => p.authorId === authorId)
      if (mine.length >= MAX_POSTS_PER_USER) {
        const oldest = mine.sort((a, b) => a.createdAt - b.createdAt)[0]
        posts = posts.filter((p) => p.id !== oldest.id)
      }
      const post: Post = {
        id: randomUUID(),
        authorId,
        boardId,
        tags,
        title,
        html,
        cover,
        visibility,
        draft,
        createdAt: now,
        updatedAt: now,
        likes: [],
        comments: []
      }
      posts.push(post)
      save()
      return { ok: true, post: detail(post) }
    },

    remove(authorId, postId) {
      const p = findPost(postId)
      if (!p || p.authorId !== authorId) return false
      posts = posts.filter((x) => x.id !== postId)
      save()
      return true
    },

    toggleLike(userId, postId) {
      if (!userId) return null
      const p = findPost(postId)
      if (!p || !canView(userId, p)) return null
      const i = p.likes.indexOf(userId)
      let liked: boolean
      if (i >= 0) {
        p.likes.splice(i, 1)
        liked = false
      } else {
        p.likes.push(userId)
        liked = true
      }
      save()
      return { liked, count: p.likes.length }
    },

    addComment(author, postId, text, parentId) {
      if (!author?.id) return null
      const p = findPost(postId)
      if (!p || !canView(author.id, p)) return null
      const msg = (text ?? '').trim().slice(0, MAX_COMMENT)
      if (!msg) return null
      // 답글 검증 — 같은 글의 '최상위' 댓글만 부모가 될 수 있다(1단 깊이 강제). 무효하면 최상위 댓글로 저장.
      const parent =
        typeof parentId === 'string' && parentId
          ? p.comments.find((x) => x.id === parentId && !x.parentId)
          : undefined
      const comment: PostComment = {
        id: randomUUID(),
        authorId: author.id,
        authorName: (author.name || '익명').slice(0, 60),
        authorAvatar: author.avatar,
        text: msg,
        createdAt: Date.now(),
        ...(parent ? { parentId: parent.id } : {})
      }
      p.comments.push(comment)
      if (p.comments.length > MAX_COMMENTS) p.comments.splice(0, p.comments.length - MAX_COMMENTS)
      save()
      return {
        comment,
        post: { id: p.id, authorId: p.authorId, title: p.title },
        parentAuthorId: parent?.authorId
      }
    },

    editComment(userId, postId, commentId, text) {
      const p = findPost(postId)
      if (!p || !canView(userId, p)) return null // 글을 볼 수 없으면(비공개 전환 등) 댓글 수정도 불가
      const c = p.comments.find((x) => x.id === commentId)
      if (!c || c.authorId !== userId) return null // 본인 댓글만 수정
      const msg = (text ?? '').trim().slice(0, MAX_COMMENT)
      if (!msg) return null
      c.text = msg
      c.updatedAt = Date.now()
      save()
      return c
    },

    removeComment(userId, postId, commentId) {
      const p = findPost(postId)
      if (!p || !canView(userId, p)) return false // 글을 볼 수 없으면 댓글 삭제도 불가(글 주인은 canView 통과)
      const c = p.comments.find((x) => x.id === commentId)
      if (!c) return false
      // 댓글 작성자 또는 글 주인만 삭제.
      if (c.authorId !== userId && p.authorId !== userId) return false
      // 부모 댓글을 지우면 매달린 답글도 함께 제거(부모 없는 답글 잔존 방지).
      p.comments = p.comments.filter((x) => x.id !== commentId && x.parentId !== commentId)
      save()
      return true
    },

    setBoards(userId, input) {
      if (!userId) return []
      const out: Board[] = []
      const seen = new Set<string>()
      if (Array.isArray(input)) {
        for (const b of input as Record<string, unknown>[]) {
          if (out.length >= MAX_BOARDS) break
          if (!b || typeof b !== 'object') continue
          const name = typeof b.name === 'string' ? b.name.trim().slice(0, MAX_BOARD_NAME) : ''
          if (!name) continue
          const id = typeof b.id === 'string' && /^[\w-]{1,64}$/.test(b.id) ? b.id : randomUUID()
          if (seen.has(id)) continue
          seen.add(id)
          out.push({ id, name })
        }
      }
      boards[userId] = out
      // 사라진 게시판을 참조하던 글은 미분류로.
      const validIds = new Set(out.map((b) => b.id))
      for (const p of posts) {
        if (p.authorId === userId && p.boardId && !validIds.has(p.boardId)) p.boardId = ''
      }
      save()
      return out
    },

    removeAll(userId) {
      if (!userId) return
      let changed = false
      const before = posts.length
      posts = posts.filter((p) => p.authorId !== userId)
      if (posts.length !== before) changed = true
      // 타인 글에 남긴 이 사용자의 댓글·좋아요 제거. 지워진 부모에 매달린 답글도 함께 정리(고아 방지).
      for (const p of posts) {
        const cl = p.comments.length
        const removedIds = new Set(p.comments.filter((c) => c.authorId === userId).map((c) => c.id))
        p.comments = p.comments.filter((c) => c.authorId !== userId && !(c.parentId && removedIds.has(c.parentId)))
        if (p.comments.length !== cl) changed = true
        const li = p.likes.indexOf(userId)
        if (li >= 0) {
          p.likes.splice(li, 1)
          changed = true
        }
      }
      if (boards[userId]) {
        delete boards[userId]
        changed = true
      }
      if (changed) save()
    },

    usageFor(userId) {
      const mine = posts.filter((p) => p.authorId === userId)
      const payload = { posts: mine, boards: boards[userId] ?? [] }
      const json = JSON.stringify(payload)
      const refs = new Set<string>()
      scanAssetRefs(json, refs)
      return { count: mine.length, bytes: Buffer.byteLength(json, 'utf8'), refs }
    },

    exportFor(accountId) {
      if (!accountId) return { posts: [], boards: [] }
      return {
        posts: posts
          .filter((p) => p.authorId === accountId)
          .map((p) => ({ ...p, tags: [...p.tags], likes: [...p.likes], comments: p.comments.map((c) => ({ ...c })) })),
        boards: boardsOf(accountId).map((b) => ({ ...b }))
      }
    },

    importFor(accountId, inPosts, inBoards) {
      if (!accountId) return 0
      // 게시판 먼저 복원(원본 id 유지 — 글의 boardId 가 매칭되게). 정규화·개수 캡.
      if (Array.isArray(inBoards)) {
        const out: Board[] = []
        const seen = new Set<string>()
        for (const b of inBoards as Record<string, unknown>[]) {
          if (out.length >= MAX_BOARDS) break
          if (!b || typeof b !== 'object') continue
          const name = typeof b.name === 'string' ? b.name.trim().slice(0, MAX_BOARD_NAME) : ''
          if (!name) continue
          const id = typeof b.id === 'string' && /^[\w-]{1,64}$/.test(b.id) ? b.id : randomUUID()
          if (seen.has(id)) continue
          seen.add(id)
          out.push({ id, name })
        }
        if (out.length > 0) boards[accountId] = out // 빈 배열로 기존 게시판을 통째로 지우지 않게(부분 번들 보호)
      }
      let imported = 0
      if (Array.isArray(inPosts)) {
        for (const raw of inPosts as Record<string, unknown>[]) {
          if (posts.filter((p) => p.authorId === accountId).length >= MAX_POSTS_PER_USER) break
          if (!raw || typeof raw !== 'object') continue
          const now = Date.now()
          // 댓글은 타인 작성이라 표시용 스냅샷(작성자 id 는 새 서버에서 의미 없지만 닉·아바타로 표시).
          const comments: PostComment[] = []
          if (Array.isArray(raw.comments)) {
            for (const c of (raw.comments as Record<string, unknown>[]).slice(-MAX_COMMENTS)) {
              if (!c || typeof c !== 'object') continue
              const text = typeof c.text === 'string' ? c.text.slice(0, MAX_COMMENT) : ''
              if (!text) continue
              comments.push({
                id: typeof c.id === 'string' ? c.id.slice(0, 64) : randomUUID(),
                authorId: typeof c.authorId === 'string' ? c.authorId.slice(0, 64) : '',
                authorName: typeof c.authorName === 'string' ? c.authorName.slice(0, 60) : '익명',
                authorAvatar: typeof c.authorAvatar === 'string' ? c.authorAvatar.slice(0, 1_000_000) : undefined,
                text,
                createdAt: typeof c.createdAt === 'number' ? c.createdAt : now,
                ...(typeof c.updatedAt === 'number' ? { updatedAt: c.updatedAt } : {}),
                // 답글 관계 보존(댓글 id 는 원본 유지라 그대로 유효). 부모 미존재 시 렌더가 최상위 폴백.
                ...(typeof c.parentId === 'string' ? { parentId: c.parentId.slice(0, 64) } : {})
              })
            }
          }
          const post: Post = {
            id: randomUUID(), // 새 글 id(충돌 회피)
            authorId: accountId, // 가져오는 계정으로 재귀속
            boardId: typeof raw.boardId === 'string' ? raw.boardId.slice(0, 64) : '',
            tags: sanitizeTags(raw.tags),
            title: typeof raw.title === 'string' ? raw.title.slice(0, MAX_TITLE) : '',
            html: sanitizePostHtml(raw.html), // 본문 재새니타이즈(저장형 XSS 차단 유지)
            cover: typeof raw.cover === 'string' ? (safeImgUrl(raw.cover) ?? undefined) : undefined,
            visibility: raw.visibility === 'private' ? 'private' : 'public',
            draft: raw.draft === true,
            createdAt: typeof raw.createdAt === 'number' ? raw.createdAt : now,
            updatedAt: typeof raw.updatedAt === 'number' ? raw.updatedAt : now,
            // 좋아요는 타 서버 userId 라 표시용(스냅샷). 길이만 캡.
            likes: Array.isArray(raw.likes)
              ? (raw.likes as unknown[]).filter((x): x is string => typeof x === 'string').slice(0, 100000)
              : [],
            comments
          }
          posts.push(post)
          imported++
        }
      }
      save()
      return imported
    },

    collectAssetRefs(into) {
      scanAssetRefs(JSON.stringify(posts), into)
    }
  }
}
