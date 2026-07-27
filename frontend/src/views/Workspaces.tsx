import { useEffect, useState } from "react";
import { useParams, useNavigate } from "react-router-dom";
import { fetchApi } from "../lib/api";
import { Button } from "../components/ui/button";
import { Search, MoreHorizontal, Filter, AlertCircle, XCircle, Clock, PauseCircle, CheckCircle2 } from "lucide-react";

export function Workspaces() {
  const { orgName } = useParams();
  const navigate = useNavigate();
  const [workspaces, setWorkspaces] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState("");

  useEffect(() => {
    loadWorkspaces();
  }, [orgName]);

  async function loadWorkspaces() {
    try {
      const data = await fetchApi(`/api/v2/organizations/${orgName}/workspaces`);
      setWorkspaces(data.data || []);
    } catch (err) {
      console.error(err);
    } finally {
      setLoading(false);
    }
  }

  const filteredWorkspaces = workspaces.filter((ws) => {
    const nameMatch = ws.attributes.name.toLowerCase().includes(search.toLowerCase());
    const tags = ws.attributes["tag-names"] || ws.attributes.tags || [];
    const tagMatch = tags.some((t: string) => t.toLowerCase().includes(search.toLowerCase()));
    return nameMatch || tagMatch;
  });

  return (
    <div className="max-w-full w-full">
      <div className="text-xs text-gray-500 mb-2 flex items-center gap-1.5 font-medium">
        <span className="hover:underline cursor-pointer">{orgName}</span>
        <span className="text-gray-300">/</span>
        <span className="text-gray-900">Workspaces</span>
      </div>

      <div className="flex items-center justify-between mb-6">
        <h1 className="text-3xl font-bold text-gray-900 tracking-tight">Workspaces</h1>
        <Button className="bg-[#2962ff] hover:bg-[#1a4bcf] text-white rounded-[4px] h-9 px-4 shadow-none font-medium">
          New workspace
        </Button>
      </div>

      <div className="flex items-center gap-4 mb-4">
        <Button variant="outline" className="h-9 px-3 text-sm text-gray-700 font-medium rounded-[4px] border-gray-300 shadow-sm flex items-center gap-2 bg-white hover:bg-gray-50">
          <Filter className="h-4 w-4 text-gray-500" /> All filters
        </Button>

        <div className="relative flex-1 max-w-md">
          <div className="absolute inset-y-0 left-0 pl-3 flex items-center pointer-events-none">
            <Search className="h-4 w-4 text-gray-400" />
          </div>
          <input
            type="text"
            placeholder="Search by workspace name"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            className="pl-9 pr-4 py-1.5 h-9 w-full border border-gray-300 rounded-[4px] text-sm focus:outline-none focus:ring-1 focus:ring-blue-500 focus:border-blue-500 placeholder-gray-400"
          />
        </div>

        <div className="ml-auto flex items-center gap-2">
          {/* Status filter pills mimicking the screenshot */}
          <div className="flex items-center border border-gray-300 rounded-[4px] overflow-hidden shadow-sm bg-white text-xs font-medium text-gray-700 h-9">
            <button className="flex items-center gap-1.5 px-3 py-1 hover:bg-gray-50 border-r border-gray-300 h-full">
              <AlertCircle className="h-3.5 w-3.5 text-orange-500" /> 0 Need attention
            </button>
            <button className="flex items-center gap-1.5 px-3 py-1 hover:bg-gray-50 border-r border-gray-300 h-full">
              <XCircle className="h-3.5 w-3.5 text-red-500" /> 0 Errored
            </button>
            <button className="flex items-center gap-1.5 px-3 py-1 hover:bg-gray-50 border-r border-gray-300 h-full">
              <Clock className="h-3.5 w-3.5 text-blue-500" /> 0 Running
            </button>
            <button className="flex items-center gap-1.5 px-3 py-1 hover:bg-gray-50 border-r border-gray-300 h-full">
              <PauseCircle className="h-3.5 w-3.5 text-gray-500" /> 0 On hold
            </button>
            <button className="flex items-center gap-1.5 px-3 py-1 hover:bg-gray-50 h-full">
              <CheckCircle2 className="h-3.5 w-3.5 text-emerald-500" /> {workspaces.length} Completed
            </button>
          </div>
        </div>
      </div>

      <div className="text-xs text-gray-500 mb-3 flex items-center gap-1">
        No filters applied <HelpCircleIcon className="h-3.5 w-3.5" />
      </div>

      <div className="bg-white border border-gray-200 rounded-md overflow-hidden">
        <table className="w-full text-left text-sm border-collapse">
          <thead>
            <tr className="bg-[#f9fafb] border-b border-gray-200 text-gray-800 font-semibold text-xs tracking-wide">
              <th className="px-4 py-3 border-r border-gray-200 cursor-pointer hover:bg-gray-100 flex items-center gap-1">
                Workspace name <SortIcon />
              </th>
              <th className="px-4 py-3 border-r border-gray-200 w-1/4">Repository</th>
              <th className="px-4 py-3 border-r border-gray-200">Health</th>
              <th className="px-4 py-3 border-r border-gray-200">Project</th>
              <th className="px-4 py-3 border-r border-gray-200 cursor-pointer hover:bg-gray-100 text-right flex items-center justify-end gap-1">
                Latest change <SortIcon />
              </th>
              <th className="px-4 py-3 text-center">Manage</th>
            </tr>
          </thead>
          <tbody>
            {loading ? (
              <tr>
                <td colSpan={6} className="px-4 py-8 text-center text-gray-500">
                  Loading workspaces...
                </td>
              </tr>
            ) : filteredWorkspaces.length === 0 ? (
              <tr>
                <td colSpan={6} className="px-4 py-12 text-center text-gray-500">
                  <p className="text-base text-gray-900 font-medium mb-1">No workspaces found</p>
                  <p className="text-sm">Try adjusting your search or filters.</p>
                </td>
              </tr>
            ) : (
              filteredWorkspaces.map((ws) => (
                <tr key={ws.id} className="border-b border-gray-200 hover:bg-gray-50 group">
                  <td className="px-4 py-3 border-r border-gray-200">
                    <div className="flex items-start gap-2">
                      <div className="mt-0.5">
                         <CheckCircle2 className="h-4 w-4 text-emerald-500" />
                      </div>
                      <div>
                        <button
                          onClick={() => navigate(`/app/${orgName}/workspaces/${ws.attributes.name}`)}
                          className="text-gray-900 font-medium hover:underline text-[13px] text-left break-all"
                        >
                          {ws.attributes.name}
                        </button>
                        <div className="text-[11px] text-gray-500 mt-0.5">Planned and finished</div>
                      </div>
                    </div>
                  </td>
                  <td className="px-4 py-3 border-r border-gray-200 text-gray-600 text-[13px]">
                    {ws.attributes["vcs-repo"] ? (
                      <span className="hover:underline cursor-pointer">{ws.attributes["vcs-repo"].identifier}</span>
                    ) : (
                      <span className="text-gray-400">None</span>
                    )}
                  </td>
                  <td className="px-4 py-3 border-r border-gray-200 text-gray-500 text-[13px]">
                    {(ws.attributes["tag-names"] || ws.attributes.tags || []).length > 0 ? (
                      <div className="flex flex-wrap gap-1">
                        {(ws.attributes["tag-names"] || ws.attributes.tags || []).map((tag: string) => (
                          <span key={tag} className="inline-flex items-center rounded-full bg-blue-50 px-2 py-0.5 text-[11px] font-medium text-blue-700 border border-blue-200">
                            {tag}
                          </span>
                        ))}
                      </div>
                    ) : (
                      <span className="text-gray-400">None</span>
                    )}
                  </td>
                  <td className="px-4 py-3 border-r border-gray-200 text-gray-600 text-[13px]">
                    <span className="hover:underline cursor-pointer">Default Project</span>
                  </td>
                  <td className="px-4 py-3 border-r border-gray-200 text-gray-500 text-[13px] text-right">
                    a day ago
                  </td>
                  <td className="px-4 py-3 text-center">
                    <button className="h-8 w-8 rounded border border-gray-200 inline-flex items-center justify-center hover:bg-gray-100 text-gray-500 transition-colors bg-white">
                      <MoreHorizontal className="h-4 w-4" />
                    </button>
                  </td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>

      {!loading && filteredWorkspaces.length > 0 && (
        <div className="flex items-center justify-between mt-4 px-1">
          <div className="text-xs text-gray-500">
            1-{filteredWorkspaces.length} of {filteredWorkspaces.length}
          </div>

          <div className="flex items-center gap-2">
            <button className="text-gray-400 hover:text-gray-600 disabled:opacity-50" disabled>
               <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="m15 18-6-6 6-6"/></svg>
            </button>
            <div className="text-blue-600 font-medium text-sm border-b-2 border-blue-600 px-1 pb-0.5">1</div>
            <button className="text-gray-400 hover:text-gray-600 disabled:opacity-50" disabled>
               <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="m9 18 6-6-6-6"/></svg>
            </button>
          </div>

          <div className="flex items-center gap-2 text-xs text-gray-500">
            <span>Items per page</span>
            <select className="border border-gray-300 rounded-[4px] py-1 px-2 text-gray-700 focus:outline-none focus:border-blue-500 bg-white">
              <option>20</option>
              <option>50</option>
              <option>100</option>
            </select>
          </div>
        </div>
      )}

      {/* Footer minimal text */}
      <div className="mt-16 flex items-center justify-center gap-4 text-xs text-gray-500 pb-8">
        <a href="#" className="hover:text-gray-700">Support</a>
        <a href="#" className="hover:text-gray-700">Terms</a>
        <a href="#" className="hover:text-gray-700">Privacy</a>
        <a href="#" className="hover:text-gray-700">Security</a>
        <a href="#" className="hover:text-gray-700">Accessibility</a>
        <span className="flex items-center gap-1.5 ml-4">
          <div className="font-bold border border-gray-400 rounded-sm px-1 text-[8px] leading-3 uppercase tracking-tighter">IBM</div>
          © 2026 HashiCorp, an IBM Company
        </span>
      </div>
    </div>
  );
}



function SortIcon() {
  return (
    <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="text-gray-400"><path d="m3 16 4 4 4-4"/><path d="M7 20V4"/><path d="m21 8-4-4-4 4"/><path d="M17 4v16"/></svg>
  );
}

function HelpCircleIcon(props: any) {
  return (
    <svg {...props} xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><circle cx="12" cy="12" r="10"/><path d="M9.09 9a3 3 0 0 1 5.83 1c0 2-3 3-3 3"/><path d="M12 17h.01"/></svg>
  );
}
