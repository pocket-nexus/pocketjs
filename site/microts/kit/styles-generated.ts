// Replaces framework/src/styles.generated.ts (the class → styleId table a native build generates).
// The preview page puts the compiled table on globalThis.__pocketStyles before importing the framework.
export const STYLE_IDS: Record<string, number> = (globalThis as { __pocketStyles?: Record<string, number> }).__pocketStyles ?? {};
