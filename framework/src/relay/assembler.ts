/** Relay L2 chunk assembly — bounded reassembly with frame-boundary
 * publication (R5 draft §3.7).
 *
 * Admission is reserve-then-accept: the consumer reserves one assembly slot
 * and up to the request's maxObjectBytes BEFORE the REQUEST is admitted, and
 * the first chunk commits the real (smaller-or-equal) total. Rules enforced:
 * - Chunks repeat resource/codec/transfer.id/total/digest; offsets run
 *   contiguously from 0; the final chunk carries final=true and lands exactly
 *   on total. Gaps, overlaps, identity changes, transfer-id reuse and
 *   out-of-range offsets reject the assembly as INVALID and drop its scratch.
 * - Nothing is visible while partial: the assembled bytes are returned once,
 *   after the digest verifies. A half object never reaches the cache.
 *
 * The frame layer already guarantees contiguous, deduplicated seq delivery
 * per stream. One channel (a get correlation, or a subscription id) carries
 * at most one assembly at a time; the transfer id therefore identifies the
 * object within a channel and must not repeat (§3.7 "transfer ID 不复用").
 * The authority allocates transfer ids from one monotonic session counter
 * and frames of one channel arrive in send order, so the bounded check is
 * "greater than the previous object's id on this channel": a reuse is never
 * greater and is rejected with O(1) state (review 1070 M3). */

import {
  RELAY_ERROR,
  type RelayResourceRef,
} from "../../../contracts/spec/relay.ts";
import { verifySha256Digest } from "./sha256.ts";

export type RelayResourceErrorCode =
  | typeof RELAY_ERROR.INVALID
  | typeof RELAY_ERROR.BUSY
  | typeof RELAY_ERROR.TOO_LARGE;

/** One assembler table per session/receiver. The §3.7 key is
 * `(session, stream, REQUEST direction + correlation or subscription,
 * transfer.id)`: a get correlation and a subscription id are two independent
 * id spaces (both allocators start at 1), so a `space` discriminator keeps a
 * correlation 1 from colliding with subscription id 1. Bounded; hostile input
 * produces a fixed error code, never a throw. */
export interface RelayChannelKey {
  stream: number;
  /** Correlation of the REQUEST for RESPONSE deliveries, or the
   * subscription id for PUSH deliveries. */
  channel: number;
  /** Which id space `channel` belongs to. */
  space: "get" | "push";
}

export interface RelayChunkLimits {
  /** Concurrent assemblies, negotiated as rxLimits.maxAssemblies. */
  maxAssemblies: number;
  /** Sum of reserved assembled bytes, rxLimits.maxScratchBytes. */
  maxScratchBytes: number;
}

export interface RelayChunkInput {
  stream: number;
  channel: number;
  /** Id space of `channel`: "get" for RESPONSE correlations, "push" for
   * subscription ids. Must match the reservation. */
  space: "get" | "push";
  codec: number;
  resource: RelayResourceRef;
  digest?: string;
  final: boolean;
  transfer: { id: number; offset: string; total: string };
  data: Uint8Array;
}

export type RelayChunkResult =
  | { ok: true; complete: false }
  | {
      ok: true;
      complete: true;
      /** The fully assembled object; digest, when declared, matched. */
      bytes: Uint8Array;
      resource: RelayResourceRef;
      codec: number;
      digest: string | undefined;
    }
  | { ok: false; code: RelayResourceErrorCode };

interface Assembly {
  stream: number;
  channel: number;
  space: "get" | "push";
  /** Reserved ceiling (the request's maxObjectBytes); counted in scratch. */
  reserved: number;
  /** Present once the first chunk commits the real total. */
  committed: boolean;
  transferId: number;
  codec: number;
  resource: RelayResourceRef;
  digest?: string;
  total: number;
  buffer: Uint8Array | null;
  have: number;
  /** Transfer id of the previous completed object on this channel; the next
   * object's id must be greater (ids are allocated monotonically and never
   * reused). */
  lastTransferId: number;
}

export interface RelayAssemblerStats {
  assemblies: number;
  stagedBytes: number;
  peakStagedBytes: number;
  /** Reservations admitted. */
  enqueued: number;
  /** Objects completed and handed off for publication. */
  published: number;
  /** Assemblies rejected or aborted. */
  failed: number;
}

const hexU64 = (s: string): bigint | null =>
  /^[0-9a-f]{16}$/.test(s) ? BigInt("0x" + s) : null;

/** Chunk identity, revision included. A JSON tuple, not a delimiter join,
 * so unrestricted field contents cannot alias two identities (review 1070 M1). */
const refId = (r: RelayResourceRef) =>
  JSON.stringify([r.kind, r.ns, r.key, r.revision ?? null, r.rendition]);

/** One assembler table per session/receiver direction. Bounded; hostile input
 * produces a fixed error code, never a throw. */
export class RelayChunkAssembler {
  private readonly assemblies = new Map<string, Assembly>();
  private peakStaged = 0;
  private enqueued = 0;
  private published = 0;
  private failed = 0;

  constructor(private readonly limits: RelayChunkLimits) {
    if (!Number.isSafeInteger(limits.maxAssemblies) || limits.maxAssemblies < 1
      || !Number.isSafeInteger(limits.maxScratchBytes) || limits.maxScratchBytes < 0) {
      throw new Error("Invalid relay assembler limits");
    }
  }

  private keyOf(stream: number, channel: number, space: "get" | "push"): string {
    return `${space === "get" ? "g" : "p"}:${stream}:${channel}`;
  }

  /** Whether a reservation of maxTotal would be admitted right now. Used by
   * the client to refuse (BUSY) a get before it consumes a request slot. */
  canReserve(maxTotal: number): boolean {
    return Number.isSafeInteger(maxTotal) && maxTotal > 0
      && this.assemblies.size < this.limits.maxAssemblies
      && this.stagedBytes() + maxTotal <= this.limits.maxScratchBytes;
  }

  /** Reserve one slot and up to maxTotal assembled bytes before the REQUEST
   * is admitted. Returns BUSY when the negotiated assembler/scratch budget
   * is fully reserved. */
  reserve(key: RelayChannelKey, maxTotal: number): { ok: true } | { ok: false; code: RelayResourceErrorCode } {
    if (!Number.isSafeInteger(maxTotal) || maxTotal <= 0) return { ok: false, code: RELAY_ERROR.INVALID };
    const id = this.keyOf(key.stream, key.channel, key.space);
    if (this.assemblies.has(id)) return { ok: false, code: RELAY_ERROR.INVALID };
    if (this.assemblies.size >= this.limits.maxAssemblies) return { ok: false, code: RELAY_ERROR.BUSY };
    if (this.stagedBytes() + maxTotal > this.limits.maxScratchBytes) {
      return { ok: false, code: RELAY_ERROR.BUSY };
    }
    this.assemblies.set(id, {
      stream: key.stream, channel: key.channel, space: key.space, reserved: maxTotal, committed: false,
      transferId: 0, codec: 0, resource: null as never, total: 0, buffer: null,
      have: 0, lastTransferId: 0,
    });
    this.enqueued++;
    this.peakStaged = Math.max(this.peakStaged, this.stagedBytes());
    return { ok: true };
  }

  /** Feed one data-bearing RESPONSE/PUSH chunk into a reserved assembly. */
  push(input: RelayChunkInput): RelayChunkResult {
    const total = hexU64(input.transfer.total);
    const offset = hexU64(input.transfer.offset);
    const key = this.keyOf(input.stream, input.channel, input.space);
    const asm = this.assemblies.get(key);
    if (!asm
      || total === null || offset === null
      || total > BigInt(Number.MAX_SAFE_INTEGER) || offset > total
      || !Number.isSafeInteger(input.transfer.id) || input.transfer.id === 0
      || typeof input.final !== "boolean" || !input.data) {
      return this.standaloneReject(RELAY_ERROR.INVALID);
    }
    const totalN = Number(total);
    const offsetN = Number(offset);

    if (!asm.committed) {
      // First chunk commits the real total against the reservation.
      if (offsetN !== 0) return this.reject(key, RELAY_ERROR.INVALID);
      if (input.transfer.id <= asm.lastTransferId) return this.reject(key, RELAY_ERROR.INVALID);
      if (totalN > asm.reserved) return this.reject(key, RELAY_ERROR.TOO_LARGE);
      asm.committed = true;
      asm.transferId = input.transfer.id;
      asm.codec = input.codec;
      asm.resource = input.resource;
      asm.digest = input.digest;
      asm.total = totalN;
      asm.buffer = new Uint8Array(totalN);
      // The reservation shrinks from the ceiling to the real total.
      this.peakStaged = Math.max(this.peakStaged, this.stagedBytes());
    } else if (asm.codec !== input.codec
      || refId(asm.resource) !== refId(input.resource)
      || asm.digest !== input.digest
      || asm.total !== totalN
      || asm.transferId !== input.transfer.id) {
      return this.reject(key, RELAY_ERROR.INVALID);
    }

    const end = offsetN + input.data.length;
    // Contiguous from the last fill, never past total. The final flag and
    // the end position must agree.
    if (offsetN !== asm.have || end > asm.total) return this.reject(key, RELAY_ERROR.INVALID);
    const isLast = end === asm.total;
    if (input.final !== isLast) return this.reject(key, RELAY_ERROR.INVALID);
    asm.buffer!.set(input.data, offsetN);
    asm.have = end;

    if (!isLast) return { ok: true, complete: false };

    const bytes = asm.buffer!;
    const { resource, codec, digest } = asm;
    // A digest failure is fatal for the assembly: drop the reservation; the
    // higher layer fails the get/subscription and never sees the bytes.
    if (digest !== undefined && !verifySha256Digest(digest, bytes)) {
      return this.reject(key, RELAY_ERROR.INVALID);
    }
    // A verified commit frees its actual staging bytes; the reservation stays
    // until release() so a long-lived PUSH channel can carry another object.
    asm.lastTransferId = asm.transferId;
    asm.committed = false;
    asm.buffer = null;
    asm.have = 0;
    this.published++;
    return { ok: true, complete: true, bytes, resource, codec, digest };
  }

  /** Release a reservation (get terminal consumed, unsubscribe, cancel). */
  release(key: RelayChannelKey): boolean {
    return this.assemblies.delete(this.keyOf(key.stream, key.channel, key.space));
  }

  /** Abort one reservation identified by its id space (CANCEL terminal). */
  abortChannel(key: RelayChannelKey): number {
    return this.assemblies.delete(this.keyOf(key.stream, key.channel, key.space)) ? 1 : 0;
  }

  reset() {
    this.assemblies.clear();
  }

  private stagedBytes(): number {
    let n = 0;
    for (const asm of this.assemblies.values()) n += asm.committed ? asm.total : asm.reserved;
    return n;
  }

  private reject(key: string, code: RelayResourceErrorCode): RelayChunkResult {
    this.assemblies.delete(key);
    this.failed++;
    return { ok: false, code };
  }

  private standaloneReject(code: RelayResourceErrorCode): RelayChunkResult {
    this.failed++;
    return { ok: false, code };
  }

  stats(): RelayAssemblerStats {
    return {
      assemblies: this.assemblies.size,
      stagedBytes: this.stagedBytes(),
      peakStagedBytes: this.peakStaged,
      enqueued: this.enqueued,
      published: this.published,
      failed: this.failed,
    };
  }
}
