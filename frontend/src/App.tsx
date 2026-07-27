import { BrowserRouter, Routes, Route, Navigate } from "react-router-dom";
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
import { getAuthToken } from "./lib/api";
import { Layout } from "./components/Layout";

function ProtectedRoute({ children }: { children: React.ReactNode }) {
  if (!getAuthToken()) {
    return <Navigate to="/login" replace />;
  }
  return <Layout>{children}</Layout>;
}

function App() {
  return (
    <BrowserRouter>
      <Routes>
        <Route path="/login" element={<Login />} />
        <Route path="/register" element={<Register />} />
        <Route path="/" element={<Navigate to="/app" replace />} />
        <Route path="/app" element={<ProtectedRoute><Dashboard /></ProtectedRoute>} />
        <Route path="/app/admin" element={<ProtectedRoute><AdminDashboard /></ProtectedRoute>} />
        <Route path="/app/account" element={<ProtectedRoute><AccountSettings /></ProtectedRoute>} />
        <Route path="/app/:orgName" element={<ProtectedRoute><Workspaces /></ProtectedRoute>} />
        <Route path="/app/:orgName/projects" element={<ProtectedRoute><Projects /></ProtectedRoute>} />
        <Route path="/app/:orgName/settings/vcs" element={<ProtectedRoute><VcsIntegrations /></ProtectedRoute>} />
        <Route path="/app/:orgName/settings/agents" element={<ProtectedRoute><AgentPools /></ProtectedRoute>} />
        <Route path="/app/:orgName/variable-sets" element={<ProtectedRoute><VariableSets /></ProtectedRoute>} />
        <Route path="/app/:orgName/settings" element={<ProtectedRoute><OrganizationSettings /></ProtectedRoute>} />
        <Route path="/app/:orgName/workspaces/:workspaceName" element={<ProtectedRoute><WorkspaceDetail /></ProtectedRoute>} />
        <Route path="/app/:orgName/workspaces/:workspaceName/runs/:runId" element={<ProtectedRoute><RunDetail /></ProtectedRoute>} />
        <Route path="*" element={<Navigate to="/" replace />} />
      </Routes>
    </BrowserRouter>
  );
}

export default App;
