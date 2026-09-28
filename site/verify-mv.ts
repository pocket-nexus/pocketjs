// site/verify-mv.ts — drive the real /mv/ page in a browser and check it plays.
//
//   bun site/verify-mv.ts
//
// Serves the page site/film.ts renders plus site/mv/'s modules, opens it in
// isolated Chrome and checks the four things that can break without anyone
// noticing: the poster paints, the song synthesizes, the clock advances while
// it plays, and the page logs nothing. Screenshots land in ignored dist/.

import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { FILM_MODULES, renderFilmPage } from "./film.ts";

const ROOT = new URL("..", import.meta.url).pathname;
const MV = `${ROOT}site/mv/`;
const OUT = `${ROOT}site/dist/mv-verify/`;
const CHROME = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
mkdirSync(OUT, { recursive: true });

const page = renderFilmPage(readFileSync(`${MV}page.html`, "utf8"));
const server = Bun.serve({
  hostname: "127.0.0.1",
  port: 0,
  fetch(request) {
    const path = new URL(request.url).pathname;
    if (path === "/mv/" || path === "/mv/index.html") {
      return new Response(page, { headers: { "Content-Type": "text/html; charset=utf-8" } });
    }
    const name = path.replace(/^\/mv\//, "");
    if (name === "mv.css") {
      return new Response(Bun.file(MV + name), { headers: { "Content-Type": "text/css; charset=utf-8" } });
    }
    if (FILM_MODULES.includes(name)) {
      return new Response(Bun.file(MV + name), { headers: { "Content-Type": "text/javascript; charset=utf-8" } });
    }
    return new Response("not found", { status: 404 });
  },
});

const logs: string[] = [];

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
        "--autoplay-policy=no-user-gesture-required",
        "--force-device-scale-factor=1",
        `--user-data-dir=${process.env.TMPDIR ?? "/tmp/"}pocketjs-mv-verify`,
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
        return;
      }
      if (m.method === "Runtime.consoleAPICalled" && m.params.type !== "debug") {
        logs.push(`console.${m.params.type}: ${m.params.args.map((a: any) => a.description ?? a.value).join(" ")}`);
      }
      if (m.method === "Runtime.exceptionThrown") {
        logs.push(`uncaught: ${m.params.exceptionDetails.exception?.description ?? "error"}`);
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

  async evaluate(expression: string, userGesture = false) {
    const r = await this.send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true, userGesture });
    const thrown = r.result?.exceptionDetails;
    if (thrown) throw new Error(thrown.exception?.description ?? thrown.text);
    return r.result?.result?.value;
  }

  async shot(file: string) {
    const r = await this.send("Page.captureScreenshot", { format: "png", captureBeyondViewport: true });
    await Bun.write(OUT + file, new Uint8Array(Buffer.from(r.result.data, "base64")));
  }

  stop() {
    this.#ws.close();
    this.#proc.kill();
  }
}

const fail = (message: string) => {
  throw new Error(message);
};

const chrome = new Chrome();
await chrome.start(9413);
await chrome.send("Emulation.setDeviceMetricsOverride", { width: 1440, height: 1100, deviceScaleFactor: 1, mobile: false });
await chrome.send("Page.navigate", { url: `http://127.0.0.1:${server.port}/mv/` });

// The poster is painted as player.js evaluates, so waiting for the canvas to
// carry more than one colour waits for the module graph and the film together.
let colours = 0;
for (let i = 0; i < 120 && colours < 40; i++) {
  await Bun.sleep(150);
  colours = Number(
    await chrome.evaluate(`(() => {
      const c = document.getElementById("film");
      if (!c) return 0;
      const g = c.getContext("2d");
      const d = g.getImageData(0, 0, c.width, c.height).data;
      const seen = new Set();
      for (let i = 0; i < d.length; i += 4 * 977) seen.add((d[i] << 16) | (d[i + 1] << 8) | d[i + 2]);
      return seen.size;
    })()`),
  ) || 0;
}
if (colours < 40) fail(`The poster frame never painted (${colours} distinct colours)`);

// The poster is a chorus frame, which is mostly lit sky. A dark result means
// the page fell back to t=0 — which is what happened when the font-ready
// repaint reset the clock instead of holding the poster.
const litShare = Number(
  await chrome.evaluate(`(() => {
    const c = document.getElementById("film");
    const d = c.getContext("2d").getImageData(0, 0, c.width, c.height).data;
    let lit = 0, n = 0;
    for (let i = 0; i < d.length; i += 4 * 331) {
      if (0.299 * d[i] + 0.587 * d[i + 1] + 0.114 * d[i + 2] > 110) lit++;
      n++;
    }
    return lit / n;
  })()`),
);
if (litShare < 0.08) fail(`The poster is not the chorus frame (${(litShare * 100).toFixed(1)}% lit)`);
console.log(`poster: chorus frame, ${colours} colours sampled, ${(litShare * 100).toFixed(1)}% lit`);
await chrome.shot("poster.png");

const title = await chrome.evaluate(`document.querySelector(".film-start-text b").textContent`);
if (title !== "ポケットに空を") fail(`Unexpected title on the start button: ${title}`);

await chrome.evaluate(`document.querySelector("[data-start]").click()`, true);
let ready = false;
for (let i = 0; i < 200 && !ready; i++) {
  await Bun.sleep(150);
  ready = Boolean(await chrome.evaluate(`!document.querySelector("[data-controls]").hidden`));
}
if (!ready) fail("The song never finished synthesizing (controls stayed hidden)");
console.log("song: synthesized in the worker, controls shown");

const first = Number(await chrome.evaluate(`Number(document.querySelector("[data-seek]").value)`));
await Bun.sleep(2500);
const second = Number(await chrome.evaluate(`Number(document.querySelector("[data-seek]").value)`));
if (!(second > first)) fail(`Playback did not advance (${first} -> ${second} of 1000)`);
const elapsed = await chrome.evaluate(`document.querySelector("[data-time]").textContent`);
console.log(`playback: advanced ${first} -> ${second} of 1000 (${elapsed})`);
await chrome.shot("playing.png");

await chrome.evaluate(`document.querySelector("[data-toggle]").click()`, true);
await Bun.sleep(400);
const held = Number(await chrome.evaluate(`Number(document.querySelector("[data-seek]").value)`));
await Bun.sleep(900);
const stillHeld = Number(await chrome.evaluate(`Number(document.querySelector("[data-seek]").value)`));
if (held !== stillHeld) fail(`Pause did not hold the clock (${held} -> ${stillHeld})`);
console.log(`pause: held at ${held} of 1000`);

chrome.stop();
server.stop(true);
if (logs.length) fail(`The page logged:\n  ${logs.join("\n  ")}`);
console.log(`clean: no console output\nscreenshots -> ${OUT}`);
