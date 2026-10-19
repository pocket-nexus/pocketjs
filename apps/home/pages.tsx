// apps/home/pages.tsx — the Settings pages: the root list, Wi-Fi, Mac,
// Apps, General, About and Time Zone. Each page is section data over the
// live system state; the grouped table draws it and the navigation stack
// scrolls, focuses and pushes it.

import { onMount, type Accessor } from "solid-js";
import { getOps } from "@pocketjs/framework/host";
import { offsetText, TIME_ZONES } from "./clock.ts";
import { LINK_PAIRING, LINK_STATE, sizeText, type HomeApp, type HomeSystem } from "./system.ts";
import { appTint } from "./ui/chrome.tsx";
import type { LayerContext, NavStack, PageSpec } from "./ui/nav.tsx";
import { tableContent, type CellIcon, type Section } from "./ui/table.tsx";
import type { Press } from "./ui/touch.ts";

export const HOME_VERSION = "0.1.0";

export const ICONS = {
  wifi: { glyph: "art/wifi.svg", from: "#5aaaf8", to: "#1c62cf" },
  mac: { glyph: "art/laptop.svg", from: "#b4bcc6", to: "#5f6874" },
  apps: { glyph: "art/apps.svg", from: "#c08cf5", to: "#6b33c4" },
  general: { glyph: "art/gear.svg", from: "#a9b0b9", to: "#5b636d" },
  about: { glyph: "art/info.svg", from: "#6db3f6", to: "#2a6ccd" },
  clock: { glyph: "art/clock.svg", from: "#ffad4a", to: "#e2620b" },
  camera: { glyph: "art/camera.svg", from: "#7d8794", to: "#3b434d" },
  store: { glyph: "art/download.svg", from: "#62b6fb", to: "#1460d6" },
} satisfies Record<string, CellIcon>;

export interface PageEnv {
  sys: HomeSystem;
  press: Press;
  keys: Accessor<boolean>;
  /** Confirm a destructive action in an alert. */
  confirm(title: string, message: string, action: string, run: () => void): void;
}

/** One line for the Wi-Fi row and the status bar. */
export function wifiSummary(sys: HomeSystem): string {
  const wifi = sys.wifi();
  if (!wifi) return "Unavailable";
  if (wifi.state === "off") return "Off";
  if (wifi.state === "connecting") return "Connecting...";
  if (wifi.state === "connected") return wifi.ssid || "Connected";
  return "Not Connected";
}

/** One line for the Mac row. */
export function linkSummary(sys: HomeSystem): string {
  const link = sys.link();
  if (!sys.hasLink) return "Unavailable";
  if (link.state === LINK_STATE.linked) return link.companion?.name ?? "Linked";
  if (link.state === LINK_STATE.connecting) return "Connecting...";
  if (link.state === LINK_STATE.searching) return "Searching...";
  return "Not Paired";
}

function table(env: PageEnv, layer: LayerContext, sections: Accessor<Section[]>) {
  return tableContent({ sections, width: 320, press: env.press, focus: layer.focus, keys: env.keys });
}

function rootPage(env: PageEnv, stack: NavStack, layer: LayerContext): PageSpec {
  const { sys } = env;
  return {
    title: () => "Settings",
    content: table(env, layer, () => [
      {
        cells: [
          { id: "settings.wifi", label: "Wi-Fi", value: wifiSummary(sys), icon: ICONS.wifi, accessory: "chevron", run: () => stack.push("wifi") },
          { id: "settings.mac", label: "Mac", value: linkSummary(sys), icon: ICONS.mac, accessory: "chevron", run: () => stack.push("mac") },
        ],
      },
      {
        cells: [
          { id: "settings.apps", label: "Apps", value: String(sys.table().apps.length), icon: ICONS.apps, accessory: "chevron", run: () => stack.push("apps") },
        ],
      },
      {
        cells: [
          { id: "settings.general", label: "General", icon: ICONS.general, accessory: "chevron", run: () => stack.push("general") },
        ],
      },
    ]),
  };
}

const ADD_NETWORK =
  "The console joins only its three saved connections. To add one, open System Settings > Internet Settings > Connection Settings from the HOME Menu.";

function wifiPage(env: PageEnv, _stack: NavStack, layer: LayerContext): PageSpec {
  const { sys } = env;
  return {
    title: () => "Wi-Fi",
    content: table(env, layer, () => {
      const wifi = sys.wifi();
      if (!wifi) {
        return [{ cells: [{ id: "wifi.none", label: "Wi-Fi", value: "Unavailable", tone: "muted" }], footer: "This console does not let apps read its wireless settings." }];
      }
      const on = wifi.state !== "off";
      const sections: Section[] = [
        {
          cells: [{ id: "wifi.toggle", label: "Wi-Fi", accessory: "switch", on, run: () => sys.setWifi(sys.wifi()?.state === "off") }],
          footer: on ? undefined : "Pocket Link, app downloads and the web need Wi-Fi.",
        },
      ];
      if (!on) return sections;
      sections.push({
        header: "Saved Networks",
        cells: wifi.saved.map((saved) => {
          const active = saved.ssid !== "" && wifi.ssid === saved.ssid;
          const label = saved.ssid || `Connection ${saved.slot + 1}`;
          return {
            id: `wifi.slot.${saved.slot}`,
            label,
            detail: saved.ssid ? undefined : "Not set up",
            tone: saved.ssid ? undefined : ("muted" as const),
            accessory: active && wifi.state === "connecting" ? ("spinner" as const) : active ? ("check" as const) : undefined,
            on: active,
            run: saved.ssid ? () => sys.connect(saved.slot) : undefined,
          };
        }),
        footer: wifi.error ? `${wifi.error}. ${ADD_NETWORK}` : ADD_NETWORK,
      });
      if (wifi.state === "connected") {
        sections.push({
          header: "Connection",
          cells: [
            { id: "wifi.network", label: "Network", value: wifi.ssid, accessory: "bars", level: wifi.strength },
            { id: "wifi.address", label: "IP Address", value: wifi.address || "None" },
          ],
        });
      }
      return sections;
    }),
  };
}

function macPage(env: PageEnv, stack: NavStack, layer: LayerContext): PageSpec {
  const { sys } = env;
  return {
    title: () => "Mac",
    content: table(env, layer, () => {
      if (!sys.hasLink) {
        return [{ cells: [{ id: "mac.none", label: "Pocket Link", value: "Unavailable", tone: "muted" }], footer: "This console's runtime has no Pocket Link." }];
      }
      const link = sys.link();
      const companion = link.companion;
      const status =
        link.state === LINK_STATE.linked ? "Linked"
        : link.state === LINK_STATE.connecting ? "Connecting"
        : link.state === LINK_STATE.searching ? "Searching"
        : "Not Paired";
      const footer =
        link.state === LINK_STATE.linked && companion
          ? `Linked to ${companion.name}${companion.address ? ` at ${companion.address}` : ""}. Apps and web requests come through this Mac.`
          : link.state === LINK_STATE.searching
            ? "Looking for a paired Mac on this network. Open Pocket Companion on the Mac."
            : "Pair a Mac to install apps from it and to reach the web through it.";
      const sections: Section[] = [
        {
          cells: [{
            id: "mac.status",
            label: "Status",
            value: status,
            accessory: link.state === LINK_STATE.searching || link.state === LINK_STATE.connecting ? "spinner" : undefined,
          }],
          footer: link.error && link.state !== LINK_STATE.linked ? `${footer} Last error: ${link.error}.` : footer,
        },
      ];
      if (link.paired.length) {
        sections.push({
          header: "Paired Macs",
          cells: link.paired.map((mac) => ({
            id: `mac.paired.${mac.id}`,
            label: mac.name,
            detail: mac.address ? `${mac.address}:${mac.port}` : "Not seen on this network yet",
            accessory: companion?.id === mac.id ? ("check" as const) : undefined,
            on: companion?.id === mac.id,
            button: {
              id: `mac.forget.${mac.id}`,
              label: "Forget",
              tone: "red" as const,
              run: () => env.confirm(`Forget "${mac.name}"?`, "This console will need to scan its code again to link.", "Forget", () => sys.forget(mac.id)),
            },
          })),
        });
      }
      sections.push({ cells: [{ id: "mac.pair", label: link.paired.length ? "Pair Another Mac..." : "Pair a Mac...", tone: "action", run: () => stack.push("scan") }] });
      return sections;
    }),
  };
}

function appsPage(env: PageEnv, _stack: NavStack, layer: LayerContext): PageSpec {
  const { sys } = env;
  const remove = (app: HomeApp) =>
    env.confirm(`Delete "${app.title}"?`, "Deleting this app also deletes its data.", "Delete", () => sys.remove(app));
  return {
    title: () => "Apps",
    content: table(env, layer, () => {
      const apps = sys.table().apps;
      if (apps.length === 0) {
        return [{ cells: [{ id: "apps.none", label: "No Apps Installed", tone: "muted" }], footer: "Install apps from a paired Mac with the Mac icon on the Home screen." }];
      }
      const total = apps.reduce((sum, app) => sum + app.bytes, 0);
      return [
        {
          header: "Installed",
          cells: apps.map((app) => ({
            id: `apps.${app.id}`,
            label: app.title,
            detail: `${app.version ? `Version ${app.version}  ` : ""}${sizeText(app.bytes)}`,
            tile: appTint(app.id, app.title),
            button: { id: `apps.delete.${app.id}`, label: "Delete", tone: "red" as const, run: () => remove(app) },
            run: () => remove(app),
          })),
          footer: `${apps.length} ${apps.length === 1 ? "app uses" : "apps use"} ${sizeText(total)} on the SD card.`,
        },
      ];
    }),
  };
}

function generalPage(env: PageEnv, stack: NavStack, layer: LayerContext): PageSpec {
  const { sys } = env;
  return {
    title: () => "General",
    content: table(env, layer, () => [
      {
        cells: [
          { id: "general.about", label: "About", accessory: "chevron", run: () => stack.push("about") },
          { id: "general.timezone", label: "Time Zone", value: offsetText(sys.offset()), accessory: "chevron", run: () => stack.push("timezone") },
        ],
      },
    ]),
  };
}

/** The runtime the console reports: "3ds-dev, host ABI 11". */
export function runtimeText(): string {
  const ops = getOps() as unknown as { __host?: unknown; __hostAbi?: unknown };
  const host = typeof ops.__host === "string" ? ops.__host : "";
  const abi = typeof ops.__hostAbi === "number" ? ops.__hostAbi : null;
  if (!host) return "PocketJS";
  return abi === null ? host : `${host}, ABI ${abi}`;
}

function aboutPage(env: PageEnv, _stack: NavStack, layer: LayerContext): PageSpec {
  const { sys } = env;
  return {
    title: () => "About",
    content: table(env, layer, () => {
      const link = sys.link();
      const wifi = sys.wifi();
      const device = link.device;
      return [
        {
          cells: [
            { id: "about.name", label: "Name", value: device.name || "Nintendo 3DS" },
            { id: "about.model", label: "Model", value: device.model || "Nintendo 3DS" },
            { id: "about.id", label: "Console ID", value: device.id || "Unknown" },
          ],
        },
        {
          cells: [
            { id: "about.wifi", label: "Wi-Fi", value: wifiSummary(sys) },
            { id: "about.ip", label: "IP Address", value: wifi?.address || device.address || "None" },
            { id: "about.mac", label: "Mac", value: linkSummary(sys) },
          ],
        },
        {
          cells: [
            { id: "about.apps", label: "Apps", value: String(sys.table().apps.length) },
            { id: "about.home", label: "Home", value: HOME_VERSION },
            { id: "about.runtime", label: "Runtime", value: runtimeText() },
          ],
        },
      ];
    }),
  };
}

function timezonePage(env: PageEnv, _stack: NavStack, layer: LayerContext): PageSpec {
  const { sys } = env;
  const content = table(env, layer, () => sys.macClock() ? [
      {
        cells: [{ id: `tz.${sys.offset()}`, label: offsetText(sys.offset()), value: "From the Mac", accessory: "check" as const, on: true }],
        footer: "Home shows the paired Mac's time and time zone. The console's own clock is not used.",
      },
    ] : [
      {
        header: "Offset from UTC",
        cells: TIME_ZONES.map((zone) => ({
          id: `tz.${zone.offset}`,
          label: offsetText(zone.offset),
          value: zone.place,
          accessory: "check" as const,
          on: sys.offset() === zone.offset,
          run: () => sys.setOffset(zone.offset),
        })),
        footer: "No Mac has linked since the console started, so Home shows the console's clock. Pair a Mac to take its time.",
      },
    ]);
  // Open on the zone in use.
  onMount(() => {
    const span = content.span(`tz.${sys.offset()}`);
    if (span) layer.reveal(span[0] - 72, span[1] + 72);
  });
  return { title: () => "Time Zone", backLabel: "Time Zone", content };
}

export const SETTINGS_PAGES: Record<string, (env: PageEnv, stack: NavStack, layer: LayerContext) => PageSpec> = {
  settings: rootPage,
  wifi: wifiPage,
  mac: macPage,
  apps: appsPage,
  general: generalPage,
  about: aboutPage,
  timezone: timezonePage,
};

export { LINK_PAIRING };
