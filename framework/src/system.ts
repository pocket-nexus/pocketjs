// The system layer a presentation gets for free (@pocketjs/framework/system).
//
// docs/HIG.md §4 reserves SELECT for the system: holding it opens the
// system sheet — the application's identity, its live status line, the
// verbs the application registers for the sheet, "Return to launcher" where
// a launcher hosts the guest, and Close. Every application that installs the
// layer behaves the same way, and no application binds SELECT itself.
//
// This is the guest-side form of the reserved chord: the host still delivers
// SELECT in the mask, so the layer watches it here; a host that intercepts
// system chords natively later can keep this sheet as the thing it opens.
//
//   installSystemLayer({
//     title: "Pocket YouTube", version: "0.3.0",
//     status: () => store.connected() ? "Companion connected" : "Waiting for the companion",
//     items: () => store.player() ? [{ label: "Stop playback", run: store.stopPlayback }] : [],
//   });

import { createSignal, For, onCleanup, Show, type Accessor, type JSX as SolidJSX } from "solid-js";
import { BTN, SCREEN_H, SCREEN_W } from "../../contracts/spec/spec.ts";
import { simulationHz } from "./clock.ts";
import { AuxiliaryPortal, Focusable, FocusScope, Portal, Text, View } from "./components.ts";
import { auxiliaryViewport, type SurfaceId } from "./display.ts";
import { onButtonPress, onFrame, pushButtonHandlerBlock } from "./frame.ts";
import { pushTouchBlock } from "./gesture.ts";
import { getOps, hostViewport } from "./host.ts";
import { appTable, launchApp, launcherActive } from "./launcher.ts";
import { glyph, modality } from "./modality.ts";

export interface SystemItem {
  label: string;
  run: () => void;
  disabled?: boolean;
}

export interface SystemLayerOptions {
  title: string;
  version?: string;
  /** One line of live state under the title. */
  status?: () => string;
  /** Application verbs for the sheet, re-read while it is open. */
  items?: () => readonly SystemItem[];
  /** The surface the sheet renders on. Default: primary. */
  surface?: SurfaceId;
}

export interface SystemLayer {
  open(): void;
  close(): void;
  isOpen: Accessor<boolean>;
}

/** Holding SELECT this long opens the sheet (virtual seconds). */
export const SYSTEM_HOLD_SECONDS = 0.4;

const SCRIM = "#10203866";
const ROW = "h-[30] rounded-[6] items-center justify-center border border-[#8c99aa] bg-gradient-to-b from-[#ffffff] to-[#d1d8e2] focus:border-[#2363c2] focus:from-[#e3effe] focus:to-[#b7d3f6] active:from-[#69a5f2] active:to-[#2363c2]";
const ROW_DISABLED = "h-[30] rounded-[6] items-center justify-center border border-[#b8c1cc] bg-[#e6eaef]";

function surfaceSize(surface: SurfaceId): { w: number; h: number } {
  if (surface === "auxiliary") {
    const viewport = auxiliaryViewport();
    if (viewport) return { w: viewport.width, h: viewport.height };
  }
  return hostViewport(getOps()) ?? { w: SCREEN_W, h: SCREEN_H };
}

export function installSystemLayer(options: SystemLayerOptions): SystemLayer {
  const [isOpen, setOpen] = createSignal(false);
  const surface = options.surface ?? "primary";
  const layer: SystemLayer = {
    open: () => setOpen(true),
    close: () => setOpen(false),
    isOpen,
  };

  // Hold SELECT: counted in virtual frames so tapes stay exact.
  if (modality.buttons) {
    let held = 0;
    onFrame((buttons) => {
      const frames = Math.max(1, Math.round(SYSTEM_HOLD_SECONDS * simulationHz()));
      if (buttons & BTN.SELECT) {
        held++;
        if (held === frames && !isOpen()) setOpen(true);
      } else {
        held = 0;
      }
    });
  }

  const Overlay = surface === "auxiliary" ? AuxiliaryPortal : Portal;
  // The sheet lives in the overlay for the layer's lifetime and shows while open.
  Overlay({
    children: () =>
      Show({
        get when() { return isOpen(); },
        get children() { return SystemSheet({ options, surface, close: layer.close }); },
      }) as SolidJSX.Element,
  });
  return layer;
}

function SystemSheet(props: { options: SystemLayerOptions; surface: SurfaceId; close: () => void }): SolidJSX.Element {
  const size = surfaceSize(props.surface);
  // Modal: the application's buttons and gestures are muted; the sheet's
  // own chords stay live. × and SELECT close it.
  onCleanup(pushButtonHandlerBlock());
  onCleanup(pushTouchBlock());
  onButtonPress(BTN.CROSS | BTN.SELECT, () => props.close(), { latched: true, allowWhenBlocked: true });

  const rows = (): readonly SystemItem[] => {
    const app = props.options.items?.() ?? [];
    // On a switching host, hand the guest back: the interrupted application
    // when the launcher summoned us, else the first other bundle.
    const table = launcherActive() ? appTable() : null;
    const home = table ? table.apps.find((app) => app.output === table.resume) ?? table.apps.find((app) => app.output !== table.current) : undefined;
    const launcher: SystemItem[] = home
      ? [{ label: table?.resume ? `Back to ${home.title}` : "Return to launcher", run: () => { launchApp(home.output); } }]
      : [];
    return [...app, ...launcher, { label: "Close", run: props.close }];
  };
  const height = () => 74 + rows().length * 36 + 8;

  return View({
    style: { posType: 1, insetL: 0, insetT: 0, width: size.w, height: size.h },
    get children() {
      return [
        // A flat scrim (no border, no radius: the PSP GE would otherwise
        // paint a translucent rounded node in its border colour).
        Focusable({ onPress: props.close, style: { posType: 1, insetL: 0, insetT: 0, width: size.w, height: size.h, bgColor: SCRIM } }),
        FocusScope({
          restoreFocus: true,
          class: "absolute border border-[#657489] bg-gradient-to-b from-[#f4f6f9] to-[#c9d2dd]",
          get style() { return { insetL: 0, insetB: 0, width: size.w, height: height(), radius: 0 }; },
          get children() {
            return [
              View({ style: { posType: 1, insetL: 0, insetT: 0, width: size.w, height: 1, bgColor: "#ffffff" } }),
              View({
                class: "absolute flex-col items-center",
                style: { insetL: 12, insetT: 10, width: size.w - 24 },
                get children() {
                  return [
                    Text({ class: "text-sm font-bold", style: { textColor: "#243955" }, get children() {
                      return props.options.version ? `${props.options.title} ${props.options.version}` : props.options.title;
                    } }),
                    Text({ class: "text-xs", style: { textColor: "#4f5d70", lineHeight: 14 }, get children() {
                      return props.options.status?.() ?? "";
                    } }),
                  ];
                },
              }),
              View({
                class: "absolute flex-col gap-[6]",
                style: { insetL: 16, insetT: 56, width: size.w - 32 },
                get children() {
                  return For({
                    get each() { return rows(); },
                    children: (item: SystemItem) =>
                      Focusable({
                        get class() { return item.disabled ? ROW_DISABLED : ROW; },
                        onPress: item.disabled ? undefined : item.run,
                        get children() {
                          return Text({ class: "text-xs font-bold", get style() { return { textColor: item.disabled ? "#8c99aa" : "#263950" }; },
                            get children() { return item.label; } });
                        },
                      }),
                  });
                },
              }),
              View({
                class: "absolute items-center",
                style: { insetL: 0, insetB: 4, width: size.w },
                get children() {
                  return Text({ class: "text-xs", style: { textColor: "#4f5d70" }, get children() {
                    return modality.buttons ? `${glyph("cross")} close · hold ${glyph("select")} opens this sheet` : "Tap outside to close";
                  } });
                },
              }),
            ];
          },
        }),
      ];
    },
  });
}
