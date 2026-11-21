# pocket3d-world

`pocket3d-world` is the renderer-independent fixed-step simulation layer for
Pocket3D games. It owns stable entities, sphere and upright-capsule bodies,
attachments, structural damage, heat, retained water, fuel, and combustion.
Games submit interactions, advance one turn, consume ordered events, and map
the resulting state into any renderer.

`pocket3d::geometry` (also available as the legacy `pocket3d::world` alias)
contains static GPU geometry. It is separate from this simulation. Animation
sampling lives in `pocket3d-anim`; model data and skin bindings live in
`pocket3d-mesh`. This crate depends on neither.

## Fixed turn

Each call to `World::step` performs the same ordered phases:

1. Synchronize attached entities with their parents.
2. Consume queued cuts, impulses, ignition, water packets, and precipitation.
3. Integrate environmental exchange, heat transfer, evaporation, and fuel.
4. Integrate dynamic bodies, advance kinematic locomotion, and solve contacts.
5. Apply contact damage, resynchronize attachments, and commit fractures.
6. Return ordered events and the state hash.

**Stable entity IDs, deferred structural changes, and a seeded RNG determine
the result.** A seed, configuration, initial snapshot, environment samples, and interaction stream
replay to the same state hash on the same target and build.

## Heat, water, and fuel

**Retained water and dry material share one energy budget.** A `Douse`
interaction adds normalized water mass at `WorldConfig::water_inlet_temperature_c`.
The dry material heat capacity and `water_specific_heat` determine the mixed
temperature. Evaporation removes the water's sensible heat plus
`water_vaporization_heat`, and cannot exceed the available thermal energy.

**Combustion heat is funded by consumed fuel.** A turn releases
`fuel_consumed * ReactiveMaterial::heat_output`; the configured local fraction
stays in the source and the remaining fixed budget is divided among nearby
receivers. Adding receivers cannot duplicate emitted energy.

## Exposure and transported water

`TransportSurface` adds an oriented box volume with separate radiant-heat and
liquid-water transmission coefficients. Its shape follows the entity transform,
including rotation and scale. **Transport geometry is independent of rigid-body
collision geometry.** A volume affects exposure; adding it does not add a solid
body or change character movement.

`World::exposure` returns ordered intersections and their combined transmission.
Reaction steps use a compact list of transport surfaces. Contact conduction uses
sphere/capsule surface distance and `thermal_contact_tolerance`, rather than the
previous 0.35 metre proximity range. A separating barrier interrupts that path.
Radiant packets pay their original share of the combustion budget before
occlusion. Reactive barriers receive intercepted energy; inert barriers export it
out of the simulated thermal system. A blocked receiver's share is not reassigned
as extra heat to another receiver.

`Interaction::Water(WaterEmission)` queues a finite packet following an authored
polyline. The engine resolves sphere/capsule receivers and transformed transport
volumes in path order. The emitter may exclude its own volume. Each object is
encountered once per packet, even if a bent path crosses it again. Received water
uses the same heat mixing and saturation rule as `Douse`. Water crossing a porous
surface remains available downstream; intercepted excess becomes runoff.
`World::water_path_distance` lets a renderer trim a stream at the same impermeable
impact used by the solver.

`Environment::rainfall` supplies an optional bounded precipitation volume. A
horizontal grid assigns `rate * cell_area * fixed_dt` water to each vertical path.
Resolution is capped at 128 cells per axis while preserving total covered area.
**Adding overlapping receivers cannot create more rain.** The first receiver or
barrier consumes its fraction of the existing packet. Rain is an external water
and energy input, sampled again on each fixed turn.

`surface_evaporation_rate` enables drying below boiling. Humidity and wind affect
the transfer rate; `evaporative_cooling_range_c` bounds cooling below ambient.
Both boiling and surface evaporation pay sensible and latent heat. The default
surface rate is zero to preserve the existing boiling-only configuration.

**Transported water obeys emitted = retained + runoff + escaped.**
`StepReport::transport` records these quantities, evaporation, per-object water
delivery and radiant heat interception. Runoff and escaped water leave this
compact model; persistent puddles and lateral surface flow are future mechanisms.
Legacy targeted `Douse` inputs and ambient absorption are outside this transport
ledger. `World::ignition_status` explains the current fuel, moisture and temperature
conditions without changing reaction state.

Transport components and queued packets are part of snapshots and state hashes.
Environment implementations remain caller-owned and must be replayed with the
same inputs. New optional components deserialize as absent in older snapshots.
Exposure tests cover two collider/material configurations, moving and rotated
barriers, porous transmission, saturation, fixed rain budgets, energy-funded
drying, contact distance and snapshot replay.

## Solver changes

**Shared solvers do not branch on entity IDs, tags, recipes, or scenarios.** A
fix to collision, integration, attachments, structures, or reactions changes a
general rule, states the invariant that rule preserves, and tests the invariant
across at least two entity configurations, material combinations, or collider
combinations. Scenario regressions are additional coverage, not the proof of a
shared rule.

The current narrow phase is a single discrete sphere/capsule pass, and reactive
pair checks are quadratic in active entity count. High-speed continuous
collision, stable large stacks, spatial partitioning, and cross-architecture
bitwise replay are outside the current contract.


## Surface locomotion

Add `Locomotion::default()` to a kinematic sphere or capsule and submit
`LocomotionInput` before `World::step`. The world owns movement, contact
projection, gravity, slope limits, surface anchors and normalized stamina.
Inputs, configuration and state are included in snapshots and state hashes;
old snapshots default to no motor. Apps own key bindings and animation selection.

**Movement is tangent to an available support and cannot enter nearby solid
geometry.** Walkable normals use `min_ground_dot`; steeper surfaces require
held grip and sufficient support force. Grip acceleration times surface friction
must support tangential gravity. Retained moisture (or ambient moisture on
terrain) reduces effective grip by up to 85%; temperatures above the configured
threshold prevent grip. These are geometry/material rules, independent of names,
tags, recipes or scenarios. Sphere and rotated capsule surfaces share the rigid
body narrow-phase geometry. Terrain coefficients come from `Environment::surface`.

Release, jump, missing support or exhausted stamina return to gravity-driven
movement. Grounded contact replenishes stamina. A local support anchor follows
translation and rotation; jumping consumes an edge command and temporarily
prevents regripping. Radius-bounded substeps and iterative projections prevent
ordinary high-speed motor movement from tunneling through thin spheres/capsules.
The motor is Y-up, uses a heightfield for terrain, and remains kinematic: it
blocks against rigid bodies rather than transferring a physically simulated
actor mass. Full rigid-body CCD and arbitrary concave terrain are outside this
contract. Teleporting supports should be handled as explicit world edits.

`locomotion::tests` covers sphere/capsule actors, capsule/terrain climbing,
walk/slide limits, wet/hot supports, jump, exhaustion, moving/removed support,
fast motion and exact snapshot replay. It runs without a renderer or GPU.
