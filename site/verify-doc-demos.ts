// Browser regression for the live docs demos (`:::demo <app>`).
// Run after site:build. By default this owns an isolated local server; set
// POCKETJS_PLAYGROUND_URL only when intentionally verifying an existing one.
//
// The Playground verifier injects PSP button bits. A docs demo takes POINTER
// input instead, so this one dispatches a scripted pointer drag onto the
// visible canvas and checks that the contacts reached the guest: packed
// contacts counted on the wire, a non-zero bounds hit fact resolved through
// the AppInstance realm, and a framebuffer that moved because of them.

import { createServer } from "node:net";
import { readFileSync, readdirSync, existsSync } from "node:fs";
import { join } from "node:path";

interface DemoProbe {
  app: string;
  state: string;
  status: string | null;
  canvasW: number;
  canvasH: number;
  expectedW: number;
  expectedH: number;
  /** Did the IntersectionObserver start the frame loop. */
  started: boolean;
  /** Frames the ambient rAF loop managed on its own (0 in headless Chrome). */
  framesRun: number;
  nonblackPct: number;
  /** Did a scripted tap move the framebuffer at any probed point. */
  tapMoved: boolean;
  /** Logical y the scripted drag moved pixels at, or -1 if none did. */
  dragAtY: number;
  baseHash: number;
  dragHash: number;
  contactsSeen: number;
  maxHit: number;
  error: string | null;
}

interface PageProbe {
  demos: DemoProbe[];
  found: number;
  error: string | null;
}

interface VerifyReport {
  probe: PageProbe;
  pageErrors: string[];
  consoleErrors: string[];
  networkErrors: string[];
}

const ROOT = join(import.meta.dir, "..");
const DIST = join(ROOT, "site/dist");
let BASE_URL = "";
let ownedServer: ReturnType<typeof Bun.spawn> | null = null;
let activeVerifier: ReturnType<typeof Bun.spawn> | null = null;
let cleanupPromise: Promise<void> | null = null;

function cleanup(): Promise<void> {
  cleanupPromise ??= (async () => {
    if (activeVerifier?.exitCode === null) activeVerifier.kill();
    if (activeVerifier) await activeVerifier.exited;
    activeVerifier = null;
    if (ownedServer?.exitCode === null) ownedServer.kill();
    if (ownedServer) await ownedServer.exited;
    ownedServer = null;
  })();
  return cleanupPromise;
}
const onSigterm = () => void cleanup().finally(() => process.exit(143));
const onSigint = () => void cleanup().finally(() => process.exit(130));
process.once("SIGTERM", onSigterm);
process.once("SIGINT", onSigint);

/** Every built docs page carrying at least one `[data-doc-demo]` figure. */
function pagesWithDemos(): { path: string; apps: string[] }[] {
  const docs = join(DIST, "docs");
  if (!existsSync(docs)) throw new Error("site/dist/docs is missing — run: bun run site:build");
  const pages: { path: string; apps: string[] }[] = [];
  for (const slug of readdirSync(docs)) {
    const file = join(docs, slug, "index.html");
    if (!existsSync(file)) continue;
    const html = readFileSync(file, "utf8");
    if (!html.includes("data-doc-demo")) continue;
    if (!html.includes("/pg/embed.js")) {
      throw new Error(`/docs/${slug}/ embeds a demo but loads no /pg/embed.js`);
    }
    const apps = [...html.matchAll(/data-doc-demo [^>]*?data-app="([^"]+)"/g)].map((m) => m[1]);
    pages.push({ path: `/docs/${slug}/`, apps });
  }
  return pages;
}

async function unusedPort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("could not allocate a local port");
  await new Promise<void>((resolve, reject) =>
    server.close((error) => (error ? reject(error) : resolve())),
  );
  return address.port;
}

async function serverReady() {
  try {
    const response = await fetch(`${BASE_URL}/pg/embed.js`, { signal: AbortSignal.timeout(2_000) });
    return response.ok;
  } catch {
    return false;
  }
}

async function ensureServer() {
  const configured = process.env.POCKETJS_PLAYGROUND_URL;
  if (configured) {
    BASE_URL = configured.replace(/\/$/, "");
    if (!(await serverReady())) throw new Error(`${BASE_URL} does not serve /pg/embed.js`);
    return;
  }
  const port = await unusedPort();
  BASE_URL = `http://127.0.0.1:${port}`;
  const server = Bun.spawn(["bun", "site/serve.ts"], {
    cwd: ROOT,
    env: { ...process.env, PORT: String(port) },
    stdout: "ignore",
    stderr: "pipe",
  });
  ownedServer = server;
  for (let attempt = 0; attempt < 80; attempt++) {
    if (await serverReady()) return;
    if (server.exitCode !== null) {
      throw new Error(
        `site server exited before it was ready:\n${await new Response(server.stderr).text()}`,
      );
    }
    await Bun.sleep(100);
  }
  server.kill();
  await server.exited;
  throw new Error(`timed out waiting for ${BASE_URL}`);
}

// The probe runs inside the page. It drives each demo through the same public
// surface a reader does — scroll it in, let the IntersectionObserver boot it,
// then dispatch real PointerEvents at the canvas.
//
// Frames are then stepped by hand. Headless Chrome commits no compositor
// frames, so requestAnimationFrame never fires there and the ambient loop
// cannot advance the app; site/verify-playground.ts drives the Playground the
// same way. What is checked instead is that the observer DID start the loop.
//
// The drag point is searched rather than assumed: a docs demo is any app, and
// only the app knows where its content sits. An attempt that leaves the
// framebuffer untouched only means that row was empty.
const PROBE = `(async () => {
  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  const out = { demos: [], found: 0, error: null };
  try {
    const deadline = performance.now() + 15000;
    while (!globalThis.__pocketDocDemos && performance.now() < deadline) await sleep(25);
    const demos = globalThis.__pocketDocDemos ?? [];
    out.found = demos.length;
    const hash = (ctx, w, h) => {
      const data = ctx.getImageData(0, 0, w, h).data;
      let value = 2166136261;
      for (let i = 0; i < data.length; i += 4) {
        value ^= data[i]; value = Math.imul(value, 16777619);
        value ^= data[i + 1]; value = Math.imul(value, 16777619);
        value ^= data[i + 2]; value = Math.imul(value, 16777619);
      }
      return value >>> 0;
    };
    const nonblack = (ctx, w, h) => {
      const data = ctx.getImageData(0, 0, w, h).data;
      let count = 0;
      for (let i = 0; i < data.length; i += 4) {
        if (data[i] + data[i + 1] + data[i + 2] > 24) count++;
      }
      return +(100 * count / (data.length / 4)).toFixed(1);
    };
    const pointer = (canvas, type, id, x, y) => {
      const rect = canvas.getBoundingClientRect();
      canvas.dispatchEvent(new PointerEvent(type, {
        bubbles: true, cancelable: true, composed: true,
        pointerId: id, pointerType: 'touch', isPrimary: true,
        button: type === 'pointermove' ? -1 : 0,
        buttons: type === 'pointerup' || type === 'pointercancel' ? 0 : 1,
        clientX: rect.left + x, clientY: rect.top + y,
      }));
    };
    const ROWS = [0.30, 0.42, 0.20, 0.55, 0.68, 0.12, 0.86];
    for (const demo of demos) {
      const record = {
        app: demo.config.app, state: '', status: null,
        canvasW: demo.canvas.width, canvasH: demo.canvas.height,
        expectedW: demo.config.width, expectedH: demo.config.height,
        started: false, framesRun: 0, nonblackPct: 0,
        tapMoved: false, dragAtY: -1, baseHash: 0, dragHash: 0,
        contactsSeen: 0, maxHit: 0, error: null,
      };
      try {
        // 1. the reader scrolls it into view; the observers boot and start it.
        demo.figure.scrollIntoView({ block: 'center' });
        const ready = performance.now() + 20000;
        while (demo.figure.dataset.state !== 'ready' && performance.now() < ready) {
          if (demo.figure.dataset.state === 'error') break;
          await sleep(50);
        }
        record.state = demo.figure.dataset.state;
        record.status = demo.figure.querySelector('[data-doc-demo-status]')?.textContent ?? null;
        if (record.state !== 'ready') { out.demos.push(record); continue; }
        const before = demo.frames;
        await sleep(250);
        record.started = demo.running === true;
        record.framesRun = demo.frames - before;

        // 2. deterministic phase: own the clock.
        const ctx = demo.canvas.getContext('2d');
        demo.stop();
        const w = demo.config.width, h = demo.config.height;
        const contactsBefore = demo.contactsSeen;
        let id = 20;
        for (const row of ROWS) {
          const y = Math.round(h * row), x = Math.round(w * 0.5);
          // A tap first. Every touch host installs a whole-screen tap->press
          // recognizer at mount, so this reaches SOMETHING on any app and
          // walks a multi-screen demo into a screen with content on it.
          const atRest = hash(ctx, demo.canvas.width, demo.canvas.height);
          id++;
          pointer(demo.canvas, 'pointerdown', id, x, y);
          demo.stepFrames(3);
          record.maxHit = Math.max(record.maxHit, ...demo.lastHits, 0);
          pointer(demo.canvas, 'pointerup', id, x, y);
          demo.stepFrames(24);
          const base = hash(ctx, demo.canvas.width, demo.canvas.height);
          if (base !== atRest) record.tapMoved = true;

          // Then the drag this verifier exists for.
          id++;
          pointer(demo.canvas, 'pointerdown', id, x, y);
          demo.stepFrames(3);
          record.maxHit = Math.max(record.maxHit, ...demo.lastHits, 0);
          for (let i = 1; i <= 6; i++) {
            pointer(demo.canvas, 'pointermove', id, x + i * 14, y);
            demo.stepFrames(3);
            record.maxHit = Math.max(record.maxHit, ...demo.lastHits, 0);
          }
          const dragged = hash(ctx, demo.canvas.width, demo.canvas.height);
          pointer(demo.canvas, 'pointerup', id, x + 84, y);
          demo.stepFrames(8);
          if (dragged !== base) {
            record.dragAtY = y;
            record.baseHash = base;
            record.dragHash = dragged;
            break;
          }
        }
        record.contactsSeen = demo.contactsSeen - contactsBefore;
        record.nonblackPct = nonblack(ctx, demo.canvas.width, demo.canvas.height);
        demo.start();
      } catch (error) {
        record.error = String(error && error.stack || error);
      }
      out.demos.push(record);
    }
  } catch (error) {
    out.error = String(error && error.stack || error);
  }
  return out;
})()`;

async function verifyPage(path: string, apps: string[]) {
  const url = new URL(path, BASE_URL).toString();
  const child = Bun.spawn(["bun", "site/verify.ts", url, "500", PROBE], {
    cwd: ROOT,
    env: { ...process.env, POCKETJS_VERIFY_NO_SHOT: "1" },
    stdout: "pipe",
    stderr: "pipe",
  });
  activeVerifier = child;
  let timedOut = false;
  const timeout = setTimeout(() => {
    timedOut = true;
    child.kill();
  }, 120_000);
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  if (activeVerifier === child) activeVerifier = null;
  clearTimeout(timeout);
  if (timedOut) throw new Error(`${path}: verifier timed out after 120s`);
  if (exitCode !== 0) throw new Error(`${path}: verifier exited ${exitCode}\n${stderr}`);
  let report: VerifyReport;
  try {
    report = JSON.parse(stdout) as VerifyReport;
  } catch {
    throw new Error(`${path}: verifier returned invalid JSON\n${stdout}\n${stderr}`);
  }

  const errors: string[] = [];
  const probe = report.probe;
  if (probe.error) errors.push(`probe threw: ${probe.error}`);
  if (probe.found !== apps.length) {
    errors.push(`page declares ${apps.length} demo(s) but embed.js prepared ${probe.found}`);
  }
  for (const demo of probe.demos) {
    const tag = `${demo.app}`;
    if (demo.error) errors.push(`${tag}: ${demo.error}`);
    if (demo.state !== "ready") {
      errors.push(
        `${tag}: never became ready (state=${demo.state}, status=${JSON.stringify(demo.status)})`,
      );
      continue;
    }
    if (demo.canvasW !== demo.expectedW || demo.canvasH !== demo.expectedH) {
      errors.push(
        `${tag}: canvas is ${demo.canvasW}x${demo.canvasH}, expected ${demo.expectedW}x${demo.expectedH}`,
      );
    }
    if (!demo.started) errors.push(`${tag}: the observer never started the frame loop`);
    if (demo.nonblackPct < 1) errors.push(`${tag}: canvas is blank (${demo.nonblackPct}% non-black)`);
    if (demo.contactsSeen <= 0) {
      errors.push(`${tag}: the scripted drag produced no packed contacts on the wire`);
    }
    if (demo.maxHit <= 0) {
      errors.push(`${tag}: no contact resolved a bounds hit fact through the AppInstance realm`);
    }
    if (!demo.tapMoved) {
      errors.push(`${tag}: no scripted tap moved the framebuffer at any of the probed points`);
    }
    if (demo.dragAtY < 0) {
      errors.push(`${tag}: no scripted drag moved the framebuffer at any of the probed points`);
    }
  }
  for (const error of report.pageErrors ?? []) errors.push(`page error: ${error}`);
  for (const error of report.consoleErrors ?? []) errors.push(`console error: ${error}`);
  for (const error of report.networkErrors ?? []) errors.push(`network error: ${error}`);
  if (errors.length) throw new Error(`${path}:\n  ${errors.join("\n  ")}`);
  return probe;
}

const pages = pagesWithDemos();
if (pages.length === 0) {
  throw new Error(
    "no built docs page embeds a live demo — a page must carry a `:::demo <app>` directive " +
      "for the embedded-demo path to be covered",
  );
}
const failures: string[] = [];
let passed = 0;
try {
  await ensureServer();
  for (const page of pages) {
    try {
      const probe = await verifyPage(page.path, page.apps);
      passed++;
      console.log(
        `ok ${page.path} (${probe.demos.map((d) => `${d.app}: ${d.contactsSeen} contacts, hit ${d.maxHit}, drag at y=${d.dragAtY}, ${d.nonblackPct}% non-black`).join("; ")})`,
      );
    } catch (error) {
      failures.push(error instanceof Error ? error.message : String(error));
      console.error(`not ok ${page.path}`);
    }
  }
} finally {
  await cleanup();
  process.off("SIGTERM", onSigterm);
  process.off("SIGINT", onSigint);
}

if (failures.length) {
  throw new Error(`${passed}/${pages.length} docs demo pages passed\n\n${failures.join("\n\n")}`);
}
console.log(`Docs live demos passed (${passed}/${pages.length} page(s), scripted pointer drags applied)`);
