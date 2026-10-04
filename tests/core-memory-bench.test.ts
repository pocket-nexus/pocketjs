import { $ } from "bun";
import { expect, test } from "bun:test";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const COMMAND = [
  "cargo",
  "run",
  "--manifest-path",
  "engine/core/Cargo.toml",
  "--example",
  "membench",
  "--quiet",
];

const REQUIRED_FIELDS = [
  "peak_requested_bytes",
  "final_requested_bytes",
  "allocation_count",
  "total_allocated_bytes",
  "avg_layout_us",
  "max_layout_us",
  "nodes",
  "structural_relayouts",
  "text_mode",
  "texture_mode",
  "drawlist_checksum",
] as const;

const TIMING_FIELDS = new Set(["avg_layout_us", "max_layout_us"]);
type Receipt = Record<(typeof REQUIRED_FIELDS)[number], string>;

function parseReceipt(output: string): Receipt {
  const lines = output.endsWith("\n")
    ? output.slice(0, -1).split("\n")
    : output.split("\n");
  expect(lines).toHaveLength(REQUIRED_FIELDS.length);

  const seen = new Set<string>();
  const entries = lines.map((line) => {
    const separator = line.indexOf("=");
    expect(separator).toBeGreaterThan(0);
    expect(line.indexOf("=", separator + 1)).toBe(-1);

    const field = line.slice(0, separator);
    const value = line.slice(separator + 1);
    expect((REQUIRED_FIELDS as readonly string[]).includes(field)).toBe(true);
    expect(seen.has(field)).toBe(false);
    expect(value).not.toBe("");
    seen.add(field);
    return [field, value];
  });

  expect(seen.size).toBe(REQUIRED_FIELDS.length);
  const receipt = Object.fromEntries(entries) as Partial<Receipt>;

  for (const field of REQUIRED_FIELDS) {
    expect(receipt[field]).toBeDefined();
    expect(receipt[field]).not.toBe("");
  }

  for (const field of REQUIRED_FIELDS) {
    if (TIMING_FIELDS.has(field)) continue;
    if (field === "text_mode" || field === "texture_mode") {
      expect(receipt[field]).toBe("atlas");
    } else if (field === "drawlist_checksum") {
      expect(receipt[field]).toMatch(/^[0-9a-f]{16}$/);
    } else {
      expect(receipt[field]).toMatch(/^\d+$/);
      const value = Number(receipt[field]);
      expect(Number.isFinite(value)).toBe(true);
      expect(Number.isInteger(value)).toBe(true);
      expect(value).toBeGreaterThanOrEqual(0);
    }
  }

  for (const field of TIMING_FIELDS) {
    expect(receipt[field]).toMatch(/^\d+$/);
    const value = Number(receipt[field]);
    expect(Number.isFinite(value)).toBe(true);
    expect(Number.isInteger(value)).toBe(true);
    expect(value).toBeGreaterThanOrEqual(0);
  }

  return receipt as Receipt;
}

const VALID_RECEIPT = REQUIRED_FIELDS.map((field) => {
  if (field === "text_mode" || field === "texture_mode") return `${field}=atlas`;
  if (field === "drawlist_checksum") return `${field}=0000000000000000`;
  return `${field}=0`;
}).join("\n");

test("receipt parser rejects unknown and duplicate fields", () => {
  expect(() => parseReceipt(`${VALID_RECEIPT}\nunknown=0`)).toThrow();
  expect(() => parseReceipt(`${VALID_RECEIPT}\npeak_requested_bytes=0`)).toThrow();
});

test("receipt parser rejects non-finite and non-integer numbers", () => {
  expect(() =>
    parseReceipt(
      VALID_RECEIPT.replace(
        "peak_requested_bytes=0",
        `peak_requested_bytes=${"9".repeat(400)}`,
      ),
    ),
  ).toThrow();
  expect(() =>
    parseReceipt(VALID_RECEIPT.replace("peak_requested_bytes=0", "peak_requested_bytes=1.5")),
  ).toThrow();
});

function canonicalReceipt(receipt: Receipt): Partial<Receipt> {
  return Object.fromEntries(
    REQUIRED_FIELDS.filter((field) => !TIMING_FIELDS.has(field)).map((field) => [
      field,
      receipt[field],
    ]),
  );
}

test(
  "core memory receipt is complete, stable, and matches its baseline",
  { timeout: 30_000 },
  async () => {
    const run = () =>
      $`${COMMAND[0]} ${COMMAND.slice(1)}`.cwd(ROOT).quiet().text();
    const first = parseReceipt(await run());
    const second = parseReceipt(await run());

    expect(canonicalReceipt(first)).toEqual(canonicalReceipt(second));

    const baseline = (await Bun.file(
      new URL("../docs/bench/core-memory-2026-09-05.json", import.meta.url),
    ).json()) as { receipt: Receipt };
    expect(canonicalReceipt(first)).toEqual(canonicalReceipt(baseline.receipt));
  },
);
