// Headless Chrome run of the wasm host: screenshot the textures, sample the analyser, read the demo's
// report. Needs playwright-core: PLAYWRIGHT_FROM=<a package.json beside its node_modules>.
//   node apps/game2d-pack-demo/verify/web-check.mjs http://127.0.0.1:8150/ <out-dir> [speed]
import { createRequire } from "node:module";
import { mkdirSync, writeFileSync } from "node:fs";

const [url, out, speed = "1"] = process.argv.slice(2);
mkdirSync(out, { recursive: true });
const { chromium } = createRequire(process.env.PLAYWRIGHT_FROM)("playwright-core");
const browser = await chromium.launch({ channel: "chrome", headless: true, args: ["--autoplay-policy=no-user-gesture-required"] });
const page = await browser.newPage({ viewport: { width: 1000, height: 600 } });
const logs = [];
page.on("console", (m) => logs.push(`[${m.type()}] ${m.text()}`));
page.on("pageerror", (e) => logs.push(`[pageerror] ${e.message}`));
page.on("response", (r) => { if (r.status() >= 400) logs.push(`[http ${r.status()}] ${r.url()}`); });
try {
  await page.goto(`${url}?speed=${speed}`);
  await page.waitForFunction(() => window.__demo?.frame >= 150, null, { timeout: 60000 });
  await page.locator("canvas").screenshot({ path: `${out}/web-textures.png` });
  const phases = [];
  for (const frame of [600, 1000, 1500, 3000, 4800]) {
    await page.waitForFunction((f) => window.__demo.frame >= f, frame, { timeout: 240000 });
    phases.push(await page.evaluate(() => ({ frame: __demo.frame, rms: __demo.rms })));
  }
  await page.waitForFunction(() => window.__demoReport, null, { timeout: 240000 });
  await page.waitForTimeout(500);
  const result = await page.evaluate(() => ({
    frame: __demo.frame, errors: __demo.errors, rmsPeak: __demo.rmsPeak, rmsEnd: __demo.rms,
    report: window.__demoReport,
  }));
  result.phases = phases;
  result.logs = logs;
  writeFileSync(`${out}/web-report.json`, JSON.stringify(result, null, 2));
  console.log(JSON.stringify(result, null, 1));
} finally {
  await browser.close();
}
