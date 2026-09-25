// Remote classroom operations R6 (#751) — delivery adapter boundary and state rules.
// Provider acceptance is not delivery, delivery is not reading, and an unknown send
// is never retried on a guess (skills/hain7-report/references/delivery-options.md).
export type SendOutcome = { status: 'accepted'; provider_message_id: string } | { status: 'rejected'; reason: string } | { status: 'unknown' };
export interface DeliveryMessage { to: string; link: string; template_revision: string; idempotency_key: string }
export interface DeliveryAdapter { id: string; external: boolean; send(m: DeliveryMessage): Promise<SendOutcome> }

/** Proves the pipeline without touching the outside world. Its result is `dry_run`, never `provider_accepted`. */
export const dryRunAdapter: DeliveryAdapter = { id: 'dry-run', external: false, send: async () => ({ status: 'rejected', reason: 'dry_run' }) };

export const DELIVERY_STATES = ['pending', 'sending', 'dry_run', 'provider_accepted', 'delivered', 'bounced', 'failed', 'send_unknown'] as const;
/** Forward only. `delivered`/`bounced` come from provider events alone; nothing here ever means "opened". */
export function nextDeliveryState(current: string, event: 'accepted' | 'delivered' | 'bounced'): string | null {
  if (event === 'accepted') return ['sending', 'send_unknown'].includes(current) ? 'provider_accepted' : null;
  if (event === 'delivered') return ['provider_accepted', 'send_unknown', 'sending'].includes(current) ? 'delivered' : null;
  return ['provider_accepted', 'send_unknown', 'sending', 'delivered'].includes(current) ? 'bounced' : null;
}
export const maskAddress = (a: string) => a.replace(/^(.).*(@.*)$/, '$1***$2');
export const LINK_TTL_MS = 7 * 24 * 3_600_000;
export const APPROVAL_TTL_MS = 24 * 3_600_000;
export const TEMPLATE_RE = /^[A-Za-z0-9_.-]{1,64}$/;
export const EMAIL_RE = /^[^\s@<>"',;]{1,64}@[A-Za-z0-9.-]{1,190}\.[A-Za-z]{2,24}$/;

/**
 * Identity of ONE logical message: this learner's report job of this class run, to this revision of this recipient,
 * over this channel/template/adapter mode. Report text is deliberately not the identity — two siblings with the same
 * draft and the same guardian are two messages — and a recipient_ref reused in another class run is another message.
 */
export interface DeliveryIdentity { class_run_id: string; batch_id: string; job_id: string; student_id: string; draft_digest: string; recipient_ref: string; recipient_revision: number; channel: string; template_revision: string; live: boolean }
export async function deliveryKey(d: DeliveryIdentity): Promise<string> {
  const bytes = new TextEncoder().encode(JSON.stringify([d.class_run_id, d.batch_id, d.job_id, d.student_id, d.draft_digest, d.recipient_ref, d.recipient_revision, d.channel, d.template_revision, d.live ? 'live' : 'dry']));
  return [...new Uint8Array(await crypto.subtle.digest('SHA-256', bytes))].map((x) => x.toString(16).padStart(2, '0')).join('');
}

// ── link viewer check ──
// The link proves someone has the mail. Mail gets forwarded, shared inboxes exist, and a URL can leak. Before a report is
// SENT to a real address the operator must have imported a second factor for that recipient: a value they agreed out of
// band. It is deliberately simple (a guardian types it on a phone) and therefore low-entropy — which is why only a salted
// HMAC keyed by the Service secret is stored, guesses are bounded per link, and a locked link needs a new one.
export const VIEWER_CHECK_KINDS = { phone_last4: /^\d{4}$/, birth_mmdd: /^(0[1-9]|1[0-2])(0[1-9]|[12]\d|3[01])$/, passphrase: /^.{6,64}$/u } as const;
export type ViewerCheckKind = keyof typeof VIEWER_CHECK_KINDS;
export const VIEWER_CHECK_PROMPT: Record<ViewerCheckKind, string> = { phone_last4: '보호자 휴대전화 번호 끝 4자리', birth_mmdd: '학생 생일 네 자리 (월일, 예: 0314)', passphrase: '수업 운영자와 미리 정한 확인 문구' };
export const MAX_VIEWER_ATTEMPTS = 5;
export const normalizeCheck = (kind: ViewerCheckKind, value: string) => (kind === 'passphrase' ? value.normalize('NFC').trim().toLowerCase() : value.replace(/\D/g, ''));
export async function viewerCheckHash(secret: string, salt: string, kind: ViewerCheckKind, value: string): Promise<string> {
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode('hps-viewer-check/1|' + secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const mac = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(`${salt}|${kind}|${normalizeCheck(kind, value)}`));
  return [...new Uint8Array(mac)].map((x) => x.toString(16).padStart(2, '0')).join('');
}
export const sameHash = (a: string, b: string) => { if (a.length !== b.length) return false; let d = 0; for (let i = 0; i < a.length; i++) d |= a.charCodeAt(i) ^ b.charCodeAt(i); return d === 0; };
