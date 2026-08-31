import { Elysia } from "elysia";
import { usersRoutes } from "./users";
import { orgsRoutes } from "./orgs";
import { workspacesRoutes } from "./workspaces";
import { runsRoutes } from "./runs";
import { versionsRoutes } from "./versions";
import { samlRoutes } from "./saml";
import { settingsRoutes } from "./settings";
import { operationsRoutes } from "./operations";
import { settingsmoreRoutes } from "./settings-more";
import { systemRoutes } from "./system";
import { dbExportRoutes } from "./db-export";
import { dbMigrationRoutes } from "./db-migration";
import { systemApiTokenAdminRoutes } from "./system-api-tokens";
import { authPlugin } from "../../auth";
import { isImpersonationTokenId } from "../../lib/impersonation";

// Admin API split into domain modules (24.3).
export const adminRoutes = new Elysia({ name: "admin" })
  .use(authPlugin)
  .onBeforeHandle(({ request, token, user, set }) => {
    const isUnimpersonation = new URL(request.url).pathname === "/api/v2/admin/users/actions/unimpersonate";
    const isImpersonationSession = isImpersonationTokenId(token?.id);
    if (isUnimpersonation && isImpersonationSession && user?.isSiteAdmin !== true) return undefined;
    if ((user as Readonly<{ isSiteAdmin?: boolean | null }> | null | undefined)?.isSiteAdmin === true) return undefined;
    set.status = 404;
    return { errors: [{ status: "404", title: "Not Found" }] };
  })
  .use(usersRoutes)
  .use(orgsRoutes)
  .use(workspacesRoutes)
  .use(runsRoutes)
  .use(versionsRoutes)
  .use(samlRoutes)
  .use(settingsRoutes)
  .use(operationsRoutes)
  .use(settingsmoreRoutes)
  .use(systemRoutes)
  .use(dbExportRoutes)
  .use(dbMigrationRoutes)
  .use(systemApiTokenAdminRoutes)
