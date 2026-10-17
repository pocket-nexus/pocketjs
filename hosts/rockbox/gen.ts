#!/usr/bin/env bun
/** Compiles a MicroTS app and bakes its fonts and images for the Rockbox host.
 * Usage: bun hosts/rockbox/gen.ts <app.tsx> <outDir>; the crate reads outDir from $POCKETJS_GEN. */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { basename, dirname, resolve } from "node:path";
import { buildAot } from "../../microts/compiler/aot-build.ts";
import { bakeAtlases } from "../../framework/compiler/bake-font.ts";
import { bakeSvg } from "../../framework/compiler/bake-svg.ts";
import { decodePng } from "../../framework/compiler/pak.ts";
import { registerAnimationTheme, setAnimationTickRate } from "../../framework/compiler/animation.ts";

/** Must match `set_tick_rate` in src/lib.rs. */
const TICK_HZ = 33;

const root = resolve(import.meta.dir, "../..");
const app = resolve(root, process.argv[2]!);
const gen = resolve(process.argv[3]!);
const appDir = dirname(app);
mkdirSync(gen, { recursive: true });

const configPath = resolve(appDir, "pocket.config.ts");
registerAnimationTheme(existsSync(configPath) ? (await import(configPath)).default.theme : undefined);
setAnimationTickRate(TICK_HZ);
const result = await buildAot(app, { outDir: gen, strict: true, format: false });

// The entry and every file reachable through relative imports.
const sourceFiles = new Set<string>();
const visit = (file: string) => {
  if (sourceFiles.has(file) || !existsSync(file)) return;
  sourceFiles.add(file);
  for (const m of readFileSync(file, "utf8").matchAll(/from\s+"(\.{1,2}\/[^"]+)"/g)) {
    const target = resolve(dirname(file), m[1]!);
    for (const candidate of [target, `${target}.ts`, `${target}.tsx`]) {
      if (/\.tsx?$/.test(candidate) && existsSync(candidate)) visit(candidate);
    }
  }
};
visit(app);

const sourceText = [...sourceFiles].map(f => readFileSync(f, "utf8")).join("");
const codepoints = [...new Set([...sourceText].map(c => c.codePointAt(0)!).filter(cp => cp > 126))];
const fonts = await bakeAtlases({ codepoints, slots: result.program.styles.usedFontSlots });
for (const font of fonts) writeFileSync(resolve(gen, `font-${font.slot}.bin`), font.bytes);

// Literal <Image src> values resolve against the declaring file, then assets/images.
const sources = new Map<string, string>();
for (const file of sourceFiles) {
  for (const m of readFileSync(file, "utf8").matchAll(/\bsrc="([^"]+)"/g)) sources.set(m[1]!, dirname(file));
}
const images = [...sources].sort().map(([src, dir]) => {
  const local = resolve(dir, src);
  const bytes = readFileSync(existsSync(local) ? local : resolve(root, "assets/images", src));
  const image = src.endsWith(".svg") ? bakeSvg(bytes.toString()) : decodePng(bytes);
  const file = `${basename(src)}.rgba`;
  writeFileSync(resolve(gen, file), image.rgba);
  return { src, file, width: image.width, height: image.height };
});

// MicroTS renames the root module when another component file shares its name
// (app.tsx rendering ../hero/app.tsx becomes app2); its types use that name.
const rootModule = [...readFileSync(resolve(gen, "mod.rs"), "utf8").matchAll(/^mod (\w+);/gm)]
  .map(m => m[1]!)
  .find(m => !m.endsWith("_model"))!;
const prefix = rootModule.split("_").map(w => w[0]!.toUpperCase() + w.slice(1)).join("");
const props = new RegExp(`pub struct ${prefix}Props(<'a>)? \\{([^}]*)\\}`).exec(readFileSync(resolve(gen, `${rootModule}.rs`), "utf8"));
const lifetime = props?.[1] ? "<'static>" : "";
const propFields = [...(props?.[2] ?? "").matchAll(/pub (\w+): ([^,]+),/g)]
  .map(([, field, type]) => `${field}: ${type!.includes("str") ? '""' : type === "bool" ? "false" : "0"}`);

const name = basename(appDir);
writeFileSync(
  resolve(gen, "include.rs"),
  `#[path = "mod.rs"]\nmod generated;\n` +
    `use generated::{${prefix}App as AppApp, ${prefix}Model as AppModel};\n` +
    `type App = AppApp<${props?.[1] ? "'static, " : ""}AppModel, RockboxHost>;\n` +
    `fn app_props() -> generated::${prefix}Props${lifetime} {\n    generated::${prefix}Props { ${propFields.join(", ")} }\n}\n` +
    `const APP_NAME: &str = ${JSON.stringify(name)};\n` +
    `const FONT_SLOTS: &[u8] = &[${fonts.map(f => f.slot).join(", ")}];\n` +
    `const IMAGES: &[(&str, &str, u32, u32)] = &[${images.map(i => `(${JSON.stringify(i.src)}, ${JSON.stringify(i.file)}, ${i.width}, ${i.height})`).join(", ")}];\n`,
);
