// @pocketjs/framework/game2d — scenes: which part of the game runs, and what it owns.
//
// A scene is a set of hooks. `enter` and `leave` bracket the time it is current: a scene loads
// what it draws when it enters and lets go of it when it leaves. `reset` abandons its state (a
// chapter jump, back to the title), so a restart is one call instead of a list of fields to clear.
// `step` runs once per fixed step, `draw` once per frame.
//
// The director owns the current scene, or follows a name kept elsewhere (`follow`): game scripts
// shared with another host often set it themselves.

export interface Scene {
  enter?(from: string | null): void;
  leave?(to: string): void;
  reset?(): void;
  step?(dtMs: number): void;
  draw?(): void;
}

export interface DirectorConfig<N extends string> {
  scenes: Record<N, Scene>;
  initial: N;
  /** Read the current scene's name from game state each frame instead of `go`. */
  follow?: () => N;
}

export interface Director<N extends string> {
  current(): N;
  /** Switch now: the current scene leaves, the next enters. No-op for the current scene. */
  go(name: N): void;
  /** Call once per frame before the steps: applies a followed name change. */
  sync(): void;
  step(dtMs: number): void;
  draw(): void;
  /** Reset every scene, then enter `name` (default the initial scene). */
  reset(name?: N): void;
}

export function createDirector<N extends string>(cfg: DirectorConfig<N>): Director<N> {
  let name: N = cfg.initial, scene: Scene | undefined = cfg.scenes[name], entered = false;
  const go = (next: N) => {
    if (entered && next === name) return;
    const from = entered ? name : null;
    if (entered) scene?.leave?.(next);
    name = next; scene = cfg.scenes[next]; entered = true;
    scene?.enter?.(from);
  };
  return {
    current: () => name,
    go,
    sync() { go(cfg.follow ? cfg.follow() : name); },
    step(dt) { scene?.step?.(dt); },
    draw() { scene?.draw?.(); },
    reset(next = cfg.initial) {
      if (entered) scene?.leave?.(next);
      for (const k in cfg.scenes) cfg.scenes[k].reset?.();
      entered = false; go(next);
    },
  };
}
