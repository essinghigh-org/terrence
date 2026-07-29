import { useState, useEffect } from "react";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Spinner } from "@/components/ui/spinner";
import { AlertTriangle } from "lucide-react";

export type ConfirmDialogProps = Readonly<{
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: string;
  description?: React.ReactNode;
  confirmText?: string;
  cancelText?: string;
  confirmVariant?: "destructive" | "default" | "outline";
  requireText?: string | undefined;
  requireTextLabel?: string;
  onConfirm: () => void | Promise<void>;
  loading?: boolean;
}>;

export function ConfirmDialog({
  open,
  onOpenChange,
  title,
  description,
  confirmText = "Confirm",
  cancelText = "Cancel",
  confirmVariant = "destructive",
  requireText,
  requireTextLabel,
  onConfirm,
  loading = false,
}: ConfirmDialogProps): React.JSX.Element {
  const [typedText, setTypedText] = useState("");

  useEffect((): void => {
    if (open) {
      setTypedText("");
    }
  }, [open]);

  const isConfirmed = requireText !== undefined ? typedText.trim() === requireText.trim() : true;

  const handleFormSubmit = (e: React.FormEvent): void => {
    e.preventDefault();
    if (!isConfirmed || loading) return;
    void onConfirm();
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-[460px] animate-in fade-in-0 zoom-in-95 duration-200">
        <form onSubmit={handleFormSubmit}>
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2 text-lg font-semibold text-foreground">
              {confirmVariant === "destructive" && (
                <div className="flex size-8 shrink-0 items-center justify-center rounded-full bg-destructive/10 text-destructive">
                  <AlertTriangle className="size-4" />
                </div>
              )}
              {title}
            </DialogTitle>
            {description !== undefined && (
              <DialogDescription className="mt-2 text-sm text-muted-foreground">
                {description}
              </DialogDescription>
            )}
          </DialogHeader>

          {requireText !== undefined && (
            <div className="my-4 space-y-2 rounded-md border border-muted bg-muted/30 p-3">
              <Label htmlFor="confirm-dialog-input" className="text-xs font-medium text-foreground">
                {requireTextLabel ?? (
                  <>
                    Type <strong className="font-semibold text-foreground">{requireText}</strong> to confirm deletion
                  </>
                )}
              </Label>
              <Input
                id="confirm-dialog-input"
                value={typedText}
                onChange={(e: React.ChangeEvent<HTMLInputElement>): void => {
                  setTypedText(e.target.value);
                }}
                placeholder={requireText}
                className="h-9 font-mono text-sm"
                autoFocus
                autoComplete="off"
              />
            </div>
          )}

          <DialogFooter className="mt-6 flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
            <Button
              type="button"
              variant="outline"
              onClick={(): void => {
                onOpenChange(false);
              }}
              disabled={loading}
            >
              {cancelText}
            </Button>
            <Button
              type="submit"
              variant={confirmVariant}
              disabled={!isConfirmed || loading}
            >
              {loading && <Spinner data-icon="inline-start" className="mr-1.5" />}
              {loading ? "Processing..." : confirmText}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
