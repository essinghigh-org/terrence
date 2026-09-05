# Terrence visual language

Terrence is a dependable infrastructure companion: bracket ears, a three-point tuft, blue body, pale belly, small face. Keep that silhouette and palette in every pose. The compact bracket-face mark is the logo; the full character is an illustration, never a status icon.

Use the welcome pose on login, the box for first-use emptiness, the check for a completed plan with no changes, the diagnostic card for failed plans, the map for 404s, the hard hat for maintenance, and the book for introductory docs. Illustrations supplement readable status and recovery instructions. Do not add them to table rows, routine alerts, or filtered search results. Never infer system health from the absence of data.

Use `Terrence` for inline art and `TerrenceLogo` for the mark or wordmark. Both are decorative; name their containing link when necessary. Motion is opt-in, CSS-only, and respects the global reduced-motion setting. Use 96–176px illustrations in content, up to 352px on login. Keep one illustration per state.

The brand palette is ink #233654, blue #96B9F6, paper #EDF3FF, line #C9D9F2, and caption #536785. Props use soft cream, green, or coral. These fixed illustration colors are separate from semantic theme colors: controls and statuses continue using primary, success, warning, destructive, and muted tokens in every supported theme.

Headings use the local Trebuchet/Avenir/system stack; body text uses Inter/system and technical values use the monospace stack. Shared buttons, cards, and page shells own sizing and spacing. Use the existing 4px spacing scale, 24px between sections, 20px within standard cards (12px in compact cards), and the shared 10px base radius. Default form controls and buttons are 40px tall; compact table actions keep their smaller sizes. Status labels always accompany icons and colors.

Run `bun run --cwd frontend scripts/brand-assets.tsx` from the repository root to export the canonical SVGs to `public/brand` and the mark to `public/favicon.svg`. The same command refreshes the inline illustrations in the self-contained `public/404.html`. Regenerate app PNGs from that mark with rsvg-convert (192px, 512px, and 180px for Apple touch); the maskable icon uses a centered 360px mark on a 512px ink background.


## Frontend audit coverage

The September 2026 audit covers the route views and shared components, including their loading, empty, error, and populated branches. Shared primitives carry the visual changes into pages that do not need their own illustration.

| Surface | Treatment |
| --- | --- |
| Login, registration, organization dashboard | Shared welcome layout; first-use organization art. Mobile prioritizes the form. |
| Workspaces, projects, runs | First-run guidance and true empty collections; populated cards, tables, filters, resource graphs and logs remain compact. |
| Plan and apply results, workspace health | Art supplements explicit results. A healthy assessment requires completed status, no drift, successful checks, no unknown checks and no error. Fetch failures never imply health or emptiness. |
| Registry, module and provider details | Collection emptiness and full-page failures can use art; filtered misses and missing version metadata stay text-led. Errors include recovery navigation. |
| Organization, account and workspace settings | Shared controls, labels, cards and dialog spacing. Variables, state, stacks, OIDC and policy collections receive explanations; repeated settings panels do not receive mascots. |
| Agent pools, VCS, policy details, tags, CIDR ranges, SSH keys, team access | Permission-aware actions and compact configuration tables. Agent-pool first use may use art; inline validation and permissions remain text-led. |
| Administration: users, organizations, workspaces, runs, audit, security, versions, authentication, SMTP, SCIM, logging, webhooks, plan explainer, database migration, compatibility | Shared navigation, controls, headings and status treatments; operational data and administrative warnings remain prominent without decorative characters. |
| Maintenance and documentation | Maintenance first-use illustration and introductory documentation guide; document-load failure has recovery instructions. |
| Server 404, application 404, crash boundary | Canonical lost/failed art with readable explanations and recovery links or reload action. Server 404 contains its own SVG and CSS. |

Validation combines frontend unit tests, the existing browser/accessibility suite across supported themes, a mobile standalone-404 accessibility check, backend error-response tests, and manual desktop/mobile inspection. Browser fixtures verify presentation and interaction; they do not prove live cloud integration behavior.
