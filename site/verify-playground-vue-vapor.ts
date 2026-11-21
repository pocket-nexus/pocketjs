// Real-browser regression for the Playground's split Vue Vapor bundles.
// Serve site/dist first, then run:
//   bun site/verify-playground-vue-vapor.ts 'http://127.0.0.1:8140/playground/?demo=hero&framework=vue-vapor'

const url = process.argv[2]
  ?? "http://127.0.0.1:8140/playground/?demo=hero&framework=vue-vapor";
const verify = new URL("./verify.ts", import.meta.url).pathname;

const probe = `(async () => {
  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  const stage = document.querySelector("[data-playground-stage]");
  const run = document.querySelector("#pg-run");
  const status = document.querySelector("#pg-status");
  const receipt = () => globalThis.__playgroundStageReceipt?.();
  const readyDeadline = performance.now() + 12000;
  while (performance.now() < readyDeadline) {
    if (stage.dataset.ready === "true" && status.dataset.kind === "ok") break;
    await sleep(100);
  }

  const ops = globalThis.ui;
  const textWritesByNode = new Map();
  const insertedNodeIds = new Set();
  const invalidTextWrites = [];
  const invalidInserts = [];
  for (const name of ["setText", "replaceText"]) {
    const original = ops[name];
    ops[name] = function (id, value) {
      if (!Number.isInteger(id) || id <= 0) {
        invalidTextWrites.push({ name, id, value: String(value) });
      } else {
        const writes = textWritesByNode.get(id) ?? new Set();
        writes.add(String(value));
        textWritesByNode.set(id, writes);
      }
      return original.apply(this, arguments);
    };
  }
  const insertBefore = ops.insertBefore;
  ops.insertBefore = function (parent, child, anchor) {
    if (
      !Number.isInteger(parent) || parent <= 0
      || !Number.isInteger(child) || child <= 0
      || !Number.isInteger(anchor) || anchor < 0
    ) {
      invalidInserts.push({ parent, child, anchor });
    } else {
      insertedNodeIds.add(child);
    }
    return insertBefore.apply(this, arguments);
  };

  run.click();
  let sawBusy = status.dataset.kind === "busy";
  const rerunDeadline = performance.now() + 12000;
  while (performance.now() < rerunDeadline) {
    sawBusy ||= status.dataset.kind === "busy";
    if (sawBusy && status.dataset.kind === "ok") break;
    await sleep(50);
  }
  // Vue Vapor schedules part of its mount work in microtasks; leave a guest
  // turn after the status flips before collecting the native-tree receipt.
  await sleep(250);

  const insertedTextWrites = [...textWritesByNode]
    .filter(([id]) => insertedNodeIds.has(id))
    .flatMap(([, writes]) => [...writes]);
  const resourceEntries = performance.getEntriesByType("resource");
  const resources = resourceEntries.map((entry) => new URL(entry.name).pathname);
  return {
    stageReady: stage.dataset.ready,
    hasError: stage.classList.contains("has-error"),
    sawBusy,
    statusKind: status.dataset.kind,
    status: status.textContent,
    insertedTextWrites,
    insertedTextNodes: [...textWritesByNode.keys()].filter((id) => insertedNodeIds.has(id)).length,
    invalidTextWrites,
    invalidInserts,
    wasmLoads: resources.filter((path) => path.endsWith("/pg/pocketjs.wasm")).length,
    stageAppLoads: resources.filter((path) => path.startsWith("/stage/handheld-apps/")),
    modelResources: resourceEntries
      .filter((entry) => new URL(entry.name).pathname === "/stage/psp_lod3_eco.glb")
      .map((entry) => ({ decodedBodySize: entry.decodedBodySize })),
    receipt: receipt(),
  };
})()`;

const child = Bun.spawn(
  [process.execPath, verify, url, "1000", probe],
  {
    stdout: "pipe",
    stderr: "pipe",
    env: {
      ...process.env,
      SHOT: process.env.SHOT ?? "/tmp/pocketjs-playground-vue-vapor.png",
    },
  },
);
const [stdout, stderr, exitCode] = await Promise.all([
  new Response(child.stdout).text(),
  new Response(child.stderr).text(),
  child.exited,
]);
if (exitCode !== 0) throw new Error(stderr || stdout || `site verifier exited ${exitCode}`);

const report = JSON.parse(stdout);
const result = report.probe;
const hasText = (value: string) =>
  result.insertedTextWrites.some((text: string) => text.includes(value));
const modelLoaded = result.modelResources.some(
  (resource: { decodedBodySize: number }) => resource.decodedBodySize > 0,
);
const loadedModelUrl = new URL("/stage/psp_lod3_eco.glb", url).href;
const expectedCanceledModelRequest =
  `net::ERR_ABORTED: ${loadedModelUrl} (type=Fetch, canceled=true)`;
const unexpectedNetworkErrors = (report.networkErrors ?? []).filter(
  (error: string) => !(modelLoaded && result.stageReady === "true" && error === expectedCanceledModelRequest),
);
const checks = {
  stageReady:
    result.stageReady === "true"
    && result.hasError === false
    && result.statusKind === "ok",
  sharedPackage:
    result.receipt?.profileUrl === "/stage/psp-profile.json"
    && result.receipt?.modelUrl === "/stage/psp_lod3_eco.glb"
    && result.receipt?.screenCanvasId === "pg-canvas"
    && modelLoaded,
  onePlaygroundRuntime: result.wasmLoads === 1 && result.stageAppLoads.length === 0,
  nativeTextNodes:
    result.sawBusy
    && result.invalidTextWrites.length === 0
    && result.invalidInserts.length === 0
    && result.insertedTextNodes > 0
    && hasText("PocketJS")
    && hasText("Vue Vapor")
    && hasText("JSX at 60 FPS.")
    && hasText("Press Circle"),
  noBrowserErrors:
    report.pageErrors.length === 0
    && report.consoleErrors.length === 0
    && unexpectedNetworkErrors.length === 0,
};
const failures = Object.entries(checks)
  .filter(([, passed]) => !passed)
  .map(([name]) => name);

console.log(JSON.stringify({ ...report, unexpectedNetworkErrors, checks }, null, 2));
if (failures.length) {
  throw new Error(`Playground Vue Vapor smoke failed: ${failures.join(", ")}`);
}
