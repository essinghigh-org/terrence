import { isIP } from "node:net";
import { isAbsolute, resolve, sep } from "node:path";
import { realpathSync } from "node:fs";

export type ListenerConfiguration = Readonly<
  Record<"SYSTEM_API_HOST" | "STORAGE_DIR", string>
  & Record<"SYSTEM_API_TLS_CERT" | "SYSTEM_API_TLS_KEY", string | null>
  & Record<"TERRENCE_SANDBOX_EXTRA_RW_PATHS", readonly string[]>
>;

function pathValue(raw: string | undefined, name: string): string | null {
  if (raw === undefined) return null;
  if (raw.trim() === "" || raw.includes("\u0000")) throw new Error(`${name} must be a non-empty filesystem path`);
  return resolve(raw);
}

function canonicalPath(path: string): string {
  try { return realpathSync(path); } catch { return resolve(path); }
}

function sandboxWritePaths(environment: Readonly<Record<string, string | undefined>>, storage: string): readonly string[] {
  const raw = environment["TERRENCE_SANDBOX_EXTRA_RW_PATHS"];
  if (raw === undefined) return Object.freeze([]);
  if (!["true", "1"].includes(environment["TERRENCE_SANDBOX_EXTRA_RW_ALLOWED"] ?? "")) {
    throw new Error("TERRENCE_SANDBOX_EXTRA_RW_PATHS requires TERRENCE_SANDBOX_EXTRA_RW_ALLOWED");
  }
  const paths = raw.split(":");
  if (paths.length > 32 || paths.some((path): boolean => !isAbsolute(path) || path.includes("\u0000"))) {
    throw new Error("Sandbox write paths must contain at most 32 non-empty absolute paths");
  }
  const canonical = paths.map(canonicalPath);
  const storagePath = canonicalPath(storage);
  const allowStorage = ["true", "1"].includes(environment["TERRENCE_SANDBOX_EXTRA_RW_ALLOW_STORAGE"] ?? "");
  if (!allowStorage && canonical.some((path): boolean => path === storagePath || path.startsWith(`${storagePath}${sep}`) || storagePath.startsWith(path.endsWith(sep) ? path : `${path}${sep}`))) {
    throw new Error("Sandbox storage access requires TERRENCE_SANDBOX_EXTRA_RW_ALLOW_STORAGE");
  }
  return Object.freeze(canonical);
}

export function parseListenerConfiguration(environment: Readonly<Record<string, string | undefined>>): ListenerConfiguration {
  const host = environment["SYSTEM_API_HOST"] ?? "127.0.0.1";
  if (isIP(host) === 0 && !/^(?=.{1,253}$)[a-zA-Z0-9](?:[a-zA-Z0-9.-]*[a-zA-Z0-9])?$/.test(host)) {
    throw new Error("SYSTEM_API_HOST must be an IP address or hostname");
  }
  const cert = pathValue(environment["SYSTEM_API_TLS_CERT"], "SYSTEM_API_TLS_CERT");
  const key = pathValue(environment["SYSTEM_API_TLS_KEY"], "SYSTEM_API_TLS_KEY");
  if ((cert === null) !== (key === null)) throw new Error("SYSTEM_API_TLS_CERT and SYSTEM_API_TLS_KEY must be configured together");
  // Preserve the container binding contract: wildcard interfaces may be
  // published through a loopback-only container port mapping.
  if (!["127.0.0.1", "::1", "localhost", "0.0.0.0", "::"].includes(host) && cert === null) {
    throw new Error("Remote SYSTEM_API_HOST requires SYSTEM_API_TLS_CERT and SYSTEM_API_TLS_KEY");
  }
  const storage = pathValue(environment["STORAGE_DIR"], "STORAGE_DIR") ?? resolve(import.meta.dir, "../../storage");
  return Object.freeze({
    SYSTEM_API_HOST: host,
    SYSTEM_API_TLS_CERT: cert,
    SYSTEM_API_TLS_KEY: key,
    STORAGE_DIR: storage,
    TERRENCE_SANDBOX_EXTRA_RW_PATHS: sandboxWritePaths(environment, storage),
  });
}
