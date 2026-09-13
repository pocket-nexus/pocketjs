import { dispatchOffload } from "../offload-provider.ts";
import { validImeKeys, validImeBrowse } from "../../contracts/spec/ime.ts";
import { GlobalFonts } from "@napi-rs/canvas";
import { createTextTileRenderer } from "./text-tile.ts";
import { createTextProvider } from "../text-glyph-provider.ts";
declare const self: Worker;
let enginePort = 0, engineToken = "";
async function compose(payload: string, browse = false) {
  if (!(browse ? validImeBrowse : validImeKeys)(JSON.parse(payload))) throw new Error("Invalid IME transcript");
  const response = await fetch(`http://127.0.0.1:${enginePort}/${browse ? "candidates" : "compose"}`, {
    method: "POST", headers: { authorization: engineToken }, body: payload, signal: AbortSignal.timeout(6000),
  });
  if (!response.ok) throw new Error("IME engine unavailable");
  return response.text();
}
const textTile = createTextTileRenderer();
let textProvider: ReturnType<typeof createTextProvider>;
// One serial capability queue owns this worker's canvas. The supervisor owns
// Rime; per-connection workers hold its authenticated loopback address.
let pending = Promise.resolve();
self.onmessage = event => {
  if (event.data.init) { if (!GlobalFonts.registerFromPath(event.data.init.font, "Pocket CJK")) throw new Error("CJK font unavailable"); textProvider = createTextProvider(event.data.init.font); enginePort = event.data.init.enginePort; engineToken = event.data.init.engineToken; return; }
  pending = pending.then(async () => self.postMessage(await dispatchOffload({ "ime.compose": compose, "ime.candidates": p => compose(p, true), "text.tile": textTile, ...textProvider }, event.data)));
};
