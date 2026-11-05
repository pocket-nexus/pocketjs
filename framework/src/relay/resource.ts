/** Relay L2 resource layer — identity, get/subscribe/release, invalidation,
 * chunked atomic publication and residence budget (R5 draft §3.5–§3.8).
 *
 * Both ends are transport-neutral state machines. The L1 session layer
 * (HELLO/OPEN/seq/correlation/credit) sits below `RelayResourceWire`; L2
 * never assigns a session or a wire seq. Frames cross the seam as metadata
 * plus an optional data region:
 *
 *   RelayResourceClient    (guest/consumer): get, subscribe, unsubscribe,
 *     release, reportEvict; receives RESPONSE/PUSH/INVALIDATE.
 *   RelayResourceAuthority (companion/provider): validates requests,
 *     allocates subscription/lease/transfer ids (never reused), chunks
 *     outbound objects, emits scoped invalidation.
 *
 * Publication invariants: a chunked object reaches a subscriber or the local
 * entry once, after the complete object passes its digest check at a frame
 * boundary. A half object is never visible. Invalidation advances a local
 * generation; late responses stamped with an older generation are dropped. */

import {
  RELAY_CODEC,
  RELAY_DELIVERY,
  RELAY_ERROR,
  RELAY_EVICT_REASON,
  RELAY_FRAME,
  RELAY_INVALIDATE_SCOPE,
  RELAY_LIMITS,
  RELAY_OP,
  RELAY_STATUS,
  RELAY_TYPE,
  type RelayErrorBody,
  type RelayResourceRef,
} from "../../../contracts/spec/relay.ts";
import type { ResourceLoad, ResourceResult } from "../resource-cache.ts";
import { stringToUtf8 } from "../bytes.ts";
import { RelayChunkAssembler } from "./assembler.ts";
import type { RelayResourceErrorCode } from "./assembler.ts";
import { sha256Hex } from "./sha256.ts";
import { validateRelayMetadata } from "./metadata.ts";

export { RELAY_DELIVERY, RELAY_INVALIDATE_SCOPE, RELAY_EVICT_REASON };

const hex16 = (n: number): string => {
  if (!Number.isSafeInteger(n) || n < 0 || n > 0xffffffffffffffff) throw new Error("offset out of u64");
  return n.toString(16).padStart(16, "0");
};

// --- identity ----------------------------------------------------------------

/** Local fence/entry identity per §3.5: (kind, ns, key, rendition).
 * `revision` is not part of the identity: a get may omit it ("current
 * version") while the response names a concrete revision, and a §3.8
 * key/namespace invalidate moves the generation of every revision of the
 * identity. The concrete revision is compared separately on the entry, the
 * response and revision-scope invalidation. See the §3.5 cache-key errata in
 * docs/RELAY.md.
 *
 * The key is the JSON encoding of the tuple, not a delimiter join: the
 * schema bounds the byte length of ns/key/rendition but reserves no
 * character, so `{ns:"a", key:"b|c"}` and `{ns:"a|b", key:"c"}` must map to
 * two keys (review 1070 M1). */
export function relayResourceKey(ref: RelayResourceRef): string {
  return JSON.stringify([ref.kind, ref.ns, ref.key, ref.rendition]);
}

function refMatchesKeyScope(a: RelayResourceRef, b: RelayResourceRef): boolean {
  return a.kind === b.kind && a.ns === b.ns && a.key === b.key && a.rendition === b.rendition;
}

/** Bind a successful get response to the ref the request selected. A
 * revisionless request means "current" and accepts the concrete revision
 * returned by the authority; a request that names a revision fixes it. */
export function relayGetResponseMatchesRequest(request: RelayResourceRef, response: RelayResourceRef): boolean {
  return refMatchesKeyScope(request, response)
    && (request.revision === undefined || request.revision === response.revision);
}

/** A resource kind is usable only when HELLO selected it. */
export function relayKindNegotiated(kinds: readonly number[], kind: number): boolean {
  return kinds.includes(kind);
}

/** A ref-scoped subscription fixes the resource's revision-independent
 * identity; its revision advances as pushes arrive. A namespace-scoped
 * subscription admits every resource kind and key in that namespace. */
function refMatchesSubscription(
  filter: { ns: string; kind?: number; key?: string; rendition?: string },
  ref: RelayResourceRef,
): boolean {
  if (filter.ns !== ref.ns) return false;
  if (filter.kind === undefined) return true;
  return filter.kind === ref.kind && filter.key === ref.key && filter.rendition === ref.rendition;
}

/** Session-scoped u32 allocator. Ids start at 1 and are never reused; after
 * 0xffffffff the allocator refuses instead of wrapping (§3.3/§3.6). */
export class RelayIdAllocator {
  private next = 1;
  allocate(): number {
    if (this.next > 0xffffffff) throw new Error("RELAY id space exhausted; reopen the stream or session");
    return this.next++;
  }
  allocated(): number {
    return this.next - 1;
  }
}

// --- frame seam --------------------------------------------------------------

/** What L1 must provide. request() returns the correlation it allocated, or
 * 0 when the bounded request window is full. A data-bearing request names
 * its codec; without data the frame carries codec 0. */
export interface RelayResourceWire {
  request(stream: number, metadata: Record<string, unknown>, data?: Uint8Array, codec?: number): number;
  /** Send a correlation-less INVALIDATE-type advisory (cache.evict). */
  advise(metadata: Record<string, unknown>): void;
  /** request.cancel on stream 0; the terminal RESPONSE still arrives on the
   * original business stream. */
  cancel(stream: number, correlation: number, reason?: string): void;
}

/** Decoded frame shape the session pump hands to handleFrame(). */
export interface RelayResourceIncomingFrame {
  type: number;
  codec: number;
  stream: number;
  correlation: number;
  metadata: Record<string, unknown>;
  data: Uint8Array;
}

export interface RelayResourceNegotiated {
  /** rxLimits.maxObjectBytes: largest assembled object this receiver reserves. */
  maxObjectBytes: number;
  codecs: readonly number[];
  /** RELAY_KIND values selected by HELLO mutual intersection. */
  kinds: readonly number[];
}

/** Product parameters a registered form admitted into the public args:
 * they are merged at the one registered key, never as top-level fields. */
export interface RelayProductArgs {
  key: string;
  value: unknown;
}

/** Locally installed value schemas for inbound resource content. The
 * client looks the stream's negotiated profile up per frame. */
export interface RelayResourceValueValidator {
  /** Null when the value satisfies the installed form, a reason otherwise. */
  validateValue(profile: { name: string; version: number } | undefined, kind: number, value: unknown): string | null;
  /** Decode and validate one complete codec-1 (JSON) object. Binary codecs
   * have no JSON schema and pass. */
  validateJson(profile: { name: string; version: number } | undefined, kind: number, bytes: Uint8Array): string | null;
  streamProfile(stream: number): { name: string; version: number } | undefined;
}

export interface RelayPublishedObject {
  ref: RelayResourceRef;
  codec: number;
  data: Uint8Array;
  value?: unknown;
  digest?: string;
}

export interface RelayResourceError {
  code: string;
  message?: string;
}

export type RelayGetOutcome =
  | { notModified: true; revision: string }
  | RelayPublishedObject;

// --- consumer ----------------------------------------------------------------

/** §3.8 bounded invalidation markers: distinct concrete revisions one
 * in-flight get records before the marker escalates to a fence over the
 * whole get. A receiver-local guarantee, not a negotiated wire limit; the
 * store holds at most maxPending × this many revision strings. */
export const RELAY_MAX_FENCED_REVISIONS = 8;

interface PendingGet {
  kind: "get";
  stream: number;
  ref: RelayResourceRef;
  /** Local identity generation captured at request time; a response stamped
   * with an older generation is dropped after a key/namespace invalidation. */
  generation: number;
  /** Concrete revisions a revision-scope invalidate named while this get was
   * in flight. The late response is dropped when it names one of them; a
   * response for a newer revision may still publish. At most
   * maxFencedRevisions distinct revisions are kept; one more sets fenceAll
   * instead, so a marker is never dropped for lack of room (§3.8). */
  fencedRevisions?: Set<string>;
  /** Marker overflow: every response to this get is dropped as RESYNC_REQUIRED. */
  fenceAll: boolean;
  /** Assembler reservation exists for this correlation. */
  reserved: boolean;
  complete: (result: ResourceResult<RelayGetOutcome>) => void;
}

interface PendingControl {
  kind: "subscribe" | "unsubscribe" | "release";
  stream: number;
  /** `response` is the terminal's metadata on success; the subscribe path
   * reads the concrete revision the authority named from it. */
  complete: (result: ResourceResult<{ subscription?: number }>, response?: Record<string, unknown>) => void;
}

type Pending = PendingGet | PendingControl;

/** The op a pending request's RESPONSE must carry. */
const PENDING_OP: Record<Pending["kind"], string> = {
  get: RELAY_OP.RESOURCE_GET,
  subscribe: RELAY_OP.RESOURCE_SUBSCRIBE,
  unsubscribe: RELAY_OP.RESOURCE_UNSUBSCRIBE,
  release: RELAY_OP.RESOURCE_RELEASE,
};

/** Clip diagnostics to the §3.4 160-byte error.message bound without
 * splitting a character. */
function clipErrorMessage(s: string): string {
  let bytes = 0;
  let out = "";
  for (const ch of s) {
    const cp = ch.codePointAt(0)!;
    const n = cp < 0x80 ? 1 : cp < 0x800 ? 2 : cp < 0x10000 ? 3 : 4;
    if (bytes + n > RELAY_LIMITS.errorMessageMaxBytes) break;
    bytes += n;
    out += ch;
  }
  return out;
}

export interface RelaySubscriptionHandler {
  /** One complete, in-order object. Reliable deltas arrive chained by
   * baseRevision; a broken chain sets resyncRequired. */
  onObject(object: RelayPublishedObject, ctx: { resyncRequired: boolean }): void;
  /** The subscription failed terminally (error, reset) or was closed. */
  onEnd?(error?: RelayResourceError): void;
}

export interface RelaySubscriptionEntry {
  id: number;
  stream: number;
  delivery: string;
  filter: { ns: string; kind?: number; key?: string; rendition?: string };
  revision: string | undefined;
  resyncRequired: boolean;
  handler: RelaySubscriptionHandler;
}

export interface RelayLocalEntry {
  ref: RelayResourceRef;
  revision: string;
  generation: number;
  stale: boolean;
}

export class RelayResourceClient {
  private readonly pending = new Map<number, Pending>();
  private readonly subscriptions = new Map<number, RelaySubscriptionEntry>();
  private readonly entries = new Map<string, RelayLocalEntry>();
  /** Monotonic per-identity invalidation generations: the single counter a
   * get captures and a late response is compared against; a resident entry
   * mirrors it and never feeds it. A marker outlives the entry while a get
   * that captured the older value is in flight (a revision-scope
   * invalidation deletes the entry but the late response must observe the
   * moved generation) and is dropped once neither an entry nor a pending
   * get references it, so the map is bounded by entries + pending
   * (review 1070 M2). */
  private readonly generations = new Map<string, number>();
  /** Subscriptions the provider holds active after this end refused their
   * push channel, each awaiting a resource.unsubscribe the request window
   * could not take yet (subscription id -> stream). Retried on the next
   * incoming frame; dropped with the stream on reset. One per refused
   * subscribe response, so bounded by the subscribes the caller issued. */
  private readonly orphans = new Map<number, number>();
  private readonly assembler: RelayChunkAssembler;
  private readonly maxFencedRevisions: number;
  private protocolErrors = 0;

  constructor(private readonly opts: {
    wire: RelayResourceWire;
    negotiated: RelayResourceNegotiated;
    assembler: RelayChunkAssembler;
    /** Revision markers kept per in-flight get; default RELAY_MAX_FENCED_REVISIONS. */
    maxFencedRevisions?: number;
    /** Installed product value schemas; absent without registered forms. */
    productForms?: RelayResourceValueValidator;
  }) {
    this.assembler = opts.assembler;
    const markers = opts.maxFencedRevisions ?? RELAY_MAX_FENCED_REVISIONS;
    if (!Number.isInteger(markers) || markers < 1) throw new Error("maxFencedRevisions must be a positive integer");
    this.maxFencedRevisions = markers;
  }

  /** Validate one inbound value (or assembled JSON) against the form bound
   * to the frame's stream profile and the caller-selected kind. A get passes
   * its pending request kind, never the peer-controlled response kind. */
  private invalidProductValue(
    frame: RelayResourceIncomingFrame, kind: number, value: unknown, bytes?: Uint8Array,
  ): string | null {
    const forms = this.opts.productForms;
    if (!forms) return null;
    const profile = forms.streamProfile(frame.stream);
    if (bytes !== undefined) {
      // Data is the content carrier. Codec 1 has a JSON schema in this layer;
      // other binary codecs use their product validator outside this layer.
      return frame.codec === RELAY_CODEC.JSON ? forms.validateJson(profile, kind, bytes) : null;
    }
    return forms.validateValue(profile, kind, value);
  }

  /** resource.get. A conditional fetch with ifRevision may return
   * notModified, which still names the concrete revision. `product`
   * carries the one registered args key; the caller has already matched it
   * to the stream's form. */
  get(
    stream: number,
    ref: RelayResourceRef,
    args: { accept: number[]; maxObjectBytes: number; ifRevision?: string; product?: RelayProductArgs },
    complete: PendingGet["complete"],
  ): { correlation: number } | { ok: false; code: string } {
    if (!relayKindNegotiated(this.opts.negotiated.kinds, ref.kind)) {
      return { ok: false, code: RELAY_ERROR.UNSUPPORTED };
    }
    if (!args.accept.length
      || !args.accept.every((c) => Number.isInteger(c) && c >= 0 && c <= 0xffff && this.opts.negotiated.codecs.includes(c))) {
      return { ok: false, code: RELAY_ERROR.INVALID };
    }
    if (!Number.isSafeInteger(args.maxObjectBytes) || args.maxObjectBytes <= 0
      || args.maxObjectBytes > this.opts.negotiated.maxObjectBytes) {
      return { ok: false, code: RELAY_ERROR.TOO_LARGE };
    }
    // Reserve-then-accept: refuse (BUSY) before consuming a request slot
    // when the local assembly budget cannot hold the authorized ceiling.
    if (!this.assembler.canReserve(args.maxObjectBytes)) return { ok: false, code: RELAY_ERROR.BUSY };
    const metadata: Record<string, unknown> = {
      op: RELAY_OP.RESOURCE_GET,
      resource: ref,
      args: { accept: [...args.accept], maxObjectBytes: args.maxObjectBytes },
    };
    if (args.ifRevision) (metadata.args as Record<string, unknown>).ifRevision = args.ifRevision;
    if (args.product) (metadata.args as Record<string, unknown>)[args.product.key] = args.product.value;
    const correlation = this.opts.wire.request(stream, metadata);
    if (correlation === 0) return { ok: false, code: RELAY_ERROR.BUSY };
    // The capacity was pre-checked; reserve the concrete correlation in the
    // get (RESPONSE correlation) id space.
    const reservation = this.assembler.reserve({ stream, channel: correlation, space: "get" }, args.maxObjectBytes);
    if (!reservation.ok) {
      // A request is already on the wire; withdraw interest so the provider
      // does not keep working and the request window is not leaked (§3.9).
      this.opts.wire.cancel(stream, correlation, "busy");
      return { ok: false, code: reservation.code };
    }
    this.pending.set(correlation, {
      kind: "get", stream, ref, generation: this.generationFor(ref), fenceAll: false, reserved: true, complete,
    });
    return { correlation };
  }

  /** Withdraw interest in an in-flight get. The provider still emits one
   * terminal response; the request slot frees only after it is consumed
   * (§3.9). */
  cancel(correlation: number, reason = "cancel"): void {
    const pending = this.pending.get(correlation);
    if (pending) this.opts.wire.cancel(pending.stream, correlation, reason);
  }

  /** resource.subscribe. The concrete subscription id arrives in the
   * terminal response and is never reused. */
  subscribe(
    stream: number,
    target: RelayResourceRef | { ns: string },
    delivery: string,
    handler: RelaySubscriptionHandler,
    complete: PendingControl["complete"],
    options: { maxObjectBytes?: number; product?: RelayProductArgs } = {},
  ): { correlation: number } | { ok: false; code: string } {
    if (delivery !== RELAY_DELIVERY.RELIABLE_DELTA && delivery !== RELAY_DELIVERY.LATEST_SNAPSHOT) {
      return { ok: false, code: RELAY_ERROR.INVALID };
    }
    // The push channel reserves what this subscriber accepts for this
    // resource, not the whole negotiated ceiling (§3.7 reserve-then-accept):
    // a namespace whose pushes are small documents must not hold the scratch
    // a 256px tile would need. A larger push fails the assembly, as an
    // oversized get does.
    const maxObjectBytes = options.maxObjectBytes ?? this.opts.negotiated.maxObjectBytes;
    if (!Number.isSafeInteger(maxObjectBytes) || maxObjectBytes <= 0
      || maxObjectBytes > this.opts.negotiated.maxObjectBytes) return { ok: false, code: RELAY_ERROR.INVALID };
    const isRef = "kind" in target;
    if (isRef && !relayKindNegotiated(this.opts.negotiated.kinds, (target as RelayResourceRef).kind)) {
      return { ok: false, code: RELAY_ERROR.UNSUPPORTED };
    }
    // Reserve-then-accept (§3.7), as the get path: refuse (BUSY) before
    // consuming a request slot when the push channel could not be admitted
    // now. The reservation itself needs the id the terminal response carries.
    if (!this.assembler.canReserve(maxObjectBytes)) return { ok: false, code: RELAY_ERROR.BUSY };
    const argsMeta: Record<string, unknown> = isRef
      ? { delivery }
      : { delivery, namespace: (target as { ns: string }).ns };
    if (options.product) argsMeta[options.product.key] = options.product.value;
    const metadata: Record<string, unknown> = {
      op: RELAY_OP.RESOURCE_SUBSCRIBE,
      args: argsMeta,
    };
    if (isRef) metadata.resource = target;
    const correlation = this.opts.wire.request(stream, metadata);
    if (correlation === 0) return { ok: false, code: RELAY_ERROR.BUSY };
    this.pending.set(correlation, {
      kind: "subscribe", stream,
      complete: (result, response) => {
        if (result.ok && "value" in result && typeof result.value.subscription === "number") {
          const id = result.value.subscription;
          // Reserve the push channel in the subscription id space, distinct
          // from get correlations (§3.7); admission failure closes the
          // subscription.
          const reservation = this.assembler.reserve({ stream, channel: id, space: "push" }, maxObjectBytes);
          if (!reservation.ok) {
            // The provider holds the subscription active and would keep
            // pushing to a channel this end cannot assemble: withdraw it with
            // resource.unsubscribe (§3.8 lease teardown) and report the
            // admission failure, not an id the caller never held.
            this.withdrawSubscription(stream, id);
            handler.onEnd?.({ code: reservation.code });
            complete({ ok: false, error: { code: reservation.code } });
            return;
          }
          if (isRef) {
            const ref = target as RelayResourceRef;
            // §3.6: the request's revision is a starting-base hint; the
            // terminal names the concrete revision the authority holds, and
            // that is the base the first delta must match (review 1070 N1).
            const named = (response?.resource as RelayResourceRef | undefined)?.revision;
            this.subscriptions.set(id, {
              id, stream, delivery,
              filter: { ns: ref.ns, kind: ref.kind, key: ref.key, rendition: ref.rendition },
              revision: named ?? ref.revision, resyncRequired: false, handler,
            });
          } else {
            this.subscriptions.set(id, {
              id, stream, delivery,
              filter: { ns: (target as { ns: string }).ns },
              revision: undefined, resyncRequired: false, handler,
            });
          }
        }
        complete(result);
      },
    });
    return { correlation };
  }

  /** resource.unsubscribe. Queued pushes already on the wire are consumed
   * and dropped after the terminal response. */
  unsubscribe(
    subscription: number,
    complete: PendingControl["complete"] = () => {},
  ): { correlation: number } | { ok: false; code: string } {
    const sub = this.subscriptions.get(subscription);
    if (!sub) return { ok: false, code: RELAY_ERROR.NOT_FOUND };
    const correlation = this.opts.wire.request(sub.stream, {
      op: RELAY_OP.RESOURCE_UNSUBSCRIBE,
      args: { subscription },
    });
    if (correlation === 0) return { ok: false, code: RELAY_ERROR.BUSY };
    this.pending.set(correlation, {
      kind: "unsubscribe", stream: sub.stream,
      complete: (result) => {
        if (result.ok) this.closeSubscription(subscription);
        complete(result);
      },
    });
    return { correlation };
  }

  /** resource.release — only for an explicit provider lease on remote
   * residence. Local cache eviction uses reportEvict. */
  release(
    stream: number,
    ref: RelayResourceRef,
    lease: number,
    complete: PendingControl["complete"] = () => {},
  ): { correlation: number } | { ok: false; code: string } {
    if (!relayKindNegotiated(this.opts.negotiated.kinds, ref.kind)) {
      return { ok: false, code: RELAY_ERROR.UNSUPPORTED };
    }
    if (!Number.isInteger(lease) || lease === 0) return { ok: false, code: RELAY_ERROR.INVALID };
    const correlation = this.opts.wire.request(stream, {
      op: RELAY_OP.RESOURCE_RELEASE, resource: ref, args: { lease },
    });
    if (correlation === 0) return { ok: false, code: RELAY_ERROR.BUSY };
    this.pending.set(correlation, { kind: "release", stream, complete });
    return { correlation };
  }

  /** Dispose a local copy and advise the provider with cache.evict. The
   * advise is fire-and-forget: it requires no ACK and the provider may
   * ignore it (R5 Q5). Local disposal happens whether or not the wire
   * accepts the frame. */
  reportEvict(ref: RelayResourceRef, reason: string): void {
    if (reason !== RELAY_EVICT_REASON.BUDGET && reason !== RELAY_EVICT_REASON.VIEW_CLOSE) return;
    if (!relayKindNegotiated(this.opts.negotiated.kinds, ref.kind)) return;
    const key = relayResourceKey(ref);
    this.entries.delete(key);
    this.pruneGeneration(key);
    this.opts.wire.advise({ op: RELAY_OP.CACHE_EVICT, resource: ref, args: { reason } });
  }

  /** Drop an identity's generation marker once nothing references it: no
   * resident entry mirrors it and no in-flight get captured it. The fence
   * compares a captured value with the current one, so with neither an
   * entry nor a pending get the absolute value carries no information; the
   * next get captures whatever the counter holds. Callers prune after the
   * fence decision of the frame they are handling, never before it. */
  private pruneGeneration(key: string): void {
    if (this.entries.has(key)) return;
    for (const p of this.pending.values()) {
      if (p.kind === "get" && relayResourceKey(p.ref) === key) return;
    }
    this.generations.delete(key);
  }

  /** INVALIDATE received from the authority. Session pumps may also call
   * this directly after classifying the frame. */
  applyInvalidate(meta: Record<string, unknown>): void {
    if (validateRelayMetadata(RELAY_OP.RESOURCE_INVALIDATE, meta)) { this.protocolErrors++; return; }
    const args = meta.args as { scope: string; namespace?: string; reason?: string };
    const ref = meta.resource as RelayResourceRef | undefined;
    if (ref && !relayKindNegotiated(this.opts.negotiated.kinds, ref.kind)) {
      this.protocolErrors++;
      return;
    }
    const ns = ref?.ns ?? args.namespace!;

    const revisionScope = args.scope === RELAY_INVALIDATE_SCOPE.REVISION;
    const inScope = (target: RelayResourceRef): boolean => args.scope === RELAY_INVALIDATE_SCOPE.NAMESPACE
      ? target.ns === ns
      : ref !== undefined && refMatchesKeyScope(target, ref);
    // Identity keys whose revision-free generation moves. Key/namespace scope
    // move it once per invalidate per identity, whatever the number of
    // resident entries and in-flight gets that match: `generations` is the
    // single counter and an entry only mirrors it (review 989 G1).
    const moved = new Set<string>();

    for (const [key, entry] of this.entries) {
      if (!inScope(entry.ref)) continue;
      if (revisionScope) {
        // Revision scope removes only the concrete revision; a newer resident
        // revision of the same identity stays. The marker stays while a get
        // of the identity is in flight and goes with the entry otherwise.
        if (entry.ref.revision === ref!.revision) {
          entry.stale = true;
          this.entries.delete(key);
          this.pruneGeneration(key);
        }
        continue;
      }
      // The stale value is retained under the moved generation.
      entry.stale = true;
      moved.add(key);
    }
    // In-flight gets: key/namespace scope move the identity fence; revision
    // scope records the concrete revision that must not land (a response for
    // a newer revision may still publish).
    for (const pending of this.pending.values()) {
      if (pending.kind !== "get" || !inScope(pending.ref)) continue;
      if (!revisionScope) { moved.add(relayResourceKey(pending.ref)); continue; }
      // Revision scope records the invalidated concrete revision on every
      // get of this key identity, including a revisionless "current version"
      // get: the fence is checked against the response's concrete revision,
      // not the request name.
      if (ref!.revision !== undefined) this.fenceRevision(pending, ref!.revision);
    }
    for (const idKey of moved) {
      const next = (this.generations.get(idKey) ?? 0) + 1;
      this.generations.set(idKey, next);
      const entry = this.entries.get(idKey);
      if (entry) entry.generation = next;
    }

    // In-flight gets keep their assembler reservation until the (now stale)
    // terminal response arrives; scratch is released there and the result is
    // fenced by generation. Dropping it early would mislabel a stale-but-
    // complete object as a wire INVALID.

    for (const sub of this.subscriptions.values()) {
      const matches = sub.filter.ns === ns
        && (!ref || (sub.filter.kind === undefined || sub.filter.kind === ref.kind)
          && (!sub.filter.key || (sub.filter.key === ref.key && sub.filter.rendition === ref.rendition
            && (args.scope !== RELAY_INVALIDATE_SCOPE.REVISION || sub.revision === ref.revision))));
      if (matches) {
        sub.revision = undefined;
        sub.resyncRequired = true;
      }
    }
  }

  /** Dispatch one decoded RESPONSE/PUSH/INVALIDATE frame from the pump. */
  handleFrame(frame: RelayResourceIncomingFrame): void {
    if (frame.type === RELAY_TYPE.INVALIDATE) {
      if (frame.metadata.op === RELAY_OP.RESOURCE_INVALIDATE) this.applyInvalidate(frame.metadata);
      // cache.evict travels consumer -> authority only; receiving one is a no-op.
    } else if (frame.type === RELAY_TYPE.RESPONSE) this.handleResponse(frame);
    else if (frame.type === RELAY_TYPE.PUSH) this.handlePush(frame);
    // A consumed terminal response may have freed the request window: retry
    // the withdrawals it refused earlier.
    if (this.orphans.size) this.withdrawOrphans();
  }

  /** resource.unsubscribe for a subscription this end never admitted. The
   * terminal response is consumed and dropped. A full request window keeps
   * the id in `orphans` for the next attempt instead of losing it. */
  private withdrawSubscription(stream: number, id: number): boolean {
    const correlation = this.opts.wire.request(stream, {
      op: RELAY_OP.RESOURCE_UNSUBSCRIBE, args: { subscription: id },
    });
    if (correlation === 0) { this.orphans.set(id, stream); return false; }
    this.orphans.delete(id);
    this.pending.set(correlation, { kind: "unsubscribe", stream, complete: () => {} });
    return true;
  }

  private withdrawOrphans(): void {
    for (const [id, stream] of this.orphans) {
      if (!this.withdrawSubscription(stream, id)) return; // window still full; keep the rest
    }
  }

  private handleResponse(frame: RelayResourceIncomingFrame): void {
    const pending = this.pending.get(frame.correlation);
    if (!pending) return; // late response for a forgotten request; L1 consumed credit
    this.handlePendingResponse(frame, pending);
    // The request ended on this frame (any terminal path): its identity's
    // marker is released unless an entry or another get holds it. This runs
    // after the fence decision, which reads the marker.
    if (pending.kind === "get" && !this.pending.has(frame.correlation)) {
      this.pruneGeneration(relayResourceKey(pending.ref));
    }
  }

  private handlePendingResponse(frame: RelayResourceIncomingFrame, pending: Pending): void {
    // The response answers the op of the pending request; any other op is a
    // peer fault and ends the request as INVALID.
    const op = PENDING_OP[pending.kind];
    if (frame.metadata.op !== op) {
      this.failMalformed(frame.correlation, pending);
      return;
    }

    if (frame.metadata.status === RELAY_STATUS.ERROR) {
      // An error envelope is terminal; its shape is the op's `.error` schema
      // (op, optional resource, error body), never the success `.response`
      // schema. A malformed error ends the request as INVALID.
      if (validateRelayMetadata(`${op}.error`, frame.metadata)) {
        this.failMalformed(frame.correlation, pending);
        return;
      }
      if (frame.metadata.resource
          && !relayKindNegotiated(this.opts.negotiated.kinds, (frame.metadata.resource as RelayResourceRef).kind)) {
        this.failPending(frame.correlation, pending, RELAY_ERROR.UNSUPPORTED);
        return;
      }
      if (pending.kind === "get" && frame.metadata.resource
          && !relayGetResponseMatchesRequest(pending.ref, frame.metadata.resource as RelayResourceRef)) {
        this.failMalformed(frame.correlation, pending);
        return;
      }
      const error = frame.metadata.error as RelayErrorBody;
      this.terminatePending(frame.correlation, pending);
      pending.complete({ ok: false, error: { code: error.code, message: error.message } });
      return;
    }

    // A response that fails its op schema is a peer fault. §3.6 gives every
    // request exactly one terminal, so the request ends here as INVALID,
    // whether or not the malformed frame carried final: the pending entry and
    // the assembler reservation are released, and a later well-formed frame
    // for this correlation is consumed and dropped as late. Keeping the
    // request open would let two malformed terminals hold the bounded
    // assembly budget until the stream is reset (review 1070 B1).
    if (validateRelayMetadata(`${op}.response`, frame.metadata)) {
      this.failMalformed(frame.correlation, pending);
      return;
    }
    if (frame.metadata.resource
        && !relayKindNegotiated(this.opts.negotiated.kinds, (frame.metadata.resource as RelayResourceRef).kind)) {
      this.failPending(frame.correlation, pending, RELAY_ERROR.UNSUPPORTED);
      return;
    }

    if (pending.kind === "get") {
      this.deliverGet(frame, pending);
      return;
    }
    if (!frame.metadata.final) return; // accepted is non-terminal; control ops end final
    this.terminatePending(frame.correlation, pending);
    pending.complete({
      ok: true,
      value: { subscription: (frame.metadata.value as { subscription?: number } | undefined)?.subscription },
    }, frame.metadata);
  }

  /** End a request whose response was malformed: count the protocol error,
   * release the pending slot and reservation, and complete it as INVALID. */
  private failMalformed(correlation: number, pending: Pending): void {
    this.failPending(correlation, pending, RELAY_ERROR.INVALID);
  }

  private failPending(correlation: number, pending: Pending, code: string): void {
    this.protocolErrors++;
    this.terminatePending(correlation, pending);
    pending.complete({ ok: false, error: { code } });
  }

  private terminatePending(correlation: number, pending: Pending): void {
    this.pending.delete(correlation);
    if (pending.kind === "get" && pending.reserved) {
      this.assembler.release({ stream: pending.stream, channel: correlation, space: "get" });
      pending.reserved = false;
    }
  }

  private deliverGet(frame: RelayResourceIncomingFrame, pending: PendingGet): void {
    const meta = frame.metadata;
    const ref = meta.resource as RelayResourceRef;
    if (!relayKindNegotiated(this.opts.negotiated.kinds, ref.kind)) {
      this.failPending(frame.correlation, pending, RELAY_ERROR.UNSUPPORTED); return;
    }
    const value = meta.value as { notModified?: boolean } | undefined;
    // The request fixes the ref identity and selected resource form. A
    // revisionless request may receive the authority's concrete revision.
    if (!relayGetResponseMatchesRequest(pending.ref, ref)) {
      this.failMalformed(frame.correlation, pending); return;
    }
    if (frame.codec === RELAY_CODEC.JSON && frame.data.length && meta.value !== undefined) {
      this.failMalformed(frame.correlation, pending); return;
    }

    if (value?.notModified) {
      // §3.6: notModified is terminal and names the concrete revision; a
      // response that breaks either rule ends the get as INVALID.
      if (!meta.final || !ref.revision) { this.failMalformed(frame.correlation, pending); return; }
      const fenced = this.isFenced(pending, ref);
      this.terminatePending(frame.correlation, pending);
      if (fenced) {
        pending.complete({ ok: false, error: { code: RELAY_ERROR.RESYNC_REQUIRED } });
        return;
      }
      pending.complete({ ok: true, value: { notModified: true, revision: ref.revision! } });
      return;
    }

    if (frame.data.length) {
      // A data region without a transfer descriptor cannot be assembled.
      if (!meta.transfer || !meta.resource) { this.failMalformed(frame.correlation, pending); return; }
      const result = this.assembler.push({
        stream: frame.stream,
        channel: frame.correlation,
        space: "get",
        codec: frame.codec,
        resource: ref,
        digest: meta.digest as string | undefined,
        final: !!meta.final,
        transfer: meta.transfer as { id: number; offset: string; total: string },
        data: frame.data,
      });
      if (!result.ok) {
        this.terminatePending(frame.correlation, pending);
        pending.complete({ ok: false, error: { code: result.code } });
        return;
      }
      if (!result.complete) return;
      // The public chunk envelope passed; the assembled object and any
      // repeated metadata value still have to satisfy the form the local
      // product installed for this kind.
      if ((meta.value !== undefined && this.invalidProductValue(frame, pending.ref.kind, meta.value))
          || this.invalidProductValue(frame, pending.ref.kind, undefined, result.bytes)) {
        this.failMalformed(frame.correlation, pending);
        return;
      }
      this.terminatePending(frame.correlation, pending);
      // Every chunk repeats the object's value (§3.7); the final chunk's copy
      // is published with the bytes, as the push path does.
      this.publishGet(pending, result.resource, result.codec, result.bytes, result.digest, meta.value);
      return;
    }

    if (!meta.final) return;
    // Unchunked result: codec NONE carries the value in metadata (small
    // control objects); codec JSON without a data region is invalid.
    if (frame.codec !== RELAY_CODEC.NONE) {
      this.terminatePending(frame.correlation, pending);
      pending.complete({ ok: false, error: { code: RELAY_ERROR.INVALID } }); return;
    }
    if (this.invalidProductValue(frame, pending.ref.kind, meta.value)) {
      this.failMalformed(frame.correlation, pending); return;
    }
    this.terminatePending(frame.correlation, pending);
    const bytes = new Uint8Array(stringToUtf8(JSON.stringify(meta.value ?? null)));
    this.publishGet(pending, ref, RELAY_CODEC.NONE, bytes, undefined, meta.value);
  }

  private publishGet(pending: PendingGet, ref: RelayResourceRef, codec: number, data: Uint8Array,
    digest: string | undefined, value?: unknown) {
    if (this.isFenced(pending, ref)) {
      pending.complete({ ok: false, error: { code: RELAY_ERROR.RESYNC_REQUIRED } });
      return;
    }
    if (ref.revision) this.storeEntry(ref);
    pending.complete({ ok: true, value: { ref, codec, data, digest, value } });
  }

  /** Record one revision-scope marker on an in-flight get. The store is
   * bounded (§3.8): past maxFencedRevisions distinct revisions the get is
   * fenced as a whole and its markers are released, so an invalidate is never
   * dropped for lack of room and a burst costs one re-fetch, not a stale
   * publication. A repeated revision is one marker. */
  private fenceRevision(pending: PendingGet, revision: string): void {
    if (pending.fenceAll) return;
    const fenced = (pending.fencedRevisions ??= new Set());
    if (fenced.has(revision)) return;
    if (fenced.size >= this.maxFencedRevisions) {
      pending.fenceAll = true;
      pending.fencedRevisions = undefined;
      return;
    }
    fenced.add(revision);
  }

  /** Whether a late response must be dropped: a key/namespace invalidate moved
   * the revision-free identity generation after the request was captured, a
   * revision-scope invalidate named the concrete revision the response
   * carries, or the marker store overflowed and the whole get is fenced. */
  private isFenced(pending: PendingGet, responseRef: RelayResourceRef): boolean {
    if (pending.fenceAll) return true;
    if (this.generationFor(responseRef) !== pending.generation) return true;
    return responseRef.revision !== undefined && !!pending.fencedRevisions?.has(responseRef.revision);
  }

  private handlePush(frame: RelayResourceIncomingFrame): void {
    if (validateRelayMetadata("resource.push", frame.metadata)) { this.protocolErrors++; return; }
    const meta = frame.metadata;
    const sub = this.subscriptions.get(meta.subscription as number);
    if (!sub) return; // post-unsubscribe/unknown push: consumed and dropped
    const ref = meta.resource as RelayResourceRef;
    if (!relayKindNegotiated(this.opts.negotiated.kinds, ref.kind)) {
      this.failSubscription(sub.id, { code: RELAY_ERROR.UNSUPPORTED }); return;
    }
    if (frame.stream !== sub.stream || !refMatchesSubscription(sub.filter, ref)) {
      this.failSubscription(sub.id, { code: RELAY_ERROR.INVALID }); return;
    }
    if (frame.codec === RELAY_CODEC.JSON && frame.data.length && meta.value !== undefined) {
      this.failSubscription(sub.id, { code: RELAY_ERROR.INVALID }); return;
    }

    if (frame.data.length) {
      if (!meta.transfer) { this.protocolErrors++; return; }
      const result = this.assembler.push({
        stream: frame.stream,
        channel: sub.id,
        space: "push",
        codec: frame.codec,
        resource: ref,
        digest: meta.digest as string | undefined,
        final: !!meta.final,
        transfer: meta.transfer as { id: number; offset: string; total: string },
        data: frame.data,
      });
      if (!result.ok) { this.failSubscription(sub.id, { code: result.code }); return; }
      if (!result.complete) return;
      // Assembled object and repeated metadata value must satisfy the form
      // bound to this stream's profile and the push's kind.
      if ((meta.value !== undefined && this.invalidProductValue(frame, ref.kind, meta.value))
          || this.invalidProductValue(frame, ref.kind, undefined, result.bytes)) {
        this.failSubscription(sub.id, { code: RELAY_ERROR.INVALID }); return;
      }
      this.publishPush(sub, result.resource, result.codec, result.bytes, result.digest,
        meta.value, meta.baseRevision as string | undefined);
      return;
    }

    if (!meta.final) return;
    if (this.invalidProductValue(frame, ref.kind, meta.value)) {
      this.failSubscription(sub.id, { code: RELAY_ERROR.INVALID }); return;
    }
    const data = new Uint8Array(stringToUtf8(JSON.stringify(meta.value ?? null)));
    this.publishPush(sub, ref, frame.codec, data, undefined, meta.value, meta.baseRevision as string | undefined);
  }

  private publishPush(sub: RelaySubscriptionEntry, ref: RelayResourceRef, codec: number,
    data: Uint8Array, digest: string | undefined, value: unknown, baseRevision: string | undefined) {
    const revision = ref.revision;
    if (!revision) { this.failSubscription(sub.id, { code: RELAY_ERROR.INVALID }); return; }
    const object: RelayPublishedObject = { ref, codec, data, value, digest };

    if (sub.delivery === RELAY_DELIVERY.RELIABLE_DELTA) {
      if (baseRevision !== undefined) {
        // A delta applies only when its base is exactly the held revision.
        // A mismatch never moves the base: the object is delivered marked for
        // resync and recovery waits for a full snapshot (§3.7, no guessed base).
        if (sub.resyncRequired || sub.revision === undefined || baseRevision !== sub.revision) {
          sub.resyncRequired = true;
          sub.handler.onObject(object, { resyncRequired: true });
          return;
        }
        sub.revision = revision;
        if (ref.revision) this.storeEntry(ref);
        sub.handler.onObject(object, { resyncRequired: false });
        return;
      }
      // Full snapshot: the §3.7 recovery. It re-establishes the base on any
      // revision and clears the flag, so the next matching delta applies. The
      // object at the resync boundary is delivered marked resyncRequired: the
      // consumer replaces state with the snapshot instead of applying a delta.
      const marked = sub.resyncRequired;
      sub.revision = revision;
      sub.resyncRequired = false;
      if (ref.revision) this.storeEntry(ref);
      sub.handler.onObject(object, { resyncRequired: marked });
      return;
    }

    // latest-snapshot: re-delivering the held revision is idempotent; seq
    // order already guarantees newer revisions arrive later.
    if (sub.revision !== undefined && revision === sub.revision) return;
    sub.revision = revision;
    sub.resyncRequired = false;
    if (ref.revision) this.storeEntry(ref);
    sub.handler.onObject(object, { resyncRequired: false });
  }

  private failSubscription(id: number, error: RelayResourceError): void {
    const sub = this.subscriptions.get(id);
    if (!sub) return;
    this.closeSubscription(id);
    sub.handler.onEnd?.({ code: error.code });
  }

  private closeSubscription(id: number): void {
    const sub = this.subscriptions.get(id);
    if (sub) {
      this.subscriptions.delete(id);
      this.assembler.release({ stream: sub.stream, channel: id, space: "push" });
    }
  }

  private storeEntry(ref: RelayResourceRef): void {
    const generation = this.generationFor(ref);
    this.entries.set(relayResourceKey(ref), { ref, revision: ref.revision!, generation, stale: false });
  }

  private generationFor(ref: RelayResourceRef): number {
    return this.generations.get(relayResourceKey(ref)) ?? 0;
  }

  localEntry(ref: RelayResourceRef): RelayLocalEntry | undefined {
    return this.entries.get(relayResourceKey(ref));
  }
  subscription(id: number): RelaySubscriptionEntry | undefined {
    return this.subscriptions.get(id);
  }
  /** Close all subscriptions and release scratch (relay.reset/session end). */
  resetStream(stream: number): void {
    for (const [id, sub] of this.subscriptions) {
      if (sub.stream === stream) { this.closeSubscription(id); sub.handler.onEnd?.(); }
    }
    // The reset ends the stream's subscriptions on the provider as well, so a
    // pending withdrawal has nothing left to withdraw.
    for (const [id, s] of this.orphans) if (s === stream) this.orphans.delete(id);
    for (const [correlation, pending] of this.pending) {
      if (pending.stream === stream) {
        this.pending.delete(correlation);
        if (pending.kind === "get" && pending.reserved) {
          this.assembler.release({ stream, channel: correlation, space: "get" });
          pending.reserved = false;
          pending.complete({ ok: false, error: { code: RELAY_ERROR.RESYNC_REQUIRED } });
        } else {
          pending.complete({ ok: false, error: { code: RELAY_ERROR.RESYNC_REQUIRED } });
        }
        if (pending.kind === "get") this.pruneGeneration(relayResourceKey(pending.ref));
      }
    }
  }
  stats() {
    let fencedRevisions = 0;
    for (const p of this.pending.values()) if (p.kind === "get") fencedRevisions += p.fencedRevisions?.size ?? 0;
    return {
      pending: this.pending.size,
      subscriptions: this.subscriptions.size,
      entries: this.entries.size,
      protocolErrors: this.protocolErrors,
      /** Revision markers held across in-flight gets: at most pending × maxFencedRevisions. */
      fencedRevisions,
      /** Refused subscriptions still awaiting their resource.unsubscribe send. */
      orphanedSubscriptions: this.orphans.size,
      /** Identity generation markers held; at most entries + pending gets. */
      generationMarkers: this.generations.size,
    };
  }
}

// --- authority ---------------------------------------------------------------

export interface RelayAuthoritySubscription {
  id: number;
  stream: number;
  delivery: string;
  ns: string;
  ref?: RelayResourceRef;
  active: boolean;
}

export interface RelayResourceEnvelope {
  type: number;
  stream: number;
  correlation: number;
  metadata: Record<string, unknown>;
  data?: Uint8Array;
  /** Data codec of a data-bearing envelope; absent or NONE without data. */
  codec?: number;
}

/** What chunkObject produced: the frames of one object, or the negotiated
 * limit the object's metadata cannot fit under. */
export type RelayChunkPlan =
  | { ok: true; frames: RelayResourceEnvelope[] }
  | {
      ok: false;
      code: typeof RELAY_ERROR.TOO_LARGE;
      /** The per-chunk metadata size the chunker computed. */
      metaBytes: number;
      /** Which negotiated ceiling refused it. */
      limit: "maxMetaBytes" | "maxWireBytes";
      message: string;
    };

/** Provider-side resource registry and chunker. It validates and answers
 * resource REQUESTs and builds PUSH/INVALIDATE frames; the L1 provider pump
 * owns transmission, seq and credit. `maxWireBytes`/`maxMetaBytes` are the
 * negotiated receiver limits of the attachment the frames will ride. */
export class RelayResourceAuthority {
  private readonly subscriptionIds = new RelayIdAllocator();
  private readonly leaseIds = new RelayIdAllocator();
  private readonly transferIds = new RelayIdAllocator();
  private readonly subscriptions = new Map<number, RelayAuthoritySubscription>();
  private readonly leases = new Set<number>();
  private readonly maxWireBytes: number;
  private readonly maxMetaBytes: number;
  /** Endpoint-injected layered validators (public schema + product form).
   * Direct authority users without them get the strict public schema only. */
  private readonly validateLayeredRequest?: (
    stream: number,
    op: typeof RELAY_OP.RESOURCE_GET | typeof RELAY_OP.RESOURCE_SUBSCRIBE,
    metadata: unknown,
  ) => string | null;
  /** Endpoint-injected full request check used before echoing a ref. */
  private readonly validGetRequest?: (stream: number, metadata: unknown) => boolean;

  constructor(opts: {
    maxWireBytes?: number;
    maxMetaBytes?: number;
    validateLayeredRequest?: (
      stream: number,
      op: typeof RELAY_OP.RESOURCE_GET | typeof RELAY_OP.RESOURCE_SUBSCRIBE,
      metadata: unknown,
    ) => string | null;
    validGetRequest?: (stream: number, metadata: unknown) => boolean;
  } = {}) {
    this.maxWireBytes = opts.maxWireBytes ?? RELAY_LIMITS.defaultMaxWireBytes;
    this.maxMetaBytes = opts.maxMetaBytes ?? RELAY_LIMITS.defaultMaxMetaBytes;
    this.validateLayeredRequest = opts.validateLayeredRequest;
    this.validGetRequest = opts.validGetRequest;
    if (!Number.isSafeInteger(this.maxWireBytes) || this.maxWireBytes < RELAY_FRAME.headerBytes
      || !Number.isSafeInteger(this.maxMetaBytes) || this.maxMetaBytes < 0) {
      throw new Error("Invalid relay authority limits");
    }
  }

  answerSubscribe(frame: { stream: number; correlation: number; metadata: Record<string, unknown> }):
    RelayResourceEnvelope {
    const invalid = this.validateLayeredRequest
      ? this.validateLayeredRequest(frame.stream, RELAY_OP.RESOURCE_SUBSCRIBE, frame.metadata)
      : validateRelayMetadata(`${RELAY_OP.RESOURCE_SUBSCRIBE}.request`, frame.metadata);
    if (invalid) return this.error(frame, RELAY_OP.RESOURCE_SUBSCRIBE, RELAY_ERROR.INVALID, invalid);
    const args = frame.metadata.args as { delivery: string; namespace?: string };
    const ref = frame.metadata.resource as RelayResourceRef | undefined;
    const ns = ref?.ns ?? args.namespace;
    if (!ns) return this.error(frame, RELAY_OP.RESOURCE_SUBSCRIBE, RELAY_ERROR.INVALID, "namespace required", ref);
    const id = this.subscriptionIds.allocate();
    this.subscriptions.set(id, { id, stream: frame.stream, delivery: args.delivery, ns, ref, active: true });
    return {
      type: RELAY_TYPE.RESPONSE, stream: frame.stream, correlation: frame.correlation,
      metadata: {
        op: RELAY_OP.RESOURCE_SUBSCRIBE,
        ...(ref ? { resource: ref } : {}),
        status: RELAY_STATUS.OK, final: true, value: { subscription: id },
      },
    };
  }

  answerUnsubscribe(frame: { stream: number; correlation: number; metadata: Record<string, unknown> }):
    RelayResourceEnvelope {
    const invalid = validateRelayMetadata(`${RELAY_OP.RESOURCE_UNSUBSCRIBE}.request`, frame.metadata);
    if (invalid) return this.error(frame, RELAY_OP.RESOURCE_UNSUBSCRIBE, RELAY_ERROR.INVALID, invalid);
    const id = (frame.metadata.args as { subscription: number }).subscription;
    const sub = this.subscriptions.get(id);
    if (!sub || !sub.active) return this.error(frame, RELAY_OP.RESOURCE_UNSUBSCRIBE, RELAY_ERROR.NOT_FOUND, "unknown subscription");
    sub.active = false;
    this.subscriptions.delete(id);
    return {
      type: RELAY_TYPE.RESPONSE, stream: frame.stream, correlation: frame.correlation,
      metadata: { op: RELAY_OP.RESOURCE_UNSUBSCRIBE, status: RELAY_STATUS.OK, final: true },
    };
  }

  /** Allocate a session-scoped remote-residence lease (never reused). */
  allocateLease(): number {
    const id = this.leaseIds.allocate();
    this.leases.add(id);
    return id;
  }

  answerRelease(frame: { stream: number; correlation: number; metadata: Record<string, unknown> }):
    RelayResourceEnvelope {
    const invalid = validateRelayMetadata(`${RELAY_OP.RESOURCE_RELEASE}.request`, frame.metadata);
    if (invalid) return this.error(frame, RELAY_OP.RESOURCE_RELEASE, RELAY_ERROR.INVALID, invalid);
    const lease = (frame.metadata.args as { lease: number }).lease;
    if (!this.leases.delete(lease)) return this.error(frame, RELAY_OP.RESOURCE_RELEASE, RELAY_ERROR.NOT_FOUND, "unknown lease");
    return {
      type: RELAY_TYPE.RESPONSE, stream: frame.stream, correlation: frame.correlation,
      metadata: { op: RELAY_OP.RESOURCE_RELEASE, status: RELAY_STATUS.OK, final: true },
    };
  }

  /** resource.get admission: the assembled total must fit the ceiling the
   * requester reserved. Request-window capacity is BUSY at L1 admission. */
  checkGet(totalBytes: number, args: { maxObjectBytes: number }): RelayResourceError | null {
    if (!Number.isSafeInteger(totalBytes) || totalBytes < 0) return { code: RELAY_ERROR.INVALID };
    if (totalBytes > args.maxObjectBytes) {
      return { code: RELAY_ERROR.TOO_LARGE, message: `${totalBytes} > ${args.maxObjectBytes}` };
    }
    return null;
  }

  /** Terminal error for a get. The error names the requested resource when
   * `frame.metadata` is a valid resource.get request; a malformed request
   * has no trustworthy ref to echo. */
  answerGetError(
    frame: { stream: number; correlation: number; metadata?: Record<string, unknown> },
    code: string,
    message = code,
  ): RelayResourceEnvelope {
    const trustworthy = frame.metadata !== undefined
      && (this.validGetRequest
        ? this.validGetRequest(frame.stream, frame.metadata)
        : validateRelayMetadata(`${RELAY_OP.RESOURCE_GET}.request`, frame.metadata) === null);
    const ref = trustworthy ? frame.metadata!.resource as RelayResourceRef : undefined;
    return this.error(frame, RELAY_OP.RESOURCE_GET, code, message, ref);
  }

  answerNotModified(frame: { stream: number; correlation: number }, ref: RelayResourceRef): RelayResourceEnvelope {
    return {
      type: RELAY_TYPE.RESPONSE, stream: frame.stream, correlation: frame.correlation,
      metadata: {
        op: RELAY_OP.RESOURCE_GET, resource: ref,
        status: RELAY_STATUS.OK, final: true, value: { notModified: true },
      },
    };
  }

  /** Chunk one complete object into data-bearing frames. Every chunk repeats
   * resource/transfer/total/digest; offsets run contiguously from 0; the
   * transfer id is freshly allocated and never reused.
   *
   * Each chunk is sized against both negotiated receiver limits: its
   * metadata must fit `maxMetaBytes` and header + metadata + data must fit
   * `maxWireBytes`. The metadata size does not depend on the chunk (offsets
   * and totals are fixed-width hex), so a metadata object over the ceiling
   * cannot be helped by smaller chunks: the plan is refused as TOO_LARGE and
   * the authority answers the request with that error (review 1070 B2). */
  chunkObject(input: {
    type: typeof RELAY_TYPE.RESPONSE | typeof RELAY_TYPE.PUSH;
    stream: number;
    correlation: number; // 0 for PUSH
    subscription?: number;
    ref: RelayResourceRef;
    codec: number;
    data: Uint8Array;
    value?: Record<string, unknown>;
    /** Reliable-delta base; top-level metadata, never inside value (§3.4). */
    baseRevision?: string;
  }): RelayChunkPlan {
    const transferId = this.transferIds.allocate();
    const total = input.data.length;
    const digest = `sha256:${sha256Hex(input.data)}`;
    const metaFor = (offset: number, final: boolean): Record<string, unknown> => {
      const meta: Record<string, unknown> = input.type === RELAY_TYPE.PUSH
        ? { op: "resource.push", resource: input.ref, subscription: input.subscription, final }
        : { op: RELAY_OP.RESOURCE_GET, resource: input.ref, status: RELAY_STATUS.OK, final };
      if (input.value !== undefined) meta.value = input.value;
      if (input.baseRevision !== undefined) meta.baseRevision = input.baseRevision;
      meta.transfer = { id: transferId, offset: hex16(offset), total: hex16(total) };
      meta.digest = digest;
      return meta;
    };
    const metaBytes = (meta: Record<string, unknown>) => stringToUtf8(JSON.stringify(meta)).length;
    // `final` is the only chunk-dependent field ("true" vs "false"); the two
    // sizes bound every chunk's metadata.
    const metaFinal = metaBytes(metaFor(0, true));
    const metaMore = metaBytes(metaFor(0, false));
    const header = RELAY_FRAME.headerBytes;
    const refuse = (size: number, limit: "maxMetaBytes" | "maxWireBytes"): RelayChunkPlan => ({
      ok: false, code: RELAY_ERROR.TOO_LARGE, metaBytes: size, limit,
      message: limit === "maxMetaBytes"
        ? `chunk metadata ${size} bytes exceeds maxMetaBytes ${this.maxMetaBytes}`
        : `chunk metadata ${size} bytes leaves no data room under maxWireBytes ${this.maxWireBytes}`,
    });
    const envelope = (offset: number, dataLen: number, final: boolean): RelayResourceEnvelope => ({
      type: input.type, stream: input.stream, correlation: input.correlation,
      metadata: metaFor(offset, final),
      data: input.data.subarray(offset, offset + dataLen),
      codec: dataLen ? input.codec : RELAY_CODEC.NONE,
    });
    if (total === 0) {
      if (metaFinal > this.maxMetaBytes) return refuse(metaFinal, "maxMetaBytes");
      if (header + metaFinal > this.maxWireBytes) return refuse(metaFinal, "maxWireBytes");
      return { ok: true, frames: [envelope(0, 0, true)] };
    }
    const frames: RelayResourceEnvelope[] = [];
    let offset = 0;
    while (offset < total) {
      const remaining = total - offset;
      if (header + metaFinal + remaining <= this.maxWireBytes) {
        // The rest fits one final chunk.
        if (metaFinal > this.maxMetaBytes) return refuse(metaFinal, "maxMetaBytes");
        frames.push(envelope(offset, remaining, true));
        offset = total;
        continue;
      }
      // A non-final chunk takes every data byte the wire ceiling leaves.
      if (metaMore > this.maxMetaBytes) return refuse(metaMore, "maxMetaBytes");
      const dataLen = this.maxWireBytes - header - metaMore;
      if (dataLen < 1) return refuse(metaMore, "maxWireBytes");
      frames.push(envelope(offset, dataLen, false));
      offset += dataLen;
    }
    return { ok: true, frames };
  }

  /** Build an authority INVALIDATE on the business stream bound to the
   * namespace (stream 0 carries control ops only; a session drops an
   * INVALIDATE there). Namespace scope may name only an ns; revision/key
   * scopes require the resource ref. */
  buildInvalidate(input:
    | { stream: number; scope: typeof RELAY_INVALIDATE_SCOPE.NAMESPACE; ns: string; reason?: string }
    | { stream: number; scope: typeof RELAY_INVALIDATE_SCOPE.KEY | typeof RELAY_INVALIDATE_SCOPE.REVISION; ref: RelayResourceRef; reason?: string },
  ): RelayResourceEnvelope {
    const metadata: Record<string, unknown> = { op: RELAY_OP.RESOURCE_INVALIDATE };
    const args: Record<string, unknown> = { scope: input.scope };
    if ("ns" in input) {
      args.namespace = input.ns;
      if (input.reason) args.reason = input.reason;
    } else {
      metadata.resource = input.ref;
      if (input.reason) args.reason = input.reason;
    }
    metadata.args = args;
    return { type: RELAY_TYPE.INVALIDATE, stream: input.stream, correlation: 0, metadata };
  }

  /** Terminal error for any resource op (the op's `.error` schema). A
   * CANCELLED terminal names its effect (§3.4/§3.6: none is the only value
   * that guarantees nothing was committed). */
  answerError(frame: { stream: number; correlation: number }, op: string, code: string, message = code,
    ref?: RelayResourceRef, effect?: string): RelayResourceEnvelope {
    const envelope = this.error(frame, op, code, message, ref);
    if (effect !== undefined) envelope.metadata.effect = effect;
    return envelope;
  }

  /** relay.reset / stream end on the provider: every subscription the
   * stream carried is gone; ids are never reused. Returns the ids closed. */
  resetStream(stream: number): number[] {
    const closed: number[] = [];
    for (const [id, sub] of this.subscriptions) {
      if (sub.stream === stream) { sub.active = false; this.subscriptions.delete(id); closed.push(id); }
    }
    return closed;
  }

  /** Active subscriptions on one stream, ascending by id. */
  subscriptionsOn(stream: number): RelayAuthoritySubscription[] {
    return [...this.subscriptions.values()].filter((s) => s.stream === stream && s.active);
  }

  subscriptionEntry(id: number): RelayAuthoritySubscription | undefined {
    return this.subscriptions.get(id);
  }

  /** Whether a push ref is inside the filter installed for this active
   * subscription. The revision is allowed to advance. */
  admitsPush(id: number, stream: number, ref: RelayResourceRef): boolean {
    const sub = this.subscriptions.get(id);
    if (!sub || !sub.active || sub.stream !== stream) return false;
    const filter = sub.ref
      ? { ns: sub.ref.ns, kind: sub.ref.kind, key: sub.ref.key, rendition: sub.ref.rendition }
      : { ns: sub.ns };
    return refMatchesSubscription(filter, ref);
  }
  leaseCount(): number {
    return this.leases.size;
  }
  idsAllocated() {
    return {
      subscription: this.subscriptionIds.allocated(),
      lease: this.leaseIds.allocated(),
      transfer: this.transferIds.allocated(),
    };
  }

  /** One error envelope shape for every resource op: the op's `.error`
   * schema (review 1070 N1). The message is clipped to 160 UTF-8 bytes and
   * never empty, so the envelope validates on the consumer. */
  private error(frame: { stream: number; correlation: number }, op: string, code: string, message: string,
    ref?: RelayResourceRef): RelayResourceEnvelope {
    return {
      type: RELAY_TYPE.RESPONSE, stream: frame.stream, correlation: frame.correlation,
      metadata: {
        op,
        ...(ref ? { resource: ref } : {}),
        status: RELAY_STATUS.ERROR, final: true,
        error: { code, message: clipErrorMessage(message) || code },
      },
    };
  }
}

// --- resource-cache adapter (§3.8 reserve-then-load) -------------------------

export interface RelayCacheAdapterDeps {
  client: RelayResourceClient;
  stream: number;
  accept: number[];
  /** Resident cost the collection reserved for this input. */
  maxObjectBytes: number;
  ifRevisionFor?(input: RelayResourceRef): string | undefined;
}

/** Adapt a relay get to the resource-cache ResourceLoad contract. The
 * collection reserves cost before load() runs (reserve-then-load); a BUSY
 * admission declines the start (resource-cache retries on a later frame),
 * and a terminal error fails the entry like any loader error. */
export function createRelayResourceLoad(deps: RelayCacheAdapterDeps):
  ResourceLoad<RelayResourceRef, Uint8Array> {
  return (ref, complete) => {
    const outcome = deps.client.get(
      deps.stream,
      ref,
      { accept: deps.accept, maxObjectBytes: deps.maxObjectBytes, ifRevision: deps.ifRevisionFor?.(ref) },
      (result) => {
        if (!result.ok || !("value" in result)) { complete(result); return; }
        if ("notModified" in result.value) {
          // notModified confirms the held revision; the cache retains the
          // resident bytes and must not materialize an empty value (§3.8 TTL).
          complete({ ok: true, revalidated: true });
          return;
        }
        complete({ ok: true, value: result.value.data });
      },
    );
    if ("correlation" in outcome) {
      const correlation = outcome.correlation;
      return { cancel: () => deps.client.cancel(correlation) };
    }
    if (outcome.code === RELAY_ERROR.BUSY) return false;
    throw new Error(`relay get refused: ${outcome.code}`);
  };
}

export type { RelayResourceErrorCode };
