# Predicting and reconciling simulation

PocketJS's [frame transaction](DETERMINISM.md) delivers inputs and effects at
a frame boundary. **It does not snapshot the JavaScript heap or rewind UI,
native resources, clocks, or IO.** Applications that need prediction separate
their simulation state from presentation and external effects.

`engine/sim` provides a `no_std` + `alloc` implementation for
native hosts and simulation services. It has no dependency on Pocket3D, a
device SDK, a transport, or a guest runtime.

## Fixed-step state

The application supplies a reducer `step(&mut state, &input)` with immutable
configuration. State includes every value the next step reads: position,
velocity, action phase, cooldowns, seeded randomness, and shared object state
when those values affect the simulation. Meshes, cameras, UI nodes, sockets,
and message delivery receipts belong outside it. Time is a fixed step or a
counter in the state.

`Predictor<State, Input, N>` saves the state after each input. An authority's
acknowledgement identifies **the last input it consumed**, with the state
after that input. On equality, confirmation drops acknowledged history with
zero reducer calls. On difference, the predictor restores the authoritative
state and replays the remaining inputs in order. The current state and stored
checkpoints are then replaced by the corrected results.

**N bounds both memory and replay work.** A full history returns `Full` before
advancing state. The host waits for confirmation or requests a fresh session
snapshot; it must not overwrite unconfirmed input. Future and stale
acknowledgements leave state unchanged. Sequence exhaustion requires a new
session. A new session constructs a new predictor from the authority's full
snapshot, discarding the preceding session's inputs.

`CommandQueue<Input, N>` admits contiguous commands from one authenticated
session. It rejects gaps and overload, and ignores duplicates. The authority
decides how many commands to consume per fixed tick; a packet cannot grant
extra simulation time. `Timeline<State, N>` brackets a delayed server tick
with remote snapshots and supplies an interpolation fraction. It holds the
newest snapshot during missing updates instead of extrapolating without a
limit.

## Frame integration

One host turn has this order:

1. Copy bounded network deliveries at the frame boundary and validate their
   protocol version, session, sequence and application state.
2. Reconcile the local simulation. Queue remote snapshots for presentation.
3. Predict the current hardware-neutral input and retain it for transmission.
4. Update presentation from the resulting state, then submit one display frame.
5. Submit new commands with transport credit. Retry unsent commands from the
   input history, with the same sequence number.

The reducer performs no network sends, file writes, UI hooks or callback
deliveries. A one-shot simulation action is an input edge and replays as state.
An external effect receives an application command ID outside the reducer;
confirmation and deduplication govern its delivery. **Replaying a reducer
does not replay the outer PocketJS frame transaction.** These Rust utilities
do not add JavaScript heap checkpointing or a JavaScript simulation API.

## Companion transport

`tools/companion-session.ts` exposes `connectCompanionSession` over the existing
[offload worker mailbox](OFFLOAD.md). Both request/reply providers and stateful
companion rooms use its length framing, paired connection, reconnect and
backpressure. It opens no second device transport and replays no application
records on reconnect. A room binds each configured device to its player ID;
the device cannot select another player's authority.

The device's offload worker owns TCP and key reads. A native display loop calls
`offload_frame`, takes at most one record, and submits at most two. Each record
is at most 4096 bytes, with eight incoming and eight outgoing slots fenced by
connection generation. `send()` on the companion reports missing credit.
Snapshot producers can replace an unsent snapshot with a newer one; reliable
commands retain their identity until accepted. DevTools uses its separate
paired runtime connection.

Pairing authenticates the companion to the device using the existing LAN key
contract. Device identity comes from the daemon's configured endpoint. This
transport does not provide encryption or an internet account identity system.

## Networking choices and sources

[GGPO](https://github.com/pond3r/ggpo) predicts inputs and restores saved game
state when later inputs disagree. Its [sync implementation](https://github.com/pond3r/ggpo/blob/master/src/lib/ggpo/sync.cpp)
shows the save/load/advance boundary. This informs the bounded simulation
history; a social room does not need to roll back every participant's UI.

[Valve's prediction implementation](https://github.com/ValveSoftware/source-sdk-2013/blob/master/src/game/client/prediction.cpp)
compares acknowledged player state, restores prediction state, and executes
unacknowledged commands. Client prediction with an authoritative companion
and remote interpolation fits a walking demo without requiring cross-device
floating-point lockstep.

VRChat documents [object ownership](https://creators.vrchat.com/worlds/udon/networking/ownership/)
and [late join recovery](https://creators.vrchat.com/worlds/udon/networking/late-joiners/):
current synchronized state and ownership are restored for a newcomer;
transient events are not replayed. A companion room therefore needs stable
player assignment, fresh session epochs, full join snapshots and explicit
disconnect handling before it adds shared interactive objects.
