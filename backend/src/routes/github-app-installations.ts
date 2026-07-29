import { Elysia } from "elysia";
import { and, eq } from "drizzle-orm";
import jwt from "jsonwebtoken";
import { authPlugin } from "../auth";
import { db } from "../db";
import { apiTokens, githubAppInstallations, oauthTokens, organizations, type users } from "../db/schema";
import { apiURL, checkOrganizationPermission, checkOrganizationVcsReadPermission } from "../lib/utils";
import { decryptSecret } from "../lib/secrets";
import { getGitHubAppAccessToken } from "../lib/webhooks";

type SetObj = Readonly<{ status?: number | string; headers: Readonly<Record<string, string | number>> }>;
type ParamCtx = Readonly<{
  params: Readonly<Record<string, string>>;
  query?: Readonly<Record<string, unknown>>;
  request?: Readonly<{ headers: Readonly<Headers>; url: string }>;
  body?: unknown;
  user?: Readonly<typeof users.$inferSelect> | null;
  token?: Readonly<{ id: string }> | null;
  orgId: string | null;
  teamId: string | null;
  set: SetObj;
}>;

type SetupState = Readonly<{
  expiresAt: number;
  orgId: string;
  orgName: string;
  tokenId: string;
  tokenOrgId: string | null;
  tokenTeamId: string | null;
  userId: string | null;
}>;

type GitHubAppConfig = Readonly<{
  apiUrl: string;
  appId: number;
  appIdText: string;
  installUrl: string;
  privateKey: string;
}>;

type VerifiedInstallation = Readonly<{
  iconUrl: string | null;
  installationType: "Organization" | "User";
  installationUrl: string | null;
  name: string;
}>;

const SETUP_STATE_TTL_MS = 10 * 60 * 1000;
const GITHUB_TIMEOUT_MS = 10_000;
const setupStates = new Map<string, SetupState>();

function stringQuery(query: Readonly<Record<string, unknown>> | undefined, key: string): string {
  const value = query?.[key];
  return typeof value === "string" ? value : "";
}

function positiveInteger(value: string): number | null {
  if (!/^[1-9]\d*$/.test(value)) return null;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) ? parsed : null;
}

function configuredUrl(value: string | undefined, fallback: string): URL | null {
  try {
    const url = new URL(value === undefined || value.trim() === "" ? fallback : value);
    return (
      (url.protocol === "https:" || url.protocol === "http:")
      && url.username === ""
      && url.password === ""
      && url.search === ""
      && url.hash === ""
    ) ? url : null;
  } catch {
    return null;
  }
}

function githubAppConfig(): GitHubAppConfig | null {
  const appIdText = process.env.GITHUB_APP_ID?.trim() ?? "";
  const appId = positiveInteger(appIdText);
  const privateKey = process.env.GITHUB_APP_PRIVATE_KEY?.replaceAll("\\n", "\n").trim() ?? "";
  const slug = process.env.GITHUB_APP_SLUG?.trim() ?? "";
  const httpUrl = configuredUrl(process.env.GITHUB_APP_HTTP_URL, "https://github.com");
  const apiUrl = configuredUrl(process.env.GITHUB_APP_API_URL, "https://api.github.com");
  if (
    appId === null
    || privateKey === ""
    || !/^[A-Za-z0-9](?:[A-Za-z0-9-]{0,98}[A-Za-z0-9])?$/.test(slug)
    || httpUrl === null
    || apiUrl === null
  ) return null;
  const installUrl = new URL(`/apps/${encodeURIComponent(slug)}/installations/new`, httpUrl);
  return { apiUrl: apiUrl.toString(), appId, appIdText, installUrl: installUrl.toString(), privateKey };
}

function redirect(location: string, status: 302 | 303): Response {
  return new Response(null, {
    status,
    headers: {
      "Cache-Control": "no-store",
      Location: location,
      "Referrer-Policy": "no-referrer",
    },
  });
}

function authorizationResponse(
  request: Readonly<{ headers: Readonly<Headers> }>,
  state: string,
  location: string,
): Response {
  const acceptsJson = (request.headers.get("accept") ?? "")
    .split(",")
    .some((value: string): boolean => {
      const mediaType = value.split(";", 1)[0]?.trim().toLowerCase();
      return mediaType === "application/json" || mediaType === "application/vnd.api+json";
    });
  if (!acceptsJson) return redirect(location, 302);
  return Response.json({
    data: {
      id: state,
      type: "vcs-authorization-requests",
      attributes: { "authorization-url": location },
    },
  }, {
    headers: {
      "Cache-Control": "no-store",
      "Content-Type": "application/vnd.api+json",
      "Referrer-Policy": "no-referrer",
    },
  });
}

function flowError(
  set: SetObj,
  status: number,
  title: string,
  detail: string,
): { errors: { status: string; title: string; detail: string }[] } {
  (set as { status: number }).status = status;
  return { errors: [{ status: String(status), title, detail }] };
}

function pruneSetupStates(): void {
  const now = Date.now();
  for (const [id, state] of setupStates) {
    if (state.expiresAt <= now) setupStates.delete(id);
  }
}

function httpUrl(value: unknown): string | null {
  if (typeof value !== "string" || value === "") return null;
  try {
    const url = new URL(value);
    return url.protocol === "https:" || url.protocol === "http:" ? url.toString() : null;
  } catch {
    return null;
  }
}

async function fetchInstallation(
  config: Readonly<GitHubAppConfig>,
  installationId: number,
): Promise<VerifiedInstallation | null> {
  let appToken: string;
  try {
    appToken = jwt.sign({
      iat: Math.floor(Date.now() / 1000) - 60,
      exp: Math.floor(Date.now() / 1000) + (9 * 60),
      iss: config.appIdText,
    }, config.privateKey, { algorithm: "RS256" });
  } catch {
    return null;
  }

  try {
    const endpoint = `${config.apiUrl.replace(/\/$/, "")}/app/installations/${String(installationId)}`;
    const response = await fetch(endpoint, {
      headers: {
        Accept: "application/vnd.github+json",
        Authorization: `Bearer ${appToken}`,
        "X-GitHub-Api-Version": "2022-11-28",
      },
      signal: AbortSignal.timeout(GITHUB_TIMEOUT_MS),
    });
    if (!response.ok) return null;
    const payload = await response.json() as Record<string, unknown>;
    const account = payload.account !== null && typeof payload.account === "object"
      ? payload.account as Record<string, unknown>
      : {};
    const returnedId = payload.id;
    const returnedAppId = payload.app_id;
    const rawName = typeof account.login === "string"
      ? account.login
      : typeof account.name === "string"
        ? account.name
        : "";
    const name = rawName.trim();
    const rawType = payload.target_type ?? account.type;
    if (
      returnedId !== installationId
      || returnedAppId !== config.appId
      || name === ""
      || (rawType !== "Organization" && rawType !== "User")
    ) return null;
    return {
      iconUrl: httpUrl(account.avatar_url),
      installationType: rawType,
      installationUrl: httpUrl(payload.html_url),
      name: name.slice(0, 255),
    };
  } catch {
    return null;
  }
}

function installationResource(installation: Readonly<typeof githubAppInstallations.$inferSelect>): Record<string, unknown> {
  return {
    id: installation.id,
    type: "github-app-installations",
    attributes: {
      name: installation.name,
      "installation-id": installation.installationId,
      "icon-url": installation.iconUrl,
      "installation-type": installation.installationType,
      "installation-url": installation.installationUrl,
      "created-at": new Date(installation.createdAt).toISOString(),
    },
  };
}

export const githubAppInstallationRoutes = new Elysia({ name: "githubAppInstallations" })
  .use(authPlugin)
  .get("/api/v2/organizations/:org_name/vcs-connections/:connection_id/repositories", async ({ params, user, orgId: tokenOrgId, teamId: tokenTeamId, set }: ParamCtx): Promise<unknown> => {
    const org = await db.query.organizations.findFirst({ where: eq(organizations.name, params.org_name ?? "") });
    if (org === undefined || !(await checkOrganizationVcsReadPermission(org.id, user?.id, tokenOrgId, tokenTeamId ?? null))) {
      (set as { status: number }).status = 404;
      return { errors: [{ status: "404", title: "Not Found" }] };
    }

    const connectionId = params.connection_id ?? "";
    const repos: Array<{ id: string; type: string; attributes: { identifier: string; name: string } }> = [];

    // 1. Check if connection is GitHub App Installation
    const installation = await db.query.githubAppInstallations.findFirst({
      where: and(eq(githubAppInstallations.id, connectionId), eq(githubAppInstallations.orgId, org.id)),
    });

    if (installation !== undefined) {
      const token = await getGitHubAppAccessToken(installation.installationId);
      if (token !== null) {
        try {
          const res = await fetch("https://api.github.com/installation/repositories?per_page=100", {
            headers: { Authorization: `Bearer ${token}`, Accept: "application/vnd.github.v3+json" },
          });
          if (res.ok) {
            const body = await res.json() as { repositories?: Array<{ full_name?: string; name?: string }> };
            for (const repo of body.repositories ?? []) {
              if (typeof repo.full_name === "string" && repo.full_name !== "") {
                repos.push({
                  id: repo.full_name,
                  type: "vcs-repositories",
                  attributes: { identifier: repo.full_name, name: repo.name ?? repo.full_name },
                });
              }
            }
          }
        } catch {}
      }
    } else {
      // 2. Check if connection is OAuth Token
      const oauthToken = await db.query.oauthTokens.findFirst({
        where: eq(oauthTokens.id, connectionId),
      });
      if (oauthToken !== undefined) {
        try {
          const tokenStr = await decryptSecret(oauthToken.token);
          const res = await fetch("https://api.github.com/user/repos?per_page=100&sort=updated", {
            headers: { Authorization: `Bearer ${tokenStr}`, Accept: "application/vnd.github.v3+json" },
          });
          if (res.ok) {
            const body = await res.json() as Array<{ full_name?: string; name?: string }>;
            if (Array.isArray(body)) {
              for (const repo of body) {
                if (typeof repo.full_name === "string" && repo.full_name !== "") {
                  repos.push({
                    id: repo.full_name,
                    type: "vcs-repositories",
                    attributes: { identifier: repo.full_name, name: repo.name ?? repo.full_name },
                  });
                }
              }
            }
          }
        } catch {}
      }
    }

    return { data: repos };
  })
  .get("/api/v2/organizations/:org_name/github-app/installations", async ({ params, user, orgId: tokenOrgId, teamId: tokenTeamId, set }: ParamCtx): Promise<unknown> => {
    const org = await db.query.organizations.findFirst({ where: eq(organizations.name, params.org_name ?? "") });
    if (org === undefined || !(await checkOrganizationVcsReadPermission(org.id, user?.id, tokenOrgId, tokenTeamId ?? null))) {
      (set as { status: number }).status = 404;
      return { errors: [{ status: "404", title: "Not Found" }] };
    }
    const installations = await db.query.githubAppInstallations.findMany({
      where: eq(githubAppInstallations.orgId, org.id),
    });
    return { data: installations.map(installationResource) };
  })
  .post("/api/v2/organizations/:org_name/github-app/installations", async ({ params, body, user, orgId: tokenOrgId, teamId: tokenTeamId, set }: ParamCtx): Promise<unknown> => {
    const org = await db.query.organizations.findFirst({ where: eq(organizations.name, params.org_name ?? "") });
    if (org === undefined || !(await checkOrganizationPermission(org.id, user?.id, tokenOrgId, tokenTeamId ?? null, "manage-vcs-settings"))) {
      (set as { status: number }).status = 404;
      return { errors: [{ status: "404", title: "Not Found" }] };
    }
    const payload = body !== null && typeof body === "object" ? body as Record<string, unknown> : {};
    const data = payload.data !== null && typeof payload.data === "object" ? payload.data as Record<string, unknown> : {};
    const attributes = data.attributes !== null && typeof data.attributes === "object" ? data.attributes as Record<string, unknown> : {};
    const name = typeof attributes.name === "string" ? attributes.name.trim() : "";
    const installationId = attributes["installation-id"];
    if (name === "" || typeof installationId !== "number" || !Number.isSafeInteger(installationId) || installationId <= 0) {
      (set as { status: number }).status = 422;
      return { errors: [{ status: "422", title: "Unprocessable Entity", detail: "Name and a positive integer installation ID are required" }] };
    }
    const existing = await db.query.githubAppInstallations.findFirst({
      where: and(eq(githubAppInstallations.orgId, org.id), eq(githubAppInstallations.installationId, installationId)),
    });
    if (existing !== undefined) {
      (set as { status: number }).status = 409;
      return { errors: [{ status: "409", title: "Conflict", detail: "Installation ID is already registered in this organization" }] };
    }
    const installation = {
      id: `ghain-${crypto.randomUUID()}`,
      orgId: org.id,
      name,
      installationId,
      createdAt: Date.now(),
    };
    await db.insert(githubAppInstallations).values(installation);
    (set as { status: number }).status = 201;
    return { data: installationResource({ ...installation, iconUrl: null, installationType: "Organization", installationUrl: null }) };
  })
  .get("/api/v2/organizations/:org_name/github-app/installations/setup", async ({ params, request, user, token, orgId: tokenOrgId, teamId: tokenTeamId, set }: ParamCtx): Promise<unknown> => {
    const org = await db.query.organizations.findFirst({ where: eq(organizations.name, params.org_name ?? "") });
    if (
      org === undefined
      || request === undefined
      || token === null
      || token === undefined
      || !(await checkOrganizationPermission(org.id, user?.id, tokenOrgId, tokenTeamId ?? null, "manage-vcs-settings"))
    ) {
      return flowError(set, 404, "Not Found", "Organization not found");
    }
    const config = githubAppConfig();
    if (config === null) {
      return flowError(
        set,
        422,
        "GitHub App Not Configured",
        "GITHUB_APP_ID, GITHUB_APP_PRIVATE_KEY, and GITHUB_APP_SLUG must be configured",
      );
    }

    pruneSetupStates();
    const stateId = crypto.randomUUID();
    setupStates.set(stateId, {
      expiresAt: Date.now() + SETUP_STATE_TTL_MS,
      orgId: org.id,
      orgName: org.name,
      tokenId: token.id,
      tokenOrgId: tokenOrgId ?? null,
      tokenTeamId: tokenTeamId ?? null,
      userId: user?.id ?? null,
    });
    const installUrl = new URL(config.installUrl);
    installUrl.searchParams.set("state", stateId);
    return authorizationResponse(request, stateId, installUrl.toString());
  })
  .get("/api/v2/github-app/installations/callback", async ({ query, request, set }: ParamCtx): Promise<unknown> => {
    pruneSetupStates();
    const stateId = stringQuery(query, "state");
    const state = setupStates.get(stateId);
    if (state === undefined) {
      return flowError(set, 400, "Invalid GitHub App Callback", "Setup state is missing, expired, or invalid");
    }
    setupStates.delete(stateId);

    const setupAction = stringQuery(query, "setup_action");
    const installationId = positiveInteger(stringQuery(query, "installation_id"));
    if ((setupAction !== "install" && setupAction !== "update") || installationId === null) {
      return flowError(set, 400, "Invalid GitHub App Callback", "GitHub returned an invalid setup action or installation ID");
    }
    const org = await db.query.organizations.findFirst({ where: eq(organizations.id, state.orgId) });
    const initiatingToken = await db.query.apiTokens.findFirst({ where: eq(apiTokens.id, state.tokenId) });
    const stillAuthorized = initiatingToken !== undefined
      && (
        state.userId !== null
          ? initiatingToken.userId === state.userId
          : state.tokenTeamId !== null
            ? initiatingToken.teamId === state.tokenTeamId
            : initiatingToken.orgId === state.orgId && state.tokenOrgId === state.orgId
      )
      && await checkOrganizationPermission(
        state.orgId,
        state.userId ?? undefined,
        state.tokenOrgId,
        state.tokenTeamId,
        "manage-vcs-settings",
      );
    if (org?.name !== state.orgName || !stillAuthorized) {
      return flowError(set, 403, "Forbidden", "Organization authorization is no longer valid");
    }
    const config = githubAppConfig();
    if (config === null) {
      return flowError(set, 422, "GitHub App Not Configured", "GitHub App configuration is unavailable");
    }
    const verified = await fetchInstallation(config, installationId);
    if (verified === null) {
      return flowError(set, 502, "GitHub App Verification Failed", "GitHub did not return a matching installation for this App");
    }

    const insertedId = `ghain-${crypto.randomUUID()}`;
    await db.insert(githubAppInstallations).values({
      id: insertedId,
      orgId: org.id,
      name: verified.name,
      installationId,
      iconUrl: verified.iconUrl,
      installationType: verified.installationType,
      installationUrl: verified.installationUrl,
      createdAt: Date.now(),
    }).onConflictDoUpdate({
      target: [githubAppInstallations.orgId, githubAppInstallations.installationId],
      set: {
        name: verified.name,
        iconUrl: verified.iconUrl,
        installationType: verified.installationType,
        installationUrl: verified.installationUrl,
      },
    });
    const installation = await db.query.githubAppInstallations.findFirst({
      where: and(
        eq(githubAppInstallations.orgId, org.id),
        eq(githubAppInstallations.installationId, installationId),
      ),
    });
    if (installation === undefined || request === undefined) {
      return flowError(set, 500, "Internal Server Error", "GitHub App installation could not be saved");
    }

    const destination = new URL(apiURL(request, `/app/${encodeURIComponent(org.name)}/settings/vcs`));
    destination.searchParams.set("github_app_installation", installation.id);
    return redirect(destination.toString(), 303);
  });
