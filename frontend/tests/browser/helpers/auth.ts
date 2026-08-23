import type { BrowserPage } from "./browser";

export const DEFAULT_MOCK_TOKEN = "terr_test_mock_admin_token_1234567890abcdef";

export function getAdminToken(): string {
  return process.env.TERRENCE_E2E_ADMIN_TOKEN ?? DEFAULT_MOCK_TOKEN;
}

export async function injectAuth(page: BrowserPage, token: string = getAdminToken()): Promise<void> {
  await page.evaluate(`
    (() => {
      localStorage.setItem("tfe_token", ${JSON.stringify(token)});
      localStorage.setItem("tfe_refreshable_session", "true");
    })()
  `);
}

export async function clearAuth(page: BrowserPage): Promise<void> {
  await page.evaluate(`
    (() => {
      localStorage.removeItem("tfe_token");
      localStorage.removeItem("tfe_refreshable_session");
    })()
  `);
}
