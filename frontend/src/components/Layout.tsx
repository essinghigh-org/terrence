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
  PanelLeftClose,
  PanelLeftOpen,
  Search,
  Settings,
  ShieldCheck,
  Trash2,
  UserRound,
  Users,
  Variable,
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
import { Avatar, AvatarFallback } from "./ui/avatar";
import { Button, buttonVariants } from "./ui/button";
import { CommandPalette } from "./CommandPalette";
import { ShortcutsHelpModal } from "./ShortcutsHelpModal";
import { fetchAllApiPages, fetchApi, logoutAuthSession } from "../lib/api";
import { applyThemeMode } from "../lib/theme";
import { usePageTitle } from "../lib/usePageTitle";
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
  const [organizationNames, setOrganizationNames] = useState<string[]>([]);
  const [organizationPermissions, setOrganizationPermissions] =
    useState<OrganizationPermissions | null>(null);
  const [organizationPermissionPath, setOrganizationPermissionPath] = useState("");
  const [canReadStateVersions, setCanReadStateVersions] = useState(false);
  const [canReadVariable, setCanReadVariable] = useState(false);
  const [workspacePermissionPath, setWorkspacePermissionPath] = useState("");
  const [commandPaletteOpen, setCommandPaletteOpen] = useState(false);
  const [shortcutsModalOpen, setShortcutsModalOpen] = useState(false);

  useEffect(() => {
    applyThemeMode();
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
            };
          };
        }).data?.attributes;
        setSiteAdmin(attributes?.["is-site-admin"] === true);
        setMustChangePassword(attributes?.["must-change-password"] === true);
        setAccountName(attributes?.username ?? "");
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

  const workspaceMatch =
    matchPath(
      {
        path: "/app/:orgName/workspaces/:workspaceName/*",
        end: false,
      },
      location.pathname,
    ) ??
    matchPath(
      {
        path: "/app/:orgName/workspaces/:workspaceName",
        end: true,
      },
      location.pathname,
    );
  const organizationMatch =
    workspaceMatch ??
    matchPath({ path: "/app/:orgName/*", end: false }, location.pathname) ??
    matchPath({ path: "/app/:orgName", end: true }, location.pathname);
  const routeOrgName = readableRouteParam(organizationMatch?.params.orgName);
  const orgName =
    routeOrgName === "account" || routeOrgName === "admin"
      ? undefined
      : routeOrgName;
  const workspaceName = readableRouteParam(workspaceMatch?.params.workspaceName);
  const hasOrg = orgName !== undefined && orgName !== "";
  const hasWorkspace = hasOrg && workspaceName !== undefined && workspaceName !== "";
  const inAccountSettings = location.pathname === "/app/account";
  const orgPath = hasOrg ? `/app/${encodeURIComponent(orgName)}` : "/app";
  const workspacePath = hasWorkspace
    ? `${orgPath}/workspaces/${encodeURIComponent(workspaceName)}`
    : "";
  const settingsPath = `${workspacePath}/settings`;
  const inWorkspaceSettings =
    hasWorkspace && isActivePath(location.pathname, settingsPath);
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
        : location.pathname === "/app/admin"
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
    if (inAccountSettings) {
      const links = mustChangePassword === false ? [
        {
          active: location.hash === "" || location.hash === "#profile",
          icon: UserRound,
          label: "Profile",
          to: "/app/account#profile",
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

    if (inOrganizationSettings) {
      const links = ([
        {
          active: location.pathname === organizationSettingsPath
            && organizationSettingsTab !== "teams",
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
      ] as const).filter((link): boolean =>
        (link.label !== "Variable sets" || canManageWorkspaces)
        && (link.label !== "VCS providers" || canManageVcsSettings)
        && (link.label !== "Agent pools" || canManageAgentPools));

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
        { label: "Settings", to: `${orgPath}/settings`, icon: Settings, trailing: true },
      ] as const).filter((link): boolean =>
        (link.label !== "Projects" || canReadProjects)
        && (link.label !== "No-code modules" || canManageWorkspaces));

      return (
        <>
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

      <header className="flex h-[52px] shrink-0 items-center justify-between bg-foreground px-2 text-background sm:px-4">
          <div className="flex min-w-0 items-center gap-2 sm:gap-4">
            <Dialog open={mobileNavigationOpen} onOpenChange={setMobileNavigationOpen}>
              <DialogTrigger asChild>
                <Button
                  variant="ghost"
                  size="icon"
                  className="text-background hover:bg-background/10 hover:text-background lg:hidden"
                  aria-label="Open navigation"
                  aria-controls="mobile-app-sidebar"
                >
                  <Menu data-icon="inline-start" />
                </Button>
              </DialogTrigger>
              <DialogContent
                id="mobile-app-sidebar"
                aria-describedby={undefined}
                className="bottom-0 left-0 top-[52px] h-[calc(100dvh-52px)] w-[280px] max-w-none translate-x-0 translate-y-0 gap-0 rounded-none border-y-0 border-l-0 p-0 data-[state=closed]:slide-out-to-left data-[state=open]:slide-in-from-left sm:rounded-none lg:hidden"
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
              className="flex shrink-0 items-center justify-center rounded outline-none transition-opacity hover:opacity-80 focus-visible:ring-2 focus-visible:ring-background"
            >
              <svg
                aria-hidden="true"
                className="size-7"
                viewBox="0 0 24 24"
                fill="none"
                xmlns="http://www.w3.org/2000/svg"
              >
                <path d="M12 2L2 7V17L12 22L22 17V7L12 2Z" fill="currentColor" />
                <path d="M12 22V12" stroke="hsl(var(--foreground))" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
                <path d="M12 12L22 7" stroke="hsl(var(--foreground))" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
                <path d="M2 7L12 12" stroke="hsl(var(--foreground))" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
              </svg>
            </Link>

            <div aria-hidden="true" className="hidden h-5 w-px bg-background/20 sm:block" />

            {hasOrg ? (
              <DropdownMenu>
                <DropdownMenuTrigger
                  render={(
                    <Button
                      variant="ghost"
                      className="min-w-0 max-w-32 shrink text-background hover:bg-background/10 hover:text-background sm:max-w-56"
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
                  "min-w-0 max-w-32 shrink text-background hover:bg-background/10 hover:text-background sm:max-w-56",
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
              className="hidden sm:inline-flex items-center gap-2 text-background/80 hover:bg-background/10 hover:text-background border border-background/20 h-8 px-2.5"
              onClick={() => setCommandPaletteOpen(true)}
            >
              <Search className="size-3.5" />
              <span className="text-xs">Search...</span>
              <kbd className="pointer-events-none rounded bg-background/20 px-1.5 py-0.5 text-[10px] font-mono font-medium text-background">
                ⌘K
              </kbd>
            </Button>

            {/* Help & Support */}
            <DropdownMenu>
              <DropdownMenuTrigger
                render={(
                  <Button
                    variant="ghost"
                    className="text-background hover:bg-background/10 hover:text-background h-8 px-2"
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
                  <DropdownMenuItem onClick={() => setShortcutsModalOpen(true)}>
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
                    className="text-background hover:bg-background/10 hover:text-background h-8 px-2"
                    aria-label="Account menu"
                  />
                )}
              >
                <Avatar className="size-6 rounded">
                  <AvatarFallback className="rounded bg-background/15 text-background text-xs">
                    {accountName === ""
                      ? <UserRound aria-hidden="true" />
                      : accountName.slice(0, 2).toUpperCase()}
                  </AvatarFallback>
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
      />

      <ShortcutsHelpModal
        open={shortcutsModalOpen}
        onOpenChange={setShortcutsModalOpen}
      />
    </div>
  );
}
