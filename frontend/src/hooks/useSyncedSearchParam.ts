import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useSearchParams } from "react-router-dom";

/**
 * URL-backed filter state (kanban 14.7).
 *
 * Binds a component filter value to a single URL query parameter so a filter
 * survives refresh, a share link, and browser back/forward. The URL is the
 * source of truth: the initial value is read from the query string, and every
 * change is written back (other query params are preserved).
 *
 * When `paramName` is undefined the hook behaves like a plain useState, so a
 * filter can opt out of URL persistence per view.
 */
export function useSyncedSearchParam(
  paramName: string | undefined,
  initialValue: string,
): [string, (next: string) => void] {
  const [searchParams, setSearchParams] = useSearchParams();

  // Read the initial value from the URL once, falling back to `initialValue`.
  const [value, setValue] = useState<string>((): string => {
    if (paramName === undefined) return initialValue;
    const fromUrl = searchParams.get(paramName);
    return fromUrl ?? initialValue;
  });

  const paramNameRef = useRef(paramName);
  paramNameRef.current = paramName;

  // Reconcile when the location changes (e.g. browser back/forward) so the
  // in-component state follows the URL. If the param disappeared (e.g. the
  // filter was cleared and the URL param removed), reset to the initial value
  // rather than leaving a stale in-component filter.
  useEffect((): void => {
    if (paramName === undefined) return;
    const fromUrl = searchParams.get(paramName);
    setValue(fromUrl ?? initialValue);
  }, [initialValue, searchParams, paramName]);

  const currentParam = useMemo((): string | undefined => paramName, [paramName]);

  const pendingRef = useRef<string | null>(null);
  const timeoutRef = useRef<number | null>(null);

  useEffect((): (() => void) => {
    return (): void => {
      if (timeoutRef.current !== null) window.clearTimeout(timeoutRef.current);
    };
  }, []);

  const setFilter = useCallback((next: string): void => {
    setValue(next);
    if (currentParam === undefined) return;
    pendingRef.current = next;
    if (timeoutRef.current !== null) window.clearTimeout(timeoutRef.current);
    timeoutRef.current = window.setTimeout((): void => {
      timeoutRef.current = null;
      const pending = pendingRef.current;
      pendingRef.current = null;
      if (pending === null) return;
      const params = new URLSearchParams(searchParams.toString());
      if (pending === "") params.delete(currentParam);
      else params.set(currentParam, pending);
      setSearchParams(params, { replace: true });
    }, 300);
  }, [currentParam, searchParams, setSearchParams]);

  return [value, setFilter];
}