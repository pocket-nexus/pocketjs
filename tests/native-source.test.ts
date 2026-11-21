import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  ensureQuickJsCheckout, mustRunCommand, quickJsCheckout,
  quickJsCheckoutStatus,
} from "../tools/native-source.ts";

test("native sources verify the pinned revision/version and preserve modified checkouts", () => {
  const temp = mkdtempSync(join(tmpdir(), "native source "));
  try {
    const source = join(temp, "upstream");
    const checkout = join(temp, "checkout with spaces");
    const git = (args: string[]) => mustRunCommand("source fixture", "git", args, source);
    mkdirSync(quickJsCheckout(source).source, { recursive: true });
    writeFileSync(join(quickJsCheckout(source).source, "VERSION"), "fixture-version\n");
    git(["init", "--quiet"]);
    git(["add", "."]);
    git(["-c", "user.name=Source Fixture", "-c", "user.email=fixture@example.invalid", "commit", "-qm", "fixture"]);
    const pin = { repository: source, revision: git(["rev-parse", "HEAD"]), version: "fixture-version" };
    ensureQuickJsCheckout("source fixture", checkout, pin);
    expect(quickJsCheckoutStatus(checkout, pin).ok).toBe(true);
    // A verified warm cache needs no usable remote or network.
    ensureQuickJsCheckout("source fixture", checkout, { ...pin, repository: join(temp, "missing") });
    expect(quickJsCheckoutStatus(checkout, { ...pin, revision: "0".repeat(40) }).ok).toBe(false);
    expect(quickJsCheckoutStatus(checkout, { ...pin, version: "wrong" }).ok).toBe(false);
    const file = join(quickJsCheckout(checkout).source, "VERSION");
    writeFileSync(file, "local change\n");
    expect(() => ensureQuickJsCheckout("source fixture", checkout, pin)).toThrow("refusing to replace");
    expect(readFileSync(file, "utf8")).toBe("local change\n");
  } finally {
    rmSync(temp, { recursive: true, force: true });
  }
});
