import { expect, test } from "bun:test";
import { copyFileSync, mkdirSync, writeFileSync } from "node:fs";
import { resolve, join } from "node:path";
const root = resolve(import.meta.dir, "..");
test("portable C driver kit detects lifecycle and source/input contract violations", () => {
  const out = join(root, ".pocket-build/validation/driver-kit-c", `${Date.now()}-${process.pid}`);
  mkdirSync(join(out, "include/pocket"), { recursive: true });
  for (const name of ["drivers", "spec"]) copyFileSync(join(root, `contracts/generated/pocket_${name}.h`), join(out, `include/pocket/pocket_${name}.h`));
  copyFileSync(join(root, "engine/driver-kit/c/pocket_driver_kit.h"), join(out, "include/pocket/pocket_driver_kit.h"));
  const command = ["cc", "-std=c11", "-Wall", "-Wextra", "-Werror", "-fsanitize=address,undefined", "-fno-omit-frame-pointer", "-g", `-I${out}/include`, `-I${out}/include/pocket`, "engine/driver-kit/c/pocket_driver_kit.c", "tests/fixtures/sdk/driver-kit.c", "-o", join(out, "consumer")];
  for (const [index, args] of [command, [join(out, "consumer")]].entries()) {
    const child = Bun.spawnSync(args, { cwd: root, stdout: "pipe", stderr: "pipe" });
    const output = child.stdout.toString() + child.stderr.toString();
    writeFileSync(join(out, `${index}.log`), output);
    expect(child.success, `${args.join(" ")} (exit ${child.exitCode}, signal ${child.signalCode ?? "none"})\n${output}`).toBe(true);
    if (index === 1) expect(output).toContain("source/input negative controls passed");
  }
});
