import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import type { BrowserPage } from "./browser";

export type ImageDiffOptions = {
  maxDiffPercentage?: number;
  colorThreshold?: number;
  updateSnapshots?: boolean;
}

export type ImageDiffResult = {
  match: boolean;
  diffPixels: number;
  totalPixels: number;
  diffPercentage: number;
}

export async function compareScreenshots(
  page: BrowserPage,
  actualBuffer: Buffer,
  baselinePath: string,
  options: ImageDiffOptions = {},
): Promise<ImageDiffResult> {
  const shouldUpdate = options.updateSnapshots === true || process.env.UPDATE_SNAPSHOTS === "true";
  const maxDiffPercentage = options.maxDiffPercentage ?? 0.1;
  const colorThreshold = options.colorThreshold ?? 5;

  if (!existsSync(baselinePath) || shouldUpdate) {
    mkdirSync(dirname(baselinePath), { recursive: true });
    writeFileSync(baselinePath, actualBuffer);
    return {
      match: true,
      diffPixels: 0,
      totalPixels: 0,
      diffPercentage: 0,
    };
  }

  const baselineBuffer = readFileSync(baselinePath);

  // Exact binary match fast-path
  if (actualBuffer.equals(baselineBuffer)) {
    return {
      match: true,
      diffPixels: 0,
      totalPixels: 0,
      diffPercentage: 0,
    };
  }

  // Canvas-based pixel diff inside the browser
  const actualB64 = actualBuffer.toString("base64");
  const baselineB64 = baselineBuffer.toString("base64");

  const diffResult = await page.evaluate<ImageDiffResult>(`
    (async () => {
      const loadImg = (b64) => new Promise((resolve, reject) => {
        const img = new Image();
        img.onload = () => resolve(img);
        img.onerror = reject;
        img.src = "data:image/png;base64," + b64;
      });

      const actualImg = await loadImg(${JSON.stringify(actualB64)});
      const baselineImg = await loadImg(${JSON.stringify(baselineB64)});

      const width = Math.max(actualImg.width, baselineImg.width);
      const height = Math.max(actualImg.height, baselineImg.height);
      const totalPixels = width * height;

      if (actualImg.width !== baselineImg.width || actualImg.height !== baselineImg.height) {
        return {
          match: false,
          diffPixels: totalPixels,
          totalPixels,
          diffPercentage: 100,
        };
      }

      const canvas = document.createElement("canvas");
      canvas.width = width;
      canvas.height = height;
      const ctx = canvas.getContext("2d", { willReadFrequently: true });
      if (!ctx) throw new Error("Could not acquire 2D canvas context");

      ctx.drawImage(actualImg, 0, 0);
      const actualData = ctx.getImageData(0, 0, width, height).data;

      ctx.clearRect(0, 0, width, height);
      ctx.drawImage(baselineImg, 0, 0);
      const baselineData = ctx.getImageData(0, 0, width, height).data;

      let diffPixels = 0;
      const threshold = ${JSON.stringify(colorThreshold)};

      for (let i = 0; i < actualData.length; i += 4) {
        const dr = Math.abs(actualData[i] - baselineData[i]);
        const dg = Math.abs(actualData[i + 1] - baselineData[i + 1]);
        const db = Math.abs(actualData[i + 2] - baselineData[i + 2]);
        const da = Math.abs(actualData[i + 3] - baselineData[i + 3]);

        if (dr > threshold || dg > threshold || db > threshold || da > threshold) {
          diffPixels++;
        }
      }

      const diffPercentage = (diffPixels / totalPixels) * 100;
      const match = diffPercentage <= ${JSON.stringify(maxDiffPercentage)};

      return {
        match,
        diffPixels,
        totalPixels,
        diffPercentage,
      };
    })()
  `);

  return diffResult;
}
