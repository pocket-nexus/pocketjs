//! Finite water transport and directional exposure through transformed volumes.
//!
//! Transport volumes describe permeability independently of rigid-body collision
//! geometry. A roof, porous screen, or insulating panel can therefore use the
//! same query without adding content-specific collision shapes or rules.

use std::collections::BTreeMap;

use glam::Vec3;
use serde::{Deserialize, Serialize};

use crate::{Entity, EntityId, ReactiveState, Transform, World, WorldConfig};

#[derive(Clone, Copy, Debug, PartialEq, Serialize, Deserialize)]
pub struct TransportSurface {
    /// Half extents in the entity's local coordinates.
    pub half_extents: Vec3,
    /// Fraction of incident radiant energy that crosses the volume.
    pub heat_transmission: f32,
    /// Fraction of incident liquid water that crosses the volume.
    pub water_transmission: f32,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub enum TransportChannel {
    RadiantHeat,
    Water,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct ExposureHit {
    pub entity: EntityId,
    pub fraction: f32,
    pub transmission: f32,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct Exposure {
    pub transmission: f32,
    /// Ordered from the emitter towards the receiver.
    pub hits: Vec<ExposureHit>,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct WaterEmission {
    /// A finite packet follows this polyline, encountering each object once.
    pub points: Vec<Vec3>,
    pub amount: f32,
    pub temperature_c: f32,
    /// The emitter's own volume is excluded from this packet's path.
    pub source: Option<EntityId>,
}

#[derive(Clone, Copy, Debug, PartialEq, Serialize, Deserialize)]
pub struct Rainfall {
    /// Axis-aligned volume. Rain enters at max.y and exits at min.y.
    pub min: Vec3,
    pub max: Vec3,
    /// Requested horizontal quadrature spacing; capped at 128 cells per axis.
    pub spacing: f32,
    /// Normalized water mass per square metre per second.
    pub rate: f32,
    pub temperature_c: f32,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub enum WaterSource {
    Emission,
    Rain,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct WaterTransfer {
    pub source: WaterSource,
    pub target: EntityId,
    pub delivered: f32,
    pub retained: f32,
    /// Water leaving an impermeable or saturated receiver. It exits the model.
    pub runoff: f32,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct HeatTransfer {
    pub source: EntityId,
    pub target: EntityId,
    pub sent: f32,
    pub received: f32,
    pub intercepted: f32,
    pub blockers: Vec<EntityId>,
}

#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize)]
pub struct TransportReport {
    pub water_emitted: f32,
    pub water_retained: f32,
    pub water_runoff: f32,
    pub water_escaped: f32,
    pub water_evaporated: f32,
    pub water: Vec<WaterTransfer>,
    pub heat: Vec<HeatTransfer>,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub enum IgnitionStatus {
    Inert,
    Burning,
    Exhausted,
    TooWet,
    TooCold,
    Ready,
}

impl World {
    /// Distance travelled before a packet meets an impermeable receiver. This
    /// uses the same ordered geometry as water delivery, including wettable
    /// colliders, so a presentation can trim its stream at the actual impact.
    pub fn water_path_distance(&self, emission: &WaterEmission) -> f32 {
        let length: f32 = emission
            .points
            .windows(2)
            .map(|p| p[0].distance(p[1]))
            .sum();
        if !length.is_finite() {
            return 0.0;
        }
        self.water_hits(emission)
            .into_iter()
            .find(|hit| hit.2 == 0.0)
            .map_or(length, |hit| hit.1)
    }

    pub fn exposure(
        &self,
        from: Vec3,
        to: Vec3,
        channel: TransportChannel,
        excluded: &[EntityId],
    ) -> Exposure {
        let surfaces: Vec<_> = self
            .entities()
            .filter_map(|(&id, entity)| {
                entity
                    .transport_surface
                    .map(|surface| (id, entity.transform, surface))
            })
            .collect();
        trace_exposure(&surfaces, from, to, channel, excluded)
    }

    pub fn ignition_status(&self, id: EntityId) -> IgnitionStatus {
        let Some(entity) = self.entity(id) else {
            return IgnitionStatus::Inert;
        };
        let (Some(material), Some(state)) = (entity.reactive_material, entity.reactive_state)
        else {
            return IgnitionStatus::Inert;
        };
        if state.burning {
            return IgnitionStatus::Burning;
        }
        if state.burned_out || positive(state.fuel) <= 0.0 {
            return IgnitionStatus::Exhausted;
        }
        if state.moisture > unit(self.config().ignition_max_moisture) {
            return IgnitionStatus::TooWet;
        }
        if state.temperature_c
            < crate::world::moisture_adjusted_ignition(material, state)
                + positive(self.config().ignition_temperature_margin_c)
        {
            return IgnitionStatus::TooCold;
        }
        IgnitionStatus::Ready
    }

    /// Query the packet's first encounter with each receiver or barrier.
    fn water_hits(&self, emission: &WaterEmission) -> Vec<(EntityId, f32, f32)> {
        let mut distances: BTreeMap<EntityId, (f32, f32)> = BTreeMap::new();
        let mut travelled = 0.0;
        for segment in emission.points.windows(2) {
            let length = segment[0].distance(segment[1]);
            if !length.is_finite() || length <= 1e-7 {
                continue;
            }
            for (&id, entity) in self.entities() {
                if emission.source == Some(id) || distances.contains_key(&id) {
                    continue;
                }
                let hit = if let Some(surface) = entity.transport_surface {
                    box_hit(
                        segment[0],
                        segment[1],
                        entity.transform,
                        surface.half_extents,
                    )
                    .map(|fraction| (fraction, unit(surface.water_transmission)))
                } else if entity.reactive_material.is_some() && entity.reactive_state.is_some() {
                    collider_hit(segment[0], segment[1], entity).map(|fraction| (fraction, 0.0))
                } else {
                    None
                };
                if let Some((fraction, transmission)) = hit {
                    distances.insert(id, (travelled + length * fraction, transmission));
                }
            }
            travelled += length;
        }
        let mut hits: Vec<_> = distances
            .into_iter()
            .map(|(id, (distance, t))| (id, distance, t))
            .collect();
        hits.sort_by(|a, b| a.1.total_cmp(&b.1).then(a.0.cmp(&b.0)));
        hits
    }

    pub(crate) fn transport_water(
        &mut self,
        emission: &WaterEmission,
        source: WaterSource,
        report: &mut TransportReport,
    ) {
        let mut remaining = positive(emission.amount);
        report.water_emitted += remaining;
        let config = *self.config();
        // Invalid geometry cannot create a partial path bridging an invalid point.
        if emission.points.len() < 2 || emission.points.iter().any(|point| !point.is_finite()) {
            report.water_escaped += remaining;
            return;
        }
        for (target, _, transmission) in self.water_hits(emission) {
            let delivered = remaining * (1.0 - transmission);
            remaining -= delivered;
            if delivered <= 0.0 {
                continue;
            }
            let entity = self.entity_mut(target).expect("queried entity");
            let retained = match (entity.reactive_material, entity.reactive_state.as_mut()) {
                (Some(material), Some(state)) => crate::world::mix_liquid_water(
                    state,
                    material,
                    config,
                    delivered,
                    emission.temperature_c,
                ),
                _ => 0.0,
            };
            let runoff = (delivered - retained).max(0.0);
            report.water_retained += retained;
            report.water_runoff += runoff;
            if let Some(transfer) = report
                .water
                .iter_mut()
                .find(|t| t.target == target && t.source == source)
            {
                transfer.delivered += delivered;
                transfer.retained += retained;
                transfer.runoff += runoff;
            } else {
                report.water.push(WaterTransfer {
                    source,
                    target,
                    delivered,
                    retained,
                    runoff,
                });
            }
            if remaining <= 0.0 {
                break;
            }
        }
        report.water_escaped += remaining;
    }

    pub(crate) fn transport_rain(&mut self, rain: Rainfall, report: &mut TransportReport) {
        let size = rain.max - rain.min;
        if !rain.min.is_finite()
            || !rain.max.is_finite()
            || size.min_element() <= 0.0
            || !rain.spacing.is_finite()
            || rain.spacing <= 0.0
            || positive(rain.rate) == 0.0
        {
            return;
        }
        let nx = (size.x / rain.spacing).ceil().clamp(1.0, 128.0) as u32;
        let nz = (size.z / rain.spacing).ceil().clamp(1.0, 128.0) as u32;
        let dx = size.x / nx as f32;
        let dz = size.z / nz as f32;
        let amount = rain.rate * dx * dz * self.config().fixed_dt;
        for z in 0..nz {
            for x in 0..nx {
                let x = rain.min.x + (x as f32 + 0.5) * dx;
                let z = rain.min.z + (z as f32 + 0.5) * dz;
                self.transport_water(
                    &WaterEmission {
                        points: vec![Vec3::new(x, rain.max.y, z), Vec3::new(x, rain.min.y, z)],
                        amount,
                        temperature_c: rain.temperature_c,
                        source: None,
                    },
                    WaterSource::Rain,
                    report,
                );
            }
        }
    }
}

pub(crate) fn surface_evaporation(
    state: &mut ReactiveState,
    material: crate::ReactiveMaterial,
    config: WorldConfig,
    sample: crate::EnvironmentSample,
) -> f32 {
    let water = unit(state.moisture);
    let floor = (sample.ambient_temperature_c
        - positive(config.evaporative_cooling_range_c) * (1.0 - unit(sample.ambient_moisture)))
    .max(0.0);
    let surplus = (state.temperature_c - floor).max(0.0);
    let latent = positive(config.water_vaporization_heat);
    let specific = positive(config.water_specific_heat);
    let capacity = crate::world::thermal_capacity(material, *state, config);
    let energy_limit = capacity * surplus / (latent + specific * surplus).max(1e-6);
    let rate_limit = positive(config.surface_evaporation_rate)
        * positive(material.drying_rate)
        * (1.0 - unit(sample.ambient_moisture))
        * (1.0 + sample.wind.length().clamp(0.0, 8.0))
        * config.fixed_dt;
    let evaporated = water.min(energy_limit).min(rate_limit);
    if evaporated <= 0.0 || !evaporated.is_finite() {
        return 0.0;
    }
    let initial_energy = capacity * state.temperature_c;
    let exported = evaporated * (specific * state.temperature_c + latent);
    state.moisture -= evaporated;
    state.temperature_c =
        (initial_energy - exported) / crate::world::thermal_capacity(material, *state, config);
    evaporated
}

fn unit(value: f32) -> f32 {
    if value.is_finite() {
        value.clamp(0.0, 1.0)
    } else {
        0.0
    }
}
fn positive(value: f32) -> f32 {
    if value.is_finite() {
        value.max(0.0)
    } else {
        0.0
    }
}

fn box_hit(from: Vec3, to: Vec3, transform: Transform, half: Vec3) -> Option<f32> {
    if !half.is_finite()
        || half.min_element() <= 0.0
        || !transform.scale.is_finite()
        || transform.scale.abs().min_element() < 1e-7
        || !transform.position.is_finite()
        || !transform.rotation.is_finite()
    {
        return None;
    }
    let inverse = transform.rotation.inverse();
    let a = (inverse * (from - transform.position)) / transform.scale;
    let b = (inverse * (to - transform.position)) / transform.scale;
    let delta = b - a;
    let mut enter = 0.0_f32;
    let mut leave = 1.0_f32;
    for axis in 0..3 {
        if delta[axis].abs() < 1e-8 {
            if a[axis].abs() > half[axis] {
                return None;
            }
        } else {
            let t0 = (-half[axis] - a[axis]) / delta[axis];
            let t1 = (half[axis] - a[axis]) / delta[axis];
            enter = enter.max(t0.min(t1));
            leave = leave.min(t0.max(t1));
            if enter > leave {
                return None;
            }
        }
    }
    Some(enter)
}

fn sphere_hit(from: Vec3, delta: Vec3, center: Vec3, radius: f32) -> Option<f32> {
    let offset = from - center;
    let c = offset.length_squared() - radius * radius;
    if c <= 0.0 {
        return Some(0.0);
    }
    let a = delta.length_squared();
    if a < 1e-12 {
        return None;
    }
    let b = offset.dot(delta);
    let discriminant = b * b - a * c;
    if discriminant < 0.0 {
        return None;
    }
    let t = (-b - discriminant.sqrt()) / a;
    (0.0..=1.0).contains(&t).then_some(t)
}

fn collider_hit(from: Vec3, to: Vec3, entity: &Entity) -> Option<f32> {
    entity.collider?;
    // Water, contacts and locomotion must agree on one world-space shape.
    let (start, end, radius) = crate::world::collider_segment(entity);
    if !start.is_finite() || !end.is_finite() || !radius.is_finite() || radius <= 0.0 {
        return None;
    }
    let segment = end - start;
    let half = segment.length() * 0.5;
    let center = (start + end) * 0.5;
    let delta = to - from;
    if half <= 1e-7 {
        return sphere_hit(from, delta, center, radius);
    }
    let axis = segment / (2.0 * half);
    let local = from - center;
    let axial = local.dot(axis);
    let radial = local - axis * axial;
    let closest = center + axis * axial.clamp(-half, half);
    if from.distance_squared(closest) <= radius * radius {
        return Some(0.0);
    }
    let perpendicular = delta - axis * delta.dot(axis);
    let a = perpendicular.length_squared();
    let b = radial.dot(perpendicular);
    let c = radial.length_squared() - radius * radius;
    let mut hits = Vec::new();
    if a > 1e-12 && b * b - a * c >= 0.0 {
        let root = (b * b - a * c).sqrt();
        for t in [(-b - root) / a, (-b + root) / a] {
            if (0.0..=1.0).contains(&t) && (axial + t * delta.dot(axis)).abs() <= half {
                hits.push(t);
            }
        }
    }
    hits.extend(sphere_hit(from, delta, start, radius));
    hits.extend(sphere_hit(from, delta, end, radius));
    hits.into_iter().min_by(f32::total_cmp)
}

// Build this compact list once per reaction phase; tracing must not scan every
// non-occluding receiver for every source/receiver pair.
pub(crate) fn trace_exposure(
    surfaces: &[(EntityId, Transform, TransportSurface)],
    from: Vec3,
    to: Vec3,
    channel: TransportChannel,
    excluded: &[EntityId],
) -> Exposure {
    let mut hits = Vec::new();
    if from.is_finite() && to.is_finite() {
        for &(id, transform, surface) in surfaces {
            if excluded.contains(&id) {
                continue;
            }
            let Some(fraction) = box_hit(from, to, transform, surface.half_extents) else {
                continue;
            };
            let transmission = unit(match channel {
                TransportChannel::RadiantHeat => surface.heat_transmission,
                TransportChannel::Water => surface.water_transmission,
            });
            hits.push(ExposureHit {
                entity: id,
                fraction,
                transmission,
            });
        }
    }
    hits.sort_by(|a, b| {
        a.fraction
            .total_cmp(&b.fraction)
            .then(a.entity.cmp(&b.entity))
    });
    Exposure {
        transmission: hits.iter().map(|hit| hit.transmission).product(),
        hits,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{
        Collider, EntityBundle, Environment, EnvironmentSample, FlatEnvironment, Interaction,
        ReactiveMaterial,
    };
    use glam::Quat;

    fn material(capacity: f32) -> ReactiveMaterial {
        ReactiveMaterial {
            heat_capacity: capacity,
            conductivity: 0.5,
            ignition_temperature_c: 220.0,
            burn_rate: 0.08,
            heat_output: 18_000.0,
            drying_rate: 0.4,
            moisture_resistance: 0.8,
            cook_temperature_c: 1000.0,
            char_temperature_c: 1200.0,
        }
    }
    fn receiver(world: &mut World, position: Vec3, capsule: bool, capacity: f32) -> EntityId {
        let mut bundle = EntityBundle::new(Transform::from_translation(position));
        bundle.collider = Some(if capsule {
            Collider::CapsuleY {
                radius: 0.45,
                half_height: 0.4,
            }
        } else {
            Collider::Sphere { radius: 0.45 }
        });
        bundle.reactive_material = Some(material(capacity));
        bundle.reactive_state = Some(ReactiveState::new(20.0, 0.0, 1.0));
        world.spawn(bundle)
    }
    fn panel(world: &mut World, position: Vec3, water: f32, heat: f32) -> EntityId {
        let mut bundle = EntityBundle::new(Transform::from_translation(position));
        bundle.transport_surface = Some(TransportSurface {
            half_extents: Vec3::new(1.0, 1.0, 0.08),
            water_transmission: water,
            heat_transmission: heat,
        });
        world.spawn(bundle)
    }
    fn world() -> World {
        World::new(WorldConfig {
            ambient_exchange: 0.0,
            contact_heat_exchange: 0.0,
            ..WorldConfig::default()
        })
    }
    fn pulse() -> WaterEmission {
        WaterEmission {
            points: vec![Vec3::new(0.0, 0.0, 3.0), Vec3::new(0.0, 0.0, -3.0)],
            amount: 2.0,
            temperature_c: 20.0,
            source: None,
        }
    }
    fn balance(report: &TransportReport) {
        assert!(
            (report.water_emitted
                - report.water_retained
                - report.water_runoff
                - report.water_escaped)
                .abs()
                < 2e-4,
            "{report:?}"
        );
    }

    #[test]
    fn water_uses_collision_dimensions_under_nonuniform_and_mirrored_scale() {
        // Invariant: collision and water delivery use the same world capsule:
        // X/Z scale its radius, Y scales its axial segment. Spheres use max XYZ.
        for (capsule, scale, radius, half) in [
            (true, Vec3::new(2.0, 0.5, 1.0), 0.9, 0.2),
            (true, Vec3::new(0.5, 3.0, 0.75), 0.3375, 1.2),
            (true, Vec3::new(-0.5, -2.0, -1.5), 0.675, 0.8),
            (true, Vec3::new(1.0, 0.0, 2.0), 0.9, 0.0),
            (false, Vec3::new(0.5, 3.0, -1.0), 1.35, 0.0),
        ] {
            for rotation in [Quat::IDENTITY, Quat::from_rotation_z(0.7)] {
                let mut world = world();
                let center = Vec3::new(2.0, 3.0, -1.0);
                let id = receiver(&mut world, center, capsule, 2.0);
                let entity = world.entity_mut(id).unwrap();
                entity.transform.scale = scale;
                entity.transform.rotation = rotation;
                let (a, b, r) = crate::world::collider_segment(entity);
                assert!((r - radius).abs() < 1e-6);
                assert!((a.distance(b) - 2.0 * half).abs() < 1e-6);
                // Test both the axial tip and radial side, just outside/inside.
                for (axis, extent) in [(Vec3::Y, half + radius), (Vec3::X, radius)] {
                    for (offset, expected_hit) in [(0.01, false), (-0.01, true)] {
                        let origin = center + rotation * axis * (extent + offset);
                        let emission = WaterEmission {
                            points: vec![
                                origin + rotation * Vec3::Z * 4.0,
                                origin - rotation * Vec3::Z * 4.0,
                            ],
                            amount: 0.1,
                            ..pulse()
                        };
                        let distance = world.water_path_distance(&emission);
                        assert_eq!(
                            distance < 8.0,
                            expected_hit,
                            "capsule={capsule}, scale={scale:?}, axis={axis:?}, offset={offset}"
                        );
                        let mut report = TransportReport::default();
                        world.transport_water(&emission, WaterSource::Emission, &mut report);
                        assert_eq!(!report.water.is_empty(), expected_hit);
                        balance(&report);
                    }
                }
            }
        }
    }

    #[test]
    fn finite_water_respects_geometry_and_saturation_across_colliders_and_materials() {
        for (capsule, capacity) in [(false, 1.2), (true, 3.5)] {
            let mut world = world();
            // Reverse spatial and ID ordering. The nearest receiver gets the packet.
            let far = receiver(&mut world, Vec3::new(0.0, 0.0, -1.5), capsule, capacity);
            let near = receiver(&mut world, Vec3::ZERO, capsule, capacity);
            world.entity_mut(near).unwrap().transform.rotation = Quat::from_rotation_z(0.7);
            world.queue_interaction(Interaction::Water(pulse()));
            let report = world.step(&FlatEnvironment::default());
            balance(&report.transport);
            assert_eq!(report.transport.water_retained, 1.0);
            assert_eq!(report.transport.water_runoff, 1.0);
            assert_eq!(
                world.entity(far).unwrap().reactive_state.unwrap().moisture,
                0.0
            );
            assert_eq!(report.transport.water[0].target, near);
        }
    }

    #[test]
    fn rotated_scaled_porosity_multiplies_per_channel_and_moving_it_opens_the_path() {
        for angle in [0.0, 0.65] {
            let mut world = world();
            let far = panel(&mut world, Vec3::ZERO, 0.25, 0.0);
            let near = panel(&mut world, Vec3::Z, 0.5, 1.0);
            world.entity_mut(near).unwrap().transform.rotation = Quat::from_rotation_y(angle);
            world.entity_mut(near).unwrap().transform.scale = Vec3::new(-1.5, 2.0, 1.0);
            let exposure = world.exposure(Vec3::Z * 3.0, -Vec3::Z, TransportChannel::Water, &[]);
            assert_eq!(exposure.transmission, 0.125);
            assert_eq!(exposure.hits[0].entity, near);
            world.queue_interaction(Interaction::Water(pulse()));
            let report = world.step(&FlatEnvironment::default());
            balance(&report.transport);
            assert_eq!(report.transport.water_escaped, 0.25);
            assert_eq!(
                world
                    .exposure(Vec3::Z * 3.0, -Vec3::Z, TransportChannel::RadiantHeat, &[])
                    .transmission,
                0.0
            );
            world.entity_mut(far).unwrap().transform.position.x = 4.0;
            assert_eq!(
                world
                    .exposure(Vec3::Z * 3.0, -Vec3::Z, TransportChannel::RadiantHeat, &[])
                    .transmission,
                1.0
            );
        }
    }

    struct Weather(Rainfall);
    impl Environment for Weather {
        fn sample(&self, _: Vec3) -> EnvironmentSample {
            EnvironmentSample::default()
        }
        fn rainfall(&self) -> Option<Rainfall> {
            Some(self.0)
        }
    }
    fn weather() -> Weather {
        Weather(Rainfall {
            min: Vec3::new(-2.0, -2.0, -1.0),
            max: Vec3::new(2.0, 4.0, 1.0),
            spacing: 0.2,
            rate: 1.0,
            temperature_c: 20.0,
        })
    }

    #[test]
    fn moving_a_roof_changes_rain_exposure_for_two_material_and_shape_configurations() {
        for (capsule, capacity) in [(false, 1.0), (true, 4.0)] {
            let mut world = world();
            let left = receiver(&mut world, Vec3::new(-1.0, 0.0, 0.0), capsule, capacity);
            let right = receiver(&mut world, Vec3::new(1.0, 0.0, 0.0), capsule, capacity);
            let roof = panel(&mut world, Vec3::new(-1.0, 2.0, 0.0), 0.0, 0.0);
            world.entity_mut(roof).unwrap().transform.rotation =
                Quat::from_rotation_x(std::f32::consts::FRAC_PI_2);
            let report = world.step(&weather());
            balance(&report.transport);
            assert_eq!(
                world.entity(left).unwrap().reactive_state.unwrap().moisture,
                0.0
            );
            assert!(
                world
                    .entity(right)
                    .unwrap()
                    .reactive_state
                    .unwrap()
                    .moisture
                    > 0.0
            );
            world.entity_mut(roof).unwrap().transform.position.x = 1.0;
            let right_before = world
                .entity(right)
                .unwrap()
                .reactive_state
                .unwrap()
                .moisture;
            world.step(&weather());
            assert!(world.entity(left).unwrap().reactive_state.unwrap().moisture > 0.0);
            assert_eq!(
                world
                    .entity(right)
                    .unwrap()
                    .reactive_state
                    .unwrap()
                    .moisture,
                right_before
            );
        }
    }

    #[test]
    fn overlapping_receivers_do_not_duplicate_rain_and_grid_area_is_conserved() {
        for count in [1, 8] {
            let mut world = world();
            for _ in 0..count {
                receiver(&mut world, Vec3::ZERO, false, 2.0);
            }
            let report = world.step(&weather());
            balance(&report.transport);
            assert!((report.transport.water_emitted - 8.0 / 60.0).abs() < 1e-5);
            assert!(report.transport.water_retained < 0.02);
        }
    }

    #[test]
    fn radiant_heat_is_intercepted_without_refunding_it_to_other_receivers() {
        for (capsule, capacity) in [(false, 1.0), (true, 3.0)] {
            let mut world = world();
            let source = receiver(&mut world, Vec3::new(0.0, 0.0, 2.0), capsule, capacity);
            world.entity_mut(source).unwrap().reactive_state =
                Some(ReactiveState::new(500.0, 0.0, 1.0));
            let target = receiver(&mut world, Vec3::new(0.0, 0.0, -1.0), capsule, capacity);
            let blocker = panel(&mut world, Vec3::ZERO, 0.0, 0.0);
            let report = world.step(&FlatEnvironment::default());
            let transfer = report
                .transport
                .heat
                .iter()
                .find(|t| t.source == source && t.target == target)
                .unwrap();
            assert!(transfer.sent > 0.0);
            assert_eq!(transfer.received, 0.0);
            assert_eq!(transfer.intercepted, transfer.sent);
            assert_eq!(transfer.blockers, vec![blocker]);
            assert_eq!(
                world
                    .entity(target)
                    .unwrap()
                    .reactive_state
                    .unwrap()
                    .temperature_c,
                20.0
            );
            world.entity_mut(blocker).unwrap().transform.position.x = 4.0;
            let report = world.step(&FlatEnvironment::default());
            assert!(
                report
                    .transport
                    .heat
                    .iter()
                    .any(|t| t.target == target && t.received > 0.0)
            );
            assert!(
                world
                    .entity(target)
                    .unwrap()
                    .reactive_state
                    .unwrap()
                    .temperature_c
                    > 20.0
            );
        }
    }

    #[test]
    fn contact_conduction_requires_contact_for_spheres_and_capsules() {
        for capsule in [false, true] {
            let mut world = world();
            world.config_mut().contact_heat_exchange = 0.42;
            let a = receiver(&mut world, Vec3::ZERO, capsule, 1.0);
            let b = receiver(&mut world, Vec3::new(1.1, 0.0, 0.0), capsule, 4.0);
            world
                .entity_mut(a)
                .unwrap()
                .reactive_state
                .as_mut()
                .unwrap()
                .temperature_c = 90.0;
            world.step(&FlatEnvironment::default());
            assert_eq!(
                world
                    .entity(b)
                    .unwrap()
                    .reactive_state
                    .unwrap()
                    .temperature_c,
                20.0
            );
            world.entity_mut(b).unwrap().transform.position.x = 0.9;
            world.step(&FlatEnvironment::default());
            assert!(
                world
                    .entity(b)
                    .unwrap()
                    .reactive_state
                    .unwrap()
                    .temperature_c
                    > 20.0
            );
        }
    }

    #[test]
    fn reactive_barrier_absorption_and_receiver_heat_share_the_original_energy_budget() {
        for capacity in [1.2, 4.0] {
            let mut world = world();
            let source = receiver(&mut world, Vec3::Z * 2.0, false, capacity);
            world.entity_mut(source).unwrap().reactive_state =
                Some(ReactiveState::new(500.0, 0.0, 1.0));
            receiver(&mut world, -Vec3::Z, true, capacity);
            let barrier = panel(&mut world, Vec3::ZERO, 0.0, 0.0);
            let entity = world.entity_mut(barrier).unwrap();
            entity.reactive_material = Some(material(capacity * 2.0));
            entity.reactive_state = Some(ReactiveState::new(20.0, 0.0, 0.0));
            let energy = |world: &World| {
                world
                    .entities()
                    .map(|(_, entity)| {
                        let material = entity.reactive_material.unwrap();
                        let state = entity.reactive_state.unwrap();
                        crate::world::thermal_capacity(material, state, *world.config())
                            * state.temperature_c
                    })
                    .sum::<f32>()
            };
            let before = energy(&world);
            let report = world.step(&FlatEnvironment::default());
            let consumed = 1.0 - world.entity(source).unwrap().reactive_state.unwrap().fuel;
            let local = consumed
                * material(capacity).heat_output
                * world.config().combustion_local_heat_fraction;
            let captured: f32 = report.transport.heat.iter().map(|t| t.sent).sum();
            assert!((energy(&world) - before - local - captured).abs() < 0.005);
            assert!(
                world
                    .entity(barrier)
                    .unwrap()
                    .reactive_state
                    .unwrap()
                    .temperature_c
                    > 20.0
            );
        }
    }

    #[test]
    fn sub_boiling_drying_pays_latent_and_sensible_energy_for_two_materials() {
        for capacity in [1.2, 4.0] {
            let material = material(capacity);
            let config = WorldConfig {
                surface_evaporation_rate: 0.6,
                ..WorldConfig::default()
            };
            let mut state = ReactiveState::new(80.0, 0.8, 1.0);
            let before =
                crate::world::thermal_capacity(material, state, config) * state.temperature_c;
            let removed =
                surface_evaporation(&mut state, material, config, EnvironmentSample::default());
            assert!(removed > 0.0);
            let after =
                crate::world::thermal_capacity(material, state, config) * state.temperature_c;
            let exported =
                removed * (config.water_specific_heat * 80.0 + config.water_vaporization_heat);
            assert!((before - after - exported).abs() < 1e-3);
            assert!(state.temperature_c >= 20.0 && state.temperature_c < 80.0);
            let before = state;
            assert_eq!(
                surface_evaporation(
                    &mut state,
                    material,
                    config,
                    EnvironmentSample {
                        ambient_moisture: 1.0,
                        ..EnvironmentSample::default()
                    }
                ),
                0.0
            );
            assert_eq!(state, before);
        }
    }

    #[test]
    fn ambient_surface_drying_cools_two_materials_without_crossing_the_cooling_floor() {
        for capacity in [1.2, 4.0] {
            let material = material(capacity);
            let config = WorldConfig {
                surface_evaporation_rate: 10.0,
                ..WorldConfig::default()
            };
            let mut state = ReactiveState::new(20.0, 0.8, 1.0);
            let start = state;
            let removed =
                surface_evaporation(&mut state, material, config, EnvironmentSample::default());
            assert!(removed > 0.0 && state.temperature_c < start.temperature_c);
            assert!(state.temperature_c >= 20.0 - config.evaporative_cooling_range_c - 1e-4);
            let before = state;
            let disabled = WorldConfig {
                surface_evaporation_rate: 0.0,
                ..config
            };
            assert_eq!(
                surface_evaporation(&mut state, material, disabled, EnvironmentSample::default()),
                0.0
            );
            assert_eq!(state, before);
        }
    }

    #[test]
    fn queued_emission_and_barrier_snapshot_replay_identical_state_and_transport() {
        let mut world = world();
        receiver(&mut world, Vec3::ZERO, true, 3.0);
        let panel = panel(&mut world, Vec3::Z, 0.5, 0.0);
        let empty_hash = world.state_hash();
        world.queue_interaction(Interaction::Water(pulse()));
        assert_ne!(empty_hash, world.state_hash());
        let snapshot = world.snapshot();
        let first = world.step(&weather());
        world.restore(snapshot.clone());
        assert_eq!(first, world.step(&weather()));
        world.restore(snapshot);
        let before = world.state_hash();
        world
            .entity_mut(panel)
            .unwrap()
            .transport_surface
            .as_mut()
            .unwrap()
            .water_transmission = 0.75;
        assert_ne!(before, world.state_hash());
    }

    #[test]
    fn invalid_packet_is_accounted_as_escaped_and_emitter_can_be_excluded() {
        let mut world = world();
        let target = receiver(&mut world, Vec3::ZERO, false, 2.0);
        for points in [vec![], vec![Vec3::ZERO], vec![Vec3::Z, Vec3::NAN, -Vec3::Z]] {
            world.queue_interaction(Interaction::Water(WaterEmission { points, ..pulse() }));
            let report = world.step(&FlatEnvironment::default());
            balance(&report.transport);
            assert_eq!(report.transport.water_escaped, 2.0);
        }
        world.queue_interaction(Interaction::Water(WaterEmission {
            source: Some(target),
            ..pulse()
        }));
        assert_eq!(
            world
                .step(&FlatEnvironment::default())
                .transport
                .water_retained,
            0.0
        );
    }
}
