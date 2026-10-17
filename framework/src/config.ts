import type { AnimationTheme } from "../compiler/animation.ts";

export type PocketFramework = "solid" | "vue-vapor" | "octane";

/**
 * One target a project ships to: a catalog id (`"psp"`), a catalog id with the
 * manifest it builds from, or an ESP-IDF host profile, whose `id` names the
 * target. Paths resolve against the directory of pocket.config.ts.
 */
export type PocketConfigTarget =
  | string
  | { readonly target: string; readonly manifest?: string }
  | { readonly hostProfile: string; readonly manifest?: string };

export interface PocketConfig {
  /**
   * The targets the project ships to. The first is the project's default
   * target for `pocket` commands that name none; `pocket build --all` builds
   * every entry.
   */
  targets?: readonly PocketConfigTarget[];
  /**
   * JSX/runtime framework for application sources. Solid is the default for
   * existing apps; Vue Vapor or Octane can be selected here or with
   * --framework.
   */
  framework?: PocketFramework;
  /**
   * Tailwind-config-shaped theme extensions. `keyframes` + `animation` feed
   * the build-time animation baker (framework/compiler/animation.ts): `animate-<name>`
   * class utilities resolve against these, and every referenced animation is
   * baked into the styles.bin ANIM TABLE as fixed-dt segment timelines.
   * An app directory may carry its own pocket.config.ts, which the build
   * prefers over the repo root one.
   */
  theme?: AnimationTheme;
}

export function definePocketConfig(config: PocketConfig): PocketConfig {
  return config;
}
