import { describe, expect, test } from "bun:test";
import {
  CREDENTIAL_DOCTOR_ENDPOINTS,
  credentialDoctorNetworkEndpoint,
  runCredentialDoctor,
  type CredentialDoctorConfiguration,
  type CredentialDoctorRequest,
  type CredentialDoctorRequester,
} from "../../src/lib/credential-doctor";

const token = {
  token: "ephemeral-doctor-token",
  claims: {
    iss: "https://terrence.example",
    aud: "aws.workload.identity",
    sub: "organization:example:credential-doctor",
    iat: Math.floor(Date.now() / 1000),
    exp: Math.floor(Date.now() / 1000) + 300,
  },
} as const;

function response(status: number, body = ""): Response {
  return new Response(body, { status, headers: { "content-type": "application/json" } });
}

function requesterFor(
  handler: (request: CredentialDoctorRequest) => Response | Promise<Response>,
  calls: CredentialDoctorRequest[],
): CredentialDoctorRequester {
  return async (request: CredentialDoctorRequest): Promise<Response> => {
    calls.push(request);
    return handler(request);
  };
}

describe("credential doctor", () => {
  test("runs the AWS read-only exchange and never returns bearer material", async () => {
    const calls: CredentialDoctorRequest[] = [];
    const aws = { provider: "aws", values: { "role-arn": "arn:aws:iam::123456789012:role/doctor" } } as const satisfies CredentialDoctorConfiguration;
    const result = await runCredentialDoctor(aws, token, requesterFor((request) => {
      if (request.method === "HEAD") return response(200);
      if (request.body?.includes("AssumeRoleWithWebIdentity") === true) {
        return response(200, "<AssumeRoleWithWebIdentityResponse><Credentials><AccessKeyId>AKIA</AccessKeyId><SecretAccessKey>secret</SecretAccessKey><SessionToken>session</SessionToken></Credentials></AssumeRoleWithWebIdentityResponse>");
      }
      return response(200, "<GetCallerIdentityResponse><GetCallerIdentityResult><Account>123456789012</Account><Arn>arn:aws:iam::123456789012:role/doctor</Arn><UserId>doctor</UserId></GetCallerIdentityResult></GetCallerIdentityResponse>");
    }, calls));

    expect(result.status).toBe("warning");
    expect(result.checks.map((check) => [check.name, check.status])).toEqual([
      ["token_issuance", "passed"],
      ["trust", "warning"],
      ["network_reachability", "passed"],
      ["provider_access", "passed"],
    ]);
    expect(result.identity).toEqual({ account: "123456789012", arn: "arn:aws:iam::123456789012:role/doctor", user_id: "doctor" });
    expect(JSON.stringify(result)).not.toContain("ephemeral-doctor-token");
    expect(calls.some((call) => call.body?.includes("WebIdentityToken=ephemeral-doctor-token") === true)).toBeTrue();
  });

  test("keeps provider permission denial separate from trust failure", async () => {
    const calls: CredentialDoctorRequest[] = [];
    const gcp = {
      provider: "gcp",
      values: { "workload-identity-provider-id": "projects/123/locations/global/workloadIdentityPools/pool/providers/provider" },
    } as const satisfies CredentialDoctorConfiguration;
    const gcpToken = { ...token, claims: { ...token.claims, aud: gcp.values["workload-identity-provider-id"] } };
    const result = await runCredentialDoctor(gcp, gcpToken, requesterFor((request) => {
      if (request.method === "HEAD") return response(204);
      if (request.url === CREDENTIAL_DOCTOR_ENDPOINTS.gcpSts) return response(200, JSON.stringify({ access_token: "provider-access-token" }));
      return response(403, JSON.stringify({ error: { code: "PERMISSION_DENIED" } }));
    }, calls));

    expect(result.status).toBe("failed");
    expect(result.checks.find((check) => check.name === "provider_access")).toMatchObject({ status: "failed", code: "provider_permission_denied" });
    expect(result.identity).toBeNull();
  });

  test("reports DNS failures at reachability and does not attempt provider access", async () => {
    const calls: CredentialDoctorRequest[] = [];
    const azure = { provider: "azure", values: { identity: "client-id", "tenant-id": "tenant", "subscription-id": "subscription" } } as const satisfies CredentialDoctorConfiguration;
    const result = await runCredentialDoctor(azure, { ...token, claims: { ...token.claims, aud: "azure.workload.identity" } }, requesterFor(() => {
      throw new Error("getaddrinfo ENOTFOUND login.microsoftonline.com");
    }, calls));

    expect(result.status).toBe("failed");
    expect(result.checks.find((check) => check.name === "network_reachability")).toMatchObject({ status: "failed", code: "dns_failure" });
    expect(result.checks.find((check) => check.name === "provider_access")).toMatchObject({ status: "skipped", code: "dns_failure" });
    expect(calls).toHaveLength(1);
  });

  test("classifies an Azure federated trust rejection distinctly", async () => {
    const azure = { provider: "azure", values: { identity: "client-id", "tenant-id": "tenant", "subscription-id": "subscription" } } as const satisfies CredentialDoctorConfiguration;
    const result = await runCredentialDoctor(azure, { ...token, claims: { ...token.claims, aud: "azure.workload.identity" } }, requesterFor((request) => {
      if (request.method === "HEAD") return response(200);
      return response(400, JSON.stringify({ error: "invalid_client", error_description: "No matching federated identity record found" }));
    }, []));

    expect(result.checks.find((check) => check.name === "provider_access")).toMatchObject({ status: "failed", code: "missing_trust" });
  });

  test("does not permit a subject or expired claim to look healthy", async () => {
    const aws = { provider: "aws", values: { "role-arn": "role", "expected-subject": "expected" } } as const satisfies CredentialDoctorConfiguration;
    const expired = { ...token, claims: { ...token.claims, exp: Math.floor(Date.now() / 1000) - 1, sub: "wrong" } };
    const result = await runCredentialDoctor(aws, expired, requesterFor(() => response(200), []));
    expect(result.checks.find((check) => check.name === "trust")).toMatchObject({ status: "failed", code: "expired_credentials" });
  });

  test("constructs only a health endpoint from the configured Vault address", () => {
    expect(credentialDoctorNetworkEndpoint("vault", { address: "https://vault.example.test/team/" })).toEqual({ url: "https://vault.example.test/team/v1/sys/health" });
    expect(credentialDoctorNetworkEndpoint("vault", { address: "https://user:secret@vault.example.test" })).toEqual({ error: "Vault address must be an HTTP(S) URL without embedded credentials" });
  });
});
