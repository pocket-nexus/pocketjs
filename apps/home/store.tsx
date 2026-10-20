// apps/home/store.tsx — the Mac: the apps the linked Mac offers this
// console, as an App Store list. Each row's pill reads GET, UPDATE or OPEN
// and turns into a progress bar while the package streams in; tapping the
// rest of a row opens the app's page (icon, version, size, description).

import { createMemo, For, Show, type Accessor } from "solid-js";
import { Text, View } from "@pocketjs/framework/components";
import { ClassicSpinner } from "@pocketjs/framework/classic";
import type { LinkCatalogApp } from "@pocketjs/framework/link";
import { LINK_STATE, sizeText, type HomeSystem, type Install } from "./system.ts";
import { appTint, Tile } from "./ui/chrome.tsx";
import type { NavButton } from "./ui/bar.tsx";
import type { LayerContext, NavStack, PageSpec } from "./ui/nav.tsx";
import { tableContent } from "./ui/table.tsx";
import { ellipsize, FONT, wrap } from "./ui/text.ts";
import type { Press, Target } from "./ui/touch.ts";
import { ICONS } from "./pages.tsx";

const ROW = 56;
const LEFT = 9;
const WIDTH = 320 - LEFT * 2;
const TOP = 10;
const PILL_W = 64;
const FOOTER_H = 26;

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
}

/** Start what an app's pill offers: open it, or install it. */
function act(sys: HomeSystem, app: LinkCatalogApp): void {
  const action = storeAction(app, sys.table().apps, sys.installs()[app.id]);
  if (action === "open") sys.launch(app.output);
  else if (action !== "installing") sys.install(app);
}

const PILL_LABEL: Record<StoreAction, string> = { get: "GET", update: "UPDATE", open: "OPEN", installing: "", retry: "RETRY" };

/** An app's GET / UPDATE / OPEN / RETRY pill, or its progress bar while it installs. */
function Pill(props: { app: LinkCatalogApp; sys: HomeSystem; press: Press; id: string; x: number; y: number; w: number }) {
  const { sys, app } = props;
  const action = () => storeAction(app, sys.table().apps, sys.installs()[app.id]);
  const install = () => sys.installs()[app.id];
  const lit = () => props.press.is(props.id);
  return (
    <Show
      when={action() !== "installing"}
      fallback={
        <>
          <View class="absolute h-[8] rounded-[4] border border-[#8f98a5] bg-[#e7eaee]" style={{ insetL: props.x, insetT: props.y + 8, width: props.w }} />
          <View
            class="absolute h-[6] rounded-[3] bg-gradient-to-b from-[#7fb4f7] to-[#2b6ed6]"
            style={{
              insetL: props.x + 1,
              insetT: props.y + 9,
              width: Math.max(6, Math.round((props.w - 2) * ((install()?.received ?? 0) / Math.max(1, install()?.bytes ?? 1)))),
            }}
          />
        </>
      }
    >
      <View
        class={action() === "update"
          ? lit()
            ? "absolute h-[24] rounded-[5] border border-[#163f86] bg-gradient-to-b from-[#2d5fb8] to-[#1b4592]"
            : "absolute h-[24] rounded-[5] border border-[#1f4f9f] bg-gradient-to-b from-[#73a8f2] via-[#3f7ddc] to-[#2c66cc]"
          : lit()
            ? "absolute h-[24] rounded-[5] border border-[#6f7680] bg-gradient-to-b from-[#9aa1ab] to-[#bfc5cc]"
            : "absolute h-[24] rounded-[5] border border-[#a2a8b0] bg-gradient-to-b from-[#ffffff] to-[#dde1e6]"}
        style={{ insetL: props.x, insetT: props.y, width: props.w }}
      />
      <Text
        class={action() === "update" ? "absolute text-xs text-white font-bold text-center" : action() === "retry" ? "absolute text-xs text-[#c4241b] font-bold text-center" : "absolute text-xs text-[#2a5db0] font-bold text-center"}
        style={{ insetL: props.x, insetT: props.y + 5, width: props.w }}
      >
        {PILL_LABEL[action()]}
      </Text>
    </Show>
  );
}

function StoreRow(props: { app: LinkCatalogApp; index: number; env: StoreEnv; lit: Accessor<boolean> }) {
  const { sys, press } = props.env;
  const app = props.app;
  const y = props.index * ROW;
  const tint = appTint(app.id, app.title);
  const action = () => storeAction(app, sys.table().apps, sys.installs()[app.id]);
  const install = () => sys.installs()[app.id];
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
      <Tile x={8} y={y + 8} size={40} {...tint} dim={() => press.is(`store.row.${app.id}`)} />
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
      <Pill app={app} sys={sys} press={press} id={`store.pill.${app.id}`} x={WIDTH - PILL_W - 8} y={y + 16} w={PILL_W} />
    </>
  );
}

function EmptyState(props: { title: string; message: string; button?: { id: string; label: string }; press: Press; spinner?: boolean }) {
  return (
    <>
      <Show when={props.spinner} fallback={<Tile x={136} y={22} size={48} art={ICONS.mac.art} />}>
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
  const details = (app: LinkCatalogApp) => stack.push(`store.app:${app.id}`);
  const emptyButton = (): { id: string; label: string; run: () => void } | undefined => {
    const now = mode();
    if (now === "unpaired" || now === "searching") return { id: "store.settings", label: "Mac Settings", run: () => stack.push("mac") };
    if (now === "error") return { id: "store.retry", label: "Try Again", run: () => sys.loadCatalog() };
    return undefined;
  };
  const offered = () => {
    const count = apps().length;
    return `${count} ${count === 1 ? "app" : "apps"} offered by ${sys.link().companion?.name ?? "this Mac"}`;
  };
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
          <Text class="absolute left-0 w-[320] text-xs text-[#ffffffb0] text-center" style={{ insetT: TOP + apps().length * ROW + 9 }}>{ellipsize(offered(), FONT.xs, 300)}</Text>
          <Text class="absolute left-0 w-[320] text-xs text-[#4c566c] text-center" style={{ insetT: TOP + apps().length * ROW + 8 }}>{ellipsize(offered(), FONT.xs, 300)}</Text>
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
      height: () => (mode() === "list" ? TOP * 2 + apps().length * ROW + FOOTER_H : 200),
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
          out.push({ id: `store.row.${app.id}`, x: LEFT, y, w: WIDTH, h: ROW, run: () => details(app) });
          out.push({ id: `store.pill.${app.id}`, x: LEFT + WIDTH - PILL_W - 14, y, w: PILL_W + 14, h: ROW, run: () => act(sys, app) });
        });
        return out;
      },
      span(id) {
        const index = apps().findIndex((app) => `store.row.${app.id}` === id);
        return index < 0 ? null : [TOP + index * ROW, TOP + (index + 1) * ROW];
      },
      activate(id) {
        const app = apps().find((entry) => `store.row.${entry.id}` === id);
        if (app) details(app);
        else emptyButton()?.run();
      },
    },
  };
}

// ---- an app's page ----------------------------------------------------------------

const DETAIL_ICON = 64;
const DETAIL_TEXT_X = 88;
const DETAIL_HEAD_H = 92;
const DETAIL_BUTTON_W = 78;
const DESCRIPTION_LINE = 17;

/** One offered app: its icon, title, version and size, the GET / OPEN /
 *  UPDATE button, its description and an Information table. */
export function storeAppPage(env: StoreEnv, appId: string, _stack: NavStack, layer: LayerContext): PageSpec {
  const { sys, press } = env;
  const app = () => sys.catalog().find((entry) => entry.id === appId) ?? null;
  const description = createMemo(() => wrap(app()?.summary || "No description.", FONT.sm, WIDTH - 24));
  const descriptionY = DETAIL_HEAD_H + 26;
  const descriptionH = () => 10 + description().length * DESCRIPTION_LINE + 8;
  const infoY = () => descriptionY + descriptionH() + 4;
  const meta = () => {
    const current = app();
    if (!current) return "";
    const install = sys.installs()[current.id];
    if (install?.error) return ellipsize(install.error, FONT.xs, 320 - DETAIL_TEXT_X - 10);
    if (install && !install.done) return `Installing  ${sizeText(install.received)} of ${sizeText(install.bytes)}`;
    return `Version ${current.version}  ${sizeText(current.bytes)}`;
  };
  const info = tableContent({
    sections: () => {
      const current = app();
      if (!current) return [];
      const installed = sys.table().apps.find((entry) => entry.id === current.id);
      return [
        {
          header: "Information",
          cells: [
            { id: "store.info.version", label: "Version", value: current.version },
            { id: "store.info.size", label: "Size", value: sizeText(current.bytes) },
            { id: "store.info.installed", label: "Installed", value: installed ? `Version ${installed.version || "?"}` : "No" },
            { id: "store.info.id", label: "Identifier", value: current.id },
          ],
        },
      ];
    },
    width: 320,
    press,
    focus: layer.focus,
    keys: env.keys,
  });
  const buttonId = `store.get.${appId}`;
  const run = () => {
    const current = app();
    if (current) act(sys, current);
  };

  return {
    title: () => app()?.title ?? "App",
    content: {
      view: () => (
        <Show
          when={app()}
          fallback={<Text class="absolute left-0 top-[80] w-[320] text-sm text-[#4c566c] font-bold text-center">The Mac no longer offers this app.</Text>}
        >
          {(current) => {
            const tint = appTint(current().id, current().title);
            return (
              <>
                <Tile x={12} y={12} size={DETAIL_ICON} {...tint} />
                <Text class="absolute text-lg text-[#ffffffb0] font-bold" style={{ insetL: DETAIL_TEXT_X, insetT: 13 }}>{ellipsize(current().title, FONT.lgBold, 320 - DETAIL_TEXT_X - 10)}</Text>
                <Text class="absolute text-lg text-black font-bold" style={{ insetL: DETAIL_TEXT_X, insetT: 12 }}>{ellipsize(current().title, FONT.lgBold, 320 - DETAIL_TEXT_X - 10)}</Text>
                <Text class="absolute text-xs text-[#4f5663]" style={{ insetL: DETAIL_TEXT_X, insetT: 34 }}>{ellipsize(sys.link().companion?.name ?? "Mac", FONT.xs, 320 - DETAIL_TEXT_X - 10)}</Text>
                <Text class={sys.installs()[current().id]?.error ? "absolute text-xs text-[#c4241b]" : "absolute text-xs text-[#6d7584]"} style={{ insetL: DETAIL_TEXT_X, insetT: 49 }}>{meta()}</Text>
                <Pill app={current()} sys={sys} press={press} id={buttonId} x={DETAIL_TEXT_X} y={64 - 2} w={DETAIL_BUTTON_W} />
                <Text class="absolute left-[18] text-sm text-[#ffffffb0] font-bold" style={{ insetT: DETAIL_HEAD_H + 5 }}>Description</Text>
                <Text class="absolute left-[18] text-sm text-[#4c566c] font-bold" style={{ insetT: DETAIL_HEAD_H + 4 }}>Description</Text>
                <View class="absolute rounded-[8] border border-[#abb1b9] bg-white" style={{ insetL: LEFT, insetT: descriptionY, width: WIDTH, height: descriptionH() }} />
                <Text class="absolute text-sm text-[#2c3a50] leading-[17]" style={{ insetL: LEFT + 12, insetT: descriptionY + 10 }}>{description().join("\n")}</Text>
                <View class="absolute left-0 w-[320]" style={{ insetT: infoY() }}>{info.view()}</View>
              </>
            );
          }}
        </Show>
      ),
      height: () => infoY() + info.height(),
      focusOrder: () => (app() ? [buttonId] : []),
      targets(top, offset) {
        if (!app()) return [];
        return [{ id: buttonId, x: DETAIL_TEXT_X - 6, y: top + 56 - offset, w: DETAIL_BUTTON_W + 12, h: 36, run }];
      },
      span: (id) => (id === buttonId ? [0, DETAIL_HEAD_H] : null),
      activate: (id) => id === buttonId && run(),
    },
  };
}
