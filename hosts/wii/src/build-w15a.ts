import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { encodePocketPackage } from "../../../contracts/spec/pocket-package.ts";
import { pack } from "../../../framework/compiler/pak.ts";
import { makeVariant } from "../../../tools/pocket-pack.ts";

const output = process.argv[2];
if (!output) throw new Error("usage: bun build-w15a.ts <work-dir>");
mkdirSync(output, { recursive: true });

const goodJavaScript = `
if (ui.__host !== "wii-dev" || ui.__hostAbi !== 7 ||
    ui.__viewport.w !== 480 || ui.__viewport.h !== 272) {
  throw new Error("W15A host bindings mismatch");
}
globalThis.frame = function () {};
`;
const badJavaScript = `throw new Error("W15A intentional boot failure");`;
const w16JavaScript = `
const node = ui.createNode(0);
ui.insertBefore(1, node, 0);
ui.setProp(node, 1, 24);
ui.setProp(node, 2, 32);
ui.setProp(node, 64, 0xff563412);
globalThis.frame = function(buttons, analog) {
  if (buttons === 0x4000 && analog === 0x1234) {
    ui.setProp(node, 1, 40);
    return;
  }
  if (buttons === 0x8000 && analog === 0x4321) {
    throw new Error("W16 intentional frame failure");
  }
  throw new Error("W16 frame arguments mismatch");
};
`;
const pak = pack([]);

function write(name: string, target: string, hostAbi: number, javascript: string) {
  const bytes = encodePocketPackage({
    manifest: new TextEncoder().encode('{"id":"w15a-probe","targets":["wii-dev"]}'),
    variants: [
      makeVariant({
        target,
        hostAbi,
        planJson: JSON.stringify({ target: { id: target, hostAbi } }),
        identity: { output: "w15a-probe", id: "w15a-probe", title: "W15a boot probe" },
        js: new TextEncoder().encode(javascript),
        pak,
      }),
    ],
  });
  writeFileSync(join(output, `${name}.pocket`), bytes);
}

write("w15a-valid", "wii-dev", 7, goodJavaScript);
write("w15a-wrong-target", "wii-other", 7, goodJavaScript);
write("w15a-wrong-abi", "wii-dev", 8, goodJavaScript);
write("w15a-bad-js", "wii-dev", 7, badJavaScript);
write("w16-frame", "wii-dev", 7, w16JavaScript);
