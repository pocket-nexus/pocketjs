Pocket Map fetches tiles from a Mac. Pocket Term keeps a shell alive there. One moves raster images, meshes and labels; the other moves terminal rows, font atlases and keystrokes. They do not share a product model.

They did share a problem. Each product had grown its own connection lifecycle, record format, resource identity and pressure valve. A reconnect meant one thing to the socket and another to the cache. An operation whose reply never arrived was tracked separately from the connection. Each new companion app was preparing to build the same route again.

If you are new here: PocketJS runs component apps on constrained and unusual machines. A companion lets such an app use work or data owned by another process without moving the UI itself off the device. **Pocket Relay is the bounded delivery contract between those two sides.**

This post is the full story: the duplicated layers we found in two products, the fixed frame and resource model we pulled out, what both migrations measured, why their wire costs diverge, and the paths Relay refuses to absorb.

## The protocol inside each product

Map already had a capable protocol. Its handheld guest kept the camera, visible layers and interaction state. A companion process fetched network data, decoded images, prepared meshes, rasterized labels and held the durable bookmark database. The split kept expensive work off the device without turning the device into a remote display.

That split came with machinery. [The provider entry point](https://github.com/pocket-nexus/pocket-map/blob/main/host/serve.ts) managed an authenticated connection. [The app model](https://github.com/pocket-nexus/pocket-map/blob/main/app/model.ts) watched connection generations, withdrew stale demand and rebuilt the resource window. [The shared types](https://github.com/pocket-nexus/pocket-map/blob/main/shared/types.ts) named tiles by source and coordinate. Native staging held binary images and meshes outside the JavaScript heap.

Term arrived at a similar boundary by a different route. The Mac owned the PTY and terminal parser, while the handheld owned the visible cell grid, cursor, history window, font atlases and input prediction. Its provider connection could disappear while the PTY continued to exist. [The terminal session](https://github.com/pocket-nexus/pocket-term/blob/main/host/session.ts), [exchange mailbox](https://github.com/pocket-nexus/pocket-term/blob/main/shared/exchange.ts) and [product protocol](https://github.com/pocket-nexus/pocket-term/blob/main/shared/protocol.ts) each carried part of that lifecycle.

Put the two implementations side by side and the repeated work falls into the same four rows:

| Concern | Pocket Map before Relay | Pocket Term before Relay | Concrete source |
|---|---|---|---|
| Session | Handheld listener, Mac connector, pairing preface, connection generation and reconnect policy | The same offload session outside a durable broker and PTY lifecycle | Map host/serve.ts; Term host/provider.ts and host/terminal-worker.ts |
| Frame | <code>4 B</code> big-endian length, outer JSON, nested JSON payload, plus <code>PIMG</code> and <code>PMSH</code> binary forms | The offload envelope around a reliable mailbox; desktop mirroring also had an <code>8 B</code> little-endian <code>PKNT</code> header | Map [host/provider.ts](https://github.com/pocket-nexus/pocket-map/blob/main/host/provider.ts) plus the runtime's [contracts/spec/offload.ts](https://github.com/pocket-nexus/pocketjs/blob/main/contracts/spec/offload.ts); Term shared/exchange.ts and host/wire.ts |
| Resource identity | <code>{source,z,x,y}</code>, a guest cache key, collection generation and source invalidation | Grid <code>sid/gen/seq</code>, atlas <code>slot/gen</code>, history <code>sid/epoch/row</code> and final-chunk publication | Map app/model.ts; Term shared/protocol.ts and app/store.ts |
| Backpressure | App concurrency, per-frame starts and completions, pending gate, wire credit, native staging and provider queue | Offload limits plus mailbox acknowledgement, input batching, output accumulation and atlas scheduling | Map app/model.ts; Term shared/exchange.ts and host/exchange.ts |

Those rows do not say that a tile is a terminal cell. They say both products need a way to authenticate a peer and establish a session, move bounded records, name changing resources and stop a fast producer from burying a slow consumer.

That was the seam.

## A delivery contract, not a product schema

Relay ends at delivery. It does not know a map coordinate, a terminal escape sequence or the rules for committing a bookmark. The product profile keeps those meanings.

<img class="w-full rounded-xl border border-line" src="/assets/blog/relay-four-layers.svg" alt="Pocket Relay architecture with a PocketJS guest and companion provider joined by four layers: bounded transport, session and frame, resource delivery, and product-owned profiles. Local image, mesh, font atlas, and surface handles stay outside the wire." />
<p class="text-sm text-slate-500 -mt-4">Relay owns session, frame and resource delivery. The transport adapter, product profile and local presentation interfaces keep their separate contracts.</p>

| Layer | Shared contract | Deliberately left outside |
|---:|---|---|
| <code>L0</code> | Ordered receive, authenticated peer, disconnect notification and bounded <code>trySend</code> | TCP, USB, a shared file, a worker, discovery and dial direction |
| <code>L1</code> | Negotiation, session and stream order, the fixed frame, message types and credit | Pairing credentials, encryption and operating-system authorization |
| <code>L2</code> | Resource reference, chunk assembly, digest, cancellation, invalidation and frame-boundary publication | Pixel decoding, mesh upload, font installation and local handle lifetime |
| <code>L3</code> | A negotiated profile name and version with schemas and recovery rules | Map coordinates and style, terminal cells and PTY behavior, edit conflicts and install commits |

This division matters because the tempting alternative is a universal companion RPC object. That object would need optional fields for every product, then an extension bag for everything its first draft missed. A peer could parse every message while remaining unsure what the omitted fields meant.

Relay takes the narrower route. The frame layer validates bytes. Resource identity and delivery belong to the resource layer, while a profile validates domain data. The local host turns accepted bytes into an image, mesh, font atlas or surface. No local handle crosses the wire, because a texture name in one process has no stable meaning in another.

The transport stays below all of this. A TCP adapter and a USB mailbox can expose the same bounded send decision while retaining different discovery, authentication and scheduling. “Transport-agnostic” means the state machine does not own a socket. It does not mean every transport has the same latency, copying cost or failure behavior.

## The frame is fixed; the meaning is negotiated

The old offload envelope made the outer record generic, then put another serialized payload inside it. Binary responses needed separate discriminators and product parsers. Relay gives every peer the same small piece of work before any product code runs.

The fixed layout is:

```text
record prefix + header

offset  width  field
0       4 B    frameBytes
4       4 B    PRLY format marker
8       1 B    major
9       1 B    minor
10      1 B    type
11      1 B    flags
12      2 B    headerBytes = 48
14      2 B    codec
16      8 B    session
24      4 B    seq
28      4 B    stream
32      4 B    correlation
36      4 B    metaBytes
40      4 B    dataBytes
44      4 B    reserved

frameBytes + 4 == 48 + metaBytes + dataBytes
```

All integers use one byte order. Metadata is one strict JSON object. Binary data follows it without textual wrapping. The decoder checks the declared length before allocating for the body, checks sequence order before dispatch and rejects reserved bits it does not understand. C, Rust and TypeScript consume the same frame vectors.

The type field has a closed vocabulary:

| Value | Type | Contract |
|---:|---|---|
| <code>1</code> | <code>REQUEST</code> | Starts one correlated operation on an open stream |
| <code>2</code> | <code>RESPONSE</code> | Returns progress or the single terminal result for that operation |
| <code>3</code> | <code>PUSH</code> | Delivers subscription or control data without a request correlation |
| <code>4</code> | <code>CANCEL</code> | Withdraws interest through the control stream; it does not undo a committed effect |
| <code>5</code> | <code>INVALIDATE</code> | Reports authority invalidation or advisory consumer eviction |

Operations such as <code>relay.hello</code>, <code>resource.get</code> and <code>operation.status</code> live in metadata. A map profile does not get a map frame type. A terminal profile does not get a terminal frame type. This keeps the byte parser closed while letting profiles add meaning above it.

Negotiation starts with exact profile names and versions. The peers intersect supported kinds and codecs, bind a profile to an opened stream and apply the smaller receive limits in each direction. Unknown required behavior fails as unsupported. It is never inferred from a numeric opcode sent by one side.

The extension design follows the same rule:

| Extension point | Rule | Delivery status |
|---|---|---|
| Codec range | <code>0x8000..0xffff</code> is available only after exact name and version negotiation | Range is reserved in the core contract; named negotiation has a tested prototype outside the core PR |
| Required capability | Every required offer must enter the negotiated intersection; a fallback is a caller choice on a new connection | Design and prototype work |
| Product operation | Permanent profile-local names use <code>x.*</code>; direction, schema, budgets and recovery are registered | Tested on a later development branch, not part of the core PR |
| Product schema | Profiles install validators; unknown keys, cycles and missing validators fail installation | Tested on a later development branch, not part of the core PR |
| Side-effect recovery | Reads may repeat; input deduplicates by epoch; mutations need operation identity, receipt and reconciliation | Tested on a later development branch, not part of the core PR |

The distinction between a reserved hook and a shipped implementation matters. The core pull request contains the session, frame, credit and resource layers. Later branches test ways to extend them. Folding every experiment into the status of the core change would make the protocol sound further along than its repository history says.

## A resource is not a handle

Map exposed the identity problem. A source and coordinate can find a tile, but they do not say whether the desired rendition is a raster or mesh, which style produced it, which density it targets or whether a reconnecting peer still holds the same bytes. Term has the same problem under different names: a screen generation, a font generation and a history epoch are not interchangeable.

Relay puts the cross-process identity in one closed record:

```text
ResourceRef = {
  kind,
  ns,
  key,
  revision?,
  rendition
}

wire identity = (
  authenticatedAuthority,
  ns,
  kind,
  key,
  revision,
  rendition
)
```

The authenticated authority comes from the session adapter rather than self-reported metadata. A namespace bounds what the stream may address, while kind chooses semantics and the profile supplies a canonical key. Revision names content; rendition binds details that change the bytes, such as codec, dimensions, density, style, font data or renderer version.

That last field prevents a common cache lie. Two resources can describe the same logical tile or text while requiring different device bytes. Calling both by a source hash leaves the receiver to guess. Including rendition makes the choice part of the identity that invalidation and cache lookup see.

Generation fences use the identity without its concrete revision. A current-version request and the response carrying its resolved revision therefore share an invalidation generation. If the authority invalidates the key while an old response is in flight, that response cannot publish into the new generation. A revision-specific invalidation can reject one version without discarding a newer one.

Chunks repeat their resource identity, codec, transfer identity, total length and digest. Offsets must be contiguous. The assembler reserves capacity before accepting them, verifies the complete digest and publishes the object once. A half image never enters the cache or UI.

Reconnection uses the same model. A guest can ask for a known revision. If the authority still has it, a <code>notModified</code> response preserves the resident bytes. If not, ordinary chunk delivery replaces them. The fast path is a consequence of explicit identity, not a separate reconnect protocol.

## Credit measures capacity, not completion

Backpressure was the other repeated subsystem. Product code had a request limit. The native bridge had staging slots. The provider had executing work and reply queues. TCP had its own writable buffer. Treating any one of them as “the queue” hid the others.

Relay separates wire capacity from operation capacity. The wire window counts frames and bytes sent but not released. The request table counts accepted work without a consumed terminal result. A sender admits a frame only when the current in-flight bytes, queued bytes and new frame fit both limits for that stream. Otherwise it returns <code>BUSY</code>; the caller retains demand instead of appending to an unbounded retry list.

The default control proposal makes those bounds concrete:

| Capacity | Default |
|---|---:|
| Normal control window | <code>8 frames / 32,768 B</code> per direction |
| Largest normal control frame | <code>4,096 B</code> |
| Reserved sideband | <code>2 slots × 256 B</code> per direction |
| C host admission queue | <code>8 slots / 32,768 B</code> |

The sideband carries credit, ping and pong, reset and cancellation. It exists so a full normal window does not prevent the message that releases or stops work from moving. It is bounded too; control cannot escape pressure by becoming an unlimited priority queue.

Credit returns when the receiver consumes a staged frame or moves it into already reserved assembly or result capacity. Socket reads and header parsing do not return it. The counter says that storage became available, not that a key was applied, an image reached the screen or a mutation committed.

Cancellation follows the same accounting. It withdraws interest and asks cancellable work to stop. The request slot remains occupied until the terminal response is consumed or the session ends. Success already in flight remains the terminal result; when cancellation wins, the provider reports that no effect occurred. An external side effect with an unknown outcome still requires reconciliation, because receiving a cancel cannot roll the outside world back.

This is more bookkeeping than an optimistic callback map. It turns the maximum queue into a value both peers can inspect and test.

## Map, same pixels through a different wire

Pocket Map was the first product migration with a completed measurement report. It exercises several awkward parts of the contract at once: binary objects larger than one wire frame, changing visible demand, cancellation, reconnect revalidation, raster and vector renditions, and native GPU materialization.

We compared the old offload path and the Relay path with the same recorded inputs in the headless simulator. The image result did not move:

| Replay receipt | Offload | Relay | Difference |
|---|---:|---:|---:|
| Input sequence | <code>1,591 frames</code> | <code>1,591 frames</code> | — |
| Captures per path | <code>12</code> | <code>12</code> | — |
| Main-screen pixels compared | <code>1,152,000</code> | <code>1,152,000</code> | <code>0</code> |
| Secondary-screen pixels compared | <code>921,600</code> | <code>921,600</code> | <code>0</code> |
| Total PNG bytes | <code>274,037</code> | <code>274,037</code> | <code>0</code> |
| Map capture digest | identical | identical | <code>0</code> mismatches |

That is equivalence under a controlled replay, not proof from physical handhelds. The run was also reproduced on the platform recorded in the migration PR:

| Validation environment | Result |
|---|---|
| <code>macOS arm64</code> headless replay | Reproduced |
| Physical <code>3DS / PSP</code> Relay path | Not claimed by this receipt |

The next result names a cost. Relay sends more steady-state bytes in the pilot. Fixed headers, repeated chunk metadata and credit reports account for the increase.

The following tables keep one measurement scope throughout:

| Pilot scope | Value |
|---|---:|
| Visible tiles | <code>4</code> |
| Screen | <code>400 × 240</code> |
| Collection entries | <code>40</code> |
| Measurement set | task <code>1151</code> pilot; the same scope used by Pocket Map PR <code>#4</code> |

| One-screen path | Offload wire bytes | Relay wire bytes | Relay delta | Recorded explanation |
|---|---:|---:|---:|---|
| Raster | <code>1,066,632 B</code> | <code>1,085,041 B</code> | <code>+18,409 B / +1.7 %</code> | Object data is <code>1,064,960 B</code>; framing and delivery metadata add the rest |
| Vector | <code>33,551 B</code> | <code>45,921 B</code> | <code>+12,370 B / +37 %</code> | Each frame carries a <code>48 B</code> header, each object about <code>330 B</code> of chunk metadata, plus <code>30</code> credit frames |

**Relay is more expensive in steady-state bytes in both measured paths.** The abstraction is not a compression scheme. Its value has to appear in behavior the previous envelope could not express cleanly enough, such as bounded cancellation and revision-aware reconnects.

Map raster objects also demonstrate why object and wire limits are different:

| Limit | Pilot value | Consequence |
|---|---:|---|
| Raster object | <code>131,072 B</code> | One logical resource can exceed one frame |
| Bulk wire frame | <code>65,536 B</code> | The response crosses contiguous chunks and publishes after full validation |

## The cancellation race

A large pan can make hundreds of predicted tiles irrelevant. The old path could stop caring about a reply, but sent work kept its credit until the reply arrived or the session ended. Relay carries cancellation on its reserved control lane and gives the provider a terminal contract.

Cancellation helps only when it reaches work that can still stop. The Map burst measured both sides of that race. The left column below is Relay with a provider that answers in the request frame. It is not the offload baseline. The right column delays provider work long enough for withdrawals to arrive.

| Relay burst metric | Provider delay <code>0 frames</code> | Provider delay <code>3 frames</code> |
|---|---:|---:|
| Tile burst | <code>600</code> | <code>600</code> |
| Wire bytes | <code>80,632,572 B</code> | <code>28,475,445 B</code> |
| Bytes wasted after cancel | <code>77,201,408 B</code> | <code>25,821,184 B</code> |
| Objects discarded after cancel | <code>589</code> | <code>197</code> |
| Gets → objects / cancelled terminals | <code>606 → 605 / 1</code> | <code>605 → 211 / 394</code> |
| Provider in-flight peak | <code>6 frames / 199,357 B</code> | <code>5 frames / 199,108 B</code> |
| Stream slice ceiling | <code>6 frames / 229,376 B</code> | <code>6 frames / 229,376 B</code> |

The original report and the migration summary used different labels for the first Relay column. Keeping the provider condition in the table avoids the attractive but false claim that Relay changed the left value into the right one. The change came from cancellation getting time to win.

The matching old-path comparison for the delayed condition recorded:

| Same delayed burst | Offload | Relay |
|---|---:|---:|
| Wire bytes | <code>79,655,598 B</code> | <code>28,475,445 B</code> |
| Bytes wasted after cancel | <code>77,735,184 B</code> | <code>25,821,184 B</code> |
| Discarded replies or objects | <code>593</code> | <code>197</code> |
| Withdrawals that beat completion | not represented | <code>394 / 591</code> |

This does not make cancellation free. The delayed Relay run still transferred bytes for work that had started or completed before its withdrawal won. The protocol names that remainder instead of hiding it.

Reconnect showed the other side of explicit identity. In the tile-only pilot, offload resent each resident tile. Relay asked whether the known revision still held and received a small unchanged result:

| Tile-only reconnect | Offload | Relay |
|---|---:|---:|
| Wire bytes per resident tile | <code>131,088 B</code> | <code>1,112 B</code> |
| Resident tiles in receipt | — | <code>8</code> |
| Total reconnect receipt | — | <code>8,893 B / 20 frames</code> |
| Resource bytes transferred | resident tiles resent | <code>0 B</code> |

Cancellation and revalidation are conditional wins. Steady delivery pays for the machinery every time. That combination is the measured Map result.

## Terminal is the second question

Term is not Map with smaller resources. Its authority is a live process with history and side effects. The Mac parses PTY output into authoritative cells. The guest publishes complete row updates, keeps a local prediction overlay for input, loads whole font atlases by slot and pages history by an absolute address. A reconnect must distinguish the transport session from the terminal session that survived it.

Before Relay, Term nested a reliable application mailbox inside offload. Delivery used its own epoch, acknowledgement and fragment sequence. The grid used a generation and sequence. Font atlases used another generation. History used another epoch. Input commands carried an identity so an uncertain retry in the same epoch would not type twice. None of those counters meant wire capacity.

That makes Term a useful second test. Map asks whether Relay can carry large immutable resources, revisions and cancellation into native GPU objects. Term asks whether the same lower layers can carry continuous small updates, font replacement and scrollback paging while leaving deduplicated input and PTY semantics in the product profile.

The migration shape is clear:

| Shared Relay mechanism | Term-owned meaning |
|---|---|
| Session and stream binding | Which durable terminal session a replica attaches to |
| Resource reference and atomic publication | Complete cell generations, history pages and font atlas replacements |
| Wire credit and request terminals | Bounded delivery without treating an input acknowledgement as transport capacity |
| Operation identity and reconciliation | Whether a key, paste, new-session request or kill request took effect |
| Profile schema | Cell runs, colors, spans, cursor state, PTY commands and font-slot policy |

The Term migration now has a completed acceptance report on an unpushed branch. The offload and Relay transport gates each passed <code>86 tests</code> with <code>0 failures</code> and <code>1,703 assertions</code>. <code>bun run test:pty</code> passed <code>3 tests</code> by launching two Node workers backed by <code>/bin/sh</code>. Their serialized final grids are each <code>254 B</code> with the same SHA-256, <code>0bd64bb7e823860cf9404b73331a5b1ac811cd64d61e8d8197f704dfab4eb74d</code>.

Input tests prove that a repeated <code>(epoch,id)</code> applies once. <code>hello</code>, <code>new</code> and <code>kill</code> use durable operations. The journal fsyncs the admitted record before applying a PTY effect, then fsyncs the committed receipt before replying.

The migration branch and report are not pushed, so there is no public Term PR to cite. Its PocketJS runtime pin is built on the unmerged <code>O1–O3</code> integration commit. The pinned <code>3DS</code> host has no native Relay byte lane, so a physical device still requires an explicit offload build.

The exact encoded records, including frame headers, metadata and data, show where the fixed costs do and do not pay:

| Term protocol-wire scenario | Offload | Relay |
|---|---:|---:|
| One full <code>80 × 24</code> screen | <code>14 frames / 3,787 B</code> | <code>22 frames / 6,712 B</code> |
| <code>1,024</code> scrollback rows, <code>16/page</code> | <code>256 frames / 93,518 B</code> | <code>256 frames / 135,922 B</code> |
| One <code>1,024-glyph</code> slot replacement | <code>106 frames / 98,229 B</code> | **<code>14 frames / 63,028 B</code>** |

Small terminal updates cannot spread Relay's identity, metadata and chunking over much payload, so the screen and scrollback paths grow. A complete font slot is a larger binary object; removing base64 saves <code>35,201 B</code> and cuts its frame count. These are deterministic protocol-wire measurements, not a physical Wi-Fi throughput claim.

The evidence level therefore advances while keeping its limits explicit:

| Evidence level | What we have |
|---|---|
| <code>n = 1</code> | Pocket Map has a completed migration measurement and controlled pixel-parity replay |
| <code>n = 2</code> | Pocket Map plus a completed Pocket Term headless and real-PTY acceptance report across a different workload |

**Two completed product receipts narrow the hypothesis; they do not establish a universal companion protocol.** Map and Term validate different boundaries under controlled tests, while neither supplies physical handheld Relay evidence.

## The fixed costs

The steady-state Map table already names the first cost: more bytes. Fixed framing, repeated identity, transfer metadata and credit acknowledgements make small objects proportionally expensive. A workload that sends each object once and never cancels, reconnects or invalidates it can pay overhead without exercising the mechanisms that justify it.

Term sharpens that boundary. Continuous grids and paged history consist of small records, so their fixed overhead does not amortize and their Relay byte counts rise. A complete font slot is a large binary transfer, so removing base64 outweighs Relay's metadata. The workload shape and the encoding being replaced decide whether the wire cost falls.

Bounded capacity also changes APIs. A caller has to retain demand after <code>BUSY</code>, pump again when capacity returns and consume terminal results after local interest disappears. This is more state than firing an unbounded promise and trusting process memory. The reward is a maximum that can be reviewed; the price is code that has to respect it.

Chunk assembly moves another hidden cost into the contract. The receiver reserves object and scratch capacity before admitting data, checks contiguous offsets and retains enough identity to reject a stale completion. Large objects no longer hide behind a record-size constant, but they still occupy memory while being assembled.

Negotiation creates governance work around codec ownership, product schemas, budgets, recovery rules and required-feature failures. A registry can reject ambiguity; it cannot decide which behavior belongs in a profile.

Finally, cancellation is a race rather than a deletion command. It can save work that has not committed. It can neither remove bytes already queued on one ordered connection nor reverse a write outside the process. An unknown outcome does not become safe to repeat, so products with side effects still need journals or reconciliation.

These are not defects concealed behind an abstraction. They are the cost of exposing capacity limits and resource identity at a boundary where outcomes can remain uncertain.

## What stays outside Relay

The proposal names six paths that should not be flattened into the common request/resource model:

| Boundary | Keep separate | Mechanism |
|---:|---|---|
| <code>1</code> | Real-time media bulk from ordinary guest RPC | Presentation timestamps, an audio clock, drop policy and a higher production rate need a native bulk attachment; session and identity may still be shared |
| <code>2</code> | Terminal, document, vault and general text schemas from one another | Cell spans, positioned runs, row masks and shaped clusters describe different facts; revision and paging can be shared without one text engine owning them all |
| <code>3</code> | Same-machine GPU surfaces from network textures | A surface handle plus geometry avoids serializing pixels and adding a copy or synchronization boundary |
| <code>4</code> | Offline packages and development push from runtime Relay | A baked design viewer may have no runtime provider; installing a package is not reading an application resource |
| <code>5</code> | Install commits and external model or tool calls from retryable reads | An unknown side-effect result requires status or reconciliation; cancellation cannot promise rollback |
| <code>6</code> | Input tape from live network lockstep | A tape omits PTY output, model results, font bytes and media timing unless those external facts are recorded too |

The table is the guardrail for future profiles. Shared framing does not collapse product data or make every identified output cacheable. Cancellation also leaves transaction semantics to the product.

## The honest boundary

Relay began with a survey of repeated code, then a proposal, a core implementation and product migrations. Those stages overlap, but they are not interchangeable.

The core change implements the lower session, frame, credit and resource layers. Its fixed frame has TypeScript, C and Rust implementations over shared vectors. The extension experiments live on later development branches. Map has the first measured migration, with simulator parity and the wire results above. Term supplies a second completed receipt on an unpushed migration branch: real-PTY grid parity, input and durable-operation recovery, and protocol-wire measurements.

There are other boundaries the current result does not cross. Map replay and Term PTY tests provide controlled evidence rather than physical handheld Relay runs. The pinned handheld host still lacks the native Relay byte lane. The burst receipt captures a conditional cancellation window; it does not imply a constant traffic reduction. Reconnect savings depend on a valid resident revision, while the steady path spends more bytes. Multi-profile cache isolation remains design work rather than a settled core guarantee.

The useful claim is narrower: **on their migration branches, two products use the shared session, frame, resource-delivery and backpressure stack to move different companion data.** The controlled Map replay kept its pixels equal, and the Term PTY run kept its serialized grid equal. Queue bounds are explicit, with tradeoffs measured under named conditions.

Term shows that the boundary can survive a different authority and update shape in controlled acceptance. A native handheld lane and more product migrations could expose a reason to move it.

## Where it stands

The public work is reviewable in three places:

| Work | Status at publication | Link |
|---|---|---|
| Pocket Relay proposal | Open issue <code>#437</code> | [Protocol layers, pilots and non-goals](https://github.com/pocket-nexus/pocketjs/issues/437) |
| Relay core implementation | Open PR <code>#456</code> | [Session, framing, credit and resource layers](https://github.com/pocket-nexus/pocketjs/pull/456) |
| Pocket Map migration | Open PR <code>#4</code> | [Tile, catalog and search paths on Relay](https://github.com/pocket-nexus/pocket-map/pull/4) |

The wire contract and implementation notes in [<code>docs/RELAY.md</code>](https://github.com/pocket-nexus/pocketjs/pull/456), and the frame constants and metadata schemas in [<code>contracts/spec/relay.ts</code>](https://github.com/pocket-nexus/pocketjs/pull/456), land with that pull request. The PR is the receipt for what the core change implements; the proposal is the receipt for what remains intended.

The next result is not another protocol diagram. It is a native handheld Relay byte lane followed by physical copy, start, input, font and history acceptance. Until then, Relay is two measured extractions without a physical handheld receipt, not a generally validated companion layer.
