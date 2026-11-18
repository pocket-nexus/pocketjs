// Browser regression for every public Playground demo/framework variant.
// Run after site:build. By default this owns an isolated local server; set
// POCKETJS_PLAYGROUND_URL only when intentionally verifying an existing one.

import { createServer } from "node:net";
import { join } from "node:path";

type Framework = "solid" | "vue-vapor" | "octane";

interface DemoVariant {
  framework: Framework;
  source: string;
}

interface Demo {
  name: string;
  variants: DemoVariant[];
}

interface CanvasProbe {
  w: number;
  h: number;
  nonblackPct: number;
  coloredPct: number;
  controlHash: number;
  interactionHash: number;
}

interface PlaygroundProbe {
  selectedDemo: string | null;
  activeFramework: string | null;
  status: string | null;
  statusKind: string | null;
  controlError: string | null;
  interactionError: string | null;
  controlFrameAlive: boolean;
  interactionFrameAlive: boolean;
  invalidNodeInserts: number;
  invalidTextWrites: number;
  pressed: string[];
  textWrites: string[];
  canvas: CanvasProbe | null;
}

interface VerifyReport {
  probe: PlaygroundProbe;
  pageErrors: string[];
  consoleErrors: string[];
  networkErrors: string[];
}

const ROOT = join(import.meta.dir, "..");
const MANIFEST = join(ROOT, "site/dist/pg/demos.json");
let BASE_URL = "";
let ownedServer: ReturnType<typeof Bun.spawn> | null = null;
let activeVerifier: ReturnType<typeof Bun.spawn> | null = null;
let cleanupPromise: Promise<void> | null = null;
let shuttingDown = false;

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
const onSigterm = () => {
  shuttingDown = true;
  void cleanup().finally(() => process.exit(143));
};
const onSigint = () => {
  shuttingDown = true;
  void cleanup().finally(() => process.exit(130));
};
process.once("SIGTERM", onSigterm);
process.once("SIGINT", onSigint);

const CIRCLE = "0x2000";
const RIGHT = "0x0020";
const DOWN = "0x0040";
const R = "0x0200";

// Every public demo gets an interaction that exercises its primary controls.
const INPUTS: Record<string, string[]> = {
  cards: [RIGHT, CIRCLE],
  chrome: [RIGHT, CIRCLE],
  cursor: [RIGHT, DOWN, CIRCLE],
  gallery: [R, RIGHT, CIRCLE],
  hero: [RIGHT, CIRCLE, CIRCLE, CIRCLE, CIRCLE],
  library: [RIGHT, CIRCLE],
  motions: [RIGHT],
  music: [DOWN, CIRCLE, R],
  notifications: [DOWN, CIRCLE],
  settings: [DOWN, CIRCLE],
  stats: [RIGHT],
};

// A rendered canvas is not enough: a DOM/native-tree mismatch can preserve
// every styled box while silently dropping Text children. These sentinels are
// required to reach the actual host setText op on each fresh app mount.
const EXPECTED_TEXT: Record<string, readonly [string, string]> = {
  cards: ["Feature Cards", "3 MODULES"],
  chrome: ["POCKETJS — CHROME", "480 x 272"],
  cursor: ["REPLAY TAPE", "hover a row, press CIRCLE"],
  gallery: ["SYNTHWAVE", "01 / 04"],
  hero: ["PocketJS", "Press Circle"],
  library: ["Game Library", "5 TITLES"],
  motions: ["MOTIONS/53", "(yui540)"],
  music: ["Now Playing", "MIDNIGHT REPLAY"],
  notifications: ["Notifications", "UPDATE AVAILABLE"],
  settings: ["Settings", "4 OPTIONS"],
  stats: ["Mission Control", "LIVE TELEMETRY"],
};

// Vue's static template() text comes from the Vue runtime bundle, while
// expressions/loops come from the vue-jsx-vapor helper bundle. Assert a
// dynamic child too so either split artifact regressing fails the matrix.
const EXPECTED_VUE_DYNAMIC_TEXT: Partial<Record<string, string>> = {
  cards: "Layout",
  gallery: "SYNTHWAVE",
  hero: "Vue Vapor",
  library: "NEON DRIFT",
  music: "MIDNIGHT REPLAY",
  notifications: "UPDATE AVAILABLE",
  settings: "SOUND EFFECTS",
  stats: "PLAYERS ONLINE",
};

const EXPECTED_VARIANTS: Record<string, Framework[]> = {
  cards: ["solid", "vue-vapor", "octane"],
  chrome: ["solid"],
  cursor: ["solid"],
  gallery: ["solid", "vue-vapor", "octane"],
  hero: ["solid", "vue-vapor", "octane"],
  library: ["solid", "vue-vapor", "octane"],
  motions: ["solid"],
  music: ["solid", "vue-vapor", "octane"],
  notifications: ["solid", "vue-vapor", "octane"],
  settings: ["solid", "vue-vapor", "octane"],
  stats: ["solid", "vue-vapor", "octane"],
};

const FRAMEWORK_LABEL: Record<Framework, string> = {
  solid: "Solid",
  "vue-vapor": "Vue Vapor",
  octane: "Octane",
};

function matrixFromManifest(demos: Demo[]) {
  const actual = Object.fromEntries(
    demos.map((demo) => [demo.name, demo.variants.map((variant) => variant.framework)]),
  );
  if (JSON.stringify(actual) !== JSON.stringify(EXPECTED_VARIANTS)) {
    throw new Error(
      `Playground matrix changed; update its interaction coverage.\nExpected: ${JSON.stringify(EXPECTED_VARIANTS)}\nActual:   ${JSON.stringify(actual)}`,
    );
  }
  for (const demo of demos) {
    for (const variant of demo.variants) {
      if (!variant.source.trim()) throw new Error(`${demo.name}/${variant.framework} has empty source`);
    }
  }
  return demos.flatMap((demo) =>
    demo.variants.map((variant) => ({ demo: demo.name, framework: variant.framework })),
  );
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
    server.close((error) => error ? reject(error) : resolve()),
  );
  return address.port;
}

async function serverReady(expectedManifest: string) {
  try {
    const response = await fetch(`${BASE_URL}/pg/demos.json`, {
      signal: AbortSignal.timeout(2_000),
    });
    return response.ok && await response.text() === expectedManifest;
  } catch {
    return false;
  }
}

async function ensureServer(expectedManifest: string) {
  const configured = process.env.POCKETJS_PLAYGROUND_URL;
  if (configured) {
    BASE_URL = configured.replace(/\/$/, "");
    if (!await serverReady(expectedManifest)) {
      throw new Error(`${BASE_URL} is unavailable or does not serve this checkout's demos.json`);
    }
    return null;
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
    if (await serverReady(expectedManifest)) return server;
    if (server.exitCode !== null) {
      const stderr = await new Response(server.stderr).text();
      throw new Error(`site server exited before it was ready:\n${stderr}`);
    }
    await Bun.sleep(100);
  }
  server.kill();
  await server.exited;
  throw new Error(`timed out waiting for ${BASE_URL}`);
}

function makeProbe(buttons: string[]) {
  return `(async () => {
    const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
    const waitForRun = async () => {
      const deadline = performance.now() + 12000;
      while (document.querySelector('#pg-status')?.dataset.kind !== 'ok' && performance.now() < deadline) {
        if (document.querySelector('#pg-status')?.dataset.kind === 'err') break;
        await sleep(25);
      }
    };
    await waitForRun();
    const canvas = document.querySelector('#pg-canvas');
    const host = globalThis.__pgHost;
    const hash = (ctx, width, height) => {
      const data = ctx.getImageData(0, 0, width, height).data;
      let value = 2166136261;
      for (let i = 0; i < data.length; i += 4) {
        value ^= data[i]; value = Math.imul(value, 16777619);
        value ^= data[i + 1]; value = Math.imul(value, 16777619);
        value ^= data[i + 2]; value = Math.imul(value, 16777619);
      }
      return value >>> 0;
    };
    const ctx = canvas?.getContext('2d');
    const sequence = ${JSON.stringify(buttons)};
    const edgeFrames = 3;
    let controlHash = 0;
    let interactionHash = 0;
    let controlError = null;
    let interactionError = null;
    let controlFrameAlive = false;
    let interactionFrameAlive = false;
    let invalidNodeInserts = 0;
    let invalidTextWrites = 0;
    const pressed = [];
    const textWritesByNode = new Map();
    const insertedNodeIds = new Set();
    if (host && ctx) {
      // Control run: advance the same exact number of virtual frames with no
      // buttons. The verifier query disables HUD and ambient RAF advancement.
      host.stop();
      host.held = 0;
      for (let i = 0; i < sequence.length * edgeFrames * 2; i++) {
        host._safeFrame();
        await Promise.resolve();
      }
      host._blit();
      controlHash = hash(ctx, canvas.width, canvas.height);
      const controlErrorEl = document.querySelector('#pg-error');
      controlError = controlErrorEl && !controlErrorEl.hidden ? controlErrorEl.textContent : null;
      controlFrameAlive = typeof host.frameCb === 'function';

      // Fresh component state, then the same frame count through the shared
      // PocketHost input path. The PSP raycast controls call this same method;
      // their hit proxies are covered separately by the Stage verifier.
      const runButton = document.querySelector('#pg-run');
      if (!runButton) throw new Error('Playground Run button is missing');
      const originalSetText = host.ops.setText;
      const originalReplaceText = host.ops.replaceText;
      const originalInsertBefore = host.ops.insertBefore;
      const recordText = (id, value) => {
        if (!Number.isInteger(id) || id <= 0) {
          invalidTextWrites++;
          return;
        }
        let values = textWritesByNode.get(id);
        if (!values) textWritesByNode.set(id, values = new Set());
        values.add(String(value));
      };
      host.ops.setText = (id, value) => {
        recordText(id, value);
        return originalSetText(id, value);
      };
      host.ops.replaceText = (id, value) => {
        recordText(id, value);
        return originalReplaceText(id, value);
      };
      host.ops.insertBefore = (parent, node, anchor) => {
        const valid = Number.isInteger(parent) && parent > 0 &&
          Number.isInteger(node) && node > 0 &&
          Number.isInteger(anchor) && anchor >= 0;
        if (valid) insertedNodeIds.add(node);
        else invalidNodeInserts++;
        return originalInsertBefore(parent, node, anchor);
      };
      try {
        runButton.click();
        if (document.querySelector('#pg-status')?.dataset.kind !== 'busy') {
          throw new Error('Playground fresh rerun did not start');
        }
        await waitForRun();
        host.stop();
        for (const value of sequence) {
          const bit = Number(value);
          if (!Number.isInteger(bit) || bit <= 0) throw new Error('Invalid input bit ' + value);
          host.press(bit, true);
          host.stop();
          for (let i = 0; i < edgeFrames; i++) {
            host._safeFrame();
            await Promise.resolve();
          }
          host.press(bit, false);
          host.stop();
          for (let i = 0; i < edgeFrames; i++) {
            host._safeFrame();
            await Promise.resolve();
          }
          pressed.push(value);
        }
        host.held = 0;
        host._blit();
        interactionHash = hash(ctx, canvas.width, canvas.height);
        const interactionErrorEl = document.querySelector('#pg-error');
        interactionError = interactionErrorEl && !interactionErrorEl.hidden ? interactionErrorEl.textContent : null;
        interactionFrameAlive = typeof host.frameCb === 'function';
      } finally {
        host.ops.setText = originalSetText;
        host.ops.replaceText = originalReplaceText;
        host.ops.insertBefore = originalInsertBefore;
      }
    }
    let canvasResult = null;
    if (ctx) {
      const data = ctx.getImageData(0, 0, canvas.width, canvas.height).data;
      let nonblack = 0;
      let colored = 0;
      for (let i = 0; i < data.length; i += 4) {
        const r = data[i], g = data[i + 1], b = data[i + 2];
        if (r + g + b > 24) nonblack++;
        if (Math.abs(r - g) + Math.abs(g - b) > 40) colored++;
      }
      const pixels = data.length / 4;
      canvasResult = {
        w: canvas.width,
        h: canvas.height,
        nonblackPct: +(100 * nonblack / pixels).toFixed(1),
        coloredPct: +(100 * colored / pixels).toFixed(1),
        controlHash,
        interactionHash,
      };
    }
    const status = document.querySelector('#pg-status');
    return {
      selectedDemo: document.querySelector('#pg-demo')?.value ?? null,
      activeFramework: document.querySelector('[data-framework].is-active')?.dataset.framework ?? null,
      status: status?.textContent ?? null,
      statusKind: status?.dataset.kind ?? null,
      controlError,
      interactionError,
      controlFrameAlive,
      interactionFrameAlive,
      invalidNodeInserts,
      invalidTextWrites,
      pressed,
      textWrites: [...textWritesByNode]
        .filter(([id]) => insertedNodeIds.has(id))
        .flatMap(([, values]) => [...values]),
      canvas: canvasResult,
    };
  })()`;
}

async function verifyVariant(demo: string, framework: Framework) {
  if (shuttingDown) throw new Error("Playground verification interrupted");
  const url = new URL("/playground/", BASE_URL);
  url.searchParams.set("demo", demo);
  url.searchParams.set("framework", framework);
  url.searchParams.set("verify", "1");
  const child = Bun.spawn(
    ["bun", "site/verify.ts", url.toString(), "500", makeProbe(INPUTS[demo])],
    {
      cwd: ROOT,
      env: { ...process.env, POCKETJS_VERIFY_NO_SHOT: "1" },
      stdout: "pipe",
      stderr: "pipe",
    },
  );
  activeVerifier = child;
  let timedOut = false;
  const timeout = setTimeout(() => {
    timedOut = true;
    child.kill();
  }, 45_000);
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  if (activeVerifier === child) activeVerifier = null;
  clearTimeout(timeout);
  if (timedOut) throw new Error(`${demo}/${framework}: verifier timed out after 45s`);
  if (exitCode !== 0) throw new Error(`${demo}/${framework}: verifier exited ${exitCode}\n${stderr}`);
  let report: VerifyReport;
  try {
    report = JSON.parse(stdout) as VerifyReport;
  } catch {
    throw new Error(`${demo}/${framework}: verifier returned invalid JSON\n${stdout}\n${stderr}`);
  }

  const errors: string[] = [];
  const probe = report.probe;
  if (probe.selectedDemo !== demo) errors.push(`selected demo is ${probe.selectedDemo}`);
  if (probe.activeFramework !== framework) errors.push(`active framework is ${probe.activeFramework}`);
  if (probe.statusKind !== "ok" || !probe.status?.startsWith(`${FRAMEWORK_LABEL[framework]} · ok ·`)) {
    errors.push(`status is ${JSON.stringify(probe.status)}`);
  }
  if (probe.controlError) errors.push(`no-input control reported ${probe.controlError}`);
  if (!probe.controlFrameAlive) errors.push("no-input control frame loop stopped");
  if (probe.interactionError) errors.push(`input run reported ${probe.interactionError}`);
  if (!probe.interactionFrameAlive) errors.push("input run frame loop stopped");
  if (probe.invalidNodeInserts > 0) {
    errors.push(`${probe.invalidNodeInserts} host insert(s) used invalid native node IDs`);
  }
  if (probe.invalidTextWrites > 0) {
    errors.push(`${probe.invalidTextWrites} host text write(s) used an invalid native node id`);
  }
  if (probe.pressed.length !== INPUTS[demo].length) {
    errors.push(`only ${probe.pressed.length}/${INPUTS[demo].length} inputs were applied`);
  }
  for (const expectedText of EXPECTED_TEXT[demo]) {
    if (!probe.textWrites.some((value) => value.includes(expectedText))) {
      errors.push(`host never rendered expected text ${JSON.stringify(expectedText)}`);
    }
  }
  const expectedVueText = framework === "vue-vapor" ? EXPECTED_VUE_DYNAMIC_TEXT[demo] : undefined;
  if (expectedVueText && !probe.textWrites.some((value) => value.includes(expectedVueText))) {
    errors.push(`Vue helper never rendered dynamic text ${JSON.stringify(expectedVueText)}`);
  }
  if (!probe.canvas || probe.canvas.w !== 480 || probe.canvas.h !== 272) {
    errors.push("480x272 canvas is missing");
  } else {
    if (probe.canvas.nonblackPct < 1) errors.push(`canvas is blank (${probe.canvas.nonblackPct}% non-black)`);
    if (probe.canvas.controlHash === probe.canvas.interactionHash) {
      errors.push("input run matched the no-input deterministic control");
    }
  }
  for (const error of report.pageErrors ?? []) errors.push(`page error: ${error}`);
  for (const error of report.consoleErrors ?? []) errors.push(`console error: ${error}`);
  for (const error of report.networkErrors ?? []) errors.push(`network error: ${error}`);
  if (errors.length) throw new Error(`${demo}/${framework}:\n  ${errors.join("\n  ")}`);
  return probe;
}

const manifestText = await Bun.file(MANIFEST).text();
const demos = JSON.parse(manifestText) as Demo[];
const fullMatrix = matrixFromManifest(demos);
const selectors = process.argv.slice(2);
const matrix = selectors.length
  ? fullMatrix.filter(({ demo, framework }) =>
      selectors.some((selector) => selector === demo || selector === `${demo}/${framework}`),
    )
  : fullMatrix;
if (!matrix.length) throw new Error(`no Playground variants match: ${selectors.join(", ")}`);
const failures: string[] = [];
let passed = 0;

try {
  await ensureServer(manifestText);
  for (const { demo, framework } of matrix) {
    try {
      const probe = await verifyVariant(demo, framework);
      passed++;
      console.log(
        `ok ${String(passed).padStart(2, " ")}/${matrix.length} ${demo}/${framework}` +
          ` (${probe.canvas?.nonblackPct}% non-black, ${probe.pressed.length} inputs)`,
      );
    } catch (error) {
      failures.push(error instanceof Error ? error.message : String(error));
      console.error(`not ok ${demo}/${framework}`);
    }
  }
} finally {
  await cleanup();
  process.off("SIGTERM", onSigterm);
  process.off("SIGINT", onSigint);
}

if (failures.length) {
  throw new Error(`${passed}/${matrix.length} Playground variants passed\n\n${failures.join("\n\n")}`);
}

console.log(`Playground browser matrix passed (${passed}/${matrix.length} variants, deterministic input comparisons passed)`);
