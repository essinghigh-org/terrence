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

// Admin API split into domain modules (24.3).
export const adminRoutes = new Elysia({ name: "admin" })
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
