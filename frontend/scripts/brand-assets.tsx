import { mkdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { renderToStaticMarkup } from "react-dom/server";
import { Terrence, TerrenceLogo, type TerrencePose } from "../src/components/brand/Terrence";

// Export the component's exact geometry so downloadable art never drifts.
const publicDir = resolve(import.meta.dir, "../public");
mkdirSync(`${publicDir}/brand`, { recursive: true });
const poses: TerrencePose[] = ["welcome", "empty", "healthy", "failed", "lost", "maintenance", "guide"];
for (const pose of poses) {
  const svg = renderToStaticMarkup(<Terrence pose={pose} />).replace('<svg ', '<svg xmlns="http://www.w3.org/2000/svg" ');
  writeFileSync(`${publicDir}/brand/terrence-${pose}.svg`, svg);
}
const logo = /<svg[\s\S]*<\/svg>/.exec(renderToStaticMarkup(<TerrenceLogo />))?.[0];
if (logo === undefined) throw new Error("Logo SVG is missing");
writeFileSync(`${publicDir}/favicon.svg`, logo.replace('<svg ', '<svg xmlns="http://www.w3.org/2000/svg" '));
const labels: Record<TerrencePose, string> = { welcome: "Welcome", empty: "No workspaces yet", healthy: "Everything healthy", failed: "Plan failed", lost: "404", maintenance: "Maintenance", guide: "Docs & tutorials" };
writeFileSync(`${publicDir}/brand/index.html`, `<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Terrence · Visual language</title><style>
*{box-sizing:border-box}body{margin:0;background:#edf3ff;color:#233654;font:15px/1.6 system-ui,sans-serif}main{max-width:1160px;margin:auto;padding:48px 24px}header{display:flex;gap:20px;align-items:center;margin-bottom:40px}header svg{width:56px;height:56px}h1{margin:0;font:700 32px/1.2 'Trebuchet MS',sans-serif;letter-spacing:-1px}p{margin:8px 0;color:#536785}.poses{display:grid;grid-template-columns:repeat(auto-fit,minmax(220px,1fr));gap:16px}figure{margin:0;padding:24px;background:#fff;border:1px solid #c9d9f2;border-radius:16px}figure img{width:100%;height:185px}figcaption{margin-top:16px;font-weight:600}a{color:#234f95;text-underline-offset:4px}a:focus-visible{outline:2px solid #233654;outline-offset:4px}footer{margin-top:32px;max-width:720px}</style><main><header>${logo}<div><h1>terrence.</h1><p>One dependable companion. Seven moments.</p></div></header><div class="poses">${poses.map((pose): string => `<figure><img src="terrence-${pose}.svg" alt="Terrence: ${labels[pose]}"><figcaption>${labels[pose]}</figcaption><a href="terrence-${pose}.svg" download>Download SVG</a></figure>`).join("")}</div><footer><p>Bracket ears. Blue coat. Steady hands. Keep the character consistent and use illustrations sparingly, alongside a clear explanation and a useful next step.</p><p>Ink #233654 · Blue #96B9F6 · Paper #EDF3FF · Line #C9D9F2</p></footer></main></html>`);
