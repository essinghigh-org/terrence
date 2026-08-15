import type { JSX } from "react";
import { Keyboard } from "lucide-react";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "./ui/dialog";

export function ShortcutsHelpModal({
  open,
  onOpenChange,
}: Readonly<{
  open: boolean;
  onOpenChange: (open: boolean) => void;
}>): JSX.Element {
  const shortcuts = [
    { key: "⌘ K / Ctrl + K", description: "Open Command Palette & Jump Search" },
    { key: "?", description: "Toggle Keyboard Shortcuts Help" },
    { key: "Esc", description: "Close modal / dialog windows" },
  ];

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

        <div className="space-y-2 py-2">
          {shortcuts.map((shortcut) => (
            <div
              key={shortcut.key}
              className="flex items-center justify-between gap-4 rounded-md border p-2.5 text-sm"
            >
              <span className="text-muted-foreground">{shortcut.description}</span>
              <kbd className="font-mono text-xs bg-muted border rounded px-2 py-1 font-semibold">
                {shortcut.key}
              </kbd>
            </div>
          ))}
        </div>
      </DialogContent>
    </Dialog>
  );
}