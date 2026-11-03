import { describe, expect, test } from "bun:test";
import { gravatarEnabled, presentationSettings, visibleBanner } from "../../src/lib/site-presentation";

describe("site presentation privacy and publication", () => {
  test("allowlists public settings and withholds internal links from anonymous visitors", () => {
    const settings = {
      footer: "Welcome",
      "login-help": "Contact us",
      "internal-support-url": "https://internal.test",
      password: "secret",
      unknown: "private",
      "avatar-sources": [{ source: "gravatar", enabled: false }],
    };
    expect(presentationSettings(settings, false)).toEqual({
      footer: "Welcome",
      "login-help": "Contact us",
      "gravatar-enabled": false,
    });
    expect(presentationSettings(settings, true)["internal-support-url"]).toBe("https://internal.test");
    expect(presentationSettings(settings, true)["password"]).toBeUndefined();
  });
  test("requires enabled Gravatar source explicitly", () => {
    expect(gravatarEnabled({ "avatar-sources": [{ source: "gravatar", enabled: true }] })).toBe(true);
    expect(gravatarEnabled({ "avatar-sources": [] })).toBe(false);
    expect(gravatarEnabled({ "avatar-sources": [{ source: "other", enabled: true }] })).toBe(false);
  });
  test("filters authenticated audiences and exact schedule boundaries", () => {
    const start = "2026-11-03T10:00:00Z";
    const end = "2026-11-03T11:00:00Z";
    const banner = {
      id: "banner",
      attributes: { audience: "authenticated_only", "scheduled-publish-at": start, "scheduled-expire-at": end },
    };
    expect(visibleBanner(banner, false, Date.parse(start))).toBeNull();
    expect(visibleBanner(banner, true, Date.parse(start) - 1)).toBeNull();
    expect(visibleBanner(banner, true, Date.parse(start))).toEqual(banner);
    expect(visibleBanner(banner, true, Date.parse(end) - 1)).toEqual(banner);
    expect(visibleBanner(banner, true, Date.parse(end))).toBeNull();
    banner.attributes.audience = "all_users";
    expect(visibleBanner(banner, false, Date.parse(start))).toEqual(banner);
    expect(visibleBanner(null, true)).toBeNull();
  });
});
