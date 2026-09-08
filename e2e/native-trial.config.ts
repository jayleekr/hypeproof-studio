import { defineConfig } from '@playwright/test';
import base from './playwright.config';

// Code-entry secrets must not be captured in traces or videos. Explicit
// screenshots in the spec are taken only after the password field is gone.
export default defineConfig({
  ...base,
  testMatch: process.env.HPS_NATIVE_IDENTITY==='1'?'native-identity-live.spec.ts':process.env.HPS_NATIVE_FAULTS==='1'?'native-faults-live.spec.ts':process.env.HPS_NATIVE_SAFETY==='1'?'native-safety-live.spec.ts':'native-trial-live.spec.ts',
  reporter: [['list']],
  use: { ...base.use, trace: 'off', video: 'off', screenshot: 'off' },
});
