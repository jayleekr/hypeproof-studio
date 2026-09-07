# Classroom console release

Status: deployment procedure, not deployment evidence. Issue #732.

The website PRD, Chalk surface and Service API have separate deployment trains.
Do not claim the API is deployed because the PRD page is reachable.

1. Use the reviewed merge SHA. Run `npm --prefix worker test`, both package typechecks,
   `npm --prefix chalk test` and `npm --prefix worker run test:classroom:d1`.
2. Dispatch the existing Service workflow. Keep the live-session override false:

   ```sh
   gh workflow run deploy-worker.yml --repo jayleekr/hypeproof-studio --ref main -f ref=REVIEWED_MERGE_SHA -F dry_run=false -F verify_prod=true -F override_live_session=false
   ```

   The workflow applies only additive migration 0003 after the live-session freeze.
   It does not change profile logging, Cloudflare Access, operator identities or old retention.
   Wait for the exact run's tests, schema, deployment and production verification to succeed.
3. Dispatch Chalk at the same reviewed SHA, then check its exact run and `/health`:

   ```sh
   gh workflow run deploy-chalk.yml --repo jayleekr/hypeproof-studio --ref main -f ref=REVIEWED_MERGE_SHA -F dry_run=false
   ```

4. Verify `/manage` and `/sharing` serve HTML. An unauthenticated GET to
   `https://api.hypeproof-ai.xyz/v1/classroom/shares` must be 401 and contain no content.
   Use approved synthetic adult participant/instructor credentials to exercise create,
   designated read, unrelated-teacher denial, feedback, student confirmation, audit and withdrawal.
   Do not use real participant records as a deployment probe.
5. Run DT-01~06 on supported browsers and widths; record untested devices explicitly.

If the Service workflow freeze blocks, stop the deployment and report the live class;
do not override it automatically. If the current connection cannot dispatch workflows,
finish the PR and preserve this procedure rather than changing triggers to bypass that limitation.

Rollback: deploy the preceding reviewed Service/Chalk revisions with the same gates.
Stop new share intake. If the old Service lacks expiry cleanup, arrange the existing
new-data expiry cleanup before rollback; do not leave shared content indefinitely.
Never drop tables or delete historical logs as an automatic rollback step.
