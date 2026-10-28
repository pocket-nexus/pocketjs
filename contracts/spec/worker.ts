import type { JsonSchema } from "./pocket-manifest.ts";

/** Version 1 of the worker host protocol; matches pocket/worker.h. */
export const WORKER_PROTOCOL_VERSION = 1;
/** The resource kinds a worker node can own: each kind's protocol id and the
 *  capability a manifest must require to declare a node of that kind. The
 *  SDK accessor (`io.<kind>` in framework/src/io.ts) encodes each kind's
 *  descriptor. */
export const WORKER_RESOURCES = {
  i2c: { kind: 1, capability: "io.i2c" },
  uart: { kind: 2, capability: "io.uart" },
  http: { kind: 3, capability: "net.http" },
} as const;
export type WorkerResourceKind = keyof typeof WORKER_RESOURCES;
export const ResourceKind = Object.fromEntries(
  Object.entries(WORKER_RESOURCES).map(([name, row]) => [name, row.kind]),
) as { readonly [K in WorkerResourceKind]: (typeof WORKER_RESOURCES)[K]["kind"] };
export const FactKind = {
  ready: 1, complete: 2, data: 3, end: 4, gap: 5, timer: 6,
  channel: 7, headers: 8, error: 9, credit: 10, closed: 11,
} as const;
export const ResourceStatus = {
  ok: 0, failed: -1, cancelled: -2, unknown: -3, busy: -4, invalid: -5, unsupported: -6,
} as const;
export const WORKER_LIMITS = {
  resources: 8, requests: 8, payloadBytes: 1024, events: 8, timers: 8, channels: 8,
} as const;
/** The execution domains of one package: the UI realm and the worker realm. */
export const POCKET_DOMAINS = ["ui", "worker"] as const;
export type PocketDomain = (typeof POCKET_DOMAINS)[number];

export interface WorkerChannelDeclaration {
  readonly name: string;
  readonly kind: "snapshot" | "ring";
  readonly direction: "ui-to-worker" | "worker-to-ui";
  readonly recordBytes: number;
  readonly capacity: number;
}

export interface WorkerDeclaration {
  /** Path relative to the project root, as for app.entry. */
  readonly entry: string;
  readonly nodes: readonly { readonly name: string; readonly kind: WorkerResourceKind }[];
  readonly channels?: readonly WorkerChannelDeclaration[];
}

const nodeName = { type: "string", minLength: 1, maxLength: 63, pattern: "^[a-zA-Z][a-zA-Z0-9_.-]*$" } as const;
export const workerDeclarationSchema = {
  type: "object", additionalProperties: false, required: ["entry", "nodes"],
  properties: {
    entry: { type: "string", minLength: 1, pattern: "^(?!/)(?!.*(?:^|/)\\.\\.(?:/|$))(?!.*\\\\).+\\.ts$" },
    nodes: { type: "array", maxItems: 8, items: {
      type: "object", additionalProperties: false, required: ["name", "kind"],
      properties: { name: nodeName, kind: { enum: Object.keys(WORKER_RESOURCES) } },
    } },
    channels: { type: "array", maxItems: 8, items: {
      type: "object", additionalProperties: false,
      required: ["name", "kind", "direction", "recordBytes", "capacity"],
      properties: {
        name: nodeName, kind: { enum: ["snapshot", "ring"] },
        direction: { enum: ["ui-to-worker", "worker-to-ui"] },
        recordBytes: { type: "integer", minimum: 1, maximum: 1024 },
        capacity: { type: "integer", minimum: 1, maximum: 8 },
      },
    } },
  },
} as const satisfies JsonSchema;
