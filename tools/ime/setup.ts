import { cpSync, existsSync, mkdirSync, readFileSync, writeFileSync, renameSync } from "node:fs";
import { resolve, join } from "node:path";
const root = resolve(import.meta.dir, "../..");
const data = resolve(Bun.argv[2] ?? join(root, ".pocket/ime"));
mkdirSync(data, { recursive: true });
function run(args: string[]) {
  const result = Bun.spawnSync(args, { cwd: root, stdout: "inherit", stderr: "inherit" });
  if (result.exitCode) throw new Error(`Failed: ${args[0]}`);
}
const dependencies = {
  "luna-pinyin": "56b934b099dfbeab842320f13aa8b461a6ab3e42",
  prelude: "082425ea0684bca36474415d4a0e8db9b016487e",
  essay: "e9b1a374a6ea015fca5bdd04318924b4483ac35a",
};
for (const [name, revision] of Object.entries(dependencies)) {
  const checkout = join(root, ".pocket-build", `rime-${name}`);
  if (!existsSync(join(checkout, ".git"))) run(["git", "clone", `https://github.com/rime/rime-${name}.git`, checkout]);
  run(["git", "-C", checkout, "fetch", "origin", revision]);
  run(["git", "-C", checkout, "checkout", "--detach", revision]);
  for (const entry of new Bun.Glob("*.{yaml,txt}").scanSync(checkout)) cpSync(join(checkout, entry), join(data, entry));
}
const prefix = process.env.POCKETJS_RIME_PREFIX ?? "/opt/homebrew";
cpSync(join(prefix, "share/opencc"), join(data, "opencc"), { recursive: true });
cpSync(join(root, "tools/ime/pocket_pinyin.schema.yaml"), join(data, "pocket_pinyin.schema.yaml"));
writeFileSync(join(data, "default.custom.yaml"), 'patch:\n  schema_list:\n    - schema: pocket_pinyin\n');
run([join(prefix, "bin/rime_deployer"), "--build", data, data, join(data, "build")]);
run(["cc", "-O2", "-Wall", "-Wextra", "-Werror", `-I${prefix}/include`, `-L${prefix}/lib`,
  "-lrime", join(root, "tools/ime/rime.c"), "-o", join(data, "pocket-rime.next")]);
renameSync(join(data, "pocket-rime.next"), join(data, "pocket-rime"));
writeFileSync(join(data, "sources.json"), JSON.stringify({ dependencies, schema: readFileSync(join(data, "pocket_pinyin.schema.yaml"), "utf8") }, null, 2));
console.log(`IME engine and dictionaries: ${data}`);
