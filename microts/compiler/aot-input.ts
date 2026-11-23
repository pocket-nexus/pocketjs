/** ActionHandler event payloads and hold timing, shared by the Solid and Vue frontends. */
import { ACTION_HOLD_DEFAULT_MS, MICROTS_INPUT_ELEMENTS } from "../../contracts/spec/microts.ts";
import { F64, I32, type AotEvent, type AotExpr, type AotHandler, type AotNode, type SourceLocation } from "./aot-ir.ts";
import { numeric } from "./aot-expressions.ts";
import { fail, type TypeMapper } from "./aot-types.ts";

export type ActionEventName = (typeof MICROTS_INPUT_ELEMENTS.ActionHandler.events)[number];
export const ACTION_EVENTS = MICROTS_INPUT_ELEMENTS.ActionHandler.events;
const firstParameter: Record<ActionEventName, string> = { press: "pressed", hold: "held", release: "released" };

/** `(pressed | held | released, buttons)`, the guest's `onPress` payload shape. */
export function actionEvent(name: ActionEventName): AotEvent {
  return { name, parameters: [{ name: firstParameter[name], type: I32 }, { name: "buttons", type: I32 }] };
}

/** A duration in model-clock milliseconds: any numeric expression, read as f64. */
export function milliseconds(value: AotExpr, mapper: TypeMapper, attribute: string): AotExpr {
  if (!numeric(value.type, mapper)) fail(value.loc, `${attribute} requires a number of milliseconds`);
  return { kind: "cast", value, type: F64, loc: value.loc };
}

/** Admit an ActionHandler's events and hold timing; `durations` maps holdMs/repeatMs to their values and locations. */
export function actionInput(
  events: { name: ActionEventName; handler: AotHandler }[],
  durations: Map<"holdMs" | "repeatMs", { value: AotExpr; loc: SourceLocation }>,
  at: SourceLocation,
  spell: (event: ActionEventName) => string,
): { events: Extract<AotNode, { kind: "input" }>["events"]; hold?: { delay: AotExpr; repeat?: AotExpr } } {
  if (!events.length) fail(at, `ActionHandler requires ${ACTION_EVENTS.map(spell).join(", ").replace(/, (?=[^,]*$)/, " or ")}`);
  const hasHold = events.some(event => event.name === "hold");
  for (const [name, duration] of durations) if (!hasHold) fail(duration.loc, `${name} requires ${spell("hold")}`);
  const ordered = ACTION_EVENTS.flatMap(name => events.filter(event => event.name === name));
  if (!hasHold) return { events: ordered };
  const delay = durations.get("holdMs")?.value ?? { kind: "literal", value: ACTION_HOLD_DEFAULT_MS, type: F64, loc: at };
  const repeat = durations.get("repeatMs")?.value;
  return { events: ordered, hold: { delay, ...(repeat ? { repeat } : {}) } };
}
