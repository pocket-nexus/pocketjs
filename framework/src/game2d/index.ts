// @pocketjs/framework/game2d — a 2D game layer on PocketJS.
//
// Structure: scenes (what runs), a fixed-step loop (when it runs), a camera over layers (what the
// screen shows: static layers draw when their content changes, dynamic layers every frame, tile
// layers by chunk), input as actions, and the story UI. Underneath: textures with a budget,
// content packs, lighting, saves, a frame-driven clock, streaming music and a memory guard.
export * from "./clock.ts";
export * from "./loop.ts";
export * from "./scene.ts";
export * from "./textures.ts";
export * from "./packs.ts";
export * from "./layer.tsx";
export * from "./tile-layer.ts";
export * from "./camera.tsx";
export * from "./light.ts";
export * from "./input.ts";
export * from "./story.tsx";
export * from "./save.ts";
export * from "./music.ts";
export * from "./memory.ts";
