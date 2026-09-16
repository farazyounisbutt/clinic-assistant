import { defineConfig } from 'vitest/config';
import { cloudflareTest } from '@cloudflare/vitest-plugin';

export default defineConfig({
  plugins: [
    cloudflareTest({
      wrangler: { configPath: './wrangler.jsonc' },
      miniflare: {
        bindings: {
          GOOGLE_SERVICE_ACCOUNT_EMAIL: '',
          GOOGLE_SERVICE_ACCOUNT_PRIVATE_KEY: '',
          GOOGLE_SHEETS_TARGETS: '',
          META_ACCESS_TOKEN: '',
          META_APP_SECRET: '',
          WHATSAPP_VERIFY_TOKEN: '',
          WHATSAPP_PHONE_CLINICS: '',
          WHATSAPP_GRAPH_VERSION: 'v26.0',
        },
      },
    }),
  ],
  test: {
    coverage: {
      provider: 'istanbul',
      include: ['src/**/*.ts'],
      exclude: [
        'src/index.ts',
        'src/ports/**',
        'src/shared/types.ts',
        'src/scheduling/models.ts',
        'src/patients/models.ts',
      ],
      reporter: ['text', 'json-summary'],
      thresholds: { lines: 80, statements: 80, functions: 80, branches: 80 },
    },
  },
});
