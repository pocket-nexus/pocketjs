/** Input coverage for native AOT admission; no display, GPIO or build settings. */
export type PocketButtonName = "a" | "b" | "select" | "start" | "right" | "left" | "up" | "down" | "r" | "l";

export interface AotInputProfile {
  readonly board: string;
  readonly chip: string;
  readonly direct: readonly PocketButtonName[];
  readonly chorded: Readonly<Partial<Record<PocketButtonName, readonly [PocketButtonName, PocketButtonName]>>>;
  readonly axes: readonly number[];
  readonly touch: boolean;
}

// Preserve the MeowBit input contract independently of the retired cartridge
// compiler. Admission checks this declaration; it does not establish a port.
const profiles = new Map<string, AotInputProfile>([
  ["meowbit", {
    board: "meowbit",
    chip: "esp32",
    direct: ["up", "down", "left", "right", "a", "b"],
    chorded: { start: ["a", "b"], select: ["left", "right"], r: ["up", "down"] },
    axes: [],
    touch: false,
  }],
]);

export function listAotInputProfiles(): string[] {
  return [...profiles.keys()].sort();
}

export function loadAotInputProfile(name: string): AotInputProfile {
  const profile = profiles.get(name);
  if (!profile) throw new Error(`board ${name}: unknown input profile (known: ${listAotInputProfiles().join(", ")})`);
  return profile;
}
