/** Operation receipts above the byte-only frame layer. [R5-P06/P10] */
import {
  RELAY_CODEC, RELAY_EFFECT, RELAY_ERROR, RELAY_METADATA_SCHEMAS, RELAY_OP, RELAY_STATUS, RELAY_TYPE,
  type RelayOperationEpochArgs, type RelayOperationEpochValue, type RelayOperationState,
  type RelayOperationStatusArgs, type RelayOperationStatusValue, type RelayProfileEntry, type RelayRxLimits,
} from "../../../contracts/spec/relay.ts";
import { prepareFrameBody, type RelayFrameBodyInput } from "./frame.ts";
import { validateRelaySchema } from "./metadata-schema.ts";
import { freezeRelayCopy, samePrivateProfile, type RelayPrivateOp } from "./private-op.ts";

export type RelayOperationOp = typeof RELAY_OP.OPERATION_EPOCH | typeof RELAY_OP.OPERATION_STATUS;
export const isOperationOp = (op: string): op is RelayOperationOp =>
  op === RELAY_OP.OPERATION_EPOCH || op === RELAY_OP.OPERATION_STATUS;

type Result<T> = { ok: true; value: T } | { ok: false; code: string };
export interface RelayOperationScope { authority: string; writer: string; ns: string }
export interface RelayOperationIdentity extends RelayOperationScope { opEpoch: string; opId: string }
export interface RelayOperationRecord {
  opId: string;
  profile: RelayProfileEntry;
  op: string;
  recovery: "epoch" | "durable";
  fingerprint: string;
  state: RelayOperationState;
  terminal?: Record<string, unknown>;
}
export interface RelayOperationNamespace { opEpoch: string; records: RelayOperationRecord[] }

/** A transaction serializes all writers to one scope, including across
 * connections/processes. Persist the returned state before returning value.
 * A durable transaction rolls back state AND the application work on a throw,
 * or recovers the committed fact from its journal. A durable driver uses
 * the same transaction or a recoverable journal for
 * the receipt and the side effect. Recover that journal before serving.
 * Scope capacity belongs to the driver; receipts within a scope are bounded
 * by RelayOperationAuthority. No TTL may delete individual current receipts. */
export interface RelayOperationStore {
  readonly durable: boolean;
  transact<T>(scope: Readonly<RelayOperationScope>,
    update: (current: Readonly<RelayOperationNamespace> | undefined) => { state: RelayOperationNamespace; value: T }): T;
}

export class RelayOperationStoreError extends Error {
  constructor(readonly code: string) { super(code); }
}
const keyOf = (scope: RelayOperationScope): string => JSON.stringify([scope.authority, scope.writer, scope.ns]);
const identityKey = (id: RelayOperationIdentity): string => JSON.stringify([keyOf(id), id.opEpoch, id.opId]);
const copy = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T;
const bytes = (value: unknown): number => new TextEncoder().encode(JSON.stringify(value)).length;
const INITIAL_EPOCH = "0000000000000001";
const scopeValid = (scope: RelayOperationScope): boolean => [scope.authority, scope.writer, scope.ns]
  .every(value => typeof value === "string" && value.length > 0);

/** For input epochs and tests. Reuse across connections to preserve input
 * deduplication. This store cannot advertise durable mutation support. */
export class RelayMemoryOperationStore implements RelayOperationStore {
  readonly durable = false;
  private readonly scopes = new Map<string, RelayOperationNamespace>();
  private readonly initialEpoch: string;
  constructor(private readonly maxScopes = 64, initialEpoch?: string) {
    if (!Number.isSafeInteger(maxScopes) || maxScopes < 1) throw new Error("invalid operation scope capacity");
    if (initialEpoch === undefined) {
      const seed = new Uint8Array(8); globalThis.crypto.getRandomValues(seed);
      // A lost input authority cannot claim the old input epoch continues.
      initialEpoch = Array.from(seed, byte => byte.toString(16).padStart(2, "0")).join("");
    }
    if (!/^[0-9a-f]{16}$/.test(initialEpoch)) throw new Error("invalid input epoch");
    this.initialEpoch = initialEpoch;
  }
  transact<T>(scope: Readonly<RelayOperationScope>,
    update: (current: Readonly<RelayOperationNamespace> | undefined) => { state: RelayOperationNamespace; value: T }): T {
    const key = keyOf(scope), current = this.scopes.get(key);
    if (!current && this.scopes.size >= this.maxScopes) throw new RelayOperationStoreError(RELAY_ERROR.BUSY);
    const result = update(current === undefined ? { opEpoch: this.initialEpoch, records: [] } : freezeRelayCopy(current));
    this.scopes.set(key, copy(result.state));
    return result.value;
  }
}

/** Bounded receipts keyed by authenticated writer + namespace. This object
 * is owned by the authority, not by a relay transport session. */
export class RelayOperationAuthority {
  readonly id: string;
  readonly durable: boolean;
  private readonly maxOperations: number;
  private readonly maxRecordBytes: number;
  private readonly listeners = new Map<string, Set<(terminal: Record<string, unknown>) => void>>();
  private readonly activeScopes = new Set<string>();

  constructor(private readonly options: { id: string; store: RelayOperationStore; maxOperations?: number; maxRecordBytes?: number }) {
    this.id = options.id;
    this.durable = options.store.durable;
    this.maxOperations = options.maxOperations ?? 64;
    this.maxRecordBytes = options.maxRecordBytes ?? 65536;
    if (!this.id || new TextEncoder().encode(this.id).length > 128
        || !Number.isSafeInteger(this.maxOperations) || this.maxOperations < 1
        || !Number.isSafeInteger(this.maxRecordBytes) || this.maxRecordBytes < 256) {
      throw new Error("invalid operation authority bounds");
    }
  }

  private run<T>(scope: RelayOperationScope, update: (state: RelayOperationNamespace) => T): Result<T> {
    if (!scopeValid(scope) || scope.authority !== this.id) return { ok: false, code: RELAY_ERROR.UNAUTHORIZED };
    const key = keyOf(scope);
    // Synchronous transport callbacks can reenter application commit code.
    // Never let a nested cancellation observe a half-finished transaction.
    if (this.activeScopes.has(key)) return { ok: false, code: RELAY_ERROR.BUSY };
    this.activeScopes.add(key);
    try {
      const value = this.options.store.transact(scope, current => {
        const state = current ? copy(current) : { opEpoch: INITIAL_EPOCH, records: [] };
        if (!/^[0-9a-f]{16}$/.test(state.opEpoch) || !Array.isArray(state.records)
            || state.records.length > this.maxOperations) throw new Error("invalid operation store");
        return { state, value: update(state) };
      });
      return { ok: true, value };
    } catch (error) {
      return { ok: false, code: error instanceof RelayOperationStoreError ? error.code : RELAY_ERROR.OUTCOME_UNKNOWN };
    } finally {
      this.activeScopes.delete(key);
    }
  }

  epoch(writer: string, args: RelayOperationEpochArgs): Result<RelayOperationEpochValue> {
    if (validateRelaySchema(RELAY_METADATA_SCHEMAS[`${RELAY_OP.OPERATION_EPOCH}.request`],
      { op: RELAY_OP.OPERATION_EPOCH, args }) || (args.action === "advance" && args.expectedEpoch === undefined)) {
      return { ok: false, code: RELAY_ERROR.INVALID };
    }
    return this.run({ authority: this.id, writer, ns: args.ns }, state => {
      if (args.action === "advance" && args.expectedEpoch === state.opEpoch) {
        if (state.records.some(record => record.state === "pending" || record.state === "unknown")) {
          throw new RelayOperationStoreError(RELAY_ERROR.BUSY);
        }
        if (state.opEpoch === "ffffffffffffffff") throw new RelayOperationStoreError(RELAY_ERROR.RESYNC_REQUIRED);
        state.opEpoch = (BigInt("0x" + state.opEpoch) + 1n).toString(16).padStart(16, "0");
        state.records = [];
      }
      return { opEpoch: state.opEpoch };
    });
  }

  status(writer: string, args: RelayOperationStatusArgs, profile: RelayProfileEntry): Result<RelayOperationStatusValue> {
    if (validateRelaySchema(RELAY_METADATA_SCHEMAS[`${RELAY_OP.OPERATION_STATUS}.request`],
      { op: RELAY_OP.OPERATION_STATUS, args })) return { ok: false, code: RELAY_ERROR.INVALID };
    if (args.authority !== this.id) return { ok: false, code: RELAY_ERROR.UNAUTHORIZED };
    return this.run({ authority: this.id, writer, ns: args.ns }, state => {
      const record = args.opEpoch === state.opEpoch ? state.records.find(record => record.opId === args.opId) : undefined;
      if (!record || !samePrivateProfile(record.profile, profile)) return { state: "unknown" };
      const receipt = (record.terminal?.value as { receipt?: unknown } | undefined)?.receipt;
      return { state: record.state, ...(receipt === undefined ? {} : { receipt: copy(receipt) }) };
    });
  }

  begin(writer: string, ns: string, op: RelayPrivateOp, opEpoch: string, opId: string, args: unknown):
    Result<{ identity: RelayOperationIdentity; fresh: boolean; record: RelayOperationRecord }> {
    if (op.recovery === "idempotent" || (op.recovery === "durable" && !this.durable)) {
      return { ok: false, code: RELAY_ERROR.UNSUPPORTED };
    }
    if (!/^[0-9a-f]{16}$/.test(opEpoch) || !/^[0-9a-f]{32}$/.test(opId)) return { ok: false, code: RELAY_ERROR.INVALID };
    const identity = freezeRelayCopy({ authority: this.id, writer, ns, opEpoch, opId });
    // Object order does not change a request's identity. Array order does.
    const canonical = (value: unknown): unknown => {
      if (Array.isArray(value)) return value.map(canonical);
      if (value && typeof value === "object") return Object.fromEntries(
        Object.keys(value).sort().map(key => [key, canonical((value as Record<string, unknown>)[key])]),
      );
      return value;
    };
    const fingerprint = JSON.stringify(canonical(args));
    return this.run(identity, state => {
      if (opEpoch !== state.opEpoch) throw new RelayOperationStoreError(RELAY_ERROR.STALE_BASE);
      const found = state.records.find(record => record.opId === opId);
      if (found) {
        if (!samePrivateProfile(found.profile, op.profile) || found.op !== op.name
            || found.recovery !== op.recovery || found.fingerprint !== fingerprint) {
          throw new RelayOperationStoreError(RELAY_ERROR.INVALID);
        }
        return { identity, fresh: false, record: freezeRelayCopy(found) };
      }
      if (state.records.length >= this.maxOperations) throw new RelayOperationStoreError(RELAY_ERROR.BUSY);
      const record: RelayOperationRecord = { opId, profile: op.profile, op: op.name,
        recovery: op.recovery as "epoch" | "durable", fingerprint, state: "pending" };
      if (bytes(record) > this.maxRecordBytes) throw new RelayOperationStoreError(RELAY_ERROR.TOO_LARGE);
      state.records.push(record);
      return { identity, fresh: true, record: freezeRelayCopy(record) };
    });
  }

  /** Endpoint watchers are bounded by admitted request slots. Detach on a
   * terminal or disconnect; the record survives without a live watcher. */
  watch(identity: RelayOperationIdentity, deliver: (terminal: Record<string, unknown>) => void): () => void {
    const key = identityKey(identity);
    let listeners = this.listeners.get(key);
    if (!listeners) this.listeners.set(key, listeners = new Set());
    listeners.add(deliver);
    return () => { listeners!.delete(deliver); if (listeners!.size === 0) this.listeners.delete(key); };
  }

  observing(identity: RelayOperationIdentity): boolean { return this.listeners.has(identityKey(identity)); }

  read(identity: RelayOperationIdentity): Result<RelayOperationRecord> {
    return this.run(identity, state => {
      const record = this.record(state, identity);
      return freezeRelayCopy(record);
    });
  }

  private record(state: RelayOperationNamespace, identity: RelayOperationIdentity): RelayOperationRecord {
    if (identity.authority !== this.id || identity.opEpoch !== state.opEpoch) throw new RelayOperationStoreError(RELAY_ERROR.STALE_BASE);
    const record = state.records.find(record => record.opId === identity.opId);
    if (!record) throw new RelayOperationStoreError(RELAY_ERROR.NOT_FOUND);
    return record;
  }

  /** Store a validated terminal and run the side effect inside the storage
   * transaction. An unknown result permits reconciliation, never execution.
   * A completed record wins over a later cancellation or duplicate commit. */
  finish(identity: RelayOperationIdentity, terminal: Record<string, unknown>,
    options: { apply?: () => void; reconcile?: boolean } = {}): Result<Record<string, unknown>> {
    const result = this.run(identity, state => {
      const record = this.record(state, identity);
      if (record.state === "committed" || record.state === "rejected") return freezeRelayCopy(record.terminal!);
      if (record.state === "unknown" && !options.reconcile) return freezeRelayCopy(record.terminal!);
      if (record.state === "unknown" && options.apply) throw new RelayOperationStoreError(RELAY_ERROR.OUTCOME_UNKNOWN);
      const effect = terminal.effect;
      if (terminal.op !== record.op || terminal.final !== true
          || ![RELAY_STATUS.OK, RELAY_STATUS.ERROR].includes(terminal.status as "ok" | "error")
          || (effect !== RELAY_EFFECT.NONE && effect !== RELAY_EFFECT.COMMITTED && effect !== RELAY_EFFECT.UNKNOWN)
          || (terminal.status === RELAY_STATUS.OK && effect !== RELAY_EFFECT.COMMITTED)
          || (terminal.status === RELAY_STATUS.ERROR && effect === RELAY_EFFECT.COMMITTED)
          || ((terminal.error as { code?: string } | undefined)?.code === RELAY_ERROR.CANCELLED && effect !== RELAY_EFFECT.NONE)
          || (options.reconcile && effect === RELAY_EFFECT.UNKNOWN)) throw new RelayOperationStoreError(RELAY_ERROR.INVALID);
      if (options.reconcile && record.state !== "unknown") throw new RelayOperationStoreError(RELAY_ERROR.INVALID);
      if (effect === RELAY_EFFECT.COMMITTED && !options.apply && !options.reconcile) {
        throw new RelayOperationStoreError(RELAY_ERROR.INVALID);
      }
      const next = { ...record, state: effect === RELAY_EFFECT.COMMITTED ? "committed" as const
        : effect === RELAY_EFFECT.NONE ? "rejected" as const : "unknown" as const, terminal: copy(terminal) };
      if (bytes(next) > this.maxRecordBytes) throw new RelayOperationStoreError(RELAY_ERROR.TOO_LARGE);
      if (options.apply) {
        if (effect !== RELAY_EFFECT.COMMITTED || typeof options.apply !== "function") throw new RelayOperationStoreError(RELAY_ERROR.INVALID);
        if (options.apply.constructor.name === "AsyncFunction") throw new RelayOperationStoreError(RELAY_ERROR.INVALID);
        try {
          const applied: unknown = options.apply();
          if (applied && typeof (applied as { then?: unknown }).then === "function") throw new Error("operation commit must be synchronous");
        } catch {
          // An application exception is not proof of a pre-admission error,
          // even when it happens to be a RelayOperationStoreError.
          throw new Error("operation effect failed");
        }
      }
      Object.assign(record, next);
      return freezeRelayCopy(record.terminal!);
    });
    if (result.ok) {
      // A delivery failure cannot roll back a persisted receipt.
      for (const deliver of [...(this.listeners.get(identityKey(identity)) ?? [])]) {
        try { deliver(result.value); } catch { /* session teardown owns undeliverable terminals */ }
      }
    } else if (options.apply && result.code === RELAY_ERROR.OUTCOME_UNKNOWN) {
      // An input callback can have delivered bytes before throwing. A storage
      // commit can also fail after its outcome became uncertain. Preserve the
      // operation for query/reconciliation; neither retry nor CANCEL may
      // turn that uncertainty into another execution or a no-effect claim.
      const record = this.read(identity);
      if (record.ok) this.finish(identity, { op: record.value.op, status: RELAY_STATUS.ERROR, final: true,
        effect: RELAY_EFFECT.UNKNOWN, error: { code: RELAY_ERROR.OUTCOME_UNKNOWN, message: "operation commit outcome unknown" } });
    }
    return result;
  }
}

/** Validate a public operation envelope before queue admission or dispatch.
 * Receipt structure is supplied by the selected profile's local schemas. */
export function prepareOperation(
  op: RelayOperationOp, input: RelayFrameBodyInput, limits: RelayRxLimits, definitions: readonly RelayPrivateOp[],
): { ok: true; metadata: Record<string, unknown> } | { ok: false; code: string } {
  if ((input.codec ?? RELAY_CODEC.NONE) !== RELAY_CODEC.NONE || (input.data?.length ?? 0) !== 0) {
    return { ok: false, code: RELAY_ERROR.UNSUPPORTED };
  }
  const prepared = prepareFrameBody(input, { maxWireBytes: limits.maxWireBytes, maxMetaBytes: limits.maxMetaBytes, codecs: [RELAY_CODEC.NONE] });
  if (!prepared.ok) return { ok: false, code: prepared.code === "WIRE_TOO_LARGE" || prepared.code === "META_TOO_LARGE"
    ? RELAY_ERROR.TOO_LARGE : RELAY_ERROR.INVALID };
  const metadata = JSON.parse(new TextDecoder().decode(prepared.body.meta)) as Record<string, unknown>;
  const suffix = input.type === RELAY_TYPE.REQUEST ? "request" : metadata.status === RELAY_STATUS.ERROR ? "error" : "response";
  if ((input.type !== RELAY_TYPE.REQUEST && input.type !== RELAY_TYPE.RESPONSE)
      || validateRelaySchema(RELAY_METADATA_SCHEMAS[`${op}.${suffix}`], metadata)) return { ok: false, code: RELAY_ERROR.INVALID };
  const value = input.type === RELAY_TYPE.REQUEST ? metadata.args : metadata.value;
  if (value !== undefined && bytes(value) > limits.maxObjectBytes) return { ok: false, code: RELAY_ERROR.TOO_LARGE };
  if (input.type === RELAY_TYPE.REQUEST && op === RELAY_OP.OPERATION_EPOCH) {
    const args = metadata.args as RelayOperationEpochArgs;
    if (args.action === "advance" && args.expectedEpoch === undefined) return { ok: false, code: RELAY_ERROR.INVALID };
  }
  if (input.type === RELAY_TYPE.RESPONSE && metadata.status === RELAY_STATUS.ERROR
      && !Object.values(RELAY_ERROR).includes((metadata.error as { code: typeof RELAY_ERROR.INVALID }).code)) {
    return { ok: false, code: RELAY_ERROR.INVALID };
  }
  if (input.type === RELAY_TYPE.RESPONSE && op === RELAY_OP.OPERATION_STATUS && metadata.status === RELAY_STATUS.OK) {
    const value = metadata.value as RelayOperationStatusValue;
    if (value.receipt !== undefined) {
      if ((value.state !== "committed" && value.state !== "rejected") || !definitions.some(definition => {
        const receipt = (definition.value.properties as Record<string, Record<string, unknown>> | undefined)?.receipt;
        return definition.recovery !== "idempotent" && receipt && validateRelaySchema(receipt, value.receipt) === null;
      })) return { ok: false, code: RELAY_ERROR.INVALID };
    }
  }
  return { ok: true, metadata };
}
