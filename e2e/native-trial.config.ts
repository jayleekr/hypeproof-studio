import { defineConfig } from '@playwright/test';
import base from './playwright.config';

// Code-entry secrets must not be captured in traces or videos. Explicit
// screenshots in the spec are taken only after the password field is gone.
export default defineConfig({
  ...base,
  testMatch: 'native-trial-live.spec.ts',
  reporter: [['list']],
  use: { ...base.use, trace: 'off', video: 'off', screenshot: 'off' },
});
