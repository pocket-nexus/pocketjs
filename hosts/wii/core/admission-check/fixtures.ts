import { readFileSync, writeFileSync } from "node:fs";
import { decodePocketPackage, encodePocketPackage } from "../../../../contracts/spec/pocket-package.ts";

const [source, output] = process.argv.slice(2);
const bytes = readFileSync(source);
const pkg = decodePocketPackage(bytes);
if (pkg.variants.length !== 1 || pkg.variants[0].target !== "wii-dev" || pkg.variants[0].hostAbi !== 7) {
  throw new Error("expected one wii-dev ABI 7 package variant");
}

const write = (name: string, target: string, hostAbi: number) => {
  writeFileSync(`${output}/${name}.pocket`, encodePocketPackage({
    manifest: pkg.manifest,
    variants: [{ ...pkg.variants[0], target, hostAbi }],
  }));
};

write("valid", "wii-dev", 7);
write("wrong-target", "wii-other", 7);
write("wrong-abi", "wii-dev", 8);
