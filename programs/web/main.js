// Static web program; the build recipe stages one admitted package beside it.
import { create } from "./app-instance.js";
import { createBrowserInput } from "../../platforms/web/browser-input.js";
const canvas = document.getElementById("screen");
const metadata = await (await fetch("./program.json")).json();
document.title = metadata.title;
const instance = await create({ ...metadata, bundleUrl: `./dist/${metadata.output}.js`, pakUrl: `./dist/${metadata.output}.pak`, wasmUrl: "./platforms/web/pocketjs.wasm" });
let width = metadata.viewport[0], height = metadata.viewport[1];
canvas.width = width; canvas.height = height;
const context = canvas.getContext("2d");
const keys = { ArrowUp: 16, ArrowRight: 32, ArrowDown: 64, ArrowLeft: 128, Enter: 8192, KeyZ: 8192, KeyX: 16384, KeyA: 32768, KeyS: 4096, ShiftLeft: 1, Space: 8, KeyL: 256, KeyR: 512 };
// The plan's input features choose the facts: a real pointer and its wheel
// (input.pointer, input.scroll) or touch contacts, and keyboard text
// (input.text) beside the button bits.
const features = new Set(metadata.features ?? []);
const input = createBrowserInput(canvas, {
  pointer: features.has("input.pointer"), contacts: !features.has("input.pointer"),
  scroll: features.has("input.scroll"), text: features.has("input.text"),
  buttons: keys, viewport: () => [width, height],
});
let frame, stopped = false;
const duration = 1000 / metadata.simHz;
function tick() {
  if (stopped) return;
  try {
    const facts = input.sample();
    if (facts.contacts?.some(contact => !contact.cancelled)) facts.buttons |= 8192;
    instance.stepInput(facts, 60 / metadata.simHz);
    context.putImageData(new ImageData(new Uint8ClampedArray(instance.render()), width, height), 0, 0);
    if (features.has("input.pointer")) canvas.style.cursor = instance.cursor();
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
window.addEventListener("pagehide", () => { stopped = true; clearTimeout(frame); input.dispose(); instance.dispose(); });
tick();
