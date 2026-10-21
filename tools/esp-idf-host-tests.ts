#!/usr/bin/env bun
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
const root = resolve(fileURLToPath(new URL("..", import.meta.url)));
const output = resolve(process.env.POCKETJS_HOST_TEST_BUILD ?? join(root, ".pocket-build/validation/idf-canonical/host"));
mkdirSync(output,{recursive:true});
const quickjs = resolve(process.env.POCKETJS_QUICKJS_SOURCE ?? join(root,
 "hosts/esp-idf/examples/smoke/managed_components/espressif__quickjs-ng/quickjs-ng"));
function run(cmd:string[],env:Record<string,string|undefined>=process.env){
 const result=Bun.spawnSync(cmd,{cwd:root,env,stdout:"inherit",stderr:"inherit"});
 if(!result.success)throw new Error(`command failed (${result.signalCode ?? result.exitCode}): ${cmd.join(" ")}`);
}
const pkg=join(root,"hosts/esp-idf/examples/prebuilt/idf-smoke.pocket");
run(["python3","hosts/esp-idf/components/pocket_runtime/tools/embed_package.py","--package",pkg,"--host-profile","hosts/esp-idf/examples/smoke/pocket.host.json","--name","host","--output-dir",output]);
const embedded=join(output,"pocketjs_package_host.c");
writeFileSync(embedded,readFileSync(embedded,"utf8").replace("extern const uint8_t pocketjs_package_host_start[];",`const uint8_t pocketjs_package_host_start[] = {${[...readFileSync(pkg)].join(",")}};`));
run(["cargo","+stable","build","--locked","--release","--no-default-features","--manifest-path","hosts/esp-idf/native/runtime/Cargo.toml"],
 {...process.env,CARGO_ENCODED_RUSTFLAGS:"",RUSTFLAGS:"",RUSTC_WRAPPER:"",RUSTC_WORKSPACE_WRAPPER:"",CARGO_TARGET_DIR:join(output,"cargo")});
run(["cmake","-S","hosts/esp-idf/tests/host","-B",output,"-G","Ninja",`-DPOCKETJS_QUICKJS_SOURCE=${quickjs}`,`-DPOCKET_RUNTIME_ARCHIVE=${join(output,"cargo/release/libpocket_idf_runtime.a")}`]);
run(["cmake","--build",output,"-j","4"]);
run(["ctest","--test-dir",output,"--output-on-failure"]);
console.log(`ESP-IDF host regression artifacts: ${output}`);
