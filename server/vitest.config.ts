import { defineWorkersConfig } from '@cloudflare/vitest-pool-workers/config';
import { unstable_readConfig, unstable_getMiniflareWorkerOptions } from 'wrangler';
import type { WorkerOptions } from 'miniflare';

// Remove AI before Wrangler constructs remote bindings. Service binding overrides
// cannot replace the wrapped AI binding produced by the locked Wrangler version.
const config = unstable_readConfig({ config: './wrangler.jsonc' });
delete config.ai;
const { workerOptions, main } = unstable_getMiniflareWorkerOptions(config);
// The locked Wrangler and test pool contain distinct Miniflare symbol types.
// These config-derived options are plain data; bridge the duplicate type copies.
const testOptions = workerOptions as unknown as Omit<WorkerOptions, 'script' | 'scriptPath' | 'modules' | 'modulesRoot'>;

export default defineWorkersConfig({
  test: {
    poolOptions: {
      workers: {
        main,
        miniflare: {
          ...testOptions,
          // Mock AI as a failing service, never the remote Workers AI binding.
          serviceBindings: { AI: async () => new Response('Unmocked AI call', { status: 500 }) },
          bindings: {
            ...testOptions.bindings,
            PUBLIC_ORIGIN: 'https://mobi.invalid',
            GOOGLE_CLIENT_ID: 'test-only-google-client',
            GOOGLE_CLIENT_SECRET: 'test-only-google-secret',
            TOKEN_ENCRYPTION_KEY: 'AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8=',
          },
        },
      },
    },
  },
});
