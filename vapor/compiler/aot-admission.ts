/** Native AOT demand diagnostics over the retained board input profiles. */
import { BTN } from "../../contracts/spec/spec.ts";
import { VAPOR_RELATIVE_AXES } from "../../contracts/spec/vapor.ts";
import { listBoards, loadBoard, PAD_KEYS, type PocketButtonName, type VaporBoard } from "./boards.ts";
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

export function admitVueAotBoard(program: AotProgram, board: VaporBoard): NativeBoardAdmission {
  const issues: NativeBoardIssue[] = [];
  for (const mask of program.demands?.buttons ?? []) {
    const name = pocketButtons.get(mask);
    if (name && (PAD_KEYS as readonly string[]).includes(name)) continue;
    const chord = name && board.input.chorded[name];
    if (chord) issues.push({ code: "VB103", severity: "warning", message: `BTN.${buttonName(mask)} uses the ${chord.join("+")} chord on ${board.board}` });
    else issues.push({ code: "VB102", severity: "error", message: `${board.board} has no mapping for BTN.${buttonName(mask)}` });
  }
  // These board profiles describe the existing C pad adapters. No profile
  // currently has an implemented relative-axis or touch adapter to claim.
  for (const axis of program.demands?.axes ?? []) {
    issues.push({ code: "VB104", severity: "error", message: `${board.board} has no relative-axis adapter for ${axisName(axis)}` });
  }
  if (program.demands?.capabilities.includes("touch")) {
    issues.push({ code: "VB105", severity: "error", message: `${board.board} has no touch adapter` });
  }
  return { board: board.board, chip: board.chip, ok: !issues.some(issue => issue.severity === "error"), issues };
}

export function vueAotBoardAdmission(program: AotProgram, board?: string, all = false): NativeBoardAdmission[] {
  return (board ? [board] : all ? listBoards() : []).map(name => admitVueAotBoard(program, loadBoard(name)));
}

export function requireVueAotBoard(program: AotProgram, name: string): NativeBoardAdmission {
  const admission = admitVueAotBoard(program, loadBoard(name));
  if (!admission.ok) throw new Error(admission.issues.map(issue => `${issue.code}: ${issue.message}`).join("\n"));
  return admission;
}
