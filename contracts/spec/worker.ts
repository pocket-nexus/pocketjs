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
  mqtt: { kind: 4, capability: "net.mqtt" },
} as const;
export type WorkerResourceKind = keyof typeof WORKER_RESOURCES;
/** The capabilities a worker declaration implies. */
export function workerCapabilities(declaration: { readonly nodes: readonly { readonly kind: WorkerResourceKind }[] }): string[] {
  return ["runtime.worker", ...new Set(declaration.nodes.map(node => WORKER_RESOURCES[node.kind].capability))];
}
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
/** The channel every host holds: a record of `recordBytes`, a ring of
 *  `capacity` records. A host's profile may state a larger one
 *  (contracts/spec/profile.ts `worker.channels`), up to WORKER_CHANNEL_MAX. */
export const WORKER_CHANNEL_FLOOR = { recordBytes: WORKER_LIMITS.payloadBytes, capacity: WORKER_LIMITS.events } as const;
/** The largest channel the worker core (engine/worker) allocates. A
 *  UI-to-worker record arrives as one fact, so a host whose records exceed
 *  its realm's per-turn bytes (`max_bytes`, 8192 by default) raises them. */
export const WORKER_CHANNEL_MAX = { recordBytes: 64 * 1024, capacity: 256 } as const;
/** The execution domains of one package: the UI realm and the worker realm. */
export const POCKET_DOMAINS = ["ui", "worker"] as const;
export type PocketDomain = (typeof POCKET_DOMAINS)[number];

/** A channel's size as a manifest states it: bytes and records, or "host"
 *  for the host's channel (WorkerChannelTable), read at run time from the
 *  channel. */
export type WorkerChannelSize = number | "host";

/** A channel as the package runs it: sizes in bytes and records. */
export interface WorkerChannelDeclaration {
  readonly name: string;
  readonly kind: "snapshot" | "ring";
  readonly direction: "ui-to-worker" | "worker-to-ui";
  readonly recordBytes: number;
  readonly capacity: number;
}

/** A channel as a manifest declares it. */
export interface WorkerChannelSource extends Omit<WorkerChannelDeclaration, "recordBytes" | "capacity"> {
  readonly recordBytes: WorkerChannelSize;
  readonly capacity: WorkerChannelSize;
}

/** A worker declaration implies these requirements: the second runtime and
 *  the capability of each node kind it owns. Node and channel counts are
 *  checked at resolution against WORKER_LIMITS and the host's worker table.
 *  `C` is the channel form: the manifest's (sizes may be "host") or the
 *  plan's (resolveWorkerChannels). */
export interface WorkerDeclaration<C extends WorkerChannelSource = WorkerChannelDeclaration> {
  /** Path relative to the project root, as for app.entry. */
  readonly entry: string;
  readonly nodes: readonly { readonly name: string; readonly kind: WorkerResourceKind }[];
  readonly channels?: readonly C[];
}
export type WorkerDeclarationSource = WorkerDeclaration<WorkerChannelSource>;

/** The largest channel a host holds (profile `worker.channels`). */
export interface WorkerChannelTable {
  readonly recordBytes: number;
  readonly capacity: number;
}

/** The declaration with each "host" size replaced by the host's channel:
 *  the plan's form, which both realms read. */
export function resolveWorkerChannels(
  declaration: WorkerDeclarationSource,
  table: WorkerChannelTable = WORKER_CHANNEL_FLOOR,
): WorkerDeclaration {
  if (!declaration.channels) return declaration as WorkerDeclaration;
  return {
    ...declaration,
    channels: declaration.channels.map(channel => ({
      ...channel,
      recordBytes: channel.recordBytes === "host" ? table.recordBytes : channel.recordBytes,
      capacity: channel.capacity === "host" ? table.capacity : channel.capacity,
    })),
  };
}

const nodeName = { type: "string", minLength: 1, maxLength: 63, pattern: "^[a-zA-Z][a-zA-Z0-9_.-]*$" } as const;
export const workerDeclarationSchema = {
  type: "object", additionalProperties: false, required: ["entry", "nodes"],
  properties: {
    entry: { type: "string", minLength: 1, pattern: "^(?!/)(?!.*(?:^|/)\\.\\.(?:/|$))(?!.*\\\\).+\\.ts$" },
    nodes: { type: "array", items: {
      type: "object", additionalProperties: false, required: ["name", "kind"],
      properties: { name: nodeName, kind: { enum: Object.keys(WORKER_RESOURCES) } },
    } },
    channels: { type: "array", items: {
      type: "object", additionalProperties: false,
      required: ["name", "kind", "direction", "recordBytes", "capacity"],
      properties: {
        name: nodeName, kind: { enum: ["snapshot", "ring"] },
        direction: { enum: ["ui-to-worker", "worker-to-ui"] },
        recordBytes: { anyOf: [{ type: "integer", minimum: 1, maximum: WORKER_CHANNEL_MAX.recordBytes }, { const: "host" }] },
        capacity: { anyOf: [{ type: "integer", minimum: 1, maximum: WORKER_CHANNEL_MAX.capacity }, { const: "host" }] },
      },
    } },
  },
} as const satisfies JsonSchema;
