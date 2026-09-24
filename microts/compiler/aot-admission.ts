/** Native AOT demand diagnostics over declared board input profiles. */
import { BTN } from "../../contracts/spec/spec.ts";
import { MICROTS_RELATIVE_AXES } from "../../contracts/spec/microts.ts";
import { MOTION_LEVELS, MOTION_VALUES } from "../../contracts/spec/motion.ts";
import { listAotInputProfiles, loadAotInputProfile, type PocketButtonName, type AotInputProfile } from "./aot-input-profiles.ts";
import type { AotProgram } from "./aot-ir.ts";

export interface NativeBoardIssue { code: "VB102" | "VB103" | "VB104" | "VB105" | "VB106"; severity: "error" | "warning"; message: string }
export interface NativeBoardAdmission { board: string; chip: string; ok: boolean; issues: NativeBoardIssue[] }
const pocketButtons = new Map<number, PocketButtonName>([
  [BTN.CIRCLE, "a"], [BTN.CROSS, "b"], [BTN.SELECT, "select"], [BTN.START, "start"],
  [BTN.RIGHT, "right"], [BTN.LEFT, "left"], [BTN.UP, "up"], [BTN.DOWN, "down"],
  [BTN.LTRIGGER, "l"], [BTN.RTRIGGER, "r"],
]);
const buttonName = (mask: number) => Object.entries(BTN).find(([, value]) => value === mask)?.[0] ?? `0x${mask.toString(16)}`;
const axisName = (id: number) => Object.entries(MICROTS_RELATIVE_AXES).find(([, value]) => value === id)?.[0] ?? String(id);
const motionValue = (id: number) => Object.entries(MOTION_VALUES).find(([, spec]) => spec.id === id);

export function admitAotBoard(program: Pick<AotProgram, "demands">, board: AotInputProfile): NativeBoardAdmission {
  const issues: NativeBoardIssue[] = [];
  for (const mask of program.demands?.buttons ?? []) {
    const name = pocketButtons.get(mask);
    if (name && board.direct.includes(name)) continue;
    const chord = name && board.chorded[name];
    if (chord) issues.push({ code: "VB103", severity: "warning", message: `BTN.${buttonName(mask)} uses the ${chord.join("+")} chord on ${board.board}` });
    else issues.push({ code: "VB102", severity: "error", message: `${board.board} has no mapping for BTN.${buttonName(mask)}` });
  }
  for (const axis of program.demands?.axes ?? []) {
    if (board.axes.includes(axis)) continue;
    issues.push({ code: "VB104", severity: "error", message: `${board.board} has no relative-axis adapter for ${axisName(axis)}` });
  }
  for (const id of program.demands?.motion ?? []) {
    const [name, spec] = motionValue(id) ?? [String(id), undefined];
    if (spec && board.motion >= MOTION_LEVELS[spec.level]) continue;
    issues.push({ code: "VB106", severity: "error", message: `${board.board} has no ${spec?.level ?? "known"} motion driver for ${name}` });
  }
  if (program.demands?.capabilities.includes("touch") && !board.touch) {
    issues.push({ code: "VB105", severity: "error", message: `${board.board} has no touch adapter` });
  }
  return { board: board.board, chip: board.chip, ok: !issues.some(issue => issue.severity === "error"), issues };
}

export function aotBoardAdmission(program: Pick<AotProgram, "demands">, board?: string, all = false): NativeBoardAdmission[] {
  return (board ? [board] : all ? listAotInputProfiles() : []).map(name => admitAotBoard(program, loadAotInputProfile(name)));
}

export function requireAotBoard(program: Pick<AotProgram, "demands">, name: string): NativeBoardAdmission {
  const admission = admitAotBoard(program, loadAotInputProfile(name));
  if (!admission.ok) throw new Error(admission.issues.map(issue => `${issue.code}: ${issue.message}`).join("\n"));
  return admission;
}
