// Static web program; the build recipe stages one admitted package beside it.
import { create } from "./app-instance.js";
const canvas = document.getElementById("screen");
const metadata = await (await fetch("./program.json")).json();
document.title = metadata.title;
const instance = await create({ ...metadata, bundleUrl: `./dist/${metadata.output}.js`, pakUrl: `./dist/${metadata.output}.pak`, wasmUrl: "./platforms/web/pocketjs.wasm" });
let width = metadata.viewport[0], height = metadata.viewport[1];
canvas.width = width; canvas.height = height;
const context = canvas.getContext("2d");
const keys = { ArrowUp: 16, ArrowRight: 32, ArrowDown: 64, ArrowLeft: 128, Enter: 8192, KeyZ: 8192, KeyX: 16384, KeyA: 32768, KeyS: 4096, ShiftLeft: 1, Space: 8, KeyL: 256, KeyR: 512 };
const held = new Set(), contacts = new Map(), cancellations = [], retired = new Set();
let frame, stopped = false;
const key = down => event => {
  if (!keys[event.code]) return;
  event.preventDefault(); if (down) held.add(event.code); else held.delete(event.code);
};
window.addEventListener("keydown", key(true)); window.addEventListener("keyup", key(false));
const point = event => {
  const rect = canvas.getBoundingClientRect();
  return { x: Math.max(0, Math.min(width - 1, (event.clientX - rect.left) * width / rect.width)),
    y: Math.max(0, Math.min(height - 1, (event.clientY - rect.top) * height / rect.height)) };
};
canvas.addEventListener("pointerdown", event => {
  if (event.button !== 0 || contacts.size >= 256) return;
  const used = new Set([...contacts.values()].map(contact => contact.id).concat([...retired])); let id = 0;
  while (used.has(id)) id++; if (id >= 256) return;
  contacts.set(event.pointerId, { surface: 0, id, ...point(event), cancelled: false });
  canvas.setPointerCapture(event.pointerId); canvas.focus(); event.preventDefault();
});
canvas.addEventListener("pointermove", event => {
  const contact = contacts.get(event.pointerId); if (contact) Object.assign(contact, point(event));
});
canvas.addEventListener("pointerup", event => { const contact = contacts.get(event.pointerId); if (contact) retired.add(contact.id); contacts.delete(event.pointerId); });
canvas.addEventListener("pointercancel", event => {
  const contact = contacts.get(event.pointerId); if (contact) { retired.add(contact.id); cancellations.push({ ...contact, cancelled: true }); }
  contacts.delete(event.pointerId);
});
window.addEventListener("blur", () => {
  held.clear(); for (const contact of contacts.values()) { retired.add(contact.id); cancellations.push({ ...contact, cancelled: true }); } contacts.clear();
});
const duration = 1000 / metadata.simHz;
function tick() {
  if (stopped) return;
  try {
    let buttons = contacts.size ? 8192 : 0; for (const code of held) buttons |= keys[code];
    instance.stepInput({ buttons, contacts: [...contacts.values(), ...cancellations.splice(0)] }, 60 / metadata.simHz);
    retired.clear();
    context.putImageData(new ImageData(new Uint8ClampedArray(instance.render()), width, height), 0, 0);
    // One logical turn per wake. Rendering or a suspended tab does not add turns.
    frame = setTimeout(tick, duration);
  } catch (error) {
    stopped = true; instance.dispose(); const message = document.createElement("pre"); message.textContent = String(error?.stack ?? error); canvas.replaceWith(message);
  }
}
if (metadata.dynamic) {
  const resize = () => {
    width = Math.max(metadata.dynamic.min[0], Math.min(metadata.dynamic.max[0], window.innerWidth));
    height = Math.max(metadata.dynamic.min[1], Math.min(metadata.dynamic.max[1], window.innerHeight));
    instance.resize(width, height); canvas.width = width; canvas.height = height;
  };
  window.addEventListener("resize", resize); resize();
}
window.addEventListener("pagehide", () => { stopped = true; clearTimeout(frame); instance.dispose(); });
tick();
