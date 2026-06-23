# Studio Architecture Decision Records

This directory records decisions that explain why Studio is structured the way
it is. ADRs are short and stable. They are not meeting notes. A new ADR is
required when a PR changes architecture boundaries, release topology, auth
contracts, preview safety policy, or the docs source-of-truth model.

## Index

| ADR | Status | Decision |
|---|---|---|
| `0001-source-owned-dev-docs.md` | Accepted | Keep dev docs in product repos and publish through `hypeprooflab`. |
| `0002-native-browser-via-webcontentsview.md` | Proposed | Build the education native browser on Electron `WebContentsView` (core patch + CDP), not a cmux/WKWebView port. |
