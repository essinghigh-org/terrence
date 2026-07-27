import { useEffect, useState } from "react";
import { fetchApi } from "../lib/api";
import { useNavigate } from "react-router-dom";
import { Search, Plus, MoreHorizontal } from "lucide-react";
import { Button } from "../components/ui/button";

export function Dashboard() {
  const [orgs, setOrgs] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState("");
  const navigate = useNavigate();

  useEffect(() => {
    loadOrgs();
  }, []);

  async function loadOrgs() {
    try {
      const data = await fetchApi("/api/v2/organizations");
      setOrgs(data.data || []);
    } catch (err) {
      console.error(err);
    } finally {
      setLoading(false);
    }
  }

  const filteredOrgs = orgs.filter((org) =>
    org.attributes.name.toLowerCase().includes(search.toLowerCase())
  );

  return (
    <div className="max-w-[1200px] w-full">
      <div className="flex items-center justify-between mb-6">
        <h1 className="text-3xl font-bold text-gray-900 tracking-tight">Organizations</h1>
        <Button className="bg-[#2962ff] hover:bg-[#1a4bcf] text-white rounded-[4px] h-9 px-4 shadow-none font-medium">
          <Plus className="mr-2 h-4 w-4" /> Create organization
        </Button>
      </div>

      <p className="text-gray-500 mb-6 text-[15px]">
        Terraform organizations let you manage organizations, projects, and teams.
      </p>

      <div className="mb-6 relative w-full max-w-sm">
        <div className="absolute inset-y-0 left-0 pl-3 flex items-center pointer-events-none">
          <Search className="h-4 w-4 text-gray-400" />
        </div>
        <input
          type="text"
          placeholder="Search by organization name"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          className="pl-9 pr-4 py-1.5 w-full border border-gray-300 rounded-[4px] text-sm focus:outline-none focus:ring-1 focus:ring-blue-500 focus:border-blue-500 placeholder-gray-400"
        />
      </div>

      <div className="bg-white border border-gray-200 rounded-md overflow-hidden">
        <table className="w-full text-left text-sm border-collapse">
          <thead>
            <tr className="bg-[#f9fafb] border-b border-gray-200 text-gray-600 font-semibold text-xs">
              <th className="px-4 py-3 w-1/3">Organization name</th>
              <th className="px-4 py-3 w-1/2">Organization type</th>
              <th className="px-4 py-3 text-right">Actions</th>
            </tr>
          </thead>
          <tbody>
            {loading ? (
              <tr>
                <td colSpan={3} className="px-4 py-8 text-center text-gray-500">
                  Loading organizations...
                </td>
              </tr>
            ) : filteredOrgs.length === 0 ? (
              <tr>
                <td colSpan={3} className="px-4 py-8 text-center text-gray-500">
                  No organizations found.
                </td>
              </tr>
            ) : (
              filteredOrgs.map((org) => (
                <tr
                  key={org.id}
                  className="border-b border-gray-200 hover:bg-gray-50 transition-colors group"
                >
                  <td className="px-4 py-3">
                    <button
                      onClick={() => navigate(`/app/${org.attributes.name}`)}
                      className="text-gray-900 font-medium hover:underline text-[13px]"
                    >
                      {org.attributes.name}
                    </button>
                  </td>
                  <td className="px-4 py-3 text-gray-600 text-[13px] flex items-center gap-2">
                    <div className="text-purple-600 flex items-center justify-center">
                      {/* Terraform minimal logo for standalone type */}
                      <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor" xmlns="http://www.w3.org/2000/svg">
                        <path d="M12 2L2 7V17L12 22L22 17V7L12 2Z" fill="currentColor" />
                      </svg>
                    </div>
                    Terraform standalone
                  </td>
                  <td className="px-4 py-3 text-right">
                    <button className="h-8 w-8 rounded border border-gray-200 flex items-center justify-center hover:bg-gray-100 text-gray-500 ml-auto transition-colors">
                      <MoreHorizontal className="h-4 w-4" />
                    </button>
                  </td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>

      {!loading && filteredOrgs.length > 0 && (
        <div className="flex items-center justify-between mt-4 px-1">
          <div className="text-xs text-gray-500">
            1-{filteredOrgs.length} of {filteredOrgs.length}
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
              <option>10</option>
              <option>20</option>
              <option>50</option>
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
