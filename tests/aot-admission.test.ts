import { expect, test } from "bun:test";
import { BTN } from "../contracts/spec/spec.ts";
import { RelativeAxis } from "../contracts/spec/microts.ts";
import { admitAotBoard, requireAotBoard, aotBoardAdmission } from "../microts/compiler/aot-admission.ts";
import { listAotInputProfiles, loadAotInputProfile } from "../microts/compiler/aot-input-profiles.ts";

const meowbit = loadAotInputProfile("meowbit");
const demand = (buttons: number[] = [], axes: number[] = [], capabilities: string[] = []) => ({
  demands: { buttons, axes, capabilities },
});

test("native board admission retains direct button coverage and profile selection", () => {
  const program = demand([BTN.UP, BTN.DOWN, BTN.LEFT, BTN.RIGHT, BTN.CIRCLE, BTN.CROSS]);
  const expected = { board: "meowbit", chip: "esp32", ok: true, issues: [] };
  expect(listAotInputProfiles()).toEqual(["meowbit"]);
  expect(requireAotBoard(program, "meowbit")).toEqual(expected);
  expect(aotBoardAdmission(program, undefined, true)).toEqual([expected]);
  expect(aotBoardAdmission(program)).toEqual([]);
});

test("chorded buttons remain admitted with the existing warning diagnostics", () => {
  const result = requireAotBoard(demand([BTN.START, BTN.SELECT, BTN.RTRIGGER]), "meowbit");
  expect(result.ok).toBe(true);
  expect(result.issues).toEqual([
    { code: "VB103", severity: "warning", message: "BTN.START uses the a+b chord on meowbit" },
    { code: "VB103", severity: "warning", message: "BTN.SELECT uses the left+right chord on meowbit" },
    { code: "VB103", severity: "warning", message: "BTN.RTRIGGER uses the up+down chord on meowbit" },
  ]);
});

test("missing buttons, relative axes and touch reject the board", () => {
  const program = demand([BTN.LTRIGGER, BTN.TRIANGLE], [RelativeAxis.Primary], ["touch"]);
  expect(admitAotBoard(program, meowbit)).toEqual({
    board: "meowbit", chip: "esp32", ok: false,
    issues: [
      { code: "VB102", severity: "error", message: "meowbit has no mapping for BTN.LTRIGGER" },
      { code: "VB102", severity: "error", message: "meowbit has no mapping for BTN.TRIANGLE" },
      { code: "VB104", severity: "error", message: "meowbit has no relative-axis adapter for primary" },
      { code: "VB105", severity: "error", message: "meowbit has no touch adapter" },
    ],
  });
  expect(() => requireAotBoard(program, "meowbit")).toThrow("VB104");
});

test("unknown profiles fail with the available names", () => {
  expect(() => loadAotInputProfile("missing")).toThrow("unknown input profile (known: meowbit)");
  expect(() => aotBoardAdmission(demand(), "missing")).toThrow("board missing");
});
