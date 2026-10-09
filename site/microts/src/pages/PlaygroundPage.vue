<script setup lang="ts">
// Playground workspace: editor + preview. Opens an example (/playground/<preset>) or a local project (/playground/p/<id>).
import { computed, nextTick, onBeforeUnmount, onMounted, reactive, ref, shallowRef, watch } from "vue";
import { useRoute, useRouter } from "vue-router";
import CodeEditor, { type EditorDiagnostic } from "../playground/CodeEditor.vue";
import DeviceFrame from "../playground/DeviceFrame.vue";
import { GBA_RETRO, deviceFor, neutralDevice, type DeviceSpec } from "../playground/devices";
import PlaygroundPicker from "../playground/PlaygroundPicker.vue";
import { findPreset, retroAssetId, type Preset, type PresetFramework } from "../playground/presets";
import { createProject, getProject, saveProject, uniqueName, type Project } from "../playground/projects";
import { findTemplate, stubFor, templateFor } from "../playground/templates";
import { RetroHost, loadRetroAssets, type RetroStatus } from "../playground/retro/RetroHost";
import type { ButtonName } from "../playground/retro/protocol";
import { UiPreview, warmCompiler, type PspButton, type UiStatus } from "../playground/ui/UiPreview";
import { decodeShare, encodeShare, loadDraft, saveDraft } from "../playground/share";
import {
  DEFAULT_VIEWPORT,
  GBA_SCREEN,
  MAX_SIDE,
  MIN_SIDE,
  SCREENS,
  loadExampleViewport,
  presetFor,
  saveExampleViewport,
  validViewport,
  type Viewport,
} from "../playground/screens";

interface LogLine {
  id: number;
  level: string;
  text: string;
  time: string;
}

/** What the workspace has open: an example or a project */
interface Workspace {
  kind: "example" | "project";
  id: string;
  framework: PresetFramework;
  entry: string;
  open: string;
  order: string[];
  viewport: Viewport;
  controls: string;
  retroAssets: string | null;
  preset?: Preset;
}

const UI_CONTROLS = "Arrows move focus · Z or Enter presses";
const RETRO_CONTROLS = "Arrows move · Z is A · X is B · Enter is Start";
const FRAMEWORK_LABEL: Record<PresetFramework, string> = { "vue-vapor": "Vue SFC", solid: "Solid TSX", retro: "Pocket Retro" };
const FILE_NAME = /^[A-Za-z0-9_-]+(\/[A-Za-z0-9_-]+)*\.[a-z]+$/;

const route = useRoute();
const router = useRouter();

const ws = shallowRef<Workspace | null>(null);
const project = shallowRef<Project | null>(null);
const missing = ref(false);
const original = shallowRef<Record<string, string>>({});
const files = ref<Record<string, string>>({});
const active = ref("");
const loading = ref(true);
const diagnostic = ref<(EditorDiagnostic & { phase: string; stack?: string }) | null>(null);
const logs = ref<LogLine[]>([]);
const autoRun = reactive({ ui: true, retro: false });
const muted = ref(false);
const paused = ref(false);
const shareState = ref<"idle" | "copied" | "failed">("idle");
const editor = ref<InstanceType<typeof CodeEditor> | null>(null);

// Inline editing of file and project names
const naming = ref<{ mode: "add" | "rename"; from?: string; value: string } | null>(null);
const nameError = ref("");
const titleEditing = ref(false);
const titleDraft = ref("");

// Bottom panel: Console / About. Starts collapsed on short windows to leave the height to the device
const panelTab = ref<"console" | "about">("console");
const panelCollapsed = ref(typeof innerHeight === "number" && innerHeight < 780);

// Screen size: selectable for UI previews; retro takes it from system.init()
const customOpen = ref(false);
const customW = ref(480);
const customH = ref(272);
const customError = ref("");
let warnedSize = "";

// Browse dialog: pick a new starting point over the workspace without leaving the page
const browseDialog = ref<HTMLDialogElement | null>(null);
const browseOpen = ref(false);

const uiStatus = ref<UiStatus>({ state: "idle", fps: 0, memory: 0 });
const retroStatus = ref<RetroStatus>({ state: "idle", width: 0, height: 0, fps: 0, frameMs: 0 });

const stageHost = ref<HTMLElement | null>(null);
const canvas = ref<HTMLCanvasElement | null>(null);
let ui: UiPreview | null = null;
let retro: RetroHost | null = null;
let logId = 0;
let debounce: ReturnType<typeof setTimeout> | undefined;
let saveTimer: ReturnType<typeof setTimeout> | undefined;
let loadSeq = 0;

const isProject = computed(() => ws.value?.kind === "project");
const isRetro = computed(() => ws.value?.framework === "retro");
const hue = computed(() => (isRetro.value ? "hue-pink" : "hue-cyan"));
const title = computed(() => (isProject.value ? project.value?.name : ws.value?.preset?.title) ?? "Playground");
// Examples keep the preset's order; projects put the open file first, the entry last, the rest by name
const fileList = computed(() => {
  const w = ws.value;
  const names = Object.keys(files.value);
  if (w?.kind === "project") {
    const first = project.value?.open ?? w.open;
    const middle = names.filter((f) => f !== first && f !== w.entry).sort();
    return [...new Set([first, ...middle, w.entry])].filter((f) => f in files.value);
  }
  const order = (w?.order ?? []).filter((f) => f in files.value);
  return [...order, ...names.filter((f) => !order.includes(f)).sort()];
});
const changed = computed(() => Object.fromEntries(Object.entries(files.value).filter(([k, v]) => original.value[k] !== v)));
const sameSize = (a: Viewport, b: Viewport) => a.width === b.width && a.height === b.height;
/** Whether the example's screen size differs from the preset's own size */
const viewportChanged = computed(() => {
  const w = ws.value;
  return !!w?.preset && w.framework !== "retro" && !sameSize(w.viewport, w.preset.viewport ?? DEFAULT_VIEWPORT);
});
const dirty = computed(() => !isProject.value && (Object.keys(changed.value).length > 0 || viewportChanged.value));
/** Examples are laid out for their own size; on another size, note that overflow is clipped */
const layoutNote = computed(() => {
  const w = ws.value;
  if (!w?.preset || w.framework === "retro" || !viewportChanged.value) return "";
  const d = w.preset.viewport ?? DEFAULT_VIEWPORT;
  return `This example is laid out for ${d.width} × ${d.height}. On ${w.viewport.width} × ${w.viewport.height}, content past the screen edge is cut off; Text does not wrap.`;
});
/** Current value of the screen-size select: a preset id, or "current" (custom size) */
const screenChoice = computed(() => (ws.value ? (presetFor(ws.value.viewport)?.id ?? "current") : "psp"));
const state = computed(() => (isRetro.value ? retroStatus.value.state : uiStatus.value.state));
// Current device: retro games run on the GBA; UI apps get the device for the selected screen size, custom sizes only a screen bezel
const device = computed<DeviceSpec>(() => {
  if (isRetro.value) return GBA_RETRO;
  const v = ws.value?.viewport ?? DEFAULT_VIEWPORT;
  return deviceFor(presetFor(v)?.id) ?? neutralDevice(v);
});
// retro: as in Pocket Retro, frames up to 240 × 160 are scaled by a whole factor and centered in the GBA screen
const GBA_W = 240;
const GBA_H = 160;
const retroCanvasStyle = computed(() => {
  const w = retroStatus.value.width || ws.value?.viewport.width || GBA_W;
  const h = retroStatus.value.height || ws.value?.viewport.height || GBA_H;
  const fit = Math.min(GBA_W / w, GBA_H / h);
  const k = fit >= 1 ? Math.floor(fit) : fit;
  const pw = ((w * k) / GBA_W) * 100;
  const ph = ((h * k) / GBA_H) * 100;
  return { width: `${pw}%`, height: `${ph}%`, left: `${(100 - pw) / 2}%`, top: `${(100 - ph) / 2}%` };
});
/** Retro examples show each game's own controls; everything else shows the device's key map */
const keysHint = computed(() => (isRetro.value && ws.value?.preset ? ws.value.controls : device.value.legend));
const stateLabel = computed(
  () =>
    ({
      idle: "Idle",
      compiling: "Compiling",
      loading: "Loading",
      running: paused.value ? "Paused" : "Running",
      paused: "Paused",
      error: "Error",
    })[state.value],
);
const facts = computed(() => {
  if (isRetro.value) {
    const s = retroStatus.value;
    if (!s.width) return [];
    return [`${s.width}×${s.height}`, `${s.fps} fps`, `frame ${s.frameMs.toFixed(2)} ms`, "JS in a Worker"];
  }
  const s = uiStatus.value;
  const out: string[] = [];
  const v = ws.value?.viewport;
  if (v) out.push(`${v.width}×${v.height}`);
  if (s.state === "running") out.push(`${s.fps} fps`);
  if (s.memory) out.push(`wasm ${(s.memory / 1048576).toFixed(1)} MB`);
  if (s.compile) out.push(`compiled ${s.compile.files} files in ${s.compile.ms} ms`, `${s.compile.classes} styles`, `pak ${(s.compile.pakBytes / 1024).toFixed(0)} KB`);
  return out;
});

// ---------- Log ----------

function log(level: string, text: string) {
  const d = new Date();
  const time = `${String(d.getMinutes()).padStart(2, "0")}:${String(d.getSeconds()).padStart(2, "0")}`;
  logs.value.push({ id: ++logId, level, text, time });
  if (logs.value.length > 300) logs.value.splice(0, logs.value.length - 300);
  nextTick(() => {
    const el = document.getElementById("pg-console");
    if (el) el.scrollTop = el.scrollHeight;
  });
}

function showError(err: { phase: string; message: string; file?: string; line?: number; column?: number; stack?: string }) {
  // Runtime error locations come from the compiled module; .vue goes through template compilation, so line numbers do not match the source
  const line = err.file?.endsWith(".vue") && err.phase !== "compile" ? undefined : err.line;
  diagnostic.value = { ...err, file: err.file ?? (isRetro.value ? ws.value?.entry : undefined), line };
  log("error", `[${err.phase}] ${err.message}`);
}

// ---------- Run ----------

/** focus: move keyboard focus to the game canvas; auto-run while editing does not take focus */
async function run(focus = true) {
  clearTimeout(debounce);
  const w = ws.value;
  if (!w) return;
  diagnostic.value = null;
  paused.value = false;
  if (w.framework === "retro") {
    if (!retro) return;
    ui?.stop();
    try {
      const assets = await loadRetroAssets(w.retroAssets);
      if (w !== ws.value) return;
      await retro.start({ ...files.value }, w.entry, assets);
      if (focus) canvas.value?.focus({ preventScroll: true });
    } catch (e) {
      showError({ phase: "assets", message: String(e) });
    }
  } else {
    retro?.stop();
    await ui?.run({ ...files.value }, w.entry, w.framework, w.viewport, device.value.touch);
  }
}

function scheduleRun() {
  clearTimeout(debounce);
  if (!(isRetro.value ? autoRun.retro : autoRun.ui)) return;
  debounce = setTimeout(() => run(false), isRetro.value ? 900 : 600);
}

function persist(now = false) {
  clearTimeout(saveTimer);
  const w = ws.value;
  if (!w) return;
  if (w.kind === "example") return saveDraft(w.id, changed.value);
  const write = () => {
    if (!project.value || project.value.id !== w.id) return;
    project.value = { ...project.value, files: { ...files.value } };
    if (!saveProject(project.value)) log("warn", "Could not save the project: browser storage is full or unavailable.");
  };
  if (now) write();
  else saveTimer = setTimeout(write, 400);
}

function onChange(file: string, source: string) {
  files.value[file] = source;
  persist();
  scheduleRun();
}

// ---------- Open an example or project ----------

function reset() {
  persist(true);
  ui?.stop();
  retro?.stop();
  diagnostic.value = null;
  naming.value = null;
  titleEditing.value = false;
  customOpen.value = false;
  missing.value = false;
}

async function openExample(id: string, shared?: { files: Record<string, string>; viewport?: Viewport }) {
  const seq = ++loadSeq;
  const p = findPreset(id);
  if (!p) return void router.replace({ name: "playground-home" });
  loading.value = true;
  project.value = null;
  ws.value = {
    kind: "example",
    id: p.id,
    framework: p.framework,
    entry: p.entry,
    open: p.open,
    order: p.order,
    viewport:
      p.kind === "retro"
        ? (p.viewport ?? DEFAULT_VIEWPORT)
        : (shared ? shared.viewport : loadExampleViewport(p.id)) ?? p.viewport ?? DEFAULT_VIEWPORT,
    controls: p.controls,
    retroAssets: p.kind === "retro" ? retroAssetId(p) : null,
    preset: p,
  };
  document.title = `${p.title} · Playground · MicroTS`;
  const base = await p.load();
  if (seq !== loadSeq) return;
  original.value = base;
  const draft = shared?.files ?? loadDraft(p.id) ?? {};
  files.value = { ...base, ...Object.fromEntries(Object.entries(draft).filter(([k]) => k in base)) };
  active.value = p.open in files.value ? p.open : Object.keys(files.value)[0]!;
  if (shared) {
    saveDraft(p.id, changed.value);
    if (p.kind !== "retro") saveExampleViewport(p.id, viewportChanged.value ? ws.value!.viewport : null);
  }
  loading.value = false;
  log("info", `Opened ${p.title}${Object.keys(draft).length ? " with your edits" : ""}`);
  await nextTick();
  await run();
}

async function openProject(id: string) {
  ++loadSeq;
  const p = getProject(id);
  if (!p) {
    ws.value = null;
    project.value = null;
    missing.value = true;
    loading.value = false;
    document.title = "Project not found · Playground · MicroTS";
    return;
  }
  project.value = p;
  ws.value = {
    kind: "project",
    id: p.id,
    framework: p.framework,
    entry: p.entry,
    open: p.open,
    order: [p.open, ...(p.open === p.entry ? [] : [p.entry])],
    viewport: p.framework === "retro" ? { width: 160, height: 120 } : validViewport(p.viewport) ? p.viewport : DEFAULT_VIEWPORT,
    controls: p.framework === "retro" ? RETRO_CONTROLS : UI_CONTROLS,
    retroAssets: p.retroAssets,
  };
  original.value = {};
  files.value = { ...p.files };
  active.value = p.open in p.files ? p.open : p.entry;
  loading.value = false;
  document.title = `${p.name} · Playground · MicroTS`;
  log("info", `Opened project ${p.name}`);
  await nextTick();
  await run();
}

async function openRoute() {
  reset();
  if (route.name === "playground-project") return openProject(String(route.params.id));
  if (route.name !== "playground") return;
  let shared: { files: Record<string, string>; viewport?: Viewport } | undefined;
  const token = route.hash.match(/^#s=(.+)$/)?.[1];
  if (token) {
    const data = await decodeShare(token);
    if (data && "project" in data) return void router.replace({ name: "playground-import", hash: route.hash });
    if (data && data.preset === route.params.preset) shared = { files: data.files, viewport: data.viewport };
  }
  await openExample(String(route.params.preset), shared);
}

// ---------- Example and project actions ----------

function resetExample() {
  const w = ws.value;
  if (!w?.preset || !dirty.value || !confirm("Discard your edits to this example?")) return;
  saveDraft(w.id, {});
  saveExampleViewport(w.id, null);
  ws.value = { ...w, viewport: w.preset.viewport ?? DEFAULT_VIEWPORT };
  files.value = { ...original.value };
  void run(false);
}

// ---------- Screen size ----------

function setViewport(v: Viewport) {
  const w = ws.value;
  if (!w || w.framework === "retro" || sameSize(v, w.viewport)) return;
  ws.value = { ...w, viewport: v };
  if (w.kind === "example") saveExampleViewport(w.id, sameSize(v, w.preset?.viewport ?? DEFAULT_VIEWPORT) ? null : v);
  else if (project.value) {
    project.value = { ...project.value, viewport: v };
    saveProject(project.value);
  }
  const name = presetFor(v)?.label;
  log("info", `Screen set to ${v.width} × ${v.height}${name ? ` (${name})` : ""}. Layouts written for one size may need changes for another.`);
  void run(false);
}

/** Screen-size select: reads the current size; a preset switches to it, "custom" opens the width/height inputs (the select keeps showing the current size) */
const screenModel = computed({
  get: () => screenChoice.value,
  set: (value: string) => {
    if (value === "custom") return openCustom();
    const preset = SCREENS.find((s) => s.id === value);
    if (preset) setViewport({ width: preset.width, height: preset.height });
  },
});

function openCustom() {
  customW.value = ws.value?.viewport.width ?? 480;
  customH.value = ws.value?.viewport.height ?? 272;
  customError.value = "";
  customOpen.value = true;
  nextTick(() => (document.getElementById("pg-custom-w") as HTMLInputElement | null)?.select());
}

function applyCustom() {
  const v = { width: Number(customW.value), height: Number(customH.value) };
  if (!validViewport(v)) return void (customError.value = `Use whole numbers from ${MIN_SIDE} to ${MAX_SIDE}.`);
  customOpen.value = false;
  setViewport(v);
}

/** retro: the screen size is set in code; jump to the system.init() line */
function revealInit() {
  const w = ws.value;
  if (!w) return;
  const target = [w.entry, ...Object.keys(files.value)].find((f) => /system\.init\(/.test(files.value[f] ?? ""));
  if (!target) return void log("warn", "No system.init(width, height) call found. setup() sets the screen size with it.");
  const line = files.value[target]!.split("\n").findIndex((l) => l.includes("system.init(")) + 1;
  active.value = target;
  nextTick(() => editor.value?.reveal(line));
}

/** Copy the example (with current edits) into a project, where files can be added and removed */
function copyToProject() {
  const w = ws.value;
  if (!w?.preset) return;
  const t = templateFor(w.framework);
  const p = createProject({
    name: uniqueName(w.preset.title),
    template: t.id,
    framework: w.framework,
    entry: w.entry,
    open: active.value || w.open,
    files: { ...files.value },
    retroAssets: w.retroAssets,
    viewport: w.framework === "retro" ? undefined : w.viewport,
    from: w.id,
  });
  void router.push({ name: "playground-project", params: { id: p.id } });
}

async function share() {
  const w = ws.value;
  if (!w) return;
  try {
    let url: string;
    if (w.kind === "example") {
      const token = await encodeShare({ preset: w.id, files: changed.value, viewport: viewportChanged.value ? w.viewport : undefined });
      url = `${location.origin}${router.resolve({ name: "playground", params: { preset: w.id } }).href}#s=${token}`;
      history.replaceState(history.state, "", url);
    } else {
      const p = project.value!;
      const token = await encodeShare({
        project: {
          name: p.name,
          template: p.template,
          framework: p.framework,
          entry: p.entry,
          open: p.open,
          files: { ...files.value },
          retroAssets: p.retroAssets,
          viewport: p.viewport,
        },
      });
      url = `${location.origin}${router.resolve({ name: "playground-import" }).href}#s=${token}`;
    }
    await navigator.clipboard.writeText(url);
    shareState.value = "copied";
  } catch {
    shareState.value = "failed";
  }
  setTimeout(() => (shareState.value = "idle"), 2200);
}

function startRenameTitle() {
  if (!project.value) return;
  titleDraft.value = project.value.name;
  titleEditing.value = true;
  nextTick(() => (document.getElementById("pg-title-input") as HTMLInputElement | null)?.select());
}

function commitTitle() {
  const name = titleDraft.value.trim();
  titleEditing.value = false;
  if (!project.value || !name || name === project.value.name) return;
  project.value = { ...project.value, name };
  saveProject(project.value);
  document.title = `${name} · Playground · MicroTS`;
}

function openBrowse() {
  persist(true);
  browseOpen.value = true;
  nextTick(() => browseDialog.value?.showModal());
}

function closeBrowse() {
  browseDialog.value?.close();
}

/** Close on a click on the backdrop outside the dialog */
function onBrowseClick(e: MouseEvent) {
  if (e.target === browseDialog.value) closeBrowse();
}

/** The open project was deleted from the dialog: go back to the start page */
function onBrowseDeleted(id: string) {
  if (!isProject.value || ws.value?.id !== id) return;
  closeBrowse();
  project.value = null;
  ws.value = null;
  void router.replace({ name: "playground-home" });
}

// ---------- File management (projects only) ----------

const extensions = computed(() => {
  const p = project.value;
  return p ? (findTemplate(p.template)?.extensions ?? [".ts"]) : [];
});

function startAdd() {
  nameError.value = "";
  naming.value = { mode: "add", value: "" };
  nextTick(() => document.getElementById("pg-file-input")?.focus());
}

function startRename(file: string) {
  if (!isProject.value || file === ws.value?.entry) return;
  nameError.value = "";
  naming.value = { mode: "rename", from: file, value: file };
  nextTick(() => (document.getElementById("pg-file-input") as HTMLInputElement | null)?.select());
}

function validName(name: string, except?: string): string {
  if (!FILE_NAME.test(name)) return "Use letters, digits, - and _, with an extension.";
  if (!extensions.value.some((ext) => name.endsWith(ext))) return `This project accepts ${extensions.value.join(", ")} files.`;
  if (name !== except && name in files.value) return `${name} already exists.`;
  return "";
}

function commitName() {
  const n = naming.value;
  if (!n) return;
  const name = n.value.trim();
  if (!name || (n.mode === "rename" && name === n.from)) return void (naming.value = null);
  const error = validName(name, n.from);
  if (error) return void (nameError.value = error);
  if (n.mode === "add") {
    files.value = { ...files.value, [name]: stubFor(name, ws.value!.framework) };
    log("info", `Added ${name}`);
  } else {
    const next: Record<string, string> = {};
    for (const [k, v] of Object.entries(files.value)) next[k === n.from ? name : k] = v;
    files.value = next;
    const p = project.value;
    if (p && p.open === n.from) project.value = { ...p, open: name };
    log("info", `Renamed ${n.from} to ${name}. Imports that name the old file need the same change.`);
  }
  naming.value = null;
  active.value = name;
  persist(true);
  scheduleRun();
}

function removeFile(file: string) {
  if (!isProject.value || file === ws.value?.entry) return;
  if (!confirm(`Delete ${file}?`)) return;
  const next = { ...files.value };
  delete next[file];
  files.value = next;
  if (active.value === file) active.value = ws.value!.open in next ? ws.value!.open : ws.value!.entry;
  persist(true);
  scheduleRun();
}

function gotoDiagnostic() {
  const d = diagnostic.value;
  if (!d?.file || !(d.file in files.value)) return;
  active.value = d.file;
  if (d.line) nextTick(() => editor.value?.reveal(d.line!, d.column));
}

// ---------- Input ----------

function press(button: string, down: boolean) {
  if (isRetro.value) retro?.press(button as ButtonName, down);
  else ui?.press(button as PspButton, down);
}

function releaseCanvasKeys() {
  retro?.releaseKeys();
}

function onCanvasKey(e: KeyboardEvent, down: boolean) {
  if (!retro) return;
  const used = down ? retro.keyDown(e) : retro.keyUp(e);
  if (used) e.preventDefault();
}

function focusStage() {
  if (isRetro.value) {
    canvas.value?.focus({ preventScroll: true });
    void retro?.enableAudio();
  } else ui?.focus();
}

function togglePause() {
  paused.value = !paused.value;
  retro?.setPaused(paused.value);
}

function toggleMute() {
  muted.value = !muted.value;
  retro?.setMuted(muted.value);
}

function onKey(e: KeyboardEvent) {
  if ((e.metaKey || e.ctrlKey) && e.key === "Enter") {
    e.preventDefault();
    void run();
  }
}

// ---------- Lifecycle ----------

onMounted(() => {
  warmCompiler();
  ui = new UiPreview(stageHost.value!, {
    onLog: log,
    onError: (err) => showError(err),
    onStatus: (s) => (uiStatus.value = s),
  });
  retro = new RetroHost(canvas.value!, {
    onLog: log,
    onError: (err) => showError(err),
    onStatus: (s) => (retroStatus.value = s),
  });
  addEventListener("keydown", onKey);
  addEventListener("pagehide", flush);
  void openRoute();
});

const flush = () => persist(true);

// retro: warn when system.init() exceeds the GBA screen (the browser can show it, a ROM cannot)
watch(
  () => [retroStatus.value.width, retroStatus.value.height],
  ([w, h]) => {
    const key = `${ws.value?.id}:${w}x${h}`;
    if (!isRetro.value || !w || key === warnedSize) return;
    warnedSize = key;
    if (w > GBA_SCREEN.width || h > GBA_SCREEN.height)
      log("warn", `system.init(${w}, ${h}) is larger than the GBA screen (${GBA_SCREEN.width} × ${GBA_SCREEN.height}). The preview shows it; a ROM build cannot.`);
  },
);

watch(
  () => [route.name, route.params.preset, route.params.id],
  (next, prev) => {
    if (ui && next.some((v, i) => v !== prev?.[i])) void openRoute();
  },
);

onBeforeUnmount(() => {
  clearTimeout(debounce);
  persist(true);
  removeEventListener("keydown", onKey);
  removeEventListener("pagehide", flush);
  ui?.dispose();
  retro?.dispose();
});
</script>

<template>
  <div class="flex h-[calc(100dvh-3.6rem-3px)] min-h-[560px] flex-col max-lg:h-auto" :class="hue">
    <!-- Toolbar -->
    <div class="flex flex-wrap items-center gap-2 border-b-[3px] border-drop bg-[rgba(20,14,34,0.75)] px-4 py-2.5">
      <button type="button" class="tool" title="New project, your projects and examples" aria-haspopup="dialog" @click="openBrowse">
        <svg width="13" height="13" viewBox="0 0 13 13" aria-hidden="true">
          <rect x="0.5" y="0.5" width="5" height="5" rx="1.2" fill="currentColor" />
          <rect x="7.5" y="0.5" width="5" height="5" rx="1.2" fill="currentColor" />
          <rect x="0.5" y="7.5" width="5" height="5" rx="1.2" fill="currentColor" />
          <rect x="7.5" y="7.5" width="5" height="5" rx="1.2" fill="currentColor" />
        </svg>
        Browse
      </button>
      <div v-if="ws" class="flex min-w-0 items-center gap-2.5">
        <input
          v-if="titleEditing"
          id="pg-title-input"
          v-model="titleDraft"
          class="w-56 rounded-lg border-2 border-yellow bg-screen px-2 py-1 font-round text-[1.02rem] font-semibold text-ink outline-none"
          aria-label="Project name"
          @keydown.enter="commitTitle"
          @keydown.esc="titleEditing = false"
          @blur="commitTitle"
        />
        <h1
          v-else
          class="truncate font-round text-[1.12rem] font-semibold text-ink"
          :class="isProject ? 'cursor-text rounded-md px-1 hover:bg-[rgba(255,255,255,0.06)]' : ''"
          :title="isProject ? 'Rename project' : undefined"
          @click="startRenameTitle"
        >
          {{ title }}
        </h1>
        <span class="tag max-sm:hidden">{{ FRAMEWORK_LABEL[ws.framework] }}</span>
        <span v-if="isProject" class="badge max-md:hidden" title="Saved in this browser">project</span>
        <span v-if="dirty" class="badge text-yellow" title="Your edits are saved in this browser">edited</span>
      </div>
      <div v-if="ws" class="ml-auto flex flex-wrap items-center justify-end gap-2">
        <label class="tool cursor-pointer gap-2" title="Run after each edit">
          <input v-if="isRetro" v-model="autoRun.retro" type="checkbox" class="accent-yellow" />
          <input v-else v-model="autoRun.ui" type="checkbox" class="accent-yellow" />
          Auto-run
        </label>
        <template v-if="!isProject">
          <button type="button" class="tool" :disabled="!dirty" :class="{ 'opacity-50': !dirty }" @click="resetExample">Reset</button>
          <button type="button" class="tool" title="Copy this example into a project you can add files to" @click="copyToProject">Copy to project</button>
        </template>
        <button type="button" class="tool" @click="share">
          {{ shareState === "copied" ? "Link copied" : shareState === "failed" ? "Copy failed" : "Share" }}
        </button>
        <button type="button" class="tool tool-go" title="Run (⌘/Ctrl + Enter)" @click="run()">
          <svg width="11" height="12" viewBox="0 0 11 12" aria-hidden="true"><path d="M1 1l9 5-9 5z" fill="currentColor" /></svg>
          Run
        </button>
      </div>
    </div>

    <!-- Browse dialog -->
    <dialog
      ref="browseDialog"
      class="pg-browse m-auto w-[min(1080px,calc(100vw-1.5rem))] max-w-none overflow-hidden rounded-[24px] border-[3px] border-lilac bg-panel p-0 text-ink"
      aria-labelledby="pg-browse-title"
      @click="onBrowseClick"
      @close="browseOpen = false"
    >
      <div v-if="browseOpen" class="flex max-h-[min(88dvh,940px)] flex-col">
        <div class="flex items-center justify-between gap-3 px-5 pt-4 pb-3" style="border-bottom: 3px dotted rgba(169, 139, 255, 0.3)">
          <div class="flex items-center gap-3">
            <h2 id="pg-browse-title" class="font-round text-[1.3rem] font-semibold">Browse</h2>
            <span class="text-[0.86rem] text-muted max-sm:hidden">Your current work stays open until you pick something.</span>
          </div>
          <button type="button" class="tool" aria-label="Close" @click="closeBrowse">
            Close <kbd class="font-mono text-[0.72rem] text-muted">Esc</kbd>
          </button>
        </div>
        <div class="min-h-0 overflow-y-auto px-5 pt-5 pb-2">
          <PlaygroundPicker compact :current="ws?.id" @pick="closeBrowse" @deleted="onBrowseDeleted" />
        </div>
      </div>
    </dialog>

    <!-- Project not found -->
    <div v-if="missing" class="grid flex-1 place-items-center p-10 text-center">
      <div>
        <p class="font-round text-xl font-semibold">This project is not in this browser.</p>
        <p class="mt-2 text-soft">Projects are stored locally. Ask for a share link, or start a new one.</p>
        <RouterLink to="/playground" class="btn btn-primary mt-6">Browse</RouterLink>
      </div>
    </div>

    <div v-show="!missing" class="grid min-h-0 flex-1 lg:grid-cols-[minmax(0,1fr)_minmax(420px,46%)]">
      <!-- Editor -->
      <section class="flex min-h-0 min-w-0 flex-col bg-screen max-lg:h-[62vh]">
        <div class="flex items-end gap-1 overflow-x-auto border-b-2 border-[rgba(203,189,226,0.1)] bg-bg-2 px-4 pt-2" role="tablist">
          <template v-for="f in fileList" :key="f">
            <input
              v-if="naming?.mode === 'rename' && naming.from === f"
              id="pg-file-input"
              v-model="naming.value"
              class="mb-1 w-44 flex-none rounded-md border-2 border-yellow bg-screen px-2 py-0.5 font-mono text-[0.8rem] text-ink outline-none"
              aria-label="File name"
              @keydown.enter="commitName"
              @keydown.esc="naming = null"
              @blur="commitName"
            />
            <div
              v-else
              role="tab"
              :aria-selected="f === active"
              class="group flex flex-none items-center rounded-t-[9px] transition-colors"
              :class="f === active ? 'bg-screen text-yellow' : 'text-muted hover:text-ink-2'"
            >
              <button
                type="button"
                class="py-1.5 pl-3 font-mono text-[0.8rem]"
                :class="isProject && f !== ws?.entry && f === active ? 'pr-1' : 'pr-3'"
                :title="isProject && f !== ws?.entry ? 'Double-click to rename' : undefined"
                @click="active = f"
                @dblclick="startRename(f)"
              >
                {{ f }}<span v-if="!isProject && original[f] !== files[f]" class="ml-1 text-pink" title="edited">●</span>
              </button>
              <button
                v-if="isProject && f !== ws?.entry && f === active"
                type="button"
                class="mr-1.5 grid size-5 place-items-center rounded text-[0.9rem] leading-none text-muted hover:bg-[rgba(255,95,158,0.2)] hover:text-pink"
                :aria-label="`Delete ${f}`"
                @click="removeFile(f)"
              >
                ×
              </button>
            </div>
          </template>
          <input
            v-if="naming?.mode === 'add'"
            id="pg-file-input"
            v-model="naming.value"
            :placeholder="`Name${extensions[0]}`"
            class="mb-1 w-44 flex-none rounded-md border-2 border-yellow bg-screen px-2 py-0.5 font-mono text-[0.8rem] text-ink outline-none placeholder:text-dim"
            aria-label="New file name"
            @keydown.enter="commitName"
            @keydown.esc="naming = null"
            @blur="commitName"
          />
          <button
            v-else-if="isProject"
            type="button"
            class="mb-1 ml-1 grid size-7 flex-none place-items-center rounded-md font-mono text-[1rem] text-muted hover:bg-key hover:text-yellow"
            title="New file"
            aria-label="New file"
            @click="startAdd"
          >
            +
          </button>
        </div>
        <div v-if="nameError && naming" class="bg-[#2a0f22] px-4 py-1.5 font-round text-[0.8rem] text-pink-l">{{ nameError }}</div>
        <div class="relative min-h-0 flex-1">
          <CodeEditor
            v-if="!loading && active && active in files"
            ref="editor"
            :files="files"
            :active="active"
            :diagnostic="diagnostic"
            @change="onChange"
            @run="run()"
          />
          <div v-else class="grid h-full place-items-center font-round text-muted">Loading…</div>
        </div>
        <button
          v-if="diagnostic"
          type="button"
          class="flex max-h-40 items-start gap-3 overflow-auto border-t-[3px] border-pink bg-[#2a0f22] px-4 py-2.5 text-left"
          @click="gotoDiagnostic"
        >
          <span class="mt-0.5 flex-none rounded-md bg-pink px-1.5 py-0.5 font-round text-[0.72rem] font-semibold text-[#2a0d1c]">
            {{ diagnostic.phase }}
          </span>
          <span class="min-w-0">
            <span v-if="diagnostic.file" class="font-mono text-[0.78rem] text-pink-l">
              {{ diagnostic.file }}<template v-if="diagnostic.line">:{{ diagnostic.line }}</template>
            </span>
            <pre class="mt-0.5 font-mono text-[0.78rem] leading-snug whitespace-pre-wrap text-[#fecaca]">{{ diagnostic.message }}</pre>
          </span>
        </button>
      </section>

      <!-- Stage: the whole device (screen + buttons) always fits in the right column -->
      <section class="flex min-h-0 flex-col gap-3 p-4 max-lg:order-first">
        <div class="flex flex-wrap items-center justify-between gap-2">
          <span class="label">
            <i class="inline-block size-2 rounded-[2px]" :class="state === 'running' && !paused ? 'blink bg-ok' : state === 'error' ? 'bg-err' : 'bg-out/60'" />
            {{ stateLabel }}
          </span>
          <div class="flex flex-wrap items-center gap-1.5">
            <!-- UI: pick a device / screen size; retro: the size is set in system.init() -->
            <select
              v-if="ws && !isRetro"
              v-model="screenModel"
              class="screen-select"
              aria-label="Screen size"
              title="Device and screen size (app.viewport in pocket.json)"
            >
              <option v-for="sc in SCREENS" :key="sc.id" :value="sc.id">{{ sc.label }} · {{ sc.width }} × {{ sc.height }}</option>
              <option v-if="screenChoice === 'current'" value="current">Custom · {{ ws.viewport.width }} × {{ ws.viewport.height }}</option>
              <option value="custom">Custom size…</option>
            </select>
            <button
              v-else-if="ws"
              type="button"
              class="tool !min-h-8 !px-2.5 !text-[0.8rem]"
              title="The game sets its screen size in setup() with system.init(width, height)"
              @click="revealInit"
            >
              {{ retroStatus.width || ws.viewport.width }} × {{ retroStatus.height || ws.viewport.height }}
              <span class="font-mono text-[0.72rem] text-muted">system.init</span>
            </button>
            <template v-if="isRetro">
              <button type="button" class="tool !min-h-8 !px-2.5 !text-[0.8rem]" :aria-pressed="paused" @click="togglePause">{{ paused ? "Resume" : "Pause" }}</button>
              <button type="button" class="tool !min-h-8 !px-2.5 !text-[0.8rem]" :aria-pressed="muted" @click="toggleMute">{{ muted ? "Muted" : "Sound" }}</button>
            </template>
            <button type="button" class="tool !min-h-8 !px-2.5 !text-[0.8rem]" @click="run()">Restart</button>
          </div>
        </div>
        <form v-if="customOpen" class="flex flex-wrap items-center gap-2" @submit.prevent="applyCustom">
          <label class="sr-only-text" for="pg-custom-w">Width</label>
          <input
            id="pg-custom-w"
            v-model.number="customW"
            type="number"
            :min="MIN_SIDE"
            :max="MAX_SIDE"
            class="w-20 rounded-lg border-2 border-[rgba(203,189,226,0.25)] bg-screen px-2 py-1 font-mono text-[0.85rem] text-ink outline-none focus:border-yellow"
          />
          <span class="font-mono text-muted">×</span>
          <label class="sr-only-text" for="pg-custom-h">Height</label>
          <input
            id="pg-custom-h"
            v-model.number="customH"
            type="number"
            :min="MIN_SIDE"
            :max="MAX_SIDE"
            class="w-20 rounded-lg border-2 border-[rgba(203,189,226,0.25)] bg-screen px-2 py-1 font-mono text-[0.85rem] text-ink outline-none focus:border-yellow"
          />
          <button type="submit" class="tool tool-go !min-h-8 !px-2.5 !text-[0.8rem]">Apply</button>
          <button type="button" class="tool !min-h-8 !px-2.5 !text-[0.8rem]" @click="customOpen = false">Cancel</button>
          <span v-if="customError" class="font-round text-[0.8rem] text-pink-l">{{ customError }}</span>
        </form>

        <!-- Device: scaled proportionally to fit this area -->
        <div class="relative min-h-[220px] flex-1 max-lg:h-[min(62vh,560px)] max-lg:flex-none">
          <DeviceFrame :device="device" :mode="isRetro ? 'retro' : 'ui'" @press="press">
            <div v-show="!isRetro" ref="stageHost" class="absolute inset-0" />
            <canvas
              v-show="isRetro"
              ref="canvas"
              tabindex="0"
              class="absolute outline-none [image-rendering:pixelated]"
              :style="retroCanvasStyle"
              aria-label="Game screen. Focus it to play with the keyboard."
              @pointerdown="focusStage"
              @keydown="onCanvasKey($event, true)"
              @keyup="onCanvasKey($event, false)"
              @blur="releaseCanvasKeys"
            />
            <div
              v-if="state === 'compiling' || state === 'loading'"
              class="absolute inset-0 grid place-items-center bg-[rgba(18,12,33,0.6)] font-px text-[0.55rem] tracking-[0.06em] text-yellow"
            >
              <span class="blink">{{ state === "compiling" ? "COMPILING" : "LOADING" }}</span>
            </div>
          </DeviceFrame>
        </div>

        <div class="flex-none space-y-1 text-[0.78rem] leading-snug">
          <p class="text-soft">
            <b class="font-round font-semibold text-ink">{{ isRetro ? "Game Boy Advance" : device.name }}</b> · {{ keysHint }}
          </p>
          <div class="flex flex-wrap gap-x-3 gap-y-0.5 font-mono text-[0.7rem] tracking-[0.04em] text-muted">
            <span v-for="f in facts" :key="f">{{ f }}</span>
          </div>
          <p v-if="layoutNote" class="font-round text-orange-l">{{ layoutNote }}</p>
        </div>

        <!-- Console / About -->
        <div class="flex-none rounded-[14px] border-[2.5px] border-[rgba(169,139,255,0.3)] bg-panel">
          <div class="flex items-center gap-1 px-2 py-1.5">
            <button
              v-for="t in [{ id: 'console', label: 'Console' }, { id: 'about', label: 'About' }] as const"
              :key="t.id"
              type="button"
              class="rounded-md px-2 py-1 font-round text-[0.82rem] font-semibold"
              :class="panelTab === t.id && !panelCollapsed ? 'bg-key text-lilac-l' : 'text-muted hover:text-ink-2'"
              @click="panelTab === t.id ? (panelCollapsed = !panelCollapsed) : ((panelTab = t.id), (panelCollapsed = false))"
            >
              {{ t.label }}<span v-if="t.id === 'console' && logs.length" class="ml-1 text-dim">{{ logs.length }}</span>
            </button>
            <span v-if="panelCollapsed && logs.length" class="ml-1 min-w-0 flex-1 truncate font-mono text-[0.72rem]" :class="logs.at(-1)!.level === 'error' ? 'text-[#fecaca]' : 'text-dim'">
              {{ logs.at(-1)!.text }}
            </span>
            <span v-else class="flex-1" />
            <button
              v-if="panelTab === 'console' && !panelCollapsed"
              type="button"
              class="px-1.5 font-round text-[0.78rem] font-semibold text-muted hover:text-yellow"
              @click="logs = []"
            >
              Clear
            </button>
            <button
              type="button"
              class="grid size-6 place-items-center rounded-md text-muted hover:text-ink"
              :aria-label="panelCollapsed ? 'Expand panel' : 'Collapse panel'"
              :aria-expanded="!panelCollapsed"
              @click="panelCollapsed = !panelCollapsed"
            >
              <svg width="10" height="10" viewBox="0 0 10 10" aria-hidden="true" :class="panelCollapsed ? 'rotate-180' : ''">
                <path d="M2 6.5 5 3.5 8 6.5" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" />
              </svg>
            </button>
          </div>
          <div v-show="!panelCollapsed" id="pg-console" class="h-28 overflow-y-auto px-3.5 pb-3 text-[0.74rem] leading-relaxed">
            <template v-if="panelTab === 'console'">
              <div v-for="l in logs" :key="l.id" class="flex gap-2 font-mono" :class="l.level === 'error' ? 'text-[#fecaca]' : l.level === 'warn' ? 'text-orange-l' : 'text-ink-2'">
                <span class="flex-none text-dim">{{ l.time }}</span>
                <span class="break-all whitespace-pre-wrap">{{ l.text }}</span>
              </div>
              <div v-if="!logs.length" class="font-mono text-dim">console.log output from the app appears here.</div>
            </template>
            <div v-else class="space-y-1.5 text-[0.8rem] text-soft">
              <template v-if="ws?.preset">
                <p>{{ ws.preset.blurb }}</p>
                <p>
                  Source:
                  <RouterLink v-if="ws.preset.source.href.startsWith('/')" :to="ws.preset.source.href" class="olink text-cyan">{{ ws.preset.source.label }}</RouterLink>
                  <a v-else :href="ws.preset.source.href" target="_blank" rel="noopener" class="olink text-cyan">{{ ws.preset.source.label }}</a>
                  <template v-if="ws.preset.credit">
                    · original by {{ ws.preset.credit }} ·
                    <a href="/retro/THIRD_PARTY_NOTICES.md" target="_blank" rel="noopener" class="olink text-cyan">licenses</a>
                  </template>
                </p>
              </template>
              <p v-else-if="project">
                Saved in this browser. <b class="font-semibold text-ink-2">+</b> adds a file; double-click a tab to rename it.
                <template v-if="project.from">Copied from <RouterLink :to="`/playground/${project.from}`" class="olink text-cyan">{{ findPreset(project.from)?.title ?? project.from }}</RouterLink>.</template>
              </p>
              <p class="text-muted">
                The preview runs this TypeScript as JavaScript in the tab; the native build compiles the same source to Rust.
                <RouterLink to="/docs/typescript-support#execution-modes" class="olink text-cyan">Execution modes</RouterLink>
              </p>
            </div>
          </div>
        </div>
      </section>
    </div>
  </div>
</template>

<style scoped>
.pg-browse {
  box-shadow: 0 8px 0 var(--color-lilac-d), 0 30px 90px rgba(0, 0, 0, 0.6);
}
/*
 * Does not reuse .tool: while the dropdown is open, Firefox listens for transitionend on the <select>
 * and rebuilds the whole popup menu when a color / background-color transition ends (toolkit/actors/SelectChild.sys.mjs),
 * which swallows the click in progress and takes a second click. No transitions here; hover changes only the border.
 */
.screen-select {
  appearance: none;
  /* Width follows the selected option, not the longest one */
  field-sizing: content;
  cursor: pointer;
  min-height: 2rem;
  padding: 0 2rem 0 0.625rem;
  border-radius: 10px;
  border: 2px solid rgba(203, 189, 226, 0.18);
  background-color: var(--color-key);
  box-shadow: var(--shadow-key);
  color: var(--color-ink-2);
  font: 600 0.8rem/1 var(--font-round);
  letter-spacing: 0.01em;
  transition: none;
  background-image: url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='10' height='10' viewBox='0 0 10 10'%3E%3Cpath d='M2 3.5 5 6.5 8 3.5' fill='none' stroke='%23cbbde2' stroke-width='1.8' stroke-linecap='round' stroke-linejoin='round'/%3E%3C/svg%3E");
  background-repeat: no-repeat;
  background-position: right 0.6rem center;
}
.screen-select:hover {
  border-color: rgba(203, 189, 226, 0.45);
}
.screen-select option {
  background: var(--color-panel);
  color: var(--color-ink);
}
.pg-browse::backdrop {
  background: rgba(10, 6, 20, 0.72);
  backdrop-filter: blur(3px);
}
@media (prefers-reduced-motion: no-preference) {
  .pg-browse[open] {
    animation: pg-pop 0.22s var(--ease-spring);
  }
}
@keyframes pg-pop {
  from {
    transform: translateY(12px) scale(0.98);
    opacity: 0;
  }
}
</style>
