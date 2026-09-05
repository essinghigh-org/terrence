import { cn } from "@/lib/utils";

export type TerrencePose = "welcome" | "empty" | "healthy" | "failed" | "lost" | "maintenance" | "guide";

/** One character, seven situations. Decorative: the adjacent text carries meaning. */
export function Terrence({ pose = "welcome", className, animated = false }: Readonly<{
  pose?: TerrencePose;
  className?: string;
  animated?: boolean;
}>): React.JSX.Element {
  return (
    <svg viewBox="0 0 320 280" fill="none" aria-hidden="true" focusable="false" className={cn("terrence-mascot", animated && "terrence-mascot--animated", className)} data-pose={pose}>
      <ellipse cx="159" cy="252" rx="99" ry="12" fill="currentColor" opacity=".07" />
      <g className="terrence-body" stroke="#233654" strokeWidth="4" strokeLinecap="round" strokeLinejoin="round">
        {/* Bracket ears and a three-part forehead tuft are the identifying silhouette. */}
        <path d="M105 104 79 83 79 48 106 48 116 89M212 104 239 83 239 48 212 48 201 89" fill="#739BE8" />
        <path d="M88 73V58H101M230 73V58H217" stroke="#C8DDFF" strokeWidth="5" />
        <path d="M107 216C83 234 86 251 115 248L138 233M184 233 205 248C233 252 239 236 213 216" fill="#739BE8" />
        <path d="M99 145C73 143 56 163 61 182 66 193 80 179 94 178" fill="#96B9F6" />
        {["welcome", "healthy"].includes(pose) ? (
          <g className="terrence-wave"><path d="M220 149C244 143 248 116 260 119 273 123 264 160 244 176L222 179" fill="#96B9F6" /><path d="m266 99 7-9m-25 10-1-12" stroke="#739BE8" /></g>
        ) : <path d="M220 148C242 144 262 160 257 179 254 192 239 179 224 179" fill="#96B9F6" />}
        <path d="M89 160C89 121 103 97 131 90L137 76 152 85 163 72 174 85 190 78 195 94C224 105 233 131 233 164L229 200C225 226 202 239 161 239 117 239 93 225 90 201Z" fill="#96B9F6" />
        <path d="M113 185C116 165 136 156 161 156 189 156 210 170 210 192 210 216 191 229 161 229 130 229 111 215 113 185Z" fill="#DCEAFF" stroke="none" />
        <g className="terrence-face">
          {pose === "healthy" ? <path d="M123 143q8-12 16 0m45 0q8-12 16 0" /> : <><ellipse cx="132" cy="142" rx="5" ry="8" fill="#233654" stroke="none" /><ellipse cx="190" cy="142" rx="5" ry="8" fill="#233654" stroke="none" /></>}
          <ellipse cx="115" cy="157" rx="10" ry="5" fill="#739BE8" stroke="none" /><ellipse cx="207" cy="157" rx="10" ry="5" fill="#739BE8" stroke="none" />
          {["failed", "lost"].includes(pose) ? <path d="M151 174q10-9 20 0" /> : <path d="M151 166q10 12 20 0" />}
          {pose === "failed" && <path d="m124 122 14 5m45 0 14-5" />}
        </g>
        {pose === "empty" && <g><path d="m109 197 51-17 51 17v39l-51 20-51-20Z" fill="#FAE4B5" /><path d="m109 197 51 20 51-20m-51 20v39m-51-59-17 15 50 21 18-16 18 16 50-21-17-15" fill="#FFF1D5" /><path d="m143 186 51 19" /></g>}
        {pose === "healthy" && <g><circle cx="222" cy="213" r="28" fill="#D7F0E6" /><path d="m209 213 9 9 17-19" stroke="#27715B" strokeWidth="5" /></g>}
        {pose === "failed" && <g><rect x="123" y="194" width="76" height="55" rx="8" fill="#FFF0EE" /><path d="m151 211 20 20m0-20-20 20" stroke="#B94A47" strokeWidth="5" /></g>}
        {pose === "lost" && <g><path d="m101 194 39-11 40 15 40-11v55l-40 11-40-15-39 11Z" fill="#FFF1D5" /><path d="M140 183v55m40-40v55" stroke="#C7A76B" /><path d="m238 90 1-4c2-9 18-9 18 2 0 7-10 7-10 15m0 10v1" stroke="#739BE8" strokeWidth="5" /></g>}
        {pose === "maintenance" && <g><path d="M106 113c0-30 18-47 54-47s54 17 54 47" fill="#FAE4B5" /><path d="M99 113h123M150 71v28m20-28v28" stroke="#B38A43" /><path d="m199 208 36-36c-4-10 2-21 12-24l-1 13 10 4 8-10c5 13-3 25-15 24l-35 40Z" fill="#E4EAF3" /></g>}
        {pose === "guide" && <g><path d="M108 192q27-9 52 5 25-14 52-5v48q-27-9-52 5-25-14-52-5Z" fill="#FFF1D5" /><path d="M160 197v48m-39-39 24 3m-24 10 24 3m31-13 24-3m-24 16 24-3" stroke="#B38A43" strokeWidth="3" /></g>}
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
