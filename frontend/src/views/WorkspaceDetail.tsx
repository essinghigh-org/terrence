import { useCallback, useEffect, useState } from "react";
import { useParams, Link } from "react-router-dom";
import { fetchApi } from "../lib/api";
import { Button } from "../components/ui/button";
import { toast } from "../components/ui/toast";
import {
  WorkspaceHealth,
  WorkspaceRunTriggers,
  WorkspaceSshKey,
} from "../components/WorkspaceConnections";
import { WorkspaceNotifications } from "../components/WorkspaceNotifications";
import { WorkspaceSettings } from "../components/WorkspaceSettings";
import { WorkspaceTeamAccess } from "../components/WorkspaceTeamAccess";
import { WorkspaceVariables } from "../components/WorkspaceVariables";
import { WorkspacePolicySets } from "../components/WorkspacePolicySets";
import { WorkspaceVcs } from "../components/WorkspaceVcs";
import { RunList } from "./RunList";
import { StateHistory } from "./StateHistory";
import { Play, Lock, LockOpen, Info, CheckCircle2 } from "lucide-react";

type Workspace = {
  id: string;
  attributes: {
    name: string;
    locked?: boolean;
    description?: string | null;
    "terraform-version"?: string;
    "auto-apply"?: boolean;
    "created-at"?: string;
    [key: string]: unknown;
  };
  relationships?: {
    "ssh-key"?: { data: { id: string; type: string } | null };
    [key: string]: unknown;
  };
}

type RunSummary = {
  attributes: {
    message?: string | null;
    status: string;
  };
}

export function WorkspaceDetail(): React.JSX.Element {
  const { orgName, workspaceName } = useParams<{ orgName: string; workspaceName: string }>();

  const [workspace, setWorkspace] = useState<Workspace | null>(null);
  const [latestRun, setLatestRun] = useState<RunSummary | null>(null);
  const [loading, setLoading] = useState(true);
  const [activeTab, setActiveTab] = useState("overview");

  const loadWorkspace = useCallback(async (): Promise<void> => {
    setLoading(true);
    try {
      const data = await fetchApi(
        `/organizations/${encodeURIComponent(orgName ?? "")}/workspaces/${encodeURIComponent(workspaceName ?? "")}`,
      ) as { data: Workspace };
      setWorkspace(data.data);
      try {
        const runs = await fetchApi(`/api/v2/workspaces/${data.data.id}/runs?page[size]=1`) as { data: unknown };
        setLatestRun(Array.isArray(runs.data) ? (runs.data[0] as RunSummary | undefined) ?? null : null);
      } catch {
        setLatestRun(null);
      }
    } catch {
      console.error("Failed to load workspace");
    } finally {
      setLoading(false);
    }
  }, [orgName, workspaceName]);

  useEffect((): void => {
    void loadWorkspace();
  }, [loadWorkspace]);

  async function handleLock(): Promise<void> {
    if (workspace == null) return;
    try {
      if (workspace.attributes.locked === true) {
        await fetchApi(`/workspaces/${workspace.id}/actions/unlock`, { method: "POST" });
      } else {
        await fetchApi(`/workspaces/${workspace.id}/actions/lock`, { method: "POST" });
      }
      void loadWorkspace();
      toast.add({ title: workspace.attributes.locked === true ? "Workspace unlocked" : "Workspace locked", type: "success" });
    } catch {
      toast.add({ title: "Failed to toggle workspace lock", type: "error" });
    }
  }

  if (loading) return <div className="p-8 text-gray-500">Loading workspace...</div>;
  if (workspace == null) return <div className="p-8 text-gray-500">Workspace not found</div>;

  const createdAt = workspace.attributes["created-at"];
  const latestRunStatus = latestRun?.attributes.status.replace(/_/g, " ");
  const latestRunSucceeded = latestRunStatus === "applied" || latestRunStatus === "planned and finished";
  const tabs = [
    { id: "overview", label: "Overview" },
    { id: "runs", label: "Runs" },
    { id: "states", label: "States" },
    { id: "variables", label: "Variables" },
    { id: "team-access", label: "Team access" },
    { id: "notifications", label: "Notifications" },
    { id: "policy-sets", label: "Policy sets" },
    { id: "run-triggers", label: "Run triggers" },
    { id: "ssh-key", label: "SSH key" },
    { id: "vcs", label: "VCS" },
    { id: "health", label: "Health" },
    { id: "settings", label: "Settings" },
  ];

  return (
    <div className="max-w-full w-full">
      {/* Breadcrumbs */}
      <div className="text-xs text-gray-500 mb-2 flex items-center gap-1.5 font-medium">
        <Link to={`/app/${orgName ?? ""}`} className="hover:underline">{orgName}</Link>
        <span className="text-gray-300">/</span>
        <span className="text-gray-900">{workspace.attributes.name}</span>
      </div>

      {/* Header */}
      <div className="flex items-start justify-between mb-8">
        <div>
          <div className="flex items-center gap-3 mb-1">
            <h1 className="text-3xl font-bold text-gray-900 tracking-tight">{workspace.attributes.name}</h1>
            {workspace.attributes.locked === true && (
              <span className="flex items-center text-xs font-medium bg-gray-100 text-gray-700 px-2 py-0.5 rounded">
                <Lock className="w-3 h-3 mr-1" /> Locked
              </span>
            )}
          </div>
          <p className="text-gray-600 text-[15px]">
            {workspace.attributes.description ?? "No description provided."}
          </p>
        </div>

        <div className="flex items-center gap-3">
          <Button
            variant="outline"
            onClick={handleLock}
            className="h-9 px-3 text-sm text-gray-700 font-medium rounded-[4px] border-gray-300 shadow-sm bg-white hover:bg-gray-50"
          >
            {workspace.attributes.locked === true ? (
              <><LockOpen className="w-4 h-4 mr-2" /> Unlock</>
            ) : (
              <><Lock className="w-4 h-4 mr-2" /> Lock</>
            )}
          </Button>
          <div className="flex rounded-[4px] shadow-sm">
            <Button className="bg-[#2962ff] hover:bg-[#1a4bcf] text-white h-9 px-4 rounded-r-none font-medium rounded-l-[4px]">
              <Play className="w-4 h-4 mr-2" /> New run
            </Button>
            <Button className="bg-[#2962ff] hover:bg-[#1a4bcf] text-white h-9 px-2 rounded-l-none font-medium border-l border-blue-700/30 rounded-r-[4px]">
               <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="m6 9 6 6 6-6"/></svg>
            </Button>
          </div>
        </div>
      </div>

      {/* Navigation Tabs */}
      <div className="border-b border-gray-200 mb-6">
        <nav className="flex flex-wrap gap-x-6 gap-y-2">
          {tabs.map((tab: Readonly<{ id: string; label: string }>): React.JSX.Element => (
            <button
              key={tab.id}
              onClick={(): void => { setActiveTab(tab.id); }}
              aria-label={tab.label.toLowerCase()}
              className={`pb-3 text-[14px] font-medium border-b-2 transition-colors ${
                activeTab === tab.id
                  ? "border-[#2962ff] text-blue-700"
                  : "border-transparent text-gray-500 hover:text-gray-700 hover:border-gray-300"
              }`}
            >
              {tab.label}
            </button>
          ))}
        </nav>
      </div>

      {/* Tab Content */}
      <div className="mt-6">
        {activeTab === "overview" && (
          <div className="grid grid-cols-3 gap-6">
            <div className="col-span-2 flex flex-col gap-6">
              {/* Latest Run Card */}
              <div className="bg-white border border-gray-200 rounded-md shadow-sm overflow-hidden flex flex-col h-64 relative">
                 <div className="absolute inset-0 flex flex-col items-center justify-center p-8 text-center bg-gray-50/50">
                    {latestRunSucceeded
                      ? <CheckCircle2 className="h-10 w-10 text-emerald-500 mb-4" />
                      : <Info className="h-10 w-10 text-blue-500 mb-4" />}
                    <h3 className="text-lg font-semibold text-gray-900 mb-1">
                      {latestRun === null ? "No runs yet" : `Latest run: ${latestRunStatus}`}
                    </h3>
                    <p className="text-sm text-gray-500 max-w-md">
                      {latestRun === null
                        ? "Start a run to plan your infrastructure changes."
                        : latestRun.attributes.message ?? "Open the Runs tab to view details and take the next action."}
                    </p>
                 </div>
              </div>

              {/* Resources Card */}
              <div className="bg-white border border-gray-200 rounded-md shadow-sm">
                <div className="px-5 py-4 border-b border-gray-200 flex items-center justify-between">
                   <h3 className="text-base font-semibold text-gray-900">Resources</h3>
                </div>
                <div className="p-5 text-center text-sm text-gray-500 py-12">
                   No resource data available yet.
                </div>
              </div>
            </div>

            <div className="col-span-1 flex flex-col gap-6">
              {/* Details Card */}
              <div className="bg-white border border-gray-200 rounded-md shadow-sm">
                <div className="px-4 py-3 border-b border-gray-200">
                  <h3 className="text-sm font-semibold text-gray-900">Workspace details</h3>
                </div>
                <div className="p-4 space-y-4">
                  <div>
                    <div className="text-xs font-semibold text-gray-500 uppercase tracking-wider mb-1">Project</div>
                    <div className="text-[13px] text-gray-900 font-medium">Default Project</div>
                  </div>
                  <div>
                    <div className="text-xs font-semibold text-gray-500 uppercase tracking-wider mb-1">Execution mode</div>
                    <div className="text-[13px] text-gray-900 flex items-center gap-1.5">
                       Remote
                       <Info className="h-3.5 w-3.5 text-gray-400" />
                    </div>
                  </div>
                  <div>
                    <div className="text-xs font-semibold text-gray-500 uppercase tracking-wider mb-1">Terraform version</div>
                    <div className="text-[13px] text-gray-900 flex items-center gap-1.5">
                       {workspace.attributes["terraform-version"] ?? "latest"}
                       <span className="text-xs bg-gray-100 text-gray-600 px-1.5 py-0.5 rounded border border-gray-200">Latest</span>
                    </div>
                  </div>
                  <div>
                    <div className="text-xs font-semibold text-gray-500 uppercase tracking-wider mb-1">Auto-apply</div>
                    <div className="text-[13px] text-gray-900">
                       {workspace.attributes["auto-apply"] === true ? "Enabled" : "Disabled"}
                    </div>
                  </div>
                  <div>
                    <div className="text-xs font-semibold text-gray-500 uppercase tracking-wider mb-1">Created</div>
                    <div className="text-[13px] text-gray-900">
                       {typeof createdAt === "string" && createdAt !== "" ? new Date(createdAt).toLocaleDateString() : "—"}
                    </div>
                  </div>
                </div>
              </div>
            </div>
          </div>
        )}

        {activeTab === "runs" && <RunList workspaceId={workspace.id} />}
        {activeTab === "states" && <StateHistory workspaceId={workspace.id} />}
        {activeTab === "variables" && <WorkspaceVariables workspaceId={workspace.id} />}
        {activeTab === "team-access" && (
          <WorkspaceTeamAccess orgName={orgName ?? ""} workspaceId={workspace.id} />
        )}
        {activeTab === "notifications" && <WorkspaceNotifications workspaceId={workspace.id} />}
        {activeTab === "policy-sets" && <WorkspacePolicySets workspaceId={workspace.id} />}
        {activeTab === "run-triggers" && (
          <WorkspaceRunTriggers orgName={orgName ?? ""} workspaceId={workspace.id} />
        )}
        {activeTab === "ssh-key" && (
          <WorkspaceSshKey
            key={workspace.id}
            orgName={orgName ?? ""}
            workspaceId={workspace.id}
            initialSshKeyId={workspace.relationships?.["ssh-key"]?.data?.id ?? null}
          />
        )}
        {activeTab === "health" && (
          <WorkspaceHealth
            key={workspace.id}
            workspace={workspace}
            onSaved={(saved: Workspace): void => { setWorkspace(saved); }}
          />
        )}
        {activeTab === "vcs" && (
          <WorkspaceVcs
            key={workspace.id}
            workspace={workspace}
            onSaved={(saved): void => { setWorkspace(saved); }}
          />
        )}
        {activeTab === "settings" && (
          <WorkspaceSettings
            key={workspace.id}
            workspace={workspace}
            onSaved={(saved: Workspace): void => { setWorkspace(saved); }}
          />
        )}

      </div>
    </div>
  );
}
