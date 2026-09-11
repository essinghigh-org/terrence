import { useEffect, useRef, useState } from "react";
import type { RefObject } from "react";

export type FullscreenLogPhase = "plan" | "apply";

export type FullscreenLog = Readonly<{
  fullscreenLog: FullscreenLogPhase | null;
  setFullscreenLog: (phase: FullscreenLogPhase | null) => void;
  triggerRef: RefObject<HTMLElement | null>;
  closeRef: RefObject<HTMLButtonElement | null>;
  containerRef: RefObject<HTMLDivElement | null>;
}>;

/**
 * Fullscreen log overlay state with focus management: remembers whichever
 * control opened the dialog so focus can return there after close, moves
 * focus into the dialog on open, and traps Tab/Shift+Tab inside it.
 */
export function useFullscreenLog(): FullscreenLog {
  const [fullscreenLog, setFullscreenLog] = useState<FullscreenLogPhase | null>(null);
  // Focus management for the fullscreen log dialog: remember
  // whichever control opened it so focus can return there after close.
  const triggerRef = useRef<HTMLElement | null>(null);
  const closeRef = useRef<HTMLButtonElement | null>(null);
  const containerRef = useRef<HTMLDivElement | null>(null);

  useEffect((): (() => void) => {
    if (fullscreenLog === null) return (): void => undefined;
    // The overlay renders after this effect commits, so the close button ref
    // is already populated; move focus into the dialog. Remember the trigger
    // so cleanup can hand focus back when the dialog goes away.
// SAFETY: the value is an element in the test DOM; callers treat it as an HTMLElement.
    triggerRef.current = document.activeElement as HTMLElement | null;
    closeRef.current?.focus();
    const onKeyDown = (event: Readonly<{
      key: string;
      shiftKey: boolean;
      preventDefault: () => void;
    }>): void => {
      if (event.key === "Escape") {
        event.preventDefault();
        setFullscreenLog(null);
        return;
      }
      // Trap Tab/Shift+Tab inside the dialog so keyboard focus can never
      // escape into the page behind the overlay.
      if (event.key === "Tab") {
        const container = containerRef.current;
        if (container === null) return;
        const focusable = Array.from(
          container.querySelectorAll<HTMLElement>(
            'a[href], button:not([disabled]), textarea, input, select, [tabindex]:not([tabindex="-1"])',
          ),
        );
        if (focusable.length === 0) {
          event.preventDefault();
          return;
        }
        const first = focusable[0];
        const last = focusable[focusable.length - 1];
        if (first === undefined || last === undefined) return;
        const active = document.activeElement;
        if (event.shiftKey) {
          if (active === null || active === first || !container.contains(active)) {
            event.preventDefault();
            last.focus();
          }
        } else if (active === null || active === last || !container.contains(active)) {
          event.preventDefault();
          first.focus();
        }
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return (): void => {
      window.removeEventListener("keydown", onKeyDown);
      triggerRef.current?.focus();
      triggerRef.current = null;
    };
  }, [fullscreenLog]);

  return { fullscreenLog, setFullscreenLog, triggerRef, closeRef, containerRef };
}
