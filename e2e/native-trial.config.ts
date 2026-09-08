import { defineConfig } from '@playwright/test';
import base from './playwright.config';

// Code-entry secrets must not be captured in traces or videos. Explicit
// screenshots in the spec are taken only after the password field is gone.
const modes: [string, string | string[]][] = [
  ['HPS_NATIVE_EFFORT', 'native-effort.spec.ts'],
  ['HPS_NATIVE_PRESENTATION', 'native-presentation.spec.ts'],
  ['HPS_NATIVE_INPUT', 'native-browser-input.spec.ts'],
  ['HPS_NATIVE_APPROVAL', 'native-approval-controls.spec.ts'],
  ['HPS_NATIVE_EXTRA', ['01-launch.spec.ts', 'native-entry-controls.spec.ts', '26-report-resilience.spec.ts', 'image-attach.spec.ts']],
  ['HPS_NATIVE_HOST', ['20-settings-bridge.spec.ts', '23-crash-recovery.spec.ts', '26-report-resilience.spec.ts', '16-approval-gates.spec.ts']],
  ['HPS_NATIVE_IDENTITY', 'native-identity-live.spec.ts'],
  ['HPS_NATIVE_FAULTS', 'native-faults-live.spec.ts'],
  ['HPS_NATIVE_SAFETY', 'native-safety-live.spec.ts'],
];

export default defineConfig({
  ...base,
  testMatch: modes.find(([flag]) => process.env[flag] === '1')?.[1] ?? 'native-trial-live.spec.ts',
  reporter: [['list']],
  use: { ...base.use, trace: 'off', video: 'off', screenshot: 'off' },
});
