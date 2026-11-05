// site/playground/playground.js — the live editor + preview glue (bundled by
// site/build.ts with CodeMirror into /pg/playground.bundle.js).
//
// Flow on every (debounced) edit:
//   compile.js  compileApp(source) -> { code, styleMap, pak }   [may throw]
//   host.reset()                    fresh wasm core + globalThis.ui
//   blob module A = transformed app (default export = the component)
//   blob module B = `import App from A; mount(() => App(), {styles, pak})`
//   import(B) via the page import-map (@pocketjs/framework -> /pg/runtime.js)
//   host.begin()                    grab globalThis.frame, drive 60 Hz
//
// runtime.js is a singleton (import-map points every @pocketjs/framework specifier at the
// one URL), so between runs the bootstrap calls __resetAll() to wipe it.

import { EditorView, basicSetup } from "codemirror";
import { EditorState } from "@codemirror/state";
import { javascript } from "@codemirror/lang-javascript";
import { oneDark } from "@codemirror/theme-one-dark";
import { PocketHost } from "./host.js";

// Dynamic-import the heavy (3 MB) compiler + the shared runtime lazily, with
// computed specifiers so the bundler leaves them external (served from /pg/).
const PG = "/pg/";
let _compiler = null;
function loadCompiler() {
  if (!_compiler) _compiler = import(/* @vite-ignore */ PG + "compiler.js");
  return _compiler;
}

const $ = (sel) => document.querySelector(sel);

async function main() {
  const query = new URLSearchParams(location.search);
  const verifyMode = query.get("verify") === "1";
  const canvas = $("#pg-canvas");
  const statusEl = $("#pg-status");
  const errorEl = $("#pg-error");
  const demoSel = $("#pg-demo");
  const frameworkBtns = [...document.querySelectorAll("[data-framework]")];
  const runBtn = $("#pg-run");
  const resetBtn = $("#pg-reset");
  const stageRoot = $("[data-playground-stage]");
  const stageKeyboardTarget = stageRoot.querySelector("[data-stage-viewport]");

  const setStatus = (s, kind = "") => {
    statusEl.textContent = s;
    statusEl.dataset.kind = kind;
  };
  const showError = (msg) => {
    errorEl.textContent = msg;
    errorEl.hidden = !msg;
  };

  // --- host -----------------------------------------------------------------
  const host = new PocketHost();
  if (verifyMode) globalThis.__pgHost = host;
  let stageController = null;
  const hostReady = host.mount(canvas, {
    wasmUrl: PG + "pocketjs.wasm",
    keyboardTarget: stageKeyboardTarget,
    onError: (e) => showError(String(e && e.stack ? e.stack : e)),
    onLog: () => {},
    onBlit: () => stageController?.refreshScreen(),
    showHud: !verifyMode,
    idleAfterMs: verifyMode ? 0 : Infinity,
  });
  stageRoot.addEventListener("pointerdown", () => stageKeyboardTarget.focus(), true);
  canvas.addEventListener("click", () => stageKeyboardTarget.focus());
  await hostReady;

  // The same authored GLB, camera, screen material, and raycast controls used
  // by the landing page wrap this host's live framebuffer. Loading the shell
  // separately keeps Three.js out of the editor bundle and lets compilation
  // start even while the model is still arriving.
  // The full demo matrix drives the hidden framebuffer deterministically and
  // exits each isolated browser as soon as its receipt is complete. Its Stage
  // shell has a separate raycast/WebGL verifier, so avoid starting GLB fetches
  // that would still be in flight when a short matrix run closes the page.
  if (!verifyMode) {
    void import("/assets/pocket-stage-web.js")
      .then(({ mountPocketStage }) => mountPocketStage(stageRoot, {
        host,
        readyText: "Playground PSP ready",
        errorText: "The PSP model could not be loaded. Using the 2D preview.",
        receiptName: "__playgroundStageReceipt",
      }))
      .then((controller) => {
        stageController = controller;
        stageController?.refreshScreen();
      })
      .catch((error) => {
        stageRoot.classList.add("has-error");
        const stageStatus = stageRoot.querySelector("[data-stage-status]");
        if (stageStatus) stageStatus.textContent = "The PSP model could not be loaded. Using the 2D preview.";
        console.error("Playground PSP module failed", error);
      });
  }

  // --- editor ---------------------------------------------------------------
  let compileTimer = 0;
  const scheduleCompile = () => {
    clearTimeout(compileTimer);
    setStatus("editing…");
    compileTimer = setTimeout(() => run(editor.state.doc.toString()), 450);
  };
  const editor = new EditorView({
    parent: $("#pg-editor"),
    state: EditorState.create({
      doc: "",
      extensions: [
        basicSetup,
        javascript({ jsx: true, typescript: true }),
        oneDark,
        EditorView.updateListener.of((v) => {
          if (v.docChanged) scheduleCompile();
        }),
        EditorView.theme({
          "&": { height: "100%", fontSize: "13px" },
          ".cm-scroller": { fontFamily: "var(--font-mono)", overflow: "auto" },
        }),
      ],
    }),
  });

  // --- demos ----------------------------------------------------------------
  let demos = [];
  let framework = "solid";
  try {
    demos = await (await fetch(PG + "demos.json")).json();
  } catch {
    demos = [];
  }
  for (const d of demos) {
    const opt = document.createElement("option");
    opt.value = d.name;
    opt.textContent = d.title || d.name;
    demoSel.appendChild(opt);
  }
  // Default to the motion-studies demo (the animation engine showcase).
  if (demos.some((d) => d.name === "motions")) demoSel.value = "motions";
  const setDoc = (src) =>
    editor.dispatch({ changes: { from: 0, to: editor.state.doc.length, insert: src } });
  const currentDemo = () => demos.find((d) => d.name === demoSel.value) || demos[0];
  const variantFor = (demo, fw) => {
    if (!demo) return null;
    if (Array.isArray(demo.variants)) return demo.variants.find((v) => v.framework === fw) || null;
    return fw === "solid" && demo.source ? { framework: "solid", source: demo.source } : null;
  };
  const currentVariant = () => variantFor(currentDemo(), framework);
  const setFramework = (next) => {
    const demo = currentDemo();
    if (!variantFor(demo, next)) return;
    framework = next;
    updateFrameworkButtons();
    const v = currentVariant();
    if (v) setDoc(v.source);
  };
  const updateFrameworkButtons = () => {
    const demo = currentDemo();
    for (const btn of frameworkBtns) {
      const fw = btn.dataset.framework;
      const available = !!variantFor(demo, fw);
      btn.disabled = !available;
      btn.classList.toggle("is-active", fw === framework);
      btn.setAttribute("aria-selected", fw === framework ? "true" : "false");
    }
  };

  // --- compile + run --------------------------------------------------------
  let running = false;
  let queued = null;
  async function run(source) {
    if (running) {
      queued = source;
      return;
    }
    running = true;
    setStatus("compiling…", "busy");
    showError("");
    try {
      const { compileApp, configure } = await loadCompiler();
      configure({ fontBaseUrl: PG + "fonts/", assetBaseUrl: "/demo-assets/" });
      const t0 = performance.now();
      const v = currentVariant();
      const activeFramework = v?.framework || framework;
      const result = await compileApp(source, {
        framework: activeFramework,
        spriteMeta: v?.spriteMeta,
      });
      // dispose previous app while the old core is still valid, then reset.
      try {
        globalThis.__pgDispose?.();
      } catch {}
      globalThis.__pgDispose = null;
      // A model tap may still be waiting for the old guest's next tick. End it
      // before reset() clears that callback so neither the host bit nor the
      // Stage pointer latch can leak into the newly compiled app.
      stageController?.releaseInput();
      globalThis.__pgStyles = result.styleMap;
      globalThis.__pgPak = result.pak;

      const appUrl = URL.createObjectURL(new Blob([result.code], { type: "text/javascript" }));
      const runtime = activeFramework === "vue-vapor"
        ? "@pocketjs/framework/vue-vapor"
        : activeFramework === "octane"
          ? "@pocketjs/framework/octane"
          : "@pocketjs/framework/solid";
      const mountExpr = activeFramework === "solid" ? "() => App()" : "App";
      const boot =
        `import App from ${JSON.stringify(appUrl)};\n` +
        `import { mount, __resetAll } from ${JSON.stringify(runtime)};\n` +
        `__resetAll();\n` +
        `globalThis.__pgDispose = mount(${mountExpr}, ` +
        `{ styles: globalThis.__pgStyles, pak: globalThis.__pgPak });\n`;
      const bootUrl = URL.createObjectURL(new Blob([boot], { type: "text/javascript" }));
      try {
        await host.runModule(() => import(/* @vite-ignore */ bootUrl), result.pak);
        // Browser regression mode advances exact virtual frames itself. Stop
        // the RAF after begin()'s single initial frame so ambient animation or
        // HUD timing cannot masquerade as an input result.
        if (verifyMode) host.stop();
        const ms = Math.round(performance.now() - t0);
        const fwLabel = { "vue-vapor": "Vue Vapor", octane: "Octane" }[activeFramework] || "Solid";
        setStatus(
          `${fwLabel} · ok · ${result.classCount} styles · ${result.slotCount} atlases` +
            (result.imageNames.length ? ` · ${result.imageNames.length} img` : "") +
            ` · ${ms} ms`,
          "ok",
        );
      } finally {
        URL.revokeObjectURL(appUrl);
        URL.revokeObjectURL(bootUrl);
      }
    } catch (e) {
      setStatus("error", "err");
      showError(String(e && e.stack ? e.stack : e));
    } finally {
      running = false;
      if (queued != null) {
        const s = queued;
        queued = null;
        run(s);
      }
    }
  }

  // --- controls -------------------------------------------------------------
  demoSel.addEventListener("change", () => {
    const d = currentDemo();
    if (d && !variantFor(d, framework)) framework = "solid";
    updateFrameworkButtons();
    const v = currentVariant();
    if (v) setDoc(v.source);
  });
  for (const btn of frameworkBtns) {
    btn.addEventListener("click", () => setFramework(btn.dataset.framework));
  }
  runBtn.addEventListener("click", () => run(editor.state.doc.toString()));
  resetBtn.addEventListener("click", () => {
    const v = currentVariant();
    if (v) setDoc(v.source);
  });

  // boot with the first demo (or a fallback), honoring ?demo=
  const boot = query.get("demo");
  const bootFramework = query.get("framework");
  if (boot && demos.some((d) => d.name === boot)) demoSel.value = boot;
  if (
    (bootFramework === "vue-vapor" || bootFramework === "octane") &&
    variantFor(currentDemo(), bootFramework)
  ) {
    framework = bootFramework;
  }
  const first = currentDemo();
  updateFrameworkButtons();
  const firstVariant = currentVariant();
  if (first && firstVariant) {
    setDoc(firstVariant.source);
    // setDoc triggers scheduleCompile; run immediately instead of waiting.
    clearTimeout(compileTimer);
    run(firstVariant.source);
  } else {
    setStatus("no demos found", "err");
  }
}

main().catch((e) => {
  const el = document.querySelector("#pg-error");
  if (el) {
    el.hidden = false;
    el.textContent = "playground failed to start: " + (e && e.stack ? e.stack : e);
  }
});
