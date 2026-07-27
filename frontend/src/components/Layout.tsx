import type { ReactNode } from "react";
import { Link, useLocation, useParams, useNavigate } from "react-router-dom";
import {
  Building2,
  HelpCircle,
  FolderGit2,
  Layers,
  Box,
  BookOpen,
  BarChart3,
  Settings,
  Compass,
  ExternalLink,
  ChevronRight,
  ChevronDown,
  ChevronsLeftRight,
  LogOut
} from "lucide-react";

import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "./ui/dropdown-menu";
import { Avatar, AvatarFallback, AvatarImage } from "./ui/avatar";
import { removeAuthToken } from "../lib/api";

export function Layout({ children }: { children: ReactNode }) {
  const { orgName } = useParams();
  const location = useLocation();
  const navigate = useNavigate();

  const isRouteActive = (path: string, exact = false) => {
    if (exact) {
      return location.pathname === path;
    }
    return location.pathname.startsWith(path);
  };

  const handleLogout = () => {
    removeAuthToken();
    navigate("/login");
  };

  return (
    <div className="flex h-screen w-full flex-col font-sans">
      {/* Topbar */}
      <header className="flex h-[52px] shrink-0 items-center justify-between bg-[#111315] px-4 text-white">
        <div className="flex items-center gap-4">
          <Link to="/app" className="flex items-center justify-center hover:opacity-80 transition-opacity">
            {/* Minimal logo placeholder mimicking the screenshot */}
            <svg width="28" height="28" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
              <path d="M12 2L2 7V17L12 22L22 17V7L12 2Z" fill="white" />
              <path d="M12 22V12" stroke="#111315" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"/>
              <path d="M12 12L22 7" stroke="#111315" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"/>
              <path d="M2 7L12 12" stroke="#111315" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"/>
            </svg>
          </Link>

          <div className="h-5 w-px bg-white/20 ml-2" />

          <button className="flex items-center gap-2 rounded border border-white/20 bg-transparent px-3 py-1.5 text-sm font-medium hover:bg-white/10 transition-colors h-8 ml-2">
            <Building2 className="h-4 w-4 opacity-70" />
            <span>{orgName || "Choose an organization"}</span>
            <ChevronDown className="h-3.5 w-3.5 opacity-70 ml-1" />
          </button>
        </div>

        <div className="flex items-center gap-1">
          <button className="flex items-center gap-1 rounded px-2 py-1.5 text-sm hover:bg-white/10 transition-colors h-8 text-gray-300 hover:text-white">
            <HelpCircle className="h-4 w-4" />
            <ChevronDown className="h-3.5 w-3.5 opacity-70" />
          </button>

          <DropdownMenu>
            <DropdownMenuTrigger className="ml-2 flex items-center gap-1 rounded px-2 py-1 hover:bg-white/10 transition-colors h-10 outline-none">
                <Avatar className="h-7 w-7 rounded">
                  <AvatarImage src="" />
                  <AvatarFallback className="rounded bg-gray-600 text-xs text-white">U</AvatarFallback>
                </Avatar>
                <ChevronDown className="h-3.5 w-3.5 opacity-70 text-gray-300" />
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" className="w-56">
              <DropdownMenuLabel>My Account</DropdownMenuLabel>
              <DropdownMenuSeparator />
              <DropdownMenuItem className="cursor-pointer" onClick={async () => navigate("/app/account")}>User Settings</DropdownMenuItem>
              <DropdownMenuItem className="cursor-pointer" onClick={async () => navigate("/app/account")}>Tokens</DropdownMenuItem>
              <DropdownMenuItem className="cursor-pointer font-medium text-blue-600" onClick={async () => navigate("/app/admin")}>Site Administration</DropdownMenuItem>
              <DropdownMenuSeparator />
              <DropdownMenuItem onClick={handleLogout} className="text-red-600 cursor-pointer">
                <LogOut className="mr-2 h-4 w-4" />
                <span>Log out</span>
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
      </header>

      {/* Main Content Area */}
      <div className="flex flex-1 overflow-hidden bg-white">
        {/* Sidebar */}
        <aside className="w-[240px] flex-shrink-0 border-r border-gray-200 bg-[#f9fafb] overflow-y-auto pb-4 flex flex-col">
          <nav className="flex flex-col gap-0.5 p-3">
            {orgName ? (
              <>
                <div className="px-3 pb-2 pt-3 text-xs font-semibold text-gray-500">Manage</div>

                <Link to={`/app/${orgName}/projects`} className={`group flex items-center gap-3 rounded-md px-3 py-2 text-sm transition-colors ${isRouteActive(`/app/${orgName}/projects`) ? 'bg-[#e0eaff] text-blue-700 font-medium' : 'text-gray-700 hover:bg-gray-100 hover:text-gray-900'}`}>
                  <FolderGit2 className={`h-[18px] w-[18px] ${isRouteActive(`/app/${orgName}/projects`) ? 'text-blue-700' : 'text-gray-500 group-hover:text-gray-700'}`} />
                  Projects
                </Link>

                <div className="flex items-center gap-3 rounded-md px-3 py-2 text-sm text-gray-700 cursor-not-allowed opacity-60">
                  <Layers className="h-[18px] w-[18px] text-gray-500" />
                  Stacks
                  <span className="ml-auto rounded border border-gray-200 px-1 py-[1px] text-[10px] font-medium bg-white">New</span>
                </div>

                <Link to={`/app/${orgName}`} className={`group flex items-center gap-3 rounded-md px-3 py-2 text-sm transition-colors ${isRouteActive(`/app/${orgName}`, true) || location.pathname.includes('/workspaces/') ? 'bg-[#e0eaff] text-blue-700 font-medium' : 'text-gray-700 hover:bg-gray-100 hover:text-gray-900'}`}>
                  <Box className={`h-[18px] w-[18px] ${isRouteActive(`/app/${orgName}`, true) || location.pathname.includes('/workspaces/') ? 'text-blue-700' : 'text-gray-500 group-hover:text-gray-700'}`} />
                  Workspaces
                </Link>

                <Link to={`/app/${orgName}/registry`} className={`group flex items-center justify-between rounded-md px-3 py-2 text-sm transition-colors ${isRouteActive(`/app/${orgName}/registry`) ? 'bg-[#e0eaff] text-blue-700 font-medium' : 'text-gray-700 hover:bg-gray-100 hover:text-gray-900'}`}>
                  <div className="flex items-center gap-3">
                    <BookOpen className={`h-[18px] w-[18px] ${isRouteActive(`/app/${orgName}/registry`) ? 'text-blue-700' : 'text-gray-500 group-hover:text-gray-700'}`} />
                    Registry
                  </div>
                  <ChevronRight className="h-4 w-4 opacity-50" />
                </Link>

                <Link to={`/app/${orgName}/usage`} className={`group flex items-center gap-3 rounded-md px-3 py-2 text-sm transition-colors ${isRouteActive(`/app/${orgName}/usage`) ? 'bg-[#e0eaff] text-blue-700 font-medium' : 'text-gray-700 hover:bg-gray-100 hover:text-gray-900'}`}>
                  <BarChart3 className={`h-[18px] w-[18px] ${isRouteActive(`/app/${orgName}/usage`) ? 'text-blue-700' : 'text-gray-500 group-hover:text-gray-700'}`} />
                  Usage
                </Link>

                <Link to={`/app/${orgName}/settings`} className={`group flex items-center justify-between rounded-md px-3 py-2 text-sm transition-colors ${isRouteActive(`/app/${orgName}/settings`) ? 'bg-[#e0eaff] text-blue-700 font-medium' : 'text-gray-700 hover:bg-gray-100 hover:text-gray-900'}`}>
                  <div className="flex items-center gap-3">
                    <Settings className={`h-[18px] w-[18px] ${isRouteActive(`/app/${orgName}/settings`) ? 'text-blue-700' : 'text-gray-500 group-hover:text-gray-700'}`} />
                    Settings
                  </div>
                  <ChevronRight className="h-4 w-4 opacity-50" />
                </Link>

                <div className="mt-6 px-3 pb-2 pt-3 text-xs font-semibold text-gray-500">Visibility</div>

                <Link to={`/app/${orgName}/explorer`} className={`group flex items-center gap-3 rounded-md px-3 py-2 text-sm transition-colors ${isRouteActive(`/app/${orgName}/explorer`) ? 'bg-[#e0eaff] text-blue-700 font-medium' : 'text-gray-700 hover:bg-gray-100 hover:text-gray-900'}`}>
                  <Compass className={`h-[18px] w-[18px] ${isRouteActive(`/app/${orgName}/explorer`) ? 'text-blue-700' : 'text-gray-500 group-hover:text-gray-700'}`} />
                  Explorer
                </Link>

                <div className="mt-6 px-3 pb-2 pt-3 text-xs font-semibold text-gray-500">Cloud Platform</div>

                <a href="#" className="group flex items-center justify-between rounded-md px-3 py-2 text-sm text-gray-700 hover:bg-gray-100 hover:text-gray-900 transition-colors">
                  <div className="flex items-center gap-3">
                    <div className="flex h-[18px] w-[18px] items-center justify-center font-bold text-gray-500 group-hover:text-gray-700">
                      <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M4 22h14a2 2 0 0 0 2-2V7.5L14.5 2H6a2 2 0 0 0-2 2v4"/><polyline points="14 2 14 8 20 8"/><path d="M2 15h10"/><path d="M9 18v-6"/></svg>
                    </div>
                    HashiCorp Cloud Platform
                  </div>
                  <ExternalLink className="h-3.5 w-3.5 opacity-50" />
                </a>
              </>
            ) : (
              <>
                <Link to={`/app`} className={`group flex items-center gap-3 rounded-md px-3 py-2 text-sm font-medium transition-colors ${isRouteActive(`/app`, true) ? 'bg-[#e0eaff] text-blue-700' : 'text-gray-700 hover:bg-gray-100 hover:text-gray-900'}`}>
                  <Building2 className={`h-[18px] w-[18px] ${isRouteActive(`/app`, true) ? 'text-blue-700' : 'text-blue-600'}`} />
                  Organizations
                </Link>
              </>
            )}
          </nav>
        </aside>

        {/* Main Content */}
        <main className="flex-1 overflow-auto bg-white flex flex-col relative">
          {/* TFE style left border toggle placeholder */}
          <div className="absolute left-0 top-0 bottom-0 w-8 flex flex-col items-center py-4 z-10 pointer-events-none">
             <button className="h-6 w-6 rounded flex items-center justify-center pointer-events-auto group mt-[-10px] ml-[-12px]">
                <div className="bg-white border border-gray-200 rounded p-0.5 shadow-sm opacity-0 group-hover:opacity-100 transition-opacity">
                  <ChevronsLeftRight className="h-3 w-3 text-gray-400" />
                </div>
             </button>
          </div>

          <div className="flex-1 px-8 py-8 w-full">
            {children}
          </div>
        </main>
      </div>
    </div>
  );
}
