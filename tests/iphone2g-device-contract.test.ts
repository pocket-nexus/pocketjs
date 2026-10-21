import { POCKET_BINDING_GENERATION } from "../contracts/spec/binding-generation.ts";
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import {
  assertIPhone2GStatusAdvanced,
  bootstrapControllerScript,
  classifyPasswordAuthenticationProbe,
  deriveIPhone2GGuestArtifacts,
  parseIPhone2GDeviceStatus,
  quoteOpenSshConfigValue,
  readUntilMarker,
} from "../tools/iphone2g.ts";
import { resolveIPhone2GBuildPlan } from "../tools/iphone2g-profile.ts";

const repository = fileURLToPath(new URL("..", import.meta.url));
const toolSource = readFileSync(join(repository, "tools/iphone2g.ts"), "utf8");
const deviceSource = readFileSync(
  join(repository, "hosts/iphone2g/device_tool.c"),
  "utf8",
);
const pocketRuntimeSource = readFileSync(
  join(repository, "engine/quickjs-c/pocket_runtime.c"),
  "utf8",
);

function sourceBlock(source: string, pattern: RegExp, label: string): string {
  const match = source.match(pattern);
  if (!match?.[1]) throw new Error(`missing ${label} source block`);
  return match[1];
}

function sourceBetween(
  source: string,
  startMarker: string,
  endMarker: string,
  label: string,
): string {
  const start = source.indexOf(startMarker);
  const end =
    start < 0 ? -1 : source.indexOf(endMarker, start + startMarker.length);
  if (start < 0 || end < 0) throw new Error(`missing ${label} source block`);
  return source.slice(start, end);
}

function withoutWhitespace(source: string): string {
  return source.replace(/\s+/g, "");
}

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
    expect(toolSource).toContain("kill -0 ${pid}");
    expect(toolSource).toContain("await Bun.sleep(1_500)");
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
    expect(toolSource).toContain(
      "rmSync(output, { recursive: true, force: true })",
    );
    expect(toolSource).toContain(
      '`-DPOCKETJS_TARGET_ID="${hostInputs.target}"`',
    );
    expect(toolSource).toContain("`-DPOCKETJS_HOST_ABI=${hostInputs.hostAbi}`");
    expect(pocketRuntimeSource).toContain(
      "POCKETJS_TARGET_ID must come from the verified ResolvedBuildPlan",
    );
    expect(pocketRuntimeSource).not.toContain(
      'JS_NewString(context, "iphone2g-dev")',
    );
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
    expect(toolSource).toContain(
      "IdentityFile ${quoteOpenSshConfigValue(identityPath())}",
    );
    expect(toolSource).toContain(
      "UserKnownHostsFile ${quoteOpenSshConfigValue(knownHosts)}",
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
    expect(toolSource).toContain("await waitForBootstrapRollback(transaction)");
  });

  test("stages only the signed helper, key-only config, and client key", () => {
    const expectedModes = sourceBlock(
      toolSource,
      /const expectedModes:[^=]+ = \[([\s\S]*?)\n    \];/,
      "bootstrap mode manifest",
    );
    const stagedFiles = [
      ...expectedModes.matchAll(/^\s*\["([^"]+)",\s*0o[0-7]+\],?$/gm),
    ].map((match) => match[1]);

    expect(stagedFiles).toEqual([
      "root/usr/libexec/pocketjs-device",
      "root/private/etc/ssh/sshd_config",
      "data/root/.ssh/authorized_keys",
    ]);
    expect(expectedModes).not.toContain("sftp");
    expect(expectedModes).not.toContain("usr/sbin/sshd");
    expect(expectedModes).not.toContain("ssh_host_rsa_key");
    expect(expectedModes).not.toContain("LaunchDaemons");

    const receipt = sourceBetween(
      toolSource,
      'join(stage, "bootstrap-receipt.json")',
      "rmSync(destination",
      "bootstrap receipt",
    );
    const compactReceipt = withoutWhitespace(receipt);
    expect(compactReceipt).toContain("files,");
    expect(compactReceipt).toContain('protocol:"PJS2G003"');
    expect(compactReceipt).toContain("signed:true");
    expect(compactReceipt).toContain('productVersion:"3.1.3"');
    expect(compactReceipt).toContain('buildVersion:"7E18"');
    expect(compactReceipt).toContain('mountPolicy:"rw-root-data"');
    expect(compactReceipt).toContain("passwordAuthentication:false");
    expect(compactReceipt).toContain("preserveDeviceSshd:true");
    expect(compactReceipt).toContain("preserveDeviceHostKey:true");
    expect(compactReceipt).toContain("preserveDeviceLaunchdPlist:true");
    expect(compactReceipt).toContain("sftp:false");
  });

  test("installs bootstrap transactionally before disabling password SSH", () => {
    const compact = withoutWhitespace(toolSource);
    expect(toolSource).toContain("async function installBootstrap()");
    expect(toolSource).toContain("PJS_BOOTSTRAP_KEY_READY");
    expect(toolSource).toContain("PJS_BOOTSTRAP_SECURE_READY");
    expect(toolSource).toContain("PJS_BOOTSTRAP_COMMITTED");
    expect(toolSource).toContain('runBinary("/bin/sh", ["-n"]');
    expect(toolSource).toContain("/usr/sbin/sysctl -n hw.machine");
    expect(toolSource).toContain('"3.1.3\\n7E18\\niPhone1,1\\n"');
    expect(compact.indexOf("verifyInstalledBootstrap(receipt);")).toBeLessThan(
      compact.indexOf('controller.stdin.write("secure\\n")'),
    );
    expect(toolSource).toContain('SSHPASS: "alpine"');
    expect(toolSource).toContain("PreferredAuthentications=password");
    expect(toolSource).toContain("PubkeyAuthentication=no");
    expect(toolSource).toContain("password SSH remained enabled");
    expect(toolSource).toContain("classifyPasswordAuthenticationProbe");
    expect(toolSource).toContain("installedSshPolicyIsSecure(policy)");
    expect(toolSource).toContain('"/usr/sbin/sshd",\n    "-t"');
    expect(toolSource).toContain(
      'receipt.files["root/private/etc/ssh/sshd_config"].sha256',
    );
    expect(toolSource).toContain(
      "preserved CustomHJ sshd, host key, and launchd plist",
    );
    expect(toolSource).toContain("/bin/chown 0:0");
    expect(toolSource).toContain("/bin/sed 's,/,-,g'");
    expect(toolSource).not.toContain("/usr/sbin/chown");
    expect(toolSource).not.toContain("/usr/bin/sed");
    const generated = bootstrapControllerScript("a".repeat(32));
    const syntax = spawnSync("/bin/sh", ["-n"], {
      input: generated,
      encoding: "utf8",
    });
    expect(syntax.status, syntax.stderr).toBe(0);
  });

  test("scopes legacy SSH algorithms and manages the USB tunnel", () => {
    for (const option of [
      "HostKeyAlgorithms=+ssh-rsa",
      "PubkeyAcceptedAlgorithms=+ssh-rsa",
      "diffie-hellman-group14-sha1",
      "diffie-hellman-group1-sha1",
      "aes128-cbc",
      "3des-cbc",
      "hmac-sha1",
      "hmac-md5",
    ]) {
      expect(toolSource).toContain(option);
    }
    expect(toolSource).toContain("async function withManagedTunnel");
    expect(toolSource).toContain('command === "tunnel"');
    expect(toolSource).toContain('command === "install-bootstrap"');
  });

  test("keeps the host encoder and ARMv6 receiver on one fixed framed bundle schema", () => {
    const hostFiles = sourceBlock(
      toolSource,
      /const DEVICE_BUNDLE_FILES = \[([\s\S]*?)\] as const;/,
      "host bundle file manifest",
    );
    const deviceFiles = sourceBlock(
      deviceSource,
      /static const BundleFile BUNDLE_FILES\[\] = \{([\s\S]*?)\n\};/,
      "device bundle file manifest",
    );
    const hostNames = [...hostFiles.matchAll(/"([^"]+)"/g)].map(
      (match) => match[1],
    );
    const deviceNames = [...deviceFiles.matchAll(/\{"([^"]+)",/g)].map(
      (match) => match[1],
    );

    expect(hostNames).toEqual([
      "PocketJSDemo",
      "Info.plist",
      "PkgInfo",
      "Icon.png",
      "build-receipt.json",
    ]);
    expect(deviceNames).toEqual(hostNames);
    expect(toolSource).toContain('join(repository, "hosts/iphone2g/Icon.png")');
    expect(toolSource).not.toContain(
      'join(repository, "assets/images/logo.png"), join(bundle, "Icon.png")',
    );
    expect(toolSource).toContain('Buffer.from("PJS2G003", "ascii")');
    expect(toolSource).toContain('Buffer.from(identifier, "ascii")');
    expect(toolSource).toContain(
      "length.writeBigUInt64BE(BigInt(bytes.length))",
    );
    expect(deviceSource).toContain(
      "static const unsigned char PACKAGE_MAGIC[8] = {'P', 'J', 'S', '2', 'G', '0', '0', '3'};",
    );
    expect(deviceSource).toContain("result = (result << 8) | encoded[index]");
    expect(deviceSource).toContain("bundle stream has trailing bytes");
    expect(deviceSource).toContain("transaction=pending");
    const compactToolSource = withoutWhitespace(toolSource);
    expect(compactToolSource).toMatch(
      /deviceCommand\(\["\/usr\/libexec\/pocketjs-device","commit",identifier,?\]\)/,
    );
    expect(compactToolSource).toMatch(
      /deviceCommand\(\["\/usr\/libexec\/pocketjs-device","rollback",identifier,?\]\)/,
    );
    expect(toolSource).toContain("ensureDeviceMountPolicy()");
    expect(toolSource).toContain("recoverPendingDeviceTransaction()");
    expect(toolSource).toContain(
      "cd / && /bin/su mobile -c '/usr/bin/uicache'",
    );
    expect(deviceSource).toContain('strcmp(argv[1], "transaction-state")');
    expect(deviceSource).toContain('strcmp(argv[1], "mount-state")');
    expect(deviceSource).not.toContain('run_mount("-ur")');
    expect(deviceSource).not.toContain('run_mount("-uw")');
    expect(deviceSource).toContain('mount_is_read_write("/")');
    expect(deviceSource).toContain('mount_is_read_write("/private/var")');
  });

  test("records the actual linked sysroot and deployed bundle bytes in its receipts", () => {
    expect(toolSource).toContain("const sysrootFiles = Object.fromEntries(");
    expect(toolSource).toContain(
      "Object.keys(IPHONE2G_TOOLCHAIN.compiler.sysrootFiles)",
    );
    expect(toolSource).toContain("sysrootRawSha256: sha256File(");
    expect(toolSource).toContain("bundleFiles,");
    expect(toolSource).toContain("buildId,");
    expect(toolSource).toContain("hostTools,");
    expect(toolSource).toContain("fields.build_id !== expectedBuildId");
    expect(toolSource).toContain('receiptMode: "0644"');
    expect(toolSource).toContain("signed: true");
    expect(toolSource).toContain('signer: "ldid -S"');
    expect(toolSource).toContain('mustRun(ldid, ["-S", executable])');
    expect(toolSource).toContain('mustRun(ldid, ["-S", output])');
    expect(toolSource).toContain('loadCommands.includes("LC_CODE_SIGNATURE")');
    expect(toolSource).toContain(
      "GraphicsServices must remain a dlsym-only 1.x fallback on 3.1.3",
    );
    expect(withoutWhitespace(toolSource)).toMatch(
      /sourceSha256:sha256File\(join\(repository,"hosts\/iphone2g\/device_tool\.c",?\),?\)/,
    );
  });

  test("treats device-status as live released-action acceptance", () => {
    expect(toolSource).toContain("const positiveAcceptanceCounters");
    expect(toolSource).toContain('"guest_frames"');
    expect(toolSource).toContain('"touch_sequences"');
    expect(toolSource).toContain('"completed_touch_sequences"');
    expect(toolSource).toContain("fields.action_name !== expectedAction");
    expect(toolSource).toContain('expectedAction: string = "hero_tap"');
    expect(toolSource).toContain('fields.touch_down !== "0"');
    expect(toolSource).toContain('fields.state !== "running"');
    expect(toolSource).toContain("assertDeviceProcessAlive");
    expect(toolSource).toContain("assertIPhone2GStatusAdvanced");
    expect(toolSource).toContain(
      "runtime acceptance requires a released touch and a completed ${expectedAction} action",
    );
  });

  test("launches only the currently deployed build through SpringBoard", () => {
    expect(toolSource).toContain('command === "launch"');
    expect(toolSource).toContain('"pocketjs-iphone2g-demo://launch"');
    expect(toolSource).toContain('"/usr/bin/uiopen"');
    expect(toolSource).toContain(
      "installed app does not match the current local build; deploy first",
    );
  });
});
