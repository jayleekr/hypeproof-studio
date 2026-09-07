# Mac lesson navigation

Use a **separate copy** of the official Mac app. Build the extension and webview,
copy their `dist` folders into that copy's built-in `hypeproof-chat`, and ad-hoc
sign only the test copy. Preserve `/Applications` and the user's workspace.
The script verifies all three bundle hashes against the current build before launch.

```sh
HPS_APP_PATH='/absolute/test-copy/HypeProof Studio.app/Contents/MacOS/HypeProof Studio' \
HPS_LESSON_BUNDLED_EXTENSION=1 npm --prefix e2e run test:lesson:mac
```

The fixture uses the registered adult `homepage-practice-s1` profile, local
Service routing/SQLite, a synthetic instructor/student, an isolated user-data
folder and in-memory SecretStorage. It does not open a production session.
Port 9347 must be available. It closes only its launched app and local server.

It proves signed lesson delivery → real `/v1/profile` → real chat webview →
selected task and acceptance criteria in the composer. It does not submit the
prompt or claim LLM/tool completion. Evidence: `e2e/test-results/lesson-studio/`.

Observed 2026-09-07: the official 0.1.51 shell rejects
`--extensionDevelopmentPath` because it compares the extension's `^1.116.0`
engine with HP's `0.1.51` product version. The built-in test-copy path above
avoids that development-host mismatch without relaxing release compatibility.
The browser test is `npm --prefix e2e run test:chalk-authoring`.
