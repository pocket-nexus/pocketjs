// The style table a framework module reads when nothing substitutes one: empty.
// A build replaces this module with its own table at bundle time
// (framework/compiler/jsx-plugin.ts serves `generatedStyles` for this path), so
// no build writes here. Code that imports framework sources directly — tests,
// the headless hosts — runs with this empty table. The shape matches
// generateStylesModule in framework/compiler/tailwind.ts.

/** class literal -> styleId (record index in ui:styles / styles.bin). */
export const STYLE_IDS: Record<string, number> = {};

/** Number of records in styles.bin (valid styleIds are 0..COUNT-1). */
export const STYLE_COUNT = 0;

/** Baked font-atlas slots shipped in the pak: slot -> metrics. */
export const FONT_SLOTS: Record<number, { px: number; bold: boolean }> = {};

/** Slot for text with no text-size/font-weight utility (16px regular). */
export const DEFAULT_FONT_SLOT = 2;
