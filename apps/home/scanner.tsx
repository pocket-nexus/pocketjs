// apps/home/scanner.tsx — Settings > Mac > Pair a Mac: the outer camera's
// live preview at 1:1 on the touch screen under a viewfinder, the console's
// QR decoder polled every frame, and the pairing handshake's progress.
//
//   scanning -> (pocketlink QR) -> connecting to <name> -> paired -> back to Mac
//
// A code that is not a pairing URI leaves the scanner running with a hint.

import { createSignal, onCleanup, Show, type Accessor } from "solid-js";
import { Image, Text, View } from "@pocketjs/framework/components";
import { after } from "@pocketjs/framework/clock";
import { closeCamera, openCamera, pollQrCode } from "@pocketjs/framework/camera";
import { isPairingUri } from "@pocketjs/framework/link";
import { onFrame } from "@pocketjs/framework/lifecycle";
import { registerTexture } from "@pocketjs/framework/renderer";
import { ClassicSpinner } from "@pocketjs/framework/classic";
import { LINK_PAIRING, type HomeSystem } from "./system.ts";
import type { NavStack, PageSpec } from "./ui/nav.tsx";
import { ellipsize, FONT, toAscii } from "./ui/text.ts";

export const PREVIEW_KEY = "camera.preview";

export type ScanState =
  | { t: "scanning"; hint: string }
  | { t: "connecting"; name: string }
  | { t: "paired"; name: string }
  | { t: "failed"; name: string; message: string }
  | { t: "unavailable" };

/** The companion name a pairing URI carries (its `n` parameter). */
export function pairingName(uri: string): string {
  const query = uri.slice(uri.indexOf("?") + 1);
  for (const part of query.split("&")) {
    const at = part.indexOf("=");
    if (at > 0 && part.slice(0, at) === "n") {
      try {
        return toAscii(decodeURIComponent(part.slice(at + 1).replace(/\+/g, " "))) || "Mac";
      } catch {
        return "Mac";
      }
    }
  }
  return "Mac";
}

const BOX = 150;
const BOX_X = (320 - BOX) / 2;
const BOX_Y = 46;

export function scannerPage(sys: HomeSystem, stack: NavStack, setScan: (state: ScanState) => void, scan: Accessor<ScanState>): PageSpec {
  const handle = openCamera();
  if (handle >= 0) registerTexture(PREVIEW_KEY, handle);
  setScan(handle >= 0 ? { t: "scanning", hint: "" } : { t: "unavailable" });
  let hintFrames = 0;
  let leaving = false;

  let disposed = false;
  onCleanup(() => {
    disposed = true;
    closeCamera();
  });

  onFrame(() => {
    const state = scan();
    if (state.t === "unavailable" || leaving) return;
    if (state.t === "scanning" || state.t === "failed") {
      if (hintFrames > 0 && --hintFrames === 0 && state.t === "scanning") setScan({ t: "scanning", hint: "" });
      const code = pollQrCode();
      if (code === undefined) return;
      if (!isPairingUri(code)) {
        hintFrames = 120;
        setScan({ t: "scanning", hint: "That code is not a Pocket pairing code." });
        return;
      }
      const name = pairingName(code);
      if (sys.pair(code)) setScan({ t: "connecting", name });
      else setScan({ t: "failed", name, message: "The pairing code could not be read." });
      return;
    }
    if (state.t === "connecting") {
      const pairing = sys.link().pairing;
      if (pairing === LINK_PAIRING.paired) {
        setScan({ t: "paired", name: sys.link().companion?.name ?? state.name });
        leaving = true;
        // Back to the Mac page, unless the user already left the scanner.
        after(1.2, () => !disposed && stack.top()?.page === "scan" && stack.pop());
      } else if (pairing === LINK_PAIRING.failed) {
        setScan({ t: "failed", name: state.name, message: sys.link().error || "The Mac refused the pairing." });
      }
    }
  });

  const pill = () => {
    const state = scan();
    switch (state.t) {
      case "scanning":
        return state.hint || "Point the camera at the code on your Mac";
      case "connecting":
        return ellipsize(`Connecting to ${state.name}...`, FONT.smBold, 240);
      case "paired":
        return ellipsize(`Paired with ${state.name}`, FONT.smBold, 240);
      case "failed":
        return ellipsize(state.message, FONT.smBold, 270);
      default:
        return "";
    }
  };

  return {
    title: () => "Pair a Mac",
    backLabel: "Scan",
    tint: "black",
    bare: true,
    fixed: () => (
      <>
        <View class="absolute left-0 top-0 w-[320] h-[240] bg-black overflow-hidden">
          <Show when={scan().t !== "unavailable"}>
            <Image class="absolute left-0 top-0 w-[512] h-[256]" src={PREVIEW_KEY} />
          </Show>
        </View>
        <Show when={scan().t === "unavailable"}>
          <Image class="absolute left-[136] top-[80] w-[48] h-[48]" src="art/camera.svg" />
          <Text class="absolute left-0 top-[136] w-[320] text-sm text-white font-bold text-center">Camera unavailable</Text>
          <Text class="absolute left-0 top-[156] w-[320] text-xs text-[#ffffffa0] text-center">This console did not start its outer camera.</Text>
        </Show>
        <Show when={scan().t !== "unavailable"}>
          {/* the viewfinder: dim everything outside the square, bracket its corners */}
          <View class="absolute left-0 top-[36] w-[320] bg-[#00000070]" style={{ height: BOX_Y - 36 }} />
          <View class="absolute left-0 w-[320] bg-[#00000070]" style={{ insetT: BOX_Y + BOX, height: 240 - BOX_Y - BOX }} />
          <View class="absolute left-0 bg-[#00000070]" style={{ insetT: BOX_Y, width: BOX_X, height: BOX }} />
          <View class="absolute bg-[#00000070]" style={{ insetL: BOX_X + BOX, insetT: BOX_Y, width: 320 - BOX_X - BOX, height: BOX }} />
          <View class={scan().t === "paired" ? "absolute w-[22] h-[4] bg-[#5fd35f]" : "absolute w-[22] h-[4] bg-white"} style={{ insetL: BOX_X - 2, insetT: BOX_Y - 2 }} />
          <View class={scan().t === "paired" ? "absolute w-[4] h-[22] bg-[#5fd35f]" : "absolute w-[4] h-[22] bg-white"} style={{ insetL: BOX_X - 2, insetT: BOX_Y - 2 }} />
          <View class={scan().t === "paired" ? "absolute w-[22] h-[4] bg-[#5fd35f]" : "absolute w-[22] h-[4] bg-white"} style={{ insetL: BOX_X + BOX - 20, insetT: BOX_Y - 2 }} />
          <View class={scan().t === "paired" ? "absolute w-[4] h-[22] bg-[#5fd35f]" : "absolute w-[4] h-[22] bg-white"} style={{ insetL: BOX_X + BOX - 2, insetT: BOX_Y - 2 }} />
          <View class={scan().t === "paired" ? "absolute w-[22] h-[4] bg-[#5fd35f]" : "absolute w-[22] h-[4] bg-white"} style={{ insetL: BOX_X - 2, insetT: BOX_Y + BOX - 2 }} />
          <View class={scan().t === "paired" ? "absolute w-[4] h-[22] bg-[#5fd35f]" : "absolute w-[4] h-[22] bg-white"} style={{ insetL: BOX_X - 2, insetT: BOX_Y + BOX - 20 }} />
          <View class={scan().t === "paired" ? "absolute w-[22] h-[4] bg-[#5fd35f]" : "absolute w-[22] h-[4] bg-white"} style={{ insetL: BOX_X + BOX - 20, insetT: BOX_Y + BOX - 2 }} />
          <View class={scan().t === "paired" ? "absolute w-[4] h-[22] bg-[#5fd35f]" : "absolute w-[4] h-[22] bg-white"} style={{ insetL: BOX_X + BOX - 2, insetT: BOX_Y + BOX - 20 }} />
          <Show when={scan().t === "paired"}>
            <View class="absolute w-[64] h-[64] rounded-[32] bg-[#3fae3fd0]" style={{ insetL: 128, insetT: BOX_Y + BOX / 2 - 32 }} />
            <Image class="absolute w-[40] h-[40]" src="art/checkmark-big.svg" style={{ insetL: 140, insetT: BOX_Y + BOX / 2 - 20 }} />
          </Show>
          {/* status pill */}
          <View
            class={scan().t === "failed" || (scan().t === "scanning" && pill() !== "Point the camera at the code on your Mac")
              ? "absolute left-[12] top-[204] w-[296] h-[28] rounded-[14] bg-[#b3261ee0] border border-[#ffffff50]"
              : "absolute left-[12] top-[204] w-[296] h-[28] rounded-[14] bg-[#000000b0] border border-[#ffffff40]"}
          />
          <Show when={scan().t === "connecting"}>
            <View class="absolute left-[22] top-[210]">
              <ClassicSpinner size={16} color={"#ffffff"} />
            </View>
          </Show>
          <Text class="absolute left-[12] top-[209] w-[296] text-sm text-white font-bold text-center">{pill()}</Text>
        </Show>
      </>
    ),
  };
}
