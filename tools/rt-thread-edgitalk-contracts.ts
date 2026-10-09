#!/usr/bin/env bun
/**
 * Contracts entry for RT-Thread / Edgi-Talk M55.
 *
 * Honest behaviour (do not fake green):
 *   --check   Reuse ESP-IDF generated-contract check for **shared** crates/headers
 *             (same layouts M55 links), then print RTT-only items as NOT YET ENFORCED.
 *   --list    Print ABI lockstep + unenforced inventory from rtt-edgitalk-native.ts
 *   --help    Usage
 *
 * Full IDF generation/check remains: bun tools/esp-idf-contracts.ts --check
 */
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  RTT_EDGITALK_ABI_LOCKSTEP,
  RTT_EDGITALK_RUST_TARGET,
  RTT_EDGITALK_TARGET,
  RTT_EDGITALK_UNENFORCED,
} from "../contracts/spec/rtt-edgitalk-native.ts";
import { generatedIdfContracts } from "./esp-idf-contracts.ts";

const root = resolve(fileURLToPath(new URL("..", import.meta.url)));

function usage(): string {
  return `usage: rt-thread-edgitalk-contracts [--check|--list|--help]

  --check   Verify shared IDF-generated contracts are up to date, then report
            RTT-only surfaces as not yet enforced (exit 1 only if IDF shared check fails).
  --list    Print lockstep ABI inventory + unenforced TODOs (no file checks).
  --help    Show this help.
`;
}

function listInventory(): void {
  console.log(`RTT Edgi-Talk native contracts inventory`);
  console.log(`  host target : ${RTT_EDGITALK_TARGET}`);
  console.log(`  rust target : ${RTT_EDGITALK_RUST_TARGET}`);
  console.log("");
  console.log("ABI lockstep with ESP-IDF (must stay identical):");
  for (const item of RTT_EDGITALK_ABI_LOCKSTEP) {
    console.log(`  • ${item.name}`);
    console.log(`      spec: ${item.idfSpec}`);
    for (const h of item.sharedHeaders) console.log(`      ${h}`);
    console.log(`      note: ${item.note}`);
  }
  console.log("");
  console.log("NOT YET ENFORCED (RTT-only / deferred):");
  for (const item of RTT_EDGITALK_UNENFORCED) {
    console.log(`  • ${item.name}`);
    for (const p of item.paths) console.log(`      ${p}`);
    console.log(`      TODO: ${item.todo}`);
  }
}

function checkSharedIdf(): void {
  const stale: string[] = [];
  for (const [path, contents] of generatedIdfContracts()) {
    const file = resolve(root, path);
    if (!existsSync(file) || readFileSync(file, "utf8") !== contents) {
      stale.push(path);
    }
  }
  if (stale.length) {
    console.error("Shared IDF contracts are stale or missing:");
    for (const path of stale) console.error("  " + path);
    console.error("Fix with: bun tools/esp-idf-contracts.ts");
    console.error("(M55 reuses these headers/crates — do not fork layouts.)");
    process.exit(1);
  }
  console.log(
    "OK: shared ESP-IDF generated contracts match contracts/spec/idf-native.ts (+ package format).",
  );
}

function reportUnenforced(): void {
  console.log("");
  console.log("RTT-only contract enforcement: NOT YET ENFORCED");
  for (const item of RTT_EDGITALK_UNENFORCED) {
    console.log(`  - ${item.name}: ${item.todo}`);
  }
  console.log("");
  console.log(
    "No fake pass for board hooks / shims / platform id. See issue #2 for platform: rt-thread.",
  );
}

if (import.meta.main) {
  const args = Bun.argv.slice(2);
  if (args.includes("--help") || args.includes("-h") || args.length === 0) {
    console.log(usage());
    if (args.length === 0) process.exit(0);
    process.exit(0);
  }
  if (args.includes("--list")) {
    listInventory();
    process.exit(0);
  }
  if (args.includes("--check")) {
    console.log(
      `Checking shared ABI for ${RTT_EDGITALK_TARGET} (${RTT_EDGITALK_RUST_TARGET})…`,
    );
    checkSharedIdf();
    reportUnenforced();
    process.exit(0);
  }
  console.error("unknown args: " + args.join(" ") + "\n" + usage());
  process.exit(1);
}
