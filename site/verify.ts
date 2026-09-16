// site/verify.ts — headless-Chrome verifier over the DevTools Protocol.
//   bun site/verify.ts <url> [waitMs] [probeExpr]
// Loads <url> in headless Chrome, hooks page errors, waits, evaluates a probe
// expression (default: canvas non-black pixel ratio + status/error text), saves
// a screenshot, and prints a JSON report. Local verification only.

import { mkdtempSync, rmSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";

const CHROME = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const url = process.argv[2] ?? "http://127.0.0.1:8140/";
const waitMs = Number(process.argv[3] ?? 4000);
const probe =
  process.argv[4] ??
  `(() => {
     // FPS + memory are drawn IN the canvas now (hosts/web/hud.js), not in the
     // DOM — so they show up in the canvas pixel stats below, not a text probe.
     const out = { status: null, error: null, canvases: [] };
     const s = document.querySelector('#pg-status'); if (s) out.status = s.textContent;
     const e = document.querySelector('#pg-error'); if (e && !e.hidden) out.error = e.textContent;
     for (const c of document.querySelectorAll('canvas')) {
       try {
         const ctx = c.getContext('2d');
         const d = ctx.getImageData(0,0,c.width,c.height).data;
         let nonblack = 0, colored = 0;
         for (let i=0;i<d.length;i+=4){ const r=d[i],g=d[i+1],b=d[i+2];
           if (r+g+b>24) nonblack++; if (Math.abs(r-g)+Math.abs(g-b)>40) colored++; }
         const px = d.length/4;
         out.canvases.push({ id:c.id, w:c.width, h:c.height,
           nonblackPct:+(100*nonblack/px).toFixed(1), coloredPct:+(100*colored/px).toFixed(1) });
       } catch(err){ out.canvases.push({ id:c.id, err:String(err) }); }
     }
     return out;
   })()`;

const SHOT = process.env.SHOT ?? join(tmpdir(), `pocketjs-site-verify-${process.pid}.png`);

// --- launch chrome with a debugging port -----------------------------------
async function unusedPort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("could not allocate a Chrome debug port");
  await new Promise<void>((resolve, reject) =>
    server.close((error) => error ? reject(error) : resolve()),
  );
  return address.port;
}

const port = await unusedPort();
const profile = mkdtempSync(join(tmpdir(), "pocketjs-site-verify-"));
const proc = (() => {
  try {
    return Bun.spawn(
      // Recent Chrome only opens the debugging port with a dedicated profile
      // dir, and the Pocket Stage needs SwiftShader-backed WebGL.
      [CHROME, "--headless=old", `--remote-debugging-port=${port}`, `--user-data-dir=${profile}`, "--no-first-run", "--no-default-browser-check",
        "--no-sandbox", "--use-angle=swiftshader", "--enable-unsafe-swiftshader",
        "--hide-scrollbars", "--window-size=1400,1600", "--force-device-scale-factor=1", "about:blank"],
      { stdout: "ignore", stderr: "ignore" },
    );
  } catch (error) {
    rmSync(profile, { recursive: true, force: true });
    throw error;
  }
})();

let ws: WebSocket | null = null;
let cleanupPromise: Promise<void> | null = null;
function cleanup(): Promise<void> {
  cleanupPromise ??= (async () => {
    ws?.close();
    if (proc.exitCode === null) {
      proc.kill();
      await Promise.race([proc.exited, Bun.sleep(3_000)]);
      if (proc.exitCode === null) proc.kill(9);
    }
    await proc.exited;
    rmSync(profile, { recursive: true, force: true });
  })();
  return cleanupPromise;
}
const onSigterm = () => void cleanup().finally(() => process.exit(143));
const onSigint = () => void cleanup().finally(() => process.exit(130));
process.once("SIGTERM", onSigterm);
process.once("SIGINT", onSigint);

async function waitFor(fn: () => Promise<any>, tries = 40, gap = 100) {
  for (let i = 0; i < tries; i++) {
    try {
      return await fn();
    } catch {
      await Bun.sleep(gap);
    }
  }
  throw new Error("timed out waiting for chrome");
}

try {
  const version = await waitFor(async () => {
    const response = await fetch(`http://127.0.0.1:${port}/json/version`);
    if (!response.ok) throw new Error(`Chrome returned ${response.status}`);
    return response.json();
  });
  const wsUrl = version.webSocketDebuggerUrl as string;
  ws = new WebSocket(wsUrl);
  await new Promise<void>((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error("timed out opening Chrome debugger")), 10_000);
    ws!.onopen = () => {
      clearTimeout(timeout);
      resolve();
    };
    ws!.onerror = (error) => {
      clearTimeout(timeout);
      reject(error);
    };
  });

  let msgId = 0;
  const pending = new Map<number, {
    resolve: (value: any) => void;
    reject: (error: Error) => void;
    timeout: ReturnType<typeof setTimeout>;
  }>();
  const rejectPending = (reason: string) => {
    for (const [id, item] of pending) {
      clearTimeout(item.timeout);
      item.reject(new Error(`${reason} (CDP request ${id})`));
    }
    pending.clear();
  };
  ws.onclose = () => rejectPending("Chrome debugger closed");
  ws.onmessage = (event) => {
    const message = JSON.parse(event.data as string);
    if (!message.id) return;
    const item = pending.get(message.id);
    if (!item) return;
    pending.delete(message.id);
    clearTimeout(item.timeout);
    if (message.error) item.reject(new Error(`CDP error: ${JSON.stringify(message.error)}`));
    else item.resolve(message.result ?? {});
  };
  function send(method: string, params: any = {}, sessionId?: string): Promise<any> {
    const id = ++msgId;
    const payload: any = { id, method, params };
    if (sessionId) payload.sessionId = sessionId;
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        pending.delete(id);
        reject(new Error(`CDP ${method} timed out`));
      }, Number(process.env.POCKETJS_VERIFY_CDP_TIMEOUT ?? 30_000));
      pending.set(id, { resolve, reject, timeout });
      ws!.send(JSON.stringify(payload));
    });
  }

  // Attach to the blank page target created on the Chrome command line.
  const { targetInfos } = await send("Target.getTargets");
  const pageTarget = targetInfos.find((target: any) => target.type === "page");
  if (!pageTarget) throw new Error("Chrome has no page target");
  const { sessionId } = await send("Target.attachToTarget", {
    targetId: pageTarget.targetId,
    flatten: true,
  });
  const S = (method: string, params?: any) => send(method, params, sessionId);

  const pageErrors: string[] = [];
  const consoleErrors: string[] = [];
  const networkErrors: string[] = [];
  const networkRequestUrls = new Map<string, string>();
  ws.addEventListener("message", (event: any) => {
    const message = JSON.parse(event.data);
    if (message.sessionId !== sessionId) return;
    if (message.method === "Runtime.exceptionThrown") {
      const detail = message.params.exceptionDetails;
      pageErrors.push(detail.exception?.description || detail.text || JSON.stringify(detail));
    }
    if (message.method === "Runtime.consoleAPICalled" && message.params.type === "error") {
      consoleErrors.push(
        message.params.args.map((arg: any) => arg.value ?? arg.description ?? "").join(" "),
      );
    }
    if (message.method === "Network.requestWillBeSent") {
      networkRequestUrls.set(message.params.requestId, message.params.request.url);
    }
    if (message.method === "Network.loadingFailed") {
      const request = networkRequestUrls.get(message.params.requestId) ?? message.params.requestId;
      networkErrors.push(
        `${message.params.errorText}: ${request}`
        + ` (type=${message.params.type ?? "unknown"}, canceled=${message.params.canceled === true})`,
      );
    }
    if (message.method === "Network.responseReceived" && message.params.response.status >= 400) {
      networkErrors.push(`${message.params.response.status}: ${message.params.response.url}`);
    }
  });

  await S("Page.enable");
  await S("Runtime.enable");
  await S("Log.enable");
  await S("Network.enable");
  if (process.env.WIDTH) {
    await S("Emulation.setDeviceMetricsOverride", {
      width: Number(process.env.WIDTH),
      height: Number(process.env.HEIGHT ?? 800),
      deviceScaleFactor: 2,
      mobile: !!process.env.MOBILE,
    });
  }
  await S("Page.navigate", { url });
  await Bun.sleep(waitMs);

  const evalRes = await S("Runtime.evaluate", {
    expression: probe,
    returnByValue: true,
    awaitPromise: true,
  });
  if (evalRes.exceptionDetails) {
    const detail = evalRes.exceptionDetails;
    throw new Error(detail.exception?.description || detail.text || "probe evaluation failed");
  }
  let screenshot: string | null = null;
  if (process.env.POCKETJS_VERIFY_NO_SHOT !== "1") {
    const shotOpts: any = { format: "png", captureBeyondViewport: true };
    if (process.env.CLIP) {
      const [x, y, w, h] = process.env.CLIP.split(",").map(Number);
      shotOpts.clip = { x, y, width: w, height: h, scale: 1 };
    } else if (process.env.POCKETJS_VERIFY_SELECTOR) {
      const bounds = await S("Runtime.evaluate", {
        expression: `(() => { const r = document.querySelector(${JSON.stringify(process.env.POCKETJS_VERIFY_SELECTOR)}).getBoundingClientRect(); return { x: r.left + scrollX, y: r.top + scrollY, width: r.width, height: r.height, scale: 1 }; })()`,
        returnByValue: true,
      });
      shotOpts.clip = bounds.result.value;
    }
    const shot = await S("Page.captureScreenshot", shotOpts);
    if (shot.data) {
      await Bun.write(SHOT, Buffer.from(shot.data, "base64"));
      screenshot = SHOT;
    }
  }

  console.log(
    JSON.stringify(
      {
        url,
        probe: evalRes.result?.value ?? evalRes.result ?? evalRes,
        pageErrors: pageErrors.slice(0, 8),
        consoleErrors: consoleErrors.slice(0, 8),
        networkErrors: networkErrors.slice(0, 8),
        screenshot,
      },
      null,
      2,
    ),
  );
} finally {
  await cleanup();
  process.off("SIGTERM", onSigterm);
  process.off("SIGINT", onSigint);
}
