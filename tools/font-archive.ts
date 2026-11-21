// Build a device-local archive, independent of the app's strings and bundle.
import { bakeFontArchive } from "../framework/compiler/font-archive.ts";
const args = Object.fromEntries(
  Bun.argv.slice(2).map((s) => {
    const at = s.indexOf("=");
    if (at < 3 || !s.startsWith("--"))
      throw new Error("Use --font=FILE --out=FILE --slots=0,2,4");
    return [s.slice(2, at), s.slice(at + 1)];
  }),
);
if (!args.font || !args.out)
  throw new Error("Use --font=FILE --out=FILE --slots=0,2,4");
const bytes = await bakeFontArchive({
  font: args.font,
  slots: (args.slots ?? "0,2,4").split(",").map(Number),
  onStrike: (slot, count) => console.log(`slot ${slot}: ${count} glyphs`),
});
await Bun.write(args.out, bytes);
console.log(
  `${args.out}: ${bytes.length} bytes; external archive, not embedded in EBOOT`,
);
