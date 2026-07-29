// 정규화된 본문 HTML 에서 사람이 읽는 평문을 뽑는다 — 목록 발췌·검색 색인이 함께 쓴다.
// 블로그와 커뮤니티가 같은 새니타이저를 지나온 HTML 을 다루므로 이 변환도 한 곳에 둔다.

/** 태그를 걷어내고 문자 참조를 되돌린 평문. max 자에서 자른다. */
export function htmlToText(html: string, max: number): string {
  return html
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&amp;/gi, '&') // &amp; 는 마지막에(먼저 풀면 &amp;lt; → < 로 이중 디코드)
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, max)
}
