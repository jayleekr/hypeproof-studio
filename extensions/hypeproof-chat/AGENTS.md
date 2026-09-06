# Studio extension instructions

Follow the [root instructions](../../AGENTS.md) and
[extension development rules](../../.claude/rules/extension-dev.md).

- src/ owns VS Code host integration and local filesystem/runtime access;
  webview-ui/ owns the existing React UI. Keep pure helpers testable without VS Code.
- Chalk entry/navigation may live here; remote instructor business logic stays
  in Chalk/Service. Do not compile lesson content or frequently tuned thresholds
  into the App to simplify access.
- Runtime capability grants come from the resolved Service profile. A plugin
  configuration or teaching prompt must not silently widen them.
- Preserve each student's workspace and keep credentials out of templates,
  lesson bundles, logs, and navigation URLs.
- Helper tests belong in test/ using existing conventions. Real Electron
  navigation, focus, preview, and lifecycle checks belong in the root e2e/.
- App build and platform restrictions remain in CLAUDE.md and DEV-GUIDE.md.
  Missing real-app validation must be reported as BLOCKED/NOT RUN, never PASS.
