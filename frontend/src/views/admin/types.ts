// Shared types and helpers for the admin dashboard sections.
export type AdminSection =
  | "security"
  | "users"
  | "orgs"
  | "workspaces"
  | "runs"
  | "versions"
  | "audit"
  | "auth";

export const attrString = (attrs: Record<string, unknown>, key: string, fallback: string): string => {
  const value = attrs[key];
  return typeof value === "string" ? value : fallback;
};

export const attrBoolean = (attrs: Record<string, unknown>, key: string, fallback: boolean): boolean => {
  const value = attrs[key];
  return typeof value === "boolean" ? value : fallback;
};

export type ItemAttrs = {
  username?: string;
  email?: string | null;

  "is-site-admin"?: boolean;
  "is-suspended"?: boolean;
  name?: string;

  "iac-binary"?: string;

  "default-terraform-version"?: string;

  "auto-apply"?: boolean;
  locked?: boolean;
  status?: string;
  message?: string | null;

  "has-changes"?: boolean;

  actions?: {
    "is-cancelable"?: boolean;
    "is-force-cancelable"?: boolean;
  };
  version?: string;
  url?: string | null;
  sha?: string | null;

  "created-at"?: string;
  action?: string;

  "resource-type"?: string;

  "resource-id"?: string | null;
  "actor-username"?: string | null;
  "actor-email"?: string | null;
  [key: string]: unknown;
};

export type DataItem = { id: string; attributes: ItemAttrs };

export type SecuritySummary = Readonly<{
  signupEnabled: boolean;
  sandboxEnabled: boolean;
  sandboxAvailable: boolean;
  sandboxReason: string | null;
}>;
