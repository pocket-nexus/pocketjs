// Verify the live hero with isolated Chrome. Screenshots stay in ignored dist/.
// Start site/preview.ts, then run: bun site/verify-hero.ts [base URL]
import { mkdirSync } from "node:fs";
const base = process.argv[2] ?? "http://127.0.0.1:4173/";
const output = new URL("../dist/handheld-models/", import.meta.url).pathname;
mkdirSync(output, { recursive: true });
const probe = `(async () => {
  const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
  const roots = [...document.querySelectorAll('.hero [data-handheld]')];
  for (let i=0; i<300 && roots.some(root=>!root.dataset.demo); i++) await sleep(100);
  if (roots.length!==2 || roots.some(root=>!root.dataset.demo)) throw Error('Both hero devices must boot');
  await sleep(1600);
  const order = [...document.querySelectorAll('.hero .pe-entry')].map(link=>link.dataset.openApp);
  if (order.join(',')!=='pspman,pocket-shell,openstrike,pocket-voxel') throw Error('Unexpected hero case order');
  if (document.querySelectorAll('#motion [data-pocket-stage]').length!==1 || !document.querySelector('#motion [data-motion-stage]')) throw Error('Keep the original PSP in Motion');
  for (const [index,root] of roots.entries()) {
    const canvas = root.querySelector('[data-stage-canvas]'), rect=canvas.getBoundingClientRect();
    if (rect.left<0 || rect.right>document.documentElement.clientWidth+1) throw Error('Device viewport extends outside page');
    if (root.querySelector('figcaption>span')) throw Error('Remove the demo subtitle below the model');
    const name=['Nintendo 3DS','PS Vita'][index];
    if (root.querySelector('h3').textContent!==name || canvas.getAttribute('aria-label')!==name) throw Error('Use the short device name');
    if (root.querySelector('figcaption button,figcaption svg,details,summary,input,[data-device-view]')) throw Error('Only show the device name below the model');
  }
  document.querySelector('.hero .pe-entry').click();
  if (!document.querySelector('#try-pspman').open) throw Error('First case must open PSPMAN');
  document.querySelector('#try-pspman').close();
  document.activeElement?.blur();
  // Freeze the background video for visual inspection.
  const video=document.querySelector('.hero video');video.pause();video.currentTime=0;
  await sleep(250);
  const rect=selector=>document.querySelector(selector).getBoundingClientRect().toJSON();
  return {order,hero:rect('.hero'),text:rect('.hero .col'),pair:rect('.hero-handhelds'),
    devices:roots.map(root=>({id:root.dataset.handheld,ready:root.dataset.ready,rect:root.getBoundingClientRect().toJSON()})),
    loadedModels:performance.getEntriesByType('resource').filter(e=>e.decodedBodySize>0 && new URL(e.name).pathname.endsWith('.glb')).map(e=>e.name)};
})()`;
for (const size of ["desktop", "mobile"]) {
  const mobile = size === "mobile";
  const screenshot = `${output}hero-${size}.png`;
  const child = Bun.spawn(["bun", new URL("./verify.ts", import.meta.url).pathname, base, "1000", probe], {
    env: { ...process.env, WIDTH: mobile ? "390" : "1440", HEIGHT: mobile ? "844" : "960", MOBILE: mobile ? "1" : "",
      SHOT: screenshot, POCKETJS_VERIFY_SELECTOR: ".hero", POCKETJS_VERIFY_CDP_TIMEOUT: "60000" },
    stdout: "pipe", stderr: "inherit",
  });
  const result = await new Response(child.stdout).text();
  if (await child.exited !== 0) throw Error(`${size} verification failed`);
  const report = JSON.parse(result);
  await Bun.write(`${output}hero-${size}-receipt.json`, result);
  const completed = new Set(report.probe.loadedModels.map((url: string) => `net::ERR_ABORTED: ${url} (type=Fetch, canceled=true)`));
  if (report.pageErrors.length || report.consoleErrors.length || report.networkErrors.some((error: string) => !completed.has(error))) {
    throw Error(`${size} reported browser errors: ${result}`);
  }
  console.log(`${size}: passed → ${screenshot}`);
}
