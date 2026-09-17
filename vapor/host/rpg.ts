// vapor/host/rpg.ts — the Pocket Vapor RPG host contract.
//
// Like the other Vapor host modules, this file has two lives. The JS/oracle
// path uses the concrete map helpers below. The AOT compiler recognizes the
// same declarations, queries, and RpgScreen component and lowers them to the
// fixed native RPG runtime. Gameplay state never lives here: RpgScreen is a
// pure host boundary whose complete state is supplied through props.

export interface RpgDialog {
  speaker: string;
  line1: string;
  line2?: string;
  choice0?: string;
  choice1?: string;
}

export interface RpgMapDefinition {
  rows: readonly string[];
  solid: string;
  events: Record<string, number>;
  dialogs: readonly RpgDialog[];
}

export interface RpgMap extends RpgMapDefinition {
  readonly width: number;
  readonly height: number;
}

export interface RpgScreenProps {
  map: RpgMap;
  mode: number;
  playerX: number;
  playerY: number;
  /** Signed sub-cell presentation offset in world pixels. */
  playerOffsetX: number;
  /** Signed sub-cell presentation offset in world pixels. */
  playerOffsetY: number;
  facing: number;
  /** Zero selects the facing idle frame; 1..4 select walking frames. */
  playerFrame: number;
  quest: number;
  dialog: number;
  choice: number;
  heroHp: number;
  enemyHp: number;
  battleCursor: number;
}

/**
 * Declare one static, cell-addressed RPG map.
 *
 * GBA's logical viewport is at most 30x20 cells. Every event is attached to
 * one map character so the same source drives oracle lookup and native ROM
 * tables without a second coordinate convention.
 */
export function defineRpgMap(definition: RpgMapDefinition): RpgMap {
  const height = definition.rows.length;
  if (height === 0) throw new Error("RPG map needs at least one row");
  if (height > 20) throw new Error(`RPG map height ${height} exceeds the 20-row GBA viewport`);

  const width = definition.rows[0]!.length;
  if (width === 0) throw new Error("RPG map rows must not be empty");
  if (width > 30) throw new Error(`RPG map width ${width} exceeds the 30-column GBA viewport`);

  for (let y = 1; y < height; y++) {
    const rowWidth = definition.rows[y]!.length;
    if (rowWidth !== width) {
      throw new Error(`RPG map row ${y} has width ${rowWidth}; expected ${width}`);
    }
  }

  const eventEntries = Object.entries(definition.events);
  if (eventEntries.length > 255) throw new Error("RPG map supports at most 255 event tile keys");
  for (const [tile, event] of eventEntries) {
    if (tile.length !== 1) throw new Error(`RPG event key ${JSON.stringify(tile)} must be one character`);
    if (!definition.rows.some((row) => row.includes(tile))) {
      throw new Error(`RPG event key ${JSON.stringify(tile)} does not appear in the map`);
    }
    if (!Number.isInteger(event) || event < 1 || event > 255) {
      throw new Error(`RPG event for ${JSON.stringify(tile)} must be an integer from 1 to 255`);
    }
  }

  if (definition.dialogs.length > 255) throw new Error("RPG map supports at most 255 dialogs");

  return {
    rows: definition.rows,
    solid: definition.solid,
    events: definition.events,
    dialogs: definition.dialogs,
    width,
    height,
  };
}

/** Out-of-bounds coordinates are solid, so movement fails closed. */
export function rpgBlocked(map: RpgMap, x: number, y: number): boolean {
  if (!Number.isInteger(x) || !Number.isInteger(y)) return true;
  if (x < 0 || y < 0 || x >= map.width || y >= map.height) return true;
  return map.solid.includes(map.rows[y]![x]!);
}

/** Return the event attached to a map cell, or zero for no event. */
export function rpgEventAt(map: RpgMap, x: number, y: number): number {
  if (!Number.isInteger(x) || !Number.isInteger(y)) return 0;
  if (x < 0 || y < 0 || x >= map.width || y >= map.height) return 0;
  return map.events[map.rows[y]![x]!] ?? 0;
}

/**
 * Stateless RPG render boundary.
 *
 * The browser oracle may replace this with a visible renderer. Pocket Vapor
 * lowers it to the target's native tile/sprite renderer. Keeping the JS body
 * empty is intentional: every observable gameplay input is explicit in props.
 */
export function RpgScreen(_props: RpgScreenProps): null {
  return null;
}
