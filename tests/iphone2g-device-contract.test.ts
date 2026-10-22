import { POCKET_BINDING_GENERATION } from "../contracts/spec/binding-generation.ts";
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { assertIPhone2GStatusAdvanced, bootstrapControllerScript, classifyPasswordAuthenticationProbe, deriveIPhone2GGuestArtifacts, parseIPhone2GDeviceStatus, quoteOpenSshConfigValue, readUntilMarker } from "../tools/iphone2g.ts";
import { resolveIPhone2GBuildPlan } from "../tools/iphone2g-profile.ts";

const repository = fileURLToPath(new URL("..", import.meta.url));
function runtimeStatus(
  overrides: Partial<Record<string, string>> = {},
): string {
  const values: Record<string, string> = {
    schema: "2",
    build_id: "a".repeat(32),
    state: "running",
    pid: "321",
    written_at: "1785900000",
    heartbeat: "7",
    guest_frames: "210",
    touch_sequences: "2",
    completed_touch_sequences: "2",
    touch_down: "0",
    last_touch_x: "71",
    last_touch_y: "409",
    last_touch_hit: "46",
    action_name: "hero_tap",
    action_value: "2",
    action_sequence: "2",
    error: "",
    ...overrides,
  };
  return (
    [
      "schema",
      "build_id",
      "state",
      "pid",
      "written_at",
      "heartbeat",
      "guest_frames",
      "touch_sequences",
      "completed_touch_sequences",
      "touch_down",
      "last_touch_x",
      "last_touch_y",
      "last_touch_hit",
      "action_name",
      "action_value",
      "action_sequence",
      "error",
    ]
      .map((name) => `${name}=${values[name]}`)
      .join("\n") + "\n"
  );
}

describe("iPhone 2G device transport contract", () => {
  test("accepts only a released app action from a live, advancing runtime", () => {
    const buildId = "a".repeat(32);
    const previous = parseIPhone2GDeviceStatus(runtimeStatus(), buildId);
    const current = parseIPhone2GDeviceStatus(
      runtimeStatus({
        written_at: "1785900002",
        heartbeat: "8",
        guest_frames: "270",
      }),
      buildId,
    );
    expect(() => assertIPhone2GStatusAdvanced(previous, current)).not.toThrow();

    for (const overrides of [
      { touch_down: "1" },
      { completed_touch_sequences: "0" },
      { action_name: "" },
      { action_value: "0" },
      { action_sequence: "0" },
    ]) {
      expect(() =>
        parseIPhone2GDeviceStatus(runtimeStatus(overrides), buildId),
      ).toThrow("released touch and a completed hero_tap action");
    }
    expect(() => assertIPhone2GStatusAdvanced(previous, previous)).toThrow(
      "status is stale",
    );
    const replacement = parseIPhone2GDeviceStatus(
      runtimeStatus({ pid: "322", heartbeat: "8", guest_frames: "270" }),
      buildId,
    );
    expect(() => assertIPhone2GStatusAdvanced(previous, replacement)).toThrow(
      "process was replaced",
    );
  });

  test("derives guest artifacts and native identity from one verified build plan", () => {
    const manifest = JSON.parse(
      readFileSync(join(repository, "apps/iphone2g-demo/pocket.json"), "utf8"),
    );
    manifest.app.output = "renamed-iphone-guest";
    const plan = resolveIPhone2GBuildPlan(manifest);
    const artifacts = deriveIPhone2GGuestArtifacts(plan, "/tmp/guest-output");

    expect(artifacts.javaScript).toBe(
      "/tmp/guest-output/renamed-iphone-guest.js",
    );
    expect(artifacts.pack).toBe("/tmp/guest-output/renamed-iphone-guest.pak");
    expect(artifacts.inputs).toMatchObject({
      appOutput: "renamed-iphone-guest",
      target: "iphone2g-dev",
      hostAbi: POCKET_BINDING_GENERATION,
    });
  });

  test("quotes override paths as single OpenSSH config values", () => {
    expect(quoteOpenSshConfigValue("/tmp/Pocket JS/#keys/device key")).toBe(
      '"/tmp/Pocket JS/#keys/device key"',
    );
    expect(quoteOpenSshConfigValue('/tmp/key "quoted"')).toBe(
      '"/tmp/key \\"quoted\\""',
    );
    expect(quoteOpenSshConfigValue("/tmp/back\\slash")).toBe(
      '"/tmp/back\\\\slash"',
    );
    expect(() => quoteOpenSshConfigValue("/tmp/key\nnext")).toThrow(
      "cannot contain NUL or newlines",
    );
  });

  test("distinguishes an explicit password-policy rejection from transport and credential failures", () => {
    expect(
      classifyPasswordAuthenticationProbe({ exitCode: 0, stderr: "" }),
    ).toBe("accepted");
    expect(
      classifyPasswordAuthenticationProbe({
        exitCode: 255,
        stderr: "root@127.0.0.1: Permission denied (publickey).\n",
      }),
    ).toBe("rejected");
    for (const result of [
      {
        exitCode: 255,
        stderr: "Permission denied (publickey,password).\n",
      },
      { exitCode: 255, stderr: "Connection timed out\n" },
      { exitCode: 255, stderr: "no matching key exchange method found\n" },
      { exitCode: 5, stderr: "Permission denied, please try again.\n" },
    ]) {
      expect(classifyPasswordAuthenticationProbe(result)).toBe("indeterminate");
    }
  });

  test("places a hard deadline on every bootstrap marker wait", async () => {
    const complete = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(Buffer.from("prefix PJS_"));
        controller.enqueue(Buffer.from("BOOTSTRAP_READY\n"));
        controller.close();
      },
    }).getReader();
    const output = { text: "" };
    await readUntilMarker(complete, "PJS_BOOTSTRAP_READY\n", output, 100);
    expect(output.text).toContain("PJS_BOOTSTRAP_READY\n");
    complete.releaseLock();

    const stalled = new ReadableStream<Uint8Array>().getReader();
    try {
      await expect(
        readUntilMarker(stalled, "PJS_BOOTSTRAP_NEVER\n", { text: "" }, 5),
      ).rejects.toThrow("timed out waiting for PJS_BOOTSTRAP_NEVER");
    } finally {
      await stalled.cancel();
      stalled.releaseLock();
    }
  });

  test("generates a bootstrap controller accepted by the shell parser", () => {
    const generated = bootstrapControllerScript("a".repeat(32));
    const syntax = spawnSync("/bin/sh", ["-n"], {
      input: generated,
      encoding: "utf8",
    });
    expect(syntax.status, syntax.stderr).toBe(0);
  });
});
