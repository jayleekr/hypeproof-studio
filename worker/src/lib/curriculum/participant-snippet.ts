// The participant snippet injected into every HTML page a test link serves (recon §6
// "Participant snippet"; CR-65, CR-T60). Under 2 KB, no framework.
//
// cr-publish ships its session half. One visit is one session (CR-21): the entry page offers a
// candidate session id and session token; the snippet keeps the visit's session in
// sessionStorage and adopts the candidate only when the visit has none, so a reload, a back
// navigation or a link back to the entry page stays in the same session with the same
// pseudonym. A new session is opened on the Service once, with POST /l/<link>/__hp/session,
// and marked opened only when the Service accepted it (a failed open is retried by the next
// page load of the visit). cr-evidence adds the event half (session_start, page_view, clicks,
// task and milestone calls) on top of this same snippet.
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
if(x&&!x.o&&window.fetch)window.fetch("/l/"+C.link+"/__hp/session",{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({token:x.session_token}),keepalive:true}).then(function(q){if(q.ok){x.o=1;p(S,K,x)}},function(){});
window.hypeproof=window.hypeproof||{};window.hypeproof.test=Object.freeze({session_id:C.session_id||null,pseudonym:P})})();`;

export interface SnippetConfig {
  link: string;
  experiment: string;
  /** Present on the entry page load only: the candidate session, adopted when the visit has none. */
  session_id?: string;
  session_token?: string;
  repeated_use: boolean;
  link_expires_at: number;
}

/** The tags injected into a served HTML page, before anything of the student's. */
export function snippetTags(cfg: SnippetConfig): string {
  // JSON inside a script element: `<` is escaped so no value can close the element.
  const json = JSON.stringify(cfg).replace(/</g, "\\u003c");
  return `<script>window.__hpTest=${json};</script><script>${PARTICIPANT_SNIPPET}</script>`;
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
