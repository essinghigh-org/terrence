import { afterEach, beforeEach, expect, test } from "bun:test";
import {
  clearActiveUserIdentity,
  clearOrganizationScopes,
  getActiveUserId,
  registerOrganizationScope,
  resolveOrgId,
  resolveOrgName,
  setActiveUserId,
  subscribeStorageIdentity,
} from "../src/lib/storage-identity";
import {
  getPinnedWorkspaces,
  getRecentWorkspaces,
  getSingleKeyShortcutsEnabled,
  isWorkspacePinned,
  recordWorkspaceVisit,
  removeWorkspaceVisit,
  setSingleKeyShortcutsEnabled,
  setWorkspacePinned,
} from "../src/lib/workspace-shortcuts";
import {
  deleteView,
  getSavedViews,
  saveView,
} from "../src/lib/saved-views";
import {
  getTablePreferences,
  setTablePreferences,
} from "../src/lib/table-preferences";
import {
  getLastOrganization,
  setLastOrganization,
} from "../src/lib/lastOrganization";

beforeEach(() => {
  window.localStorage.clear();
  window.sessionStorage.clear();
  clearActiveUserIdentity();
  clearOrganizationScopes();
});

afterEach(() => {
  window.localStorage.clear();
  window.sessionStorage.clear();
  clearActiveUserIdentity();
  clearOrganizationScopes();
});

test("user isolation: User A data is not visible to User B after switch/logout", () => {
  // User A logs in
  setActiveUserId("user-alice");
  expect(getActiveUserId()).toBe("user-alice");

  recordWorkspaceVisit("org-engineering", "infra-prod");
  setWorkspacePinned("org-engineering", "infra-prod", true);
  saveView("org-engineering", {
    name: "Production Only",
    search: "prod",
    statusFilter: "applied",
    projectFilter: "",
  });
  setTablePreferences("workspaces", {
    density: "dense",
    visibleColumns: ["name", "status"],
  });
  setLastOrganization("org-engineering");

  // User A sees their own recents, pinned, views, prefs, last org
  expect(getRecentWorkspaces()).toEqual([
    expect.objectContaining({ orgName: "org-engineering", workspaceName: "infra-prod" }),
  ]);
  expect(getPinnedWorkspaces()).toEqual([
    expect.objectContaining({ orgName: "org-engineering", workspaceName: "infra-prod" }),
  ]);
  expect(getSavedViews("org-engineering")).toEqual([
    { name: "Production Only", search: "prod", statusFilter: "applied", projectFilter: "" },
  ]);
  expect(getTablePreferences("workspaces")).toEqual({
    density: "dense",
    visibleColumns: ["name", "status"],
  });
  expect(getLastOrganization()).toBe("org-engineering");

  // User A logs out
  clearActiveUserIdentity();
  expect(getActiveUserId()).toBeNull();

  // User B logs in
  setActiveUserId("user-bob");
  expect(getActiveUserId()).toBe("user-bob");

  // User B starts with empty/clean scoped preferences
  expect(getRecentWorkspaces()).toEqual([]);
  expect(getPinnedWorkspaces()).toEqual([]);
  expect(getSavedViews("org-engineering")).toEqual([]);
  expect(getTablePreferences("workspaces")).toBeNull();
  expect(getLastOrganization()).toBe("");

  // User B creates their own items
  recordWorkspaceVisit("org-engineering", "dev-sandbox");
  saveView("org-engineering", {
    name: "Sandbox View",
    search: "sandbox",
    statusFilter: "",
    projectFilter: "",
  });
  expect(getRecentWorkspaces()).toEqual([
    expect.objectContaining({ orgName: "org-engineering", workspaceName: "dev-sandbox" }),
  ]);
  expect(getSavedViews("org-engineering")).toEqual([
    { name: "Sandbox View", search: "sandbox", statusFilter: "", projectFilter: "" },
  ]);

  // Switch back to User A
  setActiveUserId("user-alice");
  expect(getRecentWorkspaces()).toEqual([
    expect.objectContaining({ orgName: "org-engineering", workspaceName: "infra-prod" }),
  ]);
  expect(getSavedViews("org-engineering")).toEqual([
    { name: "Production Only", search: "prod", statusFilter: "applied", projectFilter: "" },
  ]);
});

test("identity subscription triggers when active user changes", () => {
  let callCount = 0;
  const unsubscribe = subscribeStorageIdentity(() => {
    callCount += 1;
  });

  setActiveUserId("user-1");
  expect(callCount).toBe(1);

  // Setting the same ID should not trigger duplicate notifications
  setActiveUserId("user-1");
  expect(callCount).toBe(1);

  setActiveUserId("user-2");
  expect(callCount).toBe(2);

  clearActiveUserIdentity();
  expect(callCount).toBe(3);

  unsubscribe();
  setActiveUserId("user-3");
  expect(callCount).toBe(3);
});

test("organization rename preserves saved views via stable org ID", () => {
  setActiveUserId("user-alice");

  // Register initial organization mapping: UUID -> original-slug
  registerOrganizationScope("org-uuid-999", "acme-corp");
  expect(resolveOrgId("acme-corp")).toBe("org-uuid-999");
  expect(resolveOrgName("org-uuid-999")).toBe("acme-corp");

  saveView("acme-corp", {
    name: "Critical Systems",
    search: "critical",
    statusFilter: "errored",
    projectFilter: "",
  });

  // Verify view was stored scoped to stable org-uuid-999
  const viewsBeforeRename = getSavedViews("acme-corp");
  expect(viewsBeforeRename).toEqual([
    { name: "Critical Systems", search: "critical", statusFilter: "errored", projectFilter: "" },
  ]);

  // Simulate organization rename: UUID -> renamed-slug
  registerOrganizationScope("org-uuid-999", "acme-global");
  expect(resolveOrgId("acme-global")).toBe("org-uuid-999");
  expect(resolveOrgName("org-uuid-999")).toBe("acme-global");

  // Saved view should be seamlessly resolved using the new name
  const viewsAfterRename = getSavedViews("acme-global");
  expect(viewsAfterRename).toEqual([
    { name: "Critical Systems", search: "critical", statusFilter: "errored", projectFilter: "" },
  ]);

  // Updating/deleting on the new name operates on the same stable storage
  deleteView("acme-global", "Critical Systems");
  expect(getSavedViews("acme-global")).toEqual([]);
  expect(getSavedViews("acme-corp")).toEqual([]);
});

test("corrupt localStorage entries return safe defaults and do not crash", () => {
  setActiveUserId("user-alice");

  // Corrupt JSON in recent workspaces
  window.localStorage.setItem("terrence-recent-workspaces:user-alice", "{ corrupt json !!");
  expect(() => getRecentWorkspaces()).not.toThrow();
  expect(getRecentWorkspaces()).toEqual([]);

  // Corrupt JSON in pinned workspaces
  window.localStorage.setItem("terrence-pinned-workspaces:user-alice", "not valid json");
  expect(() => getPinnedWorkspaces()).not.toThrow();
  expect(getPinnedWorkspaces()).toEqual([]);

  // Non-array JSON in saved views
  window.localStorage.setItem("terrence-saved-views:user-alice:org-1", JSON.stringify({ malformed: true }));
  expect(() => getSavedViews("org-1")).not.toThrow();
  expect(getSavedViews("org-1")).toEqual([]);

  // Corrupt JSON in table preferences
  window.localStorage.setItem("terrence-table-prefs:user-alice:workspaces", "{ broken json ");
  expect(() => getTablePreferences("workspaces")).not.toThrow();
  expect(getTablePreferences("workspaces")).toBeNull();

  // Corrupt/empty last organization
  window.localStorage.setItem("terrence-last-org:user-alice", "   ");
  expect(() => getLastOrganization()).not.toThrow();
  expect(getLastOrganization()).toBe("   ");

  // Writing new data over corrupt entries recovers cleanly
  saveView("org-1", {
    name: "Recovered",
    search: "test",
    statusFilter: "",
    projectFilter: "",
  });
  expect(getSavedViews("org-1")).toEqual([
    { name: "Recovered", search: "test", statusFilter: "", projectFilter: "" },
  ]);

  setWorkspacePinned("org-1", "my-ws", true);
  expect(getPinnedWorkspaces()).toEqual([
    expect.objectContaining({ orgName: "org-1", workspaceName: "my-ws" }),
  ]);
  expect(isWorkspacePinned("org-1", "my-ws")).toBe(true);
  setWorkspacePinned("org-1", "my-ws", false);
  expect(getPinnedWorkspaces()).toEqual([]);
  expect(isWorkspacePinned("org-1", "my-ws")).toBe(false);
});

test("legacy unnamespaced localStorage migration", () => {
  // Legacy pre-UI-30 localStorage entry
  window.localStorage.setItem(
    "terrence-recent-workspaces",
    JSON.stringify([{ orgName: "legacy-org", workspaceName: "legacy-ws", visitedAt: 12345 }]),
  );

  setActiveUserId("migrated-user");
  const recents = getRecentWorkspaces();
  expect(recents).toEqual([
    { orgName: "legacy-org", workspaceName: "legacy-ws", visitedAt: 12345 },
  ]);

  // Scoped key should now contain the migrated items
  const scoped = window.localStorage.getItem("terrence-recent-workspaces:migrated-user");
  expect(scoped).not.toBeNull();
  expect(JSON.parse(scoped!)).toEqual([
    { orgName: "legacy-org", workspaceName: "legacy-ws", visitedAt: 12345 },
  ]);
});

test("single-key navigation can be disabled without affecting identity-scoped recents", () => {
  expect(getSingleKeyShortcutsEnabled()).toBe(true);
  setSingleKeyShortcutsEnabled(false);
  expect(getSingleKeyShortcutsEnabled()).toBe(false);
  expect(getRecentWorkspaces()).toEqual([]);
  setSingleKeyShortcutsEnabled(true);
  expect(getSingleKeyShortcutsEnabled()).toBe(true);
});

test("removeWorkspaceVisit drops only the matching recent", () => {
  recordWorkspaceVisit("org-a", "gone");
  recordWorkspaceVisit("org-a", "stays");
  recordWorkspaceVisit("org-b", "gone");
  expect(getRecentWorkspaces().map((visit) => `${visit.orgName}/${visit.workspaceName}`)).toEqual([
    "org-b/gone",
    "org-a/stays",
    "org-a/gone",
  ]);

  removeWorkspaceVisit("org-a", "gone");
  expect(getRecentWorkspaces().map((visit) => `${visit.orgName}/${visit.workspaceName}`)).toEqual([
    "org-b/gone",
    "org-a/stays",
  ]);

  // Removing an absent entry is a no-op that keeps the remaining order.
  removeWorkspaceVisit("org-a", "never-existed");
  expect(getRecentWorkspaces().map((visit) => `${visit.orgName}/${visit.workspaceName}`)).toEqual([
    "org-b/gone",
    "org-a/stays",
  ]);
});
