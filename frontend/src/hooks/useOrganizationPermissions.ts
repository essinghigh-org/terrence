import { useCallback, useEffect, useMemo, useState } from "react";
import { fetchApi } from "../lib/api";

export const orgPermissionsCache = new Map<string, { permissions: Readonly<Record<string, boolean>> | undefined; expires: number }>();
export const ORG_CACHE_TTL_MS = 30_000;

/**
 * Centralized organization-permission lookup (kanban 14.6).
 *
 * Every screen used to re-fetch the organization and interpret its
 * `attributes.permissions.*` flags inline. This hook centralizes that so a
 * screen asks "can this user manage agent pools here?" instead of reading
 * raw attribute keys.
 *
 * The hook fetches once per (orgName) mount and exposes a boolean accessor
 * `has(...)`. Permission names are the snake_case keys returned by the API,
 * e.g. "can-manage-workspaces".
 */
export type OrganizationPermissionName = string;

export type OrganizationPermissions = Readonly<{
  permissions: Readonly<Record<string, boolean>> | undefined;
  /** True when the org object has loaded; false while loading or on error. */
  loaded: boolean;
  error: string | null;
  /** Read one permission by snake_case key. */
  has: (name: OrganizationPermissionName) => boolean;
}>;

export function useOrganizationPermissions(orgName: string | undefined): OrganizationPermissions {
  const [permissions, setPermissions] = useState<Readonly<Record<string, boolean>> | undefined>(() => {
    if (orgName !== undefined && orgName !== "") {
      const cached = orgPermissionsCache.get(orgName);
      if (cached !== undefined && cached.expires > Date.now()) return cached.permissions;
    }
    return undefined;
  });
  const [loaded, setLoaded] = useState(() => {
    if (orgName !== undefined && orgName !== "") {
      const cached = orgPermissionsCache.get(orgName);
      if (cached !== undefined && cached.expires > Date.now()) return true;
    }
    return false;
  });
  const [error, setError] = useState<string | null>(null);

  useEffect((): (() => void) | undefined => {
    if (orgName === undefined || orgName === "") {
      setPermissions(undefined);
      setLoaded(false);
      setError(null);
      return undefined;
    }
    const cached = orgName !== undefined && orgName !== "" ? orgPermissionsCache.get(orgName) : undefined;
    if (cached !== undefined && cached.expires > Date.now()) {
      setPermissions(cached.permissions);
      setLoaded(true);
      setError(null);
      return undefined;
    }

    const controller = new AbortController();
    setError(null);
    setLoaded(false);
    setPermissions(undefined);

    void fetchApi(
      `/organizations/${encodeURIComponent(orgName)}`,
      { signal: controller.signal },
    ).then((result): void => {
      if (controller.signal.aborted) return;
// SAFETY: the endpoint contract returns the JSON:API envelope with this data shape.
      const attributes = (result as {
        data?: { attributes?: { permissions?: Record<string, boolean> } };
      }).data?.attributes;
      const perms = attributes?.permissions;
      orgPermissionsCache.set(orgName ?? "", { permissions: perms, expires: Date.now() + ORG_CACHE_TTL_MS });
      setPermissions(perms);
      setLoaded(true);
    }).catch((caught: unknown): void => {
      if (controller.signal.aborted) return;
      setPermissions(undefined);
      setLoaded(false);
      setError(caught instanceof Error ? caught.message : "Failed to load organization permissions.");
    });

    return (): void => {
      controller.abort();
    };
  }, [orgName]);

  const has = useCallback((name: OrganizationPermissionName): boolean => permissions?.[name] === true, [permissions]);

  return useMemo(() => ({ permissions, loaded, error, has }), [permissions, loaded, error, has]);
}