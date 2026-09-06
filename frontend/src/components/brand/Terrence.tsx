import { cn } from "@/lib/utils";

export type TerrencePose =
  | "welcome"
  | "empty"
  | "healthy"
  | "failed"
  | "lost"
  | "maintenance"
  | "guide"
  | "blocked"
  | "interrupted";
export type TerrenceDetail = "full" | "small";
export type TerrenceSurface = "paper" | "transparent";

/** One character, nine situations. Decorative: the adjacent text carries meaning.
 * The small tier keeps the same geometry and silhouette while removing secondary
 * lines for illustrations rendered at or below 128px. A paper surface keeps the
 * fixed ink outline legible when the surrounding product theme is dark.
 */
export function Terrence({
  pose = "welcome",
  className,
  animated = false,
  detail = "full",
  surface = "paper",
}: Readonly<{
  pose?: TerrencePose;
  className?: string;
  animated?: boolean;
  detail?: TerrenceDetail;
  surface?: TerrenceSurface;
}>): React.JSX.Element {
  const small = detail === "small";
  const welcoming = pose === "welcome";
  const settled = pose === "healthy";
  const heldProp = ["empty", "lost", "maintenance", "guide"].includes(pose);
  const neutral = pose === "blocked";

  return (
    <svg
      viewBox="0 0 320 280"
      fill="none"
      aria-hidden="true"
      focusable="false"
      className={cn("terrence-mascot", animated && "terrence-mascot--animated", className)}
      data-pose={pose}
      data-detail={detail}
      data-surface={surface}
    >
      {surface === "paper" && <rect className="terrence-backplate" x="8" y="8" width="304" height="264" rx="28" fill="#EDF3FF" />}
      {!small && <ellipse className="terrence-secondary-detail" cx="159" cy="252" rx="99" ry="12" fill="currentColor" opacity=".07" />}
      <g className="terrence-body" stroke="#233654" strokeWidth="4" strokeLinecap="round" strokeLinejoin="round">
        {/* Bracket ears and a three-part forehead tuft are the identifying silhouette. */}
        <path d="M105 104 79 83 79 48 106 48 116 89M212 104 239 83 239 48 212 48 201 89" fill="#739BE8" />
        {!small && <path className="terrence-secondary-detail" d="M88 73V58H101M230 73V58H217" stroke="#C8DDFF" strokeWidth="5" />}
        <path d="M107 216C83 234 86 251 115 248L138 233M184 233 205 248C233 252 239 236 213 216" fill="#739BE8" />
        <g className={cn("terrence-arms", heldProp && "terrence-arms--holding", settled && "terrence-arms--settled")} data-arm-role={heldProp ? "holding" : settled ? "settled" : "resting"}>
          <path
            d={heldProp
              ? "M99 145C73 143 56 163 61 182 66 193 80 186 96 185 109 185 116 194 126 201"
              : settled
                ? "M99 157C76 158 61 171 66 186 70 195 84 187 99 183"
                : "M99 145C73 143 56 163 61 182 66 193 80 179 94 178"}
            fill="#96B9F6"
          />
          {welcoming ? (
            <g className="terrence-wave">
              <path d="M220 149C244 143 248 116 260 119 273 123 264 160 244 176L222 179" fill="#96B9F6" />
              <path d="m266 99 7-9m-25 10-1-12" stroke="#739BE8" />
            </g>
          ) : (
            <path
              d={heldProp
                ? "M220 148C242 144 262 160 257 179 254 190 241 183 226 184 214 185 207 194 197 201"
                : settled
                  ? "M220 157C243 158 258 171 253 186 249 195 235 187 220 183"
                  : "M220 148C242 144 262 160 257 179 254 192 239 179 224 179"}
              fill="#96B9F6"
            />
          )}
        </g>
        <path d="M89 160C89 121 103 97 131 90L137 76 152 85 163 72 174 85 190 78 195 94C224 105 233 131 233 164L229 200C225 226 202 239 161 239 117 239 93 225 90 201Z" fill="#96B9F6" />
        <path d="M113 185C116 165 136 156 161 156 189 156 210 170 210 192 210 216 191 229 161 229 130 229 111 215 113 185Z" fill="#DCEAFF" stroke="none" />
        <g className="terrence-face">
          {settled ? <path d="M123 143q8-12 16 0m45 0q8-12 16 0" /> : <><ellipse cx="132" cy="142" rx="5" ry="8" fill="#233654" stroke="none" /><ellipse cx="190" cy="142" rx="5" ry="8" fill="#233654" stroke="none" /></>}
          {!small && <g className="terrence-secondary-detail"><ellipse cx="115" cy="157" rx="10" ry="5" fill="#739BE8" stroke="none" /><ellipse cx="207" cy="157" rx="10" ry="5" fill="#739BE8" stroke="none" /></g>}
          {neutral ? <path d="M151 171h20" /> : pose === "interrupted" ? <path d="M151 172q10-5 20 0" /> : ["failed", "lost"].includes(pose) ? <path d="M151 174q10-9 20 0" /> : <path d="M151 166q10 12 20 0" />}
          {pose === "failed" && <path d="m124 126 14-3m45 0 14 3" />}
        </g>
        {pose === "empty" && <g className="terrence-prop terrence-prop--box" data-prop="box"><path d="m109 197 51-17 51 17v39l-51 20-51-20Z" fill="#FAE4B5" /><path d="m109 197 51 20 51-20m-51 20v39" fill="#FFF1D5" />{!small && <g className="terrence-secondary-detail"><path d="m109 197-17 15 50 21 18-16 18 16 50-21-17-15" fill="#FFF1D5" /><path d="m143 186 51 19" /></g>}</g>}
        {pose === "healthy" && <g className="terrence-prop terrence-prop--check" data-prop="check"><circle cx="222" cy="213" r="28" fill="#D7F0E6" /><path d="m209 213 9 9 17-19" stroke="#27715B" strokeWidth="5" /></g>}
        {pose === "failed" && <g className="terrence-prop terrence-prop--diagnostic" data-prop="diagnostic"><rect x="123" y="194" width="76" height="55" rx="8" fill="#FFF0EE" /><path d="m151 211 20 20m0-20-20 20" stroke="#B94A47" strokeWidth="5" /></g>}
        {pose === "lost" && <g className="terrence-prop terrence-prop--map" data-prop="map"><path d="m101 194 39-11 40 15 40-11v55l-40 11-40-15-39 11Z" fill="#FFF1D5" /><path d="M140 183v55m40-40v55" stroke="#C7A76B" />{!small && <path className="terrence-secondary-detail" d="m238 90 1-4c2-9 18-9 18 2 0 7-10 7-10 15m0 10v1" stroke="#739BE8" strokeWidth="5" />}</g>}
        {pose === "maintenance" && <g className="terrence-prop terrence-prop--wrench" data-prop="wrench"><path d="M106 113c0-30 18-47 54-47s54 17 54 47" fill="#FAE4B5" /><path d="M99 113h123" stroke="#B38A43" />{!small && <path className="terrence-secondary-detail" d="M150 71v28m20-28v28" stroke="#B38A43" />}{/* The wrench remains a single readable foreground prop at small sizes. */}<path d="m199 208 36-36c-4-10 2-21 12-24l-1 13 10 4 8-10c5 13-3 25-15 24l-35 40Z" fill="#E4EAF3" /></g>}
        {pose === "guide" && <g className="terrence-prop terrence-prop--book" data-prop="book"><path d="M108 192q27-9 52 5 25-14 52-5v48q-27-9-52 5-25-14-52-5Z" fill="#FFF1D5" /><path d="M160 197v48" stroke="#B38A43" strokeWidth="3" />{!small && <path className="terrence-secondary-detail" d="m121 206 24 3m-24 10 24 3m31-13 24-3m-24 16 24-3" stroke="#B38A43" strokeWidth="3" />}</g>}
        {pose === "blocked" && <g className="terrence-prop terrence-prop--gate" data-prop="gate"><path d="M102 220h116" stroke="#B38A43" strokeWidth="8" /><path d="M113 208v39m95-39v39M113 209h95" stroke="#233654" strokeWidth="5" /><rect x="145" y="207" width="30" height="40" rx="5" fill="#FAE4B5" /><circle cx="160" cy="220" r="3" fill="#233654" stroke="none" /><path d="M154 231h12" stroke="#233654" strokeWidth="3" /></g>}
        {pose === "interrupted" && <g className="terrence-prop terrence-prop--cable" data-prop="cable"><path d="M84 216h34c15 0 18 17 31 17h9m78-17h-34c-15 0-18 17-31 17h-9" stroke="#B38A43" strokeWidth="8" fill="none" /><path d="M133 209v18h14v-12m40 12h-14v-18" fill="#E4EAF3" stroke="#233654" strokeWidth="4" /></g>}

        {/* Foreground hands make the box, map, wrench and book read as held. */}
        {pose === "empty" && <g className="terrence-hands" data-held-prop="box"><path className="terrence-foreground-hand" d="M104 199q9-7 17 1v12q-8 6-17-1Z" fill="#96B9F6" /><path className="terrence-foreground-hand" d="M199 200q8-8 17-1v12q-9 7-17 1Z" fill="#96B9F6" /></g>}
        {pose === "lost" && <g className="terrence-hands" data-held-prop="map"><path className="terrence-foreground-hand" d="M101 198q9-7 17 1l3 11q-9 7-18 0Z" fill="#96B9F6" /><path className="terrence-foreground-hand" d="M199 199q8-8 18-1l-2 12q-9 7-18 0Z" fill="#96B9F6" /></g>}
        {pose === "maintenance" && <g className="terrence-hands" data-held-prop="wrench"><path className="terrence-foreground-hand" d="M207 202q8-7 16 1l-5 13-11-3Z" fill="#96B9F6" /></g>}
        {pose === "guide" && <g className="terrence-hands" data-held-prop="book"><path className="terrence-foreground-hand" d="M106 200q9-7 17 1l2 12q-9 6-18 0Z" fill="#96B9F6" /><path className="terrence-foreground-hand" d="M197 201q8-8 17-1l-2 12q-9 6-18 0Z" fill="#96B9F6" /></g>}
      </g>
    </svg>
  );
}

export function TerrenceLogo({ className, wordmark = false }: Readonly<{ className?: string; wordmark?: boolean }>): React.JSX.Element {
  return <span className={cn("inline-flex items-center gap-2.5", className)}>
    <svg viewBox="0 0 40 40" fill="none" className="size-8 shrink-0" aria-hidden="true" focusable="false">
      <rect width="40" height="40" rx="12" fill="#233654" />
      <path d="M10 18V10h7v5h6v-5h7v8l-2 10q-8 6-16 0Z" fill="#96B9F6" />
      <path d="M16 21v3m8-3v3" stroke="#233654" strokeWidth="3" strokeLinecap="round" />
    </svg>
    {wordmark && <span className="font-heading text-xl font-bold tracking-tight">terrence<span className="text-primary">.</span></span>}
  </span>;
}
