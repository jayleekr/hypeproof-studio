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
