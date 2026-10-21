#!/usr/bin/env bun
import { cpSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { createHash } from "node:crypto";
import { verifySdk } from "../../release/receipt.ts";
const root=resolve(import.meta.dir,"../../..");
const args=Bun.argv.slice(2);
function take(name:string):string|undefined { const i=args.indexOf(name);if(i<0)return;const value=args[i+1];if(!value||value.startsWith("--"))throw new Error(`${name} needs a value`);args.splice(i,2);return value; }
const zephyr=resolve(take("--zephyr")??process.env.ZEPHYR_BASE??"");
const sdk=take("--sdk");const archive=take("--archive");const quickjs=take("--quickjs");
const out=resolve(take("--out")??join(root,".pocket-build/validation/zephyr/native"));
if(process.platform!=="linux" || args.length || (!sdk && !archive) || (sdk && archive) || !existsSync(join(zephyr,"VERSION")))throw new Error("Run on Linux: test-native --zephyr <Zephyr checkout> (--sdk <SDK> | --archive <native archive>) [--out directory]");
mkdirSync(out,{recursive:true});
const commands:{args:string[];exitCode:number;signal:string|null;log:string;expectedFailure:boolean}[]=[];
function run(command:string[],name:string,expectedFailure=false) {
 const log=join(out,`${name}.log`);
 const child=Bun.spawnSync(command,{cwd:root,env:{...process.env,ZEPHYR_BASE:zephyr,ZEPHYR_TOOLCHAIN_VARIANT:"host",SDL_VIDEODRIVER:"dummy",XDG_RUNTIME_DIR:out},stdout:"pipe",stderr:"pipe"});
 writeFileSync(log,Buffer.concat([child.stdout,child.stderr]));
 commands.push({args:command,exitCode:child.exitCode,signal:child.signalCode??null,log,expectedFailure});
 writeFileSync(join(out,"commands.json"),JSON.stringify(commands,null,2)+"\n");
 if(expectedFailure ? child.success || !!child.signalCode : !child.success)throw new Error(`${name} unexpected outcome; see ${log}`);
 return child.stdout.toString()+child.stderr.toString();
}
run([process.execPath,join(root,"tools/pocket.ts"),"profile","export","--config",join(root,"tests/fixtures/zephyr/native_sim/pocket.runtime-config.ts"),"--out",join(out,"profile")],"profile");
const sdkManifest=sdk?verifySdk(resolve(sdk)):undefined;
const configure=(build:string,profile:string)=>["cmake","-S",join(root,"tests/fixtures/zephyr/native_sim"),"-B",build,"-G","Ninja","-DBOARD=native_sim/native/64",`-DPOCKET_PROFILE_EXPORT_DIR=${profile}`,...(quickjs?["-DCONFIG_POCKETJS_GUEST_QUICKJS=y",`-DPOCKET_TEST_QUICKJS=${resolve(quickjs)}`]:[]),...(sdk?[`-DPOCKET_SDK=${resolve(sdk)}`]:[`-DPOCKET_RUNTIME_ARCHIVE=${resolve(archive!)}`])];
run(configure(join(out,"build"),join(out,"profile")),"configure");
run(["cmake","--build",join(out,"build"),"-j","4"],"build");
const executable=join(out,"build/zephyr/zephyr.exe");
const output=run([executable],"execute");if(!output.includes("Zephyr driver contracts passed"))throw new Error("native_sim did not reach the assertions");
cpSync(join(out,"profile"),join(out,"wrong-profile"),{recursive:true});
const wrong=join(out,"wrong-profile/pocket_profile.h");writeFileSync(wrong,readFileSync(wrong,"utf8").replace("#define POCKET_PROFILE_WIDTH 8u","#define POCKET_PROFILE_WIDTH 9u"));
run(configure(join(out,"wrong-build"),join(out,"wrong-profile")),"wrong-configure");
const rejected=run(["cmake","--build",join(out,"wrong-build"),"-j","4"],"wrong-build",true);
if(!rejected.includes("Profile width disagrees"))throw new Error("wrong profile failed for an unrelated reason");
const sha256=(path:string)=>createHash("sha256").update(readFileSync(path)).digest("hex");
writeFileSync(join(out,"receipt.json"),JSON.stringify({kind:"zephyr-native-driver-contract",zephyrRevision:run(["git","-C",zephyr,"rev-parse","HEAD"],"zephyr-revision").trim(),executableSha256:sha256(executable),archiveSha256:sha256(sdk?join(resolve(sdk),sdkManifest!.build.archive):resolve(archive!)),quickjsSourceSha256:quickjs?sha256(join(resolve(quickjs),"quickjs.c")):null,profileSha256:sha256(join(out,"profile/pocket-profile.json")),commands},null,2)+"\n");
console.log(`Zephyr native_sim contracts passed: ${out}`);
