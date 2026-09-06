import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { renderToStaticMarkup } from "react-dom/server";
import { Terrence, TerrenceLogo, type TerrencePose, type TerrenceSurface } from "../src/components/brand/Terrence";
import { verifyBrandIcons } from "./brand-icons";

// Export the component's exact geometry so downloadable art never drifts.
const publicDir = resolve(import.meta.dir, "../public");
const check = process.argv.includes("--check");
if (!check) mkdirSync(`${publicDir}/brand`, { recursive: true });

function publish(path: string, contents: string): void {
  if (check) {
    if (readFileSync(path, "utf8") !== contents) throw new Error(`Stale brand asset: ${path}. Run frontend/scripts/brand-assets.tsx.`);
  } else {
    writeFileSync(path, contents);
  }
}

function assertSafeSvg(svg: string, label: string): void {
  if (/<script\b|<metadata\b|(?:xlink:)?href\s*=|url\(/i.test(svg)) {
    throw new Error(`Unsafe external content in generated SVG: ${label}`);
  }
  const ids = [...svg.matchAll(/\bid="([^"]+)"/g)].map((match): string => match[1] ?? "");
  if (new Set(ids).size !== ids.length) throw new Error(`Duplicate SVG IDs in generated asset: ${label}`);
}

function poseSvg(pose: TerrencePose, surface: TerrenceSurface = "transparent"): string {
  const svg = renderToStaticMarkup(<Terrence pose={pose} surface={surface} />).replace("<svg ", '<svg xmlns="http://www.w3.org/2000/svg" ');
  assertSafeSvg(svg, pose);
  return svg;
}

function logoSvg(): string {
  const logo = /<svg[\s\S]*<\/svg>/.exec(renderToStaticMarkup(<TerrenceLogo />))?.[0];
  if (logo === undefined) throw new Error("Logo SVG is missing");
  const svg = logo.replace("<svg ", '<svg xmlns="http://www.w3.org/2000/svg" ');
  assertSafeSvg(svg, "favicon");
  return svg;
}

const poses: TerrencePose[] = ["welcome", "empty", "healthy", "failed", "lost", "maintenance", "guide", "blocked", "interrupted"];
const labels: Record<TerrencePose, string> = {
  welcome: "Welcome",
  empty: "No workspaces yet",
  healthy: "Everything healthy",
  failed: "Plan failed",
  lost: "404",
  maintenance: "Maintenance",
  guide: "Docs & tutorials",
  blocked: "Access blocked",
  interrupted: "Connection interrupted",
};
const logo = logoSvg();

for (const pose of poses) publish(`${publicDir}/brand/terrence-${pose}.svg`, poseSvg(pose));
publish(`${publicDir}/favicon.svg`, logo);

const gallery = `<!doctype html>
<html lang="en">
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Terrence · Visual language</title>
<style>
*{box-sizing:border-box}
:root{color-scheme:light dark}
body{margin:0;background:#edf3ff;color:#233654;font:15px/1.6 system-ui,sans-serif}
main{max-width:1240px;margin:auto;padding:40px 24px 64px}
header{display:flex;gap:20px;align-items:center;margin-bottom:32px}
header svg{width:56px;height:56px}
h1{margin:0;font:700 32px/1.2 'Trebuchet MS',sans-serif;letter-spacing:-1px}
h2{margin:0;font:700 19px/1.25 'Trebuchet MS',sans-serif}
p{margin:8px 0;color:#536785}
.intro{max-width:760px;margin-bottom:28px}
.poses{display:grid;grid-template-columns:repeat(auto-fit,minmax(340px,1fr));gap:18px}
.pose-card{padding:20px;background:#fff;border:1px solid #c9d9f2;border-radius:16px}
.fixture-row{display:flex;flex-wrap:wrap;align-items:end;gap:12px;margin-top:16px}
.fixture{display:grid;justify-items:center;gap:5px;margin:0}
.fixture figcaption{font:12px/1.2 ui-monospace,monospace;color:#536785}
.art-frame{display:grid;place-items:center;border-radius:12px;background:#fff;overflow:hidden}
.art-frame svg{display:block;width:100%;height:100%}
.size-96{width:96px;height:84px}.size-128{width:128px;height:112px}.size-176{width:176px;height:154px}
.surface-dark{padding:10px;background:#1b2639;border-radius:12px}
.surface-dark .art-frame{background:#1b2639}
.fixture-copy{max-width:36rem;margin:16px 0 0;font-size:13px}
.logo-fixtures{display:flex;flex-wrap:wrap;align-items:end;gap:16px;margin-top:16px}
.logo-fixture{display:grid;gap:5px;justify-items:center}.logo-fixture svg{display:block}
.logo-24 svg{width:24px;height:24px}.logo-32 svg{width:32px;height:32px}.logo-40 svg{width:40px;height:40px}
.motion-fixture{display:flex;gap:16px;align-items:center;margin-top:16px;padding:16px;background:#fff;border:1px solid #c9d9f2;border-radius:12px}
.motion-fixture svg{width:96px;height:84px}
a{color:#234f95;text-underline-offset:4px}a:focus-visible{outline:2px solid #233654;outline-offset:4px}
footer{margin-top:28px;max-width:760px}
@media (prefers-reduced-motion:reduce){*,*::before,*::after{animation:none!important;transition:none!important;scroll-behavior:auto!important}}
@media (max-width:640px){main{padding:28px 16px 48px}.poses{grid-template-columns:1fr}.pose-card{padding:16px}.intro{font-size:14px}.motion-fixture{align-items:flex-start;flex-direction:column}}
@media (prefers-color-scheme:dark){body{background:#171f2e;color:#edf3ff}.pose-card,.motion-fixture{background:#202b3e;border-color:#415775}.art-frame{background:#202b3e}.surface-dark .art-frame{background:#1b2639}p,.fixture figcaption{color:#b8c9e2}a{color:#b5d1ff}}
@media (forced-colors:active){.terrence-mascot{display:none}.art-frame{border:1px solid CanvasText}}
</style>
<main>
  <header>${logo}<div><h1>terrence.</h1><p>Canonical brand regression sheet</p></div></header>
  <p class="intro">Every pose is reviewed as the same dependable companion. The fixtures below cover the approved content sizes, a dark surface, long adjacent explanation text, narrow layouts, reduced motion, and the compact mark used by navigation and install icons.</p>
  <div class="poses">${poses.map((pose): string => `
    <section class="pose-card" data-pose="${pose}">
      <h2>${labels[pose]}</h2>
      <div class="fixture-row">${[96, 128, 176].map((size): string => `<figure class="fixture"><div class="art-frame size-${size}">${poseSvg(pose)}</div><figcaption>${size}px</figcaption></figure>`).join("")}</div>
      <div class="fixture-row surface-dark"><figure class="fixture"><div class="art-frame size-128">${poseSvg(pose, "paper")}</div><figcaption>128px · dark surface</figcaption></figure></div>
      <p class="fixture-copy">${labels[pose]} art stays decorative. The adjacent copy owns the state, explains what happened, and provides the useful next step without relying on the illustration or its color.</p>
    </section>`).join("")}</div>
  <section class="pose-card" aria-labelledby="logo-fixtures-title">
    <h2 id="logo-fixtures-title">Logo and motion</h2>
    <div class="logo-fixtures"><figure class="logo-fixture logo-24">${renderToStaticMarkup(<TerrenceLogo />)}<figcaption>24px</figcaption></figure><figure class="logo-fixture logo-32">${renderToStaticMarkup(<TerrenceLogo />)}<figcaption>32px</figcaption></figure><figure class="logo-fixture logo-40">${renderToStaticMarkup(<TerrenceLogo />)}<figcaption>40px</figcaption></figure></div>
    <div class="motion-fixture">${poseSvg("welcome")}<div><strong>Opt-in motion</strong><p>The welcome arm may breathe and wave when motion is enabled. The reduced-motion media query disables animation before the primary explanation or action is affected.</p></div></div>
  </section>
  <footer><p>Ink #233654 · Blue #96B9F6 · Paper #EDF3FF · Line #C9D9F2 · Caption #536785</p><p>Source: <code>frontend/src/components/brand/Terrence.tsx</code>. Generated output is checked in CI; update the component and regenerate the assets together.</p></footer>
</main>
</html>`;
publish(`${publicDir}/brand/index.html`, gallery);

// Keep the no-JavaScript server fallback self-contained and on-model.
const fallback = `${publicDir}/404.html`;
publish(fallback, readFileSync(fallback, "utf8")
  .replace(/<!-- terrence-lost -->[\s\S]*?<!-- \/terrence-lost -->/, `<!-- terrence-lost -->${poseSvg("lost")}<!-- /terrence-lost -->`)
  .replace(/<!-- terrence-logo -->[\s\S]*?<!-- \/terrence-logo -->/, `<!-- terrence-logo -->${logo}<!-- /terrence-logo -->`));

if (check) verifyBrandIcons(publicDir);
