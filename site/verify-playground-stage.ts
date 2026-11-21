// Real-browser smoke for the Playground's shared Pocket Stage shell.
// Serve site/dist first, then run:
//   bun site/verify-playground-stage.ts 'http://127.0.0.1:8140/playground/?demo=hero&framework=solid'

const url = process.argv[2]
  ?? "http://127.0.0.1:8140/playground/?demo=hero&framework=solid";
const verify = new URL("./verify.ts", import.meta.url).pathname;

const probe = `(async () => {
  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  const stage = document.querySelector("[data-playground-stage]");
  const webgl = document.querySelector("canvas[data-stage-canvas]");
  const framebuffer = document.querySelector("#pg-canvas");
  const credit = document.querySelector(".pg-stage__credit a");
  const run = document.querySelector("#pg-run");
  const status = document.querySelector("#pg-status");
  const receipt = () => globalThis.__playgroundStageReceipt?.();
  const readyDeadline = performance.now() + 12000;
  while (performance.now() < readyDeadline) {
    if (stage.dataset.ready === "true" && status.dataset.kind === "ok") break;
    await sleep(100);
  }
  // Let the post-load ResizeObserver and the first Stage render settle so the
  // authored hit proxies and their normalized viewport coordinates agree.
  await sleep(750);
  const lowerScreenHash = () => {
    const context = framebuffer.getContext("2d");
    const top = Math.floor(framebuffer.height * 0.68);
    const data = context.getImageData(0, top, framebuffer.width, framebuffer.height - top).data;
    let value = 2166136261;
    for (let i = 0; i < data.length; i += 4) {
      value ^= data[i] | (data[i + 1] << 8) | (data[i + 2] << 16);
      value = Math.imul(value, 16777619);
    }
    return value >>> 0;
  };
  const spinnerFrameHash = () => {
    const context = framebuffer.getContext("2d");
    const data = context.getImageData(360, 70, 120, 140).data;
    let value = 2166136261;
    for (let i = 0; i < data.length; i += 4) {
      value ^= data[i] | (data[i + 1] << 8) | (data[i + 2] << 16) | (data[i + 3] << 24);
      value = Math.imul(value, 16777619);
    }
    return value >>> 0;
  };

  // The Hero spinner advances every three guest frames. Sampling its authored
  // framebuffer region catches both a stalled guest and SVG decode fallback:
  // eight failed SVGs previously produced one identical checker hash while the
  // Stage upload counters continued to advance.
  const spinnerStartTick = receipt()?.guestTicks ?? 0;
  const spinnerHashes = new Set();
  const stageUploadHashes = new Set();
  let stageUploadCalls = 0;
  const contextPrototypes = new Set(
    [window.WebGLRenderingContext, window.WebGL2RenderingContext]
      .filter(Boolean)
      .map((Context) => Context.prototype),
  );
  for (const prototype of contextPrototypes) {
    for (const name of ["texImage2D", "texSubImage2D"]) {
      const original = prototype[name];
      if (typeof original !== "function") continue;
      prototype[name] = function (...args) {
        if (args.includes(framebuffer)) {
          stageUploadCalls++;
          stageUploadHashes.add(spinnerFrameHash());
        }
        return original.apply(this, args);
      };
    }
  }
  let spinnerEndTick = spinnerStartTick;
  for (let i = 0; i < 64; i++) {
    spinnerHashes.add(spinnerFrameHash());
    spinnerEndTick = receipt()?.guestTicks ?? spinnerEndTick;
    if (
      spinnerHashes.size >= 8
      && stageUploadHashes.size >= 8
      && spinnerEndTick - spinnerStartTick >= 24
    ) break;
    // Vary the interval so the verifier cannot phase-lock with the 3-tick
    // animation step and repeatedly skip the same authored frame.
    await sleep(37 + (i % 5) * 7);
  }

  credit.focus();
  const enter = new KeyboardEvent("keydown", {
    key: "Enter",
    code: "Enter",
    bubbles: true,
    cancelable: true,
  });
  credit.dispatchEvent(enter);
  const creditEnterPrevented = enter.defaultPrevented;

  webgl.setPointerCapture = () => {};
  webgl.releasePointerCapture = () => {};
  const rect = webgl.getBoundingClientRect();
  let pointerId = 100;
  const pointer = (type, point, id) => new PointerEvent(type, {
    pointerId: id,
    pointerType: "mouse",
    isPrimary: true,
    button: 0,
    buttons: type === "pointerup" ? 0 : 1,
    clientX: rect.left + rect.width * point.x,
    clientY: rect.top + rect.height * point.y,
    bubbles: true,
    cancelable: true,
  });
  const candidates = [
    { x: 0.95, y: 0.455 },
    { x: 0.95, y: 0.49 },
    { x: 0.925, y: 0.455 },
    { x: 0.975, y: 0.455 },
  ];
  let circlePoint = null;
  let firstPointerId = null;
  for (const point of candidates) {
    const id = pointerId++;
    webgl.dispatchEvent(pointer("pointerdown", point, id));
    await sleep(20);
    if (receipt()?.pressedPart === "btn_circle") {
      circlePoint = point;
      firstPointerId = id;
      break;
    }
    webgl.dispatchEvent(pointer("pointerup", point, id));
    const releaseDeadline = performance.now() + 800;
    while (performance.now() < releaseDeadline && receipt()?.pressedPart) await sleep(20);
  }
  const firstDownPart = receipt()?.pressedPart ?? null;

  // Do not send pointerup: Run must release both the host bit and the Stage
  // pointer latch before PocketHost.reset() discards afterNextTick callbacks.
  run.click();
  let sawBusy = status.dataset.kind === "busy";
  const deadline = performance.now() + 12000;
  while (performance.now() < deadline) {
    sawBusy ||= status.dataset.kind === "busy";
    if (sawBusy && status.dataset.kind === "ok") break;
    await sleep(50);
  }
  await sleep(100);
  const afterReset = receipt();
  const hashBefore = lowerScreenHash();

  const dpadPoint = { x: 0.17, y: 0.44 };
  const dpadPointerId = pointerId++;
  webgl.dispatchEvent(pointer("pointerdown", dpadPoint, dpadPointerId));
  await sleep(30);
  const navigationPart = receipt()?.pressedPart ?? null;
  await sleep(50);
  webgl.dispatchEvent(pointer("pointerup", dpadPoint, dpadPointerId));
  await sleep(120);

  let secondDownPart = null;
  let hashAfter = hashBefore;
  let afterSecond = afterReset;
  if (circlePoint) {
    const secondPointerId = pointerId++;
    webgl.dispatchEvent(pointer("pointerdown", circlePoint, secondPointerId));
    await sleep(20);
    secondDownPart = receipt()?.pressedPart ?? null;
    await sleep(60);
    webgl.dispatchEvent(pointer("pointerup", circlePoint, secondPointerId));
    await sleep(180);
    hashAfter = lowerScreenHash();
    afterSecond = receipt();
  }

  const resourceEntries = performance.getEntriesByType("resource");
  const resources = resourceEntries.map((entry) => new URL(entry.name).pathname);
  return {
    stageReady: stage.dataset.ready,
    hasError: stage.classList.contains("has-error"),
    creditEnterPrevented,
    sawBusy,
    statusKind: status.dataset.kind,
    status: status.textContent,
    firstDownPart,
    firstPointerId,
    releasedAcrossReset: afterReset?.pressedPart == null,
    navigationPart,
    secondDownPart,
    releasedAfterSecond: afterSecond?.pressedPart == null,
    lowerFramebufferChanged: hashBefore !== hashAfter,
    spinnerGuestTicks: spinnerEndTick - spinnerStartTick,
    spinnerFramebufferHashes: spinnerHashes.size,
    spinnerStageUploadCalls: stageUploadCalls,
    spinnerStageUploadHashes: stageUploadHashes.size,
    wasmLoads: resources.filter((path) => path.endsWith("/pg/pocketjs.wasm")).length,
    stageAppLoads: resources.filter((path) => path.startsWith("/stage/handheld-apps/")),
    modelResources: resourceEntries
      .filter((entry) => new URL(entry.name).pathname === "/stage/psp_lod3_eco.glb")
      .map((entry) => ({
        duration: Math.round(entry.duration),
        transferSize: entry.transferSize,
        decodedBodySize: entry.decodedBodySize,
      })),
    receipt: afterSecond,
  };
})()`;

const child = Bun.spawn(
  [process.execPath, verify, url, "1000", probe],
  {
    stdout: "pipe",
    stderr: "pipe",
    env: {
      ...process.env,
      SHOT: process.env.SHOT ?? "/tmp/pocketjs-playground-stage.png",
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
const modelLoaded = result.modelResources.some(
  (resource: { decodedBodySize: number }) => resource.decodedBodySize > 0,
);
const loadedModelUrl = new URL("/stage/psp_lod3_eco.glb", url).href;
const expectedCanceledModelRequest =
  `net::ERR_ABORTED: ${loadedModelUrl} (type=Fetch, canceled=true)`;
// CDP can report a canceled Fetch for this URL after ResourceTiming shows the
// complete body. Accept only that exact cancellation when the browser receipt
// also proves the model loaded and the Stage became ready.
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
  creditKeepsEnter: result.creditEnterPrevented === false,
  resetReleasesModelInput:
    result.sawBusy
    && result.firstDownPart === "btn_circle"
    && result.releasedAcrossReset
    && result.navigationPart === "dpad_right"
    && result.secondDownPart === "btn_circle"
    && result.releasedAfterSecond,
  liveFramebuffer: result.lowerFramebufferChanged && result.receipt?.screenUploads > 1,
  animatedStageTexture:
    result.spinnerGuestTicks >= 24
    && result.spinnerFramebufferHashes >= 8
    && result.spinnerStageUploadCalls >= 8
    && result.spinnerStageUploadHashes >= 8,
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
  throw new Error(`Playground Stage smoke failed: ${failures.join(", ")}`);
}
