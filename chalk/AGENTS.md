# Chalk instructions

Follow the [root instructions](../AGENTS.md).
Read [README.md](README.md), [the layer plan](../docs/plan/vessel-and-modules.md),
and [products.yaml](../products.yaml) before changing this surface.

- Put instructor HTML in src/ui/, request handlers in src/routes/, and pure
  surface helpers in src/lib/, following adjacent file naming.
- The Service owns participant state writes and token signatures. Use the
  existing forwarder and Service authorization contract; do not add direct KV
  writes or token minting here.
- Reuse authentication through src/shared.ts; never copy its implementation.
- Keep the live board metadata-only. New voluntary project sharing is a
  separate proposed contract, not permission to expose raw session logs.
- Test surface contracts in test/ and wire new executable tests into package.json.
  Preserve existing auth, board, and deploy-isolation checks.
- UI authoring is planned in [the authoring requirements](../docs/requirements/chalk-authoring.md).
  Being reachable from Studio does not move this web surface into the App layer.
