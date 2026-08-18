import { Elysia } from "elysia";
import { workloadIdentityIssuer, workloadIdentityJwks } from "../lib/workload-identity";

export const workloadIdentityRoutes = new Elysia({ name: "workload-identity" })
  .get("/.well-known/jwks", async (): Promise<unknown> => workloadIdentityJwks())
  .get("/.well-known/openid-configuration", (): Record<string, unknown> => {
    const issuer = workloadIdentityIssuer();
    return {
      issuer,
      jwks_uri: new URL("/.well-known/jwks", `${issuer}/`).toString(),
      id_token_signing_alg_values_supported: ["RS256"],
      subject_types_supported: ["public"],
      response_types_supported: ["id_token"],
      claims_supported: ["sub", "aud", "exp", "iat", "iss", "jti", "nbf"],
    };
  });
