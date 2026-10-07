import{K as L}from"./index-DLwZOjxA.js";function s(e){return String(e).replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;").replace(/"/g,"&quot;")}function m(e){return String(e).padStart(2,"0")}function h(e){const t=new Date(e);return`${t.getFullYear()}-${m(t.getMonth()+1)}-${m(t.getDate())} ${m(t.getHours())}:${m(t.getMinutes())}`}function W(e,t){return t?e.slice():e.filter(n=>!n.secret&&!n.to)}function F(e,t){return e.kind==="system"||t.allChannels?!0:e.channel===t.channel&&(t.channel!=="group"||e.groupId===t.groupId)}function O(e,t){return t.size===0?!1:e.kind==="system"||t.has(L(e.channel,e.groupId))}function f(e){return String(e).replace(/\\/g,"\\\\").replace(/"/g,'\\"')}function M(e,t){const n=`#${e}`;let o=`${n} .tkbx-r{position:absolute;width:0;height:0;opacity:0;pointer-events:none}
${n} .tkbx-tabs{display:flex;flex-wrap:wrap;gap:6px;width:var(--chat-w,346px);max-width:100%;margin:0 auto 14px;padding:0 2px 13px;border-bottom:1px solid var(--line,rgba(127,127,127,.25))}
${n} .tkbx-tab{display:inline-flex;align-items:center;gap:6px;padding:6px 12px;border-radius:999px;border:1px solid var(--line,rgba(127,127,127,.3));background:var(--bg3,rgba(127,127,127,.08));color:var(--tx2,#8a90a0);font-size:12px;font-weight:700;line-height:1.2;cursor:pointer;user-select:none}
${n} .tkbx-tab:hover{border-color:var(--accent,#7c9cff)}
${n} .tkbx-n{font-size:11px;font-weight:600;opacity:.7}
`;o+=`${n} .tkbx-panes .log{padding-top:2px}
${n} .tkbx-panes .msg .who{margin-bottom:5px;line-height:1.6}
${n} .tkbx-panes .msg-chan{margin:0 3px 0 7px;padding:2px 8px;border-radius:999px;font-weight:700;background:rgba(127,127,127,.22);color:var(--tx2,#8a90a0)}
`;for(const[r,a]of t.entries()){const c=`${e}-t${r}`;o+=`${n} #${c}:checked~.tkbx-tabs label[for="${f(c)}"]{background:var(--accent,#7c9cff);border-color:var(--accent,#7c9cff);color:#fff}
`,a.key&&(o+=`${n} #${c}:checked~.tkbx-panes .log>[data-tab]:not([data-tab="${f(a.key)}"]):not([data-tab="system"]){display:none}
${n} #${c}:checked~.tkbx-panes .msg-chan{display:none}
`)}return o}function $(e,t,n){const o=t.map((a,c)=>`<input class="tkbx-r" type="radio" name="${s(e)}" id="${s(e)}-t${c}"${c===0?" checked":""}>`).join(""),r=t.map((a,c)=>`<label class="tkbx-tab" for="${s(e)}-t${c}">${s(a.label)}<span class="tkbx-n">${a.count.toLocaleString()}</span></label>`).join("");return`<div class="tkbx-log" id="${s(e)}">${o}<div class="tkbx-tabs">${r}</div><div class="tkbx-panes">${n}</div></div>`}const j=`
/* 페이지 여백 0 — @page 여백 영역은 항상 종이색(흰색)이라 칠할 수 없으므로, 0으로 해
   루트(html) 배경이 페이지 전체를 가득 채우게(흰 여백 밴드 제거 · 페이지 사이 배경 연속). */
@page { margin: 0; }
/* 모든 요소의 색·배경을 인쇄에 그대로 — 브라우저가 배경을 빼지 않게(다크/라이트 테마 배경이 PDF 에 반영). */
*, *::before, *::after { -webkit-print-color-adjust: exact !important; print-color-adjust: exact !important; animation: none !important; transition: none !important; }
/* 앱 전역 CSS 의 height:100% · overflow:hidden · zoom 을 해제(안 하면 1페이지에서 잘림). */
html, body { margin: 0 !important; padding: 0 !important; height: auto !important; min-height: 0 !important; overflow: visible !important; zoom: 1 !important; }
/* 페이지 배경(여백 제외 캔버스)=테마 배경색 — html 에도 칠해 본문이 짧아도 흰 여백이 안 보이게(다크 테마면 어둡게). */
html { background: var(--bg2, var(--bg, #0e1220)); }
body {
  background: var(--bg2, var(--bg, #0e1220));
  color: var(--tx, #e8eaf0);
  font-family: var(--font-ui, 'Malgun Gothic','Apple SD Gothic Neo','Noto Sans KR',sans-serif);
  background-attachment: initial;
}
/* 채팅 패널 — 화면 폭 그대로, 가운데 정렬, 스크롤/테두리 해제 */
.pdf-chat { width: var(--chat-w, 346px); max-width: 100%; margin: 14px auto 0; border: 0 !important; background: transparent !important; }
.pdf-chat .log {
  display: flex; flex-direction: column;
  height: auto !important; max-height: none !important; min-height: 0 !important;
  overflow: visible !important; flex: none !important;
}
/* 카드(주사위·행운·선택지·광기)만 페이지 경계에서 자르지 않음. 일반 채팅/지문은 연속 흐름시켜
   페이지 하단의 빈 세로 여백을 최소화(채팅 로그가 끊김 없이 이어져 보이게). */
.dcard-ed, .dcard-med, .dcard-tkt, .dcard-cjk, .dice, .choice-card, .luck-result, .luck-card, .madness-card {
  page-break-inside: avoid; break-inside: avoid;
}
/* 인쇄에 불필요한 상호작용 UI 숨김(복제본에 남아도 안전망). .log-more=「이전 대화 더 보기/최근 N개만 보기」 알약 버튼. */
.msg-actions, .chat-resizer, .typing-ind, .msg-edit, .log-more { display: none !important; }
/* 머리말·꼬리말(테마색 사용) — 제목(=방 이름) 가운데 + 강조색, 날짜도 가운데. */
.pdf-head { width: var(--chat-w, 346px); max-width: 100%; margin: 0 auto; padding: 10px 8px 6px; text-align: center; }
.pdf-head h1 { font-size: 20px; margin: 0 0 3px; color: var(--accent, var(--tx, #e8eaf0)); }
.pdf-head .sub { font-size: 11px; color: var(--tx3, #8a90a0); }
.pdf-foot { width: var(--chat-w, 346px); max-width: 100%; margin: 14px auto 0; padding: 8px 8px 12px; border-top: 1px solid var(--line, rgba(127,127,127,0.3)); color: var(--tx3, #888); font-size: 10px; text-align: center; }
`;function H(e){const{logHtml:t,css:n,themeAttrs:o,rootStyle:r,baseHref:a,meta:c,count:l,dedupCss:i,tabsCss:d}=e,u=h(c.exportedAt),p=a?`<base href="${s(a)}">`:"",b=i?`
<style>${i}</style>`:"",g=d?`
<style>${d}</style>`:"";return`<!doctype html>
<html${o}${r?` style="${s(r)}"`:""}>
<head><meta charset="utf-8"><title>${s(c.title)}</title>
${p}
<style>${n}</style>
<style>${j}</style>${b}${g}
</head>
<body>
<div class="pdf-head">
  <h1>${s(c.title)}</h1>
  <div class="sub">${u}</div>
</div>
<div class="chat pdf-chat">${t}</div>
<div class="pdf-foot">${s(c.title)} · 생성 ${h(c.exportedAt)} · 총 ${l}건</div>
</body></html>`}function x(){let e="";for(const t of Array.from(document.styleSheets))try{const n=t.cssRules;if(!n)continue;for(const o of Array.from(n))e+=o.cssText+`
`}catch{}return e}function D(e){const t=new Map,n=[];return{classes:e.map(r=>{let a=t.get(r);return a===void 0&&(a=t.size,t.set(r,a),n.push(`.cav-${a}{background-image:url("${r}")}`)),`cav-${a}`}),css:n.join("")}}const I=/^url\((['"]?)(data:image\/(?:png|jpe?g|webp|gif|bmp|avif);base64,[A-Za-z0-9+/=]+)\1\)$/;function y(e){const t=[];if(e.querySelectorAll('[style*="background-image"]').forEach(r=>{const a=I.exec(r.style.backgroundImage.trim());a&&t.push({el:r,uri:a[2]})}),t.length===0)return"";const{classes:n,css:o}=D(t.map(r=>r.uri));return t.forEach((r,a)=>{r.el.style.removeProperty("background-image"),r.el.classList.add(n[a])}),o}function U(e,t,n){var a;const o=document.implementation.createHTMLDocument(""),r=o.documentElement;return t.theme&&r.setAttribute("data-theme",t.theme),t.accent&&r.setAttribute("data-accent",t.accent),n&&r.setAttribute("style",n),o.body.innerHTML='<div class="pdf-head"><h1></h1><div class="sub"></div></div><div class="chat pdf-chat"></div><div class="pdf-foot"></div>',(a=o.querySelector(".pdf-chat"))==null||a.appendChild(o.importNode(e,!0)),o}function B(e,t){try{return!!t.querySelector(e)||t.documentElement.matches(e)}catch{return!0}}function v(e,t){return e.split(",").map(n=>{const o=n.trim();if(!o)return o;const r=/^(html|:root|body)\b/i;if(r.test(o)){const a=o.replace(r,"").trim();return a?a.startsWith(":")||a.startsWith("[")?`${t}${a}`:`${t} ${a}`:t}return/^\[data-(theme|accent|mobile)/.test(o)?`${t}${o}`:`${t} ${o}`}).join(",")}function k(e,t,n){var r;let o="";for(const a of e){const c=a;if(typeof c.selectorText=="string"){if(!B(c.selectorText,t))continue;n?o+=`${v(c.selectorText,n)}{${((r=c.style)==null?void 0:r.cssText)??""}}`:o+=a.cssText}else if(c.cssRules&&(c.media||typeof c.conditionText=="string")){const l=k(Array.from(c.cssRules),t,n);l&&(o+=`${c.media?`@media ${c.media.mediaText}`:`@supports ${c.conditionText}`}{${l}}`)}else o+=a.cssText}return o}function w(e,t,n,o){try{const r=U(e,t,n);let a="";for(const c of Array.from(document.styleSheets)){let l=null;try{l=c.cssRules}catch{continue}l&&(a+=k(Array.from(l),r,o))}return a||x()}catch{return x()}}function S(e,t){const n=e.cloneNode(!0);if(n.querySelectorAll(".msg-actions, .msg-edit, .chat-resizer, .typing-ind, .log-more, .log-more-err").forEach(o=>o.remove()),n.querySelectorAll('img[loading="lazy"]').forEach(o=>o.setAttribute("loading","eager")),t.includePrivate||n.querySelectorAll(".priv").forEach(o=>o.remove()),t.tabs){const o=new Set(t.tabs.map(r=>r.key).filter(Boolean));o.add("system");for(const r of Array.from(n.children))o.has(r.dataset.tab??"")||r.remove()}return n}function A(e,t){if(!t||t.length<2)return null;const n=t.filter(c=>e.querySelector(`[data-tab="${f(c.key)}"]`));if(n.length<2)return null;const o=[{key:"",label:"전체"},...n],r=o.map(c=>({...c,count:c.key?e.querySelectorAll(`[data-tab="${f(c.key)}"]`).length:e.childElementCount})),a="tkbxlog"+Math.random().toString(36).slice(2,9);return{uid:a,tabs:r,css:M(a,o)}}function G(e,t){const n=S(e,t),o=n.childElementCount,r=y(n),a=t.tabBar===!1?null:A(n,t.tabs),c=document.documentElement,l={theme:c.getAttribute("data-theme"),accent:c.getAttribute("data-accent")},i=["data-theme","data-accent"].map(u=>{const p=c.getAttribute(u);return p?` ${u}="${s(p)}"`:""}).join(""),d=`${c.getAttribute("style")??""}; --chat-w:${Math.max(240,Math.round(t.chatWidth||346))}px`;return H({logHtml:a?$(a.uid,a.tabs,n.outerHTML):n.outerHTML,css:w(n,l,d),dedupCss:r,tabsCss:a==null?void 0:a.css,themeAttrs:i,rootStyle:d,baseHref:document.baseURI,meta:t,count:o})}function q(){const e=getComputedStyle(document.documentElement),t=[];for(const n of Array.from(e)){if(!n.startsWith("--"))continue;const o=e.getPropertyValue(n).trim();o&&t.push(`${n}:${o}`)}return t.join(";")}function _(e,t){const n=S(e,t),o=n.childElementCount,r=y(n),a=t.tabBar===!1?null:A(n,t.tabs),c=document.documentElement,l="tkbxbox"+Math.random().toString(36).slice(2,9),i=`#${l}`,d={theme:c.getAttribute("data-theme"),accent:c.getAttribute("data-accent")},u=Math.max(240,Math.round(t.chatWidth||346)),p=`${c.getAttribute("style")??""}; --chat-w:${u}px`,b=w(n,d,p,i),g=[r,a==null?void 0:a.css].filter(Boolean).map(z=>N(z,i)).join(""),T=`${i}{all:initial;display:block;box-sizing:border-box;padding:18px 0;background:var(--bg2,var(--bg,#0e1220));color:var(--tx,#e8eaf0);font-family:var(--font-ui,'Malgun Gothic','Apple SD Gothic Neo','Noto Sans KR',sans-serif);text-align:left;line-height:1.6}
${i} *,${i} *::before,${i} *::after{box-sizing:border-box}
${i} .log{display:flex;flex-direction:column;width:var(--chat-w,346px);max-width:100%;margin:0 auto;height:auto;max-height:none;overflow:visible}
${i} img{max-width:100%}
${i} .msg-actions,${i} .msg-edit,${i} .chat-resizer,${i} .typing-ind,${i} .log-more{display:none}
${i} .tkbx-head{width:var(--chat-w,346px);max-width:100%;margin:0 auto 12px;text-align:center}
${i} .tkbx-head b{display:block;font-size:19px;color:var(--accent,#7c9cff)}
${i} .tkbx-head span{font-size:11px;color:var(--tx3,#8a90a0)}
${i} .tkbx-foot{width:var(--chat-w,346px);max-width:100%;margin:14px auto 0;padding-top:8px;border-top:1px solid var(--line,rgba(127,127,127,.3));color:var(--tx3,#888);font-size:10px;text-align:center}`,C=a?$(a.uid,a.tabs,n.outerHTML):n.outerHTML,E=[d.theme?` data-theme="${s(d.theme)}"`:"",d.accent?` data-accent="${s(d.accent)}"`:""].join(""),R=`${q()};--chat-w:${u}px`;return`<div id="${s(l)}"${E} style="${s(R)}">
<style>${T}${b}${g}</style>
<div class="tkbx-head"><b>${s(t.title)}</b><span>${h(t.exportedAt)}</span></div>
${C}
<div class="tkbx-foot">${s(t.title)} · ${h(t.exportedAt)} · 총 ${o}건</div>
</div>`}function N(e,t){return e.replace(/([^{}]+)\{([^{}]*)\}/g,(n,o,r)=>{const a=o.trim();return!a||a.startsWith("@")?`${a}{${r}}`:a.startsWith(t)?`${a}{${r}}`:`${v(a,t)}{${r}}`})}async function K(e){try{return await navigator.clipboard.writeText(e),!0}catch{try{const t=document.createElement("textarea");t.value=e,t.style.cssText="position:fixed;left:-9999px;top:0;opacity:0",document.body.appendChild(t),t.select();const n=document.execCommand("copy");return t.remove(),n}catch{return!1}}}function V(e,t,n="text/html;charset=utf-8"){const o=new Blob([e],{type:n}),r=URL.createObjectURL(o),a=document.createElement("a");a.href=r,a.download=t,document.body.appendChild(a),a.click(),a.remove(),setTimeout(()=>URL.revokeObjectURL(r),4e3)}function Y(e,t){const n=new Blob([e],{type:"text/html;charset=utf-8"}),o=URL.createObjectURL(n),r=document.createElement("a");r.href=o,r.download=t,document.body.appendChild(r),r.click(),r.remove(),setTimeout(()=>URL.revokeObjectURL(o),4e3)}function Z(){var e;try{return((e=window.api)==null?void 0:e.fetchImage)??null}catch{return null}}function J(){var e;try{const n=(e=window.api)==null?void 0:e.fetchText;return n?async o=>{try{const r=await n(o);return r.ok&&typeof r.text=="string"?r.text:null}catch{return null}}:null}catch{return null}}export{J as a,O as b,G as c,Y as d,Z as e,W as f,V as g,K as h,F as i,_ as j};
