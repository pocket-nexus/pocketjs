/** Build the test-only event sender after `bun ipodtouch4 build`. */
import { resolve, join } from "node:path";
import { ipodtouch4SysrootPath } from "../ipodtouch4-toolchain.ts";
const root = resolve(import.meta.dir, "../..");
const directory = join(root, ".pocket-build/ipodtouch4/clear/runtime");
const output = join(root, ".pocket-build/pocket-ime-gstap");
function run(args: string[]) {
  const result = Bun.spawnSync(args, { stdout: "pipe", stderr: "pipe" });
  if (result.exitCode) throw new Error(result.stderr.toString());
  return result.stdout.toString().trim();
}
const sdk = run(["xcrun", "--sdk", "macosx", "--show-sdk-path"]);
run(["xcrun", "clang", "-target", "armv7-apple-ios6.0", "-miphoneos-version-min=6.0", "-Os", "-fno-stack-protector",
  "-Wno-incompatible-sysroot", "-isysroot", sdk, "-c", join(import.meta.dir, "ipod-tap.c"), "-o", `${output}.o`]);
run(["xcrun", "ld-classic", "-arch", "armv7", "-syslibroot", ipodtouch4SysrootPath(), "-L/usr/lib",
  "-iphoneos_version_min", "6.0", "-no_pie", "-no_uuid", "-no_function_starts", "-no_data_in_code_info", "-no_source_version",
  "-no_compact_unwind", "-no_adhoc_codesign", "-no_encryption", "-e", "start", "-o", output,
  join(directory, "csu-start.o"), join(directory, "csu-dyld-glue.o"), join(directory, "crt_globals.o"), `${output}.o`, "-lSystem", "-lgcc_s.1"]);
run(["ldid", "-S", output]);
console.log(output);
