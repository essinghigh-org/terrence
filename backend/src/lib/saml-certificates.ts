import { X509Certificate, createHash } from "node:crypto";
import { eq } from "drizzle-orm";
import { db } from "../db";
import { adminSettings } from "../db/schema";

// Public certificates, not private keys. Keep the collection in the existing
// cross-database JSON settings store; all writers hold the auth-settings lock.
export const SAML_CERTIFICATES_KEY = "saml-idp-certificates";
export type SamlCertificate = Readonly<{
  id: string;
  legacy?: boolean;
  name: string;
  cert: string;
  createdAt: number;
  updatedAt: number;
}>;
export async function storedSamlCertificates(): Promise<SamlCertificate[]> {
  const row = await db.query.adminSettings.findFirst({ where: eq(adminSettings.id, SAML_CERTIFICATES_KEY) });
  return (row?.values["certificates"] ?? []) as SamlCertificate[];
}
export async function saveSamlCertificates(certificates: readonly SamlCertificate[]): Promise<void> {
  const values = { certificates };
  await db
    .insert(adminSettings)
    .values({ id: SAML_CERTIFICATES_KEY, values, updatedAt: Date.now() })
    .onConflictDoUpdate({ target: adminSettings.id, set: { values, updatedAt: Date.now() } });
}
export function certificateId(cert: string): string {
  let bytes: string | Buffer = cert;
  try {
    bytes = new X509Certificate(cert).raw;
  } catch {
    /* Existing legacy settings may contain invalid PEM. */
  }
  return `idpc-${createHash("sha256").update(bytes).digest("hex").slice(0, 32)}`;
}
export type LegacySamlCertificates = Readonly<{ idpCert: string | null; oldIdpCert: string | null; updatedAt: number }>;
export async function samlCertificateCollection(
  settings: LegacySamlCertificates,
): Promise<(SamlCertificate & { role: string })[]> {
  const stored = await storedSamlCertificates();
  const legacy = [
    { cert: settings.idpCert, role: "legacy_primary", name: "Legacy primary certificate" },
    { cert: settings.oldIdpCert, role: "legacy_old", name: "Legacy old certificate" },
  ].filter((item): item is { cert: string; role: string; name: string } => Boolean(item.cert));
  const legacyIds = new Set(legacy.map((item) => certificateId(item.cert)));
  return [
    ...legacy.map((item) => {
      const id = certificateId(item.cert);
      const metadata = stored.find((c) => c.id === id);
      return {
        id,
        cert: item.cert,
        role: item.role,
        name: metadata?.name ?? item.name,
        createdAt: metadata?.createdAt ?? settings.updatedAt,
        updatedAt: metadata?.updatedAt ?? settings.updatedAt,
      };
    }),
    ...stored.filter((c) => !legacyIds.has(c.id) && !c.legacy).map((c) => ({ ...c, role: "managed" })),
  ];
}
export async function trustedSamlCertificates(settings: LegacySamlCertificates): Promise<string[]> {
  return (await samlCertificateCollection(settings)).map((item) => item.cert);
}
export function samlCertificateResource(item: SamlCertificate & Readonly<{ role: string }>): unknown {
  let certificate: X509Certificate | undefined;
  try {
    certificate = new X509Certificate(item.cert);
  } catch {
    /* Legacy settings remain readable. */
  }
  return {
    type: "saml-idp-certificates",
    id: item.id,
    attributes: {
      "display-name": item.name,
      cert: item.cert,
      fingerprint: certificate?.fingerprint256 ?? "",
      "expires-at": certificate ? new Date(certificate.validTo).toISOString() : "",
      "created-at": new Date(item.createdAt).toISOString(),
      issuer: certificate?.issuer ?? "",
      "cert-role": item.role,
    },
  };
}
