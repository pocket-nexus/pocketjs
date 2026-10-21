#!/usr/bin/env bun
// Build the C guest against the same QuickJS-NG source that Cargo resolved for
// the Rust guest. A caller can supply another supported source directory.
import { dirname, join, resolve } from "node:path";
const root=resolve(import.meta.dir,"..");
const bellard=process.argv.includes("--bellard");
let source=process.argv.slice(2).find(arg=>arg!=="--bellard");
if(!source) {
  const metadata=Bun.spawnSync(["cargo","metadata","--locked","--format-version=1","--manifest-path",join(root,bellard?"programs/vita/Cargo.toml":"Cargo.toml")],{stdout:"pipe",stderr:"pipe"});
  if(!metadata.success) {process.stderr.write(metadata.stderr);process.exit(metadata.exitCode || 1);}
  const packages=JSON.parse(metadata.stdout.toString()).packages as {name:string;manifest_path:string;source:string|null;dependencies:{name:string;source:string|null}[]}[];
  const pinned=packages.find(pkg=>pkg.name==="pocketjs-vita")?.dependencies.find(dep=>dep.name==="libquickjs-sys")?.source;
  const engine=packages.find(pkg=>bellard ? pkg.name==="libquickjs-sys" && !!pinned && pkg.source?.startsWith(`${pinned}#`) : pkg.name==="rquickjs-sys");
  if(!engine) throw new Error("Cargo metadata has no rquickjs-sys package");
  source=join(dirname(engine.manifest_path),...(bellard?["embed","quickjs"]:["quickjs"]));
}
const output=join(root,".pocket-build/validation/ui-bindings",`quickjs-${bellard?"bellard":"ng"}-${process.pid}`);
const run=Bun.spawnSync(["sh",join(root,"engine/guest-quickjs/tests/run.sh"),source,output,bellard?"bellard":"ng"],{cwd:root,stdout:"inherit",stderr:"inherit"});
process.exit(run.success ? 0 : run.exitCode || 1);
