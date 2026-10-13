// A game's packs brought to a console over the LAN: tools/pocket3d-delivery.ts
// against the console's own C (hosts/3ds/src/packs_delivery.c) built for this
// computer, one process a control line, over real sockets on 127.0.0.1.

import { expect, test } from "bun:test";
import { mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { deliver, type DeliveryClient } from "../tools/pocket3d-delivery.ts";
import { checkPacks, PACKS_FILE, pieceFile, piecesOf, writePacks } from "../tools/pocket3d-packs.ts";

const ROOT = resolve(import.meta.dir, "..");
const SIZES = { min: 1024, max: 4096, bits: 10 };
const work = mkdtempSync(join(tmpdir(), "pocket3d-delivery-"));

/** Bytes that follow from a seed. */
function bytes(length: number, seed: number): Uint8Array {
  const out = new Uint8Array(length);
  let state = seed >>> 0;
  for (let i = 0; i < length; i++) {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    out[i] = state >>> 24;
  }
  return out;
}

function build(): string | null {
  if (!Bun.which("cc")) return null;
  const binary = join(work, "console");
  const source = join(ROOT, "hosts/3ds/src");
  const made = Bun.spawnSync(["cc", "-std=gnu11", "-Wall", "-Wextra", "-Werror", "-I", source, "-o", binary, join(source, "packs_delivery.c"), join(source, "dev_protocol.c"), join(ROOT, "tests/fixtures/pocket3d-delivery-console.c")]);
  if (made.exitCode !== 0) throw new Error(made.stderr.toString());
  return binary;
}

/** A console whose card is `card`: each control line is handled by the C side, and its answer comes back as a control line. */
function consoleAt(binary: string, card: string) {
  type Message = Record<string, unknown>;
  const waiting: { match: (message: Message) => boolean; resolve: (message: Message) => void }[] = [];
  const said: string[] = [];
  const client = {
    host: "127.0.0.1",
    async sendCtrl(value: unknown) {
      const run = Bun.spawn([binary, card, JSON.stringify(value)], { stdout: "pipe" });
      const [line, changed] = (await new Response(run.stdout).text()).split("\n");
      said.push(changed ?? "");
      const message = JSON.parse(line!) as Message;
      const at = waiting.findIndex((each) => each.match(message));
      if (at >= 0) waiting.splice(at, 1)[0]!.resolve(message);
    },
    waitForCtrl(match: (message: Message) => boolean) {
      return new Promise<Message>((resolve) => waiting.push({ match, resolve }));
    },
  };
  return { client: client as unknown as DeliveryClient, said };
}

const binary = build();

test.skipIf(!binary)("a console gets the pieces it lacks, then the list, and loses the pieces no pack names", async () => {
  const packs = join(work, "packs");
  const card = join(work, "card/3ds/game/packs");
  const one = bytes(40_000, 1);
  const two = bytes(30_000, 2);
  writeFileSync(join(work, "one.pack"), one);
  writeFileSync(join(work, "two.pack"), two);
  const cut = () => writePacks(packs, [{ name: "one", file: join(work, "one.pack"), cuts: [] }, { name: "two", file: join(work, "two.pack"), cuts: [] }], SIZES);
  const first = cut();
  const pieces = piecesOf(first.packs);
  expect(pieces.length).toBeGreaterThan(10);

  // An empty card: every piece crosses, and the list is written after them.
  const { client, said } = consoleAt(binary!, card);
  const brought = await deliver(client, packs, first.manifest);
  expect(brought).toMatchObject({ sent: pieces.length, had: 0, removed: 0, bytes: 70_000 });
  expect(readFileSync(join(card, PACKS_FILE), "utf8")).toBe(first.text);
  expect(checkPacks(card, PACKS_FILE).pieces).toBe(pieces.length);
  expect(said.filter((each) => each === "changed").length).toBe(1);

  // The same packs again: nothing crosses.
  expect(await deliver(client, packs, first.manifest)).toMatchObject({ sent: 0, had: pieces.length, bytes: 0 });

  // One pack changes in the middle: its changed pieces cross, and the ones nothing names go.
  one.set(bytes(64, 3), 20_000);
  writeFileSync(join(work, "one.pack"), one);
  const second = cut();
  const now = piecesOf(second.packs);
  const fresh = now.filter((piece) => !pieces.some((old) => old.name === piece.name));
  expect(fresh.length).toBeGreaterThan(0);
  expect(fresh.length).toBeLessThan(4);
  const again = await deliver(client, packs, second.manifest, { prune: true });
  expect(again).toMatchObject({ sent: fresh.length, had: now.length - fresh.length });
  expect(again.removed).toBe(pieces.length + fresh.length - now.length);
  expect(readdirSync(card).filter((name) => name.endsWith(".bin")).sort()).toEqual(now.map(pieceFile).sort());
  checkPacks(card, PACKS_FILE);

  // A piece damaged on the card keeps its name and its size: only a delivery that asks for a check finds it.
  const damaged = join(card, pieceFile(now[0]!));
  writeFileSync(damaged, bytes(now[0]!.bytes, 9));
  expect(await deliver(client, packs, second.manifest)).toMatchObject({ sent: 0 });
  expect(await deliver(client, packs, second.manifest, { verify: true })).toMatchObject({ sent: 1, bytes: now[0]!.bytes });
  checkPacks(card, PACKS_FILE);
});

test.skipIf(!binary)("the console refuses what the computer does not serve", async () => {
  const card = join(work, "refused");
  const line = { t: "pocket3d.packs", piece: { host: "127.0.0.1", port: 9, token: "0".repeat(64), name: "0123456789abcdef0123", bytes: 16, crc32: 1 } };
  const run = Bun.spawnSync([binary!, card, JSON.stringify(line)]);
  const answer = JSON.parse(run.stdout.toString().split("\n")[0]!);
  expect(answer).toMatchObject({ t: "pocket3d.piece", name: "0123456789abcdef0123", ok: false, cached: false });
  expect(answer.error).not.toBe("");
  // A line of another kind is not the delivery's.
  expect(Bun.spawnSync([binary!, card, JSON.stringify({ t: "screenshot" })]).exitCode).toBe(2);
});
