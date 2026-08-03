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

/**
 * Shallow-readonly view of an ldapts search entry (attribute name -> values).
 * ldapts's Entry is mutable by contract, so a simple intersection turns the
 * row read-only for the duration of attribute access.
 */
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
 *
 * The result distinguishes an *unavailable* directory (connect/TLS/startTLS
 * failure — worth circuit-breaking so login latency stays bounded) from a
 * *rejected login* (wrong credentials, missing user, misconfigured filter —
 * a normal authz outcome). Both return null for the user to let the login
 * route fall back to local authentication; only `unavailable` should poison
 * a failure cache.
 */
export async function authenticateLdap(
  settings: LdapSettings,
  username: string,
  password: string,
): Promise<{ user: LdapUser | null; unavailable: boolean }> {
  if (!settings.enabled || settings.host === null || settings.baseDn === null) {
    return { user: null, unavailable: false };
  }
  if (username === "" || password === "") return { user: null, unavailable: false };
  if (settings.bindDn !== null && (settings.bindPassword === null || settings.bindPassword === "")) {
    // A zero-length password performs an *unauthenticated bind* per
    // RFC 4511 §4.2 — fail closed, and flag it as a config problem that
    // should degrade to local auth immediately rather than retry the wire.
    return { user: null, unavailable: false };
  }

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
      await client.bind(settings.bindDn, settings.bindPassword ?? "");
    }

    const filter = settings.userFilter.replaceAll("{{username}}", escapeFilterValue(username));
    const result = await client.search(settings.baseDn, {
      scope: "sub",
      filter,
      attributes: [settings.attrUsername, settings.attrEmail, settings.attrDisplayName],
      sizeLimit: 10,
    });

    const byAttr = result.searchEntries.filter(
      // eslint-disable-next-line @typescript-eslint/prefer-readonly-parameter-types -- ldapts rows are mutable
      (candidate: Entry): boolean => attributeValue(candidate as LdapEntry, settings.attrUsername) === username,
    );
    // Require a unique match: binding an arbitrary entry would authenticate a
    // different identity than the one presented. Extra entries mean the filter
    // was ambiguous; refuse rather than guess.
    const entry: Entry | undefined = byAttr.length === 1 ? byAttr[0] : undefined;
    if (entry === undefined) return { user: null, unavailable: false };

    // Validate the presented password by binding as the found user.
    await client.bind(entry.dn, password);

    return {
      user: {
        dn: entry.dn,
        username: attributeValue(entry, settings.attrUsername) ?? username,
        email: attributeValue(entry, settings.attrEmail),
        displayName: attributeValue(entry, settings.attrDisplayName),
      },
      unavailable: false,
    };
  } catch (error: unknown) {
    // A rejected bind (result code 49 / InvalidCredentialsError) is a normal
    // auth outcome — the directory is fine, the credentials are not. Anything
    // else (connect, TLS, startTLS, timeout) means the directory is
    // unavailable. Never log the password or bind password.
    const name = error instanceof Error ? error.constructor.name : "";
    const message = error instanceof Error ? error.message : String(error);
    const credentialRejection = name === "InvalidCredentialsError" || message.includes("InvalidCredentials");
    if (!credentialRejection) {
      console.error(`[ldap] directory ${scheme}://${settings.host}:${settings.port} unavailable: ${message}`);
    }
    return { user: null, unavailable: !credentialRejection };
  } finally {
    await client.unbind().catch((): void => undefined);
  }
}
