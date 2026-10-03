import { createSignal } from "solid-js";
import { View } from "@pocketjs/framework/components";
import { onFrame } from "@pocketjs/framework/lifecycle";
import { mount } from "@pocketjs/framework/solid";

type SpriteInfo = { handle: number; frames: number; cols: number; step: number };
type ProbeUi = Record<string, unknown> & {
  __host?: string;
  __hostAbi?: number;
  __viewport?: { w: number; h: number };
  __textures?: Record<string, number>;
  __sprites?: Record<string, SpriteInfo>;
};

const ui = (globalThis as unknown as { ui: ProbeUi }).ui;
if (ui.__host !== "wii-dev" || ui.__hostAbi !== 7 || ui.__viewport?.w !== 480 || ui.__viewport?.h !== 272) {
  throw new Error("W14 host identity/viewport mismatch");
}
if (ui.__textures?.probe === undefined || ui.__textures.probe < 0) {
  throw new Error("W14 image name table missing probe");
}
const sprite = ui.__sprites?.pulse;
if (!sprite || sprite.frames !== 2 || sprite.cols !== 2 || sprite.step !== 3) {
  throw new Error("W14 sprite name table missing pulse metadata");
}
for (const name of [
  "createNode", "destroyNode", "insertBefore", "removeChild", "setStyle", "setProp",
  "setText", "replaceText", "uploadTexture", "setImage", "setSprite", "animate",
  "cancelAnim", "setFocus", "setActive", "loadStyles", "loadFontAtlas", "measureText",
  "loadTileTexture", "freeTexture", "uploadImgEntry",
]) {
  if (typeof ui[name] !== "function") throw new Error(`W14 HostOps missing ${name}`);
}
for (const name of [
  "setPropBatch", "setCompositorSurface", "hitTest", "hitTestBounds", "hitTestAuxiliary",
  "hitTestBoundsAuxiliary", "setCursor", "setCursorPos", "wrapText", "svcOpen",
  "debugStats", "appTable", "appLaunch", "appShot",
]) {
  if (ui[name] !== undefined) throw new Error(`W14 HostOps unexpectedly exposes ${name}`);
}
if (ui.__auxiliarySurface !== undefined || (globalThis as { audio?: unknown }).audio !== undefined ||
    (globalThis as { net?: unknown }).net !== undefined) {
  throw new Error("W14 exposed an unimplemented optional namespace");
}

let updated = false;
function ProbeBox() {
  const [width, setWidth] = createSignal(24);
  onFrame(() => {
    if (!updated) {
      updated = true;
      setWidth(40);
    }
  });
  return <View style={{ width: width(), height: 32, bgColor: "#123456" }} />;
}

mount(() => <ProbeBox />);
