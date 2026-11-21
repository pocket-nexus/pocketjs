// Application animation content: named keyframe timelines and the
// `animate-*` utilities that play them. The compiler bakes both into the
// style table (framework/compiler/animation.ts); a build plan and the `app`
// section of a host config carry the content as JSON.
import type { JsonSchema } from "./json-schema.ts";

export type KeyframeProps = Record<string, string | number>;
export type Keyframes = Record<string, KeyframeProps>;

/** Application animation content baked into the style table. */
export interface AnimationTheme {
  keyframes?: Record<string, Keyframes>;
  animation?: Record<string, string | { value: string; loop?: string | number }>;
}

export const animationThemeSchema = {
  type: "object", additionalProperties: false,
  properties: {
    keyframes: {
      type: "object", additionalProperties: {
        type: "object", additionalProperties: {
          type: "object", additionalProperties: { anyOf: [{ type: "string" }, { type: "number" }] },
        },
      },
    },
    animation: {
      type: "object", additionalProperties: {
        anyOf: [
          { type: "string" },
          { type: "object", additionalProperties: false, required: ["value"], properties: {
            value: { type: "string" }, loop: { anyOf: [{ type: "string" }, { type: "number" }] },
          } },
        ],
      },
    },
  },
} as const satisfies JsonSchema;
