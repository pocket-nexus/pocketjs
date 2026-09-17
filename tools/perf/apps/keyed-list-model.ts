export interface KeyedRow {
  readonly id: string;
  readonly label: string;
  readonly detail: string;
  readonly swatchClass: string;
}

export const INITIAL_KEYED_ROWS: readonly KeyedRow[] = Object.freeze([
  {
    id: "alpha",
    label: "ALPHA",
    detail: "retained row 01",
    swatchClass: "w-3 h-3 bg-blue-500",
  },
  {
    id: "bravo",
    label: "BRAVO",
    detail: "retained row 02",
    swatchClass: "w-3 h-3 bg-emerald-500",
  },
  {
    id: "charlie",
    label: "CHARLIE",
    detail: "retained row 03",
    swatchClass: "w-3 h-3 bg-amber-500",
  },
  {
    id: "delta",
    label: "DELTA",
    detail: "retained row 04",
    swatchClass: "w-3 h-3 bg-cyan-500",
  },
]);

export const INSERTED_KEYED_ROW: KeyedRow = Object.freeze({
  id: "inserted",
  label: "INSERTED",
  detail: "new keyed row",
  swatchClass: "w-3 h-3 bg-rose-500",
});

/** Insert one object without replacing any retained row object. */
export function keyedInsert(rows: readonly KeyedRow[]): KeyedRow[] {
  if (rows.some((row) => row.id === INSERTED_KEYED_ROW.id)) return [...rows];
  return [rows[0]!, INSERTED_KEYED_ROW, ...rows.slice(1)];
}

/** Rotate the same objects so Solid's For moves its retained row nodes. */
export function keyedReorder(rows: readonly KeyedRow[]): KeyedRow[] {
  if (rows.length < 2) return [...rows];
  return [...rows.slice(1), rows[0]!];
}

/** Delete the inserted object without replacing any surviving row object. */
export function keyedDelete(rows: readonly KeyedRow[]): KeyedRow[] {
  return rows.filter((row) => row.id !== INSERTED_KEYED_ROW.id);
}
