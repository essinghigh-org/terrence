import { useEffect, useState, type JSX } from "react";
import { useNavigate } from "react-router-dom";
import {
  Box,
  Building2,
  FolderGit2,
  LayoutDashboard,
  Package,
  Search,
  Settings,
  UserRound,
  Variable,
} from "lucide-react";

import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "./ui/dialog";
import { Input } from "./ui/input";
import { fetchAllApiPages } from "../lib/api";

type CommandItemType = {
  id: string;
  category: "Navigation" | "Organizations" | "Workspaces" | "Actions";
  icon: typeof Box;
  title: string;
  subtitle?: string | undefined;
  perform: () => void;
};

export function CommandPalette({
  open,
  onOpenChange,
  currentOrgName,
}: Readonly<{
  open: boolean;
  onOpenChange: (open: boolean) => void;
  currentOrgName?: string | undefined;
}>): JSX.Element {
  const navigate = useNavigate();
  const [search, setSearch] = useState("");
  const [orgs, setOrgs] = useState<{ name: string }[]>([]);
  const [workspaces, setWorkspaces] = useState<{ name: string }[]>([]);

  useEffect(() => {
    if (!open) return;
    setSearch("");
    const controller = new AbortController();

    void fetchAllApiPages<{ attributes: { name: string } }>(
      "/organizations?page[size]=100",
      controller.signal,
    ).then((result) => {
      if (!controller.signal.aborted) {
        setOrgs(result.map((o) => ({ name: o.attributes.name })));
      }
    }).catch(() => {});

    if (currentOrgName !== undefined && currentOrgName !== "") {
      void fetchAllApiPages<{ attributes: { name: string } }>(
        `/organizations/${encodeURIComponent(currentOrgName)}/workspaces?page[size]=100`,
        controller.signal,
      ).then((result) => {
        if (!controller.signal.aborted) {
          setWorkspaces(result.map((w) => ({ name: w.attributes.name })));
        }
      }).catch(() => {});
    }

    return () => {
      controller.abort();
    };
  }, [open, currentOrgName]);

  const items: CommandItemType[] = [
    {
      id: "nav-dash",
      category: "Navigation",
      icon: LayoutDashboard,
      title: "All Organizations Dashboard",
      perform: () => {
        navigate("/app");
        onOpenChange(false);
      },
    },
    {
      id: "nav-account",
      category: "Navigation",
      icon: UserRound,
      title: "Account Settings",
      subtitle: "Profile, Sessions, Security & API Tokens",
      perform: () => {
        navigate("/app/account");
        onOpenChange(false);
      },
    },
    ...(currentOrgName !== undefined && currentOrgName !== ""
      ? [
          {
            id: "nav-workspaces",
            category: "Navigation" as const,
            icon: Box,
            title: `${currentOrgName} / Workspaces`,
            perform: () => {
              navigate(`/app/${encodeURIComponent(currentOrgName)}/workspaces`);
              onOpenChange(false);
            },
          },
          {
            id: "nav-projects",
            category: "Navigation" as const,
            icon: FolderGit2,
            title: `${currentOrgName} / Projects`,
            perform: () => {
              navigate(`/app/${encodeURIComponent(currentOrgName)}/projects`);
              onOpenChange(false);
            },
          },
          {
            id: "nav-registry",
            category: "Navigation" as const,
            icon: Package,
            title: `${currentOrgName} / Registry`,
            perform: () => {
              navigate(`/app/${encodeURIComponent(currentOrgName)}/registry`);
              onOpenChange(false);
            },
          },
          {
            id: "nav-var-sets",
            category: "Navigation" as const,
            icon: Variable,
            title: `${currentOrgName} / Variable Sets`,
            perform: () => {
              navigate(`/app/${encodeURIComponent(currentOrgName)}/variable-sets`);
              onOpenChange(false);
            },
          },
          {
            id: "nav-org-settings",
            category: "Navigation" as const,
            icon: Settings,
            title: `${currentOrgName} / Organization Settings`,
            perform: () => {
              navigate(`/app/${encodeURIComponent(currentOrgName)}/settings`);
              onOpenChange(false);
            },
          },
        ]
      : []),
    ...orgs.map((org) => ({
      id: `org-${org.name}`,
      category: "Organizations" as const,
      icon: Building2,
      title: org.name,
      subtitle: "Switch organization",
      perform: () => {
        navigate(`/app/${encodeURIComponent(org.name)}/workspaces`);
        onOpenChange(false);
      },
    })),
    ...(currentOrgName !== undefined && currentOrgName !== ""
      ? workspaces.map((ws) => ({
          id: `ws-${ws.name}`,
          category: "Workspaces" as const,
          icon: Box,
          title: ws.name,
          subtitle: `Workspace in ${currentOrgName}`,
          perform: () => {
            navigate(
              `/app/${encodeURIComponent(currentOrgName)}/workspaces/${encodeURIComponent(ws.name)}`,
            );
            onOpenChange(false);
          },
        }))
      : []),
  ];

  const query = search.trim().toLowerCase();
  const filtered = query === ""
    ? items.slice(0, 10)
    : items.filter((item) =>
        item.title.toLowerCase().includes(query) ||
        (item.subtitle?.toLowerCase().includes(query) ?? false) ||
        item.category.toLowerCase().includes(query),
      );

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-xl p-0 gap-0 overflow-hidden shadow-2xl">
        <DialogHeader className="sr-only">
          <DialogTitle>Quick Command Palette</DialogTitle>
        </DialogHeader>
        <div className="flex items-center border-b px-3.5 py-2.5">
          <Search className="mr-2.5 size-4 text-muted-foreground shrink-0" />
          <Input
            autoFocus
            className="border-0 shadow-none focus-visible:ring-0 focus-visible:ring-offset-0 text-base"
            placeholder="Type a command or search organizations & workspaces..."
            value={search}
            onChange={(e) => { setSearch(e.target.value); }}
          />
          <kbd className="pointer-events-none hidden select-none items-center gap-1 rounded border bg-muted px-1.5 font-mono text-[10px] font-medium text-muted-foreground opacity-100 sm:flex">
            ESC
          </kbd>
        </div>

        <div className="max-h-[350px] overflow-y-auto p-2">
          {filtered.length === 0 ? (
            <div className="py-8 text-center text-sm text-muted-foreground">
              No matching commands or resources found.
            </div>
          ) : (
            <div className="space-y-1">
              {filtered.map((item) => {
                // eslint-disable-next-line @typescript-eslint/naming-convention
                const IconComponent = item.icon;
                return (
                  <button
                    key={item.id}
                    type="button"
                    className="w-full flex items-center justify-between gap-3 rounded-md px-3 py-2.5 text-left text-sm transition-colors hover:bg-accent hover:text-accent-foreground focus-visible:bg-accent focus-visible:outline-none"
                    onClick={item.perform}
                  >
                    <div className="flex items-center gap-3 min-w-0">
                      <IconComponent className="size-4 shrink-0 text-muted-foreground" />
                      <div className="truncate">
                        <p className="font-medium truncate">{item.title}</p>
                        {item.subtitle !== undefined && item.subtitle !== "" && (
                          <p className="text-xs text-muted-foreground truncate">{item.subtitle}</p>
                        )}
                      </div>
                    </div>
                    <span className="text-[10px] uppercase font-semibold text-muted-foreground/70 shrink-0">
                      {item.category}
                    </span>
                  </button>
                );
              })}
            </div>
          )}
        </div>

        <div className="border-t bg-muted/30 px-3.5 py-2 text-xs text-muted-foreground flex items-center justify-between">
          <span>Use search to quickly jump to any destination</span>
          <span className="font-mono text-[11px]">⌘K / Ctrl+K</span>
        </div>
      </DialogContent>
    </Dialog>
  );
}
