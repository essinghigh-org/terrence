import type { JSX } from "react";
import { Keyboard } from "lucide-react";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "./ui/dialog";

type Shortcut = Readonly<{
  keys: string;
  description: string;
}>;

type ShortcutGroup = Readonly<{
  label: string;
  shortcuts: readonly Shortcut[];
}>;

const isMac = typeof navigator !== "undefined" && /Mac|iPhone|iPad/.test(navigator.platform ?? navigator.userAgent);
const MOD_KEY = isMac ? "⌘ K" : "Ctrl + K";

const GROUPS: readonly ShortcutGroup[] = [
  {
    label: "General",
    shortcuts: [
      { keys: MOD_KEY, description: "Open or close the command palette" },
      { keys: "?", description: "Toggle this keyboard shortcuts help" },
      { keys: "Esc", description: "Close the active dialog or menu" },
    ],
  },
  {
    label: "Navigation",
    shortcuts: [
      { keys: "/", description: "Search commands and resources" },
      { keys: "g then w", description: "Go to workspaces" },
      { keys: "g then h", description: "Go to account settings" },
    ],
  },
  {
    label: "Command palette",
    shortcuts: [
      { keys: "↑ ↓", description: "Move between results (wraps around)" },
      { keys: "Enter", description: "Activate the highlighted result" },
      { keys: "Home / End", description: "Jump to first / last result" },
    ],
  },
  {
    label: "Layout",
    shortcuts: [
      { keys: "[", description: "Collapse or expand the sidebar" },
    ],
  },
];

export function ShortcutsHelpModal({
  open,
  onOpenChange,
}: Readonly<{
  open: boolean;
  onOpenChange: (open: boolean) => void;
}>): JSX.Element {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <div className="flex items-center gap-2">
            <Keyboard className="size-5 text-primary" />
            <DialogTitle>Keyboard Shortcuts</DialogTitle>
          </div>
          <DialogDescription>
            Quick navigation and control shortcuts for Terrence.
          </DialogDescription>
        </DialogHeader>

        <div className="max-h-[60vh] space-y-4 overflow-y-auto py-2 pr-1">
          {GROUPS.map((group) => (
            <section key={group.label} aria-label={`${group.label} shortcuts`}>
              <p className="mb-1.5 text-[10px] uppercase font-semibold tracking-wide text-muted-foreground/70">
                {group.label}
              </p>
              <div className="space-y-1">
                {group.shortcuts.map((shortcut) => (
                  <div
                    key={shortcut.keys}
                    className="flex items-center justify-between gap-4 rounded-md border px-2.5 py-1.5 text-sm"
                  >
                    <span className="text-muted-foreground">{shortcut.description}</span>
                    <kbd className="shrink-0 rounded border bg-muted px-1.5 py-0.5 font-mono text-xs font-semibold whitespace-nowrap">
                      {shortcut.keys}
                    </kbd>
                  </div>
                ))}
              </div>
            </section>
          ))}
        </div>

        <p className="pt-1 text-xs text-muted-foreground">
          Shortcut hints also appear as tooltips when the sidebar is collapsed.
        </p>
      </DialogContent>
    </Dialog>
  );
}
