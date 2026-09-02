import { useCallback, useEffect, useRef, useState, type JSX, type ReactNode } from "react";
import {
  Link,
  matchPath,
  Outlet,
  useLocation,
  useNavigate,
} from "react-router-dom";
import {
  Activity,
  ArrowLeft,
  Bell,
  BookOpen,
  Box,
  Building2,
  CalendarClock,
  ChevronDown,
  Database,
  FolderGit2,
  GitBranch,
  GitPullRequest,
  HelpCircle,
  History as HistoryIcon,
  KeyRound,
  Keyboard,
  LayoutDashboard,
  LifeBuoy,
  ListChecks,
  ListTodo,
  Lock,
  LogOut,
  Menu,
  MonitorSmartphone,
  Package,
  Fingerprint,
  PanelLeftClose,
  PanelLeftOpen,
  Palette,
  FileCode,
  PlayCircle,
  Search,
  Settings,
  ShieldCheck,
  SlidersHorizontal,
  Sparkles,
  Tag,
  Tags,
  Trash2,
  UserCog,
  UserRound,
  Users,
  Variable,
  Layers,
  Mail,
  Webhook,
} from "lucide-react";

import {
  Dialog,
  DialogTitle,
  DialogTrigger,
  DrawerContent,
} from "./ui/dialog";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "./ui/dropdown-menu";
import { Avatar, AvatarFallback, AvatarImage } from "./ui/avatar";
import { Button, buttonVariants } from "./ui/button";
import { CommandPalette } from "./CommandPalette";
import { DocsSidebarNav } from "./DocsSidebarNav";
import { ShortcutsHelpModal } from "./ShortcutsHelpModal";
import { SidebarContextLabel, SidebarGroupLabel, SidebarNavLink } from "./SidebarNavLink";
import { fetchAllApiPages, fetchApi, logoutAuthSession } from "../lib/api";
import { applyTheme, applyThemeIfUnchanged, getThemeRevision } from "../lib/theme";
import { usePageTitle } from "../lib/usePageTitle";
import { setLastOrganization } from "../lib/lastOrganization";
import { getPinnedWorkspaces, getRecentWorkspaces, recordWorkspaceVisit, subscribeWorkspaceShortcuts } from "../lib/workspace-shortcuts";
import { cn } from "../lib/utils";
import { CapabilitiesProvider, DEFAULT_CAPABILITIES, type Capabilities } from "../lib/capabilities";
import { useDocsIndex } from "../lib/docs-index";
import { isString } from "../lib/type-guards";
import { ORG_CACHE_TTL_MS, orgPermissionsCache } from "../hooks/useOrganizationPermissions";

const SIDEBAR_STORAGE_KEY = "terrence-sidebar-collapsed";

export type LayoutOutletContext = Readonly<{
  accountLoaded: boolean;
  setMustChangePassword: (required: boolean) => void;
  siteAdmin: boolean;
}>;

type OrganizationPermissions = Readonly<{
  "can-manage-agent-pools"?: boolean;
  "can-manage-projects"?: boolean;
  "can-manage-vcs-settings"?: boolean;
  "can-manage-workspaces"?: boolean;
  "can-read-projects"?: boolean;
  "can-manage-policies"?: boolean;
  "can-read-policies"?: boolean;
  "can-manage-modules"?: boolean;
}>;

function readSidebarCollapsed(): boolean {
  try {
    return window.localStorage.getItem(SIDEBAR_STORAGE_KEY) === "true";
  } catch {
    return false;
  }
}

function writeSidebarCollapsed(collapsed: boolean): void {
  try {
    window.localStorage.setItem(SIDEBAR_STORAGE_KEY, String(collapsed));
  } catch {
    // Storage silent fallback
  }
}

function readableRouteParam(value: string | undefined): string | undefined {
  if (value === undefined) return undefined;
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

function isActivePath(pathname: string, path: string, exact = false): boolean {
  return exact
    ? pathname === path
    : pathname === path || pathname.startsWith(`${path}/`);
}

export function Layout({
  children,
}: Readonly<{ readonly children?: ReactNode }>): JSX.Element {
  const location = useLocation();
  const navigate = useNavigate();
  const organizationRouteKey = location.pathname.split("/").slice(0, 3).join("/");
  const [sidebarCollapsed, setSidebarCollapsed] = useState(readSidebarCollapsed);
  const [mobileNavigationOpen, setMobileNavigationOpen] = useState(false);
  const [accountLoaded, setAccountLoaded] = useState(false);
  const [mustChangePassword, setMustChangePassword] = useState<boolean | null>(null);
  const [siteAdmin, setSiteAdmin] = useState(false);
  const [accountName, setAccountName] = useState("");
  const [avatarUrl, setAvatarUrl] = useState("");
  const [organizationNames, setOrganizationNames] = useState<string[]>([]);
  const [organizationPermissions, setOrganizationPermissions] =
    useState<OrganizationPermissions | null>(null);
  const [organizationPermissionPath, setOrganizationPermissionPath] = useState("");
  const [projectName, setProjectName] = useState<string | null>(null);
  const [canReadStateVersions, setCanReadStateVersions] = useState(false);
  const [canReadVariable, setCanReadVariable] = useState(false);
  const [workspacePermissionPath, setWorkspacePermissionPath] = useState("");
  const [commandPaletteOpen, setCommandPaletteOpen] = useState(false);
  const [shortcutsModalOpen, setShortcutsModalOpen] = useState(false);
  const [visitsRevision, setVisitsRevision] = useState(0);
  // Tracks the pending "g" of a g-then-key sequence (gg / gh / gw). Cleared
  // after 1500ms, on a non-matching key, or when an overlay is open.
  const pendingGRef = useRef<number | null>(null);
  const docsIndex = useDocsIndex();

  useEffect(() => {
    applyTheme();
  }, []);

  useEffect((): void => {
    const main = document.getElementById("main-content");
    if (main instanceof HTMLElement) main.scrollTop = 0;
  }, [location.pathname]);

  useEffect((): void => {
    if (!commandPaletteOpen && !shortcutsModalOpen && !mobileNavigationOpen) {
      return;
    }
    // Any open overlay owns the keyboard; drop any half-typed sequence.
    if (pendingGRef.current !== null) {
      window.clearTimeout(pendingGRef.current);
      pendingGRef.current = null;
    }
  }, [commandPaletteOpen, shortcutsModalOpen, mobileNavigationOpen]);



  useEffect((): (() => void) => {
    const controller = new AbortController();
    const themeRevision = getThemeRevision();
    void Promise.allSettled([
      fetchApi("/api/v2/account/details", { signal: controller.signal }),
      fetchAllApiPages<{ attributes: { name: string } }>(
        "/organizations?page[size]=100",
        controller.signal,
      ),
    ]).then(([accountResult, organizationsResult]): void => {
      if (controller.signal.aborted) return;
      if (accountResult.status === "fulfilled") {
// SAFETY: the endpoint contract returns the JSON:API envelope with this data shape.
        const attributes = (accountResult.value as {
          data?: {
            attributes?: {
              "is-site-admin"?: boolean;
              "must-change-password"?: boolean;
              username?: string;
              "avatar-url"?: string;
              theme?: string;
            };
          };
        }).data?.attributes;
        setSiteAdmin(attributes?.["is-site-admin"] === true);
        setMustChangePassword(attributes?.["must-change-password"] === true);
        setAccountName(attributes?.username ?? "");
        setAvatarUrl(attributes?.["avatar-url"] ?? "");
        if (isString(attributes?.theme)) applyThemeIfUnchanged(attributes.theme, themeRevision);
      }
      if (organizationsResult.status === "fulfilled") {
        setOrganizationNames(
          organizationsResult.value.map((organization): string => organization.attributes.name),
        );
      }
    }).finally((): void => {
      if (!controller.signal.aborted) {
        setAccountLoaded(true);
      }
    });
    return (): void => {
      controller.abort();
    };
  }, [organizationRouteKey]);

  const workspaceMatch = matchPath(
    {
      path: "/app/:orgName/workspaces/:workspaceName/*",
      end: false,
    },
    location.pathname,
  ) ?? matchPath(
    {
      path: "/app/:orgName/workspaces/:workspaceName",
      end: true,
    },
    location.pathname,
  );
  const projectMatch =
    matchPath({ path: "/app/:orgName/projects/:projectId/*", end: false }, location.pathname)
    ?? matchPath({ path: "/app/:orgName/projects/:projectId", end: true }, location.pathname);
  const organizationMatch =
    workspaceMatch ??
    projectMatch ??
    matchPath({ path: "/app/:orgName/*", end: false }, location.pathname) ??
    matchPath({ path: "/app/:orgName", end: true }, location.pathname);
  const routeOrgName = readableRouteParam(organizationMatch?.params.orgName);
  const orgName =
    routeOrgName === "account" || routeOrgName === "admin" || routeOrgName === "docs"
      ? undefined
      : routeOrgName;
  const workspaceName = readableRouteParam(workspaceMatch?.params.workspaceName);
  const projectId = readableRouteParam(projectMatch?.params.projectId);
  const hasOrg = orgName !== undefined && orgName !== "";
  const hasWorkspace = hasOrg && workspaceName !== undefined && workspaceName !== "";
  const hasProject = hasOrg && projectId !== undefined && projectId !== "";
  const inAccountSettings = location.pathname === "/app/account";
  const inSiteAdministration =
    location.pathname === "/app/admin" || location.pathname.startsWith("/app/admin/");
  const inDocs =
    location.pathname === "/app/docs" || location.pathname.startsWith("/app/docs/");
  // The docs sidebar mirrors the view's default: the first document of the
  // index is highlighted when the route has no slug yet.
  const docsPathSlug = inDocs && location.pathname.startsWith("/app/docs/")
    ? readableRouteParam(location.pathname.slice("/app/docs/".length).split("/")[0])
    : undefined;
  const docsSlug = docsPathSlug === undefined || docsPathSlug === "" ? undefined : docsPathSlug;
  const selectedDocsSlug = docsSlug ?? docsIndex.index?.[0]?.slug;
  const orgPath = hasOrg ? `/app/${encodeURIComponent(orgName)}` : "/app";

  const toggleSidebar = useCallback((): void => {
    setSidebarCollapsed((collapsed: boolean): boolean => {
      const next = !collapsed;
      writeSidebarCollapsed(next);
      return next;
    });
  }, []);

  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent): void => {
      // Never intercept typing inside form controls or contenteditable.
      const target = e.target;
      const inTextField = target instanceof HTMLInputElement
        || target instanceof HTMLTextAreaElement
        || target instanceof HTMLSelectElement
        || (target instanceof HTMLElement && target.isContentEditable);

      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") {
        e.preventDefault();
        setCommandPaletteOpen((prev) => !prev);
        return;
      }
      if (e.key === "?" && !inTextField) {
        e.preventDefault();
        setShortcutsModalOpen((prev) => !prev);
        return;
      }
      // Overlay-aware guard: while the palette, the shortcuts help, or the
      // mobile drawer is open, they own the keyboard. Don't start sequences,
      // and don't hijack Escape away from the dialog's own close handling.
      const overlayOpen = commandPaletteOpen || shortcutsModalOpen || mobileNavigationOpen;
      if (overlayOpen || inTextField || e.metaKey || e.ctrlKey || e.altKey) {
        if (e.key === "g" && pendingGRef.current !== null) {
          window.clearTimeout(pendingGRef.current);
          pendingGRef.current = null;
        }
        return;
      }
      if (pendingGRef.current !== null && (e.key === "h" || e.key === "w")) {
        window.clearTimeout(pendingGRef.current);
        pendingGRef.current = null;
        e.preventDefault();
        if (e.key === "h") navigate("/app/account");
        else navigate(hasOrg ? `${orgPath}/workspaces` : "/app");
        return;
      }

      if (e.key === "g") {
        pendingGRef.current = window.setTimeout((): void => {
          pendingGRef.current = null;
        }, 1500);
        return;
      }
      if (pendingGRef.current !== null) {
        // A sequence was pending but this key doesn't complete one.
        window.clearTimeout(pendingGRef.current);
        pendingGRef.current = null;
        return;
      }

      switch (e.key.toLowerCase()) {
        case "/":
          e.preventDefault();
          setCommandPaletteOpen(true);
          break;
        case "[":
          toggleSidebar();
          break;
        case "escape": {
          // Overlays are already closed here (the guard above returns while
          // any is open, and Base UI owns dialog Escape); just drop a
          // half-typed sequence.
          if (pendingGRef.current !== null) {
            window.clearTimeout(pendingGRef.current);
            pendingGRef.current = null;
          }
          break;
        }
        default:
          break;
      }
    };

    window.addEventListener("keydown", handleKeyDown);
    return (): void => {
      window.removeEventListener("keydown", handleKeyDown);
    };
    // hasOrg/orgPath are stable per-route values used by the g-sequences.
  }, [navigate, commandPaletteOpen, shortcutsModalOpen, mobileNavigationOpen, hasOrg, orgPath, toggleSidebar]);

  // Remember the last organization the operator worked in so a fresh page
  // load (or the next visit) can resume there instead of the org picker.
  useEffect((): void => {
    if (hasOrg && orgName !== undefined && orgName !== "") {
      setLastOrganization(orgName);
    }
  }, [hasOrg, orgName]);

  // Pin toggles happen on the Workspaces page (a different component), so the
  // sidebar refreshes when shortcut storage changes anywhere (26.12). This
  // subscription is registered before the visit effect so mount-time visits
  // are captured; recordWorkspaceVisit notifies synchronously.
  useEffect((): (() => void) => subscribeWorkspaceShortcuts((): void => {
    setVisitsRevision((value: number): number => value + 1);
  }), []);

  // Record workspace visits for the sidebar "Recent" section (kanban 26.11).
  // The revision bump comes from the subscription above via the synchronous
  // shortcut notification, so no direct state set is needed here.
  useEffect((): void => {
    if (hasWorkspace && orgName !== undefined && orgName !== "" && workspaceName !== undefined && workspaceName !== "") {
      recordWorkspaceVisit(orgName, workspaceName);
    }
  }, [hasWorkspace, orgName, workspaceName]);
  const workspacePath = hasWorkspace
    ? `${orgPath}/workspaces/${encodeURIComponent(workspaceName)}`
    : "";
  const projectPath = hasProject
    ? `${orgPath}/projects/${encodeURIComponent(projectId)}`
    : "";
  const settingsPath = `${workspacePath}/settings`;
  const inWorkspaceSettings =
    hasWorkspace && isActivePath(location.pathname, settingsPath);
  const projectSettingsPath = `${projectPath}/settings`;
  const inProjectSettings =
    hasProject && isActivePath(location.pathname, projectSettingsPath);
  const organizationSettingsPath = `${orgPath}/settings`;
  const organizationSettingsTab = new URLSearchParams(location.search).get("tab");
  const inOrganizationSettings = hasOrg
    && !hasWorkspace
    && (
      isActivePath(location.pathname, organizationSettingsPath)
      || location.pathname === `${orgPath}/variable-sets`
    );
  const currentOrgName = orgName ?? "Choose an organization";

  const computedTitle = hasWorkspace
    ? `${workspaceName} · ${currentOrgName}`
    : hasOrg
      ? currentOrgName
      : inAccountSettings
        ? "Account Settings"
        : inSiteAdministration
          ? "Site Administration"
          : location.pathname === "/app/docs" || location.pathname.startsWith("/app/docs/")
            ? "Documentation"
            : "Organizations";

  usePageTitle(computedTitle);

  const hasCurrentOrganizationPermissions = organizationPermissionPath === orgPath;
  const canManageWorkspaces =
    hasCurrentOrganizationPermissions
    && organizationPermissions?.["can-manage-workspaces"] === true;
  const canManageVcsSettings =
    hasCurrentOrganizationPermissions
    && organizationPermissions?.["can-manage-vcs-settings"] === true;
  const canManageAgentPools =
    hasCurrentOrganizationPermissions
    && organizationPermissions?.["can-manage-agent-pools"] === true;
  const canManagePolicies =
    hasCurrentOrganizationPermissions
    && (organizationPermissions?.["can-manage-policies"] === true
      || organizationPermissions?.["can-read-policies"] === true);
  const canReadProjects =
    hasCurrentOrganizationPermissions
    && organizationPermissions?.["can-read-projects"] === true;
  const hasCurrentWorkspacePermissions = workspacePermissionPath === workspacePath;
  const [capabilities, setCapabilities] = useState<Capabilities>(DEFAULT_CAPABILITIES);

  useEffect((): (() => void) | undefined => {
    const cached = hasOrg ? orgPermissionsCache.get(orgName) : undefined;
    if (cached !== undefined && cached.expires > Date.now()) {
      setOrganizationPermissions(cached.permissions ?? null);
      setOrganizationPermissionPath(orgPath);
      return undefined;
    }
    setOrganizationPermissions(null);
    setOrganizationPermissionPath("");
    setCapabilities(DEFAULT_CAPABILITIES);
    if (!hasOrg) return undefined;
    const controller = new AbortController();
    void fetchApi<{ data?: { attributes?: { permissions?: OrganizationPermissions; capabilities?: Capabilities } } }>(`/organizations/${encodeURIComponent(orgName)}`, {
      signal: controller.signal,
    }).then((response): void => {
      if (controller.signal.aborted) return;
      const attributes = response.data?.attributes;
      const perms = attributes?.permissions ?? null;
      if (hasOrg) orgPermissionsCache.set(orgName, { permissions: perms as Readonly<Record<string, boolean>> | undefined, expires: Date.now() + ORG_CACHE_TTL_MS });
      setOrganizationPermissions(perms);
      setCapabilities(attributes?.capabilities ?? DEFAULT_CAPABILITIES);
      setOrganizationPermissionPath(orgPath);
    }).catch((): void => {
      // Management nav hidden when permissions fail
    });

    return (): void => {
      controller.abort();
    };
  }, [hasOrg, orgName, orgPath]);

  useEffect((): (() => void) | undefined => {
    setCanReadStateVersions(false);
    setCanReadVariable(false);
    setWorkspacePermissionPath("");
    if (!hasWorkspace) return undefined;

    const controller = new AbortController();
    void fetchApi<{ data?: { attributes?: { permissions?: { "can-read-state-versions"?: boolean; "can-read-variable"?: boolean } } } }>(
      `/organizations/${encodeURIComponent(orgName)}/workspaces/${encodeURIComponent(workspaceName)}`,
      { signal: controller.signal },
    ).then((response): void => {
      if (controller.signal.aborted) return;
      const permissions = response.data?.attributes?.permissions;
      setCanReadStateVersions(permissions?.["can-read-state-versions"] === true);
      setCanReadVariable(permissions?.["can-read-variable"] === true);
      setWorkspacePermissionPath(workspacePath);
    }).catch((): void => {
      // Permission-based navigation hidden on error
    });

    return (): void => { controller.abort(); };
  }, [hasWorkspace, orgName, workspaceName, workspacePath]);

  useEffect((): (() => void) | undefined => {
    setProjectName(null);
    if (!hasProject || projectId === undefined) return undefined;

    const controller = new AbortController();
    void fetchApi<{ data?: { attributes?: { name?: unknown } } }>(`/projects/${encodeURIComponent(projectId)}`, {
      signal: controller.signal,
    }).then((response): void => {
      if (controller.signal.aborted) return;
      const name = response.data?.attributes?.name;
      setProjectName(isString(name) && name !== "" ? name : projectId ?? "");
    }).catch((): void => {
      setProjectName(projectId ?? "");
    });

    return (): void => { controller.abort(); };
  }, [hasProject, projectId]);

  const closeMobileNavigation = (): void => {
    setMobileNavigationOpen(false);
  };

  const handleLogout = (): void => {
    void logoutAuthSession().finally((): void => {
      void navigate("/login");
    });
  };

  const renderNavigation = (): JSX.Element => {
    if (inSiteAdministration && siteAdmin) {
      const groups = [
        {
          label: "Overview",
          links: [
            { active: location.pathname === "/app/admin", icon: ShieldCheck, label: "Site overview", to: "/app/admin" },
          ],
        },
        {
          label: "Identity & access",
          links: [
            { active: isActivePath(location.pathname, "/app/admin/users"), icon: Users, label: "Users", to: "/app/admin/users" },
            { active: isActivePath(location.pathname, "/app/admin/auth"), icon: KeyRound, label: "Authentication", to: "/app/admin/auth" },
            { active: isActivePath(location.pathname, "/app/admin/scim"), icon: UserCog, label: "SCIM", to: "/app/admin/scim" },
          ],
        },
        {
          label: "Infrastructure",
          links: [
            { active: isActivePath(location.pathname, "/app/admin/organizations"), icon: Building2, label: "Organizations", to: "/app/admin/organizations" },
            { active: isActivePath(location.pathname, "/app/admin/workspaces"), icon: Box, label: "Workspaces", to: "/app/admin/workspaces" },
            { active: isActivePath(location.pathname, "/app/admin/runs"), icon: PlayCircle, label: "System runs", to: "/app/admin/runs" },
            { active: isActivePath(location.pathname, "/app/admin/versions"), icon: FileCode, label: "Tool versions", to: "/app/admin/versions" },
            { active: isActivePath(location.pathname, "/app/admin/compatibility"), icon: ShieldCheck, label: "Provider compatibility", to: "/app/admin/compatibility" },
          ],
        },
        {
          label: "Operations",
          links: [
            { active: isActivePath(location.pathname, "/app/admin/audit"), icon: HistoryIcon, label: "Audit logs", to: "/app/admin/audit" },
            { active: isActivePath(location.pathname, "/app/admin/logging"), icon: SlidersHorizontal, label: "Logging", to: "/app/admin/logging" },
            { active: isActivePath(location.pathname, "/app/admin/maintenance"), icon: CalendarClock, label: "Maintenance windows", to: "/app/admin/maintenance" },
            { active: isActivePath(location.pathname, "/app/admin/approval-webhook"), icon: Webhook, label: "Approval webhook", to: "/app/admin/approval-webhook" },
            { active: isActivePath(location.pathname, "/app/admin/plan-explainer"), icon: Sparkles, label: "AI plan explainer", to: "/app/admin/plan-explainer" },
            { active: isActivePath(location.pathname, "/app/admin/smtp"), icon: Mail, label: "SMTP settings", to: "/app/admin/smtp" },
            { active: isActivePath(location.pathname, "/app/admin/database"), icon: Database, label: "Database", to: "/app/admin/database" },
          ],
        },
      ] as const;

      return (
        <>
          <SidebarNavLink
            active={false}
            collapsed={sidebarCollapsed}
            icon={ArrowLeft}
            label="Organizations"
            onNavigate={closeMobileNavigation}
            to="/app"
          />
          <SidebarContextLabel collapsed={sidebarCollapsed} tone="secondary">
            Site administration
          </SidebarContextLabel>
          {groups.map((group): JSX.Element => (
            <div key={group.label}>
              <SidebarGroupLabel collapsed={sidebarCollapsed}>{group.label}</SidebarGroupLabel>
              {group.links.map((link): JSX.Element => (
                <SidebarNavLink
                  key={link.to}
                  active={link.active}
                  collapsed={sidebarCollapsed}
                  icon={link.icon}
                  label={link.label}
                  onNavigate={closeMobileNavigation}
                  to={link.to}
                />
              ))}
            </div>
          ))}
        </>
      );
    }

    if (inAccountSettings) {
      const links = mustChangePassword === true ? [
        {
          active: true,
          icon: Lock,
          label: "Password",
          to: "/app/account#password",
        },
      ] as const : [
        {
          active: location.hash === "" || location.hash === "#profile",
          icon: UserRound,
          label: "Profile",
          to: "/app/account#profile",
        },
        {
          active: location.hash === "#appearance",
          icon: Palette,
          label: "Appearance",
          to: "/app/account#appearance",
        },
        {
          active: location.hash === "#sessions",
          icon: MonitorSmartphone,
          label: "Sessions",
          to: "/app/account#sessions",
        },
        {
          active: location.hash === "#password",
          icon: Lock,
          label: "Password",
          to: "/app/account#password",
        },
        {
          active: location.hash === "#api-tokens",
          icon: KeyRound,
          label: "API tokens",
          to: "/app/account#api-tokens",
        },
      ] as const;

      return (
        <>
          <SidebarNavLink
            active={false}
            collapsed={sidebarCollapsed}
            icon={ArrowLeft}
            label="Organizations"
            onNavigate={closeMobileNavigation}
            to="/app"
          />
          <SidebarContextLabel collapsed={sidebarCollapsed} tone="secondary">
            Account settings
          </SidebarContextLabel>
          {links.map((link): JSX.Element => (
            <SidebarNavLink
              key={link.to}
              active={link.active}
              collapsed={sidebarCollapsed}
              icon={link.icon}
              label={link.label}
              onNavigate={closeMobileNavigation}
              to={link.to}
            />
          ))}
        </>
      );
    }

    if (hasWorkspace && inWorkspaceSettings) {
      // Grouped by what you came here to change, not by internal subsystem:
      // the workspace object itself, what makes its runs happen, who can
      // reach it, and where it reports to.
      const groups = [
        {
          label: "Workspace",
          links: [
            { label: "General", to: `${settingsPath}/general`, icon: Settings },
            { label: "Locking", to: `${settingsPath}/lock`, icon: Lock },
            { label: "Data retention", to: `${settingsPath}/retention`, icon: HistoryIcon },
            { label: "Destruction and deletion", to: `${settingsPath}/delete`, icon: Trash2 },
          ],
        },
        {
          label: "Runs",
          links: [
            { label: "Version control", to: `${settingsPath}/version-control`, icon: GitBranch },
            { label: "Configuration versions", to: `${settingsPath}/configuration-versions`, icon: FileCode },
            { label: "Run triggers", to: `${settingsPath}/run-triggers`, icon: GitPullRequest },
            { label: "Run tasks", to: `${settingsPath}/tasks`, icon: ListTodo },
            { label: "Policies", to: `${settingsPath}/policies`, icon: ShieldCheck },
            { label: "Health assessments", to: `${settingsPath}/health`, icon: Activity },
          ],
        },
        {
          label: "Access",
          links: [
            { label: "Team access", to: `${settingsPath}/team-access`, icon: Users },
            { label: "SSH key", to: `${settingsPath}/ssh`, icon: KeyRound },
          ],
        },
        {
          label: "Integrations",
          links: [
            { label: "Notifications", to: `${settingsPath}/notifications`, icon: Bell },
            { label: "Webhooks", to: `${settingsPath}/webhooks`, icon: SlidersHorizontal },
          ],
        },
      ] as const;

      return (
        <>
          <SidebarNavLink
            active={false}
            collapsed={sidebarCollapsed}
            icon={ArrowLeft}
            label={workspaceName}
            onNavigate={closeMobileNavigation}
            to={workspacePath}
          />
          <SidebarContextLabel collapsed={sidebarCollapsed} tone="secondary">
            Workspace settings
          </SidebarContextLabel>
          {groups.map((group): JSX.Element => (
            <div key={group.label}>
              <SidebarGroupLabel collapsed={sidebarCollapsed}>{group.label}</SidebarGroupLabel>
              {group.links.map((link): JSX.Element => (
                <SidebarNavLink
                  key={link.to}
                  active={
                    link.label === "General"
                      ? location.pathname === settingsPath ||
                        isActivePath(location.pathname, link.to)
                      : isActivePath(location.pathname, link.to)
                  }
                  collapsed={sidebarCollapsed}
                  icon={link.icon}
                  label={link.label}
                  onNavigate={closeMobileNavigation}
                  to={link.to}
                />
              ))}
            </div>
          ))}
        </>
      );
    }

    if (hasWorkspace) {
      const links = ([
        { label: "Overview", to: workspacePath, icon: LayoutDashboard, exact: true },
        { label: "Runs", to: `${workspacePath}/runs`, icon: ListChecks },
        { label: "States", to: `${workspacePath}/states`, icon: Database },
        { label: "Variables", to: `${workspacePath}/variables`, icon: Variable },
        { label: "Settings", to: `${settingsPath}/general`, icon: Settings, trailing: true },
      ] as const).filter((link): boolean =>
        (link.label !== "States" || (hasCurrentWorkspacePermissions && canReadStateVersions))
        && (link.label !== "Variables" || (hasCurrentWorkspacePermissions && canReadVariable)));

      return (
        <>
          <SidebarNavLink
            active={false}
            collapsed={sidebarCollapsed}
            icon={ArrowLeft}
            label="Workspaces"
            onNavigate={closeMobileNavigation}
            to={`${orgPath}/workspaces`}
          />
          <SidebarContextLabel collapsed={sidebarCollapsed} title={workspaceName}>
            {workspaceName}
          </SidebarContextLabel>
          {links.map((link): JSX.Element => (
            <SidebarNavLink
              key={link.to}
              active={isActivePath(
                location.pathname,
                link.to,
                "exact" in link && link.exact,
              )}
              collapsed={sidebarCollapsed}
              icon={link.icon}
              label={link.label}
              onNavigate={closeMobileNavigation}
              to={link.to}
              trailing={"trailing" in link && link.trailing}
            />
          ))}
        </>
      );
    }

    if (hasProject) {
      const projectLinks = inProjectSettings
        ? ([
            {
              active: location.pathname === projectSettingsPath,
              icon: Settings,
              label: "General",
              to: projectSettingsPath,
            },
            {
              active: location.pathname === `${projectSettingsPath}/variable-sets`,
              icon: Variable,
              label: "Variable sets",
              to: `${projectSettingsPath}/variable-sets`,
            },
            {
              active: location.pathname === `${projectSettingsPath}/notifications`,
              icon: Bell,
              label: "Notifications",
              to: `${projectSettingsPath}/notifications`,
            },
          ] as const)
        : ([
            {
              active: location.pathname === projectPath,
              icon: LayoutDashboard,
              label: "Overview",
              to: projectPath,
            },
            {
              active: isActivePath(location.pathname, `${projectPath}/workspaces`),
              icon: Box,
              label: "Workspaces",
              to: `${projectPath}/workspaces`,
            },
            {
              active: isActivePath(location.pathname, projectSettingsPath),
              icon: Settings,
              label: "Settings",
              to: projectSettingsPath,
              trailing: true,
            },
          ] as const);

      return (
        <>
          <SidebarNavLink
            active={false}
            collapsed={sidebarCollapsed}
            icon={ArrowLeft}
            label="Projects"
            onNavigate={closeMobileNavigation}
            to={`${orgPath}/projects`}
          />
          <SidebarContextLabel collapsed={sidebarCollapsed} title={projectName ?? projectId}>
            {projectName ?? projectId}
          </SidebarContextLabel>
          {inProjectSettings && (
            <SidebarContextLabel collapsed={sidebarCollapsed} tone="secondary">
              Project settings
            </SidebarContextLabel>
          )}
          {projectLinks.map((link): JSX.Element => (
            <SidebarNavLink
              key={link.to}
              active={link.active}
              collapsed={sidebarCollapsed}
              icon={link.icon}
              label={link.label}
              onNavigate={closeMobileNavigation}
              to={link.to}
              trailing={"trailing" in link && link.trailing}
            />
          ))}
        </>
      );
    }

    if (inOrganizationSettings) {
      const links = ([
        {
          active: location.pathname === organizationSettingsPath
            && organizationSettingsTab !== "teams"
            && organizationSettingsTab !== "roles"
            && organizationSettingsTab !== "cidr"
            && organizationSettingsTab !== "tags"
            && organizationSettingsTab !== "users"
            && organizationSettingsTab !== "ssh-keys",
          icon: Settings,
          label: "General",
          to: organizationSettingsPath,
        },
        {
          active: location.pathname === organizationSettingsPath
            && organizationSettingsTab === "teams",
          icon: Users,
          label: "Teams",
          to: `${organizationSettingsPath}?tab=teams`,
        },
        {
          active: location.pathname === organizationSettingsPath
            && organizationSettingsTab === "roles",
          icon: Users,
          label: "Roles",
          to: `${organizationSettingsPath}?tab=roles`,
        },
        {
          active: location.pathname === organizationSettingsPath
            && organizationSettingsTab === "tags",
          icon: Tag,
          label: "Tags",
          to: `${organizationSettingsPath}?tab=tags`,
        },
        {
          active: location.pathname === organizationSettingsPath
            && organizationSettingsTab === "users",
          icon: Users,
          label: "Users",
          to: `${organizationSettingsPath}?tab=users`,
        },
        {
          active: location.pathname === organizationSettingsPath
            && organizationSettingsTab === "cidr",
          icon: ShieldCheck,
          label: "IP allowlists",
          to: `${organizationSettingsPath}?tab=cidr`,
        },
        {
          active: location.pathname === organizationSettingsPath
            && organizationSettingsTab === "ssh-keys",
          icon: KeyRound,
          label: "SSH keys",
          to: `${organizationSettingsPath}?tab=ssh-keys`,
        },
        {
          active: location.pathname === `${orgPath}/variable-sets`,
          icon: Variable,
          label: "Variable sets",
          to: `${orgPath}/variable-sets`,
        },
        {
          active: location.pathname === `${organizationSettingsPath}/vcs`,
          icon: GitBranch,
          label: "VCS providers",
          to: `${organizationSettingsPath}/vcs`,
        },
        {
          active: location.pathname === `${organizationSettingsPath}/agents`,
          icon: Activity,
          label: "Agent pools",
          to: `${organizationSettingsPath}/agents`,
        },
        {
          // Active on the list and detail pages, but NOT on the tag-selector
          // sibling (`.../policy-sets/tags`), which has its own nav item.
          active: isActivePath(location.pathname, `${organizationSettingsPath}/policy-sets`)
            && !location.pathname.startsWith(`${organizationSettingsPath}/policy-sets/tags`),
          icon: ShieldCheck,
          label: "Policy sets",
          to: `${organizationSettingsPath}/policy-sets`,
        },
        {
          active: isActivePath(location.pathname, `${organizationSettingsPath}/policy-sets/tags`),
          icon: Tags,
          label: "Tag policy sets",
          to: `${organizationSettingsPath}/policy-sets/tags`,
        },
        {
          active: isActivePath(location.pathname, `${organizationSettingsPath}/oidc`),
          icon: Fingerprint,
          label: "OIDC",
          to: `${organizationSettingsPath}/oidc`,
        },
        {
          active: isActivePath(location.pathname, `${organizationSettingsPath}/stacks-workspaces`),
          icon: Layers,
          label: "Stacks",
          to: `${organizationSettingsPath}/stacks-workspaces`,
        },
      ] as const).filter((link): boolean =>
        (link.label !== "Variable sets" || canManageWorkspaces)
        && (link.label !== "VCS providers" || canManageVcsSettings)
        && (link.label !== "Agent pools" || canManageAgentPools)
        && (link.label !== "Policy sets" || canManagePolicies)
        && (link.label !== "Tag policy sets" || canManagePolicies)
        && (link.label !== "OIDC" || canManagePolicies)
        && (link.label !== "Stacks" || canManageWorkspaces));

      // Fourteen flat links is a wall. Group them the same way workspace and
      // site-admin settings are grouped, and drop groups the viewer can't use.
      const groups = ([
        { label: "Organization", members: ["General", "Tags"] },
        { label: "People", members: ["Users", "Teams", "Roles"] },
        { label: "Infrastructure", members: ["Variable sets", "VCS providers", "Agent pools", "Stacks"] },
        { label: "Policies", members: ["Policy sets", "Tag policy sets"] },
        { label: "Security", members: ["IP allowlists", "SSH keys", "OIDC"] },
      ] as const)
        .map((group): { label: string; links: typeof links } => ({
          label: group.label,
          links: group.members.flatMap((member): typeof links =>
            links.filter((link): boolean => link.label === member)),
        }))
        .filter((group): boolean => group.links.length > 0);

      return (
        <>
          <SidebarNavLink
            active={false}
            collapsed={sidebarCollapsed}
            icon={ArrowLeft}
            label={currentOrgName}
            onNavigate={closeMobileNavigation}
            to={`${orgPath}/workspaces`}
          />
          <SidebarContextLabel collapsed={sidebarCollapsed} tone="secondary">
            Organization settings
          </SidebarContextLabel>
          {groups.map((group): JSX.Element => (
            <div key={group.label}>
              <SidebarGroupLabel collapsed={sidebarCollapsed}>{group.label}</SidebarGroupLabel>
              {group.links.map((link): JSX.Element => (
                <SidebarNavLink
                  key={link.to}
                  active={link.active}
                  collapsed={sidebarCollapsed}
                  icon={link.icon}
                  label={link.label}
                  onNavigate={closeMobileNavigation}
                  to={link.to}
                />
              ))}
            </div>
          ))}
        </>
      );
    }

    if (hasOrg) {
      const links = ([
        { label: "Projects", to: `${orgPath}/projects`, icon: FolderGit2 },
        { label: "Workspaces", to: `${orgPath}/workspaces`, icon: Box },
        { label: "Registry", to: `${orgPath}/registry`, icon: Package },
        { label: "Settings", to: `${orgPath}/settings`, icon: Settings, trailing: true },
      ] as const).filter((link): boolean =>
        link.label !== "Projects" || canReadProjects);

      // Sidebar shortcuts are re-read on every navigation (visitsRevision
      // bumps when a workspace is visited, so the list stays current).
      void visitsRevision;
      const pinned = getPinnedWorkspaces().filter((entry): boolean => entry.orgName === orgName);
      const recent = getRecentWorkspaces()
        .filter((entry): boolean => entry.orgName === orgName)
        .filter((entry): boolean => !pinned.some((pinnedEntry): boolean => pinnedEntry.workspaceName === entry.workspaceName))
        .slice(0, 4);

      const shortcutLinks = [...pinned, ...recent].map((entry) => ({
        label: entry.workspaceName,
        to: `/app/${encodeURIComponent(orgName)}/workspaces/${encodeURIComponent(entry.workspaceName)}`,
        icon: Box,
      }));

      return (
        <>
          {shortcutLinks.length > 0 && (
            <>
              <div
                className={cn(
                  "px-3 pb-2 pt-3 text-xs font-semibold text-muted-foreground",
                  sidebarCollapsed && "lg:sr-only",
                )}
              >
                {pinned.length > 0 ? "Pinned & recent" : "Recent"}
              </div>
              {shortcutLinks.map((link): JSX.Element => (
                <SidebarNavLink
                  key={link.to}
                  active={false}
                  collapsed={sidebarCollapsed}
                  icon={link.icon}
                  label={link.label}
                  onNavigate={closeMobileNavigation}
                  to={link.to}
                />
              ))}
            </>
          )}
          <div
            className={cn(
              "px-3 pb-2 pt-3 text-xs font-semibold text-muted-foreground",
              sidebarCollapsed && "lg:sr-only",
            )}
          >
            Manage
          </div>
          {links.map((link): JSX.Element => (
            <SidebarNavLink
              key={link.to}
              active={
                link.label === "Workspaces"
                  ? location.pathname === orgPath ||
                    location.pathname === link.to
                  : isActivePath(location.pathname, link.to)
              }
              collapsed={sidebarCollapsed}
              icon={link.icon}
              label={link.label}
              onNavigate={closeMobileNavigation}
              to={link.to}
              trailing={"trailing" in link && link.trailing}
            />
          ))}
        </>
      );
    }

    if (inDocs) {
      return (
        <DocsSidebarNav
          index={docsIndex.index}
          selectedSlug={selectedDocsSlug}
          collapsed={sidebarCollapsed}
          onNavigate={closeMobileNavigation}
        />
      );
    }

    return (
      <>
        <SidebarNavLink
          active={location.pathname === "/app"}
          collapsed={sidebarCollapsed}
          icon={Building2}
          label="Organizations"
          onNavigate={closeMobileNavigation}
          to="/app"
        />
      </>
    );
  };

  return (
    <div className="flex h-dvh w-full flex-col bg-background font-sans text-foreground">
      <a
        href="#main-content"
        className="sr-only focus:fixed focus:left-4 focus:top-2 focus:z-50 focus:not-sr-only focus:rounded-md focus:bg-background focus:px-3 focus:py-2 focus:text-sm focus:font-medium focus:text-foreground focus:ring-2 focus:ring-ring"
      >
        Skip to main content
      </a>

      <header className="flex h-[52px] shrink-0 items-center justify-between bg-topbar px-2 text-topbar-foreground sm:px-4">
          <div className="flex min-w-0 items-center gap-2 sm:gap-4">
            <Dialog open={mobileNavigationOpen} onOpenChange={setMobileNavigationOpen}>
              <DialogTrigger render={
                <Button
                  variant="ghost"
                  size="icon"
                  className="text-topbar-foreground hover:bg-topbar-foreground/10 hover:text-topbar-foreground lg:hidden"
                  aria-label="Open navigation"
                  aria-controls="mobile-app-sidebar"
                >
                  <Menu data-icon="inline-start" />
                </Button>
              } />
              <DrawerContent
                id="mobile-app-sidebar"
                aria-describedby={undefined}
                className="top-[52px] bottom-0 h-[calc(100dvh-52px)] max-w-none rounded-none border-y-0 p-0 gap-0 lg:hidden"
              >
                <DialogTitle className="sr-only">Application navigation</DialogTitle>
                <nav aria-label="Application navigation" className="flex flex-1 flex-col gap-0.5 overflow-y-auto p-3 pt-12">
                  {renderNavigation()}
                </nav>
              </DrawerContent>
            </Dialog>

            <Link
              to="/app"
              aria-label="Home"
                className="flex shrink-0 items-center justify-center rounded outline-none transition-opacity hover:opacity-80 focus-visible:ring-2 focus-visible:ring-topbar-foreground"
            >
              <img src="/favicon.svg" alt="" aria-hidden="true" className="size-7" />
            </Link>

            <div aria-hidden="true" className="hidden h-5 w-px bg-topbar-foreground/20 sm:block" />

            {hasOrg ? (
              <DropdownMenu>
                <DropdownMenuTrigger
                  render={(
                    <Button
                      variant="ghost"
                      className="min-w-0 max-w-32 shrink text-topbar-foreground hover:bg-topbar-foreground/10 hover:text-topbar-foreground sm:max-w-56"
                      aria-label={`Organization menu for ${currentOrgName}`}
                    />
                  )}
                >
                  <Building2 data-icon="inline-start" />
                  <span className="truncate">{currentOrgName}</span>
                  <ChevronDown data-icon="inline-end" />
                </DropdownMenuTrigger>
                <DropdownMenuContent align="start" className="w-56">
                  <DropdownMenuGroup>
                    <DropdownMenuLabel>Organization</DropdownMenuLabel>
                    <DropdownMenuItem
                      onClick={(): void => {
                        void navigate(`${orgPath}/workspaces`);
                      }}
                    >
                      Workspaces
                    </DropdownMenuItem>
                    {organizationNames.some((name): boolean => name !== orgName) && (
                      <>
                        <DropdownMenuSeparator />
                        <DropdownMenuLabel>Switch organization</DropdownMenuLabel>
                        {organizationNames
                          .filter((name): boolean => name !== orgName)
                          .map((name): JSX.Element => (
                            <DropdownMenuItem
                              key={name}
                              onClick={(): void => {
                                void navigate(`/app/${encodeURIComponent(name)}/workspaces`);
                              }}
                            >
                              {name}
                            </DropdownMenuItem>
                          ))}
                      </>
                    )}
                    <DropdownMenuSeparator />
                    <DropdownMenuItem
                      onClick={(): void => {
                        void navigate("/app");
                      }}
                    >
                      All organizations
                    </DropdownMenuItem>
                  </DropdownMenuGroup>
                </DropdownMenuContent>
              </DropdownMenu>
            ) : (
              <Link
                to="/app"
                className={cn(
                  buttonVariants({ variant: "ghost" }),
                  "min-w-0 max-w-32 shrink text-topbar-foreground hover:bg-topbar-foreground/10 hover:text-topbar-foreground sm:max-w-56",
                )}
              >
                <Building2 data-icon="inline-start" />
                <span className="truncate">{currentOrgName}</span>
              </Link>
            )}
          </div>

          <div className="flex shrink-0 items-center gap-1.5 sm:gap-2">
            {/* Command Palette Trigger */}
            <Button
              variant="ghost"
              size="sm"
              className="hidden sm:inline-flex items-center gap-2 text-topbar-foreground/80 hover:bg-topbar-foreground/10 hover:text-topbar-foreground border border-topbar-foreground/20 h-8 px-2.5"
              onClick={() => { setCommandPaletteOpen(true); }}
            >
              <Search className="size-3.5" />
              <span className="text-xs">Search…</span>
              <kbd className="pointer-events-none rounded bg-topbar-foreground/20 px-1.5 py-0.5 text-2xs font-mono font-medium text-topbar-foreground">
                ⌘K / Ctrl+K
              </kbd>
            </Button>

            {/* Help & Support */}
            <DropdownMenu>
              <DropdownMenuTrigger
                render={(
                  <Button
                    variant="ghost"
                    className="text-topbar-foreground hover:bg-topbar-foreground/10 hover:text-topbar-foreground h-8 px-2"
                    aria-label="Help and support"
                  />
                )}
              >
                <HelpCircle data-icon="inline-start" />
                <ChevronDown className="size-3.5" data-icon="inline-end" />
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end" className="w-56">
                <DropdownMenuGroup>
                  <DropdownMenuLabel>Help and support</DropdownMenuLabel>
                  <DropdownMenuItem onClick={() => { setShortcutsModalOpen(true); }}>
                    <Keyboard className="mr-2 size-4 text-muted-foreground" />
                    Keyboard shortcuts (?)
                  </DropdownMenuItem>
                  <DropdownMenuSeparator />
                  <DropdownMenuItem onClick={() => { navigate("/app/docs"); }}>
                    <BookOpen className="mr-2 size-4 text-muted-foreground" />
                    Documentation
                  </DropdownMenuItem>
                  <DropdownMenuItem
                    render={(
                      <a
                        href="https://github.com/essinghigh-org/terrence/issues"
                        target="_blank"
                        rel="noreferrer"
                      />
                    )}
                  >
                    <LifeBuoy className="mr-2 size-4 text-muted-foreground" />
                    Support
                  </DropdownMenuItem>
                </DropdownMenuGroup>
              </DropdownMenuContent>
            </DropdownMenu>

            {/* User Account Menu */}
            <DropdownMenu>
              <DropdownMenuTrigger
                render={(
                  <Button
                    variant="ghost"
                    className="text-topbar-foreground hover:bg-topbar-foreground/10 hover:text-topbar-foreground h-8 px-2"
                    aria-label="Account menu"
                  />
                )}
              >
                <Avatar className="size-6 rounded-full">
                  {avatarUrl !== "" ? (
                    <AvatarImage src={avatarUrl} alt={accountName} className="rounded-full object-cover" />
                  ) : (
                    <AvatarFallback className="rounded-full bg-topbar-foreground/15 text-topbar-foreground text-xs">
                      {accountName === ""
                        ? <UserRound aria-hidden="true" />
                        : accountName.slice(0, 2).toUpperCase()}
                    </AvatarFallback>
                  )}
                </Avatar>
                <ChevronDown className="size-3.5" data-icon="inline-end" />
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end" className="w-56">
                <DropdownMenuGroup>
                  <DropdownMenuLabel>{accountName === "" ? "My account" : accountName}</DropdownMenuLabel>
                  <DropdownMenuItem
                    onClick={(): void => {
                      void navigate("/app/account");
                    }}
                  >
                    Account settings
                  </DropdownMenuItem>
                  {siteAdmin && (
                    <DropdownMenuItem
                      onClick={(): void => {
                        void navigate("/app/admin");
                      }}
                    >
                      Site administration
                    </DropdownMenuItem>
                  )}
                </DropdownMenuGroup>
                <DropdownMenuSeparator />
                <DropdownMenuGroup>
                  <DropdownMenuItem variant="destructive" onClick={handleLogout}>
                    <LogOut />
                    Log out
                  </DropdownMenuItem>
                </DropdownMenuGroup>
              </DropdownMenuContent>
            </DropdownMenu>
          </div>
        </header>

      <div className="relative flex min-h-0 flex-1 overflow-hidden">
        <aside
          id="app-sidebar"
          aria-label="Application navigation"
          className={cn(
            "hidden shrink-0 flex-col border-r bg-muted/40 transition-[width] duration-200 lg:flex",
            sidebarCollapsed ? "lg:w-16" : "lg:w-[280px]",
          )}
        >
          {/* Width transitions on the aside would stretch the nav content
              mid-animation; a fixed overlay decouples the button from the
              animating box so it stays put and clickable throughout. */}
          <div className="pointer-events-none fixed bottom-0 z-10 hidden lg:block" style={{ width: sidebarCollapsed ? "4rem" : "17.5rem" }}>
            <div className="border-t p-3 pointer-events-auto">
              <Button
                variant="ghost"
                size={sidebarCollapsed ? "icon" : "default"}
                className={cn("w-full", !sidebarCollapsed && "justify-start")}
                aria-controls="app-sidebar"
                aria-expanded={!sidebarCollapsed}
                aria-label={sidebarCollapsed ? "Expand sidebar" : "Collapse sidebar"}
                title={sidebarCollapsed ? undefined : "["}
                onClick={toggleSidebar}
              >
                {sidebarCollapsed
                  ? <PanelLeftOpen data-icon="inline-start" />
                  : <PanelLeftClose data-icon="inline-start" />}
                {!sidebarCollapsed && <span>Collapse sidebar</span>}
              </Button>
            </div>
          </div>
          <nav className="flex flex-1 flex-col gap-0.5 overflow-y-auto p-3 pb-16">
            {renderNavigation()}
          </nav>
        </aside>

        <main
          id="main-content"
          tabIndex={-1}
          className="relative flex min-w-0 flex-1 flex-col overflow-auto bg-background outline-none"
        >
          <div className="w-full flex-1 px-4 py-6 sm:px-6 lg:px-8">
            <CapabilitiesProvider capabilities={capabilities}>
            {children ?? (
              <Outlet
                context={{
                  accountLoaded,
                  setMustChangePassword,
                  siteAdmin,
                } satisfies LayoutOutletContext}
              />
            )}
          </CapabilitiesProvider>
          </div>
        </main>
      </div>

      <CommandPalette
        open={commandPaletteOpen}
        onOpenChange={setCommandPaletteOpen}
        currentOrgName={orgName}
        currentWorkspaceName={workspaceName}
        canManageWorkspaces={canManageWorkspaces}
      />

      <ShortcutsHelpModal
        open={shortcutsModalOpen}
        onOpenChange={setShortcutsModalOpen}
      />
    </div>
  );
}
