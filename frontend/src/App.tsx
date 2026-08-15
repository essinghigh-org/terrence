import { lazy, Suspense, useEffect, type ComponentType, type JSX, type ReactNode } from "react";
import { isFunction } from "./lib/type-guards";
import { BrowserRouter, Routes, Route, Navigate, useNavigate } from "react-router-dom";
import { Login } from "./views/Login";
import { Register } from "./views/Register";
import { Spinner } from "./components/ui/spinner";
import {
  AUTH_CHANGED_EVENT,
  AUTH_EXPIRED_EVENT,
  consumeAuthExpiry,
  expireAuthSession,
  getAuthToken,
  getAuthTokenExpiry,
  isRefreshableSession,
} from "./lib/api";
import { Layout } from "./components/Layout";
import { ErrorBoundary } from "./components/ErrorBoundary";
import { RunSandboxGate } from "./components/RunSandboxGate";
import { Toaster, toast } from "./components/ui/toast";
import { useDisplayTimezone } from "./lib/useDisplayTimezone";

/**
 * Route-level code splitting (10.16): every view is a separate Vite chunk,
 * loaded on first navigation. Login/Register stay eager so the entry
 * screens never wait on a chunk fetch.
 */
function lazyView(
  importer: () => Promise<Record<string, unknown>>,
  name: string,
): ComponentType<Record<string, unknown>> {
  const load = async (): Promise<{ default: ComponentType<Record<string, unknown>> }> => {
    const module = await importer();
    const component = module[name];
    // SAFETY: chunk exports are components; anything else is a broken build.
    if (!isFunction(component)) {
      throw new Error(`View ${name} is missing from its chunk`);
    }
    return { default: component as ComponentType<Record<string, unknown>> };
  };
  return lazy(async (): Promise<{ default: ComponentType<Record<string, unknown>> }> => {
    try {
      return await load();
    } catch (firstError: unknown) {
      // A failed chunk fetch is often a stale deployment mid-swap: wait
      // briefly, retry once, then reload so the new asset manifest is
      // fetched. The reload fires at most once per browser session.
      if (sessionStorage.getItem("terrence:chunk-reload") === "1") {
        throw firstError;
      }
      await new Promise((resolve): void => { setTimeout(resolve, 500); });
      try {
        return await load();
      } catch {
        sessionStorage.setItem("terrence:chunk-reload", "1");
        window.location.reload();
        throw firstError;
      }
    }
  });
}

const Dashboard = lazyView(() => import("./views/Dashboard"), "Dashboard");
const Workspaces = lazyView(() => import("./views/Workspaces"), "Workspaces");
const WorkspaceDetail = lazyView(() => import("./views/WorkspaceDetail"), "WorkspaceDetail");
const VariableSets = lazyView(() => import("./views/VariableSets"), "VariableSets");
const OrganizationSettings = lazyView(() => import("./views/OrganizationSettings"), "OrganizationSettings");
const AccountSettings = lazyView(() => import("./views/AccountSettings"), "AccountSettings");
const Projects = lazyView(() => import("./views/Projects"), "Projects");
const ProjectDetail = lazyView(() => import("./views/ProjectDetail"), "ProjectDetail");
const Registry = lazyView(() => import("./views/Registry"), "Registry");
const RegistryModuleDetail = lazyView(() => import("./views/RegistryModuleDetail"), "RegistryModuleDetail");
const RegistryProviderDetail = lazyView(() => import("./views/RegistryProviderDetail"), "RegistryProviderDetail");
const VcsIntegrations = lazyView(() => import("./views/VcsIntegrations"), "VcsIntegrations");
const AgentPools = lazyView(() => import("./views/AgentPools"), "AgentPools");
const PolicySets = lazyView(() => import("./views/PolicySets"), "PolicySets");
const PolicySetDetail = lazyView(() => import("./views/PolicySetDetail"), "PolicySetDetail");
const ProviderSets = lazyView(() => import("./views/ProviderSets"), "ProviderSets");
const OidcConfigurations = lazyView(() => import("./views/OidcConfigurations"), "OidcConfigurations");
const TokenTTLPolicies = lazyView(() => import("./views/TokenTTLPolicies"), "TokenTTLPolicies");
const StackSettings = lazyView(() => import("./views/StackSettings"), "StackSettings");
const AgentPoolScoping = lazyView(() => import("./views/AgentPoolScoping"), "AgentPoolScoping");
const HyokConfigurations = lazyView(() => import("./views/HyokConfigurations"), "HyokConfigurations");
const AuditTrailTokens = lazyView(() => import("./views/AuditTrailTokens"), "AuditTrailTokens");
const PolicySetsTags = lazyView(() => import("./views/PolicySetsTags"), "PolicySetsTags");
const AdminDashboard = lazyView(() => import("./views/AdminDashboard"), "AdminDashboard");
const CompatibilityDashboard = lazyView(() => import("./views/CompatibilityDashboard"), "CompatibilityDashboard");
const AdminSmtpSettings = lazyView(() => import("./views/AdminSmtpSettings"), "AdminSmtpSettings");
const AdminScimSettings = lazyView(() => import("./views/AdminScimSettings"), "AdminScimSettings");
const ModuleSharing = lazyView(() => import("./views/ModuleSharing"), "ModuleSharing");
const NoCodeProvisioning = lazyView(() => import("./views/NoCodeProvisioning"), "NoCodeProvisioning");
const ChangeCalendar = lazyView(() => import("./views/ChangeCalendar"), "ChangeCalendar");
const ChangeRequests = lazyView(() => import("./views/ChangeRequests"), "ChangeRequests");
const ChangeRequestDetail = lazyView(() => import("./views/ChangeRequestDetail"), "ChangeRequestDetail");
const AdminOperationsSettings = lazyView(() => import("./views/AdminOperationsSettings"), "AdminOperationsSettings");
const AdminDatabaseMigration = lazyView(() => import("./views/AdminDatabaseMigration"), "AdminDatabaseMigration");
const NotFound = lazyView(() => import("./views/NotFound"), "NotFound");

export function RegistrySettingsRedirect({ tab }: Readonly<{ tab: "modules" | "providers" }>): JSX.Element {
  return <Navigate to={tab === "providers" ? "../../registry?tab=providers" : "../../registry"} relative="path" replace />;
}

function RouteFallback(): JSX.Element {
  return (
    <div className="flex justify-center py-24">
      <Spinner className="size-6" />
    </div>
  );
}

function ProtectedRoute({ children }: Readonly<{ readonly children?: ReactNode }>): JSX.Element {
  const token = getAuthToken();
  if (token === null || token === "") {
    return <Navigate to="/login" replace />;
  }
  return <>{children}</>;
}

function AuthSessionManager(): null {
  const navigate = useNavigate();

  useEffect((): (() => void) => {
    let expiryTimer: number | undefined;

    const notifyAndSignIn = (): void => {
      if (consumeAuthExpiry()) {
        toast.add({
          title: "Session expired",
          description: "Sign in again to continue.",
          type: "warning",
        });
      }
      void navigate("/login", { replace: true });
    };

    const scheduleExpiry = (): void => {
      if (expiryTimer !== undefined) window.clearTimeout(expiryTimer);
      if (isRefreshableSession()) return;
      const expiresAt = getAuthTokenExpiry();
      if (expiresAt === null) return;
      const remaining = expiresAt - Date.now();
      if (remaining <= 0) {
        expireAuthSession();
        return;
      }
      expiryTimer = window.setTimeout(scheduleExpiry, Math.min(remaining, 2_147_000_000));
    };

    window.addEventListener(AUTH_EXPIRED_EVENT, notifyAndSignIn);
    window.addEventListener(AUTH_CHANGED_EVENT, scheduleExpiry);
    scheduleExpiry();
    if (consumeAuthExpiry()) {
      toast.add({
        title: "Session expired",
        description: "Sign in again to continue.",
        type: "warning",
      });
    }

    return (): void => {
      if (expiryTimer !== undefined) window.clearTimeout(expiryTimer);
      window.removeEventListener(AUTH_EXPIRED_EVENT, notifyAndSignIn);
      window.removeEventListener(AUTH_CHANGED_EVENT, scheduleExpiry);
    };
  }, [navigate]);

  return null;
}

function App(): JSX.Element {
  useDisplayTimezone();

  return (
    <ErrorBoundary>
      <RunSandboxGate>
        <BrowserRouter>
          <AuthSessionManager />
          <Suspense fallback={<RouteFallback />}>
            <Routes>
            <Route path="/login" element={<Login />} />
            <Route path="/register" element={<Register />} />
            <Route path="/" element={<Navigate to="/app" replace />} />
            <Route path="/app" element={<ProtectedRoute><Layout /></ProtectedRoute>}>
              <Route index element={<Dashboard />} />
              <Route path="admin" element={<AdminDashboard section="security" />} />
              <Route path="admin/users" element={<AdminDashboard section="users" />} />
              <Route path="admin/organizations" element={<AdminDashboard section="orgs" />} />
              <Route path="admin/workspaces" element={<AdminDashboard section="workspaces" />} />
              <Route path="admin/runs" element={<AdminDashboard section="runs" />} />
              <Route path="admin/versions" element={<AdminDashboard section="versions" />} />
              <Route path="admin/compatibility" element={<CompatibilityDashboard />} />
              <Route path="admin/audit" element={<AdminDashboard section="audit" />} />
              <Route path="admin/auth" element={<AdminDashboard section="auth" />} />
              <Route path="admin/smtp" element={<AdminSmtpSettings />} />
              <Route path="admin/scim" element={<AdminScimSettings />} />
              <Route path="admin/operations" element={<AdminOperationsSettings />} />
              <Route path="admin/database" element={<AdminDatabaseMigration />} />
              <Route path="account" element={<AccountSettings />} />
              <Route path=":orgName" element={<Workspaces />} />
              <Route path=":orgName/workspaces" element={<Workspaces />} />
              <Route path=":orgName/registry" element={<Registry />} />
              <Route path=":orgName/registry/modules/:namespace/:name/:provider" element={<RegistryModuleDetail />} />
              <Route path=":orgName/registry/providers/:namespace/:name" element={<RegistryProviderDetail />} />
              <Route path=":orgName/no-code" element={<NoCodeProvisioning />} />
              <Route path=":orgName/calendar" element={<ChangeCalendar />} />
              <Route path=":orgName/change-requests" element={<ChangeRequests />} />
              <Route path=":orgName/change-requests/:changeRequestId" element={<ChangeRequestDetail />} />
              <Route path=":orgName/projects" element={<Projects />} />
              <Route path=":orgName/projects/:projectId" element={<ProjectDetail section="overview" />} />
              <Route path=":orgName/projects/:projectId/workspaces" element={<ProjectDetail section="workspaces" />} />
              <Route path=":orgName/projects/:projectId/settings" element={<ProjectDetail section="settings" />} />
              <Route path=":orgName/projects/:projectId/settings/variable-sets" element={<ProjectDetail section="variable-sets" />} />
              <Route path=":orgName/settings/vcs" element={<VcsIntegrations />} />
              <Route path=":orgName/settings/agents" element={<AgentPools />} />
              <Route path=":orgName/settings/policy-sets" element={<PolicySets />} />
              <Route path=":orgName/settings/provider-sets" element={<ProviderSets />} />
              <Route path=":orgName/settings/oidc" element={<OidcConfigurations />} />
              <Route path=":orgName/settings/registry-providers" element={<RegistrySettingsRedirect tab="providers" />} />
              <Route path=":orgName/settings/registry-modules" element={<RegistrySettingsRedirect tab="modules" />} />
              <Route path=":orgName/settings/token-ttl" element={<TokenTTLPolicies />} />
              <Route path=":orgName/settings/stacks-workspaces" element={<StackSettings />} />
              <Route path=":orgName/settings/agent-pool-scoping" element={<AgentPoolScoping />} />
              <Route path=":orgName/settings/hyok" element={<HyokConfigurations />} />
              <Route path=":orgName/settings/audit-trail-tokens" element={<AuditTrailTokens />} />
              <Route path=":orgName/settings/policy-sets/tags" element={<PolicySetsTags />} />
              <Route path=":orgName/settings/module-sharing" element={<ModuleSharing />} />
              <Route path=":orgName/settings/policy-sets/:policySetId" element={<PolicySetDetail />} />
              <Route path=":orgName/settings/policy-sets/:policySetId/policies" element={<PolicySetDetail section="policies" />} />
              <Route path=":orgName/settings/policy-sets/:policySetId/attachments" element={<PolicySetDetail section="attachments" />} />
              <Route path=":orgName/settings/policy-sets/:policySetId/parameters" element={<PolicySetDetail section="parameters" />} />
              <Route path=":orgName/settings/policy-sets/:policySetId/vcs" element={<PolicySetDetail section="vcs" />} />
              <Route path=":orgName/variable-sets" element={<VariableSets />} />
              <Route path=":orgName/settings" element={<OrganizationSettings />} />

              <Route
                path=":orgName/workspaces/:workspaceName"
                element={<WorkspaceDetail section="overview" />}
              />
              <Route
                path=":orgName/workspaces/:workspaceName/runs"
                element={<WorkspaceDetail section="runs" />}
              />
              <Route
                path=":orgName/workspaces/:workspaceName/states"
                element={<WorkspaceDetail section="states" />}
              />
              <Route
                path=":orgName/workspaces/:workspaceName/variables"
                element={<WorkspaceDetail section="variables" />}
              />
              <Route
                path=":orgName/workspaces/:workspaceName/settings"
                element={<WorkspaceDetail section="settings" />}
              />
              <Route
                path=":orgName/workspaces/:workspaceName/settings/general"
                element={<WorkspaceDetail section="settings" />}
              />
              <Route
                path=":orgName/workspaces/:workspaceName/settings/lock"
                element={<WorkspaceDetail section="locking" />}
              />
              <Route
                path=":orgName/workspaces/:workspaceName/settings/notifications"
                element={<WorkspaceDetail section="notifications" />}
              />
              <Route
                path=":orgName/workspaces/:workspaceName/settings/webhooks"
                element={<WorkspaceDetail section="webhooks" />}
              />
              <Route
                path=":orgName/workspaces/:workspaceName/settings/policies"
                element={<WorkspaceDetail section="policy-sets" />}
              />
              <Route
                path=":orgName/workspaces/:workspaceName/settings/tasks"
                element={<WorkspaceDetail section="run-tasks" />}
              />
              <Route
                path=":orgName/workspaces/:workspaceName/settings/run-triggers"
                element={<WorkspaceDetail section="run-triggers" />}
              />
              <Route
                path=":orgName/workspaces/:workspaceName/settings/configuration-versions"
                element={<WorkspaceDetail section="configuration-versions" />}
              />
              <Route
                path=":orgName/workspaces/:workspaceName/settings/ssh"
                element={<WorkspaceDetail section="ssh-key" />}
              />
              <Route
                path=":orgName/workspaces/:workspaceName/settings/version-control"
                element={<WorkspaceDetail section="vcs" />}
              />
              <Route
                path=":orgName/workspaces/:workspaceName/settings/team-access"
                element={<WorkspaceDetail section="team-access" />}
              />
              <Route
                path=":orgName/workspaces/:workspaceName/settings/health"
                element={<WorkspaceDetail section="health" />}
              />
              <Route
                path=":orgName/workspaces/:workspaceName/settings/retention"
                element={<WorkspaceDetail section="retention" />}
              />
              <Route
                path=":orgName/workspaces/:workspaceName/settings/delete"
                element={<WorkspaceDetail section="destruction" />}
              />
              <Route
                path=":orgName/workspaces/:workspaceName/runs/:runId"
                element={<WorkspaceDetail section="run-detail" />}
              />
            </Route>
            <Route path="*" element={<NotFound />} />
          </Routes>
          </Suspense>
          <Toaster />
        </BrowserRouter>
      </RunSandboxGate>
    </ErrorBoundary>
  );
}

export default App;