import type { GatewayEnv } from "../apps/gateway/src";

declare global {
  namespace Cloudflare {
    interface Env extends GatewayEnv {
      TEST_MIGRATIONS: string;
      ADMIN_TOKEN: string;
      DASHBOARD_TOKEN: string;
      CREDENTIAL_PEPPER: string;
      ENABLE_DEV_ISSUER: string;
    }
  }
}

export {};
