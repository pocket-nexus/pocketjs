// apps/home/top.tsx — the top screen while Settings, the scanner or the Mac
// store holds the touch screen: a header for the current page (icon, title,
// one line of explanation) over a card of the facts that page is about.

import { createMemo, For, Show, type Accessor } from "solid-js";
import { Text, View } from "@pocketjs/framework/components";
import type { LinkCatalogApp } from "@pocketjs/framework/link";
import { civilFromEpoch, dateText, offsetText, statusTime } from "./clock.ts";
import { ICONS, linkSummary, runtimeText, wifiSummary } from "./pages.tsx";
import type { ScanState } from "./scanner.tsx";
import { storeAction } from "./store.tsx";
import { LINK_STATE, sizeText, type HomeSystem } from "./system.ts";
import { appTint, Pinstripes, StatusBar, Tile } from "./ui/chrome.tsx";
import type { CellIcon } from "./ui/table.tsx";
import { ellipsize, FONT, wrap } from "./ui/text.ts";

interface TopInfo {
  icon: CellIcon;
  title: string;
  text: string;
  rows: [string, string][];
  /** Numbered steps instead of rows (the scanner). */
  steps?: string[];
  status?: { text: string; tone: "plain" | "good" | "bad" };
}

function infoFor(page: string, sys: HomeSystem, scan: ScanState): TopInfo {
  const time = civilFromEpoch(sys.now(), sys.offset());
  const link = sys.link();
  const wifi = sys.wifi();
  switch (page) {
    case "wifi":
      return {
        icon: ICONS.wifi,
        title: "Wi-Fi",
        text: "Turn the radio on or off and pick one of the console's saved connections.",
        rows: [
          ["Status", wifiSummary(sys)],
          ["Signal", wifi && wifi.state === "connected" ? `${wifi.strength} of 3 bars` : "None"],
          ["IP Address", wifi?.address || "None"],
        ],
      };
    case "mac":
      return {
        icon: ICONS.mac,
        title: "Mac",
        text: "A paired Mac running Pocket Companion installs apps and carries web requests.",
        rows: [
          ["Status", linkSummary(sys)],
          ["Address", link.companion?.address ? `${link.companion.address}:${link.companion.port}` : "None"],
          ["Paired Macs", String(link.paired.length)],
        ],
      };
    case "apps": {
      const apps = sys.table().apps;
      return {
        icon: ICONS.apps,
        title: "Apps",
        text: "Apps installed on this console from a paired Mac.",
        rows: [
          ["Installed", String(apps.length)],
          ["Storage", sizeText(apps.reduce((sum, app) => sum + app.bytes, 0))],
        ],
      };
    }
    case "general":
      return {
        icon: ICONS.general,
        title: "General",
        text: "This console, its runtime and the time zone Home shows.",
        rows: [
          ["Time Zone", offsetText(sys.offset())],
          ["Runtime", runtimeText()],
        ],
      };
    case "about":
      return {
        icon: ICONS.about,
        title: "About",
        text: "The console's name and model as the Pocket Link reports them.",
        rows: [
          ["Name", link.device.name || "Nintendo 3DS"],
          ["Model", link.device.model || "Nintendo 3DS"],
          ["Runtime", runtimeText()],
        ],
      };
    case "timezone":
      return {
        icon: ICONS.clock,
        title: "Time Zone",
        text: "The console reports no time zone. Home adds this offset to UTC.",
        rows: [
          ["Offset", offsetText(sys.offset())],
          ["Time", statusTime(time)],
          ["Date", dateText(time)],
        ],
      };
    case "scan":
      return {
        icon: ICONS.camera,
        title: "Pair a Mac",
        text: "Pairing shares a key with the Mac; the console links to it on its own after that.",
        rows: [],
        steps: [
          "On your Mac, open Pocket Companion.",
          "Choose Pair a Console... to show a code.",
          "Hold the outer camera up to the code.",
        ],
        status:
          scan.t === "connecting" ? { text: `Connecting to ${scan.name}...`, tone: "plain" }
          : scan.t === "paired" ? { text: `Paired with ${scan.name}.`, tone: "good" }
          : scan.t === "failed" ? { text: scan.message, tone: "bad" }
          : scan.t === "unavailable" ? { text: "The camera did not start.", tone: "bad" }
          : scan.hint ? { text: scan.hint, tone: "bad" }
          : { text: "Scanning...", tone: "plain" },
      };
    default:
      return {
        icon: ICONS.general,
        title: "Settings",
        text: "Wi-Fi, the paired Mac, installed apps and this console.",
        rows: [
          ["Wi-Fi", wifiSummary(sys)],
          ["Mac", linkSummary(sys)],
          ["Apps", String(sys.table().apps.length)],
          ["Time", `${statusTime(time)}  ${offsetText(sys.offset())}`],
        ],
      };
  }
}

export function SettingsTop(props: { page: Accessor<string>; sys: HomeSystem; scan: Accessor<ScanState> }) {
  const time = createMemo(() => civilFromEpoch(props.sys.now(), props.sys.offset()));
  const info = createMemo(() => infoFor(props.page(), props.sys, props.scan()));
  const lines = () => wrap(info().text, FONT.sm, 290, 2);
  return (
    <View class="relative w-full h-full overflow-hidden bg-[#c9d0d8]">
      <Pinstripes width={400} height={240} />
      <Tile x={22} y={30} size={58} from={info().icon.from} to={info().icon.to} glyph={info().icon.glyph} shadow />
      <Text class="absolute left-[96] top-[31] text-2xl text-[#ffffffc0] font-bold">{info().title}</Text>
      <Text class="absolute left-[96] top-[30] text-2xl text-[#2c3a50] font-bold">{info().title}</Text>
      <For each={lines()}>
        {(line, index) => <Text class="absolute left-[96] text-sm text-[#4c566c]" style={{ insetT: 60 + index() * 17 }}>{line}</Text>}
      </For>
      <Show when={info().rows.length}>
        <View class="absolute left-[16] w-[368] rounded-[8] bg-[#ffffff90]" style={{ insetT: 107, height: info().rows.length * 28 }} />
        <View class="absolute left-[16] top-[106] w-[368] rounded-[8] border border-[#abb1b9] bg-white" style={{ height: info().rows.length * 28 }}>
          <For each={info().rows}>
            {(row, index) => (
              <>
                <Show when={index() > 0}>
                  <View class="absolute left-0 w-[368] h-[1] bg-[#d9dce0]" style={{ insetT: index() * 28 }} />
                </Show>
                <Text class="absolute left-[12] text-sm text-black font-bold" style={{ insetT: index() * 28 + 5 }}>{row[0]}</Text>
                <Text class="absolute left-[120] w-[236] text-sm text-[#385487] text-right" style={{ insetT: index() * 28 + 5 }}>
                  {ellipsize(row[1], FONT.sm, 236)}
                </Text>
              </>
            )}
          </For>
        </View>
      </Show>
      <Show when={info().steps}>
        {(steps) => (
          <For each={steps()}>
            {(step, index) => (
              <>
                <View class="absolute left-[24] w-[22] h-[22] rounded-[11] bg-gradient-to-b from-[#5aaaf8] to-[#1c62cf]" style={{ insetT: 108 + index() * 30 }} />
                <Text class="absolute left-[24] w-[22] text-sm text-white font-bold text-center" style={{ insetT: 110 + index() * 30 }}>{String(index() + 1)}</Text>
                <Text class="absolute left-[56] text-sm text-[#2c3a50] font-bold" style={{ insetT: 110 + index() * 30 }}>{step}</Text>
              </>
            )}
          </For>
        )}
      </Show>
      <Show when={info().status}>
        {(status) => (
          <>
            <View
              class={status().tone === "good"
                ? "absolute left-[16] top-[204] w-[368] h-[26] rounded-[13] bg-[#3a9d3a]"
                : status().tone === "bad"
                  ? "absolute left-[16] top-[204] w-[368] h-[26] rounded-[13] bg-[#b3261e]"
                  : "absolute left-[16] top-[204] w-[368] h-[26] rounded-[13] bg-[#4c566c]"}
            />
            <Text class="absolute left-[16] top-[208] w-[368] text-sm text-white font-bold text-center">{ellipsize(status().text, FONT.smBold, 350)}</Text>
          </>
        )}
      </Show>
      <StatusBar
        width={400}
        carrier="Pocket"
        opaque
        bars={() => {
          const wifi = props.sys.wifi();
          return !wifi || wifi.state === "off" ? -1 : wifi.state === "connected" ? wifi.strength : 0;
        }}
        time={() => statusTime(time())}
        right={() => (props.sys.link().state === LINK_STATE.linked ? linkSummary(props.sys) : "")}
      />
    </View>
  );
}

/** The top screen over the Mac store: the Mac, and the selected app. */
export function StoreTop(props: { sys: HomeSystem; selected: Accessor<string> }) {
  const { sys } = props;
  const time = createMemo(() => civilFromEpoch(sys.now(), sys.offset()));
  const app = (): LinkCatalogApp | null => {
    const list = sys.catalog();
    return list.find((entry) => entry.id === props.selected()) ?? list[0] ?? null;
  };
  const macName = () => (sys.link().state === LINK_STATE.linked ? sys.link().companion?.name ?? "Mac" : "Mac");
  const offered = () => {
    if (sys.link().state !== LINK_STATE.linked) return "Not linked. Pair a Mac in Settings > Mac.";
    if (sys.catalogState() !== "ready") return "Asking the Mac for its apps...";
    const count = sys.catalog().length;
    return `${count} ${count === 1 ? "app" : "apps"} offered for this console`;
  };
  const status = () => {
    const current = app();
    if (!current) return "";
    const install = sys.installs()[current.id];
    const action = storeAction(current, sys.table().apps, install);
    if (action === "installing" && install) return `Installing... ${Math.round((100 * install.received) / Math.max(1, install.bytes))}%`;
    if (action === "retry") return `Install failed: ${install?.error ?? ""}`;
    if (action === "open") return "Installed. Press A to open it.";
    if (action === "update") return "An update is available. Press A to install it.";
    return "Not installed. Press A to get it.";
  };
  return (
    <View class="relative w-full h-full overflow-hidden bg-[#c9d0d8]">
      <Pinstripes width={400} height={240} />
      <Tile x={18} y={26} size={36} from={ICONS.mac.from} to={ICONS.mac.to} glyph={ICONS.mac.glyph} shadow />
      <Text class="absolute left-[64] top-[26] text-lg text-[#ffffffc0] font-bold">{ellipsize(macName(), FONT.lgBold, 320)}</Text>
      <Text class="absolute left-[64] top-[25] text-lg text-[#2c3a50] font-bold">{ellipsize(macName(), FONT.lgBold, 320)}</Text>
      <Text class="absolute left-[64] top-[46] text-xs text-[#4c566c]">{offered()}</Text>
      <Show
        when={app()}
        fallback={
          <>
            <View class="absolute left-[12] top-[83] w-[376] h-[96] rounded-[10] bg-[#ffffff90]" />
            <View class="absolute left-[12] top-[82] w-[376] h-[96] rounded-[10] border border-[#abb1b9] bg-white" />
            <Text class="absolute left-[28] top-[94] text-base text-[#2c3a50] font-bold">Apps from your Mac</Text>
            <Text class="absolute left-[28] top-[118] text-sm text-[#4c566c]">Pocket Companion on a paired Mac offers apps built</Text>
            <Text class="absolute left-[28] top-[135] text-sm text-[#4c566c]">for this console. Get one and it joins the Home screen;</Text>
            <Text class="absolute left-[28] top-[152] text-sm text-[#4c566c]">a newer version on the Mac shows UPDATE.</Text>
          </>
        }
      >
        {(current) => {
          const tint = () => appTint(current().id, current().title);
          const summary = () => wrap(current().summary || "No description.", FONT.sm, 330, 3);
          return (
            <>
              <View class="absolute left-[12] top-[74] w-[376] h-[156] rounded-[10] bg-[#ffffff90]" />
              <View class="absolute left-[12] top-[73] w-[376] h-[156] rounded-[10] border border-[#abb1b9] bg-white" />
              <Tile x={26} y={86} size={56} from={tint().from} to={tint().to} letters={tint().letters} shadow />
              <Text class="absolute left-[96] top-[88] text-xl text-black font-bold">{ellipsize(current().title, FONT.xlBold, 280)}</Text>
              <Text class="absolute left-[96] top-[114] text-xs text-[#6d7584]">{`Version ${current().version}  ${sizeText(current().bytes)}  ${current().id}`}</Text>
              <For each={summary()}>
                {(line, index) => <Text class="absolute left-[26] text-sm text-[#2c3a50]" style={{ insetT: 152 + index() * 17 }}>{line}</Text>}
              </For>
              <View class="absolute left-[12] top-[204] w-[376] h-[1] bg-[#d9dce0]" />
              <Text class="absolute left-[26] top-[209] text-xs text-[#385487] font-bold">{ellipsize(status(), FONT.xsBold, 350)}</Text>
            </>
          );
        }}
      </Show>
      <StatusBar
        width={400}
        carrier="Pocket"
        opaque
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
