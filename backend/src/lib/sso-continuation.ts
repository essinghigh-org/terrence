import { peekOAuthHandshakeState, TERRAFORM_PENDING_AUTH_PREFIX } from "./oauth-handshake";

const TERRAFORM_OAUTH_STATE_COOKIE = "terraform_oauth_state";

type RequestInfo = Readonly<{ headers: Readonly<{ get: (name: string) => string | null }> }>;

export type SsoContinuation =
  | Readonly<{ kind: "oauth"; oauthState: string }>
  | Readonly<{ kind: "return"; target: string }>;

function cookieValue(request: RequestInfo, name: string): string | undefined {
  const raw = request.headers.get("cookie") ?? "";
  for (const part of raw.split(";")) {
    const separator = part.indexOf("=");
    if (separator !== -1 && part.slice(0, separator).trim() === name) {
      return part.slice(separator + 1).trim();
    }
  }
  return undefined;
}

function safeReturnTarget(value: unknown): string | undefined {
  if (typeof value !== "string" || (value !== "/app" && !value.startsWith("/app/"))) return undefined;
  if (value.startsWith("//") || /[\r\n]/.test(value) || value.includes("/../")) return undefined;
  return value;
}

export async function resolveSsoContinuation(
  query: Readonly<Record<string, unknown>>,
  request: RequestInfo,
): Promise<{ value: SsoContinuation | null } | { error: string }> {
  if (query["oauth_state"] !== undefined) {
    const oauthState = query["oauth_state"];
    if (typeof oauthState !== "string" || oauthState === "") return { error: "The sign-in continuation is invalid." };
    if (cookieValue(request, TERRAFORM_OAUTH_STATE_COOKIE) !== oauthState) {
      return { error: "The sign-in continuation does not match this browser." };
    }
    if ((await peekOAuthHandshakeState(TERRAFORM_PENDING_AUTH_PREFIX + oauthState)) === undefined) {
      return { error: "The sign-in continuation has expired. Please run 'terraform login' again." };
    }
    return { value: { kind: "oauth", oauthState } };
  }

  if (query["returnTo"] === undefined) return { value: null };
  const target = safeReturnTarget(query["returnTo"]);
  return target === undefined
    ? { error: "The sign-in destination is invalid." }
    : { value: { kind: "return", target } };
}

export function parseSsoContinuation(value: unknown): SsoContinuation | null {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  if (record["kind"] === "oauth" && typeof record["oauthState"] === "string" && record["oauthState"] !== "") {
    return { kind: "oauth", oauthState: record["oauthState"] };
  }
  const target = record["kind"] === "return" ? safeReturnTarget(record["target"]) : undefined;
  return target === undefined ? null : { kind: "return", target };
}

export function ssoContinuationTarget(continuation: SsoContinuation | null): string {
  if (continuation?.kind === "oauth") {
    return `/oauth/authorization/complete?oauth_state=${encodeURIComponent(continuation.oauthState)}`;
  }
  return continuation?.kind === "return" ? continuation.target : "/app";
}
