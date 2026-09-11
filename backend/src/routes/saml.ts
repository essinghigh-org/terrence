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

function logoutRequestFields(request: DomElement | null): { requestId: string; nameId: string; issuer: string; destination: string; issueInstant: string } {
  return {
    requestId: request?.getAttribute("ID") ?? "",
    nameId: request?.getElementsByTagNameNS("*", "NameID").item(0)?.textContent?.trim() ?? "",
    issuer: request?.getElementsByTagNameNS("*", "Issuer").item(0)?.textContent?.trim() ?? "",
    destination: request?.getAttribute("Destination") ?? "",
    issueInstant: request?.getAttribute("IssueInstant") ?? "",
  };
}

function logoutSignedRequestMatches(signedXml: string, requestId: string, nameId: string): boolean {
  const signedDoc = new DOMParser({ errorHandler: (): void => undefined })
    .parseFromString(signedXml, "text/xml");
  const signedRequests = signedDoc.getElementsByTagNameNS("*", "LogoutRequest");
  const signedRequest = signedRequests.length === 1 ? signedRequests.item(0) : null;
  if (signedRequest === null || signedRequest.getAttribute("ID") !== requestId) return false;
  const signedNameId = signedRequest.getElementsByTagNameNS("*", "NameID").item(0)?.textContent?.trim() ?? "";
  return signedNameId === nameId;
}

function verifyLogoutSignatureWithCert(args: {
  xml: string;
  certificate: string;
  signatureElement: DomElement;
  requestId: string;
  nameId: string;
}): boolean {
  try {
    const signed = new SignedXml();
    signed.getCertFromKeyInfo = (): string => pemCertificate(args.certificate);
    signed.loadSignature(args.signatureElement as unknown as Parameters<SignedXml["loadSignature"]>[0]);
    if (!supportedXmlSignature(signed)) return false;
    if (!signed.checkSignature(args.xml)) return false;
    const references = signed.getReferences();
    if (references.length !== 1 || (references[0] as { uri?: string }).uri?.replace(/^#/, "") !== args.requestId) return false;
    const signedReferences = signed.getSignedReferences();
    if (signedReferences.length !== 1 || signedReferences[0] === undefined) return false;
    return logoutSignedRequestMatches(signedReferences[0], args.requestId, args.nameId);
  } catch {
    // Try the next certificate (e.g. the old cert during rotation).
    return false;
  }
}

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
  const fields = logoutRequestFields(requests.item(0));
  if (fields.requestId === "") return { valid: false, error: "SAML logout request has no request ID" };
  if (fields.nameId === "") return { valid: false, error: "SAML logout request has no NameID" };
  if (redirectBinding) return { valid: true, error: "", ...fields };
  const signatureElement = doc.getElementsByTagNameNS("*", "Signature").item(0);
  if (signatureElement === null) return { valid: false, error: "SAML logout request is not signed" };
  for (const certificate of certificates) {
    if (verifyLogoutSignatureWithCert({ xml, certificate, signatureElement, requestId: fields.requestId, nameId: fields.nameId })) {
      return { valid: true, error: "", ...fields };
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

function parseSamlAssertionNode(xml: string): { doc: ReturnType<DOMParser["parseFromString"]>; assertionNode: DomElement } {
  let doc: ReturnType<DOMParser["parseFromString"]>;
  try {
    doc = new DOMParser({ errorHandler: (): void => undefined })
      .parseFromString(xml, "text/xml");
  } catch {
    throw new SamlAuthError(400, "SAML response is not valid XML");
  }
  // Exactly one SignedXml reference, and it must resolve to the assertion we
  // consume. Multiple references, no reference, or a reference to something
  // other than the assertion are all rejected — this is the core defense
  // against wrapping attacks.
  const assertions = doc.getElementsByTagNameNS("*", "Assertion");
  if (assertions.length !== 1) {
    throw new SamlAuthError(400, "SAML response must contain exactly one Assertion element");
  }
  const assertionNode = assertions.item(0);
  if (assertionNode === null) {
    throw new SamlAuthError(400, "SAML response must contain exactly one Assertion element");
  }
  return { doc, assertionNode };
}

function collectSignatureNodes(doc: ReturnType<DOMParser["parseFromString"]>): DomElement[] {
  const signatureNodes = doc.getElementsByTagNameNS("*", "Signature");
  if (signatureNodes.length === 0) throw new SamlAuthError(400, "SAML response is not signed");
  // An attacker can stuff a document with signature elements to exhaust CPU;
  // the single verified signature is all the flow ever needs.
  if (signatureNodes.length > MAX_SAML_SIGNATURE_NODES) {
    throw new SamlAuthError(400, "SAML response contains too many signatures");
  }
  const out: DomElement[] = [];
  for (let index = 0; index < signatureNodes.length; index += 1) {
    const node = signatureNodes.item(index);
    if (node !== null) out.push(node);
  }
  return out;
}

function tryVerifyAssertionSignature(args: {
  xml: string;
  certificate: string;
  signatureElement: DomElement;
  assertionId: string | null;
}): string | null {
  try {
    const signed = new SignedXml();
    signed.getCertFromKeyInfo = (): string => pemCertificate(args.certificate);
    signed.loadSignature(args.signatureElement as unknown as Parameters<SignedXml["loadSignature"]>[0]);
    if (!supportedXmlSignature(signed)) return null;
    if (!signed.checkSignature(args.xml)) return null;
    const references = signed.getReferences();
    // The references type from xml-crypto exposes `uri`; tolerate shaped
    // variants without losing type-safety.
    const uris = references.map((ref): string => (ref as { uri?: string }).uri ?? "");
    if (uris.length !== 1) return null;
    const uri = uris[0]?.replace(/^#/, "") ?? "";
    if (uri === "") return null;
    if (args.assertionId !== uri) return null;
    const signedReferences = signed.getSignedReferences();
    if (signedReferences.length !== 1 || signedReferences[0] === undefined) return null;
    // The signature covers exactly the assertion we will consume.
    return signedReferences[0];
  } catch {
    // Try the next signature and certificate (e.g. during rotation).
    return null;
  }
}

function signedAssertionResult(
  xml: string,
  certificates: readonly string[],
): SignedAssertionResult {
  try {
    if (certificates.length === 0) {
      throw new SamlAuthError(400, "No IdP certificate configured");
    }
    const { doc, assertionNode } = parseSamlAssertionNode(xml);
    const signatureElements = collectSignatureNodes(doc);
    const assertionId = assertionNode.getAttribute("ID");
    for (const signatureElement of signatureElements) {
      for (const certificate of certificates) {
        const assertionXml = tryVerifyAssertionSignature({ xml, certificate, signatureElement, assertionId });
        if (assertionXml !== null) return { valid: true, error: "", assertionXml };
      }
    }
    return { valid: false, error: "SAML signature verification failed" };
  } catch (error: unknown) {
    if (error instanceof SamlAuthError) return { valid: false, error: error.message };
    throw error;
  }
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

function resolveLogoutUrls(request: RequestInfo): { expectedSloUrl: string; expectedLogoutEndpointUrl: string; entityId: string } {
  try {
    return {
      expectedSloUrl: sloUrl(request),
      expectedLogoutEndpointUrl: logoutEndpointUrl(request),
      entityId: samlSpEntityId(request),
    };
  } catch {
    throw new SamlAuthError(502, "SAML SSO is misconfigured. PUBLIC_URL must be configured.");
  }
}

function decodeLogoutXml(rawRequest: string): string {
  if (rawRequest === "") throw new SamlAuthError(400, "Invalid SAML logout request");
  try {
    return decodeSamlMessage(rawRequest);
  } catch {
    throw new SamlAuthError(400, "Invalid SAML logout request");
  }
}

async function verifyLogoutRequestSignatures(args: {
  request: RequestInfo;
  xml: string;
  rawRequest: string;
  certificates: readonly string[];
}): Promise<{ nameId: string; requestId: string; issuer?: string | undefined; destination?: string | undefined; issueInstant?: string | undefined }> {
  const redirectSignature = verifyRedirectLogoutSignature(args.request, args.certificates, args.rawRequest);
  if (redirectSignature.present && !redirectSignature.valid) {
    await auditLog("sso-failure", "saml", null, null, null, { reason: "SAML redirect signature verification failed" });
    throw new SamlAuthError(400, "Invalid SAML logout request signature");
  }
  const verifiedLogout = verifyLogoutSignature(args.xml, args.certificates, redirectSignature.present);
  if (!verifiedLogout.valid || verifiedLogout.nameId === undefined || verifiedLogout.requestId === undefined) {
    await auditLog("sso-failure", "saml", null, null, null, { reason: verifiedLogout.error });
    throw new SamlAuthError(400, "Invalid SAML logout request signature");
  }
  return {
    nameId: verifiedLogout.nameId,
    requestId: verifiedLogout.requestId,
    issuer: verifiedLogout.issuer,
    destination: verifiedLogout.destination,
    issueInstant: verifiedLogout.issueInstant,
  };
}

async function assertLogoutFreshness(issueInstant: string | undefined): Promise<void> {
  // The IssueInstant must be present and within the clock-skew window: a
  // stale or future-dated LogoutRequest is not worth acting on.
  const issueInstantMs = issueInstant !== undefined ? Date.parse(issueInstant) : Number.NaN;
  if (Number.isNaN(issueInstantMs) || Math.abs(Date.now() - issueInstantMs) > TIME_SKEW_MS) {
    await auditLog("sso-failure", "saml", null, null, null, { reason: "SAML logout request issue instant out of range" });
    throw new SamlAuthError(400, "Invalid SAML logout request");
  }
}

async function assertLogoutAudience(
  logout: { issuer?: string | undefined; destination?: string | undefined },
  settings: SamlRow,
  expectedSloUrl: string,
  expectedLogoutEndpointUrl: string,
): Promise<void> {
  // The LogoutRequest must name this IdP and target one of this SP's SLO
  // endpoints; otherwise the session must not be revoked on its authority.
  if (logout.issuer === undefined || logout.issuer === ""
    || logout.issuer !== settings.idpEntityId
    || logout.destination === undefined || logout.destination === ""
    || (logout.destination !== expectedSloUrl && logout.destination !== expectedLogoutEndpointUrl)) {
    await auditLog("sso-failure", "saml", null, null, null, { reason: "SAML logout request issuer or destination mismatch" });
    throw new SamlAuthError(400, "Invalid SAML logout request");
  }
}

async function claimLogoutRequest(requestId: string): Promise<void> {
  if (!(await claimSsoChallenge(
    SAML_LOGOUT_CHALLENGE_KIND,
    requestId,
    {},
    Date.now() + PENDING_AUTHNREQUEST_TTL_MS,
  ))) {
    await auditLog("sso-failure", "saml", null, null, null, { reason: "SAML logout request replayed" });
    throw new SamlAuthError(400, "SAML logout request has already been used");
  }
}

async function revokeMismatchedSession(args: {
  request: RequestInfo;
  set: SetObj;
  nameId: string;
}): Promise<boolean> {
  const sessionUser = await browserSessionUser(args.request);
  const subjectMatches = sessionUser?.ssoProvider === "saml" && sessionUser.ssoSubject === args.nameId;
  if (!subjectMatches) {
    await auditLog("sso-failure", "saml", null, sessionUser?.id ?? null, null, { reason: "logout NameID does not match session" });
  } else if (sessionUser !== null) {
    await revokeBrowserSession(args.set, args.request);
    await auditLog("sso-logout", "saml", sessionUser.id, sessionUser.id, null, { reason: "IdP-initiated" });
  }
  return subjectMatches;
}

function logoutRedirectTarget(args: {
  settings: SamlRow;
  entityId: string;
  requestId: string;
  subjectMatches: boolean;
  relayState: string | undefined;
  set: SetObj;
}): Response {
  if (args.settings.sloEndpointUrl === null) {
    const response = new Response(null, { status: 302, headers: { "Cache-Control": "no-store", Location: "/app" } });
    appendSetCookies(response, args.set.headers["Set-Cookie"]);
    return response;
  }
  let target: URL;
  try {
    target = new URL(args.settings.sloEndpointUrl);
  } catch {
    const response = new Response(null, { status: 302, headers: { "Cache-Control": "no-store", Location: "/app" } });
    appendSetCookies(response, args.set.headers["Set-Cookie"]);
    return response;
  }
  // A LogoutRequest whose NameID does not match the local session cannot
  // count as a full logout: report PartialLogout per SAML 2.0 so the IdP
  // does not consider the session terminated on this SP.
  target.searchParams.set("SAMLResponse", encodeRedirect(logoutResponseXml(args.entityId, args.requestId, args.subjectMatches)));
  if (args.relayState !== undefined) target.searchParams.set("RelayState", args.relayState);
  const response = new Response(null, {
    status: 302,
    headers: { "Cache-Control": "no-store", Location: target.toString() },
  });
  appendSetCookies(response, args.set.headers["Set-Cookie"]);
  return response;
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
  try {
    const { expectedSloUrl, expectedLogoutEndpointUrl, entityId } = resolveLogoutUrls(request);
    const xml = decodeLogoutXml(rawRequest);
    const certificates = [settings.idpCert, settings.oldIdpCert]
      .filter((cert): cert is string => typeof cert === "string" && cert !== "");
    const logout = await verifyLogoutRequestSignatures({ request, xml, rawRequest, certificates });
    await assertLogoutFreshness(logout.issueInstant);
    await assertLogoutAudience(logout, settings, expectedSloUrl, expectedLogoutEndpointUrl);
    await claimLogoutRequest(logout.requestId);
    const subjectMatches = await revokeMismatchedSession({ request, set, nameId: logout.nameId });
    return logoutRedirectTarget({ settings, entityId, requestId: logout.requestId, subjectMatches, relayState, set });
  } catch (error: unknown) {
    if (error instanceof SamlAuthError) {
      if (error.status === 502) {
        return new Response(error.message, {
          status: 502,
          headers: { "Cache-Control": "no-store", "Content-Type": "text/plain; charset=utf-8" },
        });
      }
      return invalid(error.message);
    }
    throw error;
  }
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

class SamlAuthError extends Error {
  constructor(public status: number, message: string) {
    super(message);
  }
}

function parseSamlCallbackInput(
  body: unknown,
  query: Readonly<Record<string, unknown>>,
): { samlResponse: string; relayState: string | null } {
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
    throw new SamlAuthError(400, "Missing SAMLResponse.");
  }
  return { samlResponse, relayState };
}

function decodeSamlXml(samlResponse: string): string {
  try {
    return decodeSamlMessage(samlResponse);
  } catch {
    throw new SamlAuthError(400, "The SAML response could not be decoded.");
  }
}

function parseSamlResponseDocument(xml: string): DomElement {
  let responseDoc: ReturnType<DOMParser["parseFromString"]>;
  try {
    responseDoc = new DOMParser({ errorHandler: (): void => undefined }).parseFromString(xml, "text/xml");
  } catch {
    throw new SamlAuthError(400, "The SAML response could not be parsed.");
  }
  const responseElement = domElement(responseDoc, "Response");
  if (responseElement === null) {
    throw new SamlAuthError(400, "The SAML response could not be parsed.");
  }
  return responseElement;
}

async function assertSamlSuccessStatus(responseElement: DomElement): Promise<void> {
  // Reject an explicitly failed response. Status is outside an
  // assertion-only signature, so the signed assertion below remains the
  // authentication gate when the IdP does not sign the Response element.
  const statusCode = domElement(responseElement, "StatusCode")?.getAttribute("Value") ?? "";
  if (statusCode !== SAML_SUCCESS_STATUS) {
    await auditLog("sso-failure", "saml", null, null, null, { reason: "non-success status" });
    throw new SamlAuthError(400, "The SAML response reports a failed authentication.");
  }
}

async function verifySamlAssertionSignature(xml: string, settings: SamlRow): Promise<Extract<SignedAssertionResult, { valid: true }>> {
  const certificates = [settings.idpCert, settings.oldIdpCert].filter((cert): cert is string => typeof cert === "string" && cert !== "");
  const signature = signedAssertionResult(xml, certificates);
  if (!signature.valid) {
    await auditLog("sso-failure", "saml", null, null, null, { reason: signature.error });
    throw new SamlAuthError(400, signature.error);
  }
  return signature;
}

function parseVerifiedAssertion(assertionXml: string): DomElement {
  // Parse only the assertion that was actually covered by the verified
  // signature — never the full untrusted document.
  try {
    const verifiedDoc = new DOMParser({ errorHandler: (): void => undefined }).parseFromString(assertionXml, "text/xml");
    const assertion = domElement(verifiedDoc, "Assertion");
    if (assertion === null) throw new Error("no assertion");
    return assertion;
  } catch {
    throw new SamlAuthError(400, "The SAML response contains no assertion.");
  }
}

function assertAssertionAudience(assertionElement: DomElement, entityId: string): void {
  const audiences = domElements(assertionElement, "AudienceRestriction").flatMap((restriction): string[] =>
    domElements(restriction, "Audience").map((audience): string => audience.textContent?.trim() ?? "")
  );
  if (audiences.length === 0 || !audiences.includes(entityId)) {
    throw new SamlAuthError(400, "SAML assertion audience does not match this instance.");
  }
}

function assertAssertionTimeWindow(conditionsElement: DomElement | null, now: number): void {
  const notBefore = conditionsElement?.getAttribute("NotBefore") ?? undefined;
  const notOnOrAfter = conditionsElement?.getAttribute("NotOnOrAfter") ?? undefined;
  const parseInstant = (value: unknown): number | undefined =>
    typeof value === "string" ? Date.parse(value) : undefined;
  const notBeforeMs = parseInstant(notBefore);
  if (notBeforeMs !== undefined && (Number.isNaN(notBeforeMs) || notBeforeMs - TIME_SKEW_MS > now)) {
    throw new SamlAuthError(400, "SAML assertion is not yet valid.");
  }
  const notOnOrAfterMs = parseInstant(notOnOrAfter);
  if (notOnOrAfterMs !== undefined && (Number.isNaN(notOnOrAfterMs) || notOnOrAfterMs + TIME_SKEW_MS < now)) {
    throw new SamlAuthError(400, "SAML assertion has expired.");
  }
}

function assertAssertionConstraints(args: {
  assertionElement: DomElement;
  responseElement: DomElement;
  assertionConsumerService: string;
  entityId: string;
  now: number;
}): string {
  // Reject replays: an assertion whose ID we have already consumed within
  // its validity window is a re-submission of a live assertion.
  const assertionId = args.assertionElement.getAttribute("ID") ?? "";
  if (assertionId === "") {
    throw new SamlAuthError(400, "The SAML assertion has no ID.");
  }
  const responseDestination = args.responseElement.getAttribute("Destination");
  if (typeof responseDestination === "string" && responseDestination !== "" && responseDestination !== args.assertionConsumerService) {
    throw new SamlAuthError(400, "SAML assertion Destination does not match the ACS URL.");
  }
  assertAssertionTimeWindow(domElement(args.assertionElement, "Conditions"), args.now);
  assertAssertionAudience(args.assertionElement, args.entityId);
  return assertionId;
}

function assertSamlIssuer(assertionElement: DomElement, settings: SamlRow): void {
  const assertionIssuerText = domText(assertionElement, "Issuer");
  if (typeof settings.idpEntityId !== "string" || settings.idpEntityId === ""
    || assertionIssuerText !== settings.idpEntityId) {
    throw new SamlAuthError(400, "SAML assertion issuer does not match the configured identity provider.");
  }
}

function resolveBearerSubject(args: {
  assertionElement: DomElement;
  assertionConsumerService: string;
  now: number;
}): { subjectElement: DomElement | null; nameIdText: string; inResponseTo: string } {
  const subjectElement = domElement(args.assertionElement, "Subject");
  const confirmationList = domElements(subjectElement, "SubjectConfirmation");
  const validConfirmation = confirmationList.find((confirmation): boolean => {
    if (confirmation.getAttribute("Method") !== BEARER) return false;
    const data = domElement(confirmation, "SubjectConfirmationData");
    if (data === null) return false;
    const inResponseTo = data.getAttribute("InResponseTo") ?? "";
    const recipient = data.getAttribute("Recipient") ?? "";
    const notOnOrAfter = data.getAttribute("NotOnOrAfter") ?? "";
    if (inResponseTo === "" || recipient !== args.assertionConsumerService || notOnOrAfter === "") return false;
    const expiresAt = Date.parse(notOnOrAfter);
    return !Number.isNaN(expiresAt) && expiresAt + TIME_SKEW_MS >= args.now;
  });
  if (validConfirmation === undefined) {
    throw new SamlAuthError(400, "SAML subject confirmation is invalid or does not match this request.");
  }
  const subjectData = domElement(validConfirmation, "SubjectConfirmationData");
  const inResponseTo = subjectData?.getAttribute("InResponseTo") ?? "";
  const nameIdText = domText(subjectElement, "NameID");
  if (nameIdText === "") {
    throw new SamlAuthError(400, "The SAML assertion contains no NameID.");
  }
  return { subjectElement, nameIdText, inResponseTo };
}

async function assertSamlChallengeBinding(args: {
  request: RequestInfo;
  relayState: string | null;
  inResponseTo: string;
  assertionId: string;
}): Promise<{ issuedTokenResponse: boolean }> {
  if (cookieValue(args.request, SAML_STATE_COOKIE) !== args.inResponseTo) {
    throw new SamlAuthError(400, "SAML response does not match the browser that started this sign-in.");
  }
  const authnChallenge = typeof args.inResponseTo === "string"
    ? await consumeSsoChallenge(SAML_AUTHN_CHALLENGE_KIND, args.inResponseTo)
    : undefined;
  const issuedRelayState = authnChallenge?.["relayState"] === null || typeof authnChallenge?.["relayState"] === "string"
    ? authnChallenge["relayState"]
    : undefined;
  if (issuedRelayState === undefined || issuedRelayState !== args.relayState) {
    throw new SamlAuthError(400, "SAML response does not match an issuance from this instance.");
  }
  const issuedTokenResponse = authnChallenge?.["tokenResponse"] === true;
  if (!(await claimSsoChallenge(
    SAML_ASSERTION_CHALLENGE_KIND,
    args.assertionId,
    {},
    Date.now() + TIME_SKEW_MS + 10 * 60 * 1000,
  ))) {
    throw new SamlAuthError(400, "SAML assertion has already been used.");
  }
  return { issuedTokenResponse };
}

async function resolveSamlIdentity(args: {
  assertionElement: DomElement;
  nameIdText: string;
  settings: SamlRow;
}): Promise<{
  username: string;
  email: string | undefined;
  allowEmailLinking: boolean;
  groups: string[];
  siteAdminMatches: boolean;
  attrGroupsConfigured: boolean;
}> {
  const attributesList = domElements(args.assertionElement, "AttributeStatement")
    .flatMap((statement): SamlAttribute[] => samlAttributes(statement));
  const usernameValues = namedAttribute(attributesList, args.settings.attrUsername);
  const username = usernameValues[0] ?? args.nameIdText;
  // Linking by email must be anchored to an explicitly configured attribute:
  // guessing among well-known names could attach an identity by an attribute
  // the administrator never vetted.
  const attrEmailConfigured = typeof args.settings.attrEmail === "string" && args.settings.attrEmail !== "";
  const emailAttributeNames = attrEmailConfigured
    ? [args.settings.attrEmail]
    : ["email", "mail", "Email", "EmailAddress"];
  const emailValues = emailAttributeNames.flatMap((name): string[] => namedAttribute(attributesList, name));
  const email = emailValues[0] ?? (args.nameIdText.includes("@") ? args.nameIdText : undefined);
  // Group mapping runs only when attrGroups is configured: an empty setting
  // (misconfiguration) must never wipe SAML-sourced memberships by treating
  // the assertion as group-less. When configured, an assertion that omits
  // the attribute synchronizes an empty set so stale memberships are pruned.
  const attrGroupsConfigured = args.settings.attrGroups !== null && args.settings.attrGroups !== "";
  const groups = attrGroupsConfigured
    ? namedAttribute(attributesList, args.settings.attrGroups).flatMap((value): string[] =>
        value.split(",").map((part): string => part.trim()).filter((part): boolean => part !== "")
      )
    : [];
  const siteAdminMatches = args.settings.attrSiteAdmin !== null && args.settings.attrSiteAdmin !== ""
    && namedAttribute(attributesList, args.settings.attrSiteAdmin).includes(args.settings.siteAdminRole);
  const linkByEmailEnabled = (await getSettings("saml"))["link-by-email"] === true;
  return {
    username,
    email,
    allowEmailLinking: linkByEmailEnabled && attrEmailConfigured,
    groups,
    siteAdminMatches,
    attrGroupsConfigured,
  };
}

async function provisionSamlAccount(args: {
  nameIdText: string;
  username: string;
  email: string | undefined;
  allowEmailLinking: boolean;
}) {
  let result: Awaited<ReturnType<typeof provisionSsoUser>>;
  try {
    result = await provisionSsoUser({
      provider: "saml",
      subject: args.nameIdText,
      username: args.username,
      email: args.email ?? null,
      // SAML attribute statements are signed with the IdP assertion, so
      // the operator-controlled directory is the verification authority.
      emailVerified: true,
      allowEmailLinking: args.allowEmailLinking,
    });
  } catch (error: unknown) {
    if (error instanceof SsoConflictError) {
      await auditLog("sso-conflict", "saml", null, null, null, { username: error.username });
      throw new SamlAuthError(409, error.message);
    }
    throw error;
  }
  const user = result.user;
  // Do not synchronize groups or elevate a suspended, provisional, or
  // tombstoned account while processing a signed assertion. Those writes must
  // never happen before the account-availability check.
  if (isUserLoginBlocked(user)) {
    await auditLog("sso-failure", "saml", user.id, user.id, null, { reason: "account is suspended, provisional, or deleted" });
    throw new SamlAuthError(403, "This account is not available.");
  }
  return user;
}

type SamlProvisionedUser = Awaited<ReturnType<typeof provisionSamlAccount>>;

async function syncSamlAccountState(args: {
  user: SamlProvisionedUser;
  settings: SamlRow;
  siteAdminMatches: boolean;
  attrGroupsConfigured: boolean;
  groups: string[];
}) {
  const user = args.user;
  if (args.attrGroupsConfigured) {
    await syncSamlGroupMappings(user.id, args.groups);
  }    // The site-admin attribute is authoritative in both directions: matching
  // promotes, and once an account's admin status is SAML-sourced, losing the
  // role demotes it so the IdP can revoke elevated access. If the attribute
  // is misconfigured (empty `attrSiteAdmin`), we never touch the flag.
  if (args.settings.attrSiteAdmin !== null && args.settings.attrSiteAdmin !== "" && args.settings.siteAdminRole !== "") {
    const noLongerSiteAdmin = user.isSiteAdmin && !args.siteAdminMatches;
    if (args.siteAdminMatches && !user.isSiteAdmin) {
      await db.update(users).set({ isSiteAdmin: true, ssoSiteAdmin: true }).where(eq(users.id, user.id));
      await auditLog("sso-site-admin", "saml", user.id, user.id, null, { username: user.username, role: args.settings.siteAdminRole });
    } else if (noLongerSiteAdmin && user.ssoSiteAdmin) {
      await db.update(users).set({ isSiteAdmin: false, ssoSiteAdmin: false }).where(eq(users.id, user.id));
      await auditLog("sso-site-admin-revoked", "saml", user.id, user.id, null, { username: user.username, role: args.settings.siteAdminRole });
    }
  }
  const refreshedUser = await db.query.users.findFirst({ where: eq(users.id, user.id) });
  if (refreshedUser === undefined) {
    throw new SamlAuthError(500, "The signed-in account is unavailable.");
  }
  if (isUserLoginBlocked(refreshedUser)) {
    await auditLog("sso-failure", "saml", refreshedUser.id, refreshedUser.id, null, { reason: "account is suspended or deleted" });
    throw new SamlAuthError(403, "This account is not available.");
  }
  return refreshedUser;
}

async function completeSamlLogin(args: {
  user: Awaited<ReturnType<typeof syncSamlAccountState>>;
  settings: SamlRow;
  issuedTokenResponse: boolean;
  set: SetObj;
  request: RequestInfo;
  server?: unknown;
}): Promise<unknown> {
  const tokenTtlMs = typeof args.settings.ssoApiTokenSessionTimeout === "number" && args.settings.ssoApiTokenSessionTimeout > 0
    ? args.settings.ssoApiTokenSessionTimeout * 1000
    : DEFAULT_SSO_API_TOKEN_TTL_MS;
  const session = await issueSsoLogin(args.user, { set: args.set, request: args.request, server: args.server }, {
    tokenTtlMs,
    wantsToken: args.issuedTokenResponse,
  });
  await auditLog("sso-login", "saml", args.user.id, args.user.id, null, { username: args.user.username });
  // The browser-session refresh cookie is written into set.headers by
  // issueLoginSession; attach it to the HTML response we return.
  const respond = (body: string, status = 200): Response => {
    const response = ssoHtmlResponse(body, status);
    appendSetCookies(response, args.set.headers["Set-Cookie"]);
    clearSamlStateCookie(args.request, response, args.server);
    return response;
  };
  const sessionToken = sessionTokenValue(session);
  if (args.issuedTokenResponse) {
    if (sessionToken === null) {
      await auditLog("sso-failure", "saml", args.user.id, args.user.id, null, { reason: "SSO token response was malformed" });
      return respond(ssoHtmlPage("SAML SSO", "The sign-in token could not be issued.", { error: true }), 500);
    }
    const response = Response.json(session, {
      headers: {
        "Cache-Control": "no-store",
        "Content-Type": "application/vnd.api+json",
      },
    });
    appendSetCookies(response, args.set.headers["Set-Cookie"]);
    clearSamlStateCookie(args.request, response, args.server);
    return response;
  }
  return respond(ssoHtmlPage("SAML SSO", "You are signed in.", { redirectUrl: "/app" }));
}

function appRedirect(set: SetObj): Response {
  const response = new Response(null, { status: 302, headers: { "Cache-Control": "no-store", Location: "/app" } });
  appendSetCookies(response, set.headers["Set-Cookie"]);
  return response;
}

async function spInitiatedLogoutRedirect(args: {
  settings: SamlRow;
  request: RequestInfo;
  samlSessionUser: { id: string } | null;
  nameId: string | null;
  set: SetObj;
}): Promise<Response | null> {
  if (!(args.settings.enabled && args.settings.sloEndpointUrl !== null && args.samlSessionUser !== null && args.nameId !== null && args.nameId !== "")) {
    return null;
  }
  // Send SP-initiated logout to the IdP so the session is ended on both
  // sides. The IdP acknowledges via its own LogoutResponse; we do not
  // block the local redirect on it.
  const requestId = `_${randomBytes(16).toString("hex")}`;
  let logoutRequest: string;
  try {
    logoutRequest = logoutRequestXml(samlSpEntityId(args.request), args.settings.sloEndpointUrl, requestId, args.nameId);
  } catch {
    return appRedirect(args.set);
  }
  let target: URL;
  try {
    target = new URL(args.settings.sloEndpointUrl);
  } catch {
    return appRedirect(args.set);
  }
  await auditLog("sso-logout", "saml", args.samlSessionUser.id, args.samlSessionUser.id, null, {
    reason: "SP-initiated",
    signed: false,
  });
  target.searchParams.set("SAMLRequest", encodeRedirect(logoutRequest));
  const response = new Response(null, {
    status: 302,
    headers: { "Cache-Control": "no-store", Location: target.toString() },
  });
  appendSetCookies(response, args.set.headers["Set-Cookie"]);
  return response;
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

    try {
      const { samlResponse, relayState } = parseSamlCallbackInput(body, query);
      const xml = decodeSamlXml(samlResponse);
      const responseElement = parseSamlResponseDocument(xml);
      await assertSamlSuccessStatus(responseElement);
      const signature = await verifySamlAssertionSignature(xml, settings);
      const assertionElement = parseVerifiedAssertion(signature.assertionXml);
      const now = Date.now();
      const assertionId = assertAssertionConstraints({ assertionElement, responseElement, assertionConsumerService, entityId, now });

      assertSamlIssuer(assertionElement, settings);
      const { nameIdText, inResponseTo } = resolveBearerSubject({ assertionElement, assertionConsumerService, now });
      const { issuedTokenResponse } = await assertSamlChallengeBinding({ request, relayState, inResponseTo, assertionId });
      const identity = await resolveSamlIdentity({ assertionElement, nameIdText, settings });

      const user = await provisionSamlAccount({ nameIdText, username: identity.username, email: identity.email, allowEmailLinking: identity.allowEmailLinking });
      const activeUser = await syncSamlAccountState({ user, settings, siteAdminMatches: identity.siteAdminMatches, attrGroupsConfigured: identity.attrGroupsConfigured, groups: identity.groups });
      return await completeSamlLogin({ user: activeUser, settings, issuedTokenResponse, set, request, server });
    } catch (error: unknown) {
      if (error instanceof SamlAuthError) return reject(error.message, error.status);
      throw error;
    }
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
      return appRedirect(set);
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
    const spLogout = await spInitiatedLogoutRedirect({ settings, request, samlSessionUser, nameId, set });
    if (spLogout !== null) return spLogout;
    return appRedirect(set);
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
