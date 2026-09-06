import { createContext, useCallback, useContext, useEffect, useState, type ReactNode } from "react";
import { useBlocker } from "react-router-dom";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";

type RegisterGuard = (message: string) => () => void;
const guardContext = createContext<RegisterGuard | null>(null);
const defaultMessage = "You have unsaved changes. Discard them and leave this page?";

/** One router blocker coordinates every dirty section, including Back/Forward. */
export function UnsavedChangesProvider({ children }: Readonly<{ children: ReactNode }>): React.JSX.Element {
  const [guards, setGuards] = useState<ReadonlyMap<symbol, string>>(new Map());
  const register = useCallback<RegisterGuard>((message) => {
    const id = Symbol();
    setGuards((current): ReadonlyMap<symbol, string> => new Map(current).set(id, message));
    return (): void => {
      setGuards((current): ReadonlyMap<symbol, string> => {
        const next = new Map(current);
        next.delete(id);
        return next;
      });
    };
  }, []);
  const blocker = useBlocker(({ currentLocation, nextLocation }): boolean => guards.size > 0 && (
    currentLocation.pathname !== nextLocation.pathname
    || currentLocation.search !== nextLocation.search
    || currentLocation.hash !== nextLocation.hash
  ));

  useEffect((): void => {
    if (guards.size === 0 && blocker.state === "blocked") blocker.reset();
  }, [guards, blocker]);

  return (
    <guardContext.Provider value={register}>
      {children}
      <ConfirmDialog
        open={blocker.state === "blocked" && guards.size > 0}
        title="Unsaved changes"
        description={guards.size === 1 ? guards.values().next().value : defaultMessage}
        cancelText="Stay"
        confirmText="Discard and leave"
        confirmVariant="default"
        onOpenChange={(open): void => { if (!open && blocker.state === "blocked") blocker.reset(); }}
        onConfirm={(): void => { if (blocker.state === "blocked") blocker.proceed(); }}
      />
    </guardContext.Provider>
  );
}

/** The provider handles SPA transitions; standalone forms still protect document exits. */
export function useUnsavedChangesWarning(active: boolean, message = defaultMessage): void {
  const register = useContext(guardContext);
  useEffect((): (() => void) | undefined => {
    if (!active) return;
    const unregister = register?.(message);
    const beforeUnload = (event: BeforeUnloadEvent): void => { event.preventDefault(); };
    window.addEventListener("beforeunload", beforeUnload);
    return (): void => {
      unregister?.();
      window.removeEventListener("beforeunload", beforeUnload);
    };
  }, [active, message, register]);
}
