import { cn } from "@/lib/utils";
import { OpenTofuMark, TerraformMark } from "./EngineMarks";

export type TerrencePose = "welcome" | "empty" | "healthy" | "failed" | "lost" | "maintenance" | "guide" | "blocked" | "interrupted" | "ecosystem";
export type TerrenceDetail = "full" | "small";
export type TerrenceSurface = "paper" | "transparent";

function Ears({ pose, small }: Readonly<{ pose: TerrencePose; small: boolean }>): React.JSX.Element {
  const angles: Partial<Record<TerrencePose, readonly [number, number]>> = {
    welcome: [4, -4], ecosystem: [4, -4], healthy: [5, -5], failed: [-22, 22], lost: [-18, -5], interrupted: [-8, 8],
  };
  const [left, right] = angles[pose] ?? [0, 0];
  return <g className="terrence-ears">
    <g className="terrence-ear-left" transform={`rotate(${left} 110 100)`}>
      <path d="M105 104 79 83 79 48 106 48 116 89" fill="#739BE8" />
      {!small && <path className="terrence-secondary-detail" d="M88 73V58H101" stroke="#C8DDFF" strokeWidth="5" />}
    </g>
    <g className="terrence-ear-right" transform={`rotate(${right} 207 100)`}>
      <path d="M212 104 239 83 239 48 212 48 201 89" fill="#739BE8" />
      {!small && <path className="terrence-secondary-detail" d="M230 73V58H217" stroke="#C8DDFF" strokeWidth="5" />}
    </g>
  </g>;
}

/** A short flipper folds over the edge of a prop. Its open root blends into the
 * body; the outlined tip stays in front of the object in both detail tiers. */
function Paw({ right = false, inset = false }: Readonly<{ right?: boolean; inset?: boolean }>): React.JSX.Element {
  const contour = "M94 180C83 181 80 192 87 201 94 210 109 215 119 209 125 205 121 197 114 195L104 187";
  const offset = inset ? 8 : 0;
  return <g className="terrence-paw" transform={right ? `translate(${322 - offset} 0) scale(-1 1)` : `translate(${offset} 0)`}>
    <path d={`${contour}Z`} fill="#96B9F6" stroke="none" />
    <path d={contour} />
  </g>;
}

function HeldProp({ pose, small }: Readonly<{ pose: TerrencePose; small: boolean }>): React.JSX.Element | null {
  switch (pose) {
    case "empty":
      return <g className="terrence-prop" data-prop="box" transform="translate(0 5)" strokeWidth="3">
        <path d="m112 201 48-18-12-12-48 18Zm48-18 48 18 12-12-48-18Z" fill="#FAE4B5" />
        <path d="m112 201 48-18 48 18v34l-48 18-48-18Z" fill="#E4C48A" />
        <path d="m112 201 48 18 48-18-48-18Z" fill="#B38A43" />
        <path d="m160 219 48-18v34l-48 18Z" fill="#FAE4B5" />
        <path d="m112 201 48 18-12 13-48-18Zm48 18 48-18 12 13-48 18Z" fill="#FFF1D5" />
      </g>;
    case "healthy":
      return <g className="terrence-prop" data-prop="check">
        <rect x="110" y="187" width="102" height="58" rx="12" fill="#D7F0E6" />
        <path d="m144 215 12 12 23-25" stroke="#27715B" strokeWidth="5" />
      </g>;
    case "failed":
      return <g className="terrence-prop" data-prop="diagnostic">
        <rect x="110" y="187" width="102" height="58" rx="12" fill="#FFF0EE" />
        <path d="m150 205 22 22m0-22-22 22" stroke="#B94A47" strokeWidth="5" />
      </g>;
    case "lost":
      return <g className="terrence-prop" data-prop="map" strokeWidth="3">
        <path d="m107 192 36-10 36 13 36-10v54l-36 10-36-13-36 10Z" fill="#FFF1D5" />
        <path d="m143 182 36 13v54l-36-13Z" fill="#FAE4B5" />
        {!small && <path className="terrence-secondary-detail" d="m123 221 12-9 19 13 15-16 27 10" stroke="#B38A43" strokeDasharray="2 6" />}
      </g>;
    case "guide":
      return <g className="terrence-prop" data-prop="book" strokeWidth="3">
        <path d="M108 192q27-9 53 5 26-14 53-5v48q-27-9-53 5-26-14-53-5Z" fill="#FFF1D5" />
        <path d="M161 197v48" stroke="#B38A43" />
        {!small && <path className="terrence-secondary-detail" d="m128 207 18 3m-18 10 18 3m30-13 18-3m-18 16 18-3" stroke="#B38A43" strokeWidth="2.5" />}
      </g>;
    case "blocked":
      return <g className="terrence-prop" data-prop="lock">
        <path d="M144 200v-3a17 17 0 0 1 34 0v3" stroke="#B38A43" strokeWidth="6" />
        <rect x="120" y="198" width="82" height="48" rx="10" fill="#FAE4B5" />
        <circle cx="161" cy="216" r="4" fill="#233654" stroke="none" />
        <path d="M161 219v8" strokeWidth="4" />
      </g>;
    case "interrupted":
      return <g className="terrence-prop" data-prop="cable">
        <path d="M109 219c-23 0-38 8-38 22m142-22c23 0 38 8 38 22" strokeWidth="5" />
        <path d="M109 219c-23 0-38 8-38 22m142-22c23 0 38 8 38 22" stroke="#739BE8" strokeWidth="2" />
        <path d="M145 204h9m-9 12h9" strokeWidth="3" />
        <path d="M112 196h33v29h-33a8 8 0 0 1-8-8v-13a8 8 0 0 1 8-8Zm98 0h-31v29h31a8 8 0 0 0 8-8v-13a8 8 0 0 0-8-8Z" fill="#E4EAF3" />
        <path d="M179 203v15" strokeWidth="5" />
      </g>;
    case "maintenance":
      return <Maintenance small={small} />;
    case "welcome":
    case "ecosystem":
      return null;
  }
}

function Wrench(): React.JSX.Element {
  return <g className="terrence-prop" data-prop="wrench">
    <path d="m234 210 14-40c-9-7-9-19 0-26l1 13 12 4 8-10c5 12-2 23-13 23l-13 40Z" fill="#E4EAF3" />
    <g className="terrence-paw">
      <path d="M228 171c10-5 19-2 22 5 3 8-3 15-11 14l-13-5Z" fill="#96B9F6" stroke="none" />
      <path d="M228 171c10-5 19-2 22 5 3 8-3 15-11 14l-13-5" />
    </g>
  </g>;
}

function Maintenance({ small }: Readonly<{ small: boolean }>): React.JSX.Element {
  return <>
    <g data-prop="hat">
      <path d="M106 113c0-30 18-47 54-47s54 17 54 47" fill="#FAE4B5" />
      <path d="M99 113h123" stroke="#B38A43" />
      {!small && <path className="terrence-secondary-detail" d="M150 71v28m20-28v28" stroke="#B38A43" />}
    </g>
    <Wrench />
  </>;
}

function Face({ pose }: Readonly<{ pose: TerrencePose }>): React.JSX.Element {
  const neutral = pose === "blocked" || pose === "interrupted";
  const sad = pose === "failed" || pose === "lost";
  return <g className="terrence-face">
    <g className="terrence-eyes" transform={pose === "guide" || pose === "empty" ? "translate(0 3)" : undefined}>
      {pose === "healthy" ? <path d="M123 143q8-12 16 0m45 0q8-12 16 0" /> : <><ellipse cx="132" cy="142" rx="5" ry="8" fill="#233654" stroke="none" /><ellipse cx="190" cy="142" rx="5" ry="8" fill="#233654" stroke="none" /></>}
    </g>
    <ellipse cx="115" cy="157" rx="10" ry="5" fill="#739BE8" stroke="none" /><ellipse cx="207" cy="157" rx="10" ry="5" fill="#739BE8" stroke="none" />
    <path d={neutral ? "M151 171h20" : sad ? "M151 174q10-9 20 0" : "M151 166q10 12 20 0"} />
    {pose === "failed" && <path d="m124 126 14-3m45 0 14 3" />}
  </g>;
}

function BackFlippers({ pose, small }: Readonly<{ pose: TerrencePose; small: boolean }>): React.JSX.Element {
  const waving = pose === "welcome" || pose === "ecosystem";
  return <>
    {(waving || pose === "maintenance") && <path d="M99 145C73 143 56 163 61 182 66 193 80 179 94 178" fill="#96B9F6" />}
    {waving && <g className="terrence-wave">
      <path d="M220 149C244 143 248 116 260 119 273 123 264 160 244 176L222 179" fill="#96B9F6" />
      {!small && <path className="terrence-secondary-detail" d="m266 99 7-9m-25 10-1-12" stroke="#739BE8" />}
    </g>}
  </>;
}

const poseTransforms: Partial<Record<TerrencePose, string>> = {
  welcome: "rotate(3 161 244)",
  ecosystem: "rotate(3 161 244)",
  lost: "rotate(-3 161 244)",
  failed: "translate(161 244) scale(1.025 .96) translate(-161 -244)",
};

/** One rounded creature, short flippers, flat fills. Adjacent text carries the
 * state; small illustrations omit only secondary decoration, never the grip. */
export function Terrence({ pose = "welcome", className, animated = false, detail = "full", surface = "transparent" }: Readonly<{
  pose?: TerrencePose;
  className?: string;
  animated?: boolean;
  detail?: TerrenceDetail;
  surface?: TerrenceSurface;
}>): React.JSX.Element {
  const small = detail === "small";
  const centralProp = !["welcome", "maintenance", "ecosystem"].includes(pose);
  return <svg viewBox="0 0 320 280" fill="none" aria-hidden="true" focusable="false"
    className={cn("terrence-mascot", animated && "terrence-mascot--animated", className)} data-pose={pose} data-detail={detail} data-surface={surface}>
    {surface === "paper" && <rect className="terrence-backplate" x="8" y="8" width="304" height="264" rx="28" fill="#EDF3FF" />}
    {!small && <ellipse className="terrence-secondary-detail" cx="159" cy="252" rx="86" ry="10" fill="currentColor" opacity=".07" />}
    {pose === "ecosystem" && <path className="terrence-orbit terrence-orbit--back" d="M14 170a146 62 0 0 1 292 0" transform="rotate(-18 160 170)" stroke="#A7BFDF" strokeWidth="1" strokeDasharray="4 6" />}
    <g className="terrence-body" stroke="#233654" strokeWidth="4" strokeLinecap="round" strokeLinejoin="round">
      <g className="terrence-pose" transform={poseTransforms[pose]}>
        <Ears pose={pose} small={small} />
        <path d="M107 216C83 234 86 251 115 248L138 233M184 233 205 248C233 252 239 236 213 216" fill="#739BE8" />
        <BackFlippers pose={pose} small={small} />
        <path d="M89 160C89 121 103 97 131 90L137 76 152 85 163 72 174 85 190 78 195 94C224 105 233 131 233 164L229 200C225 226 202 239 161 239 117 239 93 225 90 201Z" fill="#96B9F6" />
        <path d="M113 185C116 165 136 156 161 156 189 156 210 170 210 192 210 216 191 229 161 229 130 229 111 215 113 185Z" fill="#DCEAFF" stroke="none" />
        <Face pose={pose} />
        {pose === "lost" && !small && <path className="terrence-secondary-detail" d="m238 90 1-4c2-9 18-9 18 2 0 7-10 7-10 15m0 10v1" stroke="#739BE8" strokeWidth="5" />}
        <HeldProp pose={pose} small={small} />
        {centralProp && <><Paw inset={pose === "blocked"} /><Paw right inset={pose === "blocked"} /></>}
      </g>
    </g>
    {pose === "ecosystem" && <g data-prop="engine-marks">
      <path className="terrence-orbit terrence-orbit--front" d="M14 170a146 62 0 0 0 292 0" transform="rotate(-18 160 170)" stroke="#536785" strokeWidth="1" strokeDasharray="4 6" />
      <g transform="rotate(-8 31 133)"><svg x="9" y="110" width="44" height="48"><TerraformMark /></svg></g>
      <g transform="rotate(7 289 207)"><svg x="268" y="184" width="42" height="46"><OpenTofuMark /></svg></g>
    </g>}
  </svg>;
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
