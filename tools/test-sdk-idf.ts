#!/usr/bin/env bun
import { POCKET_BINDING_GENERATION } from "../contracts/spec/binding-generation.ts";
import { createHash } from "node:crypto";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { NODE_TYPE, PROP, ROOT_ID } from "../contracts/spec/spec.ts";
import { encodeIdentity, encodePocketPackage, POCKET_SECTION } from "../contracts/spec/pocket-package.ts";
import { canonicalProfileJson, type PocketProfile } from "../contracts/spec/profile.ts";
import { profileFactsC } from "./profile-export.ts";

const root = resolve(import.meta.dir, "..");
const args = Bun.argv.slice(2);
function take(name: string): string | undefined {
  const at = args.indexOf(name);
  if (at < 0) return;
  const value = args[at + 1];
  if (!value || value.startsWith("--")) throw new Error(`${name} requires a value`);
  args.splice(at, 2); return resolve(value);
}
const hostSdk = take("--host-sdk"), sdk = take("--sdk"), quickjs = take("--quickjs"), idf = take("--idf");
const artifacts = take("--artifacts") ?? join(root, ".pocket-build/validation/sdk-idf", `${Date.now()}-${process.pid}`);
const hostOnly = args.includes("--host-only");
if (hostOnly) args.splice(args.indexOf("--host-only"), 1);
if (args.length || !hostSdk || !quickjs || (!hostOnly && (!sdk || !idf)))
  throw new Error("usage: test-sdk-idf --host-sdk DIR --quickjs DIR [--host-only | --sdk DIR --idf DIR] [--artifacts DIR]");
mkdirSync(artifacts, { recursive: true });
const external = mkdtempSync(join(tmpdir(), "pocket-sdk-idf-"));
const consumer = join(external, "consumer");
cpSync(join(root, "tests/fixtures/sdk-idf"), consumer, { recursive: true });
cpSync(hostSdk, join(external, "sdk-host"), { recursive: true });
if (sdk) cpSync(sdk, join(external, "sdk-idf"), { recursive: true });
cpSync(quickjs, join(external, "quickjs"), { recursive: true,
  filter: path => !path.split(/[\\/]/).some(name => name === ".git" || name === "build" || name === "node_modules") });
const sha256 = (bytes: Uint8Array | string) => createHash("sha256").update(bytes).digest("hex");
const fixtureProfile: PocketProfile = { id: "external-idf", platform: "esp-idf", form: "takeover", tickHz: 60, display: {
  physicalViewport: [32, 24], logicalViewports: [[32, 24]], presentations: ["native"], rasterDensity: 1,
}, capabilities: ["input.buttons"] };
const profile = canonicalProfileJson(fixtureProfile);
const script = `
const root=ui.createNode(${NODE_TYPE.view});ui.insertBefore(${ROOT_ID},root,0);
ui.setProp(root,${PROP.width},32);ui.setProp(root,${PROP.height},24);
ui.setProp(root,${PROP.gradFrom},0xff000020);ui.setProp(root,${PROP.gradTo},0xffff8000);ui.setProp(root,${PROP.gradDir},0);
const box=ui.createNode(${NODE_TYPE.view});ui.insertBefore(root,box,0);
ui.setProp(box,${PROP.width},8);ui.setProp(box,${PROP.height},8);ui.setProp(box,${PROP.posType},1);
ui.setProp(box,${PROP.insetL},3);ui.setProp(box,${PROP.insetT},5);ui.setProp(box,${PROP.bgColor},0xff0000ff);
globalThis.frame=(buttons)=>ui.setProp(box,${PROP.bgColor},buttons?0xff00ff00:0xff0000ff);
`;
// Maintained fixture for the current package contract and independent profile.
function packageBytes(): Uint8Array {
  const bytes = (text: string) => new TextEncoder().encode(text);
  return encodePocketPackage({ manifest: bytes("{}"), variants: [{ target: "external-idf", hostAbi: POCKET_BINDING_GENERATION,
    profileHash: `sha256:${sha256(profile)}`, sections: [
    { kind: POCKET_SECTION.identity, bytes: encodeIdentity({ output: "sdk", id: "test.sdk", title: "SDK consumer" }) },
    { kind: POCKET_SECTION.plan, bytes: bytes('{"animation":"repaint","profile":{"tickHz":60},"viewport":{"logical":[32,24],"presentation":"native","rasterDensity":1},"features":{}}') },
    { kind: POCKET_SECTION.js, bytes: bytes(script + "\0") },
  ] }] });
}
const cArray = (name: string, bytes: Uint8Array) => `static const uint8_t ${name}[]={${[...bytes].join(",")}};\n`;
writeFileSync(join(consumer, "fixture_data.h"), "#include <pocket/runtime.h>\n" +
  profileFactsC(fixtureProfile, "fixture_profile") +
  cArray("fixture_profile_hash", createHash("sha256").update(profile).digest()) +
  cArray("fixture_package", packageBytes()));
const commands: Array<{ args: string[]; log: string; exitCode: number; signalCode: string | null }> = [];
function run(command: string[], name: string): string {
  const result = Bun.spawnSync(command, { cwd: external, stdout: "pipe", stderr: "pipe" });
  const output = result.stdout.toString() + result.stderr.toString();
  const log = join(artifacts, `${name}.log`); writeFileSync(log, output);
  commands.push({ args: command, log, exitCode: result.exitCode, signalCode: result.signalCode ?? null });
  if (!result.success) throw new Error(`${name} failed (${result.signalCode ?? result.exitCode}); ${log}\n${output.slice(-8000)}`);
  console.log(`${name}: passed`); return result.stdout.toString();
}
const receipt: Record<string, unknown> = {
  kind: "external-sdk-idf-consumer", external, artifacts,
  hostSdkManifestSha256: sha256(readFileSync(join(external, "sdk-host/sdk-manifest.json"))),
  quickjsSourceSha256: sha256(readFileSync(join(external, "quickjs/quickjs.c"))),
  hostPpa: "mock; not hardware evidence", deviceExecution: "deferred to final acceptance",
  oldQuickjsPinGate: "not used; existing old-component pin remains separately blocked", commands,
};
try {
  run(["cmake", "-S", consumer, "-B", join(external, "host-build"), "-DPOCKET_HOST_TEST=ON",
    "-DCMAKE_EXPORT_COMPILE_COMMANDS=ON",
    `-DPOCKET_SDK=${join(external, "sdk-host")}`, `-DPOCKET_QUICKJS=${join(external, "quickjs")}`], "host-configure");
  run(["cmake", "--build", join(external, "host-build"), "-j", "4"], "host-build");
  if (readFileSync(join(external, "host-build/compile_commands.json"), "utf8").includes(root))
    throw new Error("C consumer compilation references the PocketJS checkout");
  receipt.hostResult = run([join(external, "host-build/consumer")], "host-execute").trim();
  if (!(receipt.hostResult as string).includes("SDK consumer passed:")) throw new Error("missing consumer success marker");
  if (!hostOnly) {
    receipt.idfSdkManifestSha256 = sha256(readFileSync(join(external, "sdk-idf/sdk-manifest.json")));
    const shell = 'fixture_idf="$1"; shift; source "$fixture_idf/export.sh" >/dev/null && exec python "$fixture_idf/tools/idf.py" "$@"';
    const invoke = (...params: string[]) => ["bash", "-c", shell, "sdk-fixture", idf!, "-C", consumer, "-B", join(external, "idf-build"), ...params];
    run(invoke(`-DPOCKET_SDK=${join(external, "sdk-idf")}`, `-DPOCKET_QUICKJS=${join(external, "quickjs")}`, "set-target", "esp32p4"), "idf-target");
    run(invoke(`-DPOCKET_SDK=${join(external, "sdk-idf")}`, `-DPOCKET_QUICKJS=${join(external, "quickjs")}`, "build"), "idf-build");
    if (readFileSync(join(external, "idf-build/compile_commands.json"), "utf8").includes(root))
      throw new Error("IDF consumer compilation references the PocketJS checkout");
    const firmware = join(external, "idf-build/pocket_sdk_consumer.bin");
    if (!existsSync(firmware)) throw new Error("IDF build did not produce firmware");
    receipt.firmwareSha256 = sha256(readFileSync(firmware));
    receipt.firmwareBytes = readFileSync(firmware).length;
    receipt.idfVersion = run(invoke("--version"), "idf-version").trim();
  }
  receipt.status = "passed";
} catch (error) {
  receipt.status = "failed"; receipt.error = String(error); throw error;
} finally {
  writeFileSync(join(artifacts, "build-receipt.json"), JSON.stringify(receipt, null, 2) + "\n");
  console.log(`External consumer: ${external}\nReceipt: ${join(artifacts, "build-receipt.json")}`);
}
