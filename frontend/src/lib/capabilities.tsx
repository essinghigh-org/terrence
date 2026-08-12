import { createContext, useContext, type ReactNode } from "react";

/**
 * Site-level feature capabilities driven by backend settings.
 *
 * The backend surfaces these through the organization resource
 * (`attributes.capabilities`, see getSiteCapabilities() in
 * backend/src/lib/settings.ts). Layout fetches the current org on every
 * org-scoped page and provides them here. Any component can gate UI on a
 * capability with useCapability("...").
 *
 * Add a new capability in three places:
 *   1. backend/src/lib/settings.ts -> getSiteCapabilities()
 *   2. this file -> exported CAPABILITY_* constant
 *   3. the view -> gate the button/section on useCapability(...)
 *
 * Keys are stable kebab-case strings and match the backend keys exactly.
 */
export type Capabilities = Readonly<Record<string, boolean>>;

/** Capability values are unknown until the org fetch resolves; fail closed. */
export const DEFAULT_CAPABILITIES: Capabilities = {};

/** AI plan explainer for runs (plan-explainer admin setting). */
export const CAPABILITY_PLAN_EXPLAINER = "plan-explainer";

const capabilitiesContext = createContext<Capabilities>(DEFAULT_CAPABILITIES);

/**
 * Provides the capabilities map to the routed view tree.
 * Wired up in Layout around the <Outlet />.
 */
export function CapabilitiesProvider({
  capabilities,
  children,
}: Readonly<{ capabilities: Capabilities; children: ReactNode }>): ReactNode {
  return (
    <capabilitiesContext.Provider value={capabilities}>
      {children}
    </capabilitiesContext.Provider>
  );
}

/**
 * True when the named capability is enabled. Unknown or not-yet-loaded
 * capabilities resolve to false, so gated UI stays hidden until proven.
 */
export function useCapability(name: string): boolean {
  return useContext(capabilitiesContext)[name] === true;
}