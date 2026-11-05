// programs/web/dev/devtools.js — all panel logic for devtools.html. Vanilla ES module,
// no build step, no external requests. Protocol: docs/DEVTOOLS.md §4 — one JSON
// object per WebSocket message, relayed verbatim by the hub in serve.ts.
//
// Panel → device : inspect(id) · pause · resume · step · getTree ·
//                  eval(id, code) · dumpTape · seek(frame) · replay(tape) ·
//                  screenshot
// Device → panel : hello · tree · inspect · stats · log · error · evalResult ·
//                  tape · screenshot(frame, data:image/png;base64 URL)
// Hub notices    : deviceConnected · deviceGone

const $ = (id) => document.getElementById(id);

const MAX_LOG_LINES = 500; // console cap
const DEFAULT_EXPAND_DEPTH = 6; // tree rows deeper than this start collapsed
const MAX_TREE_NODES = 20000; // DOM safety cap for malformed/giant trees
const MAX_TAPE_FRAMES = 4_000_000; // RLE expansion safety cap (~18 h)

// ---------------------------------------------------------------- state ----

let ws = null;
let backoff = 500; // ms, doubles to 8 s
let hubUp = false;
let deviceUp = false; // saw hello / stats / deviceConnected since last drop
let appInfo = null; // { app, host } from hello
let stats = null; // last {frame, nodes, tapeLen, paused}

let root = null; // last tree root
const nodeById = new Map(); // id -> protocol node
const collapsedOverride = new Map(); // id -> bool (user toggles, survives tree updates)

let hoveredId = null;
let pinnedId = null;
let lastInspectSent = null; // throttle: never resend the same inspect id
let lastInspect = null; // last {id, rect} response from the device

let tape = null; // last received/imported tape object
let tapeMasks = null; // Uint16Array, RLE-expanded
let actCache = null; // { w, act: Uint8Array } activity buckets for the strip

let evalSeq = 0;
const replHistory = [];
let histIdx = 0;
let histDraft = "";

let shotTimer = null; // pending-screenshot timeout id (null = not pending)

// ------------------------------------------------------------ websocket ----

function connect() {
  try {
    ws = new WebSocket(`ws://${location.host}/ws?role=panel`);
  } catch {
    scheduleReconnect();
    return;
  }
  ws.onopen = () => {
    hubUp = true;
    backoff = 500;
    lastInspectSent = null; // device state unknown after (re)connect
    send({ t: "getTree" });
    renderStatus();
  };
  ws.onmessage = (ev) => {
    let msg;
    try {
      msg = JSON.parse(ev.data);
    } catch {
      return; // malformed — ignore
    }
    if (!msg || typeof msg.t !== "string") return;
    try {
      const h = HANDLERS[msg.t];
      if (h) h(msg); // unknown t — ignore
    } catch {
      /* a bad message must never take the panel down */
    }
  };
  ws.onclose = () => {
    hubUp = false;
    deviceUp = false;
    endShot();
    renderStatus();
    scheduleReconnect();
  };
  ws.onerror = () => {
    try {
      ws.close();
    } catch {}
  };
}

function scheduleReconnect() {
  setTimeout(connect, backoff);
  backoff = Math.min(backoff * 2, 8000);
}

function send(obj) {
  if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(obj));
}

// ------------------------------------------------------ message handlers ----

const HANDLERS = {
  hello(m) {
    deviceUp = true;
    appInfo = { app: String(m.app ?? "?"), host: String(m.host ?? "?") };
    if (typeof m.frame === "number") $("statFrame").textContent = String(m.frame);
    send({ t: "getTree" });
    renderStatus();
  },
  tree(m) {
    if (m.root && typeof m.root === "object") setTree(m.root);
  },
  inspect(m) {
    if (typeof m.id !== "number") return;
    lastInspect = { id: m.id, rect: Array.isArray(m.rect) ? m.rect : null };
    renderDetails();
  },
  stats(m) {
    stats = m;
    if (!deviceUp) {
      deviceUp = true; // stats may arrive before hello — order-independent
      renderStatus();
    }
    renderStats();
    drawStrip(); // keep the current-frame marker live
  },
  log(m) {
    const text = Array.isArray(m.args) ? m.args.map(String).join(" ") : String(m.args ?? "");
    addLine(levelClass(m.level), text);
  },
  error(m) {
    const line = addLine("error", `✖ frame ${m.frame ?? "?"}: ${m.message ?? "error"}`);
    if (m.stack) {
      const pre = document.createElement("pre");
      pre.className = "stack";
      pre.textContent = String(m.stack);
      line.appendChild(pre);
    }
  },
  evalResult(m) {
    const value = typeof m.value === "string" ? m.value : safeJson(m.value);
    if (m.ok) addLine("result", "= " + value);
    else addLine("error", "✖ " + value);
  },
  tape(m) {
    if (m.tape) setTape(m.tape);
  },
  screenshot(m) {
    endShot(); // clear pending regardless of payload shape
    if (typeof m.data !== "string" || !m.data.startsWith("data:image/")) return;
    const frame = typeof m.frame === "number" ? m.frame : 0;
    const name = `${(appInfo && appInfo.app) || "device"}-f${frame}.png`;
    downloadDataUrl(m.data, name);
    addShot(m.data, frame, name);
  },
  deviceConnected() {
    deviceUp = true;
    lastInspectSent = null; // fresh device knows nothing of our selection
    send({ t: "getTree" });
    renderStatus();
  },
  deviceGone() {
    deviceUp = false;
    appInfo = null;
    endShot(); // no response is coming
    renderStatus();
  },
};

function levelClass(level) {
  const l = String(level ?? "log");
  return l === "warn" || l === "error" || l === "info" || l === "debug" ? l : "log";
}

function safeJson(v) {
  try {
    return JSON.stringify(v) ?? String(v);
  } catch {
    return String(v);
  }
}

// -------------------------------------------------------- header / status ----

function renderStatus() {
  const dot = $("connDot");
  const txt = $("connText");
  const app = $("appInfo");
  if (!hubUp) {
    dot.className = "dot bad";
    txt.textContent = "disconnected — retrying…";
    app.textContent = "";
  } else if (!deviceUp) {
    dot.className = "dot warn";
    txt.textContent = "hub connected — waiting for device…";
    app.textContent = "";
  } else {
    dot.className = "dot ok";
    txt.textContent = "device connected";
    app.textContent = appInfo ? `${appInfo.app} @ ${appInfo.host}` : "";
  }
  $("treeEmpty").classList.toggle("hidden", !!root);
  $("tree").classList.toggle("stale", !deviceUp && !!root);
}

function renderStats() {
  if (!stats) return;
  $("statFrame").textContent = num(stats.frame);
  $("statNodes").textContent = num(stats.nodes);
  $("statTape").textContent = num(stats.tapeLen);
  $("statPaused").classList.toggle("hidden", !stats.paused);
  $("btnPause").classList.toggle("active", !!stats.paused);
}

function num(v) {
  return typeof v === "number" ? String(v) : "–";
}

// ------------------------------------------------------------ tree panel ----

function setTree(newRoot) {
  root = newRoot;
  nodeById.clear();
  const frag = document.createDocumentFragment();
  buildNode(newRoot, 0, frag);
  $("treeRows").replaceChildren(frag);
  if (pinnedId !== null && !nodeById.has(pinnedId)) {
    pinnedId = null; // pinned node vanished from the tree
  }
  renderStatus();
  renderDetails();
}

function buildNode(node, depth, parentEl) {
  if (!node || typeof node !== "object" || typeof node.i !== "number") return;
  if (depth > 64 || nodeById.size >= MAX_TREE_NODES) return;
  nodeById.set(node.i, node);

  const kids = Array.isArray(node.k) ? node.k : [];
  const collapsed = kids.length > 0 && isCollapsed(node.i, depth);

  const row = document.createElement("div");
  row.className = "row" + (node.i === pinnedId ? " pinned" : "");
  row.dataset.id = String(node.i);
  row.style.paddingLeft = 8 + depth * 14 + "px";

  const caret = document.createElement("span");
  caret.className = "caret" + (kids.length ? "" : " none");
  caret.textContent = kids.length ? (collapsed ? "▸" : "▾") : "·";
  row.appendChild(caret);

  if (node.n) {
    const b = document.createElement("b");
    b.textContent = String(node.n);
    row.appendChild(b);
  }
  const ty = document.createElement("span");
  ty.className = node.n ? "type dim" : "type";
  ty.textContent = String(node.t ?? "?");
  row.appendChild(ty);

  const sum = summarize(node);
  if (sum) {
    const s = document.createElement("span");
    s.className = "sum";
    s.textContent = sum;
    row.appendChild(s);
  }
  parentEl.appendChild(row);

  if (kids.length) {
    const kidsEl = document.createElement("div");
    kidsEl.className = "kids" + (collapsed ? " hidden" : "");
    kidsEl.dataset.owner = String(node.i);
    for (const k of kids) buildNode(k, depth + 1, kidsEl);
    parentEl.appendChild(kidsEl);
  }
}

function isCollapsed(id, depth) {
  const o = collapsedOverride.get(id);
  return o !== undefined ? o : depth >= DEFAULT_EXPAND_DEPTH;
}

function summarize(node) {
  const parts = [];
  if (node.c) parts.push(String(node.c));
  if (node.x) parts.push(`"${String(node.x)}"`);
  return parts.join("  ");
}

function toggleRow(row, id) {
  const kidsEl = row.nextElementSibling;
  if (!kidsEl || !kidsEl.classList.contains("kids")) return;
  const nowCollapsed = !kidsEl.classList.contains("hidden");
  kidsEl.classList.toggle("hidden", nowCollapsed);
  collapsedOverride.set(id, nowCollapsed);
  row.firstChild.textContent = nowCollapsed ? "▸" : "▾";
}

function sendInspect(id) {
  id = id | 0;
  if (id === lastInspectSent) return; // throttle duplicates
  lastInspectSent = id;
  send({ t: "inspect", id });
}

function setHover(id) {
  if (id === hoveredId) return;
  hoveredId = id;
  if (pinnedId === null) {
    sendInspect(id ?? 0);
    renderDetails();
  }
}

function pin(id) {
  if (pinnedId === id) {
    unpin();
    return;
  }
  pinnedId = id;
  sendInspect(id);
  updatePinClass();
  renderDetails();
}

function unpin() {
  pinnedId = null;
  sendInspect(hoveredId ?? 0); // resume hover, or clear
  updatePinClass();
  renderDetails();
}

function updatePinClass() {
  const rows = $("treeRows");
  const prev = rows.querySelector(".row.pinned");
  if (prev) prev.classList.remove("pinned");
  if (pinnedId !== null) {
    const row = rows.querySelector(`.row[data-id="${pinnedId}"]`);
    if (row) row.classList.add("pinned");
  }
}

{
  const rows = $("treeRows");
  rows.addEventListener("click", (e) => {
    const row = e.target.closest(".row");
    if (!row) return;
    const id = Number(row.dataset.id);
    if (e.target.classList.contains("caret") && !e.target.classList.contains("none")) {
      toggleRow(row, id);
      return;
    }
    if (nodeById.get(id)?.v) return;
    pin(id);
  });
  rows.addEventListener("mouseover", (e) => {
    const row = e.target.closest(".row");
    if (row) {
      const id = Number(row.dataset.id);
      setHover(nodeById.get(id)?.v ? null : id);
    }
  });
  $("tree").addEventListener("mouseleave", () => setHover(null));
}

// ---------------------------------------------------------- details pane ----

function renderDetails() {
  const id = pinnedId ?? hoveredId;
  const node = id !== null && id !== undefined ? nodeById.get(id) : undefined;
  const body = $("detailsBody");
  if (!node) {
    const d = document.createElement("div");
    d.className = "dim";
    d.style.fontStyle = "italic";
    d.textContent = root ? "hover or click a node in the tree" : "waiting for device…";
    body.replaceChildren(d);
    return;
  }
  const frag = document.createDocumentFragment();
  const kv = (k, v, cls) => {
    const r = document.createElement("div");
    r.className = "kv";
    const kEl = document.createElement("span");
    kEl.className = "k";
    kEl.textContent = k;
    const vEl = document.createElement("span");
    vEl.className = "v" + (cls ? " " + cls : "");
    vEl.textContent = v;
    r.append(kEl, vEl);
    frag.appendChild(r);
    return vEl;
  };
  const idEl = kv("id", String(node.i));
  if (pinnedId === node.i) {
    const tag = document.createElement("span");
    tag.className = "pinTag";
    tag.textContent = "pinned — Esc to release";
    idEl.appendChild(tag);
  }
  kv("type", String(node.t ?? "?"));
  kv("debugName", node.n ? String(node.n) : "—", node.n ? "" : "dim");
  kv("class", node.c ? String(node.c) : "—", node.c ? "" : "dim");
  kv("text", node.x ? String(node.x) : "—", node.x ? "" : "dim");
  const rect = lastInspect && lastInspect.id === node.i ? lastInspect.rect : undefined;
  if (rect === undefined) kv("rect", "…", "dim"); // inspect response not in yet
  else if (rect === null) kv("rect", "not painted", "dim");
  else kv("rect", `[${rect.join(", ")}]  (x, y, w, h)`);
  body.replaceChildren(frag);
}

// --------------------------------------------------------- console + REPL ----

function addLine(cls, text) {
  const el = $("consoleLog");
  const stick = el.scrollTop + el.clientHeight >= el.scrollHeight - 40;
  const d = document.createElement("div");
  d.className = "line " + cls;
  d.textContent = text;
  el.appendChild(d);
  while (el.children.length > MAX_LOG_LINES) el.firstChild.remove();
  if (stick) el.scrollTop = el.scrollHeight;
  return d;
}

{
  const repl = $("repl");
  repl.addEventListener("keydown", (e) => {
    if (e.key === "Enter") {
      const code = repl.value.trim();
      if (!code) return;
      replHistory.push(code);
      histIdx = replHistory.length;
      histDraft = "";
      addLine("input", "› " + code);
      send({ t: "eval", id: ++evalSeq, code });
      repl.value = "";
    } else if (e.key === "ArrowUp") {
      if (histIdx > 0) {
        if (histIdx === replHistory.length) histDraft = repl.value;
        histIdx--;
        repl.value = replHistory[histIdx];
        e.preventDefault();
      }
    } else if (e.key === "ArrowDown") {
      if (histIdx < replHistory.length) {
        histIdx++;
        repl.value = histIdx === replHistory.length ? histDraft : replHistory[histIdx];
        e.preventDefault();
      }
    }
  });
}

// Esc: clear the REPL draft if typing, otherwise unpin the selection.
document.addEventListener("keydown", (e) => {
  if (e.key !== "Escape") return;
  const repl = $("repl");
  if (document.activeElement === repl && repl.value) {
    repl.value = "";
    histIdx = replHistory.length;
    return;
  }
  if (pinnedId !== null) unpin();
});

// ------------------------------------------------------------ screenshots ----
// On-demand capture (no streaming): send {t:"screenshot"}, device answers with
// {t:"screenshot", frame, data:"data:image/png;base64,…"}. PSP pushes ~550 KB
// over USB, so the pending state times out after 15 s. Unsupported hosts may
// only reply with a warn log — the timeout covers that too.

const SHOT_TIMEOUT_MS = 15000;
const MAX_SHOTS = 6; // thumbnails kept; oldest drops

$("btnShot").addEventListener("click", () => {
  if (shotTimer !== null) return; // one in flight at a time
  send({ t: "screenshot" });
  $("btnShot").disabled = true;
  shotTimer = setTimeout(endShot, SHOT_TIMEOUT_MS);
});

function endShot() {
  if (shotTimer !== null) {
    clearTimeout(shotTimer);
    shotTimer = null;
  }
  $("btnShot").disabled = false;
}

function downloadDataUrl(dataUrl, name) {
  const a = document.createElement("a");
  a.href = dataUrl;
  a.download = name;
  a.click();
}

function addShot(dataUrl, frame, name) {
  const strip = $("shots");
  const a = document.createElement("a");
  a.className = "shot";
  a.href = dataUrl;
  a.target = "_blank"; // middle/ctrl-click: browser default opens a new tab
  a.rel = "noopener";
  a.title = name + " — click to download, ctrl/middle-click to open";
  a.addEventListener("click", (e) => {
    // Plain left-click re-downloads; modified clicks keep browser behavior.
    if (e.button === 0 && !e.ctrlKey && !e.metaKey && !e.shiftKey && !e.altKey) {
      e.preventDefault();
      downloadDataUrl(dataUrl, name);
    }
  });
  const img = document.createElement("img");
  img.src = dataUrl;
  img.alt = name;
  const cap = document.createElement("span");
  cap.className = "cap";
  cap.textContent = "f" + frame;
  a.append(img, cap);
  strip.appendChild(a);
  while (strip.children.length > MAX_SHOTS) strip.firstChild.remove();
  strip.classList.remove("hidden");
  strip.scrollLeft = strip.scrollWidth; // newest visible
}

// -------------------------------------------------- time travel / tape bar ----

$("btnPause").addEventListener("click", () => send({ t: "pause" }));
$("btnResume").addEventListener("click", () => send({ t: "resume" }));
$("btnStep").addEventListener("click", () => send({ t: "step" }));
$("btnLoadTape").addEventListener("click", () => send({ t: "dumpTape" }));
$("btnExport").addEventListener("click", exportTape);
$("btnReplay").addEventListener("click", () => $("replayFile").click());
$("replayFile").addEventListener("change", onReplayFile);

function setTape(t) {
  if (!t || typeof t !== "object" || !Array.isArray(t.masks)) return;
  let total = 0;
  for (const run of t.masks) {
    if (!Array.isArray(run) || run.length < 2) return;
    total += run[1] | 0;
  }
  if (total <= 0 || total > MAX_TAPE_FRAMES) return;
  const masks = new Uint16Array(total);
  let off = 0;
  for (const [mask, count] of t.masks) {
    masks.fill(mask & 0xffff, off, off + (count | 0));
    off += count | 0;
  }
  tape = t;
  tapeMasks = masks;
  actCache = null;
  $("btnExport").disabled = false;
  updateStripInfo();
  drawStrip();
}

function exportTape() {
  if (!tape) return;
  const blob = new Blob([JSON.stringify(tape)], { type: "application/json" });
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = `${tape.app || "tape"}-${tape.frames ?? tapeMasks.length}f.json`;
  a.click();
  URL.revokeObjectURL(a.href);
}

async function onReplayFile(e) {
  const f = e.target.files && e.target.files[0];
  e.target.value = "";
  if (!f) return;
  let parsed;
  try {
    parsed = JSON.parse(await f.text());
  } catch {
    addLine("error", "replay: " + f.name + " is not valid JSON");
    return;
  }
  // Accept either a bare tape object or a wrapped {t:"tape", tape} message.
  const t = parsed && parsed.t === "tape" && parsed.tape ? parsed.tape : parsed;
  if (!t || !Array.isArray(t.masks)) {
    addLine("error", "replay: " + f.name + " is not a tape (no masks)");
    return;
  }
  send({ t: "replay", tape: t });
  setTape(t);
  addLine("info", `replay: sent ${f.name} (${t.frames ?? "?"} frames)`);
}

// ---- tape strip canvas ----

const strip = $("strip");
const stripCtx = strip.getContext("2d");
const dpr = () => window.devicePixelRatio || 1;

function sizeStrip() {
  const r = strip.getBoundingClientRect();
  const w = Math.max(1, Math.round(r.width * dpr()));
  const h = Math.max(1, Math.round(r.height * dpr()));
  if (strip.width !== w || strip.height !== h) {
    strip.width = w;
    strip.height = h;
    actCache = null;
  }
}

function activity(w) {
  if (actCache && actCache.w === w) return actCache.act;
  const act = new Uint8Array(w);
  const n = tapeMasks.length;
  for (let f = 0; f < n; f++) {
    if (tapeMasks[f]) act[Math.min(w - 1, ((f * w) / n) | 0)] = 1;
  }
  actCache = { w, act };
  return act;
}

function drawStrip() {
  const W = strip.width;
  const H = strip.height;
  if (!W || !H) return;
  stripCtx.fillStyle = "#0b0e17";
  stripCtx.fillRect(0, 0, W, H);
  if (!tapeMasks || !tapeMasks.length) {
    stripCtx.fillStyle = "#334155";
    stripCtx.font = `${12 * dpr()}px ui-monospace, SFMono-Regular, Menlo, monospace`;
    stripCtx.textBaseline = "middle";
    stripCtx.fillText("no tape — click Load tape to dump the flight recorder", 8 * dpr(), H / 2);
    return;
  }
  // idle lane + active columns
  stripCtx.fillStyle = "#1e293b";
  stripCtx.fillRect(0, (H * 0.45) | 0, W, Math.max(1, (H * 0.1) | 0));
  const act = activity(W);
  stripCtx.fillStyle = "#818cf8";
  const y = (H * 0.15) | 0;
  const h = (H * 0.7) | 0;
  for (let x = 0; x < W; x++) if (act[x]) stripCtx.fillRect(x, y, 1, h);
  // current frame marker from stats
  const cur = stats && typeof stats.frame === "number" ? stats.frame : null;
  if (cur !== null) {
    const x = Math.max(0, Math.min(W - 1, ((cur * W) / tapeMasks.length) | 0));
    stripCtx.fillStyle = "#e2e8f0";
    stripCtx.fillRect(x, 0, Math.max(1, dpr() | 0), H);
  }
}

function stripFrameAt(clientX) {
  const r = strip.getBoundingClientRect();
  const frac = (clientX - r.left) / Math.max(1, r.width);
  return Math.max(0, Math.min(tapeMasks.length - 1, (frac * tapeMasks.length) | 0));
}

function updateStripInfo(hoverFrame) {
  const info = $("stripInfo");
  if (!tapeMasks || !tapeMasks.length) {
    info.textContent = "no tape";
    return;
  }
  if (hoverFrame === undefined) {
    info.textContent = `tape: ${tape.frames ?? tapeMasks.length} frames`;
  } else {
    const mask = tapeMasks[hoverFrame] ?? 0;
    info.textContent = `f ${hoverFrame} · mask 0x${mask.toString(16).padStart(4, "0")}`;
  }
}

strip.addEventListener("click", (e) => {
  if (!tapeMasks || !tapeMasks.length) return;
  send({ t: "seek", frame: stripFrameAt(e.clientX) });
});
strip.addEventListener("mousemove", (e) => {
  if (!tapeMasks || !tapeMasks.length) return;
  updateStripInfo(stripFrameAt(e.clientX));
});
strip.addEventListener("mouseleave", () => updateStripInfo());

window.addEventListener("resize", () => {
  sizeStrip();
  drawStrip();
});

// ---------------------------------------------------------------- boot ----

sizeStrip();
drawStrip();
renderStatus();
renderDetails();
connect();
