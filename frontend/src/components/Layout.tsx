import { createElement, useEffect, useState, type JSX, type ReactNode } from "react";
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
  Box,
  Building2,
  ChevronDown,
  ChevronRight,
  Database,
  FolderGit2,
  GitBranch,
  GitPullRequest,
  HelpCircle,
  History as HistoryIcon,
  KeyRound,
  Keyboard,
  LayoutDashboard,
  ListChecks,
  ListTodo,
  Lock,
  LogOut,
  Menu,
  MonitorSmartphone,
  Package,
  PackageOpen,
  Fingerprint,
  PanelLeftClose,
  PanelLeftOpen,
  Palette,
  FileCode,
  PlayCircle,
  Search,
  Settings,
  ShieldCheck,
  Tag,
  Trash2,
  UserRound,
  Users,
  Variable,
  Boxes,
  Hourglass,
  Layers,
  Calendar,
  Tags,
  FileClock,
  Mail,
  SlidersHorizontal,
  UserCog,
  Share2,
  type LucideIcon,
} from "lucide-react";

import {
  Dialog,
  DialogContent,
  DialogTitle,
  DialogTrigger,
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
import { ShortcutsHelpModal } from "./ShortcutsHelpModal";
import { fetchAllApiPages, fetchApi, logoutAuthSession } from "../lib/api";
import { applyTheme, applyThemeIfUnchanged, getThemeRevision } from "../lib/theme";
import { usePageTitle } from "../lib/usePageTitle";
import { setLastOrganization } from "../lib/lastOrganization";
import { getPinnedWorkspaces, getRecentWorkspaces, recordWorkspaceVisit, subscribeWorkspaceShortcuts } from "../lib/workspace-shortcuts";
import { cn } from "../lib/utils";

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
}>;

type SidebarNavLinkProps = Readonly<{
  active: boolean;
  collapsed: boolean;
  icon: LucideIcon;
  label: string;
  onNavigate: () => void;
  to: string;
  trailing?: boolean;
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

function SidebarNavLink({
  active,
  collapsed,
  icon,
  label,
  onNavigate,
  to,
  trailing = false,
}: SidebarNavLinkProps): JSX.Element {
  return (
    <Link
      to={to}
      onClick={onNavigate}
      aria-current={active ? "page" : undefined}
      title={collapsed ? label : undefined}
      className={cn(
        "group flex min-h-9 items-center gap-3 rounded-md border-l-2 px-3 py-2 text-sm font-medium outline-none transition-colors focus-visible:ring-2 focus-visible:ring-ring",
        active
          ? "border-primary bg-primary/10 text-primary"
          : "border-transparent text-muted-foreground hover:bg-muted hover:text-foreground",
      )}
    >
      {createElement(icon, {
        "aria-hidden": true,
        className: "size-4 shrink-0",
      })}
      <span className={cn("truncate", collapsed && "lg:sr-only")}>{label}</span>
      {trailing && (
        <ChevronRight
          aria-hidden="true"
          className={cn("ml-auto size-4", collapsed && "lg:hidden")}
        />
      )}
    </Link>
  );
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

  useEffect(() => {
    applyTheme();
  }, []);

  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent): void => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") {
        e.preventDefault();
        setCommandPaletteOpen((prev) => !prev);
      } else if (
        e.key === "?" &&
        !(e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement)
      ) {
        e.preventDefault();
        setShortcutsModalOpen((prev) => !prev);
      }
    };

    window.addEventListener("keydown", handleKeyDown);
    return (): void => {
      window.removeEventListener("keydown", handleKeyDown);
    };
  }, []);

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
        if (typeof attributes?.theme === "string") applyThemeIfUnchanged(attributes.theme, themeRevision);
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
    routeOrgName === "account" || routeOrgName === "admin"
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
  const orgPath = hasOrg ? `/app/${encodeURIComponent(orgName)}` : "/app";

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

  useEffect((): (() => void) | undefined => {
    setOrganizationPermissions(null);
    setOrganizationPermissionPath("");
    if (!hasOrg) return undefined;
    const controller = new AbortController();
    void fetchApi(`/organizations/${encodeURIComponent(orgName)}`, {
      signal: controller.signal,
    }).then((response: unknown): void => {
      if (controller.signal.aborted) return;
      const permissions = (response as {
        data?: { attributes?: { permissions?: OrganizationPermissions } };
      }).data?.attributes?.permissions;
      setOrganizationPermissions(permissions ?? null);
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
    void fetchApi(
      `/organizations/${encodeURIComponent(orgName)}/workspaces/${encodeURIComponent(workspaceName)}`,
      { signal: controller.signal },
    ).then((response: unknown): void => {
      if (controller.signal.aborted) return;
      const permissions = (response as {
        data?: {
          attributes?: {
            permissions?: {
              "can-read-state-versions"?: boolean;
              "can-read-variable"?: boolean;
            };
          };
        };
      }).data?.attributes?.permissions;
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
    void fetchApi(`/projects/${encodeURIComponent(projectId)}`, {
      signal: controller.signal,
    }).then((response: unknown): void => {
      if (controller.signal.aborted) return;
      const name = (response as {
        data?: { attributes?: { name?: unknown } };
      }).data?.attributes?.name;
      setProjectName(typeof name === "string" && name !== "" ? name : projectId ?? "");
    }).catch((): void => {
      setProjectName(projectId ?? "");
    });

    return (): void => { controller.abort(); };
  }, [hasProject, projectId]);

  const closeMobileNavigation = (): void => {
    setMobileNavigationOpen(false);
  };

  const toggleSidebar = (): void => {
    setSidebarCollapsed((collapsed: boolean): boolean => {
      const next = !collapsed;
      writeSidebarCollapsed(next);
      return next;
    });
  };

  const handleLogout = (): void => {
    void logoutAuthSession().finally((): void => {
      void navigate("/login");
    });
  };

  const renderNavigation = (): JSX.Element => {
    if (inSiteAdministration && siteAdmin) {
      const links = [
        {
          active: location.pathname === "/app/admin",
          icon: ShieldCheck,
          label: "Security overview",
          to: "/app/admin",
        },
        {
          active: isActivePath(location.pathname, "/app/admin/users"),
          icon: Users,
          label: "Users",
          to: "/app/admin/users",
        },
        {
          active: isActivePath(location.pathname, "/app/admin/organizations"),
          icon: Building2,
          label: "Organizations",
          to: "/app/admin/organizations",
        },
        {
          active: isActivePath(location.pathname, "/app/admin/workspaces"),
          icon: Box,
          label: "Workspaces",
          to: "/app/admin/workspaces",
        },
        {
          active: isActivePath(location.pathname, "/app/admin/runs"),
          icon: PlayCircle,
          label: "System Runs",
          to: "/app/admin/runs",
        },
        {
          active: isActivePath(location.pathname, "/app/admin/versions"),
          icon: FileCode,
          label: "Tool Versions",
          to: "/app/admin/versions",
        },
        {
          active: isActivePath(location.pathname, "/app/admin/compatibility"),
          icon: ShieldCheck,
          label: "Provider compatibility",
          to: "/app/admin/compatibility",
        },
        {
          active: isActivePath(location.pathname, "/app/admin/audit"),
          icon: HistoryIcon,
          label: "Audit Logs",
          to: "/app/admin/audit",
        },
        {
          active: isActivePath(location.pathname, "/app/admin/auth"),
          icon: KeyRound,
          label: "Authentication",
          to: "/app/admin/auth",
        },
        {
          active: isActivePath(location.pathname, "/app/admin/smtp"),
          icon: Mail,
          label: "SMTP settings",
          to: "/app/admin/smtp",
        },
        {
          active: isActivePath(location.pathname, "/app/admin/scim"),
          icon: UserCog,
          label: "SCIM settings",
          to: "/app/admin/scim",
        },
        {
          active: isActivePath(location.pathname, "/app/admin/operations"),
          icon: SlidersHorizontal,
          label: "Operations",
          to: "/app/admin/operations",
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
          <div
            className={cn(
              "px-3 pb-2 pt-4 text-xs font-semibold text-muted-foreground",
              sidebarCollapsed && "lg:sr-only",
            )}
          >
            Site administration
          </div>
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

    if (inAccountSettings) {
      const links = mustChangePassword === false ? [
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
      ] as const : [
        {
          active: true,
          icon: Lock,
          label: "Password",
          to: "/app/account#password",
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
          <div
            className={cn(
              "px-3 pb-2 pt-4 text-xs font-semibold text-muted-foreground",
              sidebarCollapsed && "lg:sr-only",
            )}
          >
            Account settings
          </div>
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
      const links = [
        { label: "General", to: `${settingsPath}/general`, icon: Settings },
        { label: "Locking", to: `${settingsPath}/lock`, icon: Lock },
        { label: "Notifications", to: `${settingsPath}/notifications`, icon: Bell },
        { label: "Policies", to: `${settingsPath}/policies`, icon: ShieldCheck },
        { label: "Run Tasks", to: `${settingsPath}/tasks`, icon: ListTodo },
        { label: "Run triggers", to: `${settingsPath}/run-triggers`, icon: GitPullRequest },
        { label: "SSH Key", to: `${settingsPath}/ssh`, icon: KeyRound },
        { label: "Version Control", to: `${settingsPath}/version-control`, icon: GitBranch },
        { label: "Team access", to: `${settingsPath}/team-access`, icon: Users },
        { label: "Health assessments", to: `${settingsPath}/health`, icon: Activity },
        { label: "Data retention", to: `${settingsPath}/retention`, icon: HistoryIcon },
        { label: "Destruction and deletion", to: `${settingsPath}/delete`, icon: Trash2 },
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
          <div
            className={cn(
              "px-3 pb-2 pt-4 text-xs font-semibold text-muted-foreground",
              sidebarCollapsed && "lg:sr-only",
            )}
          >
            Workspace settings
          </div>
          {links.map((link): JSX.Element => (
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
          <div
            className={cn(
              "truncate px-3 pb-2 pt-4 text-xs font-semibold text-foreground",
              sidebarCollapsed && "lg:sr-only",
            )}
            title={workspaceName}
          >
            {workspaceName}
          </div>
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
          <div
            className={cn(
              "truncate px-3 pb-2 pt-4 text-xs font-semibold text-foreground",
              sidebarCollapsed && "lg:sr-only",
            )}
            title={projectName ?? projectId}
          >
            {projectName ?? projectId}
          </div>
          {inProjectSettings && (
            <div
              className={cn(
                "px-3 pb-2 pt-3 text-xs font-semibold text-muted-foreground",
                sidebarCollapsed && "lg:sr-only",
              )}
            >
              Project Settings
            </div>
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
          active: isActivePath(location.pathname, `${organizationSettingsPath}/provider-sets`),
          icon: Package,
          label: "Provider sets",
          to: `${organizationSettingsPath}/provider-sets`,
        },
        {
          active: isActivePath(location.pathname, `${organizationSettingsPath}/oidc`),
          icon: Fingerprint,
          label: "OIDC",
          to: `${organizationSettingsPath}/oidc`,
        },
        {
          active: isActivePath(location.pathname, `${organizationSettingsPath}/registry-providers`),
          icon: Boxes,
          label: "Registry providers",
          to: `${organizationSettingsPath}/registry-providers`,
        },
        {
          active: isActivePath(location.pathname, `${organizationSettingsPath}/registry-modules`),
          icon: PackageOpen,
          label: "Registry modules",
          to: `${organizationSettingsPath}/registry-modules`,
        },
        {
          active: isActivePath(location.pathname, `${organizationSettingsPath}/token-ttl`),
          icon: Hourglass,
          label: "Token TTL policies",
          to: `${organizationSettingsPath}/token-ttl`,
        },
        {
          active: isActivePath(location.pathname, `${organizationSettingsPath}/stacks-workspaces`),
          icon: Layers,
          label: "Stacks",
          to: `${organizationSettingsPath}/stacks-workspaces`,
        },
        {
          active: isActivePath(location.pathname, `${organizationSettingsPath}/agent-pool-scoping`),
          icon: SlidersHorizontal,
          label: "Agent pool scoping",
          to: `${organizationSettingsPath}/agent-pool-scoping`,
        },
        {
          active: isActivePath(location.pathname, `${organizationSettingsPath}/hyok`),
          icon: KeyRound,
          label: "Encryption keys",
          to: `${organizationSettingsPath}/hyok`,
        },
        {
          active: isActivePath(location.pathname, `${organizationSettingsPath}/audit-trail-tokens`),
          icon: FileClock,
          label: "Audit trail token",
          to: `${organizationSettingsPath}/audit-trail-tokens`,
        },
        {
          active: isActivePath(location.pathname, `${organizationSettingsPath}/module-sharing`),
          icon: Share2,
          label: "Module sharing",
          to: `${organizationSettingsPath}/module-sharing`,
        },
      ] as const).filter((link): boolean =>
        (link.label !== "Variable sets" || canManageWorkspaces)
        && (link.label !== "VCS providers" || canManageVcsSettings)
        && (link.label !== "Agent pools" || canManageAgentPools)
        && (link.label !== "Policy sets" || canManagePolicies)
        && (link.label !== "Tag policy sets" || canManagePolicies)
        && (link.label !== "Provider sets" || canManagePolicies)
        && (link.label !== "OIDC" || canManagePolicies)
        && (link.label !== "Registry providers" || canManagePolicies)
        && (link.label !== "Registry modules" || canManagePolicies)
        && (link.label !== "Token TTL policies" || canManagePolicies)
        && (link.label !== "Stacks" || canManageWorkspaces)
        && (link.label !== "Agent pool scoping" || canManageAgentPools)
        && (link.label !== "Encryption keys" || canManagePolicies)
        && (link.label !== "Audit trail token" || canManagePolicies)
        && (link.label !== "Module sharing" || siteAdmin));

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
          <div
            className={cn(
              "px-3 pb-2 pt-4 text-xs font-semibold text-muted-foreground",
              sidebarCollapsed && "lg:sr-only",
            )}
          >
            Organization settings
          </div>
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

    if (hasOrg) {
      const links = ([
        { label: "Projects", to: `${orgPath}/projects`, icon: FolderGit2 },
        { label: "Workspaces", to: `${orgPath}/workspaces`, icon: Box },
        { label: "Registry", to: `${orgPath}/registry`, icon: Package },
        { label: "No-code modules", to: `${orgPath}/no-code`, icon: PackageOpen },
        { label: "Change calendar", to: `${orgPath}/calendar`, icon: Calendar },
        { label: "Settings", to: `${orgPath}/settings`, icon: Settings, trailing: true },
      ] as const).filter((link): boolean =>
        (link.label !== "Projects" || canReadProjects)
        && (link.label !== "No-code modules" || canManageWorkspaces));

      // Sidebar shortcuts are re-read on every navigation (visitsRevision
      // bumps when a workspace is visited, so the list stays current).
      void visitsRevision;
      const pinned = getPinnedWorkspaces().filter((entry): boolean => entry.orgName === orgName);
      const recent = getRecentWorkspaces()
        .filter((entry): boolean => entry.orgName === orgName)
        .filter((entry): boolean => !pinned.some((pinnedEntry): boolean => pinnedEntry.workspaceName === entry.workspaceName))
        .slice(0, 4);

      const shortcutLinks = [...pinned, ...recent].map((entry): { label: string; to: string; icon: typeof FolderGit2 } => ({
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

    return (
      <SidebarNavLink
        active={location.pathname === "/app"}
        collapsed={sidebarCollapsed}
        icon={Building2}
        label="Organizations"
        onNavigate={closeMobileNavigation}
        to="/app"
      />
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
              <DialogContent
                id="mobile-app-sidebar"
                aria-describedby={undefined}
                className="bottom-0 left-0 top-[52px] h-[calc(100dvh-52px)] w-[280px] max-w-none translate-x-0 translate-y-0 gap-0 rounded-none border-y-0 border-l-0 p-0 data-closed:slide-out-to-left data-open:slide-in-from-left sm:rounded-none lg:hidden"
              >
                <DialogTitle className="sr-only">Application navigation</DialogTitle>
                <nav aria-label="Application navigation" className="flex flex-1 flex-col gap-0.5 overflow-y-auto p-3 pt-12">
                  {renderNavigation()}
                </nav>
              </DialogContent>
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
              <span className="text-xs">Search...</span>
              <kbd className="pointer-events-none rounded bg-topbar-foreground/20 px-1.5 py-0.5 text-[10px] font-mono font-medium text-topbar-foreground">
                ⌘K
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
                  {[
                    ["Documentation", "https://developer.hashicorp.com/terraform/cloud-docs"],
                    ["Tutorials", "https://developer.hashicorp.com/terraform/tutorials/cloud"],
                    ["Support", "https://support.hashicorp.com/"],
                    ["Status", "https://status.hashicorp.com/"],
                  ].map(([label, href]): JSX.Element => (
                    <DropdownMenuItem
                      key={href}
                      render={<a href={href} target="_blank" rel="noreferrer" />}
                    >
                      {label}
                    </DropdownMenuItem>
                  ))}
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
            "hidden w-[280px] shrink-0 flex-col border-r bg-muted/40 transition-[width] duration-200 lg:flex",
            sidebarCollapsed ? "lg:w-16" : "lg:w-[280px]",
          )}
        >
          <nav className="flex flex-1 flex-col gap-0.5 overflow-y-auto p-3">
            {renderNavigation()}
          </nav>

          <div className="hidden border-t p-3 lg:block">
            <Button
              variant="ghost"
              size={sidebarCollapsed ? "icon" : "default"}
              className={cn("w-full", !sidebarCollapsed && "justify-start")}
              aria-controls="app-sidebar"
              aria-expanded={!sidebarCollapsed}
              aria-label={sidebarCollapsed ? "Expand sidebar" : "Collapse sidebar"}
              onClick={toggleSidebar}
            >
              {sidebarCollapsed
                ? <PanelLeftOpen data-icon="inline-start" />
                : <PanelLeftClose data-icon="inline-start" />}
              {!sidebarCollapsed && <span>Collapse sidebar</span>}
            </Button>
          </div>
        </aside>

        <main
          id="main-content"
          tabIndex={-1}
          className="relative flex min-w-0 flex-1 flex-col overflow-auto bg-background outline-none"
        >
          <div className="w-full flex-1 px-4 py-6 sm:px-6 lg:px-8">
            {children ?? (
              <Outlet
                context={{
                  accountLoaded,
                  setMustChangePassword,
                  siteAdmin,
                } satisfies LayoutOutletContext}
              />
            )}
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
