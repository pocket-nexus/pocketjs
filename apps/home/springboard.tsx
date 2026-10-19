// apps/home/springboard.tsx — the Home screen on the touch screen (a page
// of glossy icons over the wallpaper, page dots and the glass dock holding
// Settings and Mac) and the lock-screen-style top screen above it.
//
// Installed mini-apps come from the launcher's app table. Tapping one zooms
// the screen and asks the host to switch to it; holding one (or Y) starts
// edit mode, where icons wiggle and a badge deletes an app.

import { createMemo, createSignal, For, Show, type Accessor } from "solid-js";
import { Image, Text, View, type NodeMirror } from "@pocketjs/framework/components";
import { animate, jump } from "@pocketjs/framework/animation";
import { after } from "@pocketjs/framework/clock";
import { BTN } from "@pocketjs/framework/input";
import { onFrame } from "@pocketjs/framework/lifecycle";
import { civilFromEpoch, clockText, dateText, statusTime } from "./clock.ts";
import { ICONS, linkSummary } from "./pages.tsx";
import { LINK_STATE, sizeText, type HomeApp, type HomeSystem } from "./system.ts";
import { appTint, StatusBar, Tile, Wallpaper } from "./ui/chrome.tsx";
import { ellipsize, FONT } from "./ui/text.ts";
import type { Press, Target, TouchPage } from "./ui/touch.ts";

export const COLS = 4;
export const ROWS = 2;
export const PER_PAGE = COLS * ROWS;
const ICON = 46;
const CELL_W = 80;
const ROW_Y = [10, 88];
const DOCK_Y = 178;
const DOTS_Y = 168;

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
  /** The app the top screen describes (focused or last pressed). */
  selected: Accessor<HomeApp | DockItem | null>;
  editing: Accessor<boolean>;
  launching: Accessor<string>;
}

const iconX = (slot: number) => (slot % COLS) * CELL_W + (CELL_W - ICON) / 2;
const iconY = (slot: number) => ROW_Y[Math.floor(slot / COLS)]!;

export function createSpringboard(env: SpringboardEnv): Springboard {
  const { sys, press } = env;
  const apps = () => sys.table().apps;
  const pages = () => Math.max(1, Math.ceil(apps().length / PER_PAGE));
  const [page, setPage] = createSignal(0);
  const [focus, setFocus] = createSignal<string>("");
  const [lastPressed, setLastPressed] = createSignal<string>("");
  const [editing, setEditing] = createSignal(false);
  const [launching, setLaunching] = createSignal("");
  const [wiggle, setWiggle] = createSignal(0);
  let gridNode: NodeMirror | undefined;
  let boardNode: NodeMirror | undefined;

  const items = createMemo(() => [...apps().map((app) => `app:${app.output}`), ...DOCK.map((item) => item.key)]);
  const lookup = (key: string): HomeApp | DockItem | null => {
    if (key.startsWith("app:")) return apps().find((app) => `app:${app.output}` === key) ?? null;
    return DOCK.find((item) => item.key === key) ?? null;
  };
  const selected = () => lookup(env.keys() ? focus() : press.id().startsWith("app:") || press.id().startsWith("dock:") ? press.id() : lastPressed());

  let frames = 0;
  onFrame(() => {
    frames++;
    if (editing() && frames % 5 === 0) setWiggle((wiggle() + 1) % 4);
    // Keep the page index inside the table after a removal.
    if (page() > pages() - 1) setPage(pages() - 1);
  });

  const showPage = (next: number, animated = true) => {
    const target = Math.max(0, Math.min(pages() - 1, next));
    setPage(target);
    if (gridNode) {
      if (animated) animate(gridNode, "translateX", -target * 320, { dur: 260, easing: "out" });
      else jump(gridNode, "translateX", -target * 320);
    }
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
    setLastPressed(key);
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
      <Image class="absolute left-0 top-[200] w-[320] h-[40]" src="art/dock.svg" />
      <For each={DOCK}>
        {(item, index) => (
          <>
            <Tile
              x={DOCK_X[index()]!}
              y={DOCK_Y}
              size={ICON}
              from={item.key === "dock:settings" ? ICONS.general.from : ICONS.store.from}
              to={item.key === "dock:settings" ? ICONS.general.to : ICONS.store.to}
              glyph={item.key === "dock:settings" ? ICONS.general.glyph : ICONS.mac.glyph}
              dim={() => press.is(item.key)}
              shadow
            />
            <View
              class={env.keys() && focus() === item.key ? "absolute w-[54] h-[54] rounded-[13] border-[#ffffff] border-2" : "hidden"}
              style={{ insetL: DOCK_X[index()]! - 4, insetT: DOCK_Y - 4 }}
            />
            <Text class="absolute text-xs text-[#00000099] font-bold text-center" style={{ insetL: DOCK_X[index()]! - 17, insetT: 227, width: ICON + 34 }}>{item.title}</Text>
            <Text class="absolute text-xs text-white font-bold text-center" style={{ insetL: DOCK_X[index()]! - 17, insetT: 226, width: ICON + 34 }}>{item.title}</Text>
          </>
        )}
      </For>
    </View>
  ) as unknown as ReturnType<typeof View>;

  return {
    view,
    selected,
    editing,
    launching,
    touch: () => ({
      targets,
      background: () => setEditing(false),
      panX: pages() > 1
        ? {
            start: () => undefined,
            move: (dx) => {
              if (gridNode) jump(gridNode, "translateX", -page() * 320 + dx);
            },
            end: (dx, vx) => showPage(dx < -60 || vx < -300 ? page() + 1 : dx > 60 || vx > 300 ? page() - 1 : page()),
          }
        : undefined,
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
      if (pressed & BTN.LTRIGGER) {
        showPage(page() - 1);
        return true;
      }
      if (pressed & BTN.RTRIGGER) {
        showPage(page() + 1);
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
      <Tile x={0} y={0} size={ICON} from={tint.from} to={tint.to} letters={tint.letters} dim={() => props.env.press.is(key)} shadow />
      <View class={props.env.keys() && props.focus() === key ? "absolute left-[-4] top-[-4] w-[54] h-[54] rounded-[13] border-[#ffffff] border-2" : "hidden"} />
      <Show when={props.editing()}>
        <Image class="absolute left-[-9] top-[-9] w-[22] h-[22]" src="art/delete-badge.svg" />
      </Show>
      <Text class="absolute left-[-17] top-[50] w-[80] text-xs text-[#00000099] font-bold text-center">{ellipsize(props.app.title, FONT.xsBold, 80)}</Text>
      <Text class="absolute left-[-17] top-[49] w-[80] text-xs text-white font-bold text-center">{ellipsize(props.app.title, FONT.xsBold, 80)}</Text>
    </View>
  );
}

// ---- top screen -------------------------------------------------------------------

export interface LockEnv {
  sys: HomeSystem;
  board: Springboard;
  keys: Accessor<boolean>;
}

/** The top screen over the Home screen: status bar, clock and date in a
 *  glass band, a card with the link state, and a bar describing the
 *  selected app (or what the buttons do). */
export function LockScreen(props: { env: LockEnv }) {
  const { sys, board } = props.env;
  const time = createMemo(() => civilFromEpoch(sys.now(), sys.offset()));
  const linkTitle = () => {
    const link = sys.link();
    if (!sys.hasLink) return "Pocket Link unavailable";
    if (link.state === LINK_STATE.linked) return `Linked to ${link.companion?.name ?? "Mac"}`;
    if (link.state === LINK_STATE.unpaired) return "No Mac paired";
    return `Looking for ${link.companion?.name ?? link.paired[0]?.name ?? "your Mac"}...`;
  };
  const linkLine = () => {
    const link = sys.link();
    if (link.state === LINK_STATE.linked) {
      const count = sys.catalog().length;
      return sys.catalogState() === "ready" ? `${count} ${count === 1 ? "app" : "apps"} offered. Open Mac below.` : "Asking the Mac for its apps...";
    }
    if (link.state === LINK_STATE.unpaired) return "Open Settings > Mac to pair one.";
    return "Open Pocket Companion on the Mac.";
  };
  const selection = () => board.selected();
  const appLine = (): { title: string; line: string } => {
    const item = selection();
    const table = sys.table();
    if (board.editing()) return { title: "Editing Home", line: "Tap x to delete an app. B when done." };
    if (item && "output" in item) return { title: item.title, line: `${item.version ? `Version ${item.version}  ` : ""}${sizeText(item.bytes)}` };
    if (item && item.key === "dock:settings") return { title: "Settings", line: "Wi-Fi, Mac, Apps and General" };
    if (item && item.key === "dock:mac") return { title: "Mac", line: "Apps your Mac offers this console" };
    if (table.lastError) {
      const failed = table.apps.find((app) => app.output === table.lastError!.output);
      return { title: `${failed?.title ?? table.lastError.output} stopped`, line: table.lastError.message };
    }
    const resume = table.resume ? table.apps.find((app) => app.output === table.resume) : null;
    if (resume) return { title: resume.title, line: "Press SELECT to go back to it." };
    return { title: "Pocket", line: "Tap an app to open it. Hold one to edit." };
  };
  const tile = () => {
    const item = selection();
    if (item && "output" in item) return appTint(item.id, item.title);
    return null;
  };
  return (
    <View class="relative w-full h-full overflow-hidden bg-black">
      <Wallpaper screen="top" />
      <View class="absolute left-0 top-[16] w-[400] h-[90] bg-gradient-to-b from-[#00000070] to-[#00000040]" />
      <View class="absolute left-0 top-[16] w-[400] h-[45] bg-gradient-to-b from-[#ffffff26] to-[#ffffff0a]" />
      <View class="absolute left-0 top-[105] w-[400] h-[1] bg-[#ffffff30]" />
      <Text class="absolute left-0 top-[15] w-[400] text-5xl text-[#00000060] text-center">{clockText(time())}</Text>
      <Text class="absolute left-0 top-[14] w-[400] text-5xl text-white text-center">{clockText(time())}</Text>
      <Text class="absolute left-0 top-[80] w-[400] text-sm text-[#ffffffd8] text-center">{dateText(time())}</Text>

      <View class="absolute left-[40] top-[118] w-[320] h-[50] rounded-[10] bg-[#00000055] border border-[#ffffff30]" />
      <Tile x={50} y={125} size={36} from={ICONS.mac.from} to={ICONS.mac.to} glyph={ICONS.mac.glyph} />
      <View
        class={sys.link().state === LINK_STATE.linked ? "absolute left-[80] top-[154] w-[9] h-[9] rounded-[5] bg-[#4cd964] border border-[#ffffff]" : "absolute left-[80] top-[154] w-[9] h-[9] rounded-[5] bg-[#a0a6ae] border border-[#ffffff]"}
      />
      <Text class="absolute left-[96] top-[126] text-sm text-white font-bold">{ellipsize(linkTitle(), FONT.smBold, 254)}</Text>
      <Text class="absolute left-[96] top-[145] text-xs text-[#ffffffb8]">{ellipsize(linkLine(), FONT.xs, 254)}</Text>

      <View class="absolute left-0 top-[186] w-[400] h-[54] bg-gradient-to-b from-[#00000080] to-[#000000b0]" />
      <View class="absolute left-0 top-[186] w-[400] h-[1] bg-[#ffffff38]" />
      <Show
        when={tile()}
        fallback={<Tile x={12} y={195} size={36} from={ICONS.general.from} to={ICONS.general.to} glyph={selection() && !("output" in selection()!) && (selection() as DockItem).key === "dock:mac" ? ICONS.mac.glyph : ICONS.general.glyph} />}
      >
        {(tint) => <Tile x={12} y={195} size={36} from={tint().from} to={tint().to} letters={tint().letters} />}
      </Show>
      <Text class="absolute left-[58] top-[196] text-sm text-white font-bold">{ellipsize(appLine().title, FONT.smBold, 240)}</Text>
      <Text class="absolute left-[58] top-[215] text-xs text-[#ffffffb0]">{ellipsize(appLine().line, FONT.xs, 240)}</Text>
      <Text class="absolute left-[300] top-[205] w-[92] text-xs text-[#ffffff90] text-right">
        {board.editing() ? "B  Done" : selection() ? "A  Open" : "Y  Edit"}
      </Text>

      <StatusBar
        width={400}
        carrier="Pocket"
        bars={() => {
          const wifi = sys.wifi();
          return !wifi || wifi.state === "off" ? -1 : wifi.state === "connected" ? wifi.strength : 0;
        }}
        time={() => statusTime(time())}
        right={() => (sys.link().state === LINK_STATE.linked ? linkSummary(sys) : "")}
      />
    </View>
  );
}
