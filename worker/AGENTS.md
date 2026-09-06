# Service instructions

Follow the [root instructions](../AGENTS.md) and [the layer plan](../docs/plan/vessel-and-modules.md).

- HTTP entry points belong in src/routes/; shared policy and domain logic in
  src/lib/. Reuse existing instructor authorization and token handling.
- Before adding course/version storage, inspect src/lib/modules.ts and the
  module publisher. hps-module/1 already has a session-design kind; its content
  is currently envelope-validated only. A complete authoring schema and consumer
  require explicit validation and contract tests.
- Curriculum content and session-design data belong to the Module layer.
  Tool permissions and participant policy remain Service-enforced; editable
  teaching text must not grant runtime capabilities.
- Inspect existing schema and migration tooling before adding a migration.
  Do not renumber or modify an applied migration.
- Use test/ for API, policy, persistence, and cross-layer contracts, and wire
  new tests into the existing package scripts. Include unauthorized, concurrent,
  duplicate-request, and old-client cases when relevant.
- See [the authoring test plan](../docs/testing/chalk-authoring.md).
