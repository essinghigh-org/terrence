import { useEffect, useId, useRef, useState, type JSX } from "react";
import { useNavigate } from "react-router-dom";
import {
  Box,
  BookOpen,
  Building2,
  Clipboard,
  FolderGit2,
  History,
  LayoutDashboard,
  Lock,
  Package,
  PlayCircle,
  Plus,
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
import { fetchAllApiPages, fetchApi } from "../lib/api";
import { getRecentWorkspaces, subscribeWorkspaceShortcuts } from "../lib/workspace-shortcuts";

type CommandItemType = {
  id: string;
  category: "Navigation" | "Organizations" | "Workspaces" | "Actions" | "Recent" | "Documentation";
  icon: typeof Box;
  title: string;
  subtitle?: string | undefined;
  perform: () => void;
};

export function CommandPalette({
  open,
  onOpenChange,
  currentOrgName,
  currentWorkspaceName,
  canManageWorkspaces,
}: Readonly<{
  open: boolean;
  onOpenChange: (open: boolean) => void;
  currentOrgName?: string | undefined;
  currentWorkspaceName?: string | undefined;
  canManageWorkspaces: boolean;
}>): JSX.Element {
  const navigate = useNavigate();
  const [search, setSearch] = useState("");
  // Highlighted row of the flattened result list (visual order). Keyboard
  // selection and aria-activedescendant both key off this single index so
  // what screen readers announce always matches what is visually highlighted.
  const [highlightedIndex, setHighlightedIndex] = useState(0);
  const listboxId = useId();
  const optionId = (index: number): string => `${listboxId}-option-${index}`;
  const listRef = useRef<HTMLDivElement | null>(null);
  const inputRef = useRef<HTMLInputElement | null>(null);
  const [orgs, setOrgs] = useState<{ name: string }[]>([]);
  const [workspaces, setWorkspaces] = useState<{ name: string }[]>([]);
  const [docs, setDocs] = useState<{ slug: string; title: string; category: string }[]>([]);
  const [, setRecentRevision] = useState(0);
  // 14.18: keep the Recent list live while the palette is open (a visit made
  // elsewhere in the sidebar bumps the revision through the shortcut bus).
  useEffect((): (() => void) | undefined => {
    if (!open) return undefined;
    return subscribeWorkspaceShortcuts((): void => {
      setRecentRevision((r) => r + 1);
    });
  }, [open]);

  useEffect(() => {
    if (!open) return;
    setSearch("");
    setHighlightedIndex(0);
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

    // Bundled documentation index: every doc page is reachable from the
    // palette so cmd+k works as the product-wide search surface.
    void fetchApi<{ data?: unknown }>("/docs", { signal: controller.signal })
      .then((result) => {
        if (controller.signal.aborted) return;
        const records = (result as { data?: unknown }).data;
        if (!Array.isArray(records)) return;
        setDocs(records.flatMap((record): { slug: string; title: string; category: string }[] => {
          const attributes = (record as { attributes?: unknown }).attributes;
          if (typeof attributes !== "object" || attributes === null) return [];
          const entry = attributes as { slug?: unknown; title?: unknown; category?: unknown };
          if (typeof entry.slug !== "string" || typeof entry.title !== "string" || typeof entry.category !== "string") return [];
          return [{ slug: entry.slug, title: entry.title, category: entry.category }];
        }));
      }).catch(() => {});

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
    ...docs.map((doc) => ({
      id: `doc-${doc.slug}`,
      category: "Documentation" as const,
      icon: BookOpen,
      title: doc.title,
      subtitle: doc.category,
      perform: () => {
        navigate(`/app/docs/${encodeURIComponent(doc.slug)}`);
        onOpenChange(false);
      },
    })),
    // 14.17: permission-aware actions. Workspace-scoped actions are only shown
    // when a workspace is on screen; the "New workspace" action is gated on the
    // can-manage-workspaces permission.
    ...(currentOrgName !== undefined && currentOrgName !== ""
      ? [
          ...(canManageWorkspaces
            ? [{
                id: "act-new-workspace",
                category: "Actions" as const,
                icon: Plus,
                title: "New workspace",
                subtitle: `Create a workspace in ${currentOrgName}`,
                perform: () => {
                  navigate(`/app/${encodeURIComponent(currentOrgName)}/workspaces/new`);
                  onOpenChange(false);
                },
              }]
            : []),
          ...(currentWorkspaceName !== undefined && currentWorkspaceName !== ""
            ? [
                {
                  id: "act-queue-plan",
                  category: "Actions" as const,
                  icon: PlayCircle,
                  title: "Queue plan",
                  subtitle: `Run a plan on ${currentWorkspaceName}`,
                  perform: () => {
                    navigate(
                      `/app/${encodeURIComponent(currentOrgName)}/workspaces/${encodeURIComponent(currentWorkspaceName)}/runs/new`,
                    );
                    onOpenChange(false);
                  },
                },
                {
                  id: "act-copy-workspace-id",
                  category: "Actions" as const,
                  icon: Clipboard,
                  title: "Copy workspace ID",
                  subtitle: currentWorkspaceName,
                  perform: () => {
                    void (async (): Promise<void> => {
                      try {
// SAFETY: the endpoint contract returns the JSON:API envelope with this data shape.
                        const response = await fetchApi(
                          `/organizations/${encodeURIComponent(currentOrgName)}/workspaces/${encodeURIComponent(currentWorkspaceName)}`,
                        ) as { data?: { id?: string } };
                        const wsId = response.data?.id;
                        if (wsId !== undefined) {
                          await navigator.clipboard.writeText(wsId);
                        }
                      } catch {
                        // clipboard copy is best-effort; ignore non-fatal failures
                      }
                      onOpenChange(false);
                    })();
                  },
                },
                {
                  id: "act-open-latest-run",
                  category: "Actions" as const,
                  icon: History,
                  title: "Open latest run",
                  subtitle: currentWorkspaceName,
                  perform: () => {
                    void (async (): Promise<void> => {
                      try {
                        // Runs are API-keyed by workspace ID (GET
                        // /api/v2/workspaces/:workspace_id/runs), so resolve the
                        // workspace ID from its org/name path first, then fetch
                        // the newest run (sort=-created-at, page[size]=1).
// SAFETY: the endpoint contract returns the JSON:API envelope with this data shape.
                        const wsResponse = await fetchApi(
                          `/organizations/${encodeURIComponent(currentOrgName)}/workspaces/${encodeURIComponent(currentWorkspaceName)}`,
                        ) as { data?: { id?: string } };
                        const wsId = wsResponse.data?.id;
                        if (wsId === undefined) return;
// SAFETY: the endpoint contract returns the JSON:API envelope with this data shape.
                        const runsResponse = await fetchApi(
                          `/workspaces/${encodeURIComponent(wsId)}/runs?page[size]=1&sort=-created-at`,
                        ) as { data?: { id?: string }[] };
                        const runId = runsResponse.data?.[0]?.id;
                        if (runId !== undefined) {
                          navigate(
                            `/app/${encodeURIComponent(currentOrgName)}/workspaces/${encodeURIComponent(currentWorkspaceName)}/runs/${encodeURIComponent(runId)}`,
                          );
                        }
                      } catch {
                        // no-op: if we cannot resolve the latest run, stay put
                      }
                      onOpenChange(false);
                    })();
                  },
                },
                {
                  // Lock/unlock the current workspace (drive-by toggle).
                  id: "act-toggle-lock",
                  category: "Actions" as const,
                  icon: Lock,
                  title: "Toggle workspace lock",
                  subtitle: currentWorkspaceName,
                  perform: () => {
                    navigate(
                      `/app/${encodeURIComponent(currentOrgName)}/workspaces/${encodeURIComponent(currentWorkspaceName)}/settings#lock`,
                    );
                    onOpenChange(false);
                  },
                },
              ]
            : []),
        ]
      : []),
  ];

  const query = search.trim().toLowerCase();
  const recentItems: CommandItemType[] = getRecentWorkspaces().map((visit): CommandItemType => ({
    id: `recent-${visit.orgName}-${visit.workspaceName}`,
    category: "Recent",
    icon: History,
    title: visit.workspaceName,
    subtitle: `Workspace in ${visit.orgName}`,
    perform: () => {
      navigate(
        `/app/${encodeURIComponent(visit.orgName)}/workspaces/${encodeURIComponent(visit.workspaceName)}`,
      );
      onOpenChange(false);
    },
  }));
  // 14.18: when the query is empty, surface recently-visited workspaces (most
  // recent first) ahead of the generic navigation items. When the user types,
  // search runs over the full item list as usual.
  const filtered = query === ""
    ? [...recentItems, ...items].slice(0, 14)
    : items.filter((item) =>
        item.title.toLowerCase().includes(query) ||
        (item.subtitle?.toLowerCase().includes(query) ?? false) ||
        item.category.toLowerCase().includes(query),
      );

  // Keep the highlight pinned to a real row as the result set shrinks or grows.
  const clampedIndex = filtered.length === 0 ? 0 : Math.min(highlightedIndex, filtered.length - 1);

  const moveHighlight = (delta: number): void => {
    if (filtered.length === 0) return;
    // Base the move on the clamped index: the raw state can be stale when the
    // result set shrinks while the palette is open (late fetch resolving).
    const next = clampedIndex + delta;
    // Wrap around so ↓ at the bottom returns to the top and vice versa.
    if (next < 0) setHighlightedIndex(filtered.length - 1);
    else if (next >= filtered.length) setHighlightedIndex(0);
    else setHighlightedIndex(next);
  };

  const handleInputKeyDown = (e: React.KeyboardEvent<HTMLInputElement>): void => {
    switch (e.key) {
      case "ArrowDown":
        e.preventDefault();
        moveHighlight(1);
        break;
      case "ArrowUp":
        e.preventDefault();
        moveHighlight(-1);
        break;
      case "Home":
        e.preventDefault();
        setHighlightedIndex(0);
        break;
      case "End":
        e.preventDefault();
        setHighlightedIndex(Math.max(0, filtered.length - 1));
        break;
      case "Enter": {
        e.preventDefault();
        const selected = filtered[clampedIndex];
        if (selected !== undefined) selected.perform();
        break;
      }
      default:
        break;
    }
  };

  // Follow the highlight with the scroll position. The highlight only moves
  // via keyboard or result-set changes, so this never fights mouse users;
  // block:nearest keeps jumps minimal.
  useEffect((): void => {
    if (!open) return;
    const row = listRef.current?.querySelector(`[id="${listboxId}-option-${clampedIndex}"]`);
    row?.scrollIntoView({ block: "nearest" });
  }, [clampedIndex, open, listboxId]);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent align="top" hideClose className="max-w-xl p-0 gap-0 overflow-hidden shadow-2xl">
        <DialogHeader className="sr-only">
          <DialogTitle>Quick Command Palette</DialogTitle>
        </DialogHeader>
        <div className="flex items-center border-b px-3.5 py-2.5">
          <Search className="mr-2.5 size-4 text-muted-foreground shrink-0" />
          <Input
            id="command-palette-search"
            name="command-palette-search"
            type="search"
            autoComplete="off"
            role="combobox"
            aria-expanded
            aria-controls={listboxId}
            aria-activedescendant={
              filtered.length > 0 ? optionId(clampedIndex) : undefined
            }
            aria-label="Search commands and resources"
            ref={inputRef}
            autoFocus
            className="border-0 shadow-none focus-visible:ring-0 focus-visible:ring-offset-0 text-base"
            placeholder="Type a command or search organizations & workspaces…"
            value={search}
            // onInput rather than onChange mirrors the rest of the codebase
            // (Login, forms): per-keystroke semantics, and it stays drivable
            // from tests where Base UI portals swallow the change event.
            onInput={(e: React.SyntheticEvent<HTMLInputElement>) => {
              setSearch(e.currentTarget.value);
              setHighlightedIndex(0);
            }}
            onKeyDown={handleInputKeyDown}
          />
          <kbd className="pointer-events-none hidden select-none items-center gap-1 rounded border bg-muted px-1.5 font-mono text-[10px] font-medium text-muted-foreground opacity-100 sm:flex">
            ESC
          </kbd>
        </div>

        <div
          ref={listRef}
          id={listboxId}
          role="listbox"
          aria-label="Command results"
          className="max-h-[350px] overflow-y-auto p-2"
        >
          {filtered.length === 0 ? (
            <div className="py-8 text-center text-sm text-muted-foreground">
              No matching commands or resources found.
            </div>
          ) : (
            <div className="space-y-1">
              {(() => {
                const grouped = new Map<string, CommandItemType[]>();
                for (const item of filtered) {
                  const list = grouped.get(item.category) ?? [];
                  list.push(item);
                  grouped.set(item.category, list);
                }
                const categoryOrder = ["Recent", "Actions", "Navigation", "Workspaces", "Organizations", "Documentation"];
                const rows: React.JSX.Element[] = [];
                let flatIndex = 0;
                for (const category of categoryOrder) {
                  const list = grouped.get(category);
                  if (list === undefined) continue;
                  const groupStart = flatIndex;
                  flatIndex += list.length;
                  rows.push(
                    <div key={category} className="pt-1 first:pt-0">
                      {query === "" && (
                        <p className="px-3 py-1 text-[10px] uppercase font-semibold tracking-wide text-muted-foreground/60">
                          {category}
                        </p>
                      )}
                      {list.map((item, indexInGroup): JSX.Element => {
                        const IconComponent = item.icon;
                        const index = groupStart + indexInGroup;
                        const highlighted = index === clampedIndex;
                        return (
                          <button
                            key={item.id}
                            id={optionId(index)}
                            type="button"
                            role="option"
                            aria-selected={highlighted}
                            data-highlighted={highlighted || undefined}
                            className="w-full flex items-center justify-between gap-3 rounded-md px-3 py-2.5 text-left text-sm transition-colors hover:bg-accent hover:text-accent-foreground focus-visible:outline-none data-highlighted:bg-accent data-highlighted:text-accent-foreground"
                            onMouseMove={(): void => {
                              if (!highlighted) setHighlightedIndex(index);
                            }}
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
                    </div>,
                  );
                }
                // Any category not in the fixed order (e.g. a future one).
                for (const [category, list] of grouped) {
                  if (categoryOrder.includes(category)) continue;
                  for (const item of list) {
                    const index = flatIndex;
                    flatIndex += 1;
                    const highlighted = index === clampedIndex;
                    rows.push(
                      <button
                        key={item.id}
                        id={optionId(index)}
                        type="button"
                        role="option"
                        aria-selected={highlighted}
                        data-highlighted={highlighted || undefined}
                        className="w-full flex items-center justify-between gap-3 rounded-md px-3 py-2.5 text-left text-sm transition-colors hover:bg-accent hover:text-accent-foreground focus-visible:outline-none data-highlighted:bg-accent data-highlighted:text-accent-foreground"
                        onMouseMove={(): void => {
                          if (!highlighted) setHighlightedIndex(index);
                        }}
                        onClick={item.perform}
                      >
                        <span>{item.title}</span>
                        <span className="text-[10px] uppercase font-semibold text-muted-foreground/70">{item.category}</span>
                      </button>,
                    );
                  }
                }
                return rows;
              })()}
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