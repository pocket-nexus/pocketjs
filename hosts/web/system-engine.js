// Browser Pocket System host. Each package runs in an independent same-origin
// iframe Realm with its own wasm Ui. This module owns AppInstance lifecycle,
// focused scheduling, child raster retention and browser input adaptation.

const BTN = {
  SELECT: 0x0001,
  START: 0x0008,
  UP: 0x0010,
  RIGHT: 0x0020,
  DOWN: 0x0040,
  LEFT: 0x0080,
  LTRIGGER: 0x0100,
  RTRIGGER: 0x0200,
  TRIANGLE: 0x1000,
  CIRCLE: 0x2000,
  CROSS: 0x4000,
  SQUARE: 0x8000,
};

const KEY_BUTTONS = {
  ArrowUp: BTN.UP,
  ArrowRight: BTN.RIGHT,
  ArrowDown: BTN.DOWN,
  ArrowLeft: BTN.LEFT,
  KeyZ: BTN.CROSS,
  Enter: BTN.CROSS,
  KeyX: BTN.CIRCLE,
  KeyA: BTN.SQUARE,
  KeyS: BTN.TRIANGLE,
  KeyQ: BTN.LTRIGGER,
  KeyW: BTN.RTRIGGER,
  ShiftLeft: BTN.SELECT,
  ShiftRight: BTN.SELECT,
  Space: BTN.START,
};

const NAMED_KEYS = {
  Backspace: "Backspace",
  Delete: "Delete",
  Enter: "Enter",
  Tab: "Tab",
  ArrowLeft: "Left",
  ArrowRight: "Right",
  ArrowUp: "Up",
  ArrowDown: "Down",
  Home: "Home",
  End: "End",
  PageUp: "PageUp",
  PageDown: "PageDown",
  Escape: "Escape",
  F1: "F1",
  F2: "F2",
  F3: "F3",
  F4: "F4",
  F5: "F5",
  F6: "F6",
  F7: "F7",
  F8: "F8",
  F9: "F9",
  F10: "F10",
  F11: "F11",
  F12: "F12",
};

function absolute(url, base = location.href) {
  return new URL(url, base).href;
}

export function focusCanvas(canvas) {
  canvas.focus({ preventScroll: true });
}

export function createSurfaceCatalog(applications) {
  const catalog = new Map();
  const surfaces = {};
  applications.forEach((entry, index) => {
    const handle = index + 1;
    catalog.set(handle, entry);
    surfaces[entry.package] = handle;
  });
  return { catalog, surfaces };
}

export function validateSystemPlan(plan) {
  if (!plan || plan.target?.id !== "web-app" || plan.target?.hostAbi !== 4) {
    throw new Error("browser System host requires a web-app ABI 4 ResolvedSystemPlan");
  }
  if (!plan.systemUI || plan.roles?.systemUI !== plan.systemUI.package) {
    throw new Error("resolved SystemUI role does not match its package plan");
  }
  if (plan.systemUI.plan?.features?.["ui.compositor-surfaces"] !== true) {
    throw new Error("SystemUI plan lacks ui.compositor-surfaces");
  }
  const packages = [plan.systemUI, ...(plan.applications ?? [])];
  const ids = new Set();
  const outputs = new Set();
  for (const entry of packages) {
    if (ids.has(entry.package)) throw new Error(`duplicate System package ${entry.package}`);
    ids.add(entry.package);
    const output = entry.plan?.app?.output;
    if (!output || outputs.has(output)) throw new Error(`duplicate or missing artifact output ${output}`);
    outputs.add(output);
    if (entry.plan.app.id !== entry.package) {
      throw new Error(`package ${entry.package} carries plan for ${entry.plan.app.id}`);
    }
    if (entry.plan.target?.id !== "web-app" || entry.plan.target?.hostAbi !== 4) {
      throw new Error(`package ${entry.package} was not resolved for web-app ABI 4`);
    }
  }
  for (const entry of plan.applications ?? []) {
    if ((entry.plan.companions ?? []).length > 0) {
      throw new Error(`AppInstance ${entry.package} declares unsupported companions`);
    }
  }
  const installed = new Set(plan.installation?.installedPackages ?? []);
  if (installed.size !== ids.size || [...ids].some((id) => !installed.has(id))) {
    throw new Error("resolved packages do not match the System installation snapshot");
  }
}

async function createRealm(instanceUrl, options) {
  const iframe = document.createElement("iframe");
  iframe.hidden = true;
  iframe.tabIndex = -1;
  iframe.setAttribute("aria-hidden", "true");
  iframe.src = instanceUrl;
  document.body.appendChild(iframe);
  await new Promise((resolve, reject) => {
    iframe.addEventListener("load", resolve, { once: true });
    iframe.addEventListener("error", () => reject(new Error(`failed to load ${instanceUrl}`)), {
      once: true,
    });
  });
  const factory = iframe.contentWindow?.PocketAppInstance;
  if (!factory) {
    iframe.remove();
    throw new Error("app-instance Realm did not publish PocketAppInstance");
  }
  try {
    return { iframe, api: await factory.create(options) };
  } catch (error) {
    iframe.remove();
    throw error;
  }
}

export async function mountPocketSystem(canvas, options = {}) {
  const planUrl = absolute(options.planUrl ?? "./pocket.system.plan.json");
  const response = await fetch(planUrl);
  if (!response.ok) throw new Error(`System plan not found at ${planUrl}`);
  const plan = await response.json();
  validateSystemPlan(plan);

  const base = new URL(options.baseUrl ?? "./", planUrl);
  const distBase = absolute(options.distBase ?? "./dist/", base);
  const wasmUrl = absolute(options.wasmUrl ?? "./pocketjs.wasm", base);
  const instanceUrl = absolute(options.instanceUrl ?? "./app-instance.html", base);
  const log = options.onLog ?? (() => {});
  const shellPlan = plan.systemUI.plan;
  const viewport = [...shellPlan.viewport.logical];
  canvas.width = viewport[0];
  canvas.height = viewport[1];
  const context = canvas.getContext("2d");
  context.imageSmoothingEnabled = false;
  let image = context.createImageData(viewport[0], viewport[1]);

  const { catalog, surfaces } = createSurfaceCatalog(plan.applications);
  const artifact = (entry, extension) =>
    absolute(`${entry.plan.app.output}.${extension}`, distBase);
  const shellRealm = await createRealm(instanceUrl, {
    packageId: plan.systemUI.package,
    host: shellPlan.target.id, hostAbi: shellPlan.target.hostAbi,
    wasmUrl,
    bundleUrl: artifact(plan.systemUI, "js"),
    pakUrl: artifact(plan.systemUI, "pak"),
    viewport,
    rasterDensity: shellPlan.viewport.rasterDensity,
    companions: shellPlan.companions,
    surfaces,
  });
  const shell = shellRealm.api;
  shell.sendService({ t: "hello", w: viewport[0], h: viewport[1], epoch: Date.now() });

  const children = new Map();
  let stopped = false;
  let raf = 0;
  let accumulator = 0;
  let last = performance.now();
  let heldButtons = 0;
  let focusedHandle = null;
  let primaryDown = false;

  async function openChild(handle) {
    if (children.has(handle)) return children.get(handle);
    const entry = catalog.get(handle);
    if (!entry) throw new Error(`unknown compositor surface handle ${handle}`);
    const pending = createRealm(instanceUrl, {
      packageId: entry.package,
      host: entry.plan.target.id, hostAbi: entry.plan.target.hostAbi,
      wasmUrl,
      bundleUrl: artifact(entry, "js"),
      pakUrl: artifact(entry, "pak"),
      viewport: entry.plan.viewport.logical,
      rasterDensity: entry.plan.viewport.rasterDensity,
      companions: [],
    }).then((realm) => ({ ...realm, entry, composited: false }));
    children.set(handle, pending);
    try {
      const child = await pending;
      children.set(handle, child);
      log(`started AppInstance ${entry.package}`);
      return child;
    } catch (error) {
      children.delete(handle);
      throw error;
    }
  }

  function closeChild(handle) {
    const child = children.get(handle);
    children.delete(handle);
    shell.freeSurface(handle);
    if (!child || child instanceof Promise) {
      child?.then((resolved) => {
        resolved.api.dispose();
        resolved.iframe.remove();
      });
      return;
    }
    child.api.dispose();
    child.iframe.remove();
    log(`removed AppInstance ${child.entry.package}`);
  }

  async function reconcile() {
    const bindings = shell.bindings();
    const live = new Set(bindings.map((binding) => binding.handle));
    for (const handle of [...children.keys()]) {
      if (!live.has(handle)) closeChild(handle);
    }
    await Promise.all([...live].map((handle) => openChild(handle).catch((error) => {
      log(`AppInstance ${handle} failed: ${error.message ?? error}`);
      return null;
    })));

    const frames = shell.frames();
    const visible = new Set(frames.map((frame) => frame.handle));
    const focused = [...frames].reverse().find((frame) => frame.focused);
    focusedHandle = focused?.handle ?? null;
    const background = plan.lifecycle.backgroundExecution;
    const ordered = [...frames].sort((a, b) => {
      if (a.handle === focusedHandle) return -1;
      if (b.handle === focusedHandle) return 1;
      return b.order - a.order;
    });
    if (background === "continue") {
      for (const handle of live) {
        if (!visible.has(handle)) ordered.push({ handle, focused: false, order: -1 });
      }
    }

    for (const fact of ordered) {
      const child = children.get(fact.handle);
      if (!child || child instanceof Promise) continue;
      child.api.step(fact.handle === focusedHandle ? heldButtons : 0);
      if (visible.has(fact.handle)) {
        const pixels = child.api.render();
        const [width, height] = child.api.viewport;
        const texture = shell.uploadSurface(fact.handle, pixels, width, height);
        if (texture < 0) {
          throw new Error(`failed to upload compositor surface ${fact.handle}`);
        }
        if (!child.composited) {
          child.composited = true;
          log(
            `composited AppInstance ${child.entry.package} (${width}x${height} into ${fact.full[2]}x${fact.full[3]})`,
          );
        }
      }
    }
  }

  function processShellIntents() {
    for (const line of shell.drainService()) {
      let message;
      try {
        message = JSON.parse(line);
      } catch {
        continue;
      }
      if (message.t === "cursor" && typeof message.k === "string") {
        canvas.style.cursor = message.k === "default" ? "default" : message.k;
      } else if (message.t === "copy" && typeof message.text === "string") {
        navigator.clipboard?.writeText(message.text).catch(() => {});
      } else if (message.t === "paste-req") {
        navigator.clipboard?.readText().then((text) => {
          if (text) shell.sendService({ t: "paste", text });
        }).catch(() => {});
      } else if (message.t === "quit") {
        options.onQuit?.();
      }
    }
  }

  async function step() {
    shell.step(0);
    await reconcile();
    processShellIntents();
  }

  function paint() {
    image.data.set(shell.renderComposited());
    context.putImageData(image, 0, 0);
  }

  async function tick(now) {
    if (stopped) return;
    let elapsed = Math.min(250, now - last);
    last = now;
    accumulator += elapsed;
    let count = 0;
    while (accumulator >= 1000 / 60 && count < 4) {
      await step();
      accumulator -= 1000 / 60;
      count++;
    }
    if (count > 0) paint();
    raf = requestAnimationFrame(tick);
  }

  function logicalPoint(event) {
    const rect = canvas.getBoundingClientRect();
    return {
      x: Math.max(0, Math.min(viewport[0] - 1, (event.clientX - rect.left) * viewport[0] / rect.width)),
      y: Math.max(0, Math.min(viewport[1] - 1, (event.clientY - rect.top) * viewport[1] / rect.height)),
    };
  }

  function sendMouse(event, down, button = 1) {
    const point = logicalPoint(event);
    shell.sendService({
      t: "mouse",
      x: point.x,
      y: point.y,
      d: down,
      ...(button === 2 ? { b: 2 } : {}),
      sh: event.shiftKey,
    });
  }

  const onPointerMove = (event) => sendMouse(event, primaryDown);
  const onPointerDown = (event) => {
    focusCanvas(canvas);
    if (event.button === 0) primaryDown = true;
    if (event.button === 0 || event.button === 2) sendMouse(event, true, event.button === 2 ? 2 : 1);
    event.preventDefault();
  };
  const onPointerUp = (event) => {
    if (event.button === 0) primaryDown = false;
    if (event.button === 0 || event.button === 2) sendMouse(event, false, event.button === 2 ? 2 : 1);
    event.preventDefault();
  };
  const onWheel = (event) => {
    shell.sendService({ t: "scroll", dy: event.deltaY });
    event.preventDefault();
  };
  const onKeyDown = (event) => {
    const button = KEY_BUTTONS[event.code];
    if (focusedHandle !== null && button !== undefined && !event.metaKey && !event.ctrlKey && !event.altKey) {
      heldButtons |= button;
      event.preventDefault();
      return;
    }
    const command = event.metaKey || event.ctrlKey;
    if (command) {
      if (event.key.toLowerCase() === "v") {
        navigator.clipboard?.readText().then((text) => {
          if (text) shell.sendService({ t: "paste", text });
        }).catch(() => {});
        event.preventDefault();
        return;
      }
      if (event.key.toLowerCase() === "q") {
        options.onQuit?.();
        event.preventDefault();
        return;
      }
      shell.sendService({
        t: "key",
        k: event.key.toLowerCase(),
        cmd: true,
        sh: event.shiftKey,
        alt: event.altKey,
        ctl: event.ctrlKey,
      });
      event.preventDefault();
      return;
    }
    const named = NAMED_KEYS[event.key];
    if (named) {
      shell.sendService({ t: "key", k: named, sh: event.shiftKey, alt: event.altKey, ctl: event.ctrlKey });
      event.preventDefault();
    } else if (event.key.length === 1 && !event.altKey) {
      shell.sendService({ t: "ch", s: event.key });
      event.preventDefault();
    }
  };
  const onKeyUp = (event) => {
    const button = KEY_BUTTONS[event.code];
    if (button !== undefined) {
      heldButtons &= ~button;
      if (focusedHandle !== null) event.preventDefault();
    }
  };
  const onBlur = () => {
    primaryDown = false;
    heldButtons = 0;
  };
  canvas.tabIndex = 0;
  canvas.addEventListener("pointermove", onPointerMove);
  canvas.addEventListener("pointerdown", onPointerDown);
  window.addEventListener("pointerup", onPointerUp);
  canvas.addEventListener("contextmenu", (event) => event.preventDefault());
  canvas.addEventListener("wheel", onWheel, { passive: false });
  window.addEventListener("keydown", onKeyDown);
  window.addEventListener("keyup", onKeyUp);
  window.addEventListener("blur", onBlur);

  function resizeShell(width, height) {
    width = Math.max(320, Math.min(4096, Math.round(width)));
    height = Math.max(240, Math.min(4096, Math.round(height)));
    if (width === viewport[0] && height === viewport[1]) return;
    viewport[0] = width;
    viewport[1] = height;
    shell.resize(width, height);
    shell.sendService({ t: "resize", w: width, h: height });
    canvas.width = width;
    canvas.height = height;
    image = context.createImageData(width, height);
  }
  const resizeObserver = options.liveResize === false || typeof ResizeObserver === "undefined"
    ? null
    : new ResizeObserver(([entry]) => {
        const { width, height } = entry.contentRect;
        if (width > 0 && height > 0) resizeShell(width, height);
      });
  resizeObserver?.observe(canvas);

  await step();
  paint();
  log(`booted ${plan.system.title} with ${plan.applications.length} installed applications`);
  raf = requestAnimationFrame(tick);

  return {
    plan,
    stop() {
      if (stopped) return;
      stopped = true;
      cancelAnimationFrame(raf);
      for (const handle of [...children.keys()]) closeChild(handle);
      shell.dispose();
      shellRealm.iframe.remove();
      canvas.removeEventListener("pointermove", onPointerMove);
      canvas.removeEventListener("pointerdown", onPointerDown);
      window.removeEventListener("pointerup", onPointerUp);
      canvas.removeEventListener("wheel", onWheel);
      window.removeEventListener("keydown", onKeyDown);
      window.removeEventListener("keyup", onKeyUp);
      window.removeEventListener("blur", onBlur);
      resizeObserver?.disconnect();
    },
  };
}
