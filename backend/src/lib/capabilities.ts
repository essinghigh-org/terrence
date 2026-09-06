/** Capability issuance and validation helpers. */
import type { RequestWithUrl } from "./types";
import type { AuthorizedRunCapability } from "./authorized-resources";
import { runLogURL, findLogCapability, signedApiURL, validSignedApiURL, apiURL } from "./utils";

export type RunLogPhase = "plan" | "apply";
export type RunLogCapability = "run-read" | "admin";

/** Issue a run-log capability only from an explicitly authorized run context. */
export function issueRunLogCapability(
  authorized: AuthorizedRunCapability<RunLogCapability>,
  phase: RunLogPhase,
  request: RequestWithUrl,
): string | null {
  // Keep this guard at the issuance boundary as well as in the type. A
  // capability context can cross an untyped request boundary, and a
  // state/plan-only decision must never be enough to mint a log URL.
  if (authorized.capability !== "run-read" && authorized.capability !== "admin") return null;
  return runLogURL(authorized.run, phase, request);
}

export { apiURL, findLogCapability, signedApiURL, validSignedApiURL };
export type { RequestWithUrl } from "./types";
