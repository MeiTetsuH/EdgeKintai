import type { D1Migration } from '@cloudflare/vitest-pool-workers';

declare module '*?raw' {
  const content: string;
  export default content;
}

declare global {
  namespace Cloudflare {
    interface Env {
      TEST_MIGRATIONS: D1Migration[];
    }
  }
}

export {};
