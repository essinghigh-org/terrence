// SAML 2.0 service provider endpoints: SP metadata, SP-initiated SSO redirect,
// the ACS assertion consumer, and SLO logout. The IdP configuration lives in
// the saml_settings table (admin API + dashboard).
import { Elysia } from "elysia";
import { eq } from "drizzle-orm";
import { createHash, randomBytes } from "node:crypto";
import { deflateRawSync, gunzipSync, inflateRawSync } from "node:zlib";
import { DOMParser } from "@xmldom/xmldom";
import { SignedXml } from "xml-crypto";
import { XMLParser } from "fast-xml-parser";
import { db } from "../db";
import { apiTokens, samlSettings, users } from "../db/schema";
import { apiURL, auditLog } from "../lib/utils";
import {
  applySamlGroupMapping,
  provisionSsoUser,
  pruneSamlGroupMappings,
  ssoHtmlPage,
  ssoHtmlResponse,
  SsoConflictError,
} from "../lib/sso";
import { issueLoginSession, revokeBrowserSession } from "./accounts";

type SetObj = Readonly<{ status?: number | string; headers: Readonly<Record<string, string | number>> }>;
type RequestInfo = Readonly<{ url: string; headers: Readonly<{ get: (name: string) => string | null }> }>;

const SAML_VERSION = "urn:oasis:names:tc:SAML:2.0:assertion";
const PROTOCOL = "urn:oasis:names:tc:SAML:2.0:protocol";
// SAML 2.0 core specifies the bearer confirmation method under the "cm"
// namespace, NOT under the assertion namespace.
const BEARER = "urn:oasis:names:tc:SAML:2.0:cm:bearer";
const TIME_SKEW_MS = 5 * 60 * 1000;
// Cap the decoded/decodescapped SAML message size so an attacker-supplied
// compressed payload cannot expand into excessive memory.
const MAX_SAML_MESSAGE_BYTES = 1024 * 1024;

// AuthnRequests we issued are recorded and matched against InResponseTo so
// captured assertions cannot be replayed against the ACS.
const PENDING_AUTHNREQUEST_TTL_MS = 10 * 60 * 1000;
const pendingAuthnRequests = new Map<string, number>(); // requestId -> expiresAt
const consumedAssertionIds = new Map<string, number>(); // assertion ID -> expiresAt

type SamlRow = Readonly<typeof samlSettings.$inferSelect>;

function samlIdentityProviderUrl(request: RequestInfo): string {
  return apiURL(request, "/users/saml/metadata");
}

function acsUrl(request: RequestInfo): string {
  return apiURL(request, "/users/saml/auth");
}

function sloUrl(request: RequestInfo): string {
  return apiURL(request, "/users/saml/slo");
}

function xmlEscape(value: string): string {
  return value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll("\"", "&quot;").replaceAll("'", "&apos;");
}

function encodeRedirect(value: string): string {
  return Buffer.from(deflateRawSync(Buffer.from(value, "utf8"))).toString("base64");
}

function decodeSamlMessage(value: string): string {
  const raw = Buffer.from(value.replaceAll(" ", "+"), "base64");
  if (raw.length > MAX_SAML_MESSAGE_BYTES) throw new Error("SAML message too large");
  // IdPs may compress the XML (DEFLATE, gzip, or raw).
  if (raw.length >= 2 && raw[0] === 0x1f && raw[1] === 0x8b) {
    return gunzipSync(raw, { maxOutputLength: MAX_SAML_MESSAGE_BYTES }).toString("utf8");
  }
  try {
    return inflateRawSync(raw, { maxOutputLength: MAX_SAML_MESSAGE_BYTES }).toString("utf8");
  } catch {
    return raw.toString("utf8");
  }
}

/** Build an SP-initiated LogoutRequest for the HTTP-Redirect binding. */
function logoutRequestXml(entityId: string, destination: string, requestId: string): string {
  const now = new Date().toISOString();
  return `<?xml version="1.0" encoding="UTF-8"?>
<samlp:LogoutRequest xmlns:samlp="${PROTOCOL}" xmlns:saml="${SAML_VERSION}" ID="${requestId}" Version="2.0" IssueInstant="${now}" Destination="${xmlEscape(destination)}">
  <saml:Issuer>${xmlEscape(entityId)}</saml:Issuer>
  <saml:NameID Format="urn:oasis:names:tc:SAML:1.1:nameid-format:unspecified">logout</saml:NameID>
</samlp:LogoutRequest>
`;
}

/** Build the LogoutResponse the SP returns for an IdP-initiated logout. */
function logoutResponseXml(entityId: string): string {
  const now = new Date().toISOString();
  return `<?xml version="1.0" encoding="UTF-8"?>
<samlp:LogoutResponse xmlns:samlp="${PROTOCOL}" xmlns:saml="${SAML_VERSION}" ID="_${randomBytes(16).toString("hex")}" Version="2.0" IssueInstant="${now}">
  <saml:Issuer>${xmlEscape(entityId)}</saml:Issuer>
  <samlp:Status>
    <samlp:StatusCode Value="urn:oasis:names:tc:SAML:2.0:protocol:status:Success"/>
  </samlp:Status>
</samlp:LogoutResponse>
`;
}

function decodeLogoutMessage(value: string): string {
  const raw = Buffer.from(value.replaceAll(" ", "+"), "base64");
  if (raw.length > MAX_SAML_MESSAGE_BYTES) throw new Error("SAML message too large");
  if (raw.length >= 2 && raw[0] === 0x1f && raw[1] === 0x8b) {
    return gunzipSync(raw, { maxOutputLength: MAX_SAML_MESSAGE_BYTES }).toString("utf8");
  }
  try {
    return inflateRawSync(raw, { maxOutputLength: MAX_SAML_MESSAGE_BYTES }).toString("utf8");
  } catch {
    return raw.toString("utf8");
  }
}

/** Verify the IdP's LogoutRequest signature against the configured certs. */
function verifyLogoutSignature(xml: string, certificates: readonly string[]): boolean {
  if (certificates.length === 0) return false;
  let doc: ReturnType<DOMParser["parseFromString"]>;
  try {
    doc = new DOMParser({ errorHandler: (): void => undefined }).parseFromString(xml, "text/xml");
  } catch {
    return false;
  }
  const signatureElement = doc.getElementsByTagNameNS("*", "Signature").item(0);
  if (signatureElement === null) return false;
  for (const certificate of certificates) {
    try {
      const signed = new SignedXml();
      signed.getCertFromKeyInfo = (): string => certificate;
      // eslint-disable-next-line @typescript-eslint/no-base-to-string
      signed.loadSignature(String(signatureElement));
      if (signed.checkSignature(xml)) return true;
    } catch {
      // Try the next certificate (e.g. the old cert during rotation).
    }
  }
  return false;
}

/** Local-name lookup against namespace-prefixed keys ("samlp:Response" -> "Response"). */
function local(record: Record<string, unknown> | undefined, name: string): unknown {
  if (record === undefined) return undefined;
  if (name in record) return record[name];
  const key = Object.keys(record).find((candidate): boolean => candidate.split(":")[1] === name);
  return key === undefined ? undefined : record[key];
}

function attr(record: Record<string, unknown> | undefined): Record<string, unknown> {
  if (record === undefined || typeof record !== "object") return {};
  return record;
}

function attributeValues(element: Record<string, unknown> | undefined): string[] {
  if (element === undefined) return [];
  const value = local(element, "AttributeValue");
  if (value === undefined) return [];
  const values = Array.isArray(value) ? value : [value];
  return values
    .map((item): string => {
      if (typeof item === "string") return item;
      if (item !== null && typeof item === "object") {
        const text = (item as Record<string, unknown>)["#text"];
        return typeof text === "string" ? text : "";
      }
      return "";
    })
    .filter((item): boolean => item !== "");
}

/** Find the Attribute element whose Name or FriendlyName matches. */
function namedAttribute(attributes: unknown, name: string): string[] {
  if (!Array.isArray(attributes)) return [];
  for (const attribute of attributes) {
    if (attribute === null || typeof attribute !== "object") continue;
    const record = attribute as Record<string, unknown>;
    const attributeName = record["@_Name"];
    const friendlyName = record["@_FriendlyName"];
    if ((typeof attributeName === "string" && attributeName === name)
      || (typeof friendlyName === "string" && friendlyName === name)) {
      return attributeValues(record);
    }
  }
  return [];
}

function spMetadataXml(entityId: string, acs: string, slo: string): string {
  return `<?xml version="1.0" encoding="UTF-8"?>
<md:EntityDescriptor xmlns:md="urn:oasis:names:tc:SAML:2.0:metadata" entityID="${xmlEscape(entityId)}">
  <md:SPSSODescriptor AuthnRequestsSigned="false" WantAssertionsSigned="true" protocolSupportEnumeration="urn:oasis:names:tc:SAML:2.0:protocol">
    <md:NameIDFormat>urn:oasis:names:tc:SAML:1.1:nameid-format:unspecified</md:NameIDFormat>
    <md:AssertionConsumerService Binding="urn:oasis:names:tc:SAML:2.0:bindings:HTTP-POST" Location="${xmlEscape(acs)}" index="0" isDefault="true"/>
    <md:SingleLogoutService Binding="urn:oasis:names:tc:SAML:2.0:bindings:HTTP-Redirect" Location="${xmlEscape(slo)}"/>
  </md:SPSSODescriptor>
</md:EntityDescriptor>
`;
}

function authnRequestXml(entityId: string, acs: string, ssoEndpointUrl: string, requestId: string): string {
  const now = new Date().toISOString();
  return `<?xml version="1.0" encoding="UTF-8"?>
<samlp:AuthnRequest xmlns:samlp="${PROTOCOL}" xmlns:saml="${SAML_VERSION}" ID="${requestId}" Version="2.0" IssueInstant="${now}" Destination="${xmlEscape(ssoEndpointUrl)}" ProtocolBinding="urn:oasis:names:tc:SAML:2.0:bindings:HTTP-POST" AssertionConsumerServiceURL="${xmlEscape(acs)}">
  <saml:Issuer>${xmlEscape(entityId)}</saml:Issuer>
  <samlp:NameIDPolicy AllowCreate="true" Format="urn:oasis:names:tc:SAML:1.1:nameid-format:unspecified"/>
</samlp:AuthnRequest>
`;
}

const xmlParser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: "@_",
  textNodeName: "#text",
  parseTagValue: false,
  parseAttributeValue: false,
});

/**
 * Verify a signed SAML response and return the exact (code-verified)
 * assertion payload XML. The returned assertion is the element that the
 * signature actually covers, which prevents signature-wrapping attacks: an
 * attacker inserting an extra unsigned assertion cannot smuggle it past the
 * single-Reference check into the consumed document.
 */
function signedAssertionResult(
  xml: string,
  certificates: readonly string[],
): Readonly<{ valid: boolean; error: string; assertionXml?: string }> {
  if (certificates.length === 0) {
    return { valid: false, error: "No IdP certificate configured" };
  }
  let doc: ReturnType<DOMParser["parseFromString"]>;
  try {
    doc = new DOMParser({ errorHandler: (): void => undefined })
      .parseFromString(xml, "text/xml");
  } catch {
    return { valid: false, error: "SAML response is not valid XML" };
  }

  // Exactly one SignedXml reference, and it must resolve to the assertion we
  // consume. Multiple references, no reference, or a reference to something
  // other than the assertion are all rejected — this is the core defense
  // against wrapping attacks.
  const assertions = doc.getElementsByTagNameNS("*", "Assertion");
  if (assertions.length !== 1) {
    return { valid: false, error: "SAML response must contain exactly one Assertion element" };
  }
  const assertionNode = assertions.item(0);
  if (assertionNode === null) {
    return { valid: false, error: "SAML response must contain exactly one Assertion element" };
  }

  const signatures = doc.getElementsByTagNameNS("*", "Signature");
  if (signatures.length === 0) return { valid: false, error: "SAML response is not signed" };
  const signatureElement = signatures[0];
  if (signatureElement === undefined) return { valid: false, error: "SAML response is not signed" };

  for (const certificate of certificates) {
    try {
      const signed = new SignedXml();
      signed.getCertFromKeyInfo = (): string => certificate;
      // eslint-disable-next-line @typescript-eslint/no-base-to-string
      signed.loadSignature(String(signatureElement));
      if (!signed.checkSignature(xml)) continue;
      const references = signed.getReferences();
      // The references type from xml-crypto exposes `uri`; tolerate shaped
      // variants without losing type-safety.
      const uris = references.map((ref): string => (ref as { uri?: string }).uri ?? "");
      if (uris.length !== 1) continue;
      const uri = uris[0]?.replace(/^#/, "") ?? "";
      if (uri === "") continue;
      const assertionId = assertionNode.getAttribute("ID");
      if (assertionId !== uri) continue;
      // The signature covers exactly the assertion we will consume.
      return {
        valid: true,
        error: "",
        // eslint-disable-next-line @typescript-eslint/no-base-to-string
        assertionXml: String(assertionNode),
      };
    } catch {
      // Try the next certificate (e.g. the old cert during rotation).
    }
  }
  return { valid: false, error: "SAML signature verification failed" };
}

async function currentSamlSettings(): Promise<SamlRow> {
  await db.insert(samlSettings).values({ id: "saml" }).onConflictDoNothing();
  const settings = await db.query.samlSettings.findFirst({ where: eq(samlSettings.id, "saml") });
  if (settings === undefined) throw new Error("SAML settings are unavailable");
  return settings;
}

type LoginContext = Readonly<{
  set: SetObj;
  request: RequestInfo | undefined;
  server?: unknown;
}>;

/** Browser session or SSO API token (RelayState "api"), shared by SAML + OIDC. */
export async function issueSsoLogin(
  user: Readonly<typeof users.$inferSelect>,
  context: LoginContext,
  options: Readonly<{ tokenTtlMs?: number; wantsToken?: boolean }> = {},
): Promise<unknown> {
  if (!options.wantsToken) {
    return issueLoginSession(user, true, context.set, context.request, context.server);
  }
  const tokenStr = `user-${randomBytes(32).toString("base64url")}`;
  const tokenId = crypto.randomUUID();
  const createdAt = Date.now();
  await db.insert(apiTokens).values({
    id: tokenId,
    token: createHash("sha256").update(tokenStr).digest("hex"),
    userId: user.id,
    description: "SSO login token",
    createdAt,
    expiresAt: options.tokenTtlMs !== undefined ? createdAt + options.tokenTtlMs : null,
  });
  return {
    data: {
      id: tokenId,
      type: "tokens",
      attributes: {
        token: tokenStr,
        "must-change-password": user.mustChangePassword,
        ...(options.tokenTtlMs === undefined ? {} : { "expired-at": new Date(createdAt + options.tokenTtlMs).toISOString() }),
      },
    },
  };
}

function wantsToken(request: RequestInfo | undefined, relayState: string | null): boolean {
  if (relayState === "api" || relayState === "api-token" || relayState === "terraform-cli") return true;
  const accept = request?.headers.get("accept") ?? "";
  return accept.includes("application/json") && relayState !== null && relayState.startsWith("cli");
}

export const samlRoutes = new Elysia({ name: "saml-sso" })
  .get("/users/saml/metadata", async ({ request }: {
    request: RequestInfo;
  }): Promise<Response> => {
    await currentSamlSettings();
    return new Response(spMetadataXml(samlIdentityProviderUrl(request), acsUrl(request), sloUrl(request)), {
      headers: {
        "Content-Type": "application/xml; charset=utf-8",
        "Cache-Control": "public, max-age=300",
      },
    });
  })
  .get("/users/saml/auth", async ({ query, request }: {
    query: Readonly<Record<string, unknown>>;
    request: RequestInfo;
  }): Promise<unknown> => {
    const settings = await currentSamlSettings();
    if (!settings.enabled || settings.ssoEndpointUrl === null) {
      return ssoHtmlResponse(ssoHtmlPage("SAML SSO", "SAML single sign-on is not enabled."), 404);
    }
    const requestId = `_${randomBytes(16).toString("hex")}`;
    // Record the issued AuthnRequest so the ACS can match InResponseTo and
    // reject replayed or unsolicited assertions.
    pendingAuthnRequests.set(requestId, Date.now() + PENDING_AUTHNREQUEST_TTL_MS);
    for (const [key, expiresAt] of pendingAuthnRequests) {
      if (expiresAt <= Date.now()) pendingAuthnRequests.delete(key);
    }
    const relayState = typeof query.RelayState === "string" ? query.RelayState : null;
    const authnRequest = encodeRedirect(authnRequestXml(samlIdentityProviderUrl(request), acsUrl(request), settings.ssoEndpointUrl, requestId));
    const target = new URL(settings.ssoEndpointUrl);
    target.searchParams.set("SAMLRequest", authnRequest);
    if (relayState !== null) target.searchParams.set("RelayState", relayState);
    return new Response(null, {
      status: 302,
      headers: {
        "Cache-Control": "no-store",
        Location: target.toString(),
      },
    });
  })
  .post("/users/saml/auth", async ({ body, query, request, set, server }: {
    body: unknown;
    query: Readonly<Record<string, unknown>>;
    request: RequestInfo;
    set: SetObj;
    server?: unknown;
  }): Promise<unknown> => {
    const settings = await currentSamlSettings();
    if (!settings.enabled || settings.ssoEndpointUrl === null) {
      (set as { status: number }).status = 404;
      return ssoHtmlResponse(ssoHtmlPage("SAML SSO", "SAML single sign-on is not enabled."), 404);
    }

    const form = (body !== null && typeof body === "object" ? body : {}) as Record<string, unknown>;
    const samlResponse = typeof form.SAMLResponse === "string"
      ? form.SAMLResponse
      : typeof query.SAMLResponse === "string"
        ? query.SAMLResponse
        : "";
    const relayState = typeof form.RelayState === "string" ? form.RelayState : null;
    if (samlResponse === "") {
      (set as { status: number }).status = 400;
      return ssoHtmlResponse(ssoHtmlPage("SAML SSO", "Missing SAMLResponse."), 400);
    }

    let xml: string;
    try {
      xml = decodeSamlMessage(samlResponse);
    } catch {
      (set as { status: number }).status = 400;
      return ssoHtmlResponse(ssoHtmlPage("SAML SSO", "The SAML response could not be decoded."), 400);
    }

    // Parse the top-level response for its attributes (Status, Destination).
    let parsed: Record<string, unknown>;
    try {
      parsed = xmlParser.parse(xml) as Record<string, unknown>;
    } catch {
      (set as { status: number }).status = 400;
      return ssoHtmlResponse(ssoHtmlPage("SAML SSO", "The SAML response could not be parsed."), 400);
    }
    const responseElement = attr(local(parsed, "Response") as Record<string, unknown> | undefined);

    // A Response carrying a non-Success status must be rejected outright —
    // a failed auth must not be accepted just because it also holds an
    // assertion.
    const statusCode = attr(local(local(responseElement, "Status") as Record<string, unknown> | undefined, "StatusCode") as Record<string, unknown> | undefined)["@_Value"];
    if (statusCode !== "urn:oasis:names:tc:SAML:2.0:protocol:status:Success") {
      await auditLog("sso-failure", "saml", null, null, null, { reason: "non-success status" });
      (set as { status: number }).status = 400;
      return ssoHtmlResponse(ssoHtmlPage("SAML SSO", "The SAML response reports a failed authentication."), 400);
    }

    // Replay / request-binding checks: the outgoing AuthnRequest is recorded in
    // pendingAuthnRequests; its response must reference it exactly once, and
    // each assertion can be consumed only once.
    const inResponseTo = responseElement["@_InResponseTo"];
    const now = Date.now();
    for (const [key, expiresAt] of pendingAuthnRequests) {
      if (expiresAt <= now) pendingAuthnRequests.delete(key);
    }
    if (typeof inResponseTo === "string" && inResponseTo !== "") {
      const expiresAt = pendingAuthnRequests.get(inResponseTo);
      if (expiresAt === undefined || expiresAt <= now) {
        (set as { status: number }).status = 400;
        return ssoHtmlResponse(ssoHtmlPage("SAML SSO", "SAML response does not match an issuance from this instance."), 400);
      }
      pendingAuthnRequests.delete(inResponseTo);
    }

    const certificates = [settings.idpCert, settings.oldIdpCert].filter((cert): cert is string => typeof cert === "string" && cert !== "");
    const signature = signedAssertionResult(xml, certificates);
    if (!signature.valid) {
      await auditLog("sso-failure", "saml", null, null, null, { reason: signature.error });
      (set as { status: number }).status = 400;
      return ssoHtmlResponse(ssoHtmlPage("SAML SSO", signature.error), 400);
    }

    // Parse only the assertion that was actually covered by the verified
    // signature — never the full untrusted document.
    let parsedAssertion: Record<string, unknown>;
    try {
      const verified = xmlParser.parse(signature.assertionXml ?? xml) as Record<string, unknown>;
      const assertion = local(verified, "Assertion");
      if (assertion === undefined || typeof assertion !== "object" || assertion === null) {
        throw new Error("no assertion");
      }
      parsedAssertion = assertion as Record<string, unknown>;
    } catch {
      (set as { status: number }).status = 400;
      return ssoHtmlResponse(ssoHtmlPage("SAML SSO", "The SAML response contains no assertion."), 400);
    }

    // Reject replays: an assertion whose ID we have already consumed within
    // its validity window is a re-submission of a live assertion.
    const assertionIdElement = parsedAssertion["@_ID"];
    if (typeof assertionIdElement === "string" && assertionIdElement !== "") {
      const seen = consumedAssertionIds.get(assertionIdElement);
      if (seen !== undefined && seen > Date.now()) {
        (set as { status: number }).status = 400;
        return ssoHtmlResponse(ssoHtmlPage("SAML SSO", "SAML assertion has already been used."), 400);
      }
      consumedAssertionIds.set(assertionIdElement, Date.now() + TIME_SKEW_MS + 10 * 60 * 1000);
    }

    const destination = responseElement["@_Destination"] ?? parsedAssertion["@_Destination"];
    if (typeof destination === "string" && destination !== "" && destination !== acsUrl(request)) {
      (set as { status: number }).status = 400;
      return ssoHtmlResponse(ssoHtmlPage("SAML SSO", "SAML assertion Destination does not match the ACS URL."), 400);
    }

    const conditions = attr(local(parsedAssertion, "Conditions") as Record<string, unknown> | undefined);
    const notBefore = conditions["@_NotBefore"];
    const notOnOrAfter = conditions["@_NotOnOrAfter"];
    const parseInstant = (value: unknown): number | undefined =>
      typeof value === "string" ? Date.parse(value) : undefined;
    const notBeforeMs = typeof notBefore === "string" ? parseInstant(notBefore) : undefined;
    if (notBeforeMs !== undefined && (Number.isNaN(notBeforeMs) || notBeforeMs - TIME_SKEW_MS > now)) {
      (set as { status: number }).status = 400;
      return ssoHtmlResponse(ssoHtmlPage("SAML SSO", "SAML assertion is not yet valid."), 400);
    }
    const notOnOrAfterMs = typeof notOnOrAfter === "string" ? parseInstant(notOnOrAfter) : undefined;
    if (notOnOrAfterMs !== undefined && (Number.isNaN(notOnOrAfterMs) || notOnOrAfterMs + TIME_SKEW_MS < now)) {
      (set as { status: number }).status = 400;
      return ssoHtmlResponse(ssoHtmlPage("SAML SSO", "SAML assertion has expired."), 400);
    }

    const audience = local(conditions, "AudienceRestriction");
    const audiences = Array.isArray(audience)
      ? audience.flatMap((entry): string[] => {
        const value = local(attr(entry as Record<string, unknown>), "Audience");
        return typeof value === "string" ? [value] : [];
      })
      : (() => {
        const value = local(attr(audience as Record<string, unknown> | undefined), "Audience");
        return typeof value === "string" ? [value] : [];
      })();
    const entityId = samlIdentityProviderUrl(request);
    if (audiences.length > 0 && !audiences.includes(entityId)) {
      (set as { status: number }).status = 400;
      return ssoHtmlResponse(ssoHtmlPage("SAML SSO", "SAML assertion audience does not match this instance."), 400);
    }

    const subject = attr(local(parsedAssertion, "Subject") as Record<string, unknown> | undefined);
    const subjectConfirmation = local(subject, "SubjectConfirmation");
    const confirmationMethod = attr(subjectConfirmation as Record<string, unknown> | undefined)["@_Method"];
    const subjectData = attr(local(subjectConfirmation as Record<string, unknown> | undefined, "SubjectConfirmationData") as Record<string, unknown> | undefined);
    const recipient = subjectData["@_Recipient"];
    const dataNotOnOrAfter = subjectData["@_NotOnOrAfter"];
    if (confirmationMethod !== BEARER) {
      (set as { status: number }).status = 400;
      return ssoHtmlResponse(ssoHtmlPage("SAML SSO", "Unsupported SAML subject confirmation method."), 400);
    }
    if (typeof recipient === "string" && recipient !== acsUrl(request)) {
      (set as { status: number }).status = 400;
      return ssoHtmlResponse(ssoHtmlPage("SAML SSO", "SAML subject confirmation recipient does not match."), 400);
    }
    if (typeof dataNotOnOrAfter === "string") {
      const dataNotOnOrAfterMs = Date.parse(dataNotOnOrAfter);
      if (Number.isNaN(dataNotOnOrAfterMs) || dataNotOnOrAfterMs + TIME_SKEW_MS < now) {
        (set as { status: number }).status = 400;
        return ssoHtmlResponse(ssoHtmlPage("SAML SSO", "SAML subject confirmation has expired."), 400);
      }
    }

    const nameId = local(subject, "NameID");
    const nameIdText = typeof nameId === "string" ? nameId : attr(nameId as Record<string, unknown> | undefined)["#text"];
    if (typeof nameIdText !== "string" || nameIdText === "") {
      (set as { status: number }).status = 400;
      return ssoHtmlResponse(ssoHtmlPage("SAML SSO", "The SAML assertion contains no NameID."), 400);
    }

    const asArray = (value: unknown): unknown[] => {
    if (value === undefined || value === null) return [];
    return Array.isArray(value) ? value : [value];
  };

  // fast-xml-parser collapses repeated elements: a single Attribute becomes
  // a plain object and several AttributeStatement elements become an array.
  // Normalize both levels so single-attribute assertions are not silently
  // dropped (which would wipe groups, site-admin, and email mapping).
  const attributesList = asArray(local(parsedAssertion, "AttributeStatement"))
    .flatMap((statement): unknown[] =>
      asArray(local(attr(statement as Record<string, unknown>), "Attribute"))
    );
  const usernameValues = namedAttribute(attributesList, settings.attrUsername);
  const username = usernameValues[0] ?? nameIdText;
  const emailValues = ["email", "mail", "Email", "EmailAddress"].flatMap((name): string[] => namedAttribute(attributesList, name));
  const email = emailValues[0] ?? (nameIdText.includes("@") ? nameIdText : undefined);
  const groups = namedAttribute(attributesList, settings.attrGroups).flatMap((value): string[] =>
    value.split(/[,\s]+/).filter((part): boolean => part !== "")
  );
  const siteAdminMatches = settings.attrSiteAdmin !== null && settings.attrSiteAdmin !== ""
    && namedAttribute(attributesList, settings.attrSiteAdmin).includes(settings.siteAdminRole);

    let result: Awaited<ReturnType<typeof provisionSsoUser>>;
    try {
      result = await provisionSsoUser({
        provider: "saml",
        subject: nameIdText,
        username,
        email: email ?? null,
        // SAML attribute statements are signed with the IdP assertion, so
        // the operator-controlled directory is the verification authority.
        emailVerified: true,
      });
    } catch (error: unknown) {
      if (error instanceof SsoConflictError) {
        await auditLog("sso-conflict", "saml", null, null, null, { username: error.username });
        (set as { status: number }).status = 409;
        return ssoHtmlResponse(ssoHtmlPage("SAML SSO", error.message), 409);
      }
      throw error;
    }
    const user = result.user;

    await applySamlGroupMapping(user.id, groups);
    await pruneSamlGroupMappings(user.id, groups);
// The site-admin attribute is authoritative in both directions: matching
    // promotes, and once an account's admin status is SAML-sourced, losing the
    // role demotes it so the IdP can revoke elevated access. If the attribute
    // is misconfigured (empty `attrSiteAdmin`), we never touch the flag.
    if (settings.attrSiteAdmin !== null && settings.attrSiteAdmin !== "" && settings.siteAdminRole !== "") {
      const noLongerSiteAdmin = user.isSiteAdmin && !siteAdminMatches;
      if (siteAdminMatches && !user.isSiteAdmin) {
        await db.update(users).set({ isSiteAdmin: true, ssoSiteAdmin: true }).where(eq(users.id, user.id));
        await auditLog("sso-site-admin", "saml", user.id, user.id, null, { username: user.username, role: settings.siteAdminRole });
      } else if (noLongerSiteAdmin && user.ssoSiteAdmin) {
        await db.update(users).set({ isSiteAdmin: false, ssoSiteAdmin: false }).where(eq(users.id, user.id));
        await auditLog("sso-site-admin-revoked", "saml", user.id, user.id, null, { username: user.username, role: settings.siteAdminRole });
      }
    }

    const tokenTtlMs = settings.ssoApiTokenSessionTimeout * 1000;
    const session = await issueSsoLogin(user, { set, request, server }, {
      tokenTtlMs,
      wantsToken: wantsToken(request, relayState),
    });
    await auditLog("sso-login", "saml", user.id, user.id, null, { username: user.username });

    // The browser-session refresh cookie is written into set.headers by
    // issueLoginSession; attach it to the HTML response we return.
    const cookie = (set.headers as Record<string, string | number>)["Set-Cookie"];
    const respond = (body: string): Response => {
      const response = ssoHtmlResponse(body);
      if (cookie !== undefined) response.headers.set("Set-Cookie", String(cookie));
      return response;
    };

    const wantsJson = request?.headers.get("accept")?.includes("application/json") === true;
    if (wantsJson && wantsToken(request, relayState)) return session;
    if (wantsToken(request, relayState)) {
      const token = (session as { data: { attributes: { token: string } } }).data.attributes.token;
      return respond(ssoHtmlPage("SAML SSO", "You are signed in.", { token }));
    }
    return respond(ssoHtmlPage("SAML SSO", "You are signed in.", { redirectUrl: "/app" }));
  })
  .get("/users/saml/slo", async ({ set, request }: {
    set: SetObj;
    request: RequestInfo;
  }): Promise<unknown> => {
    const settings = await currentSamlSettings();
    // Terminate the local session regardless of the IdP's availability.
    await revokeBrowserSession(set, request);
    if (settings.enabled && settings.sloEndpointUrl !== null) {
      // Send SP-initiated logout to the IdP so the session is ended on both
      // sides. The IdP acknowledges via its own LogoutResponse; we do not
      // block the local redirect on it.
      const requestId = `_${randomBytes(16).toString("hex")}`;
      const logoutRequest = logoutRequestXml(samlIdentityProviderUrl(request), sloUrl(request), requestId);
      const target = new URL(settings.sloEndpointUrl);
      target.searchParams.set("SAMLRequest", encodeRedirect(logoutRequest));
      return new Response(null, {
        status: 302,
        headers: { "Cache-Control": "no-store", Location: target.toString() },
      });
    }
    return new Response(null, {
      status: 302,
      headers: { "Cache-Control": "no-store", Location: "/app" },
    });
  })
  // IdP-initiated logout: the IdP POSTs a LogoutRequest; after validating it
  // we revoke the local session and answer with a LogoutResponse.
  .post("/users/saml/logout", async ({ body, query, request, set }: {
    body: unknown;
    query: Readonly<Record<string, unknown>>;
    request: RequestInfo;
    set: SetObj;
  }): Promise<unknown> => {
    const settings = await currentSamlSettings();
    const form = (body !== null && typeof body === "object" ? body : {}) as Record<string, unknown>;
    const logoutRequestRaw = typeof form.SAMLRequest === "string"
      ? form.SAMLRequest
      : typeof query.SAMLRequest === "string"
        ? query.SAMLRequest
        : "";
    if (logoutRequestRaw !== "") {
      const certificates = [settings.idpCert, settings.oldIdpCert].filter((cert): cert is string => typeof cert === "string" && cert !== "");
      let xml: string;
      try {
        xml = decodeLogoutMessage(logoutRequestRaw);
      } catch {
        (set as { status: number }).status = 400;
        return new Response("Invalid SAML logout request", { status: 400 });
      }
      if (!verifyLogoutSignature(xml, certificates)) {
        await auditLog("sso-failure", "saml", null, null, null, { reason: "invalid logout signature" });
        (set as { status: number }).status = 400;
        return new Response("Invalid SAML logout request signature", { status: 400 });
      }
    }
    await revokeBrowserSession(set, request);
    await auditLog("sso-logout", "saml", null, null, null, { reason: "IdP-initiated" });
    return new Response(logoutResponseXml(samlIdentityProviderUrl(request)), {
      status: 200,
      headers: {
        "Cache-Control": "no-store",
        "Content-Type": "text/xml; charset=utf-8",
      },
    });
  });
