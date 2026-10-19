// apps/home/store.tsx — the Mac: the apps the linked Mac offers this
// console, as an App Store list. Each row's pill reads GET, UPDATE or OPEN
// and turns into a progress bar while the package streams in.

import { createEffect, For, Show, type Accessor } from "solid-js";
import { Text, View } from "@pocketjs/framework/components";
import { ClassicSpinner } from "@pocketjs/framework/classic";
import type { LinkCatalogApp } from "@pocketjs/framework/link";
import { LINK_STATE, sizeText, type HomeSystem, type Install } from "./system.ts";
import { appTint, Tile } from "./ui/chrome.tsx";
import type { NavButton } from "./ui/bar.tsx";
import type { LayerContext, NavStack, PageSpec } from "./ui/nav.tsx";
import { ellipsize, FONT } from "./ui/text.ts";
import type { Press, Target } from "./ui/touch.ts";
import { ICONS } from "./pages.tsx";

const ROW = 56;
const LEFT = 9;
const WIDTH = 320 - LEFT * 2;
const TOP = 10;
const PILL_W = 64;

export type StoreAction = "get" | "update" | "open" | "installing" | "retry";

/** What a catalog row's pill offers, given the installed table. */
export function storeAction(app: LinkCatalogApp, installed: readonly { id: string; version: string }[], install: Install | undefined): StoreAction {
  if (install && !install.done && !install.error) return "installing";
  if (install?.error) return "retry";
  const have = installed.find((entry) => entry.id === app.id);
  if (!have) return "get";
  return have.version === app.version ? "open" : "update";
}

export interface StoreEnv {
  sys: HomeSystem;
  press: Press;
  keys: Accessor<boolean>;
  /** The row the top screen describes. */
  selected: Accessor<string>;
  select(id: string): void;
}

function StoreRow(props: { app: LinkCatalogApp; index: number; env: StoreEnv; lit: Accessor<boolean> }) {
  const { sys, press } = props.env;
  const app = props.app;
  const y = props.index * ROW;
  const tint = appTint(app.id, app.title);
  const action = () => storeAction(app, sys.table().apps, sys.installs()[app.id]);
  const install = () => sys.installs()[app.id];
  const pillLit = () => press.is(`store.pill.${app.id}`);
  const label = () => ({ get: "GET", update: "UPDATE", open: "OPEN", installing: "", retry: "RETRY" })[action()];
  const meta = () => {
    const state = install();
    if (state?.error) return ellipsize(state.error, FONT.xs, WIDTH - 60 - PILL_W);
    if (action() === "installing" && state) return `Installing  ${sizeText(state.received)} of ${sizeText(state.bytes)}`;
    return `Version ${app.version}  ${sizeText(app.bytes)}`;
  };
  return (
    <>
      <View class={props.lit() ? "absolute bg-gradient-to-b from-[#058cf5] to-[#015ee6]" : "hidden"} style={{ insetL: 0, insetT: y, width: WIDTH, height: ROW }} />
      <View class="absolute h-[1] bg-[#d9dce0]" style={{ insetL: 54, insetT: y + ROW - 1, width: WIDTH - 54 }} />
      <Tile x={8} y={y + 8} size={40} from={tint.from} to={tint.to} letters={tint.letters} shadow dim={() => press.is(`store.row.${app.id}`)} />
      <Text class={props.lit() ? "absolute text-sm text-white font-bold" : "absolute text-sm text-black font-bold"} style={{ insetL: 56, insetT: y + 5 }}>
        {ellipsize(app.title, FONT.smBold, WIDTH - 60 - PILL_W - 8)}
      </Text>
      <Text class={props.lit() ? "absolute text-xs text-white" : "absolute text-xs text-[#4f5663]"} style={{ insetL: 56, insetT: y + 22 }}>
        {ellipsize(app.summary || "No description", FONT.xs, WIDTH - 60 - PILL_W - 8)}
      </Text>
      <Text
        class={install()?.error ? "absolute text-xs text-[#c4241b]" : props.lit() ? "absolute text-xs text-[#d8e8ff]" : "absolute text-xs text-[#8a9099]"}
        style={{ insetL: 56, insetT: y + 37 }}
      >
        {meta()}
      </Text>
      <Show
        when={action() !== "installing"}
        fallback={
          <>
            <View class="absolute h-[8] rounded-[4] border border-[#8f98a5] bg-[#e7eaee]" style={{ insetL: WIDTH - PILL_W - 8, insetT: y + 24, width: PILL_W }} />
            <View
              class="absolute h-[6] rounded-[3] bg-gradient-to-b from-[#7fb4f7] to-[#2b6ed6]"
              style={{
                insetL: WIDTH - PILL_W - 7,
                insetT: y + 25,
                width: Math.max(6, Math.round((PILL_W - 2) * ((install()?.received ?? 0) / Math.max(1, install()?.bytes ?? 1)))),
              }}
            />
          </>
        }
      >
        <View
          class={action() === "update"
            ? pillLit()
              ? "absolute h-[24] rounded-[5] border border-[#163f86] bg-gradient-to-b from-[#2d5fb8] to-[#1b4592]"
              : "absolute h-[24] rounded-[5] border border-[#1f4f9f] bg-gradient-to-b from-[#73a8f2] via-[#3f7ddc] to-[#2c66cc]"
            : pillLit()
              ? "absolute h-[24] rounded-[5] border border-[#6f7680] bg-gradient-to-b from-[#9aa1ab] to-[#bfc5cc]"
              : "absolute h-[24] rounded-[5] border border-[#a2a8b0] bg-gradient-to-b from-[#ffffff] to-[#dde1e6]"}
          style={{ insetL: WIDTH - PILL_W - 8, insetT: y + 16, width: PILL_W }}
        />
        <Text
          class={action() === "update" ? "absolute text-xs text-white font-bold text-center" : action() === "retry" ? "absolute text-xs text-[#c4241b] font-bold text-center" : "absolute text-xs text-[#2a5db0] font-bold text-center"}
          style={{ insetL: WIDTH - PILL_W - 8, insetT: y + 21, width: PILL_W }}
        >
          {label()}
        </Text>
      </Show>
    </>
  );
}

function EmptyState(props: { title: string; message: string; button?: { id: string; label: string }; press: Press; spinner?: boolean }) {
  return (
    <>
      <Show when={props.spinner} fallback={<Tile x={136} y={22} size={48} from={ICONS.mac.from} to={ICONS.mac.to} glyph={ICONS.mac.glyph} shadow />}>
        <View class="absolute left-[149] top-[36]">
          <ClassicSpinner size={22} color={"#6d7584"} />
        </View>
      </Show>
      <Text class="absolute left-0 top-[80] w-[320] text-base text-[#ffffffb0] font-bold text-center">{props.title}</Text>
      <Text class="absolute left-0 top-[79] w-[320] text-base text-[#4c566c] font-bold text-center">{props.title}</Text>
      <For each={props.message.split("\n")}>
        {(line, index) => (
          <Text class="absolute left-[20] w-[280] text-xs text-[#5d6677] text-center" style={{ insetT: 104 + index() * 15 }}>{line}</Text>
        )}
      </For>
      <Show when={props.button}>
        {(button) => (
          <>
            <View
              class={props.press.is(button().id)
                ? "absolute left-[90] top-[150] w-[140] h-[30] rounded-[6] border border-[#6f7680] bg-gradient-to-b from-[#9aa1ab] to-[#bfc5cc]"
                : "absolute left-[90] top-[150] w-[140] h-[30] rounded-[6] border border-[#9aa1aa] bg-gradient-to-b from-[#ffffff] to-[#dde1e6]"}
            />
            <Text class="absolute left-[90] top-[157] w-[140] text-sm text-[#385487] font-bold text-center">{button().label}</Text>
          </>
        )}
      </Show>
    </>
  );
}

export function storePage(env: StoreEnv, stack: NavStack, layer: LayerContext): PageSpec {
  const { sys, press } = env;
  const apps = () => sys.catalog();
  const mode = (): "unavailable" | "unpaired" | "searching" | "loading" | "error" | "empty" | "list" => {
    if (!sys.hasLink) return "unavailable";
    const link = sys.link();
    if (link.state === LINK_STATE.unpaired) return "unpaired";
    if (link.state !== LINK_STATE.linked) return "searching";
    const state = sys.catalogState();
    if (state === "error") return "error";
    if (state !== "ready") return "loading";
    return apps().length ? "list" : "empty";
  };
  const act = (app: LinkCatalogApp) => {
    env.select(app.id);
    const action = storeAction(app, sys.table().apps, sys.installs()[app.id]);
    if (action === "open") sys.launch(app.output);
    else if (action !== "installing") sys.install(app);
  };
  const emptyButton = (): { id: string; label: string; run: () => void } | undefined => {
    const now = mode();
    if (now === "unpaired" || now === "searching") return { id: "store.settings", label: "Mac Settings", run: () => stack.push("mac") };
    if (now === "error") return { id: "store.retry", label: "Try Again", run: () => sys.loadCatalog() };
    return undefined;
  };
  // The d-pad focus is the selection the top screen describes.
  createEffect(() => {
    const focused = layer.focus();
    if (focused.startsWith("store.row.")) env.select(focused.slice("store.row.".length));
  });
  const reload: NavButton = { id: "store.reload", label: "Reload", kind: "plain", run: () => sys.loadCatalog() };

  return {
    title: () => (sys.link().state === LINK_STATE.linked ? sys.link().companion?.name ?? "Mac" : "Mac"),
    backLabel: "Mac",
    right: () => (mode() === "list" || mode() === "empty" ? reload : null),
    content: {
      view: () => (
        <Show
          when={mode() === "list"}
          fallback={
            <EmptyState
              press={press}
              spinner={mode() === "loading" || mode() === "searching"}
              title={{
                unavailable: "No Pocket Link",
                unpaired: "No Mac Paired",
                searching: "Looking for Your Mac",
                loading: "Loading",
                error: "Could Not Load Apps",
                empty: "No Apps Offered",
                list: "",
              }[mode()]}
              message={{
                unavailable: "This console's runtime has no Pocket Link.",
                unpaired: "Pair a Mac in Settings > Mac to install\nthe apps it offers this console.",
                searching: `Open Pocket Companion on ${sys.link().companion?.name ?? "your Mac"}.\nThe console links when it hears the Mac.`,
                loading: "Asking the Mac for its apps...",
                error: sys.catalogError() || "The Mac did not answer.",
                empty: "Add a Pocket app to Pocket Companion\non the Mac and it appears here.",
                list: "",
              }[mode()]}
              button={emptyButton()}
            />
          }
        >
          <View class="absolute rounded-[8] border border-[#abb1b9] bg-white" style={{ insetL: LEFT, insetT: TOP, width: WIDTH, height: apps().length * ROW }}>
            <For each={apps()}>
              {(app, index) => (
                <StoreRow
                  app={app}
                  index={index()}
                  env={env}
                  lit={() => press.is(`store.row.${app.id}`) || (env.keys() && layer.focus() === `store.row.${app.id}`)}
                />
              )}
            </For>
          </View>
        </Show>
      ),
      height: () => (mode() === "list" ? TOP * 2 + apps().length * ROW : 200),
      focusOrder: () => (mode() === "list" ? apps().map((app) => `store.row.${app.id}`) : emptyButton() ? [emptyButton()!.id] : []),
      targets(top, offset, bottom) {
        const out: Target[] = [];
        if (mode() !== "list") {
          const button = emptyButton();
          if (button) out.push({ id: button.id, x: 90, y: top + 150 - offset, w: 140, h: 30, run: button.run });
          return out;
        }
        apps().forEach((app, index) => {
          const y = top + TOP + index * ROW - offset;
          if (y + ROW <= top || y >= bottom) return;
          out.push({ id: `store.row.${app.id}`, x: LEFT, y, w: WIDTH, h: ROW, run: () => env.select(app.id) });
          out.push({ id: `store.pill.${app.id}`, x: LEFT + WIDTH - PILL_W - 14, y, w: PILL_W + 14, h: ROW, run: () => act(app) });
        });
        return out;
      },
      span(id) {
        const index = apps().findIndex((app) => `store.row.${app.id}` === id);
        return index < 0 ? null : [TOP + index * ROW, TOP + (index + 1) * ROW];
      },
      activate(id) {
        const app = apps().find((entry) => `store.row.${entry.id}` === id);
        if (app) act(app);
        else emptyButton()?.run();
      },
    },
  };
}
