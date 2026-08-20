# Report delivery options — design only

Decision date: 2026-08-19. This document evaluates a future delivery extension. No provider adapter, credential, upload, message send, or QR generation is implemented in this skill version.

## Decision

Start with **HypeProof-domain email as the primary channel plus an in-class QR using the same secure link**. Keep SMS/LMS as fallback. After a stable report template and recurring volume justify onboarding, make **Kakao Alimtalk the primary notification**, retain email as the durable recovery channel, and use SMS only for Alimtalk failure.

Do not attach the child report by default. Every channel should carry a branded `https://<hypeproof-domain>/r/<opaque-token>` link. The application validates a one-time, short-lived token and then streams the PDF or issues a very short-lived object-storage URL. Cloudflare R2 presigned URLs are reusable until expiry, so an R2 URL alone cannot enforce one-time access. Source: [Cloudflare R2 presigned URLs](https://developers.cloudflare.com/r2/api/s3/presigned-urls/).

Existing assets reduce, but do not remove, onboarding:

- the HypeProof domain is immediately useful for the branded secure link and sender authentication;
- a Google account enables Gmail API authorization, but custom-domain sending still requires a configured Google Workspace or equivalent mailbox;
- an owned phone number is a candidate SMS sender number, but the provider still requires ownership/business documents and approval;
- neither the domain, Google account, nor phone number replaces Kakao business-channel verification and Alimtalk template review.

## Scoring

Current-introduction fit is weighted as setup speed 25, guardian reach 20, trust/brand 15, security/control 20, delivery observability 10, and variable cost 10. Each criterion is scored 1–5, then converted to 100 points. Scores are product judgments based on the official constraints below, not provider SLAs. The rating order shown below is `setup/reach/brand/security/observability/cost`.

| Channel | Six ratings | Current fit | Settled-operation fit | Best role | Main bottleneck |
| --- | --- | ---: | ---: | --- | --- |
| HypeProof-domain email via Google | `5/4/4/4/3/5` | **85** | 85 | Pilot primary and durable recovery | Confirm Workspace/custom-domain sender; SPF/DKIM/DMARC; OAuth `gmail.send`; weak delivered/read evidence |
| Kakao Alimtalk | `1/5/5/4/5/4` | 74 | **94** | Recurring-volume primary notification | Business-channel verification, sender profile, information-template review, BizMessage provider contract |
| In-class QR | `5/5/4/3/1/5` | **81** | 81 | Immediate classroom handoff | Not remote delivery; screenshot/share risk; no recipient or delivery proof |
| SMS/LMS | `3/5/2/3/4/3` | 67 | 75 | Universal failure fallback | Sender-number document approval, low brand trust for links, length/filtering constraints |

“Settled-operation fit” removes one-time onboarding friction but keeps each channel's structural limits: Kakao setup rises from 1 to 5; SMS setup rises from 3 to 4 and brand trust from 2 to 3 after registered-sender history. QR's score assumes the learner or guardian is physically present; as a remote delivery channel it is unsuitable.

## Channel findings

### 1. HypeProof-domain email through Google

Advantages:

- fastest pilot if the HypeProof domain is already attached to Google Workspace;
- supports a branded sender, clear explanation, secure-link button, and a durable searchable record;
- Gmail API can send MIME messages and attachments, though the recommended default is a link;
- low marginal cost within account sending limits.

Bottlenecks:

- owning a domain and a Google account does not prove that custom-domain Gmail/Workspace is configured;
- authenticate the sender domain with SPF or DKIM at minimum and preferably SPF, DKIM, and DMARC; Gmail applies stronger requirements to bulk senders;
- use the least-privilege `gmail.send` OAuth scope. Google classifies it as sensitive, so a multi-user OAuth app may require verification;
- Gmail API acceptance is not proof of inbox delivery or reading. Production bounce/delivery analytics may justify a transactional-email provider later.

Sources: [Gmail sender guidelines](https://support.google.com/mail/answer/81126), [Gmail API sending](https://developers.google.com/workspace/gmail/api/guides/sending), [Gmail API scopes](https://developers.google.com/workspace/gmail/api/auth/scopes).

### 2. Kakao Alimtalk

Use Alimtalk, not the Kakao Developers friend-message API. The latter only sends within the same service and requires Kakao Login, recipient consent, additional permission, and friend selection; it is not an operational guardian-notification channel. Source: [Kakao Talk Message REST API](https://developers.kakao.com/docs/en/kakaotalk-message/rest-api).

Advantages:

- phone-number based and works without channel friendship;
- trusted Kakao business identity, up to 1,000 characters, link buttons, delivery-result APIs/webhooks, and SMS failover;
- strong fit for a standardized “report ready” informational notice.

Bottlenecks:

- create a KakaoTalk channel, obtain business verification, and register the sender profile. NHN Cloud states business-channel review normally takes 2–3 business days and requires business and employment/identity documents;
- every Alimtalk content structure must be informational and template-reviewed. NHN Cloud states review normally completes within two business days;
- select and contract with a BizMessage provider such as NHN Cloud or NAVER Cloud, manage sender keys/templates, and handle provider webhooks;
- template changes can cause re-review, so do not place volatile interpretive text in the message. Send a stable notice plus secure report link.

Sources: [NHN Cloud sender preparation](https://docs.nhncloud.com/ko/Notification/KakaoTalk%20Bizmessage/ko/sender-overview/), [NHN Cloud Alimtalk overview](https://docs.nhncloud.com/ko/Notification/KakaoTalk%20Bizmessage/ko/alimtalk-overview/), [NHN Cloud Alimtalk API](https://docs.nhncloud.com/ko/Notification/KakaoTalk%20Bizmessage/ko/alimtalk-api-guide-v2.2/), [NAVER Cloud SENS](https://www.ncloud.com/product/applicationService/sens).

### 3. In-class QR

Advantages:

- near-zero channel cost, instant handoff, and strong branded completion moment;
- the same secure link can appear on the instructor screen or printed handout;
- no contact information is required just to scan.

Bottlenecks:

- QR is an encoding/entry mechanism, not a remote notification provider;
- anyone who photographs or forwards the code has the bearer link;
- a scan does not prove guardian identity or delivery;
- use only an opaque expiring application URL, never a public PDF path or raw R2 presigned URL. QR error correction improves scan reliability but does not add access control. Source: [DENSO WAVE QR error correction](https://www.qrcode.com/en/about/error_correction.html).

### 4. SMS/LMS

Advantages:

- broadest phone reach and effective fallback when Kakao or email fails;
- provider APIs expose send history and can be paired with Alimtalk failover;
- does not require a smartphone app account.

Bottlenecks:

- the sender number must be registered and document-verified. NAVER Cloud states approval can take 3–4 business days;
- SMS is byte-limited and branded links can resemble phishing; a HypeProof custom domain and concise LMS template are essential;
- it is a poor place for report content and should carry only the secure link and support contact;
- advertising rules are separate. Keep report delivery strictly transactional and obtain a separate review before mixing marketing content.

Sources: [NAVER Cloud SENS overview](https://guide.ncloud-docs.com/docs/sens-overview), [NAVER Cloud caller-number registration](https://guide.ncloud-docs.com/docs/sens-callingno).

## Provider-neutral future contract

Keep the report generator independent from delivery providers. The generator emits an immutable report ID, PDF hash, and private object reference. A later delivery service receives references, not raw prompts or analysis.

```json
{
  "delivery_request": {
    "report_id": "rpt_...",
    "recipient_ref": "recipient_...",
    "channel": "email|alimtalk|sms|qr",
    "destination_ref": "contact_...",
    "link_token_id": "token_...",
    "template_version": "report-ready-v1",
    "guardian_consent_ref": "consent_...",
    "expires_at": "ISO-8601",
    "idempotency_key": "unique-per-report-recipient-channel"
  },
  "delivery_receipt": {
    "provider": "provider-name",
    "provider_message_id": "opaque-id",
    "accepted_at": "ISO-8601|null",
    "delivered_at": "ISO-8601|null",
    "failed_at": "ISO-8601|null",
    "failure_code": "string|null",
    "correlation_id": "internal-opaque-id"
  }
}
```

## Required future gates

1. Verify the guardian contact and delivery consent; never infer a child's destination from logs.
2. Store email/phone encrypted in a recipient vault and reference it by opaque ID. Do not put contact data in analysis JSON, filenames, URLs, or provider logs beyond operational necessity.
3. Generate a single-use application token with short expiry, revocation, access logging, rate limiting, and no PII in the URL.
4. Show a human confirmation screen with recipient, masked destination, channel, template, report ID, and expiry immediately before send.
5. Send idempotently, ingest provider result/webhook, and distinguish provider acceptance, delivery, link opening, and report download.
6. Provide resend, revoke, correction, and deletion workflows with an audit trail.
7. Run a privacy/legal review for child data, provider retention, overseas processing, guardian notice, and transactional-versus-marketing classification before production.
