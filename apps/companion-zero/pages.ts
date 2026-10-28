// The pages: the Mac app's (tools/companion/macos/PocketCompanion.swift) for
// a 320x170 panel with a keyboard. A page is a column of blocks; the
// buttons and the rows with an action are what the arrows move between.
// Links open on a phone: their button shows the URL as a QR code.

import type { Companion, Install, Status } from "./control.ts";
import { bytes, toAscii, when } from "./text.ts";

export type Page = "start" | "consoles" | "applets" | "x" | "discord" | "youtube" | "assistant" | "settings";

export const PAGES: readonly { id: Page; title: string }[] = [
  { id: "start", title: "Get Started" },
  { id: "consoles", title: "Consoles" },
  { id: "applets", title: "Applets" },
  { id: "x", title: "X" },
  { id: "discord", title: "Discord" },
  { id: "youtube", title: "YouTube" },
  { id: "assistant", title: "Assistant" },
  { id: "settings", title: "Settings" },
];

const STUDIO = {
  shell: "https://studio.pocket.nexus/apps/shell",
  companion: "https://studio.pocket.nexus/apps/companion",
  discordPortal: "https://discord.com/developers/applications",
  codex: "https://developers.openai.com/codex/cli",
};

export type Tone = "ink" | "dim" | "ok" | "warn";

export interface Button {
  label: string;
  press: () => void;
}

export type Block =
  | { kind: "title"; text: string; line: string }
  | { kind: "text"; text: string; tone?: Tone; small?: boolean; indent?: boolean }
  | { kind: "state"; on: boolean; text: string }
  | { kind: "step"; number: number; done: boolean; title: string; text: string }
  | { kind: "item"; title: string; detail: string; dot: Tone; press?: () => void }
  | { kind: "buttons"; buttons: Button[]; indent?: boolean }
  | { kind: "pairs"; rows: [string, string][] }
  | { kind: "progress"; value: number };

/** What the screen does for a page's buttons beyond the companion's commands. */
export interface Screen {
  go(page: Page): void;
  /** Show `url` as a QR code to open on a phone. */
  link(title: string, url: string): void;
  pair(): void;
  confirm(title: string, text: string, action: string, run: () => void): void;
}

/** The dot after a page's name in the sidebar: set up, needs setting up, or
 *  nothing to say. */
export function pageDot(page: Page, companion: Companion): Tone | null {
  const status = companion.status();
  const services = companion.services()?.services;
  switch (page) {
    case "start":
    case "applets":
    case "settings":
      return null;
    case "consoles":
      return status && status.consoles.length > 0 ? "ok" : null;
    case "x":
      return services?.x ? (services.x.signedIn ? "ok" : "warn") : null;
    case "discord":
      return services?.discord ? (services.discord.configured && !services.discord.error ? "ok" : "warn") : null;
    case "youtube":
      return services?.youtube ? (services.youtube.ready ? "ok" : "warn") : null;
    case "assistant":
      return companion.services() ? (companion.services()!.agent.on ? "ok" : null) : null;
  }
}

const SERVICE_PAGES: Record<string, { title: string; page: Page }> = {
  x: { title: "X", page: "x" },
  discord: { title: "Discord", page: "discord" },
  youtube: { title: "YouTube", page: "youtube" },
};

const consoleName = (console: { name: string; id: string }) => toAscii(console.name || console.id);

function noteBlocks(companion: Companion): Block[] {
  const busy = companion.busy();
  if (busy) return [{ kind: "text", text: `${busy}...`, tone: "dim" }];
  const note = companion.note();
  return note ? [{ kind: "text", text: note.text, tone: note.failed ? "warn" : "ok" }] : [];
}

function waiting(): Block[] {
  return [{ kind: "text", text: "Asking Pocket Companion...", tone: "dim" }];
}

/** The page while the companion does not answer. */
function downBlocks(companion: Companion): Block[] {
  return [
    { kind: "title", text: "Pocket Companion", line: "Pocket Companion does not answer on this Zero." },
    { kind: "text", text: companion.down(), tone: "warn", small: true },
    { kind: "text", text: "It runs as the pocket-companion service. Start it again from here, or with systemctl restart pocket-companion over SSH." },
    { kind: "buttons", buttons: [{ label: "Start Pocket Companion", press: () => companion.restart() }] },
    ...noteBlocks(companion),
  ];
}

export function pageBlocks(page: Page, companion: Companion, screen: Screen): Block[] {
  const status = companion.status();
  if (!status) return companion.down() ? downBlocks(companion) : waiting();
  switch (page) {
    case "start":
      return start(status, screen);
    case "consoles":
      return consoles(status, companion, screen);
    case "applets":
      return applets(status, screen);
    case "x":
      return x(companion, screen);
    case "discord":
      return discord(companion, screen);
    case "youtube":
      return youtube(companion);
    case "assistant":
      return assistant(companion, screen);
    case "settings":
      return settings(status, companion, screen);
  }
}

function start(status: Status, screen: Screen): Block[] {
  const linked = status.consoles.length > 0;
  const known = linked || status.paired.length > 0;
  return [
    { kind: "title", text: "Get Started", line: "Pocket Companion brings applets to Pocket Shell on your consoles and does the work they need on this Zero." },
    { kind: "step", number: 1, done: known, title: "Put Pocket Shell on your console", text: "Pocket Shell runs on the PSP and the Nintendo 3DS. Get it from Pocket Studio." },
    { kind: "buttons", indent: true, buttons: [{ label: "Get Pocket Shell", press: () => screen.link("Get Pocket Shell", STUDIO.shell) }] },
    { kind: "step", number: 2, done: linked, title: "Connect it to this Zero", text: "Plug the PSP into this Zero's USB port and start Pocket Shell. A 3DS pairs over Wi-Fi once and then finds this Zero by itself." },
    { kind: "buttons", indent: true, buttons: [{ label: status.paired.length ? "Pair Another 3DS" : "Pair a 3DS", press: () => screen.pair() }] },
    { kind: "step", number: 3, done: false, title: "Open the applets", text: "Pocket Shell on a PSP comes with them. On a 3DS, open the store on Home and choose GET next to the ones you want." },
    { kind: "buttons", indent: true, buttons: [{ label: "See the Applets", press: () => screen.go("applets") }] },
    { kind: "step", number: 4, done: false, title: "Set up the services you use", text: "X, Discord and YouTube work through this Zero; the console never holds your passwords or tokens." },
    {
      kind: "buttons",
      indent: true,
      buttons: [
        { label: "X", press: () => screen.go("x") },
        { label: "Discord", press: () => screen.go("discord") },
        { label: "YouTube", press: () => screen.go("youtube") },
        { label: "Assistant", press: () => screen.go("assistant") },
      ],
    },
  ];
}

function consoles(status: Status, companion: Companion, screen: Screen): Block[] {
  const blocks: Block[] = [
    { kind: "title", text: "Consoles", line: "A PSP links over USB while it is plugged in. A paired 3DS connects whenever it is on the same network." },
  ];
  if (status.consoles.length === 0 && status.paired.length === 0) {
    blocks.push({ kind: "text", text: "No console is linked or paired yet.", tone: "dim" });
  }
  for (const console of status.consoles) {
    if (status.paired.some(paired => paired.id === console.id)) continue;
    const over = console.address === "usb" ? "over USB" : `at ${console.address}`;
    blocks.push({ kind: "item", title: consoleName(console), detail: `${toAscii(console.model)} - linked ${over} since ${when(console.since)}`, dot: "ok" });
  }
  for (const paired of status.paired) {
    const link = status.consoles.find(console => console.id === paired.id);
    const detail = link
      ? `${toAscii(paired.model)} - connected since ${when(link.since)}`
      : `${toAscii(paired.model)} - not connected - last seen ${paired.lastSeen > 0 ? when(paired.lastSeen) : "never"}`;
    const name = consoleName(paired);
    blocks.push({
      kind: "item",
      title: name,
      detail: `${detail}. Enter: forget`,
      dot: link ? "ok" : "dim",
      press: () =>
        screen.confirm(`Forget ${name}?`, "This Zero deletes the console's key and disconnects it. To use it again, pair it again.", "Forget", () =>
          companion.forget(paired.id),
        ),
    });
  }
  blocks.push({ kind: "buttons", buttons: [{ label: status.paired.length ? "Pair Another 3DS" : "Pair a 3DS", press: () => screen.pair() }] });
  blocks.push(...noteBlocks(companion));
  return blocks;
}

function applets(status: Status, screen: Screen): Block[] {
  const blocks: Block[] = [
    { kind: "title", text: "Applets", line: "The applets Pocket Companion offers, and the services each one uses through this Zero." },
  ];
  if (status.apps.length === 0) blocks.push({ kind: "text", text: "No applets are offered.", tone: "dim" });
  for (const app of status.apps) {
    const needs = (app.services ?? []).map(name => SERVICE_PAGES[name]).filter(need => need !== undefined);
    const summary = app.summary ? toAscii(app.summary) : "";
    blocks.push({ kind: "item", title: `${toAscii(app.title)} ${toAscii(app.version)}`, detail: summary ? `${summary} (${bytes(app.bytes)})` : bytes(app.bytes), dot: "ink" });
    if (needs.length) blocks.push({ kind: "buttons", indent: true, buttons: needs.map(need => ({ label: `Set up ${need.title}`, press: () => screen.go(need.page) })) });
  }
  blocks.push({ kind: "text", small: true, tone: "dim", text: `Pocket Companion offers the .pocket files in ${status.appsDirs.map(toAscii).join(" and ")}.` });
  return blocks;
}

function x(companion: Companion, screen: Screen): Block[] {
  const state = companion.services()?.services.x;
  const blocks: Block[] = [{ kind: "title", text: "X", line: "The X applet reads your timeline and posts through this Zero." }];
  if (!state) return [...blocks, ...waiting()];
  if (state.signedIn) {
    blocks.push({ kind: "state", on: true, text: state.since ? `Signed in since ${when(state.since)}` : "Signed in" });
    if (state.lastError) blocks.push({ kind: "text", text: `The last request failed: ${toAscii(state.lastError)}`, tone: "warn", small: true });
    blocks.push({
      kind: "buttons",
      buttons: [
        {
          label: "Sign Out of X",
          press: () =>
            screen.confirm("Sign out of X?", "This Zero deletes its X session. Signing in again needs a browser.", "Sign Out", () =>
              companion.service("Signing out of X", "x", ["logout"]),
            ),
        },
      ],
    });
  } else {
    blocks.push({ kind: "state", on: false, text: state.signingIn ? "Waiting for you to sign in" : "Not signed in" });
    blocks.push({ kind: "text", text: "Signing in opens x.com in a browser window, and this Zero has no browser. Sign in with Pocket Companion on a Mac, or give this Zero a signed-in browser's cookies over SSH:" });
    blocks.push({ kind: "text", small: true, tone: "dim", text: "service x cookies <auth_token> <ct0>" });
  }
  blocks.push(...noteBlocks(companion));
  blocks.push({ kind: "text", small: true, tone: "dim", text: "Pocket reads X through x.com's own web interface. When X changes it, the applet can stop loading until Pocket Companion is updated." });
  return blocks;
}

function discord(companion: Companion, screen: Screen): Block[] {
  const state = companion.services()?.services.discord;
  const blocks: Block[] = [
    { kind: "title", text: "Discord", line: "The Discord applet reads and sends messages as a bot you create. Discord lets apps in through bots, not through your own account." },
  ];
  if (!state) return [...blocks, ...waiting()];
  if (state.configured) {
    if (state.error) blocks.push({ kind: "state", on: false, text: `Discord did not answer: ${toAscii(state.error)}` });
    else {
      blocks.push({ kind: "state", on: true, text: `Bot ${toAscii(state.bot ?? "")} is set up` });
      const servers = state.servers ?? [];
      blocks.push({
        kind: "text",
        tone: "dim",
        text: servers.length
          ? `In ${servers.length === 1 ? "1 server" : `${servers.length} servers`}: ${servers.map(toAscii).join(", ")}`
          : "The bot is in no server yet. Invite it to the servers you want to read on the console.",
      });
      if (state.contentIntent === false) {
        blocks.push({ kind: "text", tone: "warn", text: "Messages arrive empty: turn on Message Content Intent under Bot in the Discord Developer Portal." });
      }
    }
    const buttons: Button[] = [];
    if (state.invite) buttons.push({ label: "Invite the Bot", press: () => screen.link("Invite the bot to a server", state.invite!) });
    buttons.push({
      label: "Remove the Token",
      press: () =>
        screen.confirm("Remove the bot token?", "This Zero deletes the token. The applet stops reading Discord until you give it a token again.", "Remove", () =>
          companion.service("Removing the bot token", "discord", ["logout"]),
        ),
    });
    blocks.push({ kind: "buttons", buttons });
  } else {
    blocks.push(
      { kind: "step", number: 1, done: false, title: "Create a bot", text: "In the Discord Developer Portal choose New Application, give it a name, open Bot, and choose Reset Token. Copy the token it shows." },
      { kind: "buttons", indent: true, buttons: [{ label: "Open the Developer Portal", press: () => screen.link("Discord Developer Portal", STUDIO.discordPortal) }] },
      { kind: "step", number: 2, done: false, title: "Let it read messages", text: "On the same Bot page, turn on Message Content Intent and save." },
      { kind: "step", number: 3, done: false, title: "Give the token to this Zero", text: "Over SSH, run Pocket Companion's command below. The token stays on this Zero." },
      { kind: "text", indent: true, small: true, tone: "dim", text: "service discord token <bot-token>" },
    );
  }
  blocks.push(...noteBlocks(companion));
  return blocks;
}

function installLine(install: Install): string {
  return install.total > 0 ? `${bytes(install.received)} of ${bytes(install.total)}` : "";
}

function youtube(companion: Companion): Block[] {
  const state = companion.services()?.services.youtube;
  const blocks: Block[] = [{ kind: "title", text: "YouTube", line: "The YouTube applet plays videos this Zero converts for the console while you watch." }];
  if (!state) return [...blocks, ...waiting()];
  const installing = state.install.state === "installing";
  if (state.ready && !installing) {
    blocks.push({ kind: "state", on: true, text: "Ready" });
    blocks.push({ kind: "pairs", rows: [["yt-dlp", toAscii(state.ytDlp ?? "")], ["ffmpeg", toAscii(state.ffmpeg ?? "")]] });
    if (state.managed) {
      blocks.push({ kind: "text", text: "YouTube changes often, and yt-dlp follows. When videos stop loading, update it." });
      blocks.push({ kind: "buttons", buttons: [{ label: "Update yt-dlp", press: () => companion.service("Updating yt-dlp", "youtube", ["install"]) }] });
    }
  } else if (installing) {
    blocks.push({ kind: "state", on: false, text: toAscii(state.install.message) });
    if (state.install.total > 0) {
      blocks.push({ kind: "progress", value: state.install.received / state.install.total });
      blocks.push({ kind: "text", small: true, tone: "dim", text: installLine(state.install) });
    }
  } else {
    blocks.push({ kind: "state", on: false, text: "Needs two programs" });
    blocks.push({ kind: "text", text: "Pocket Companion converts videos with yt-dlp and ffmpeg. It can download both into its own folder, checked against their published checksums." });
    if (state.install.state === "failed") blocks.push({ kind: "text", tone: "warn", text: `The download failed: ${toAscii(state.install.message)}` });
    blocks.push({ kind: "buttons", buttons: [{ label: "Download yt-dlp and ffmpeg", press: () => companion.service("Downloading yt-dlp and ffmpeg", "youtube", ["install"]) }] });
  }
  blocks.push(...noteBlocks(companion));
  return blocks;
}

function assistant(companion: Companion, screen: Screen): Block[] {
  const agent = companion.services()?.agent;
  const blocks: Block[] = [
    { kind: "title", text: "Assistant", line: "Press L and R together on the console to ask about what is on its screen, by voice or by keyboard." },
    { kind: "text", small: true, tone: "dim", text: "The answers come from Codex on this Zero, signed in with your ChatGPT account. The console sends your question and a picture of its screen here; Codex uses your plan's usage." },
  ];
  if (!agent) return [...blocks, ...waiting()];
  if (agent.on) blocks.push({ kind: "state", on: true, text: "On" });
  else if (!agent.codex) {
    blocks.push({ kind: "state", on: false, text: "Codex is not installed" });
    blocks.push({ kind: "text", text: "Install the Codex command line on this Zero, then come back to this page." });
    blocks.push({ kind: "buttons", buttons: [{ label: "How to Install Codex", press: () => screen.link("Install Codex", STUDIO.codex) }] });
  } else if (!agent.signedIn) {
    blocks.push({ kind: "state", on: false, text: "Codex is not signed in" });
    blocks.push({ kind: "text", text: "Over SSH, run codex login --device-auth on this Zero and finish signing in on your phone." });
  } else if (!agent.enabled) blocks.push({ kind: "state", on: false, text: "Off" });
  else {
    blocks.push({ kind: "state", on: false, text: "Codex is ready" });
    blocks.push({ kind: "text", text: "Restart Pocket Companion to turn the assistant on. Connected consoles reconnect by themselves." });
    blocks.push({ kind: "buttons", buttons: [{ label: "Restart Pocket Companion", press: () => companion.restart() }] });
  }
  blocks.push(...noteBlocks(companion));
  return blocks;
}

function settings(status: Status, companion: Companion, screen: Screen): Block[] {
  const { companion: info } = status;
  return [
    { kind: "title", text: "Settings", line: "Pocket Companion runs as a service on this Zero. Consoles reach it while the Zero is on." },
    {
      kind: "pairs",
      rows: [
        ["Name", toAscii(info.name)],
        ["Address", info.addresses.length ? info.addresses.map(address => `${address}:${info.port}`).join(", ") : "No network"],
        ["Link", `version ${info.version}`],
      ],
    },
    { kind: "buttons", buttons: [{ label: "Restart Pocket Companion", press: () => companion.restart() }] },
    { kind: "buttons", buttons: [{ label: "Pocket Companion on Pocket Studio", press: () => screen.link("Pocket Companion", STUDIO.companion) }] },
    { kind: "buttons", buttons: [{ label: "Close This Screen", press: () => companion.quit() }] },
    ...noteBlocks(companion),
  ];
}
