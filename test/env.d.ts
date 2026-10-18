import type { D1Migration } from '@cloudflare/vitest-plugin';

declare module '*?raw' {
  const content: string;
  export default content;
}

declare global {
  namespace Cloudflare {
    interface Env {
      TEST_MIGRATIONS: D1Migration[];
      UPGRADE_DB: D1Database;
    }
  }
}

export {};
