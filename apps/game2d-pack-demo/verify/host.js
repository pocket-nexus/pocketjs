// Minimal wasm host for the demo: the same bundle and pak the PSP EBOOT embeds, with
// globalThis.audio and globalThis.pack mounted before it evaluates. Pack files come from /data/.
// window.__demo carries the frame count, errors and the analyser's RMS for verify/web-check.mjs.
import { createWasmUi } from "/pocketjs/platforms/web/wasm-ops.js";
import { createAudioHost } from "/pocketjs/platforms/web/audio.js";
import { createPackHost } from "/pocketjs/platforms/web/pack.js";

const W = 480, H = 272, NAME = "game2d-pack-demo";
const demo = (window.__demo = { frame: 0, errors: [], rmsPeak: 0, rmsBySecond: [], speed: Number(new URLSearchParams(location.search).get("speed") ?? 1) });

// Every node connected to the destination also feeds an analyser.
let analyser = null;
const connect = AudioNode.prototype.connect;
AudioNode.prototype.connect = function (dest, ...rest) {
  if (dest instanceof AudioDestinationNode) {
    if (!analyser) { analyser = dest.context.createAnalyser(); analyser.fftSize = 2048; }
    connect.call(this, analyser);
  }
  return connect.call(this, dest, ...rest);
};
const measure = () => {
  if (!analyser) return 0;
  const buffer = new Float32Array(analyser.fftSize);
  analyser.getFloatTimeDomainData(buffer);
  let sum = 0;
  for (const v of buffer) sum += v * v;
  return Math.sqrt(sum / buffer.length);
};
setInterval(() => { demo.rmsPeak = Math.max(demo.rmsPeak, measure()); demo.rms = measure(); }, 50);

const canvas = document.getElementById("screen");
const context = canvas.getContext("2d");
const image = context.createImageData(W, H);
const wasm = await createWasmUi(await (await fetch("/pocketjs/platforms/web/pocketjs.wasm")).arrayBuffer(), { width: W, height: H, rasterDensity: 1 });
wasm.init(1);
const audio = createAudioHost();
audio.reset();
const pack = createPackHost({ baseUrl: "/data/", ops: wasm });
demo.packHost = pack;
Object.assign(globalThis, { frame: undefined, audio: audio.ns, pack: pack.ns, __simHz: 60, __pocketApp: NAME });
const [pak, source] = await Promise.all([
  fetch(`/dist/${NAME}.pak`).then((r) => r.arrayBuffer()),
  fetch(`/dist/${NAME}.js`).then((r) => r.text()),
]);
try {
  wasm.boot(source, { pak, renderScale: 1, sourceName: `${NAME}.js` });
} catch (error) {
  demo.errors.push(String(error?.stack ?? error));
}

let budget = 0;
let last = performance.now();
function loop(now) {
  requestAnimationFrame(loop);
  budget += Math.min(250, now - last) * demo.speed;
  last = now;
  let stepped = 0;
  while (budget >= 1000 / 60 && stepped < 4) {
    try {
      audio.beginFrame();
      wasm.advance({ buttons: 0, analog: 0x8080 }, 1);
    } catch (error) {
      demo.errors.push(String(error?.stack ?? error));
    }
    demo.frame++;
    budget -= 1000 / 60;
    stepped++;
  }
  if (stepped) {
    image.data.set(wasm.renderScaledIncremental(1));
    context.putImageData(image, 0, 0);
  }
}
requestAnimationFrame(loop);
