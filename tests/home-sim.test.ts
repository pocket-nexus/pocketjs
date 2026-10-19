// tests/home-sim.test.ts — Pocket Home (apps/home) headless on the wasm core
// with the 3DS geometry, the 3DS app table and the Pocket Link, Wi-Fi and
// camera fakes (hosts/sim/console-3ds.ts). Each journey drives the stylus and
// the buttons and checks what the screens show and what the host was asked.
//
// POCKET_HOME_SHOTS=<dir> also writes top/bottom PNGs of each main screen.

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BTN } from "../contracts/spec/spec.ts";
import type { LinkCatalogApp } from "../contracts/spec/link.ts";
import { bootConsole3ds, type Console3ds, type Console3dsOptions } from "../hosts/sim/console-3ds.ts";
import { encodePNG } from "../tools/png.ts";

const ROOT = new URL("..", import.meta.url).pathname;
const OUT = mkdtempSync(join(tmpdir(), "pocket-home-"));
const GUEST = join(OUT, "guest", "home-main");
const SHOTS = process.env.POCKET_HOME_SHOTS;
const GLOBALS = ["ui", "__pak", "__simHz", "frame", "link", "wifi", "camera", "net", "__pocketApp"] as const;
const saved = new Map(GLOBALS.map((key) => [key, (globalThis as Record<string, unknown>)[key]]));

const MAC = { id: "a1b2c3d4e5f60718", name: "Evan's MacBook Pro", address: "192.168.8.120", port: 8628 };
const PAIRING_URI = "pocketlink://pair?v=1&c=a1b2c3d4e5f60718&h=192.168.8.120&p=8628&s=00112233445566778899aabbccddeeff&n=Evan%27s%20MacBook%20Pro";
const APPS = [
  { output: "hn-main", id: "dev.pocket-nexus.hn", title: "Hacker News", version: "0.1.0", bytes: 61_440 },
  { output: "nexus-main", id: "dev.pocket-nexus.nexus", title: "Pocket Nexus", version: "0.1.0", bytes: 1_240_000 },
  { output: "pocket3ds-demo-main", id: "dev.pocket-nexus.3ds-demo", title: "Contacts", version: "0.1.0", bytes: 212_000 },
];
const CATALOG: LinkCatalogApp[] = [
  { id: "dev.pocket-nexus.hn", title: "Hacker News", version: "0.1.0", output: "hn-main", hash: "0123456789abcdef", bytes: 61_440, summary: "Top stories and threads, read on two screens." },
  { id: "dev.pocket-nexus.nexus", title: "Pocket Nexus", version: "0.2.0", output: "nexus-main", hash: "1123456789abcdef", bytes: 1_310_000, summary: "The pocket.nexus homepage with physics toys." },
  { id: "dev.pocket-nexus.weather", title: "Weather", version: "1.0.0", output: "weather-main", hash: "2123456789abcdef", bytes: 96_000, summary: "Forecasts for your saved cities." },
];

beforeAll(() => {
  const build = Bun.spawnSync(
    [process.execPath, "tools/3ds.ts", "home", "--pocket-only", `--outdir=${join(OUT, "guest")}`, `--package-outdir=${OUT}`],
    { cwd: ROOT, stdout: "pipe", stderr: "pipe" },
  );
  if (build.exitCode !== 0) throw new Error(`home build failed\n${build.stdout}${build.stderr}`);
  if (SHOTS) mkdirSync(SHOTS, { recursive: true });
}, 120_000);

afterAll(() => {
  for (const [key, value] of saved) (globalThis as Record<string, unknown>)[key] = value;
  rmSync(OUT, { recursive: true, force: true });
});

function boot(options: Partial<Console3dsOptions> = {}): Promise<Console3ds> {
  return bootConsole3ds({
    js: `${GUEST}.js`,
    pak: `${GUEST}.pak`,
    apps: APPS,
    link: { paired: [MAC], linked: MAC.id, catalog: CATALOG },
    wifi: { saved: ["PocketNet", "Studio 5G", ""], connected: 0 },
    ...options,
  });
}

function shot(console3ds: Console3ds, name: string): void {
  if (!SHOTS) return;
  for (const surface of ["primary", "auxiliary"] as const) {
    const { width, height, rgba } = console3ds.world.pixels(surface);
    writeFileSync(join(SHOTS, `home-${name}-${surface === "primary" ? "top" : "bottom"}.png`), encodePNG(rgba, width, height));
  }
}

/** Open Settings from the dock and let the zoom finish. */
async function openSettings(console3ds: Console3ds): Promise<void> {
  await console3ds.tapText("Settings");
  await console3ds.run(24);
}

describe("springboard", () => {
  test("installed apps fill the grid, the dock holds Settings and Mac, the top screen is the lock screen", async () => {
    const home = await boot();
    await home.run(30);
    const bottom = home.texts("auxiliary");
    for (const label of ["Hacker News", "Pocket Nexus", "Contacts", "Settings", "Mac"]) expect(bottom).toContain(label);
    const top = home.texts("primary");
    // 01:41 UTC at the default UTC+8.
    expect(top).toContain("9:41");
    expect(top).toContain("Monday, October 19");
    expect(top).toContain("Linked to Evan's MacBook Pro");
    expect(top).toContain("3 apps offered. Open Mac below.");
    shot(home, "springboard");
  });

  test("tapping an icon zooms and asks the host to launch it", async () => {
    const home = await boot();
    await home.run(10);
    await home.tapText("Contacts");
    await home.run(30);
    expect(home.launches).toEqual(["pocket3ds-demo-main"]);
  });

  test("the d-pad walks the grid with a focus ring and A launches", async () => {
    const home = await boot();
    await home.run(10);
    await home.press(BTN.RIGHT); // first press: focus the first icon
    await home.press(BTN.RIGHT);
    await home.run(2);
    expect(home.texts("primary")).toContain("Pocket Nexus");
    await home.press(BTN.CIRCLE);
    await home.run(30);
    expect(home.launches).toEqual(["nexus-main"]);
  });

  test("edit mode deletes an app through removeApp after the alert", async () => {
    const home = await boot();
    await home.run(10);
    await home.press(BTN.SQUARE);
    await home.run(6);
    expect(home.texts("primary")).toContain("Editing Home");
    // The badge sits on the first icon's top-left corner.
    await home.tap(18, 12);
    await home.run(4);
    expect(home.texts("auxiliary")).toContain('Delete "Hacker News"?');
    shot(home, "delete-alert");
    await home.tapText("Delete");
    await home.run(6);
    expect(home.link!.log).toContain("remove dev.pocket-nexus.hn");
    expect(home.apps.map((app) => app.id)).not.toContain("dev.pocket-nexus.hn");
    expect(home.texts("auxiliary")).not.toContain("Hacker News");
  });

  test("SELECT goes back to the app the host interrupted", async () => {
    const home = await boot({ resume: "hn-main" });
    await home.run(10);
    expect(home.texts("primary")).toContain("Press SELECT to go back to it.");
    await home.press(BTN.SELECT);
    expect(home.launches).toEqual(["hn-main"]);
  });
});

describe("settings", () => {
  test("the root lists Wi-Fi, Mac, Apps and General with their values", async () => {
    const home = await boot();
    await home.run(10);
    await openSettings(home);
    const bottom = home.texts("auxiliary");
    for (const label of ["Wi-Fi", "PocketNet", "Evan's MacBook Pro", "Apps", "3", "General"]) expect(bottom).toContain(label);
    expect(home.texts("primary")).toContain("Settings");
    shot(home, "settings");
  });

  test("Wi-Fi shows the saved networks and connects to the tapped one", async () => {
    const home = await boot();
    await home.run(10);
    await openSettings(home);
    await home.tapText("Wi-Fi");
    await home.run(24);
    const bottom = home.texts("auxiliary");
    for (const label of ["Saved Networks", "PocketNet", "Studio 5G", "Connection 3", "Not set up", "ON"]) expect(bottom).toContain(label);
    shot(home, "wifi");
    await home.tapText("Studio 5G");
    expect(home.wifi!.log).toContain("connect 1");
    await home.run(40);
    expect(home.wifi!.status().ssid).toBe("Studio 5G");
    expect(home.texts("primary")).toContain("Studio 5G");
  });

  test("the Wi-Fi switch turns the radio off", async () => {
    const home = await boot();
    await home.run(10);
    await openSettings(home);
    await home.tapText("Wi-Fi");
    await home.run(24);
    await home.tapText("ON");
    await home.run(32);
    expect(home.wifi!.log).toContain("setEnabled false");
    expect(home.texts("auxiliary")).toContain("OFF");
    expect(home.texts("auxiliary")).not.toContain("Saved Networks");
  });

  test("Time Zone moves the clock", async () => {
    const home = await boot();
    await home.run(10);
    await openSettings(home);
    await home.tapText("General");
    await home.run(24);
    await home.tapText("Time Zone");
    await home.run(24);
    // The list opens scrolled to the zone in use (UTC+8); its neighbour is on screen.
    await home.tapText("UTC+9");
    await home.run(2);
    expect(home.texts("primary")).toContain("10:41 AM");
    expect(home.texts("primary")).toContain("UTC+9");
  });

  test("B walks back up the stack and closes Settings", async () => {
    const home = await boot();
    await home.run(10);
    await openSettings(home);
    await home.tapText("General");
    await home.run(24);
    await home.press(BTN.CROSS);
    await home.run(24);
    expect(home.texts("auxiliary")).toContain("Wi-Fi");
    await home.press(BTN.CROSS);
    await home.run(24);
    expect(home.texts("primary")).toContain("9:41");
  });
});

describe("pairing a Mac", () => {
  test("scan a pairing code, pair, and land back on the Mac page linked", async () => {
    const home = await boot({ link: { paired: [], catalog: CATALOG } });
    await home.run(10);
    await openSettings(home);
    expect(home.texts("auxiliary")).toContain("Not Paired");
    await home.tapText("Mac");
    await home.run(24);
    await home.tapText("Pair a Mac...");
    await home.run(24);
    expect(home.camera!.log).toContain("open");
    expect(home.texts("primary")).toContain("On your Mac, open Pocket Companion.");
    shot(home, "scanner");

    home.camera!.show("https://example.com/not-a-pairing-code");
    await home.run(2);
    expect(home.texts("auxiliary")).toContain("That code is not a Pocket pairing code.");
    expect(home.link!.log.some((line) => line.startsWith("pair "))).toBe(false);

    home.camera!.show(PAIRING_URI);
    await home.run(2);
    expect(home.link!.log).toContain(`pair ${PAIRING_URI}`);
    expect(home.texts("auxiliary").some((text) => text.startsWith("Connecting to Evan's MacBook"))).toBe(true);
    await home.run(32);
    expect(home.texts("auxiliary")).toContain("Paired with Evan's MacBook Pro");
    shot(home, "scanner-paired");
    await home.run(100);
    expect(home.camera!.log).toContain("close");
    const mac = home.texts("auxiliary");
    expect(mac).toContain("Linked");
    expect(mac).toContain("Evan's MacBook Pro");
    expect(home.link!.status().state).toBe("linked");
    shot(home, "mac");
  });

  test("a refused pairing shows its reason and keeps the scanner open", async () => {
    const home = await boot({ link: { paired: [], refusePairing: "The pairing window closed" } });
    await home.run(10);
    await openSettings(home);
    await home.tapText("Mac");
    await home.run(24);
    await home.tapText("Pair a Mac...");
    await home.run(24);
    home.camera!.show(PAIRING_URI);
    await home.run(40);
    expect(home.texts("auxiliary")).toContain("The pairing window closed");
    expect(home.camera!.open()).toBe(true);
  });
});

describe("the Mac store", () => {
  test("lists the catalog, installs an app, and the app opens from the springboard", async () => {
    const home = await boot();
    await home.run(10);
    await home.tapText("Mac");
    await home.run(24);
    const store = home.texts("auxiliary");
    for (const label of ["Hacker News", "OPEN", "Pocket Nexus", "UPDATE", "Weather", "GET"]) expect(store).toContain(label);
    shot(home, "store");

    const get = home.locate("GET")!;
    await home.tap(get[0] + get[2] / 2, get[1] + get[3] / 2);
    expect(home.link!.log).toContain("install 2 dev.pocket-nexus.weather");
    await home.run(8);
    expect(home.texts("auxiliary").some((text) => text.startsWith("Installing"))).toBe(true);
    shot(home, "store-installing");
    await home.run(30);
    expect(home.apps.map((app) => app.output)).toContain("weather-main");
    expect(home.texts("auxiliary")).not.toContain("GET");

    await home.press(BTN.START); // back to the springboard
    await home.run(24);
    expect(home.texts("auxiliary")).toContain("Weather");
    await home.tapText("Weather");
    await home.run(30);
    expect(home.launches).toEqual(["weather-main"]);
  });

  test("without a paired Mac the store points to Settings > Mac", async () => {
    const home = await boot({ link: { paired: [] } });
    await home.run(10);
    await home.tapText("Mac");
    await home.run(24);
    expect(home.texts("auxiliary")).toContain("No Mac Paired");
    await home.tapText("Mac Settings");
    await home.run(24);
    expect(home.texts("auxiliary")).toContain("Pair a Mac...");
  });
});

test("a journey is a pure function of its input", async () => {
  const hashes: string[][] = [];
  for (let run = 0; run < 2; run++) {
    const home = await boot();
    const seen: string[] = [];
    await home.run(10);
    await home.tapText("Settings");
    for (let frame = 0; frame < 30; frame++) {
      await home.step();
      if (frame % 10 === 9) seen.push(Bun.hash(home.world.pixels("auxiliary").rgba).toString(16));
    }
    seen.push(Bun.hash(home.world.pixels("primary").rgba).toString(16));
    hashes.push(seen);
  }
  expect(hashes[0]).toEqual(hashes[1]!);
});
