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
  requireCheckbox?: string | undefined;
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
  requireCheckbox,
  onConfirm,
  loading = false,
}: ConfirmDialogProps): React.JSX.Element {
  const [typedText, setTypedText] = useState("");
  const [checked, setChecked] = useState(false);

  useEffect((): void => {
    if (open) {
      setTypedText("");
      setChecked(false);
    }
  }, [open]);

  const textConfirmed = requireText === undefined || typedText.trim() === requireText.trim();
  const checkboxConfirmed = requireCheckbox === undefined || checked;
  const isConfirmed = textConfirmed && checkboxConfirmed;

  const handleFormSubmit = (e: React.FormEvent): void => {
    e.preventDefault();
    if (!isConfirmed || loading) return;
    void onConfirm();
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-[460px]">
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
                name="confirmation"
                value={typedText}
                onChange={(e: React.ChangeEvent<HTMLInputElement>): void => {
                  setTypedText(e.target.value);
                }}
                onInput={(e: React.SyntheticEvent<HTMLInputElement>): void => {
                  setTypedText(e.currentTarget.value);
                }}
                placeholder={requireText}
                className="h-9 font-mono text-sm"
                autoFocus
                autoComplete="off"
              />
            </div>
          )}

          {requireCheckbox !== undefined && (
            <div className="my-4 flex items-start gap-2 rounded-md border border-destructive/30 bg-destructive/5 p-3">
              <input
                id="confirm-dialog-checkbox"
                type="checkbox"
                checked={checked}
                onChange={(e: React.ChangeEvent<HTMLInputElement>): void => {
                  setChecked(e.target.checked);
                }}
                className="mt-0.5 size-4 shrink-0 accent-destructive"
              />
              <Label htmlFor="confirm-dialog-checkbox" className="text-xs font-medium leading-relaxed text-foreground">
                {requireCheckbox}
              </Label>
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
              {loading ? "Processing…" : confirmText}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}