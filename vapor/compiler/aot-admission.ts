/** Native AOT demand diagnostics over declared board input profiles. */
import { BTN } from "../../contracts/spec/spec.ts";
import { VAPOR_RELATIVE_AXES } from "../../contracts/spec/vapor.ts";
import { listAotInputProfiles, loadAotInputProfile, type PocketButtonName, type AotInputProfile } from "./aot-input-profiles.ts";
import type { AotProgram } from "./aot-ir.ts";

export interface NativeBoardIssue { code: "VB102" | "VB103" | "VB104" | "VB105"; severity: "error" | "warning"; message: string }
export interface NativeBoardAdmission { board: string; chip: string; ok: boolean; issues: NativeBoardIssue[] }
const pocketButtons = new Map<number, PocketButtonName>([
  [BTN.CIRCLE, "a"], [BTN.CROSS, "b"], [BTN.SELECT, "select"], [BTN.START, "start"],
  [BTN.RIGHT, "right"], [BTN.LEFT, "left"], [BTN.UP, "up"], [BTN.DOWN, "down"],
  [BTN.LTRIGGER, "l"], [BTN.RTRIGGER, "r"],
]);
const buttonName = (mask: number) => Object.entries(BTN).find(([, value]) => value === mask)?.[0] ?? `0x${mask.toString(16)}`;
const axisName = (id: number) => Object.entries(VAPOR_RELATIVE_AXES).find(([, value]) => value === id)?.[0] ?? String(id);

export function admitVueAotBoard(program: Pick<AotProgram, "demands">, board: AotInputProfile): NativeBoardAdmission {
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
  if (program.demands?.capabilities.includes("touch") && !board.touch) {
    issues.push({ code: "VB105", severity: "error", message: `${board.board} has no touch adapter` });
  }
  return { board: board.board, chip: board.chip, ok: !issues.some(issue => issue.severity === "error"), issues };
}

export function vueAotBoardAdmission(program: Pick<AotProgram, "demands">, board?: string, all = false): NativeBoardAdmission[] {
  return (board ? [board] : all ? listAotInputProfiles() : []).map(name => admitVueAotBoard(program, loadAotInputProfile(name)));
}

export function requireVueAotBoard(program: Pick<AotProgram, "demands">, name: string): NativeBoardAdmission {
  const admission = admitVueAotBoard(program, loadAotInputProfile(name));
  if (!admission.ok) throw new Error(admission.issues.map(issue => `${issue.code}: ${issue.message}`).join("\n"));
  return admission;
}
