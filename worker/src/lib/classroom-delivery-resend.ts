// Remote classroom operations R6 (#751) — the one live email adapter: Resend (HTTP API).
//
// Why this provider (docs/requirements/classroom-admin.md records the comparison): a Worker can only speak
// HTTP; the ledger already carries a per-message idempotency key and needs a provider that honours one
// (Resend: `Idempotency-Key`, kept 24 h); and delivery/bounce must arrive as SIGNED events (Svix HMAC).
// Contract checked against resend.com/docs on 2026-09-19. No account exists yet: nothing here has been
// run against the real API, a sandbox or a real inbox.
//
//   - A 2xx is `accepted` by the provider. It is not delivery, and delivery is not reading.
//   - Timeout, network failure, 5xx and "a request with this key is still in progress" are `unknown`:
//     the message may have gone out. It is never re-sent on a guess.
//   - 4xx validation/auth/rate-limit answers mean the provider did NOT take the message: `rejected`.
//   - Opens and clicks are deliberately not read. Tracking them is not needed to deliver a report.
import type { Env } from '../env';
import type { DeliveryAdapter, DeliveryMessage, SendOutcome } from './classroom-delivery';

export const RESEND_ENDPOINT = 'https://api.resend.com/emails';
/** Fixed, reviewed wording per template revision. A live send refuses a revision that is not listed here. */
export const EMAIL_TEMPLATES: Record<string, { subject: string; text: (link: string) => string; html: (link: string) => string }> = {
  'report-link-ko-1': {
    subject: '[HypeProof] 수업 관찰 보고서가 준비됐습니다',
    text: (link) => `안녕하세요.\n\n이번 수업에서 관찰된 내용을 강사가 확인해 보고서로 정리했습니다. 점수나 순위가 아니라, 수업 중 실제로 관찰된 행동과 그 근거를 적은 것입니다.\n\n보고서 보기: ${link}\n\n보고서를 열 때 수업 운영자와 미리 정한 확인 값(예: 휴대전화 번호 끝 4자리)을 입력해야 합니다. 이 메일을 다른 사람에게 전달하지 말아 주세요. 주소는 7일 뒤 닫힙니다. 내용에 고칠 점이 있거나 받고 싶지 않으시면 수업 운영자에게 알려 주세요.\n\nHypeProof`,
    html: (link) => `<p>안녕하세요.</p><p>이번 수업에서 관찰된 내용을 강사가 확인해 보고서로 정리했습니다. 점수나 순위가 아니라, 수업 중 실제로 관찰된 행동과 그 근거를 적은 것입니다.</p><p><a href="${link}">보고서 보기</a></p><p>보고서를 열 때 수업 운영자와 미리 정한 확인 값(예: 휴대전화 번호 끝 4자리)을 입력해야 합니다. 이 메일을 다른 사람에게 전달하지 말아 주세요. 주소는 7일 뒤 닫힙니다. 내용에 고칠 점이 있거나 받고 싶지 않으시면 수업 운영자에게 알려 주세요.</p><p>HypeProof</p>`,
  },
};

export function resendConfigured(env: Env): boolean {
  return env.HPS_DELIVERY_PROVIDER === 'resend' && !!env.RESEND_API_KEY && !!env.HPS_DELIVERY_FROM && /^https:\/\/[A-Za-z0-9.-]+(?::\d+)?$/.test(env.HPS_PUBLIC_BASE_URL ?? '');
}
export function resendAdapter(env: Env, fetchImpl: typeof fetch = fetch): DeliveryAdapter {
  return { id: 'resend', external: true, async send(m: DeliveryMessage): Promise<SendOutcome> {
    const template = EMAIL_TEMPLATES[m.template_revision];
    if (!template) return { status: 'rejected', reason: 'template_unknown' };
    const link = env.HPS_PUBLIC_BASE_URL + m.link;
    let res: Response;
    try {
      res = await fetchImpl(RESEND_ENDPOINT, { method: 'POST', signal: AbortSignal.timeout(10_000),
        headers: { authorization: `Bearer ${env.RESEND_API_KEY}`, 'content-type': 'application/json', 'idempotency-key': m.idempotency_key },
        // The tag lets a signed event settle a send whose HTTP answer was lost (send_unknown) without sending again.
        body: JSON.stringify({ from: env.HPS_DELIVERY_FROM, to: [m.to], subject: template.subject, text: template.text(link), html: template.html(link), tags: [{ name: 'delivery_key', value: m.idempotency_key }] }) });
    } catch { return { status: 'unknown' }; }
    if (res.ok) { const b = (await res.json().catch(() => null)) as { id?: unknown } | null; return typeof b?.id === 'string' && /^[A-Za-z0-9_-]{8,128}$/.test(b.id) ? { status: 'accepted', provider_message_id: b.id } : { status: 'unknown' }; }
    if (res.status >= 500) return { status: 'unknown' };
    const b = (await res.json().catch(() => null)) as { name?: unknown } | null, name = typeof b?.name === 'string' ? b.name : '';
    // Same key, original request still running: it may well be going out.
    if (res.status === 409 && name === 'concurrent_idempotent_requests') return { status: 'unknown' };
    return { status: 'rejected', reason: /^[a-z_]{1,48}$/.test(name) ? name : `http_${res.status}` };
  } };
}

// ── signed provider events (Svix) ──
const b64 = (s: string) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));
/** Constant-time HMAC check of `${id}.${timestamp}.${rawBody}`. Any one of the space-separated `v1,` signatures may match (key rotation). */
export async function verifySvix(secret: string, headers: { id: string | undefined; timestamp: string | undefined; signature: string | undefined }, rawBody: string, nowMs: number, toleranceSec = 300): Promise<'ok' | 'missing' | 'stale' | 'bad_signature'> {
  if (!headers.id || !headers.timestamp || !headers.signature || !secret.startsWith('whsec_')) return 'missing';
  const ts = Number(headers.timestamp); if (!Number.isSafeInteger(ts) || Math.abs(nowMs / 1000 - ts) > toleranceSec) return 'stale'; // replayed or far-future
  let key: CryptoKey; try { key = await crypto.subtle.importKey('raw', b64(secret.slice(6)), { name: 'HMAC', hash: 'SHA-256' }, false, ['verify']); } catch { return 'missing'; }
  const data = new TextEncoder().encode(`${headers.id}.${headers.timestamp}.${rawBody}`);
  for (const part of headers.signature.split(' ')) {
    const [version, sig] = part.split(','); if (version !== 'v1' || !sig) continue;
    try { if (await crypto.subtle.verify('HMAC', key, b64(sig), data)) return 'ok'; } catch { /* malformed base64: try the next one */ }
  }
  return 'bad_signature';
}
/** Resend event → the ledger's vocabulary. Opens/clicks/complaints are not delivery states and return null. */
export function resendEventKind(type: unknown): 'accepted' | 'delivered' | 'bounced' | null {
  return type === 'email.sent' ? 'accepted' : type === 'email.delivered' ? 'delivered' : type === 'email.bounced' || type === 'email.failed' || type === 'email.suppressed' ? 'bounced' : null;
}
