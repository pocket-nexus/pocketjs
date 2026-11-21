import { createHash } from "node:crypto";
import { cpSync, existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, readlinkSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { addTarget, escapingLinks, unsafeEntries } from "../../targets/install.ts";
import { publishStagedDirectory, uniqueSuffix, withArtifactLock, withSharedLock } from "../../targets/lock.ts";
import { storeLayout, storeLock, storeTree } from "../../targets/store.ts";
import { validateToolchain, type ToolchainManifest } from "../../targets/toolchain.ts";
import { currentHost, type HostId } from "../../targets/types.ts";

export interface VitaSdkArchive {
  readonly name: string;
  readonly file: string;
  readonly url: string;
  readonly sha256: string;
  readonly root?: string;
  readonly destination: "." | "arm-vita-eabi";
  readonly markers: readonly string[];
}
/** Release v2.540 plus the exact ports used by the generic Vita runtime.
 * The ports' upstream tag is mutable: SHA mismatch must fail, never upgrade. */
export const VITA_RELEASE_SDK_ARCHIVES = [
  { name: "sdk", file: "vitasdk.tar.bz2", root: "vitasdk", destination: ".",
    url: "https://github.com/vitasdk/autobuilds/releases/download/master-osx-v2.540/vitasdk-arm64-apple-darwin-2026-05-24_12-05-09.tar.bz2",
    sha256: "28b28fb108269dbe1657f72cb74824f6bb3cdd5c8084b9028d386f22a44c9a53",
    markers: ["bin/arm-vita-eabi-gcc", "bin/vita-elf-create", "bin/vita-mksfoex", "share/vita.cmake", "arm-vita-eabi/include/psp2/kernel/processmgr.h"] },
  { name: "vita2d", file: "libvita2d.tar.xz", destination: "arm-vita-eabi",
    url: "https://github.com/vitasdk/packages/releases/download/master/libvita2d.tar.xz",
    sha256: "f2688386ca15e030450223812c65beea4d1ce930a79b8a99d04f99b55ab1a455", markers: ["include/vita2d.h", "lib/libvita2d.a"] },
  { name: "png", file: "libpng.tar.xz", destination: "arm-vita-eabi",
    url: "https://github.com/vitasdk/packages/releases/download/master/libpng.tar.xz",
    sha256: "e502fac413e17b75a06f8f2a88f87daec13d83a33e9206713a0612ee245b72b8", markers: ["include/png.h", "lib/libpng.a"] },
  { name: "jpeg", file: "libjpeg-turbo.tar.xz", destination: "arm-vita-eabi",
    url: "https://github.com/vitasdk/packages/releases/download/master/libjpeg-turbo.tar.xz",
    sha256: "87511c384b36f944655e298140f24215f3da8b59821deddca0f6a9c5e3438b78", markers: ["include/jpeglib.h", "lib/libjpeg.a"] },
  { name: "zlib", file: "zlib.tar.xz", destination: "arm-vita-eabi",
    url: "https://github.com/vitasdk/packages/releases/download/master/zlib.tar.xz",
    sha256: "f39cea16c176f93dc744597113f093db0d48adf23dd25a14ee0d2ec47df17fa6", markers: ["include/zlib.h", "lib/libz.a"] },
] as const satisfies readonly VitaSdkArchive[];

const RECEIPT = ".pocket-vita-sdk.json";
const digest = (value: Uint8Array | string) => createHash("sha256").update(value).digest("hex");
const relativePath = (value: string) => value.length > 0 && !value.includes("\\") && !value.startsWith("/") && !value.split("/").some(part => !part || part === ".." || part === ".");
function run(command: string[], env: NodeJS.ProcessEnv): string {
  const result = Bun.spawnSync(command, { env, stdout: "pipe", stderr: "pipe" });
  if (!result.success) throw new Error(`Vita SDK: ${command[0]} failed (${result.signalCode ?? result.exitCode}): ${result.stderr.toString().trim()}`);
  return result.stdout.toString();
}
/** Includes every installed file, mode and relative symlink, excluding only
 * the installer receipt. Cache hits detect modified tools and extra files. */
function treeDigest(root: string): string {
  const hash = createHash("sha256");
  function walk(directory: string, prefix: string) {
    for (const name of readdirSync(directory).sort()) {
      if (!prefix && name === RECEIPT) continue;
      const path = join(directory, name), relative = prefix + name, stat = lstatSync(path);
      hash.update(JSON.stringify([relative, stat.mode & 0o777]));
      if (stat.isSymbolicLink()) hash.update(`link:${readlinkSync(path)}`);
      else if (stat.isDirectory()) { hash.update("directory"); walk(path, `${relative}/`); }
      else if (stat.isFile()) hash.update(`file:${digest(readFileSync(path))}`);
      else throw new Error(`Vita SDK: unsupported installed entry ${relative}`);
    }
  }
  walk(root, "");
  return hash.digest("hex");
}

/** Bundle assembly shared with fixture tests. Production calls use only the
 * pinned archive list below. Raw archives remain in the common CAS, allowing
 * their SHA to be checked again before a cached extracted SDK is reused. */
export async function installVitaSdkBundle(outdir: string, archives: readonly VitaSdkArchive[], options: {
  readonly env?: NodeJS.ProcessEnv;
  readonly host?: HostId | null;
  readonly log?: (line: string) => void;
} = {}): Promise<string> {
  const host = options.host === undefined ? currentHost() : options.host;
  if (host !== "darwin-arm64") throw new Error(`Vita release SDK supports darwin-arm64 only; got ${host ?? "unsupported host"}`);
  if (!archives.length || archives[0]!.destination !== ".") throw new Error("Vita SDK: base archive must come first");
  for (const archive of archives) {
    if ((archive.destination !== "." && archive.destination !== "arm-vita-eabi") ||
        (archive.root !== undefined && !relativePath(archive.root)) || !archive.markers.length ||
        archive.markers.some(marker => !relativePath(marker))) throw new Error("Vita SDK: invalid archive layout");
  }
  const env = options.env ?? process.env;
  const manifest: ToolchainManifest = { schema: "pocket-toolchain/2", target: "vita-release-sdk",
    components: archives.map(archive => ({ name: archive.name, kind: "file", role: "toolchain",
      file: archive.file, source: { url: archive.url, sha256: archive.sha256 } })) };
  const problems = validateToolchain(manifest, manifest.target);
  if (problems.length) throw new Error(`Vita SDK: ${problems.join("; ")}`);
  const identity = digest(JSON.stringify(archives));
  const sdk = resolve(outdir, "vitasdk");
  return withArtifactLock(`${sdk}.lock`, async () => {
    const record = await addTarget({ id: manifest.target, title: "Vita release SDK", hosts: ["darwin-arm64"], toolchain: manifest }, { env, host, log: options.log });
    const layout = storeLayout(env);
    return withSharedLock(storeLock(layout), async () => {
      const paths = archives.map(archive => {
        const component = record.components[archive.name]!;
        if (!("store" in component.location)) throw new Error("Vita SDK: expected a stored archive");
        const path = join(storeTree(layout, component.location.store), archive.file);
        if (!lstatSync(path).isFile() || digest(readFileSync(path)) !== archive.sha256) {
          throw new Error(`Vita SDK: cached archive SHA-256 mismatch: ${path}`);
        }
        return path;
      });
      if (existsSync(sdk)) {
        if (!lstatSync(sdk).isDirectory()) throw new Error(`Vita SDK: destination is not an owned SDK directory: ${sdk}`);
        let receipt: { identity?: string; treeSha256?: string };
        try { receipt = JSON.parse(readFileSync(join(sdk, RECEIPT), "utf8")); }
        catch { throw new Error(`Vita SDK: refusing existing unmanaged directory ${sdk}`); }
        if (receipt.identity !== identity || receipt.treeSha256 !== treeDigest(sdk)) {
          throw new Error(`Vita SDK: installed tree differs from its pinned receipt: ${sdk}`);
        }
        return sdk;
      }
      mkdirSync(dirname(sdk), { recursive: true });
      const staging = `${sdk}.stage-${uniqueSuffix()}`, tree = join(staging, "tree");
      mkdirSync(tree, { recursive: true });
      try {
        for (const [index, archive] of archives.entries()) {
          const names = run(["tar", "-tf", paths[index]!], env).split("\n").filter(Boolean);
          if (unsafeEntries(names).length) throw new Error(`Vita SDK: archive entries escape staging: ${archive.file}`);
          const extracted = join(staging, `extract-${index}`);
          mkdirSync(extracted);
          run(["tar", "-xf", paths[index]!, "-C", extracted], env);
          if (escapingLinks(extracted).length) throw new Error(`Vita SDK: archive links escape staging: ${archive.file}`);
          const source = archive.root ? join(extracted, archive.root) : extracted;
          if (!existsSync(source) || !lstatSync(source).isDirectory() || archive.markers.some(marker => !existsSync(join(source, marker)))) {
            throw new Error(`Vita SDK: missing archive root or markers: ${archive.file}`);
          }
          const destination = archive.destination === "." ? tree : join(tree, archive.destination);
          mkdirSync(destination, { recursive: true });
          cpSync(source, destination, { recursive: true, verbatimSymlinks: true });
          rmSync(extracted, { recursive: true, force: true });
        }
        const escapes = escapingLinks(tree);
        if (escapes.length) throw new Error(`Vita SDK: merged SDK links escape: ${escapes.join(", ")}`);
        writeFileSync(join(tree, RECEIPT), `${JSON.stringify({ schema: "pocket-vita-sdk/1", host, identity, archives, treeSha256: treeDigest(tree) }, null, 2)}\n`);
        publishStagedDirectory(tree, sdk);
        return sdk;
      } finally { rmSync(staging, { recursive: true, force: true }); }
    });
  }, { timeoutMs: 60 * 60_000 });
}

/** Return <outdir>/vitasdk. The only supported release host is darwin-arm64. */
export async function installVitaReleaseSdk(outdir: string): Promise<string> {
  return installVitaSdkBundle(outdir, VITA_RELEASE_SDK_ARCHIVES);
}
