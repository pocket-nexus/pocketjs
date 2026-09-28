// tools/render-mv.ts — render the PocketJS film to a video file.
//
//   bun tools/render-mv.ts                       # full film -> mp4 + wav
//   bun tools/render-mv.ts --stills 3,12,34,60   # just those seconds, as PNGs
//   bun tools/render-mv.ts --width 1280 --height 720   # a smaller share copy
//   bun tools/render-mv.ts --crf 16 --preset slow      # archive quality
//   bun tools/render-mv.ts --audio-only                # the song on its own
//
// The picture comes from the same site/mv/film.js the web page runs: this
// serves site/mv/, points headless Chrome at capture.html, calls __mv.render(t)
// once per frame and screenshots the canvas. film.js draws from t alone, so
// stepping time by hand produces the same film the page plays in real time.
// The audio comes from site/mv/score.js, synthesized here in Bun.
//
// Output lands in .pocket-build/validation/promo-mv/<run>/, which is ignored:
// the video is a build product of two source files, not a checked-in asset.

import { existsSync, mkdirSync } from "node:fs";
import { renderSong, DURATION as SONG_DURATION } from "../site/mv/score.js";

const ROOT = new URL("..", import.meta.url).pathname;
const CHROME = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";

// ------------------------------------------------------------------ options

const argv = process.argv.slice(2);
const flag = (name: string, fallback: string) => {
  const hit = argv.find((a) => a.startsWith(`--${name}=`));
  if (hit) return hit.slice(name.length + 3);
  const i = argv.indexOf(`--${name}`);
  return i >= 0 && argv[i + 1] && !argv[i + 1].startsWith("--") ? argv[i + 1] : fallback;
};
const has = (name: string) => argv.includes(`--${name}`);

const fps = Number(flag("fps", "30"));
const width = Number(flag("width", "1920"));
const height = Number(flag("height", "1080"));
const quality = flag("format", "png"); // png | jpeg
// The film redraws its grain eight times a second across the whole frame, which
// is the most expensive thing in it to encode. crf 20 holds the strokes and the
// type; crf 18 roughly doubles the file to preserve noise nobody sees.
const crf = flag("crf", "20");
const preset = flag("preset", "medium");
const stills = flag("stills", "").split(",").filter(Boolean).map(Number);
const run = flag("run", new Date().toISOString().replace(/[-:]/g, "").slice(0, 15));
const outDir = flag("out", `${ROOT}.pocket-build/validation/promo-mv/${run}/`);
if (!Number.isFinite(fps) || fps <= 0) throw new Error("--fps must be positive");
if (!Number.isFinite(width) || !Number.isFinite(height)) throw new Error("--width/--height must be numbers");

mkdirSync(outDir, { recursive: true });

// ------------------------------------------------------------------ audio

function writeWav(path: string, left: Float32Array, right: Float32Array, sampleRate: number) {
  const frames = left.length;
  const bytes = frames * 4; // 2 channels, 16-bit
  const buf = new ArrayBuffer(44 + bytes);
  const view = new DataView(buf);
  const ascii = (offset: number, s: string) => {
    for (let i = 0; i < s.length; i++) view.setUint8(offset + i, s.charCodeAt(i));
  };
  ascii(0, "RIFF");
  view.setUint32(4, 36 + bytes, true);
  ascii(8, "WAVEfmt ");
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true); // PCM
  view.setUint16(22, 2, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * 4, true);
  view.setUint16(32, 4, true);
  view.setUint16(34, 16, true);
  ascii(36, "data");
  view.setUint32(40, bytes, true);
  for (let i = 0; i < frames; i++) {
    const l = Math.max(-1, Math.min(1, left[i]));
    const r = Math.max(-1, Math.min(1, right[i]));
    view.setInt16(44 + i * 4, l < 0 ? l * 0x8000 : l * 0x7fff, true);
    view.setInt16(44 + i * 4 + 2, r < 0 ? r * 0x8000 : r * 0x7fff, true);
  }
  Bun.write(path, buf);
  return buf.byteLength;
}

console.log("score: synthesizing…");
const songStart = performance.now();
const song = renderSong(48000);
const wavPath = `${outDir}pocketjs-mv.wav`;
const wavBytes = writeWav(wavPath, song.left, song.right, song.sampleRate);
console.log(
  `score: ${song.duration.toFixed(2)}s, ${(wavBytes / 1e6).toFixed(1)} MB wav ` +
  `in ${((performance.now() - songStart) / 1000).toFixed(1)}s -> ${wavPath}`,
);
if (has("audio-only")) process.exit(0);

// ------------------------------------------------------------------ serving

const MIME: Record<string, string> = {
  html: "text/html; charset=utf-8",
  js: "text/javascript; charset=utf-8",
  css: "text/css; charset=utf-8",
};
const server = Bun.serve({
  hostname: "127.0.0.1",
  port: 0,
  async fetch(request) {
    const path = new URL(request.url).pathname;
    const file = Bun.file(`${ROOT}site/mv${path === "/" ? "/capture.html" : path}`);
    if (!(await file.exists())) return new Response("not found", { status: 404 });
    const ext = path.split(".").pop() ?? "";
    return new Response(file, { headers: { "Content-Type": MIME[ext] ?? "application/octet-stream" } });
  },
});
const pageUrl = `http://127.0.0.1:${server.port}/capture.html`;

// ------------------------------------------------------------------ chrome

class Chrome {
  #ws!: WebSocket;
  #proc!: Bun.Subprocess;
  #id = 0;
  #waiting = new Map<number, (v: any) => void>();

  async start(port: number) {
    if (!existsSync(CHROME)) throw new Error(`Chrome not found at ${CHROME}`);
    this.#proc = Bun.spawn(
      [
        CHROME,
        `--remote-debugging-port=${port}`,
        "--headless=new",
        "--hide-scrollbars",
        "--no-first-run",
        "--mute-audio",
        "--force-device-scale-factor=1",
        "--disable-lcd-text",
        `--user-data-dir=${process.env.TMPDIR ?? "/tmp/"}pocketjs-mv`,
        "about:blank",
      ],
      { stdout: "pipe", stderr: "pipe" },
    );
    let url = "";
    for (let i = 0; i < 120 && !url; i++) {
      try {
        const list = (await (await fetch(`http://127.0.0.1:${port}/json/list`)).json()) as any[];
        url = list.find((t) => t.type === "page")?.webSocketDebuggerUrl ?? "";
      } catch {}
      if (!url) await Bun.sleep(120);
    }
    if (!url) throw new Error("Chrome never opened a debugging target");
    this.#ws = new WebSocket(url);
    await new Promise((r) => (this.#ws.onopen = r as any));
    this.#ws.onmessage = (e) => {
      const m = JSON.parse(String(e.data));
      if (m.id && this.#waiting.has(m.id)) {
        this.#waiting.get(m.id)!(m);
        this.#waiting.delete(m.id);
      }
    };
    await this.send("Page.enable");
    await this.send("Runtime.enable");
  }

  send(method: string, params: Record<string, unknown> = {}): Promise<any> {
    return new Promise((res) => {
      const id = ++this.#id;
      this.#waiting.set(id, res);
      this.#ws.send(JSON.stringify({ id, method, params }));
    });
  }

  async evaluate(expression: string) {
    const r = await this.send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true });
    if (r.result?.exceptionDetails) {
      throw new Error(r.result.exceptionDetails.exception?.description ?? "page threw");
    }
    return r.result?.result?.value;
  }

  async shot(): Promise<Uint8Array> {
    const r = await this.send("Page.captureScreenshot", {
      format: quality,
      ...(quality === "jpeg" ? { quality: 96 } : {}),
      captureBeyondViewport: false,
      fromSurface: true,
    });
    return new Uint8Array(Buffer.from(r.result.data, "base64"));
  }

  stop() {
    this.#ws.close();
    this.#proc.kill();
  }
}

const chrome = new Chrome();
await chrome.start(9412);
await chrome.send("Emulation.setDeviceMetricsOverride", { width, height, deviceScaleFactor: 1, mobile: false });
await chrome.send("Page.navigate", { url: pageUrl });

// capture.html sets __mvReady after every font the film uses has loaded, so
// polling that one flag covers navigation, module evaluation and fonts.
let ready = false;
for (let i = 0; i < 260 && !ready; i++) {
  ready = Boolean(await chrome.evaluate("!!window.__mvReady"));
  if (!ready) await Bun.sleep(150);
}
if (!ready) throw new Error("capture.html never became ready (fonts or modules failed to load)");

const duration = Number(await chrome.evaluate("window.__mv.duration"));
console.log(`film: ready, song ${SONG_DURATION.toFixed(2)}s, film ${duration.toFixed(2)}s at ${width}x${height}`);

// ------------------------------------------------------------------ stills

if (stills.length) {
  for (const second of stills) {
    await chrome.evaluate(`window.__mv.render(${second})`);
    const png = await chrome.shot();
    const path = `${outDir}still-${String(second).padStart(5, "0")}s.${quality}`;
    await Bun.write(path, png);
    console.log(`still ${second}s -> ${path} (${(png.length / 1024).toFixed(0)} KB)`);
  }
  chrome.stop();
  server.stop(true);
  process.exit(0);
}

// ------------------------------------------------------------------ frames

const total = Math.ceil(song.duration * fps);
const mp4Path = `${outDir}pocketjs-mv.mp4`;
const ffmpeg = Bun.spawn(
  [
    "ffmpeg", "-y", "-loglevel", "error",
    "-f", "image2pipe", "-framerate", String(fps), "-i", "-",
    "-i", wavPath,
    "-map", "0:v:0", "-map", "1:a:0",
    "-c:v", "libx264", "-preset", preset, "-crf", crf, "-pix_fmt", "yuv420p",
    "-movflags", "+faststart",
    "-c:a", "aac", "-b:a", "192k",
    "-shortest",
    mp4Path,
  ],
  { stdin: "pipe", stdout: "inherit", stderr: "inherit" },
);
const sink = ffmpeg.stdin as import("bun").FileSink;

const started = performance.now();
for (let frame = 0; frame < total; frame++) {
  await chrome.evaluate(`window.__mv.render(${(frame / fps).toFixed(6)})`);
  sink.write(await chrome.shot());
  await sink.flush();
  if (frame % Math.round(fps * 5) === 0 || frame === total - 1) {
    const done = frame + 1;
    const rate = done / ((performance.now() - started) / 1000);
    const left = (total - done) / rate;
    process.stdout.write(
      `\rframes ${done}/${total}  ${(done / total * 100).toFixed(1)}%  ` +
      `${rate.toFixed(1)} fps  eta ${Math.round(left)}s   `,
    );
  }
}
process.stdout.write("\n");
await sink.end();
const code = await ffmpeg.exited;
chrome.stop();
server.stop(true);
if (code !== 0) throw new Error(`ffmpeg exited ${code}`);

const size = (await Bun.file(mp4Path).arrayBuffer()).byteLength;
console.log(`video: ${total} frames at ${fps} fps, crf ${crf}, ${(size / 1e6).toFixed(1)} MB -> ${mp4Path}`);
