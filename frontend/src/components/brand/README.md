# Terrence visual language

Terrence is a dependable infrastructure companion: bracket ears, a three-point tuft, blue body, pale belly, small face. Keep that silhouette and palette in every pose. The compact bracket-face mark is the logo; the full character is an illustration, never a status icon.

Use the welcome pose on login, the box for first-use emptiness, the check for a completed plan with no changes, the diagnostic card for failed plans, the map for 404s, the hard hat for maintenance, and the book for introductory docs. Illustrations supplement readable status and recovery instructions. Do not add them to table rows, routine alerts, or filtered search results. Never infer system health from the absence of data.

Use `Terrence` for inline art and `TerrenceLogo` for the mark or wordmark. Both are decorative; name their containing link when necessary. Motion is opt-in, CSS-only, and respects the global reduced-motion setting. Use 96–176px illustrations in content, up to 352px on login. Keep one illustration per state.

The brand palette is ink #233654, blue #96B9F6, paper #EDF3FF, line #C9D9F2, and caption #536785. Props use soft cream, green, or coral. These fixed illustration colors are separate from semantic theme colors: controls and statuses continue using primary, success, warning, destructive, and muted tokens in every supported theme.

Headings use the local Trebuchet/Avenir/system stack; body text uses Inter/system and technical values use the monospace stack. Shared buttons, cards, and page shells own sizing and spacing. Use the existing 4px spacing scale, 24px between sections, 16px within cards, and the shared 10px base radius. Status labels always accompany icons and colors.

Run `bun run --cwd frontend scripts/brand-assets.tsx` from the repository root to export the canonical SVGs to `public/brand` and the mark to `public/favicon.svg`. Regenerate app PNGs from that mark with rsvg-convert (192px, 512px, and 180px for Apple touch); the maskable icon uses a centered 360px mark on a 512px ink background.
