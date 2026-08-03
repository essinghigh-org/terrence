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
import { auditLog } from "../lib/utils";
import {
  appendSetCookies,
  applySamlGroupMapping,
  provisionSsoUser,
  pruneSamlGroupMappings,
  ssoHtmlPage,
  ssoHtmlResponse,
  ssoBaseUrl,
  SsoConflictError,
} from "../lib/sso";
import { claimSsoChallenge, consumeSsoChallenge, storeSsoChallenge } from "../lib/sso-challenges";
import { browserSessionUser, issueLoginSession, revokeBrowserSession } from "./accounts";

type HeaderValue = string | number | readonly string[];
type SetObj = Readonly<{ status?: number | string; headers: Readonly<Record<string, HeaderValue>> }>;
type RequestInfo = Readonly<{ url: string; headers: Readonly<{ get: (name: string) => string | null }> }>;

const SAML_VERSION = "urn:oasis:names:tc:SAML:2.0:assertion";
const PROTOCOL = "urn:oasis:names:tc:SAML:2.0:protocol";
// SAML 2.0 core specifies the bearer confirmation method under the "cm"
// namespace, NOT under the assertion namespace.
const BEARER = "urn:oasis:names:tc:SAML:2.0:cm:bearer";
const SAML_SUCCESS_STATUS = "urn:oasis:names:tc:SAML:2.0:status:Success";
const TIME_SKEW_MS = 5 * 60 * 1000;
// Cap the decoded/decodescapped SAML message size so an attacker-supplied
// compressed payload cannot expand into excessive memory.
const MAX_SAML_MESSAGE_BYTES = 1024 * 1024;

// AuthnRequests we issued are recorded and matched against InResponseTo so
// captured assertions cannot be replayed against the ACS.
const PENDING_AUTHNREQUEST_TTL_MS = 10 * 60 * 1000;
const SAML_AUTHN_CHALLENGE_KIND = "saml-authn";
const SAML_ASSERTION_CHALLENGE_KIND = "saml-assertion";

type SamlRow = Readonly<typeof samlSettings.$inferSelect>;

function samlSpEntityId(request: RequestInfo): string {
  return new URL("/users/saml/metadata", ssoBaseUrl(request)).toString();
}

function acsUrl(request: RequestInfo): string {
  return new URL("/users/saml/auth", ssoBaseUrl(request)).toString();
}

function sloUrl(request: RequestInfo): string {
  return new URL("/users/saml/slo", ssoBaseUrl(request)).toString();
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
function logoutResponseXml(entityId: string, inResponseTo: string): string {
  const now = new Date().toISOString();
  return `<?xml version="1.0" encoding="UTF-8"?>
<samlp:LogoutResponse xmlns:samlp="${PROTOCOL}" xmlns:saml="${SAML_VERSION}" ID="_${randomBytes(16).toString("hex")}" Version="2.0" IssueInstant="${now}" InResponseTo="${xmlEscape(inResponseTo)}">
  <saml:Issuer>${xmlEscape(entityId)}</saml:Issuer>
  <samlp:Status>
    <samlp:StatusCode Value="${SAML_SUCCESS_STATUS}"/>
  </samlp:Status>
</samlp:LogoutResponse>
`;
}

/** Verify the IdP's LogoutRequest signature against the configured certs. */
function verifyLogoutSignature(xml: string, certificates: readonly string[]): Readonly<{ valid: boolean; error: string; nameId?: string; requestId?: string }> {
  if (certificates.length === 0) return { valid: false, error: "No IdP certificate configured" };
  let doc: ReturnType<DOMParser["parseFromString"]>;
  try {
    doc = new DOMParser({ errorHandler: (): void => undefined }).parseFromString(xml, "text/xml");
  } catch {
    return { valid: false, error: "SAML logout request is not valid XML" };
  }
  const requests = doc.getElementsByTagNameNS("*", "LogoutRequest");
  if (requests.length !== 1 || requests.item(0) === null) return { valid: false, error: "SAML logout request is invalid" };
  const request = requests.item(0);
  const requestId = request?.getAttribute("ID") ?? "";
  if (requestId === "") return { valid: false, error: "SAML logout request has no request ID" };
  const signatureElement = doc.getElementsByTagNameNS("*", "Signature").item(0);
  if (signatureElement === null) return { valid: false, error: "SAML logout request is not signed" };
  for (const certificate of certificates) {
    try {
      const signed = new SignedXml();
      signed.getCertFromKeyInfo = (): string => certificate;
      // eslint-disable-next-line @typescript-eslint/no-base-to-string
      signed.loadSignature(String(signatureElement));
      if (!signed.checkSignature(xml)) continue;
      const references = signed.getReferences();
      if (references.length !== 1 || (references[0] as { uri?: string }).uri?.replace(/^#/, "") !== requestId) continue;
      const signedReferences = signed.getSignedReferences();
      if (signedReferences.length !== 1 || signedReferences[0] === undefined) continue;
      const signedDoc = new DOMParser({ errorHandler: (): void => undefined })
        .parseFromString(signedReferences[0], "text/xml");
      const signedRequests = signedDoc.getElementsByTagNameNS("*", "LogoutRequest");
      const signedRequest = signedRequests.length === 1 ? signedRequests.item(0) : null;
      if (signedRequest === null || signedRequest.getAttribute("ID") !== requestId) continue;
      const signedNameId = signedRequest.getElementsByTagNameNS("*", "NameID").item(0)?.textContent?.trim() ?? "";
      if (signedNameId === "") continue;
      return { valid: true, error: "", nameId: signedNameId, requestId };
    } catch {
      // Try the next certificate (e.g. the old cert during rotation).
    }
  }
  return { valid: false, error: "SAML logout request signature verification failed" };
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
      const signedReferences = signed.getSignedReferences();
      if (signedReferences.length !== 1 || signedReferences[0] === undefined) continue;
      // The signature covers exactly the assertion we will consume.
      return {
        valid: true,
        error: "",
        assertionXml: signedReferences[0],
      };
    } catch {
      // Try the next certificate (e.g. the old cert during rotation).
    }
  }
  return { valid: false, error: "SAML signature verification failed" };
}

async function currentSamlSettings(): Promise<SamlRow> {
  const existing = await db.query.samlSettings.findFirst({ where: eq(samlSettings.id, "saml") });
  if (existing !== undefined) return existing;
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
    return new Response(spMetadataXml(samlSpEntityId(request), acsUrl(request), sloUrl(request)), {
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
    if (!settings.enabled || settings.ssoEndpointUrl === null || settings.idpEntityId === null) {
      return ssoHtmlResponse(ssoHtmlPage("SAML SSO", "SAML single sign-on is not enabled."), 404);
    }
    const requestId = `_${randomBytes(16).toString("hex")}`;
    // Record the issued AuthnRequest so the ACS can match InResponseTo and
    // reject replayed or unsolicited assertions.
    await storeSsoChallenge(SAML_AUTHN_CHALLENGE_KIND, requestId, {}, Date.now() + PENDING_AUTHNREQUEST_TTL_MS);
    const relayState = typeof query.RelayState === "string" ? query.RelayState : null;
    const authnRequest = encodeRedirect(authnRequestXml(samlSpEntityId(request), acsUrl(request), settings.ssoEndpointUrl, requestId));
    let target: URL;
    try {
      target = new URL(settings.ssoEndpointUrl);
    } catch {
      return ssoHtmlResponse(ssoHtmlPage("SAML SSO", "SAML SSO is misconfigured."), 502);
    }
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
    if (statusCode !== SAML_SUCCESS_STATUS) {
      await auditLog("sso-failure", "saml", null, null, null, { reason: "non-success status" });
      (set as { status: number }).status = 400;
      return ssoHtmlResponse(ssoHtmlPage("SAML SSO", "The SAML response reports a failed authentication."), 400);
    }

    const now = Date.now();

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
    if (typeof assertionIdElement !== "string" || assertionIdElement === "") {
      (set as { status: number }).status = 400;
      return ssoHtmlResponse(ssoHtmlPage("SAML SSO", "The SAML assertion has no ID."), 400);
    }

    const responseDestination = responseElement["@_Destination"];
    if (typeof responseDestination === "string" && responseDestination !== "" && responseDestination !== acsUrl(request)) {
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
    const entityId = samlSpEntityId(request);
    if (audiences.length === 0 || !audiences.includes(entityId)) {
      (set as { status: number }).status = 400;
      return ssoHtmlResponse(ssoHtmlPage("SAML SSO", "SAML assertion audience does not match this instance."), 400);
    }

    const assertionIssuer = local(parsedAssertion, "Issuer");
    const assertionIssuerText = typeof assertionIssuer === "string"
      ? assertionIssuer
      : attr(assertionIssuer as Record<string, unknown> | undefined)["#text"];
    if (typeof settings.idpEntityId !== "string" || settings.idpEntityId === ""
      || assertionIssuerText !== settings.idpEntityId) {
      (set as { status: number }).status = 400;
      return ssoHtmlResponse(ssoHtmlPage("SAML SSO", "SAML assertion issuer does not match the configured identity provider."), 400);
    }

    const subject = attr(local(parsedAssertion, "Subject") as Record<string, unknown> | undefined);
    const confirmations = local(subject, "SubjectConfirmation");
    const confirmationList: unknown[] = Array.isArray(confirmations) ? confirmations as unknown[] : [confirmations];
    const validConfirmation = confirmationList.find((candidate): boolean => {
      const confirmation = attr(candidate as Record<string, unknown> | undefined);
      if (confirmation["@_Method"] !== BEARER) return false;
      const data = attr(local(confirmation, "SubjectConfirmationData") as Record<string, unknown> | undefined);
      const inResponseTo = data["@_InResponseTo"];
      const recipient = data["@_Recipient"];
      const notOnOrAfter = data["@_NotOnOrAfter"];
      if (typeof inResponseTo !== "string" || inResponseTo === "") return false;
      if (recipient !== acsUrl(request) || typeof notOnOrAfter !== "string") return false;
      const expiresAt = Date.parse(notOnOrAfter);
      return !Number.isNaN(expiresAt) && expiresAt + TIME_SKEW_MS >= now;
    });
    if (validConfirmation === undefined) {
      (set as { status: number }).status = 400;
      return ssoHtmlResponse(ssoHtmlPage("SAML SSO", "SAML subject confirmation is invalid or does not match this request."), 400);
    }
    const subjectData = attr(local(
      attr(validConfirmation as Record<string, unknown>),
      "SubjectConfirmationData",
    ) as Record<string, unknown> | undefined);
    const inResponseTo = subjectData["@_InResponseTo"];

    const nameId = local(subject, "NameID");
    const nameIdText = typeof nameId === "string" ? nameId : attr(nameId as Record<string, unknown> | undefined)["#text"];
    if (typeof nameIdText !== "string" || nameIdText === "") {
      (set as { status: number }).status = 400;
      return ssoHtmlResponse(ssoHtmlPage("SAML SSO", "The SAML assertion contains no NameID."), 400);
    }

    if (typeof inResponseTo !== "string" || !(await consumeSsoChallenge(SAML_AUTHN_CHALLENGE_KIND, inResponseTo))) {
      (set as { status: number }).status = 400;
      return ssoHtmlResponse(ssoHtmlPage("SAML SSO", "SAML response does not match an issuance from this instance."), 400);
    }
    if (!(await claimSsoChallenge(
      SAML_ASSERTION_CHALLENGE_KIND,
      assertionIdElement,
      {},
      Date.now() + TIME_SKEW_MS + 10 * 60 * 1000,
    ))) {
      (set as { status: number }).status = 400;
      return ssoHtmlResponse(ssoHtmlPage("SAML SSO", "SAML assertion has already been used."), 400);
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

    const tokenTtlMs = settings.ssoApiTokenSessionTimeout === 0
      ? undefined
      : settings.ssoApiTokenSessionTimeout * 1000;
    const session = await issueSsoLogin(user, { set, request, server }, {
      ...(tokenTtlMs === undefined ? {} : { tokenTtlMs }),
      wantsToken: wantsToken(request, relayState),
    });
    await auditLog("sso-login", "saml", user.id, user.id, null, { username: user.username });

    // The browser-session refresh cookie is written into set.headers by
    // issueLoginSession; attach it to the HTML response we return.
    const respond = (body: string): Response => {
      const response = ssoHtmlResponse(body);
      appendSetCookies(response, set.headers["Set-Cookie"]);
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
      const logoutRequest = logoutRequestXml(samlSpEntityId(request), settings.sloEndpointUrl, requestId);
      let target: URL;
      try {
        target = new URL(settings.sloEndpointUrl);
      } catch {
        const response = new Response(null, {
          status: 302,
          headers: { "Cache-Control": "no-store", Location: "/app" },
        });
        appendSetCookies(response, set.headers["Set-Cookie"]);
        return response;
      }
      target.searchParams.set("SAMLRequest", encodeRedirect(logoutRequest));
      const response = new Response(null, {
        status: 302,
        headers: { "Cache-Control": "no-store", Location: target.toString() },
      });
      appendSetCookies(response, set.headers["Set-Cookie"]);
      return response;
    }
    const response = new Response(null, {
      status: 302,
      headers: { "Cache-Control": "no-store", Location: "/app" },
    });
    appendSetCookies(response, set.headers["Set-Cookie"]);
    return response;
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
    if (logoutRequestRaw === "") {
      (set as { status: number }).status = 400;
      return new Response("Invalid SAML logout request", { status: 400 });
    }
    const certificates = [settings.idpCert, settings.oldIdpCert].filter((cert): cert is string => typeof cert === "string" && cert !== "");
    let xml: string;
    try {
      xml = decodeSamlMessage(logoutRequestRaw);
    } catch {
      (set as { status: number }).status = 400;
      return new Response("Invalid SAML logout request", { status: 400 });
    }
    const verifiedLogout = verifyLogoutSignature(xml, certificates);
    if (!verifiedLogout.valid || verifiedLogout.nameId === undefined || verifiedLogout.requestId === undefined) {
      await auditLog("sso-failure", "saml", null, null, null, { reason: verifiedLogout.error });
      (set as { status: number }).status = 400;
      return new Response("Invalid SAML logout request signature", { status: 400 });
    }
    const sessionUser = await browserSessionUser(request);
    if (sessionUser?.ssoProvider !== "saml" || sessionUser.ssoSubject !== verifiedLogout.nameId) {
      await auditLog("sso-failure", "saml", null, sessionUser?.id ?? null, null, { reason: "logout NameID does not match session" });
      (set as { status: number }).status = 400;
      return new Response("Invalid SAML logout request subject", { status: 400 });
    }
    await revokeBrowserSession(set, request);
    await auditLog("sso-logout", "saml", null, null, null, { reason: "IdP-initiated" });
    const response = new Response(logoutResponseXml(samlSpEntityId(request), verifiedLogout.requestId), {
      status: 200,
      headers: {
        "Cache-Control": "no-store",
        "Content-Type": "text/xml; charset=utf-8",
      },
    });
    appendSetCookies(response, set.headers["Set-Cookie"]);
    return response;
  });
