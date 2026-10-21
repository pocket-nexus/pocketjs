#!/usr/bin/env bun
import { STABLE_RUST_TOOLCHAIN } from "../../build/toolchains/rust.ts";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
const root = resolve(fileURLToPath(new URL("../../..", import.meta.url)));
const output = resolve(process.env.POCKETJS_HOST_TEST_BUILD ?? join(root, ".pocket-build/validation/idf-canonical/host"));
mkdirSync(output,{recursive:true});
const quickjs = resolve(process.env.POCKETJS_QUICKJS_SOURCE ?? join(root,
 "tests/esp-idf/examples/smoke/managed_components/espressif__quickjs-ng/quickjs-ng"));
function run(cmd:string[],env:Record<string,string|undefined>=process.env){
 const result=Bun.spawnSync(cmd,{cwd:root,env,stdout:"inherit",stderr:"inherit"});
 if(!result.success)throw new Error(`command failed (${result.signalCode ?? result.exitCode}): ${cmd.join(" ")}`);
}
const pkg=join(root,"tests/esp-idf/examples/prebuilt/idf-smoke.pocket");
run([process.execPath,"tools/pocket.ts","profile","export","--config","tests/esp-idf/examples/smoke/pocket.runtime-config.ts","--out",output]);
run(["python3","platforms/esp-idf/pocket_runtime/tools/embed_package.py","--package",pkg,"--profile",join(output,"pocket-profile.json"),"--name","host","--output-dir",output]);
const embedded=join(output,"pocketjs_package_host.c");
writeFileSync(embedded,readFileSync(embedded,"utf8").replace("extern const uint8_t pocketjs_package_host_start[];",`const uint8_t pocketjs_package_host_start[] = {${[...readFileSync(pkg)].join(",")}};`));
run(["cargo",`+${STABLE_RUST_TOOLCHAIN}`,"build","--locked","--release","--no-default-features","--manifest-path","programs/esp-idf/archive/Cargo.toml"],
 {...process.env,CARGO_ENCODED_RUSTFLAGS:"",RUSTFLAGS:"",RUSTC_WRAPPER:"",RUSTC_WORKSPACE_WRAPPER:"",CARGO_TARGET_DIR:join(output,"cargo"),CARGO_PROFILE_RELEASE_PANIC:"abort",CARGO_PROFILE_RELEASE_LTO:"false",CARGO_PROFILE_RELEASE_CODEGEN_UNITS:"16",CARGO_PROFILE_RELEASE_OPT_LEVEL:"3"});
run(["cmake","-S","tests/esp-idf/host","-B",output,"-G","Ninja",`-DPOCKETJS_QUICKJS_SOURCE=${quickjs}`,`-DPOCKET_RUNTIME_ARCHIVE=${join(output,"cargo/release/libpocket_idf_runtime.a")}`]);
run(["cmake","--build",output,"-j","4"]);
run(["ctest","--test-dir",output,"--output-on-failure"]);
console.log(`ESP-IDF host regression artifacts: ${output}`);
