import { BrowserRouter, Routes, Route, Navigate } from "react-router-dom";
import { Login } from "./views/Login";
import { Dashboard } from "./views/Dashboard";
import { Workspaces } from "./views/Workspaces";
import { getAuthToken } from "./lib/api";

function ProtectedRoute({ children }: { children: React.ReactNode }) {
  if (!getAuthToken()) {
    return <Navigate to="/login" replace />;
  }
  return <>{children}</>;
}

function App() {
  return (
    <BrowserRouter>
      <Routes>
        <Route path="/login" element={<Login />} />
        <Route path="/" element={<Navigate to="/app" replace />} />
        <Route path="/app" element={<ProtectedRoute><Dashboard /></ProtectedRoute>} />
        <Route path="/app/:orgName" element={<ProtectedRoute><Workspaces /></ProtectedRoute>} />
        {/* Placeholder for workspace detail */}
        <Route path="/app/:orgName/workspaces/:workspaceName" element={<ProtectedRoute><div className="p-8">Workspace Detail (TODO)</div></ProtectedRoute>} />
      </Routes>
    </BrowserRouter>
  );
}

export default App;
