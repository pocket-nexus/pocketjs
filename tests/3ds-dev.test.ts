// `bun run 3ds:dev` (tools/3ds-dev.ts): the link's command line with the
// spellings of the tool that spoke the development connection.

import { afterAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { EXIT } from "../tools/pocket-link/v2/cli.ts";

const root = resolve(import.meta.dir, "..");
const tool = join(root, "tools/3ds-dev.ts");
const scratch = mkdtempSync(join(tmpdir(), "p3d-"));
afterAll(() => rmSync(scratch, { recursive: true, force: true }));

async function dev(home: string, ...args: string[]): Promise<{ code: number; out: string; err: string }> {
  const child = Bun.spawn(["bun", tool, ...args, "--home", home], { cwd: scratch, stdout: "pipe", stderr: "pipe" });
  const [out, err, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
  return { code, out, err };
}

describe("bun run 3ds:dev", () => {
  test("help names the commands, the earlier spellings and what a console built before the link needs", async () => {
    const help = await dev(join(scratch, "h0"), "help");
    expect(help.code).toBe(EXIT.ok);
    for (const word of ["setup --host", "was: pair", "was: discover", "probe", "dev ", "8131", "bun run link2 --help"]) expect(help.out).toContain(word);
  });

  test("pair is setup and discover is devices: a card gets its pairing and the record is listed, no key printed", async () => {
    const home = join(scratch, "h1");
    const card = join(scratch, "card1");
    mkdirSync(card);
    const paired = await dev(home, "pair", "--card", card, "--address", "192.0.2.7", "--rotate");
    expect(paired.code, paired.err).toBe(EXIT.ok);
    expect(paired.err).toContain("--rotate is gone");
    expect(readdirSync(join(card, "pocketjs/link")).sort()).toEqual(["companions", "device.txt"]);
    const listed = await dev(home, "discover");
    expect(listed.code, listed.err).toBe(EXIT.ok);
    expect(listed.out).toContain("never linked");
    expect(`${paired.out}${listed.out}`).not.toMatch(/[0-9a-f]{64}/);
  });

  test("a named file that is not there is an error before anything is sent; a console that never links gets the advice for an old program", async () => {
    const home = join(scratch, "h2");
    const card = join(scratch, "card2");
    mkdirSync(card);
    expect((await dev(home, "setup", "--card", card, "--address", "192.0.2.7")).code).toBe(EXIT.ok);
    const missing = await dev(home, "push", "--package", "nowhere.pocket");
    expect(missing.code).toBe(EXIT.failed);
    expect(missing.err).toContain("package does not exist");
    const waited = await dev(home, "status", "--host", "127.0.0.1", "--wait", "1", "--port", "0");
    expect(waited.code).toBe(EXIT.noDevice);
    expect(waited.err).toContain("built before Pocket Link 2");
  }, 30_000);
});
