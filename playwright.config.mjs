import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: './tests/web',
  use: {
    channel: 'chrome',
    permissions: ['microphone'],
    launchOptions: {
      args: ['--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream'],
    },
  },
});
