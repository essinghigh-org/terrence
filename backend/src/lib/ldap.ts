// LDAP directory authentication. Binds a service account (when configured),
// locates the user with the configured filter, then validates the presented
// password by binding as that user. Returns null for any failure so the login
// route can fall back to local authentication.
import { Client, type Entry } from "ldapts";
import type { LdapSettings } from "./sso";

export type LdapUser = Readonly<{
  dn: string;
  username: string;
  email: string | null;
  displayName: string | null;
}>;

/** RFC 4515 filter-value escaping. */
function escapeFilterValue(value: string): string {
  return value
    .replaceAll("\\", "\\5c")
    .replaceAll("*", "\\2a")
    .replaceAll("(", "\\28")
    .replaceAll(")", "\\29")
    .replaceAll("\0", "\\00");
}

/** Shallow-readonly view of an ldapts search entry (attribute name -> values). */
type LdapEntry = Readonly<{
  dn: string;
  [attribute: string]: string | readonly string[] | Buffer | readonly Buffer[] | undefined;
}>;

  // eslint-disable-next-line @typescript-eslint/prefer-readonly-parameter-types -- ldapts Entry buffers are mutable by contract
  function attributeValue(entry: LdapEntry, name: string): string | null {
  const raw: unknown = entry[name];
  if (typeof raw === "string") return raw;
  if (Array.isArray(raw)) {
    const first: unknown = raw[0];
    if (typeof first === "string") return first;
    if (first instanceof Buffer) return first.toString("utf8");
    return null;
  }
  if (raw instanceof Buffer) return raw.toString("utf8");
  return null;
}

/**
 * Verify credentials against the configured LDAP directory.
 * Returns the directory entry for the authenticated user, or null when the
 * credentials are rejected or the directory is unreachable/misconfigured.
 */
export async function authenticateLdap(
  settings: LdapSettings,
  username: string,
  password: string,
): Promise<LdapUser | null> {
  if (!settings.enabled || settings.host === null || settings.baseDn === null) return null;
  if (username === "" || password === "") return null;

  const scheme = settings.encryption === "ldaps" ? "ldaps" : "ldap";
  const client = new Client({
    url: `${scheme}://${settings.host}:${settings.port}`,
    timeout: 10_000,
    connectTimeout: 10_000,
  });

  try {
    if (settings.encryption === "starttls") {
      await client.startTLS();
    }
    if (settings.bindDn !== null) {
      // A zero-length password performs an *unauthenticated bind* per
      // RFC 4511 §4.2 — on permissive servers this silently succeeds with
      // anonymous permissions. Fail closed instead of downgrading.
      if (settings.bindPassword === null || settings.bindPassword === "") {
        return null;
      }
      await client.bind(settings.bindDn, settings.bindPassword);
    }

    const filter = settings.userFilter.replaceAll("{{username}}", escapeFilterValue(username));
    const result = await client.search(settings.baseDn, {
      scope: "sub",
      filter,
      attributes: [settings.attrUsername, settings.attrEmail, settings.attrDisplayName],
      sizeLimit: 10,
    });

    let entry: Entry | undefined;
    for (const candidate of result.searchEntries) {
      if (attributeValue(candidate, settings.attrUsername) === username) {
        entry = candidate;
        break;
      }
    }
    entry ??= result.searchEntries[0];
    if (entry === undefined) return null;

    // Validate the presented password by binding as the found user.
    await client.bind(entry.dn, password);

    return {
      dn: entry.dn,
      username: attributeValue(entry, settings.attrUsername) ?? username,
      email: attributeValue(entry, settings.attrEmail),
      displayName: attributeValue(entry, settings.attrDisplayName),
    };
  } catch {
    return null;
  } finally {
    await client.unbind().catch((): void => undefined);
  }
}
