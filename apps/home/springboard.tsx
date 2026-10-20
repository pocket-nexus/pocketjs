// apps/home/springboard.tsx — the Home screen on the touch screen: the
// status bar (time, Wi-Fi, the linked Mac), pages of glossy icons over the
// wallpaper, page dots and the glass dock holding Settings and Mac.
//
// The pages sit side by side in one row that a drag moves sideways, as on
// SpringBoard: the row follows the finger, resists past the first and last
// page, and on release settles on the page the drag or the flick points to.
// The D-pad pages at the grid's left and right edges.
//
// Installed mini-apps come from the launcher's app table. Tapping one zooms
// the screen and asks the host to switch to it; holding one (or Y) starts
// edit mode, where icons wiggle and a badge deletes an app. An app the host
// interrupted, or one that stopped with an error, is announced by an iOS 6
// banner that slides over the status bar.

import { createMemo, createSignal, For, Show, type Accessor } from "solid-js";
import { Image, Text, View, type NodeMirror } from "@pocketjs/framework/components";
import { animate, cancelAnim, jump } from "@pocketjs/framework/animation";
import { after } from "@pocketjs/framework/clock";
import { BTN } from "@pocketjs/framework/input";
import { onFrame } from "@pocketjs/framework/lifecycle";
import { civilFromEpoch, statusTime } from "./clock.ts";
import { ICONS, linkSummary } from "./pages.tsx";
import { LINK_STATE, type HomeApp, type HomeSystem } from "./system.ts";
import { appTint, StatusBar, Tile, Wallpaper } from "./ui/chrome.tsx";
import { ellipsize, FONT } from "./ui/text.ts";
import type { Press, Target, TouchPage } from "./ui/touch.ts";

export const COLS = 4;
export const ROWS = 2;
export const PER_PAGE = COLS * ROWS;
const ICON = 46;
const CELL_W = 80;
const ROW_Y = [26, 100];
const BANNER_H = 36;
/** Seconds a banner stays before it slides away. */
const BANNER_SECONDS = 6;
const DOCK_Y = 174;
const DOTS_Y = 168;
const PAGE_W = 320;
/** A release faster than this (px/s) turns the page toward the flick. */
const FLICK = 250;
/** UIScrollView's rubber band: the row moves (1 - 1/(over*k/w + 1))*w. */
const RUBBER = 0.55;

const rubber = (over: number) => (1 - 1 / ((Math.abs(over) * RUBBER) / PAGE_W + 1)) * PAGE_W * Math.sign(over);

export interface DockItem {
  key: "dock:settings" | "dock:mac";
  title: string;
}

export const DOCK: readonly DockItem[] = [
  { key: "dock:settings", title: "Settings" },
  { key: "dock:mac", title: "Mac" },
];
const DOCK_X = [97, 177];

export interface SpringboardEnv {
  sys: HomeSystem;
  press: Press;
  keys: Accessor<boolean>;
  setKeys(on: boolean): void;
  openApp(which: "settings" | "store"): void;
  confirm(title: string, message: string, action: string, run: () => void): void;
  /** False while another layer owns the screen. */
  active: Accessor<boolean>;
}

export interface Springboard {
  view: () => ReturnType<typeof View>;
  touch(): TouchPage;
  key(pressed: number): boolean;
  editing: Accessor<boolean>;
  launching: Accessor<string>;
}

/** The banner over the status bar: an app to go back to, or one that stopped. */
interface Banner {
  app: HomeApp | null;
  title: string;
  line: string;
  /** Tapping the banner: go back to the app, or dismiss. */
  resume: boolean;
}

function bannerFor(sys: HomeSystem): Banner | null {
  const table = sys.table();
  if (table.lastError) {
    const failed = table.apps.find((app) => app.output === table.lastError!.output) ?? null;
    return { app: failed, title: `${failed?.title ?? table.lastError.output} stopped`, line: table.lastError.message, resume: false };
  }
  const resume = table.resume ? table.apps.find((app) => app.output === table.resume) ?? null : null;
  if (resume) return { app: resume, title: resume.title, line: "Tap here or press SELECT to go back to it.", resume: true };
  return null;
}

const iconX = (slot: number) => (slot % COLS) * CELL_W + (CELL_W - ICON) / 2;
const iconY = (slot: number) => ROW_Y[Math.floor(slot / COLS)]!;

export function createSpringboard(env: SpringboardEnv): Springboard {
  const { sys, press } = env;
  const apps = () => sys.table().apps;
  const pages = () => Math.max(1, Math.ceil(apps().length / PER_PAGE));
  const [page, setPage] = createSignal(0);
  const [focus, setFocus] = createSignal<string>("");
  const [editing, setEditing] = createSignal(false);
  const [banner, setBanner] = createSignal<Banner | null>(bannerFor(sys));
  const time = createMemo(() => civilFromEpoch(sys.now(), sys.offset()));
  const [launching, setLaunching] = createSignal("");
  const [wiggle, setWiggle] = createSignal(0);
  let gridNode: NodeMirror | undefined;
  let boardNode: NodeMirror | undefined;

  const items = createMemo(() => [...apps().map((app) => `app:${app.output}`), ...DOCK.map((item) => item.key)]);
  const lookup = (key: string): HomeApp | DockItem | null => {
    if (key.startsWith("app:")) return apps().find((app) => `app:${app.output}` === key) ?? null;
    return DOCK.find((item) => item.key === key) ?? null;
  };

  let bannerNode: NodeMirror | undefined;
  const hideBanner = () => {
    if (!banner()) return;
    if (bannerNode) animate(bannerNode, "translateY", -BANNER_H, { dur: 220, easing: "in" });
    after(0.24, () => setBanner(null));
  };
  if (banner()) after(BANNER_SECONDS, hideBanner);
  const tapBanner = () => {
    const current = banner();
    if (current?.resume && current.app) sys.launch(current.app.output);
    else hideBanner();
  };

  // The row's offset in px (0 = first page) as last written, and the
  // settle animation that may be moving it: its ease-out cubic is evaluated
  // here too, so a finger that lands mid-settle picks the row up where it is.
  let rowX = 0;
  let settle = { id: -1, from: 0, to: 0, frame: 0, frames: 0 };
  let frames = 0;
  onFrame(() => {
    frames++;
    if (editing() && frames % 5 === 0) setWiggle((wiggle() + 1) % 4);
    // Keep the page index inside the table after a removal.
    if (page() > pages() - 1) showPage(pages() - 1);
  });

  const clampPage = (next: number) => Math.max(0, Math.min(pages() - 1, next));
  const settledX = () => {
    if (settle.id < 0) return rowX;
    const t = Math.min(1, (frames - settle.frame) / settle.frames);
    return settle.from + (settle.to - settle.from) * (1 - (1 - t) ** 3);
  };
  const stopSettle = () => {
    if (settle.id < 0) return;
    rowX = settledX();
    cancelAnim(settle.id);
    settle.id = -1;
    if (gridNode) jump(gridNode, "translateX", rowX);
  };
  const placeRow = (x: number) => {
    rowX = x;
    if (gridNode) jump(gridNode, "translateX", x);
  };

  const showPage = (next: number, animated = true) => {
    const target = clampPage(next);
    setPage(target);
    stopSettle();
    const to = -target * PAGE_W;
    if (!gridNode || !animated || rowX === to) return placeRow(to);
    const ms = Math.max(180, Math.min(340, 150 + Math.abs(to - rowX) * 0.6));
    settle = { id: animate(gridNode, "translateX", to, { dur: ms, easing: "out" }), from: rowX, to, frame: frames, frames: ms / (1000 / 60) };
    rowX = to;
  };

  // A drag: the row follows the finger from where it was picked up.
  let dragFrom = 0;
  const dragTo = (dx: number) => {
    const x = dragFrom + dx;
    const min = -(pages() - 1) * PAGE_W;
    placeRow(x > 0 ? rubber(x) : x < min ? min + rubber(x - min) : x);
    const live = clampPage(Math.round(-rowX / PAGE_W));
    if (live !== page()) setPage(live);
  };
  const release = (vx: number) => {
    const at = -rowX / PAGE_W;
    showPage(vx < -FLICK ? Math.floor(at) + 1 : vx > FLICK ? Math.ceil(at) - 1 : Math.round(at));
  };

  const launch = (app: HomeApp) => {
    if (launching()) return;
    setLaunching(app.output);
    if (boardNode) {
      animate(boardNode, "scale", 1.6, { dur: 260, easing: "in" });
      animate(boardNode, "opacity", 0, { dur: 260, easing: "in" });
    }
    after(0.28, () => {
      if (sys.launch(app.output)) return;
      setLaunching("");
      if (boardNode) {
        jump(boardNode, "scale", 1);
        jump(boardNode, "opacity", 1);
      }
      env.confirm(`Cannot Open "${app.title}"`, "The console did not start this app.", "OK", () => {});
    });
  };

  const activate = (key: string) => {
    if (key === "dock:settings") env.openApp("settings");
    else if (key === "dock:mac") env.openApp("store");
    else {
      const app = lookup(key) as HomeApp | null;
      if (app && !editing()) launch(app);
    }
  };

  const remove = (app: HomeApp) =>
    env.confirm(`Delete "${app.title}"?`, "Deleting this app also deletes its data.", "Delete", () => {
      sys.remove(app);
      if (apps().length === 0) setEditing(false);
    });

  const targets = (): Target[] => {
    const out: Target[] = [];
    const first = page() * PER_PAGE;
    apps().slice(first, first + PER_PAGE).forEach((app, index) => {
      const key = `app:${app.output}`;
      out.push({
        id: key,
        x: iconX(index) - 10,
        y: iconY(index) - 4,
        w: ICON + 20,
        h: ICON + 22,
        run: () => activate(key),
        hold: () => setEditing(true),
      });
      if (editing()) {
        out.push({ id: `delete:${app.output}`, x: iconX(index) - 14, y: iconY(index) - 14, w: 28, h: 28, run: () => remove(app) });
      }
    });
    DOCK.forEach((item, index) => {
      out.push({ id: item.key, x: DOCK_X[index]! - 10, y: DOCK_Y - 4, w: ICON + 20, h: ICON + 20, run: () => !editing() && activate(item.key) });
    });
    if (banner()) out.push({ id: "banner", x: 0, y: 0, w: 320, h: BANNER_H, run: tapBanner });
    return out;
  };

  // D-pad: the grid page as a 4-column matrix, the dock as the last row.
  const moveFocus = (pressed: number) => {
    const list = items();
    const dockStart = apps().length;
    if (!env.keys() || !list.includes(focus())) {
      env.setKeys(true);
      setFocus(list[Math.min(page() * PER_PAGE, dockStart)] ?? list[0] ?? "");
      return;
    }
    const at = list.indexOf(focus());
    if (at >= dockStart) {
      const dockIndex = at - dockStart;
      if (pressed & BTN.LEFT && dockIndex > 0) setFocus(list[at - 1]!);
      else if (pressed & BTN.RIGHT && dockIndex < DOCK.length - 1) setFocus(list[at + 1]!);
      else if (pressed & BTN.UP && dockStart > 0) {
        const first = page() * PER_PAGE;
        const onPage = Math.min(PER_PAGE, dockStart - first);
        const lastRow = Math.floor((onPage - 1) / COLS);
        const column = Math.min(COLS - 1, dockIndex + 1);
        setFocus(list[first + Math.min(onPage - 1, lastRow * COLS + column)]!);
      }
      return;
    }
    const slot = at - page() * PER_PAGE;
    const column = slot % COLS;
    if (pressed & BTN.LEFT) {
      if (column > 0) setFocus(list[at - 1]!);
      else if (page() > 0) {
        showPage(page() - 1);
        setFocus(list[Math.min(dockStart - 1, at - 1)]!);
      }
    } else if (pressed & BTN.RIGHT) {
      if (column < COLS - 1 && at + 1 < dockStart) setFocus(list[at + 1]!);
      else if (page() < pages() - 1) {
        showPage(page() + 1);
        setFocus(list[Math.min(dockStart - 1, (page()) * PER_PAGE + Math.floor(slot / COLS) * COLS)]!);
      }
    } else if (pressed & BTN.UP) {
      if (slot >= COLS) setFocus(list[at - COLS]!);
    } else if (pressed & BTN.DOWN) {
      if (slot + COLS < PER_PAGE && at + COLS < dockStart) setFocus(list[at + COLS]!);
      else setFocus(list[dockStart + (column < 2 ? 0 : 1)]!);
    }
  };

  const view = () => (
    <View ref={(node) => (boardNode = node)} class="absolute left-0 top-0 w-[320] h-[240]">
      <Wallpaper screen="bottom" />
      <View ref={(node) => (gridNode = node)} class="absolute left-0 top-0 w-[320] h-[164]">
        <For each={apps()}>
          {(app, index) => <AppIcon app={app} index={index()} env={env} focus={focus} editing={editing} wiggle={wiggle} />}
        </For>
      </View>
      <Show when={apps().length === 0}>
        <Text class="absolute left-0 top-[58] w-[320] text-sm text-[#ffffffd0] font-bold text-center">No apps yet</Text>
        <Text class="absolute left-0 top-[78] w-[320] text-xs text-[#ffffffa0] text-center">Open Mac below to install apps from your Mac.</Text>
      </Show>
      <Show when={pages() > 1}>
        <For each={Array.from({ length: pages() }, (_, index) => index)}>
          {(index) => (
            <View
              class={page() === index ? "absolute w-[6] h-[6] rounded-[3] bg-white" : "absolute w-[6] h-[6] rounded-[3] bg-[#ffffff55]"}
              style={{ insetL: 160 - pages() * 6 + index * 12, insetT: DOTS_Y }}
            />
          )}
        </For>
      </Show>
      <Image class="absolute left-0 top-[200] w-[512] h-[64]" src="art/icons/dock.png" />
      <For each={DOCK}>
        {(item, index) => (
          <>
            <Tile
              x={DOCK_X[index()]!}
              y={DOCK_Y}
              size={ICON}
              art={item.key === "dock:settings" ? ICONS.general.art : ICONS.mac.art}
              dim={() => press.is(item.key)}
            />
            <View
              class={env.keys() && focus() === item.key ? "absolute w-[54] h-[54] rounded-[13] border-[#ffffff] border-2" : "hidden"}
              style={{ insetL: DOCK_X[index()]! - 4, insetT: DOCK_Y - 4 }}
            />
            <Text class="absolute text-xs text-[#00000099] font-bold text-center" style={{ insetL: DOCK_X[index()]! - 17, insetT: 223, width: ICON + 34 }}>{item.title}</Text>
            <Text class="absolute text-xs text-white font-bold text-center" style={{ insetL: DOCK_X[index()]! - 17, insetT: 222, width: ICON + 34 }}>{item.title}</Text>
          </>
        )}
      </For>
      <StatusBar
        width={320}
        carrier="Pocket"
        bars={() => {
          const wifi = sys.wifi();
          return !wifi || wifi.state === "off" ? -1 : wifi.state === "connected" ? wifi.strength : 0;
        }}
        time={() => statusTime(time())}
        right={() => (sys.link().state === LINK_STATE.linked ? ellipsize(linkSummary(sys), FONT.xsBold, 104) : "")}
      />
      <Show when={banner()}>
        {(current) => (
          <View
            ref={(node) => {
              bannerNode = node;
              jump(node, "translateY", -BANNER_H);
              animate(node, "translateY", 0, { dur: 260, easing: "out" });
            }}
            class="absolute left-0 top-0 w-[320] h-[36] bg-gradient-to-b from-[#3a3a3a] to-[#0c0c0c]"
          >
            <View class="absolute left-0 bottom-0 w-[320] h-[1] bg-[#000000]" />
            <View class="absolute left-0 top-0 w-[320] h-[1] bg-[#ffffff30]" />
            <Show
              when={current().app}
              fallback={<Tile x={7} y={6} size={24} art={ICONS.general.art} />}
            >
              {(app) => <Tile x={7} y={6} size={24} {...appTint(app().id, app().title)} />}
            </Show>
            <Text class="absolute left-[38] top-[3] text-xs text-white font-bold">{ellipsize(current().title, FONT.xsBold, 272)}</Text>
            <Text class="absolute left-[38] top-[18] text-xs text-[#ffffffb8]">{ellipsize(current().line, FONT.xs, 272)}</Text>
          </View>
        )}
      </Show>
    </View>
  ) as unknown as ReturnType<typeof View>;

  return {
    view,
    editing,
    launching,
    touch: () => ({
      targets,
      background: () => setEditing(false),
      panX: {
        start: () => {
          stopSettle();
          dragFrom = rowX;
        },
        move: dragTo,
        end: (_dx, vx) => release(vx),
      },
    }),
    key(pressed) {
      if (!env.active()) return false;
      if (pressed & BTN.SQUARE) {
        setEditing(!editing() && apps().length > 0);
        return true;
      }
      if (pressed & (BTN.CROSS | BTN.START) && editing()) {
        setEditing(false);
        return true;
      }
      if (pressed & (BTN.UP | BTN.DOWN | BTN.LEFT | BTN.RIGHT)) {
        moveFocus(pressed);
        return true;
      }
      if (pressed & BTN.CIRCLE && env.keys() && focus()) {
        press.down(focus());
        press.release();
        if (editing() && focus().startsWith("app:")) remove(lookup(focus()) as HomeApp);
        else activate(focus());
        return true;
      }
      return false;
    },
  };
}

function AppIcon(props: {
  app: HomeApp;
  index: number;
  env: SpringboardEnv;
  focus: Accessor<string>;
  editing: Accessor<boolean>;
  wiggle: Accessor<number>;
}) {
  const key = `app:${props.app.output}`;
  const tint = appTint(props.app.id, props.app.title);
  const pageIndex = Math.floor(props.index / PER_PAGE);
  const slot = props.index % PER_PAGE;
  const x = pageIndex * 320 + iconX(slot);
  const y = iconY(slot);
  const angle = () => (props.editing() ? ([-2, 0, 2, 0][(props.wiggle() + props.index) % 4] ?? 0) : 0);
  return (
    <View class="absolute w-[46] h-[46]" style={{ insetL: x, insetT: y, rotate: angle() }}>
      <Tile x={0} y={0} size={ICON} {...tint} dim={() => props.env.press.is(key)} />
      <View class={props.env.keys() && props.focus() === key ? "absolute left-[-4] top-[-4] w-[54] h-[54] rounded-[13] border-[#ffffff] border-2" : "hidden"} />
      <Show when={props.editing()}>
        <Image class="absolute left-[-9] top-[-9] w-[22] h-[22]" src="art/delete-badge.svg" />
      </Show>
      <Text class="absolute left-[-16] top-[50] w-[78] text-xs text-[#00000099] font-bold text-center">{ellipsize(props.app.title, FONT.xsBold, 77)}</Text>
      <Text class="absolute left-[-16] top-[49] w-[78] text-xs text-white font-bold text-center">{ellipsize(props.app.title, FONT.xsBold, 77)}</Text>
    </View>
  );
}
