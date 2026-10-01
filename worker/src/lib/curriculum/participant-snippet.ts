// The participant snippet injected into every HTML page a test link serves (recon §6
// "Participant snippet"; CR-65, CR-T60). Under 2 KB, no framework.
//
// cr-publish ships its session half. One visit is one session (CR-21): the entry page offers a
// candidate session id and session token; the snippet keeps the visit's session in
// sessionStorage and adopts the candidate only when the visit has none, so a reload, a back
// navigation or a link back to the entry page stays in the same session with the same
// pseudonym. A new session is opened on the Service once, with POST /l/<link>/__hp/session,
// and marked opened only when the Service accepted it (a failed open is retried by the next
// page load of the visit). The open also carries the visit's pseudonym, so the Service keeps
// it on the session link (cr-evidence, CR-65, CR-72); events then inherit it from there.
//
// The pseudonym (CR-65): random, made in the participant's browser with
// crypto.getRandomValues, never derived from user agent, IP, screen or any device data.
// Scoped to one experiment: the storage key names the experiment, so the same browser in a
// second experiment gets an unrelated value. Kept in localStorage only when the experiment
// declares repeated-use measurement (CR-72), and then only for the link it was made under
// and until that link's expiry: a new link, an expired or revoked one (whose pages are no
// longer served) never brings an old pseudonym back. Undeclared: a fresh one every session.
//
// The test (worker/test/cr-publish.test.mjs, CR-T60) runs exactly these bytes in a VM.

export const PARTICIPANT_SNIPPET = `(function(){var C=window.__hpTest||{},K="hp:test:"+C.link,S,L,P=null,x;try{S=window.sessionStorage}catch(e){}try{L=window.localStorage}catch(e){}
function g(s,k){try{return s?JSON.parse(s.getItem(k)||"null"):null}catch(e){return null}}
function p(s,k,v){try{s&&s.setItem(k,JSON.stringify(v))}catch(e){}}
function r(){var b=new Uint8Array(16),h="";crypto.getRandomValues(b);for(var i=0;i<16;i++)h+=(b[i]<16?"0":"")+b[i].toString(16);return"pp-"+h}
var V=/^pp-[0-9a-f]{32}$/;x=g(S,K);if(!(x&&V.test(x.pseudonym)&&x.session_id))x=null;
if(x){C.session_id=x.session_id;C.session_token=x.session_token;P=x.pseudonym}
else if(C.session_id){if(C.repeated_use){var s=g(L,"hp:pseudonym:"+C.experiment);if(s&&s.link===C.link&&s.exp>Date.now()&&V.test(s.v))P=s.v}
if(!P){P=r();if(C.repeated_use)p(L,"hp:pseudonym:"+C.experiment,{v:P,link:C.link,exp:C.link_expires_at})}
x={session_id:C.session_id,session_token:C.session_token,pseudonym:P,o:0};p(S,K,x)}
if(x&&!x.o&&window.fetch)window.fetch("/l/"+C.link+"/__hp/session",{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({token:x.session_token,pseudonym:P}),keepalive:true}).then(function(q){if(q.ok){x.o=1;p(S,K,x)}},function(){});
window.hypeproof=window.hypeproof||{};window.hypeproof.test=Object.freeze({session_id:C.session_id||null,pseudonym:P})})();`;

/**
 * The event half (cr-evidence #1394; CR-23, CR-65, CR-67), a second script after the session
 * half, under 2 KB too. It records, under the visit's session:
 *   - `session_start` once per visit (a flag in sessionStorage) and `page_view` on every load,
 *     with the page path only (no query string, which may carry typed values);
 *   - `click` with the element's role and a structural path (tag and position, at most six
 *     levels), never its text;
 *   - `input` on a field change: the fact, the field's name and its path; the typed value only
 *     when the experiment declared that field (`raw_input`, CR-67), else never sent;
 *   - `task_start` / `task_complete` / `milestone` from the student's app through
 *     `window.hypeproof.test.task(label, "start" | "complete")` and `.milestone(label)`.
 * Events wait in memory until the session half has opened the session, then go in batches
 * of at most 50 to POST /l/<link>/__hp/events with the session token. Only a transient refusal
 * is retried, a bounded number of times: 409 `session_not_open` (the open has not landed yet),
 * 429 and 5xx. Any other refusal (a conflicting event, a version mismatch, a deleted session,
 * a malformed batch) drops that batch, so one refused batch never holds back the session's
 * later events. A redelivered batch the Service already stored answers 204 (a duplicate). Sequence numbers live in their own
 * sessionStorage key (the session half rewrites its own), at most 300 per session. No identity
 * field exists to send (CR-65). The test (worker/test/cr-evidence.test.mjs) runs these bytes.
 */
export const PARTICIPANT_EVENTS_SNIPPET = `(function(){var W=window,C=W.__hpTest||{},K="hp:test:"+C.link,E=K+":e",S,Q=[],B=0,D=C.raw_input||[],d=document;try{S=W.sessionStorage}catch(e){}
function g(k){try{return JSON.parse(S.getItem(k)||"null")}catch(e){return null}}
function p(k,v){try{S.setItem(k,JSON.stringify(v))}catch(e){}}
function ev(k,o){if(!g(K))return;var s=g(E)||{n:0};if(s.n>=300)return;s.n++;p(E,s);o=o||{};o.kind=k;o.seq=s.n;Q.push(o);f(0)}
function r(t,b){Q=b.concat(Q);if(t<40)setTimeout(function(){f(t+1)},400)}
function f(t){if(B||!Q.length)return;var x=g(K);if(!x||!x.o)return r(t,[]);B=1;var b=Q.splice(0,50);
W.fetch("/l/"+C.link+"/__hp/events",{method:"POST",body:JSON.stringify({token:x.session_token,events:b}),keepalive:!0}).then(function(q){B=0;q.status==429||q.status>499||/not_open/.test(q.headers.get("x-hp-refusal"))?r(t,b):f(0)},function(){B=0;r(t,b)})}
function pa(n){for(var a=[],i=0,c,s;n&&n.nodeType==1&&i<6;i++,n=n.parentNode){for(c=1,s=n.previousElementSibling;s;s=s.previousElementSibling)s.tagName==n.tagName&&c++;a.unshift(n.tagName.toLowerCase()+(c>1?":"+c:""))}return a.join(">")}
function tg(n){return{role:((n.getAttribute&&n.getAttribute("role"))||n.tagName.toLowerCase()).slice(0,40),path:pa(n)}}
if(g(K)){var z=g(E)||{n:0};if(!z.s){z.s=1;p(E,z);ev("session_start")}ev("page_view",{path:"/"+location.pathname.split("/").slice(3).join("/").slice(0,299)})}
d.addEventListener("click",function(e){var n=e.target;n&&n.nodeType==1&&ev("click",{target:tg(n)})},!0);
d.addEventListener("change",function(e){var n=e.target;if(!n||!/^(INPUT|TEXTAREA|SELECT)$/.test(n.tagName))return;var k=String(n.name||n.id||"").slice(0,60),o={target:tg(n)};if(k)o.field=k;if(k&&~D.indexOf(k)&&n.value)o.value=n.value.slice(0,2000);ev("input",o)},!0);
var T=(W.hypeproof||{}).test||{};W.hypeproof=W.hypeproof||{};W.hypeproof.test=Object.freeze({session_id:T.session_id,pseudonym:T.pseudonym,task:function(l,h){ev(h=="complete"?"task_complete":"task_start",{label:String(l).slice(0,80)})},milestone:function(l){ev("milestone",{label:String(l).slice(0,80)})}})})();`;

export interface SnippetConfig {
  link: string;
  experiment: string;
  /** Present on the entry page load only: the candidate session, adopted when the visit has none. */
  session_id?: string;
  session_token?: string;
  repeated_use: boolean;
  link_expires_at: number;
  /** Field names whose typed value the experiment declared it keeps (CR-67); absent = none. */
  raw_input?: string[];
}

/** The tags injected into a served HTML page, before anything of the student's. */
export function snippetTags(cfg: SnippetConfig): string {
  // JSON inside a script element: `<` is escaped so no value can close the element.
  const json = JSON.stringify(cfg).replace(/</g, "\\u003c");
  return `<script>window.__hpTest=${json};</script><script>${PARTICIPANT_SNIPPET}</script><script>${PARTICIPANT_EVENTS_SNIPPET}</script>`;
}

/** Insert the snippet right after `<head>` (or the doctype / start) so it runs before the student's scripts. */
export function injectSnippet(html: string, cfg: SnippetConfig): string {
  const tags = snippetTags(cfg);
  const head = /<head(\s[^>]*)?>/i.exec(html);
  if (head) return html.slice(0, head.index + head[0].length) + tags + html.slice(head.index + head[0].length);
  const doctype = /^\s*<!doctype[^>]*>/i.exec(html);
  if (doctype) return html.slice(0, doctype[0].length) + tags + html.slice(doctype[0].length);
  return tags + html;
}
