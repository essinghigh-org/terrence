import { useEffect, type JSX, type ReactElement } from "react";
import { BrowserRouter, Routes, Route, Navigate, useNavigate } from "react-router-dom";
import { Login } from "./views/Login";
import { Register } from "./views/Register";
import { Dashboard } from "./views/Dashboard";
import { Workspaces } from "./views/Workspaces";
import { WorkspaceDetail } from "./views/WorkspaceDetail";
import { RunDetail } from "./views/RunDetail";
import { VariableSets } from "./views/VariableSets";
import { OrganizationSettings } from "./views/OrganizationSettings";
import { AccountSettings } from "./views/AccountSettings";
import { Projects } from "./views/Projects";
import { VcsIntegrations } from "./views/VcsIntegrations";
import { AgentPools } from "./views/AgentPools";
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
import { Toaster, toast } from "./components/ui/toast";

type DeepReadonly<T> = T extends null | undefined
  ? T
  : T extends (infer R)[]
  ? readonly DeepReadonly<R>[]
  : T extends object
  ? { readonly [K in keyof T]: DeepReadonly<T[K]> }
  : T;

type ChildNode = DeepReadonly<ReactElement> | string | number | null | undefined;

function ProtectedRoute({ children }: Readonly<{ readonly children?: ChildNode }>): JSX.Element {
  const token = getAuthToken();
  if (token === null || token === "") {
    return <Navigate to="/login" replace />;
  }
  return <Layout>{children}</Layout>;

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
      <BrowserRouter>
        <AuthSessionManager />
        <Routes>
          <Route path="/login" element={<Login />} />
          <Route path="/register" element={<Register />} />
          <Route path="/" element={<Navigate to="/app" replace />} />
          <Route path="/app" element={<ProtectedRoute><Dashboard /></ProtectedRoute>} />
          <Route path="/app/admin" element={<ProtectedRoute><AdminDashboard /></ProtectedRoute>} />
          <Route path="/app/account" element={<ProtectedRoute><AccountSettings /></ProtectedRoute>} />
          <Route path="/app/:orgName" element={<ProtectedRoute><Workspaces /></ProtectedRoute>} />
          <Route path="/app/:orgName/no-code" element={<ProtectedRoute><NoCodeProvisioning /></ProtectedRoute>} />
          <Route path="/app/:orgName/projects" element={<ProtectedRoute><Projects /></ProtectedRoute>} />
          <Route path="/app/:orgName/settings/vcs" element={<ProtectedRoute><VcsIntegrations /></ProtectedRoute>} />
          <Route path="/app/:orgName/settings/agents" element={<ProtectedRoute><AgentPools /></ProtectedRoute>} />
          <Route path="/app/:orgName/variable-sets" element={<ProtectedRoute><VariableSets /></ProtectedRoute>} />
          <Route path="/app/:orgName/settings" element={<ProtectedRoute><OrganizationSettings /></ProtectedRoute>} />
          <Route path="/app/:orgName/workspaces/:workspaceName" element={<ProtectedRoute><WorkspaceDetail /></ProtectedRoute>} />
          <Route path="/app/:orgName/workspaces/:workspaceName/runs/:runId" element={<ProtectedRoute><RunDetail /></ProtectedRoute>} />
          <Route path="*" element={<Navigate to="/" replace />} />
        </Routes>
        <Toaster />
      </BrowserRouter>
    </ErrorBoundary>
  );
}

export default App;
