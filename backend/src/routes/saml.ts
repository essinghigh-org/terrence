// SAML 2.0 service provider endpoints: SP metadata, SP-initiated SSO redirect,
// the ACS assertion consumer, and SLO logout. The IdP configuration lives in
// the saml_settings table (admin API + dashboard).
import { Elysia } from "elysia";
import { eq } from "drizzle-orm";
import { randomBytes, verify as verifySignature } from "node:crypto";
import { deflateRawSync, gunzipSync, inflateRawSync } from "node:zlib";
import { DOMParser } from "@xmldom/xmldom";
import { SignedXml } from "xml-crypto";
import { db } from "../db";
import { samlSettings, users } from "../db/schema";
import { getSettings } from "../lib/settings";
import { auditLog } from "../lib/utils";
import {
  appendSetCookies,
  provisionSsoUser,
  syncSamlGroupMappings,
  ssoHtmlPage,
  ssoHtmlResponse,
  SsoConflictError,
} from "../lib/sso";
import { claimSsoChallenge, consumeSsoChallenge, storeSsoChallenge } from "../lib/sso-challenges";
import { issueSsoLogin } from "../lib/sso-login";
import { secureRequest } from "../lib/secure-request";
import { isUserLoginBlocked } from "./accounts";
import { browserSessionUser, revokeBrowserSession } from "./accounts";

type HeaderValue = string | number | readonly string[];
type SetObj = Readonly<{ status?: number | string; headers: Readonly<Record<string, HeaderValue>> }>;
type RequestInfo = Readonly<{ url: string; headers: Readonly<{ get: (name: string) => string | null }> }>;

const SAML_VERSION = "urn:oasis:names:tc:SAML:2.0:assertion";
const PROTOCOL = "urn:oasis:names:tc:SAML:2.0:protocol";
// SAML 2.0 core specifies the bearer confirmation method under the "cm"
// namespace, NOT under the assertion namespace.
const BEARER = "urn:oasis:names:tc:SAML:2.0:cm:bearer";
const SAML_SUCCESS_STATUS = "urn:oasis:names:tc:SAML:2.0:status:Success";
const SAML_PARTIAL_LOGOUT_STATUS = "urn:oasis:names:tc:SAML:2.0:status:PartialLogout";
const TIME_SKEW_MS = 5 * 60 * 1000;
// Cap the decoded/decodescapped SAML message size so an attacker-supplied
// compressed payload cannot expand into excessive memory.
const MAX_SAML_MESSAGE_BYTES = 1024 * 1024;
// Signature verification is the expensive step; cap the elements checked so
// a doctored document cannot force unbounded signature work.
const MAX_SAML_SIGNATURE_NODES = 4;
const REDIRECT_SIGNATURE_ALGORITHMS: Readonly<Record<string, string>> = {
  "http://www.w3.org/2001/04/xmldsig-more#rsa-sha256": "RSA-SHA256",
  "http://www.w3.org/2001/04/xmldsig-more#rsa-sha384": "RSA-SHA384",
  "http://www.w3.org/2001/04/xmldsig-more#rsa-sha512": "RSA-SHA512",
};
const XML_SIGNATURE_ALGORITHMS = new Set([
  "http://www.w3.org/2001/04/xmldsig-more#rsa-sha256",
  "http://www.w3.org/2001/04/xmldsig-more#rsa-sha384",
  "http://www.w3.org/2001/04/xmldsig-more#rsa-sha512",
]);
const XML_DIGEST_ALGORITHMS = new Set([
  "http://www.w3.org/2001/04/xmlenc#sha256",
  "http://www.w3.org/2001/04/xmldsig-more#sha384",
  "http://www.w3.org/2001/04/xmlenc#sha512",
]);
const XML_CANONICALIZATION_ALGORITHMS = new Set([
  "http://www.w3.org/2001/10/xml-exc-c14n#",
]);
const XML_TRANSFORM_ALGORITHMS = new Set([
  "http://www.w3.org/2000/09/xmldsig#enveloped-signature",
  "http://www.w3.org/2001/10/xml-exc-c14n#",
]);

function supportedXmlSignature(signed: SignedXml): boolean {
  if (!XML_SIGNATURE_ALGORITHMS.has(signed.signatureAlgorithm ?? "")
    || !XML_CANONICALIZATION_ALGORITHMS.has(signed.canonicalizationAlgorithm ?? "")) return false;
  return signed.getReferences().every((reference): boolean => (
    XML_DIGEST_ALGORITHMS.has(reference.digestAlgorithm)
    && reference.transforms.every((transform): boolean => XML_TRANSFORM_ALGORITHMS.has(transform))
  ));
}

function pemCertificate(certificate: string): string {
  if (certificate.includes("-----BEGIN CERTIFICATE-----")) return certificate;
  const body = certificate.replace(/\s+/g, "").match(/.{1,64}/g)?.join("\n") ?? "";
  return `-----BEGIN CERTIFICATE-----\n${body}\n-----END CERTIFICATE-----\n`;
}

// AuthnRequests we issued are recorded and matched against InResponseTo so
// captured assertions cannot be replayed against the ACS.
const PENDING_AUTHNREQUEST_TTL_MS = 10 * 60 * 1000;
const SAML_AUTHN_CHALLENGE_KIND = "saml-authn";
const SAML_ASSERTION_CHALLENGE_KIND = "saml-assertion";
const SAML_LOGOUT_CHALLENGE_KIND = "saml-logout";
const SAML_STATE_COOKIE = "terrence_saml_state";
const DEFAULT_SSO_API_TOKEN_TTL_MS = 12 * 60 * 60 * 1000;

type SamlRow = Readonly<typeof samlSettings.$inferSelect>;

function samlBaseUrl(request: RequestInfo): string {
  const configured = process.env["PUBLIC_URL"]?.trim();
  if (configured !== undefined && configured !== "") {
    try {
      const parsed = new URL(configured);
      if ((parsed.protocol !== "http:" && parsed.protocol !== "https:")
        || parsed.username !== "" || parsed.password !== "") {
        throw new Error("invalid URL");
      }
      return parsed.toString();
    } catch {
      throw new Error("PUBLIC_URL must be a valid HTTP(S) URL for SAML endpoints");
    }
  }

  let requestUrl: URL;
  try {
    requestUrl = new URL(request.url);
  } catch {
    throw new Error("PUBLIC_URL must be configured for SAML endpoints");
  }
  const hostname = requestUrl.hostname.replace(/^\[|\]$/g, "").toLowerCase();
  const loopback = hostname === "localhost" || hostname === "127.0.0.1" || hostname === "::1";
  if (process.env.NODE_ENV === "test" || (process.env.NODE_ENV !== "production" && loopback)) {
    return requestUrl.origin;
  }
  throw new Error("PUBLIC_URL must be configured for SAML endpoints");
}

function samlSpEntityId(request: RequestInfo): string {
  return new URL("/users/saml/metadata", samlBaseUrl(request)).toString();
}

function acsUrl(request: RequestInfo): string {
  return new URL("/users/saml/auth", samlBaseUrl(request)).toString();
}

function sloUrl(request: RequestInfo): string {
  return new URL("/users/saml/slo", samlBaseUrl(request)).toString();
}

function logoutEndpointUrl(request: RequestInfo): string {
  return new URL("/users/saml/logout", samlBaseUrl(request)).toString();
}

/** Read a same-site cookie value from a request. */
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

function samlStateCookie(request: RequestInfo, state: string, maxAge: number, server?: unknown): string {
  const secure = secureRequest(request, server);
  return `${SAML_STATE_COOKIE}=${state}; Path=/users/saml; HttpOnly; ${secure ? "SameSite=None; Secure" : "SameSite=Lax"}; Max-Age=${maxAge}`;
}

function clearSamlStateCookie(request: RequestInfo, response: Response, server?: unknown): void {
  response.headers.append("Set-Cookie", samlStateCookie(request, "", 0, server));
}

function callbackResponse(request: RequestInfo, set: SetObj, body: string, status: number, server?: unknown): Response {
  const response = ssoHtmlResponse(body, status);
  appendSetCookies(response, set.headers["Set-Cookie"]);
  clearSamlStateCookie(request, response, server);
  return response;
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
  let text: string;
  if (raw.length >= 2 && raw[0] === 0x1f && raw[1] === 0x8b) {
    text = gunzipSync(raw, { maxOutputLength: MAX_SAML_MESSAGE_BYTES }).toString("utf8");
  } else {
    try {
      text = inflateRawSync(raw, { maxOutputLength: MAX_SAML_MESSAGE_BYTES }).toString("utf8");
    } catch {
      text = raw.toString("utf8");
    }
  }
  // A DOCTYPE can declare entity expansions; reject it before any parser
  // touches the message (both parsers keep entity expansion disabled too).
  if (/<!doctype/i.test(text)) throw new Error("SAML message must not contain a DOCTYPE");
  return text;
}

/** Build an SP-initiated LogoutRequest for the HTTP-Redirect binding. */
function logoutRequestXml(entityId: string, destination: string, requestId: string, nameId: string): string {
  const now = new Date().toISOString();
  return `<?xml version="1.0" encoding="UTF-8"?>
<samlp:LogoutRequest xmlns:samlp="${PROTOCOL}" xmlns:saml="${SAML_VERSION}" ID="${requestId}" Version="2.0" IssueInstant="${now}" Destination="${xmlEscape(destination)}">
  <saml:Issuer>${xmlEscape(entityId)}</saml:Issuer>
  <saml:NameID Format="urn:oasis:names:tc:SAML:1.1:nameid-format:unspecified">${xmlEscape(nameId)}</saml:NameID>
</samlp:LogoutRequest>
`;
}

/** Build the LogoutResponse the SP returns for an IdP-initiated logout. */
function logoutResponseXml(entityId: string, inResponseTo: string, success: boolean): string {
  const now = new Date().toISOString();
  const status = success ? SAML_SUCCESS_STATUS : SAML_PARTIAL_LOGOUT_STATUS;
  return `<?xml version="1.0" encoding="UTF-8"?>
<samlp:LogoutResponse xmlns:samlp="${PROTOCOL}" xmlns:saml="${SAML_VERSION}" ID="_${randomBytes(16).toString("hex")}" Version="2.0" IssueInstant="${now}" InResponseTo="${xmlEscape(inResponseTo)}">
  <saml:Issuer>${xmlEscape(entityId)}</saml:Issuer>
  <samlp:Status>
    <samlp:StatusCode Value="${status}"/>
  </samlp:Status>
</samlp:LogoutResponse>
`;
}

/** Verify the IdP's LogoutRequest signature against the configured certs. */
function rawQueryParameter(requestUrl: string, name: string): string | undefined {
  const query = new URL(requestUrl).search.slice(1);
  for (const part of query.split("&")) {
    const separator = part.indexOf("=");
    if (separator === -1) continue;
    try {
      if (decodeURIComponent(part.slice(0, separator).replaceAll("+", " ")) === name) {
        return part.slice(separator + 1);
      }
    } catch {
      // One malformed parameter must not hide the one we are looking for.
      continue;
    }
  }
  return undefined;
}

function verifyRedirectLogoutSignature(
  request: RequestInfo,
  certificates: readonly string[],
  expectedRawRequest: string,
): Readonly<{ present: boolean; valid: boolean }> {
  const rawRequest = rawQueryParameter(request.url, "SAMLRequest");
  const rawSignature = rawQueryParameter(request.url, "Signature");
  const rawSigAlg = rawQueryParameter(request.url, "SigAlg");
  if (rawSignature === undefined && rawSigAlg === undefined) {
    return { present: false, valid: false };
  }
  if (rawRequest === undefined || rawSignature === undefined || rawSigAlg === undefined) {
    return { present: true, valid: false };
  }
  let decodedRawRequest: string;
  try {
    decodedRawRequest = decodeURIComponent(rawRequest.replaceAll("+", " "));
  } catch {
    return { present: true, valid: false };
  }
  if (decodedRawRequest !== expectedRawRequest) return { present: true, valid: false };
  let sigAlg: string;
  let signature: Buffer;
  try {
    sigAlg = decodeURIComponent(rawSigAlg);
    signature = Buffer.from(decodeURIComponent(rawSignature).replaceAll(" ", "+"), "base64");
  } catch {
    return { present: true, valid: false };
  }
  const algorithm = REDIRECT_SIGNATURE_ALGORITHMS[sigAlg];
  if (algorithm === undefined) return { present: true, valid: false };
  const rawRelayState = rawQueryParameter(request.url, "RelayState");
  const signedInput = `SAMLRequest=${rawRequest}${rawRelayState === undefined ? "" : `&RelayState=${rawRelayState}`}&SigAlg=${rawSigAlg}`;
  const valid = certificates.some((certificate): boolean => {
    try {
      return verifySignature(algorithm, Buffer.from(signedInput, "utf8"), pemCertificate(certificate), signature);
    } catch {
      return false;
    }
  });
  return { present: true, valid };
}

type LogoutVerification = Readonly<{
  valid: boolean;
  error: string;
  nameId?: string;
  requestId?: string;
  issuer?: string;
  destination?: string;
  issueInstant?: string;
}>;

function verifyLogoutSignature(
  xml: string,
  certificates: readonly string[],
  redirectBinding = false,
): LogoutVerification {
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
  const nameId = request?.getElementsByTagNameNS("*", "NameID").item(0)?.textContent?.trim() ?? "";
  if (nameId === "") return { valid: false, error: "SAML logout request has no NameID" };
  const issuer = request?.getElementsByTagNameNS("*", "Issuer").item(0)?.textContent?.trim() ?? "";
  const destination = request?.getAttribute("Destination") ?? "";
  const issueInstant = request?.getAttribute("IssueInstant") ?? "";
  if (redirectBinding) return { valid: true, error: "", nameId, requestId, issuer, destination, issueInstant };
  const signatureElement = doc.getElementsByTagNameNS("*", "Signature").item(0);
  if (signatureElement === null) return { valid: false, error: "SAML logout request is not signed" };
  for (const certificate of certificates) {
    try {
      const signed = new SignedXml();
      signed.getCertFromKeyInfo = (): string => pemCertificate(certificate);
      signed.loadSignature(signatureElement as unknown as Parameters<SignedXml["loadSignature"]>[0]);
      if (!supportedXmlSignature(signed)) continue;
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
      if (signedNameId !== nameId) continue;
      return { valid: true, error: "", nameId, requestId, issuer, destination, issueInstant };
    } catch {
      // Try the next certificate (e.g. the old cert during rotation).
    }
  }
  return { valid: false, error: "SAML logout request signature verification failed" };
}

/** Local-name DOM helpers: the document may use any namespace prefix. */
type DomRoot = Readonly<{
  getElementsByTagNameNS(namespaceURI: string | null, localName: string): Readonly<{ item(index: number): DomElement | null; readonly length: number }>;
}>;
type DomElement = Readonly<{
  getAttribute(name: string): string | null;
  readonly textContent: string | null;
  getElementsByTagNameNS(namespaceURI: string | null, localName: string): Readonly<{ item(index: number): DomElement | null; readonly length: number }>;
}>;

function domElements(root: DomRoot | null, localName: string): DomElement[] {
  if (root === null) return [];
  const nodes = root.getElementsByTagNameNS("*", localName);
  const out: DomElement[] = [];
  for (let index = 0; index < nodes.length; index += 1) {
    const node = nodes.item(index);
    if (node !== null) out.push(node);
  }
  return out;
}

function domElement(root: DomRoot | null, localName: string): DomElement | null {
  return root?.getElementsByTagNameNS("*", localName).item(0) ?? null;
}

function domText(root: DomRoot | null, localName: string): string {
  return domElement(root, localName)?.textContent ?? "";
}

type SamlAttribute = Readonly<{ name: string | null; friendlyName: string | null; values: readonly string[] }>;

/** Read Attribute elements (Name/FriendlyName + AttributeValue texts). */
function samlAttributes(statement: DomElement): SamlAttribute[] {
  return domElements(statement, "Attribute").map((attribute): SamlAttribute => ({
    name: attribute.getAttribute("Name"),
    friendlyName: attribute.getAttribute("FriendlyName"),
    values: domElements(attribute, "AttributeValue")
      .map((value): string => value.textContent ?? "")
      .filter((value): boolean => value !== ""),
  }));
}

/** Find every Attribute element whose Name or FriendlyName matches. */
function namedAttribute(attributes: unknown, name: string): string[] {
  if (!Array.isArray(attributes)) return [];
  const collected: string[] = [];
  for (const attribute of attributes) {
    if (attribute === null || typeof attribute !== "object") continue;
    const record = attribute as SamlAttribute;
    if ((typeof record.name === "string" && record.name === name)
      || (typeof record.friendlyName === "string" && record.friendlyName === name)) {
      collected.push(...record.values);
    }
  }
  return collected;
}

function spMetadataXml(entityId: string, acs: string, slo: string, postSlo: string): string {
  return `<?xml version="1.0" encoding="UTF-8"?>
<md:EntityDescriptor xmlns:md="urn:oasis:names:tc:SAML:2.0:metadata" entityID="${xmlEscape(entityId)}">
  <md:SPSSODescriptor AuthnRequestsSigned="false" WantAssertionsSigned="true" protocolSupportEnumeration="urn:oasis:names:tc:SAML:2.0:protocol">
    <md:NameIDFormat>urn:oasis:names:tc:SAML:1.1:nameid-format:unspecified</md:NameIDFormat>
    <md:AssertionConsumerService Binding="urn:oasis:names:tc:SAML:2.0:bindings:HTTP-POST" Location="${xmlEscape(acs)}" index="0" isDefault="true"/>
    <md:SingleLogoutService Binding="urn:oasis:names:tc:SAML:2.0:bindings:HTTP-Redirect" Location="${xmlEscape(slo)}"/>
    <md:SingleLogoutService Binding="urn:oasis:names:tc:SAML:2.0:bindings:HTTP-POST" Location="${xmlEscape(postSlo)}"/>
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

/**
 * Verify a signed SAML response and return the exact (code-verified)
 * assertion payload XML. The returned assertion is the element that the
 * signature actually covers, which prevents signature-wrapping attacks: an
 * attacker inserting an extra unsigned assertion cannot smuggle it past the
 * single-Reference check into the consumed document.
 */
type SignedAssertionResult =
  | Readonly<{ valid: true; error: ""; assertionXml: string }>
  | Readonly<{ valid: false; error: string }>;

function signedAssertionResult(
  xml: string,
  certificates: readonly string[],
): SignedAssertionResult {
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

  const signatureNodes = doc.getElementsByTagNameNS("*", "Signature");
  if (signatureNodes.length === 0) return { valid: false, error: "SAML response is not signed" };
  // An attacker can stuff a document with signature elements to exhaust CPU;
  // the single verified signature is all the flow ever needs.
  if (signatureNodes.length > MAX_SAML_SIGNATURE_NODES) {
    return { valid: false, error: "SAML response contains too many signatures" };
  }

  for (let index = 0; index < signatureNodes.length; index += 1) {
    const signatureElement = signatureNodes.item(index);
    if (signatureElement === null) continue;
    for (const certificate of certificates) {
      try {
        const signed = new SignedXml();
        signed.getCertFromKeyInfo = (): string => pemCertificate(certificate);
        signed.loadSignature(signatureElement as unknown as Parameters<SignedXml["loadSignature"]>[0]);
        if (!supportedXmlSignature(signed)) continue;
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
        return { valid: true, error: "", assertionXml: signedReferences[0] };
      } catch {
        // Try the next signature and certificate (e.g. during rotation).
      }
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

function acceptsJson(request: RequestInfo | undefined): boolean {
  return (request?.headers.get("accept") ?? "")
    .split(",")
    .some((value: string): boolean => {
      const parameters = value.split(";");
      const mediaType = parameters.shift()?.trim().toLowerCase();
      if (mediaType !== "application/json" && mediaType !== "application/vnd.api+json") return false;
      const qualityParameter = parameters.find((parameter: string): boolean => /^q\s*=/iu.test(parameter.trim()));
      if (qualityParameter === undefined) return true;
      const quality = Number(qualityParameter.slice(qualityParameter.indexOf("=") + 1).trim().replace(/^"|"$/gu, ""));
      return Number.isFinite(quality) && quality > 0 && quality <= 1;
    });
}

function wantsToken(request: RequestInfo | undefined, relayState: string | null): boolean {
  const tokenRelayState = relayState === "api" || relayState === "api-token" || relayState === "terraform-cli"
    || (relayState !== null && relayState.startsWith("cli"));
  // A top-level browser navigation normally asks for HTML. Requiring an
  // explicit JSON client signal prevents a caller-controlled RelayState from
  // switching an ordinary browser SSO login into a token-rendering flow.
  return tokenRelayState && acceptsJson(request);
}

function sessionTokenValue(session: unknown): string | null {
  if (session === null || typeof session !== "object") return null;
  const data = (session as { data?: unknown }).data;
  if (data === null || typeof data !== "object") return null;
  const attributes = (data as { attributes?: unknown }).attributes;
  if (attributes === null || typeof attributes !== "object") return null;
  const token = (attributes as { token?: unknown }).token;
  return typeof token === "string" ? token : null;
}

async function handleIdpInitiatedLogout(
  rawRequest: string,
  relayState: string | undefined,
  settings: SamlRow,
  request: RequestInfo,
  set: SetObj,
): Promise<Response> {
  if (!settings.enabled) return ssoHtmlResponse(ssoHtmlPage("SAML SSO", "SAML single sign-on is not enabled."), 404);
  const invalid = (message: string): Response => new Response(message, {
    status: 400,
    headers: { "Cache-Control": "no-store", "Content-Type": "text/plain; charset=utf-8" },
  });
  let expectedSloUrl: string;
  let expectedLogoutEndpointUrl: string;
  let entityId: string;
  try {
    expectedSloUrl = sloUrl(request);
    expectedLogoutEndpointUrl = logoutEndpointUrl(request);
    entityId = samlSpEntityId(request);
  } catch {
    return new Response("SAML SSO is misconfigured. PUBLIC_URL must be configured.", {
      status: 502,
      headers: { "Cache-Control": "no-store", "Content-Type": "text/plain; charset=utf-8" },
    });
  }
  if (rawRequest === "") return invalid("Invalid SAML logout request");

  let xml: string;
  try {
    xml = decodeSamlMessage(rawRequest);
  } catch {
    return invalid("Invalid SAML logout request");
  }
  const certificates = [settings.idpCert, settings.oldIdpCert]
    .filter((cert): cert is string => typeof cert === "string" && cert !== "");
  const redirectSignature = verifyRedirectLogoutSignature(request, certificates, rawRequest);
  if (redirectSignature.present && !redirectSignature.valid) {
    await auditLog("sso-failure", "saml", null, null, null, { reason: "SAML redirect signature verification failed" });
    return invalid("Invalid SAML logout request signature");
  }
  const verifiedLogout = verifyLogoutSignature(xml, certificates, redirectSignature.present);
  if (!verifiedLogout.valid || verifiedLogout.nameId === undefined || verifiedLogout.requestId === undefined) {
    await auditLog("sso-failure", "saml", null, null, null, { reason: verifiedLogout.error });
    return invalid("Invalid SAML logout request signature");
  }
  // The IssueInstant must be present and within the clock-skew window: a
  // stale or future-dated LogoutRequest is not worth acting on.
  const issueInstantMs = verifiedLogout.issueInstant !== undefined ? Date.parse(verifiedLogout.issueInstant) : Number.NaN;
  if (Number.isNaN(issueInstantMs) || Math.abs(Date.now() - issueInstantMs) > TIME_SKEW_MS) {
    await auditLog("sso-failure", "saml", null, null, null, { reason: "SAML logout request issue instant out of range" });
    return invalid("Invalid SAML logout request");
  }
  // The LogoutRequest must name this IdP and target one of this SP's SLO
  // endpoints; otherwise the session must not be revoked on its authority.
  if (verifiedLogout.issuer === undefined || verifiedLogout.issuer === ""
    || verifiedLogout.issuer !== settings.idpEntityId
    || verifiedLogout.destination === undefined || verifiedLogout.destination === ""
    || (verifiedLogout.destination !== expectedSloUrl && verifiedLogout.destination !== expectedLogoutEndpointUrl)) {
    await auditLog("sso-failure", "saml", null, null, null, { reason: "SAML logout request issuer or destination mismatch" });
    return invalid("Invalid SAML logout request");
  }
  if (!(await claimSsoChallenge(
    SAML_LOGOUT_CHALLENGE_KIND,
    verifiedLogout.requestId,
    {},
    Date.now() + PENDING_AUTHNREQUEST_TTL_MS,
  ))) {
    await auditLog("sso-failure", "saml", null, null, null, { reason: "SAML logout request replayed" });
    return invalid("SAML logout request has already been used");
  }

  const sessionUser = await browserSessionUser(request);
  const subjectMatches = sessionUser?.ssoProvider === "saml" && sessionUser.ssoSubject === verifiedLogout.nameId;
  if (!subjectMatches) {
    await auditLog("sso-failure", "saml", null, sessionUser?.id ?? null, null, { reason: "logout NameID does not match session" });
  } else if (sessionUser !== null) {
    await revokeBrowserSession(set, request);
    await auditLog("sso-logout", "saml", sessionUser.id, sessionUser.id, null, { reason: "IdP-initiated" });
  }

  if (settings.sloEndpointUrl === null) {
    const response = new Response(null, { status: 302, headers: { "Cache-Control": "no-store", Location: "/app" } });
    appendSetCookies(response, set.headers["Set-Cookie"]);
    return response;
  }
  let target: URL;
  try {
    target = new URL(settings.sloEndpointUrl);
  } catch {
    const response = new Response(null, { status: 302, headers: { "Cache-Control": "no-store", Location: "/app" } });
    appendSetCookies(response, set.headers["Set-Cookie"]);
    return response;
  }
  // A LogoutRequest whose NameID does not match the local session cannot
  // count as a full logout: report PartialLogout per SAML 2.0 so the IdP
  // does not consider the session terminated on this SP.
  target.searchParams.set("SAMLResponse", encodeRedirect(logoutResponseXml(entityId, verifiedLogout.requestId, subjectMatches)));
  if (relayState !== undefined) target.searchParams.set("RelayState", relayState);
  const response = new Response(null, {
    status: 302,
    headers: { "Cache-Control": "no-store", Location: target.toString() },
  });
  appendSetCookies(response, set.headers["Set-Cookie"]);
  return response;
}

function isApplicationLogoutRequest(request: RequestInfo): boolean {
  if (request.headers.get("sec-fetch-site") === "same-origin") return true;
  const origin = request.headers.get("origin");
  if (origin === null) return false;
  try {
    return new URL(origin).origin === new URL(request.url).origin;
  } catch {
    return false;
  }
}

export const samlRoutes = new Elysia({ name: "saml-sso" })
  .get("/users/saml/metadata", async ({ request }: {
    request: RequestInfo;
  }): Promise<Response> => {
    await currentSamlSettings();
    try {
      return new Response(spMetadataXml(samlSpEntityId(request), acsUrl(request), sloUrl(request), logoutEndpointUrl(request)), {
        headers: {
          "Content-Type": "application/xml; charset=utf-8",
          "Cache-Control": "public, max-age=300",
        },
      });
    } catch {
      return ssoHtmlResponse(ssoHtmlPage("SAML SSO", "SAML SSO is misconfigured. PUBLIC_URL must be configured."), 502);
    }
  })
  .get("/users/saml/auth", async ({ query, request, server }: {
    query: Readonly<Record<string, unknown>>;
    request: RequestInfo;
    server?: unknown;
  }): Promise<unknown> => {
    const settings = await currentSamlSettings();
    if (!settings.enabled || settings.ssoEndpointUrl === null || settings.idpEntityId === null) {
      return ssoHtmlResponse(ssoHtmlPage("SAML SSO", "SAML single sign-on is not enabled."), 404);
    }
    if (!secureRequest(request, server)) {
      return ssoHtmlResponse(ssoHtmlPage("SAML SSO", "SAML SSO requires HTTPS."), 400);
    }
    let target: URL;
    let entityId: string;
    let assertionConsumerService: string;
    try {
      target = new URL(settings.ssoEndpointUrl);
      entityId = samlSpEntityId(request);
      assertionConsumerService = acsUrl(request);
    } catch {
      return ssoHtmlResponse(ssoHtmlPage("SAML SSO", "SAML SSO is misconfigured. PUBLIC_URL must be configured."), 502);
    }
    const requestId = `_${randomBytes(16).toString("hex")}`;
    // Record the issued AuthnRequest so the ACS can match InResponseTo and
    // reject replayed or unsolicited assertions.
    const rawRelayState = typeof query["RelayState"] === "string" ? query["RelayState"] : null;
    // SAML 2.0 bindings cap RelayState at 80 bytes; reject oversized values
    // instead of storing or forwarding them to the IdP.
    if (rawRelayState !== null && Buffer.byteLength(rawRelayState, "utf8") > 80) {
      return ssoHtmlResponse(ssoHtmlPage("SAML SSO", "RelayState is too large."), 400);
    }
    const relayState = rawRelayState;
    await storeSsoChallenge(SAML_AUTHN_CHALLENGE_KIND, requestId, {
      relayState,
      tokenResponse: wantsToken(request, relayState),
    }, Date.now() + PENDING_AUTHNREQUEST_TTL_MS);
    const authnRequest = encodeRedirect(authnRequestXml(entityId, assertionConsumerService, settings.ssoEndpointUrl, requestId));
    target.searchParams.set("SAMLRequest", authnRequest);
    if (relayState !== null) target.searchParams.set("RelayState", relayState);
    return new Response(null, {
      status: 302,
      headers: {
        "Cache-Control": "no-store",
        Location: target.toString(),
        "Set-Cookie": samlStateCookie(request, requestId, Math.ceil(PENDING_AUTHNREQUEST_TTL_MS / 1000), server),
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
      return callbackResponse(request, set, ssoHtmlPage("SAML SSO", "SAML single sign-on is not enabled."), 404, server);
    }
    if (!secureRequest(request, server)) {
      (set as { status: number }).status = 400;
      return callbackResponse(request, set, ssoHtmlPage("SAML SSO", "SAML SSO requires HTTPS."), 400, server);
    }

    let entityId: string;
    let assertionConsumerService: string;
    try {
      entityId = samlSpEntityId(request);
      assertionConsumerService = acsUrl(request);
    } catch {
      (set as { status: number }).status = 502;
      return callbackResponse(request, set, ssoHtmlPage("SAML SSO", "SAML SSO is misconfigured. PUBLIC_URL must be configured."), 502, server);
    }
    const reject = (message: string, status: number): Response => {
      (set as { status: number }).status = status;
      return callbackResponse(request, set, ssoHtmlPage("SAML SSO", message), status, server);
    };

    const form = (body !== null && typeof body === "object" ? body : {}) as Record<string, unknown>;
    const samlResponse = typeof form["SAMLResponse"] === "string"
      ? form["SAMLResponse"]
      : typeof query["SAMLResponse"] === "string"
        ? query["SAMLResponse"]
        : "";
    const relayState = typeof form["RelayState"] === "string"
      ? form["RelayState"]
      : typeof query["RelayState"] === "string" ? query["RelayState"] : null;
    if (samlResponse === "") {
      (set as { status: number }).status = 400;
      return reject("Missing SAMLResponse.", 400);
    }

    let xml: string;
    try {
      xml = decodeSamlMessage(samlResponse);
    } catch {
      (set as { status: number }).status = 400;
      return reject("The SAML response could not be decoded.", 400);
    }

    // Parse the top-level response with the DOM parser so structure,
    // attributes, and signatures all come from the same source.
    let responseDoc: ReturnType<DOMParser["parseFromString"]>;
    try {
      responseDoc = new DOMParser({ errorHandler: (): void => undefined }).parseFromString(xml, "text/xml");
    } catch {
      (set as { status: number }).status = 400;
      return reject("The SAML response could not be parsed.", 400);
    }
    const responseElement = domElement(responseDoc, "Response");
    if (responseElement === null) {
      (set as { status: number }).status = 400;
      return reject("The SAML response could not be parsed.", 400);
    }

    // Reject an explicitly failed response. Status is outside an
    // assertion-only signature, so the signed assertion below remains the
    // authentication gate when the IdP does not sign the Response element.
    const statusCode = domElement(responseElement, "StatusCode")?.getAttribute("Value") ?? "";
    if (statusCode !== SAML_SUCCESS_STATUS) {
      await auditLog("sso-failure", "saml", null, null, null, { reason: "non-success status" });
      (set as { status: number }).status = 400;
      return reject("The SAML response reports a failed authentication.", 400);
    }

    const now = Date.now();

    const certificates = [settings.idpCert, settings.oldIdpCert].filter((cert): cert is string => typeof cert === "string" && cert !== "");
    const signature = signedAssertionResult(xml, certificates);
    if (!signature.valid) {
      await auditLog("sso-failure", "saml", null, null, null, { reason: signature.error });
      (set as { status: number }).status = 400;
      return reject(signature.error, 400);
    }

    // Parse only the assertion that was actually covered by the verified
    // signature — never the full untrusted document.
    let assertionElement: DomElement;
    try {
      const verifiedDoc = new DOMParser({ errorHandler: (): void => undefined }).parseFromString(signature.assertionXml, "text/xml");
      const assertion = domElement(verifiedDoc, "Assertion");
      if (assertion === null) throw new Error("no assertion");
      assertionElement = assertion;
    } catch {
      (set as { status: number }).status = 400;
      return reject("The SAML response contains no assertion.", 400);
    }

    // Reject replays: an assertion whose ID we have already consumed within
    // its validity window is a re-submission of a live assertion.
    const assertionIdElement = assertionElement.getAttribute("ID") ?? "";
    if (assertionIdElement === "") {
      (set as { status: number }).status = 400;
      return reject("The SAML assertion has no ID.", 400);
    }

    const responseDestination = responseElement.getAttribute("Destination");
    if (typeof responseDestination === "string" && responseDestination !== "" && responseDestination !== assertionConsumerService) {
      return reject("SAML assertion Destination does not match the ACS URL.", 400);
    }
    const conditionsElement = domElement(assertionElement, "Conditions");
    const notBefore = conditionsElement?.getAttribute("NotBefore") ?? undefined;
    const notOnOrAfter = conditionsElement?.getAttribute("NotOnOrAfter") ?? undefined;
    const parseInstant = (value: unknown): number | undefined =>
      typeof value === "string" ? Date.parse(value) : undefined;
    const notBeforeMs = parseInstant(notBefore);
    if (notBeforeMs !== undefined && (Number.isNaN(notBeforeMs) || notBeforeMs - TIME_SKEW_MS > now)) {
      return reject("SAML assertion is not yet valid.", 400);
    }
    const notOnOrAfterMs = parseInstant(notOnOrAfter);
    if (notOnOrAfterMs !== undefined && (Number.isNaN(notOnOrAfterMs) || notOnOrAfterMs + TIME_SKEW_MS < now)) {
      return reject("SAML assertion has expired.", 400);
    }

    const audiences = domElements(assertionElement, "AudienceRestriction").flatMap((restriction): string[] =>
      domElements(restriction, "Audience").map((audience): string => audience.textContent?.trim() ?? "")
    );
    if (audiences.length === 0 || !audiences.includes(entityId)) {
      return reject("SAML assertion audience does not match this instance.", 400);
    }

    const assertionIssuerText = domText(assertionElement, "Issuer");
    if (typeof settings.idpEntityId !== "string" || settings.idpEntityId === ""
      || assertionIssuerText !== settings.idpEntityId) {
      return reject("SAML assertion issuer does not match the configured identity provider.", 400);
    }

    const subjectElement = domElement(assertionElement, "Subject");
    const confirmationList = domElements(subjectElement, "SubjectConfirmation");
    const validConfirmation = confirmationList.find((confirmation): boolean => {
      if (confirmation.getAttribute("Method") !== BEARER) return false;
      const data = domElement(confirmation, "SubjectConfirmationData");
      if (data === null) return false;
      const inResponseTo = data.getAttribute("InResponseTo") ?? "";
      const recipient = data.getAttribute("Recipient") ?? "";
      const notOnOrAfter = data.getAttribute("NotOnOrAfter") ?? "";
      if (inResponseTo === "" || recipient !== assertionConsumerService || notOnOrAfter === "") return false;
      const expiresAt = Date.parse(notOnOrAfter);
      return !Number.isNaN(expiresAt) && expiresAt + TIME_SKEW_MS >= now;
    });
    if (validConfirmation === undefined) {
      return reject("SAML subject confirmation is invalid or does not match this request.", 400);
    }
    const subjectData = domElement(validConfirmation, "SubjectConfirmationData");
    const inResponseTo = subjectData?.getAttribute("InResponseTo") ?? "";

    const nameIdText = domText(subjectElement, "NameID");
    if (nameIdText === "") {
      return reject("The SAML assertion contains no NameID.", 400);
    }

    if (cookieValue(request, SAML_STATE_COOKIE) !== inResponseTo) {
      return reject("SAML response does not match the browser that started this sign-in.", 400);
    }

    const authnChallenge = typeof inResponseTo === "string"
      ? await consumeSsoChallenge(SAML_AUTHN_CHALLENGE_KIND, inResponseTo)
      : undefined;
    const issuedRelayState = authnChallenge?.["relayState"] === null || typeof authnChallenge?.["relayState"] === "string"
      ? authnChallenge["relayState"]
      : undefined;
    if (issuedRelayState === undefined || issuedRelayState !== relayState) {
      return reject("SAML response does not match an issuance from this instance.", 400);
    }
    const issuedTokenResponse = authnChallenge?.["tokenResponse"] === true;
    if (!(await claimSsoChallenge(
      SAML_ASSERTION_CHALLENGE_KIND,
      assertionIdElement,
      {},
      Date.now() + TIME_SKEW_MS + 10 * 60 * 1000,
    ))) {
      return reject("SAML assertion has already been used.", 400);
    }

    const attributesList = domElements(assertionElement, "AttributeStatement")
      .flatMap((statement): SamlAttribute[] => samlAttributes(statement));
  const usernameValues = namedAttribute(attributesList, settings.attrUsername);
  const username = usernameValues[0] ?? nameIdText;
  // Linking by email must be anchored to an explicitly configured attribute:
  // guessing among well-known names could attach an identity by an attribute
  // the administrator never vetted.
  const attrEmailConfigured = typeof settings.attrEmail === "string" && settings.attrEmail !== "";
  const emailAttributeNames = attrEmailConfigured
    ? [settings.attrEmail]
    : ["email", "mail", "Email", "EmailAddress"];
  const emailValues = emailAttributeNames.flatMap((name): string[] => namedAttribute(attributesList, name));
  const email = emailValues[0] ?? (nameIdText.includes("@") ? nameIdText : undefined);
  // Group mapping runs only when attrGroups is configured: an empty setting
  // (misconfiguration) must never wipe SAML-sourced memberships by treating
  // the assertion as group-less. When configured, an assertion that omits
  // the attribute synchronizes an empty set so stale memberships are pruned.
  const attrGroupsConfigured = settings.attrGroups !== null && settings.attrGroups !== "";
  const groups = attrGroupsConfigured
    ? namedAttribute(attributesList, settings.attrGroups).flatMap((value): string[] =>
        value.split(",").map((part): string => part.trim()).filter((part): boolean => part !== "")
      )
    : [];
  const siteAdminMatches = settings.attrSiteAdmin !== null && settings.attrSiteAdmin !== ""
    && namedAttribute(attributesList, settings.attrSiteAdmin).includes(settings.siteAdminRole);
  const linkByEmailEnabled = (await getSettings("saml"))["link-by-email"] === true;

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
        allowEmailLinking: linkByEmailEnabled && attrEmailConfigured,
      });
    } catch (error: unknown) {
      if (error instanceof SsoConflictError) {
        await auditLog("sso-conflict", "saml", null, null, null, { username: error.username });
        return reject(error.message, 409);
      }
      throw error;
    }
    let user = result.user;

    // Do not synchronize groups or elevate a suspended, provisional, or
    // tombstoned account while processing a signed assertion. Those writes must
    // never happen before the account-availability check.
    if (isUserLoginBlocked(user)) {
      await auditLog("sso-failure", "saml", user.id, user.id, null, { reason: "account is suspended, provisional, or deleted" });
      return reject("This account is not available.", 403);
    }

    if (attrGroupsConfigured) {
      await syncSamlGroupMappings(user.id, groups);
    }    // The site-admin attribute is authoritative in both directions: matching
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
    const refreshedUser = await db.query.users.findFirst({ where: eq(users.id, user.id) });
    if (refreshedUser === undefined) {
      (set as { status: number }).status = 500;
      return reject("The signed-in account is unavailable.", 500);
    }
    user = refreshedUser;
    if (isUserLoginBlocked(user)) {
      await auditLog("sso-failure", "saml", user.id, user.id, null, { reason: "account is suspended or deleted" });
      return reject("This account is not available.", 403);
    }

    const tokenTtlMs = typeof settings.ssoApiTokenSessionTimeout === "number" && settings.ssoApiTokenSessionTimeout > 0
      ? settings.ssoApiTokenSessionTimeout * 1000
      : DEFAULT_SSO_API_TOKEN_TTL_MS;
    const wantsTokenResponse = issuedTokenResponse;
    const session = await issueSsoLogin(user, { set, request, server }, {
      tokenTtlMs,
      wantsToken: wantsTokenResponse,
    });
    await auditLog("sso-login", "saml", user.id, user.id, null, { username: user.username });

    // The browser-session refresh cookie is written into set.headers by
    // issueLoginSession; attach it to the HTML response we return.
    const respond = (body: string, status = 200): Response => {
      const response = ssoHtmlResponse(body, status);
      appendSetCookies(response, set.headers["Set-Cookie"]);
      clearSamlStateCookie(request, response, server);
      return response;
    };

    const sessionToken = sessionTokenValue(session);
    if (wantsTokenResponse) {
      if (sessionToken === null) {
        await auditLog("sso-failure", "saml", user.id, user.id, null, { reason: "SSO token response was malformed" });
        return respond(ssoHtmlPage("SAML SSO", "The sign-in token could not be issued.", { error: true }), 500);
      }
      const response = Response.json(session, {
        headers: {
          "Cache-Control": "no-store",
          "Content-Type": "application/vnd.api+json",
        },
      });
      appendSetCookies(response, set.headers["Set-Cookie"]);
      clearSamlStateCookie(request, response, server);
      return response;
    }
    return respond(ssoHtmlPage("SAML SSO", "You are signed in.", { redirectUrl: "/app" }));
  })
  .get("/users/saml/slo", async ({ set, request, query }: {
    set: SetObj;
    request: RequestInfo;
    query: Readonly<Record<string, unknown>>;
  }): Promise<unknown> => {
    const settings = await currentSamlSettings();
    const samlRequest = typeof query["SAMLRequest"] === "string" ? query["SAMLRequest"] : "";
    if (samlRequest !== "") {
      const relayState = typeof query["RelayState"] === "string" ? query["RelayState"] : undefined;
      return handleIdpInitiatedLogout(samlRequest, relayState, settings, request, set);
    }
    // The IdP's response to an SP-initiated redirect binding completes at the
    // same endpoint. Local logout already happened before the request, so
    // just finish in the application instead of starting another request.
    if (typeof query["SAMLResponse"] === "string" && query["SAMLResponse"] !== "") {
      const response = new Response(null, { status: 302, headers: { "Cache-Control": "no-store", Location: "/app" } });
      appendSetCookies(response, set.headers["Set-Cookie"]);
      return response;
    }
    if (!isApplicationLogoutRequest(request)) return new Response("Invalid SAML logout request", {
      status: 400,
      headers: { "Cache-Control": "no-store", "Content-Type": "text/plain; charset=utf-8" },
    });
    const sessionUser = await browserSessionUser(request);
    const samlSessionUser = sessionUser?.ssoProvider === "saml" ? sessionUser : null;
    const nameId = samlSessionUser?.ssoSubject ?? null;
    // Terminate the local session regardless of the IdP's availability.
    await revokeBrowserSession(set, request);
    if (settings.enabled && settings.sloEndpointUrl !== null && samlSessionUser !== null && nameId !== null && nameId !== "") {
      // Send SP-initiated logout to the IdP so the session is ended on both
      // sides. The IdP acknowledges via its own LogoutResponse; we do not
      // block the local redirect on it.
      const requestId = `_${randomBytes(16).toString("hex")}`;
      let logoutRequest: string;
      try {
        logoutRequest = logoutRequestXml(samlSpEntityId(request), settings.sloEndpointUrl, requestId, nameId);
      } catch {
        const response = new Response(null, {
          status: 302,
          headers: { "Cache-Control": "no-store", Location: "/app" },
        });
        appendSetCookies(response, set.headers["Set-Cookie"]);
        return response;
      }
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
      await auditLog("sso-logout", "saml", samlSessionUser.id, samlSessionUser.id, null, {
        reason: "SP-initiated",
        signed: false,
      });
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
    const logoutRequestRaw = typeof form["SAMLRequest"] === "string"
      ? form["SAMLRequest"]
      : typeof query["SAMLRequest"] === "string"
        ? query["SAMLRequest"]
        : "";
    const relayState = typeof form["RelayState"] === "string"
      ? form["RelayState"]
      : typeof query["RelayState"] === "string" ? query["RelayState"] : undefined;
    return handleIdpInitiatedLogout(logoutRequestRaw, relayState, settings, request, set);
  });
