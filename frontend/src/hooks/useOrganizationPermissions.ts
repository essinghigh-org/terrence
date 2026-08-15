import { useEffect, useState } from "react";
import { fetchApi } from "../lib/api";

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
export type OrganizationPermissionName =
  | "can-manage-workspaces"
  | "can-manage-projects"
  | "can-manage-policies"
  | "can-read-policies"
  | "can-manage-agent-pools"
  | "can-manage-vcs-settings"
  | "can-manage-providers"
  | "can-manage-modules"
  | "can-manage-auditing"
  | "can-queue-plan"
  | "can-run"
  | "can-apply"
  | "can-lock"
  | "can-read-state-versions"
  | "can-read-variables"
  | "can-manage-organization"
  | string;

export type OrganizationPermissions = Readonly<{
  permissions: Readonly<Record<string, boolean>> | undefined;
  /** True when the org object has loaded; false while loading or on error. */
  loaded: boolean;
  error: string | null;
  /** Read one permission by snake_case key. */
  has: (name: OrganizationPermissionName) => boolean;
}>;

export function useOrganizationPermissions(orgName: string | undefined): OrganizationPermissions {
  const [permissions, setPermissions] = useState<Readonly<Record<string, boolean>> | undefined>(undefined);
  const [loaded, setLoaded] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect((): (() => void) => {
    if (orgName === undefined || orgName === "") {
      setPermissions(undefined);
      setLoaded(false);
      setError(null);
      return () => {};
    }
    const controller = new AbortController();
    setError(null);
    setLoaded(false);
    setPermissions(undefined);

    void fetchApi(
      `/organizations/${encodeURIComponent(orgName)}`,
      { signal: controller.signal },
    ).then((result) => {
      if (controller.signal.aborted) return;
// SAFETY: the endpoint contract returns the JSON:API envelope with this data shape.
      const attributes = (result as {
        data?: { attributes?: { permissions?: Record<string, boolean> } };
      }).data?.attributes;
      setPermissions(attributes?.permissions);
      setLoaded(true);
    }).catch((caught: unknown) => {
      if (controller.signal.aborted) return;
      setPermissions(undefined);
      setLoaded(true);
      setError(caught instanceof Error ? caught.message : "Failed to load organization permissions.");
    });

    return (): void => {
      controller.abort();
    };
  }, [orgName]);

  const has = (name: OrganizationPermissionName): boolean => permissions?.[name] === true;

  return { permissions, loaded, error, has };
}