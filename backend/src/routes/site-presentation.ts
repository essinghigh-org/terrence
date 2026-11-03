import { Elysia } from "elysia";
import { authPlugin } from "../auth";
import { getSettingsFresh } from "../lib/settings";
import { presentationSettings, visibleBanner } from "../lib/site-presentation";

export const sitePresentationRoutes = new Elysia({ name: "site-presentation" })
  .use(authPlugin)
  .get("/api/v2/site-presentation", async ({ user, set }) => {
    // Responses vary by authentication and schedule. Never cache internal links
    // or retain an announcement after logout/expiry.
    set.headers["Cache-Control"] = "no-store";
    const authenticated = user !== null && user !== undefined;
    const [settings, banners] = await Promise.all([
      getSettingsFresh("customization"),
      getSettingsFresh("admin-banners"),
    ]);
    return {
      data: {
        type: "site-presentation",
        id: "site",
        attributes: {
          ...presentationSettings(settings, authenticated),
          banner: visibleBanner(banners["active"], authenticated),
        },
      },
    };
  });
