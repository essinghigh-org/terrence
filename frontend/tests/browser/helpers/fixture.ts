export const TEST_ORG = "essinghigh-org";
export const TEST_WORKSPACE = "tf-deploy-github-repository";
export const TEST_RUN_ID = "423b4c6e-3b0b-4707-94c6-678d80c43f09";

export const TEST_PATHS = {
  login: "/login",
  register: "/register",
  workspace: `/app/${TEST_ORG}/workspaces/${TEST_WORKSPACE}`,
  runDetail: `/app/${TEST_ORG}/workspaces/${TEST_WORKSPACE}/runs/${TEST_RUN_ID}`,
  adminSecurity: "/app/admin",
  adminOperations: "/app/admin/operations",
  orgWorkspaces: `/app/${TEST_ORG}/workspaces`,
  orgCalendar: `/app/${TEST_ORG}/calendar`,
  accountSettings: "/app/account",
} as const;
