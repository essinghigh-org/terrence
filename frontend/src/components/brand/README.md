# Terrence visual language

Terrence is a dependable infrastructure companion: bracket ears, a three-point tuft, blue body, pale belly, small face. Keep that silhouette and palette in every pose. The compact bracket-face mark is the logo; the full character is an illustration, never a status icon.

Use the ecosystem welcome scene on login, the box for first-use emptiness, the check for a completed plan with no changes, the diagnostic card for failed plans, the map for 404s, the hard hat for maintenance, and the book for introductory docs. Use `blocked` only for a full-page permission boundary and `interrupted` only when a page cannot load because its connection is unavailable. Brief SSE reconnects stay text-led. Illustrations supplement readable status and recovery instructions. Do not add them to table rows, routine alerts, or filtered search results. Never infer system health from the absence of data.

Use `Terrence` for inline art and `TerrenceLogo` for the mark or wordmark. Both are decorative; name their containing link when necessary. Motion is opt-in, CSS-only, and respects the global reduced-motion setting. Use 96–176px illustrations in content, up to 352px on login. Keep one illustration per state.

`Terrence` keeps the original rounded head/body, pale muzzle, blush, bracket ears, and short flippers. Ear groups, the face, paws, and props remain separate in the source. A small tilt distinguishes welcome and lost; lowered ears and a slight squash distinguish failure. The box, cards, book, map, lock, and cable plugs are physically held: the paw tip overlaps the object, and the open flipper root joins the body. The wrench shaft remains visible above and below its grip. Keep props as flat and simply outlined as the character. Do not introduce gradients, realistic materials, human limbs, or detached circular hands.

Pass `detail="small"` at 128px or less. It retains the face, silhouette, prop, and complete grip while omitting the ground shadow, ear insets, map route, page lines, and hat ribs. The default `detail="full"` includes these details. The component is the source of truth for both tiers.

The brand palette is ink #233654, blue #96B9F6, paper #EDF3FF, line #C9D9F2, and caption #536785. Props use soft cream, green, or coral. These fixed illustration colors are separate from semantic theme colors: controls and statuses continue using primary, success, warning, destructive, and muted tokens in every supported theme. Inline art and downloadable SVGs are transparent by default. Use `surface="paper"` only when an explicit pale backplate is appropriate; the gallery checks both treatments on a dark surface. Forced-colors mode suppresses decorative art while adjacent text remains complete.

Headings use the local Trebuchet/Avenir/system stack; body text uses Inter/system and technical values use the monospace stack. Shared buttons, cards, and page shells own sizing and spacing. Use the existing 4px spacing scale, 24px between sections, 20px within standard cards (12px in compact cards), and the shared 10px base radius. Default form controls and buttons are 40px tall; compact table actions keep their smaller sizes. Status labels always accompany icons and colors.

Run `bun run --cwd frontend scripts/brand-assets.tsx` from the repository root to export the canonical SVGs to `public/brand` and the mark to `public/favicon.svg`. CI runs the same script with `--check` to reject stale SVGs, the brand gallery, favicon SVG, standalone fallback, and the generated icon manifest without rewriting files. The same command refreshes the inline illustrations in the self-contained `public/404.html`. Run `bun run --cwd frontend scripts/brand-icons.ts` with the pinned local toolchain (`rsvg-convert 2.62.3` for SVG rasterization and ImageMagick 7.1.2-31 for the maskable composite) after changing the canonical mark; it regenerates the 192px, 512px, Apple touch, and centered maskable icons and records their hashes in `public/icons/brand-manifest.json`. The checked manifest makes a changed favicon fail CI until the binary exports are regenerated.

The generated `public/brand/index.html` is the regression sheet: every pose is shown at 96/128/176px on light and dark surfaces, with the compact mark, long adjacent copy, narrow-screen layout, and opt-in motion under a reduced-motion query. Review optical alignment, clipping, hand/prop tangencies, and the state copy there before changing canonical geometry. Check that props do not obscure the face, cables do not merge into feet, and grips remain readable at 96px.


## README and social preview

`public/brand/terrence-ecosystem.svg` is the dedicated README illustration. It places the official Terraform and OpenTofu vector marks on the login scene's dashed orbit, with their source files, provenance, and licenses in `vendor/`. Keep each mark unobstructed and preserve its proportions. The rear orbit arc is behind the body; the lower arc is drawn in front. These marks float independently of the character; do not add carrying paws or white tiles. The same scene is used on sign-in and registration.

`public/brand/github-social.png` is the 1280 × 640 social preview, with `github-social.svg` as its editable composition. The normal asset generator refreshes both and records their hashes in `github-social.manifest.json`; `--check` verifies dimensions, size, and freshness without a rasterizer. Regenerating the PNG requires `rsvg-convert`, Trebuchet MS, and Noto Sans. The PNG contains the rendered lettering and does not depend on fonts when uploaded. Upload it through the repository's social preview settings; generating the file does not change those settings.


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
