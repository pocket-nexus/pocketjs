// One headless Chrome page over the DevTools protocol, for the bake tools
// that rasterize with a browser (tools/icons.ts, apps/nexus/gen-art.ts).
//
// The page renders with a transparent default background at device scale 1;
// callers size the viewport per capture.

import { existsSync } from "node:fs";

export const CHROME = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";

export interface HeadlessChromeOptions {
  /** Remote debugging port; tools running side by side pick different ones. */
  port: number;
  /** Profile directory, so a run never touches the user's Chrome profile. */
  profile: string;
}

export class HeadlessChrome {
  #ws!: WebSocket;
  #proc!: Bun.Subprocess;
  #id = 0;
  #waiting = new Map<number, (message: any) => void>();

  static async start(options: HeadlessChromeOptions): Promise<HeadlessChrome> {
    const chrome = new HeadlessChrome();
    await chrome.#start(options);
    return chrome;
  }

  async #start({ port, profile }: HeadlessChromeOptions): Promise<void> {
    if (!existsSync(CHROME)) throw new Error(`Chrome not found at ${CHROME}`);
    this.#proc = Bun.spawn(
      [
        CHROME,
        `--remote-debugging-port=${port}`,
        "--headless=new",
        "--hide-scrollbars",
        "--no-first-run",
        "--no-default-browser-check",
        "--force-device-scale-factor=1",
        `--user-data-dir=${profile}`,
        "about:blank",
      ],
      { stdout: "pipe", stderr: "pipe" },
    );
    let url = "";
    for (let i = 0; i < 100 && !url; i++) {
      try {
        const list = (await (await fetch(`http://127.0.0.1:${port}/json/list`)).json()) as any[];
        url = list.find((target) => target.type === "page")?.webSocketDebuggerUrl ?? "";
      } catch {}
      if (!url) await Bun.sleep(120);
    }
    if (!url) throw new Error("Chrome never opened a debugging target");
    this.#ws = new WebSocket(url);
    await new Promise((resolve) => (this.#ws.onopen = resolve as any));
    this.#ws.onmessage = (event) => {
      const message = JSON.parse(String(event.data));
      if (message.id && this.#waiting.has(message.id)) {
        this.#waiting.get(message.id)!(message);
        this.#waiting.delete(message.id);
      }
    };
    await this.send("Page.enable");
    await this.send("Emulation.setDefaultBackgroundColorOverride", { color: { r: 0, g: 0, b: 0, a: 0 } });
  }

  /** One protocol call; resolves with the whole reply (`result` or `error`). */
  send(method: string, params: Record<string, unknown> = {}): Promise<any> {
    return new Promise((resolve) => {
      const id = ++this.#id;
      this.#waiting.set(id, resolve);
      this.#ws.send(JSON.stringify({ id, method, params }));
    });
  }

  async viewport(width: number, height: number): Promise<void> {
    await this.send("Emulation.setDeviceMetricsOverride", { width, height, deviceScaleFactor: 1, mobile: false });
  }

  /** Navigate and wait for the load event. */
  async navigate(url: string): Promise<void> {
    const loaded = new Promise<void>((resolve) => {
      const on = (event: MessageEvent) => {
        if (JSON.parse(String(event.data)).method === "Page.loadEventFired") {
          this.#ws.removeEventListener("message", on);
          resolve();
        }
      };
      this.#ws.addEventListener("message", on);
    });
    await this.send("Page.navigate", { url });
    await loaded;
  }

  /** Load an HTML document from memory. */
  html(document: string): Promise<void> {
    return this.navigate(`data:text/html;base64,${Buffer.from(document).toString("base64")}`);
  }

  /** Evaluate an expression in the page, awaiting a promise; throws on exceptions. */
  async evaluate(expression: string): Promise<any> {
    const reply = await this.send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true });
    if (reply.error || reply.result?.exceptionDetails) {
      throw new Error(JSON.stringify(reply.error ?? reply.result.exceptionDetails).slice(0, 400));
    }
    return reply.result?.result?.value;
  }

  /** PNG of the viewport, or of `clip` in CSS pixels. */
  async screenshot(clip?: { x: number; y: number; width: number; height: number }): Promise<Uint8Array> {
    const reply = await this.send("Page.captureScreenshot", {
      format: "png",
      captureBeyondViewport: false,
      ...(clip ? { clip: { ...clip, scale: 1 } } : {}),
    });
    return new Uint8Array(Buffer.from(reply.result.data, "base64"));
  }

  stop(): void {
    this.#ws.close();
    this.#proc.kill();
  }
}
