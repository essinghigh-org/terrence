import { useEffect, type JSX, type ReactNode } from "react";
import { BrowserRouter, Routes, Route, Navigate, useNavigate } from "react-router-dom";
import { Login } from "./views/Login";
import { Register } from "./views/Register";
import { Dashboard } from "./views/Dashboard";
import { Workspaces } from "./views/Workspaces";
import { WorkspaceDetail } from "./views/WorkspaceDetail";
import { VariableSets } from "./views/VariableSets";
import { OrganizationSettings } from "./views/OrganizationSettings";
import { AccountSettings } from "./views/AccountSettings";
import { Projects } from "./views/Projects";
import { ProjectDetail } from "./views/ProjectDetail";
import { Registry } from "./views/Registry";
import { VcsIntegrations } from "./views/VcsIntegrations";
import { AgentPools } from "./views/AgentPools";
import { PolicySets } from "./views/PolicySets";
import { PolicySetDetail } from "./views/PolicySetDetail";
import { ProviderSets } from "./views/ProviderSets";
import { OidcConfigurations } from "./views/OidcConfigurations";
import { AdminDashboard } from "./views/AdminDashboard";
import { NoCodeProvisioning } from "./views/NoCodeProvisioning";
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
  return (
    <ErrorBoundary>
      <RunSandboxGate>
        <BrowserRouter>
          <AuthSessionManager />
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
            <Route path="admin/audit" element={<AdminDashboard section="audit" />} />
            <Route path="admin/auth" element={<AdminDashboard section="auth" />} />
            <Route path="account" element={<AccountSettings />} />
            <Route path=":orgName" element={<Workspaces />} />
            <Route path=":orgName/workspaces" element={<Workspaces />} />
            <Route path=":orgName/registry" element={<Registry />} />
            <Route path=":orgName/no-code" element={<NoCodeProvisioning />} />
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
          <Route path="*" element={<Navigate to="/" replace />} />
        </Routes>
        <Toaster />
        </BrowserRouter>
      </RunSandboxGate>
    </ErrorBoundary>
  );
}

export default App;
