// Shared helpers for SAML flow tests: build and sign SAMLResponse documents
// with the same xml-crypto pipeline the service provider uses for
// verification, guaranteeing byte-compatible canonicalization.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { inflateRawSync } from "node:zlib";
import { SignedXml } from "xml-crypto";

export const IDP_CERT = readFileSync(join(import.meta.dir, "../fixtures/idp-cert.pem"), "utf8");
export const IDP_KEY = readFileSync(join(import.meta.dir, "../fixtures/idp-key.pem"), "utf8");
export const IDP_OLD_CERT = readFileSync(join(import.meta.dir, "../fixtures/idp-old-cert.pem"), "utf8");
export const IDP_OLD_KEY = readFileSync(join(import.meta.dir, "../fixtures/idp-old-key.pem"), "utf8");

export const ACS_URL = "http://terrence.test/users/saml/auth";
export const ENTITY_ID = "http://terrence.test/users/saml/metadata";
export const IDP_ENTITY_ID = "http://idp.example.test/metadata";

export type SamlResponseOptions = Readonly<{
  /** Destination attribute on the Response/Assertion. */
  destination?: string;
  recipient?: string;
  audience?: string;
  inResponseTo?: string;
  issuer?: string;
  nameId?: string;
  username?: string;
  email?: string;
  groups?: string[];
  notBefore?: string;
  notOnOrAfter?: string;
  siteAdmin?: string;
  privateKey?: string;
  publicCert?: string;
  /** Attribute map merged into the AttributeStatement. */
  attributes?: Record<string, string | string[]>;
}>;

function iso(offsetSeconds: number): string {
  return new Date(Date.now() + offsetSeconds * 1000).toISOString();
}

function escapeXml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&apos;");
}

function serializedAttribute(name: string, values: string | string[]): string {
  const list = Array.isArray(values) ? values : [values];
  const rendered = list
    .map((value): string => `<saml:AttributeValue>${escapeXml(value)}</saml:AttributeValue>`)
    .join("");
  return `<saml:Attribute Name="${escapeXml(name)}">${rendered}</saml:Attribute>`;
}

/** Build a self-consistent, signed SAMLResponse as base64. */
export function buildSignedSamlResponse(options: SamlResponseOptions = {}): string {
  const {
    destination = ACS_URL,
    recipient = ACS_URL,
    audience = ENTITY_ID,
    inResponseTo,
    issuer = IDP_ENTITY_ID,
    nameId = options.username ?? "alice",
    username = "alice",
    email = "alice@example.com",
    groups = [],
    notBefore = iso(-60),
    notOnOrAfter = iso(600),
    siteAdmin,
    privateKey = IDP_KEY,
    publicCert = IDP_CERT,
    attributes = {},
  } = options;

  const now = iso(0);
  const responseId = `_response_${crypto.randomUUID().replaceAll("-", "")}`;
  const assertionId = `_assertion_${crypto.randomUUID().replaceAll("-", "")}`;
  const attributeXml = [
    serializedAttribute("Username", username),
    serializedAttribute("email", email),
    ...(groups.length > 0 ? [serializedAttribute("MemberOf", groups)] : []),
    ...(siteAdmin !== undefined ? [serializedAttribute("SiteAdmin", siteAdmin)] : []),
    ...Object.entries(attributes).map(([name, values]): string => serializedAttribute(name, values)),
  ].join("");

  const responseXml = `<?xml version="1.0" encoding="UTF-8"?>
<samlp:Response xmlns:samlp="urn:oasis:names:tc:SAML:2.0:protocol" xmlns:saml="urn:oasis:names:tc:SAML:2.0:assertion" xmlns:ds="http://www.w3.org/2000/09/xmldsig#" ID="${responseId}" Version="2.0" IssueInstant="${now}" Destination="${destination}">
  <saml:Issuer>${issuer}</saml:Issuer>
  <samlp:Status>
  <samlp:StatusCode Value="urn:oasis:names:tc:SAML:2.0:status:Success"/>
  </samlp:Status>
  <saml:Assertion Version="2.0" ID="${assertionId}" IssueInstant="${now}">
    <saml:Issuer>${issuer}</saml:Issuer>
    <saml:Subject>
      <saml:NameID>${nameId}</saml:NameID>
      <saml:SubjectConfirmation Method="urn:oasis:names:tc:SAML:2.0:cm:bearer">
        <saml:SubjectConfirmationData Recipient="${recipient}" NotOnOrAfter="${notOnOrAfter}"${inResponseTo === undefined ? "" : ` InResponseTo="${inResponseTo}"`}/>
      </saml:SubjectConfirmation>
    </saml:Subject>
    <saml:Conditions NotBefore="${notBefore}" NotOnOrAfter="${notOnOrAfter}">
      <saml:AudienceRestriction>
        <saml:Audience>${audience}</saml:Audience>
      </saml:AudienceRestriction>
    </saml:Conditions>
    <saml:AttributeStatement>
      ${attributeXml}
    </saml:AttributeStatement>
  </saml:Assertion>
</samlp:Response>
`;

  const signed = new SignedXml({
    privateKey,
    publicCert,
    signatureAlgorithm: "http://www.w3.org/2001/04/xmldsig-more#rsa-sha256",
    canonicalizationAlgorithm: "http://www.w3.org/2001/10/xml-exc-c14n#",
  });
  signed.addReference({
    xpath: "//*[local-name()='Assertion']",
    transforms: [
      "http://www.w3.org/2000/09/xmldsig#enveloped-signature",
      "http://www.w3.org/2001/10/xml-exc-c14n#",
    ],
    digestAlgorithm: "http://www.w3.org/2001/04/xmlenc#sha256",
    uri: `#${assertionId}`,
  });
  signed.computeSignature(responseXml, {
    location: { reference: "//*[local-name()='Assertion']", action: "append" },
  });
  return Buffer.from(signed.getSignedXml(), "utf8").toString("base64");
}

/** Build a signed IdP-initiated LogoutRequest as base64. */
export function buildSignedLogoutRequest(nameId = "slo-user"): string {
  const now = new Date().toISOString();
  const requestId = `_logout_${crypto.randomUUID().replaceAll("-", "")}`;
  const logoutXml = `<?xml version="1.0" encoding="UTF-8"?>
<samlp:LogoutRequest xmlns:samlp="urn:oasis:names:tc:SAML:2.0:protocol" xmlns:saml="urn:oasis:names:tc:SAML:2.0:assertion" xmlns:ds="http://www.w3.org/2000/09/xmldsig#" ID="${requestId}" Version="2.0" IssueInstant="${now}">
  <saml:Issuer>http://idp.example.test/metadata</saml:Issuer>
  <saml:NameID Format="urn:oasis:names:tc:SAML:1.1:nameid-format:unspecified">${nameId}</saml:NameID>
</samlp:LogoutRequest>
`;
  const signed = new SignedXml({
    privateKey: IDP_KEY,
    publicCert: IDP_CERT,
    signatureAlgorithm: "http://www.w3.org/2001/04/xmldsig-more#rsa-sha256",
    canonicalizationAlgorithm: "http://www.w3.org/2001/10/xml-exc-c14n#",
  });
  signed.addReference({
    xpath: "//*[local-name()='LogoutRequest']",
    transforms: [
      "http://www.w3.org/2000/09/xmldsig#enveloped-signature",
      "http://www.w3.org/2001/10/xml-exc-c14n#",
    ],
    digestAlgorithm: "http://www.w3.org/2001/04/xmlenc#sha256",
    uri: `#${requestId}`,
  });
  signed.computeSignature(logoutXml, {
    location: { reference: "//*[local-name()='LogoutRequest']", action: "append" },
  });
  return Buffer.from(signed.getSignedXml(), "utf8").toString("base64");
}

/** Inflate a base64 DEFLATE-encoded SAMLRequest from the redirect binding. */
export function inflateAndDecode(value: string): string {
  const compressed = Buffer.from(value.replaceAll(" ", "+"), "base64");
  return inflateRawSync(compressed).toString("utf8");
}

/** Build a form-encoded POST request to the ACS endpoint. */
export function samlAcsRequest(samlResponse: string, relayState?: string): Request {
  const params = new URLSearchParams({ SAMLResponse: samlResponse });
  if (relayState !== undefined) params.set("RelayState", relayState);
  return new Request("http://terrence.test/users/saml/auth", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: params.toString(),
  });
}
