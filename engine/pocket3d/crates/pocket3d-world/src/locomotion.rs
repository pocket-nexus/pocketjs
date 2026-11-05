//! Contact-constrained kinematic locomotion. No renderer or content identities.
use glam::{Vec2, Vec3};
use serde::{Deserialize, Serialize};

use crate::world::{closest_segment_points, collider_segment};
use crate::{BodyMode, Entity, EntityId, Environment, World};

#[derive(Clone, Copy, Debug, PartialEq, Serialize, Deserialize)]
#[serde(default)]
pub struct LocomotionConfig {
    pub walk_speed: f32,
    pub climb_speed: f32,
    pub jump_speed: f32,
    /// Walkable surface normal dot world Y. Steeper surfaces require grip.
    pub min_ground_dot: f32,
    pub contact_offset: f32,
    pub grip_reach: f32,
    /// Maximum acceleration supplied by hands, multiplied by effective friction.
    pub grip_acceleration: f32,
    pub max_temperature_c: f32,
    pub stamina_seconds: f32,
    pub recovery_per_second: f32,
}

impl Default for LocomotionConfig {
    fn default() -> Self {
        Self {
            walk_speed: 3.55,
            climb_speed: 1.1,
            jump_speed: 4.0,
            min_ground_dot: 0.68,
            contact_offset: 0.01,
            grip_reach: 0.15,
            grip_acceleration: 22.0,
            max_temperature_c: 65.0,
            stamina_seconds: 12.0,
            recovery_per_second: 0.28,
        }
    }
}

#[derive(Clone, Copy, Debug, Default, PartialEq, Serialize, Deserialize)]
pub struct LocomotionInput {
    /// World-space ground direction; length is clamped to one.
    pub direction: Vec3,
    /// Surface-space right/up input; length is clamped to one.
    pub climb: Vec2,
    pub grip: bool,
    /// Edge command consumed by the next fixed turn.
    pub jump: bool,
}

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
pub enum LocomotionMode {
    Grounded,
    Climbing,
    Sliding,
    #[default]
    Airborne,
}

#[derive(Clone, Copy, Debug, PartialEq, Serialize, Deserialize)]
pub struct SurfaceAnchor {
    pub entity: EntityId,
    pub local_point: Vec3,
    pub world_point: Vec3,
}

#[derive(Clone, Copy, Debug, PartialEq, Serialize, Deserialize)]
#[serde(default)]
pub struct Locomotion {
    pub config: LocomotionConfig,
    pub input: LocomotionInput,
    pub mode: LocomotionMode,
    pub normal: Vec3,
    pub stamina: f32,
    pub support: Option<SurfaceAnchor>,
    pub regrip_delay: f32,
}

impl Default for Locomotion {
    fn default() -> Self {
        Self {
            config: LocomotionConfig::default(),
            input: LocomotionInput::default(),
            mode: LocomotionMode::Airborne,
            normal: Vec3::Y,
            stamina: 1.0,
            support: None,
            regrip_delay: 0.0,
        }
    }
}

/// Signed capsule/sphere separation. Normal points towards the querying body.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct SurfaceContact {
    pub entity: Option<EntityId>,
    pub normal: Vec3,
    pub point: Vec3,
    pub separation: f32,
    pub friction: f32,
    pub temperature_c: f32,
}

fn tangent(v: Vec3, n: Vec3) -> Vec3 {
    v - n * v.dot(n)
}
fn finite_direction(v: Vec3) -> Vec3 {
    if v.is_finite() {
        v.clamp_length_max(1.0)
    } else {
        Vec3::ZERO
    }
}

impl World {
    /// Deterministic signed-distance query over the same sphere/capsule geometry
    /// as rigid contacts. Includes terrain and excludes the actor's attachments.
    pub fn surface_contacts<E: Environment + ?Sized>(
        &self,
        actor: &Entity,
        environment: &E,
        reach: f32,
    ) -> Vec<SurfaceContact> {
        if actor.collider.is_none() {
            return Vec::new();
        }
        let (a, b, radius) = collider_segment(actor);
        let mut contacts = Vec::new();
        // Sample both segment ends: the lower one is not necessarily the support
        // on a slope or for a rotated capsule.
        for p in [a, b] {
            let sample = environment.sample(p);
            let n = sample.ground_normal.normalize_or(Vec3::Y);
            let plane = Vec3::new(p.x, sample.ground_height, p.z);
            let separation = (p - plane).dot(n) - radius;
            if separation <= reach && separation.is_finite() {
                contacts.push(SurfaceContact {
                    entity: None,
                    normal: n,
                    point: p - n * (radius + separation),
                    separation,
                    friction: environment.surface(p).friction.max(0.0)
                        * (1.0 - sample.ambient_moisture.clamp(0.0, 1.0) * 0.85),
                    temperature_c: sample.ambient_temperature_c,
                });
            }
        }
        for (&id, other) in self.entities() {
            if id == actor.id
                || other.collider.is_none()
                || other.attachment.is_some_and(|a| a.parent == actor.id)
            {
                continue;
            }
            let (c, d, r) = collider_segment(other);
            let (pa, pb) = closest_segment_points(a, b, c, d);
            let delta = pa - pb;
            let separation = delta.length() - radius - r;
            if separation <= reach && separation.is_finite() {
                let n = delta.normalize_or(Vec3::X);
                let moisture = other.reactive_state.map_or(0.0, |s| s.moisture);
                contacts.push(SurfaceContact {
                    entity: Some(id),
                    normal: n,
                    point: pb + n * r,
                    separation,
                    friction: other.surface.friction.max(0.0)
                        * (1.0 - moisture.clamp(0.0, 1.0) * 0.85),
                    temperature_c: other.reactive_state.map_or(20.0, |s| s.temperature_c),
                });
            }
        }
        contacts
    }

    pub(crate) fn step_locomotion<E: Environment + ?Sized>(&mut self, environment: &E) {
        let ids: Vec<_> = self
            .entities()
            .filter_map(|(&id, e)| {
                (e.locomotion.is_some()
                    && e.collider.is_some()
                    && e.attachment.is_none()
                    && e.body.is_some_and(|b| b.mode == BodyMode::Kinematic))
                .then_some(id)
            })
            .collect();
        for id in ids {
            let mut actor = self.entity(id).expect("collected actor").clone();
            let mut motor = actor.locomotion.expect("collected motor");
            let c = motor.config;
            let dt = self.config().fixed_dt;
            let gravity = self.config().gravity;
            let previous = actor.transform.position;
            let mut velocity = actor.body.expect("collected body").linear_velocity;
            if !velocity.is_finite() {
                velocity = Vec3::ZERO;
            }
            // Follow the actual support transform, including rotation. Removal
            // naturally invalidates the anchor; velocity remains for release.
            if let Some(anchor) = motor.support
                && let Some(support) = self.entity(anchor.entity)
            {
                let displacement =
                    support.transform.transform_point(anchor.local_point) - anchor.world_point;
                actor.transform.position += displacement;
            }
            let contacts = self.surface_contacts(&actor, environment, c.grip_reach);
            let ground = contacts
                .iter()
                .filter(|p| {
                    p.normal.y >= c.min_ground_dot && p.separation <= c.contact_offset + 0.06
                })
                .min_by(|a, b| a.separation.total_cmp(&b.separation))
                .copied();
            motor.regrip_delay = (motor.regrip_delay - dt).max(0.0);
            let grip = contacts
                .iter()
                .filter(|p| {
                    p.normal.y < c.min_ground_dot
                        && p.normal.y > -0.1
                        && p.temperature_c <= c.max_temperature_c
                        && p.friction * c.grip_acceleration >= tangent(gravity, p.normal).length()
                        && (motor.mode == LocomotionMode::Climbing
                            || motor.input.direction.dot(p.normal) < -0.1)
                })
                .min_by(|a, b| a.separation.total_cmp(&b.separation))
                .copied();
            let mut support = None;
            if motor.input.grip
                && motor.stamina > 0.0
                && motor.regrip_delay <= 0.0
                && let Some(contact) = grip
            {
                motor.mode = LocomotionMode::Climbing;
                motor.normal = contact.normal;
                let up = tangent(Vec3::Y, contact.normal).normalize_or(Vec3::Y);
                let right = up.cross(contact.normal).normalize_or(Vec3::X);
                let axis = if motor.input.climb.is_finite() {
                    motor.input.climb.clamp_length_max(1.0)
                } else {
                    Vec2::ZERO
                };
                velocity = (up * axis.y + right * axis.x) * c.climb_speed;
                actor.transform.position -=
                    contact.normal * (contact.separation - c.contact_offset);
                motor.stamina = (motor.stamina
                    - dt * (0.35 + axis.length() * 0.65) / c.stamina_seconds.max(dt))
                .max(0.0);
                support = Some(contact);
            } else if let Some(contact) =
                ground.filter(|_| velocity.y <= 0.5 || motor.mode != LocomotionMode::Airborne)
            {
                motor.mode = LocomotionMode::Grounded;
                motor.normal = contact.normal;
                let direction = finite_direction(motor.input.direction * Vec3::new(1.0, 0.0, 1.0));
                velocity = tangent(direction, contact.normal).normalize_or_zero()
                    * direction.length()
                    * c.walk_speed;
                actor.transform.position -=
                    contact.normal * (contact.separation - c.contact_offset);
                motor.stamina = (motor.stamina + dt * c.recovery_per_second).min(1.0);
                support = Some(contact);
            } else {
                if motor.mode == LocomotionMode::Climbing {
                    // Keep inherited support motion on release.
                    velocity += (actor.transform.position - previous) / dt;
                    motor.regrip_delay = 0.25;
                }
                motor.mode = LocomotionMode::Airborne;
                velocity += gravity * dt;
                let control = finite_direction(motor.input.direction * Vec3::new(1.0, 0.0, 1.0));
                velocity.x += (control.x * c.walk_speed - velocity.x) * (dt * 3.0).min(1.0);
                velocity.z += (control.z * c.walk_speed - velocity.z) * (dt * 3.0).min(1.0);
            }
            if motor.input.jump && support.is_some() {
                let push = if motor.mode == LocomotionMode::Climbing {
                    motor.normal * c.jump_speed
                } else {
                    Vec3::ZERO
                };
                velocity += Vec3::Y * c.jump_speed + push;
                motor.mode = LocomotionMode::Airborne;
                motor.regrip_delay = 0.35;
                support = None;
            }
            motor.input.jump = false;
            // Radius-bounded advances prevent crossing a thin collider in one
            // move. Reproject after every advance against ALL nearby geometry.
            let radius = collider_segment(&actor).2;
            let steps = ((velocity.length() * dt) / (radius * 0.25)).ceil().max(1.0) as usize;
            for _ in 0..steps {
                actor.transform.position += velocity * (dt / steps as f32);
                for _ in 0..6 {
                    let penetrations = self.surface_contacts(&actor, environment, c.contact_offset);
                    let Some(contact) = penetrations
                        .iter()
                        .min_by(|a, b| a.separation.total_cmp(&b.separation))
                    else {
                        break;
                    };
                    let depth = c.contact_offset - contact.separation;
                    if depth <= 0.00001 {
                        break;
                    }
                    actor.transform.position += contact.normal * depth;
                    let inward = velocity.dot(contact.normal);
                    if inward < 0.0 {
                        velocity -= contact.normal * inward;
                    }
                    if motor.mode == LocomotionMode::Airborne {
                        motor.normal = contact.normal;
                        if contact.normal.y >= c.min_ground_dot {
                            motor.mode = LocomotionMode::Grounded;
                            support = Some(*contact);
                        } else if contact.normal.y > 0.05 {
                            motor.mode = LocomotionMode::Sliding;
                        }
                    }
                }
            }
            motor.support = support
                .and_then(|contact| contact.entity)
                .and_then(|entity| {
                    let transform = self.entity(entity)?.transform;
                    let world_point = actor.transform.position;
                    let local_point = transform.rotation.inverse()
                        * (world_point - transform.position)
                        / transform.scale;
                    Some(SurfaceAnchor {
                        entity,
                        local_point,
                        world_point,
                    })
                });
            actor.locomotion = Some(motor);
            actor.body.as_mut().expect("collected body").linear_velocity = velocity;
            *self.entity_mut(id).expect("actor remains") = actor;
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{
        Body, Collider, EntityBundle, EnvironmentSample, FlatEnvironment, ReactiveState, Transform,
    };

    fn actor(world: &mut World, shape: Collider, p: Vec3) -> EntityId {
        let mut e = EntityBundle::new(Transform::from_translation(p));
        let mut body = Body::static_body();
        body.mode = BodyMode::Kinematic;
        e.body = Some(body);
        e.collider = Some(shape);
        e.locomotion = Some(Locomotion::default());
        world.spawn(e)
    }
    fn obstacle(world: &mut World, shape: Collider, p: Vec3) -> EntityId {
        let mut e = EntityBundle::new(Transform::from_translation(p));
        e.collider = Some(shape);
        e.body = Some(Body::static_body());
        e.surface.friction = 0.82;
        world.spawn(e)
    }
    fn input(world: &mut World, id: EntityId, i: LocomotionInput) {
        world
            .entity_mut(id)
            .unwrap()
            .locomotion
            .as_mut()
            .unwrap()
            .input = i;
    }
    fn shapes() -> [Collider; 2] {
        [
            Collider::Sphere { radius: 0.28 },
            Collider::CapsuleY {
                radius: 0.28,
                half_height: 0.55,
            },
        ]
    }
    struct Slope(f32);
    impl Environment for Slope {
        fn sample(&self, p: Vec3) -> EnvironmentSample {
            EnvironmentSample {
                ground_height: self.0 * p.x,
                ground_normal: Vec3::new(-self.0, 1.0, 0.0).normalize(),
                ..Default::default()
            }
        }
    }
    #[test]
    fn walk_and_slide_obey_slope_limit_for_sphere_and_capsule() {
        for shape in shapes() {
            for slope in [0.4, 2.0] {
                let env = Slope(slope);
                let mut w = World::with_seed(7);
                let y = shape.half_height() + shape.radius() * (1.0 + slope * slope).sqrt() + 0.01;
                let id = actor(&mut w, shape, Vec3::new(0.0, y, 0.0));
                input(
                    &mut w,
                    id,
                    LocomotionInput {
                        direction: Vec3::X,
                        ..Default::default()
                    },
                );
                for _ in 0..90 {
                    w.step(&env);
                }
                let e = w.entity(id).unwrap();
                if slope < 1.0 {
                    assert!(e.transform.position.x > 3.0, "{shape:?} {e:?}");
                } else {
                    assert!(
                        e.transform.position.x < 0.5,
                        "steep slope must resist walking: {e:?}"
                    );
                }
                assert!(
                    w.surface_contacts(e, &env, 0.1)
                        .iter()
                        .all(|c| c.separation >= -0.002)
                );
            }
        }
    }
    #[test]
    fn grip_climbs_terrain_and_capsules_then_release_falls() {
        for shape in shapes() {
            for terrain in [false, true] {
                let mut w = World::with_seed(11);
                let env = Slope(if terrain { 2.0 } else { 0.0 });
                if !terrain {
                    obstacle(
                        &mut w,
                        Collider::CapsuleY {
                            radius: 0.5,
                            half_height: 5.0,
                        },
                        Vec3::new(0.0, 5.0, 0.0),
                    );
                }
                let p = if terrain {
                    Vec3::new(
                        0.0,
                        shape.half_height() + shape.radius() * 5.0_f32.sqrt() + 0.01,
                        0.0,
                    )
                } else {
                    Vec3::new(0.80, 1.0, 0.0)
                };
                let id = actor(&mut w, shape, p);
                input(
                    &mut w,
                    id,
                    LocomotionInput {
                        direction: if terrain { Vec3::X } else { Vec3::NEG_X },
                        climb: Vec2::Y,
                        grip: true,
                        ..Default::default()
                    },
                );
                for _ in 0..120 {
                    w.step(&env);
                }
                let e = w.entity(id).unwrap();
                assert_eq!(e.locomotion.unwrap().mode, LocomotionMode::Climbing);
                let top = e.transform.position.y;
                assert!(top > p.y + 1.5, "{e:?}");
                input(&mut w, id, LocomotionInput::default());
                for _ in 0..60 {
                    w.step(&env);
                }
                assert!(w.entity(id).unwrap().transform.position.y < top - 0.3);
            }
        }
    }
    #[test]
    fn wet_and_hot_surfaces_cannot_support_grip_across_colliders() {
        for support_shape in [
            Collider::Sphere { radius: 5.0 },
            Collider::CapsuleY {
                radius: 5.0,
                half_height: 4.0,
            },
        ] {
            for (moisture, temperature) in [(0.0, 20.0), (1.0, 20.0), (0.0, 100.0)] {
                let mut w = World::with_seed(3);
                let env = FlatEnvironment::default();
                let surface = obstacle(&mut w, support_shape, Vec3::new(0.0, 6.0, 0.0));
                w.entity_mut(surface).unwrap().reactive_state =
                    Some(ReactiveState::new(temperature, moisture, 1.0));
                let id = actor(&mut w, shapes()[0], Vec3::new(5.30, 6.0, 0.0));
                input(
                    &mut w,
                    id,
                    LocomotionInput {
                        direction: Vec3::NEG_X,
                        climb: Vec2::Y,
                        grip: true,
                        ..Default::default()
                    },
                );
                for _ in 0..20 {
                    w.step(&env);
                }
                assert_eq!(
                    w.entity(id).unwrap().locomotion.unwrap().mode == LocomotionMode::Climbing,
                    moisture == 0.0 && temperature < 65.0
                );
            }
        }
    }
    #[test]
    fn anchor_follows_support_removal_releases_and_snapshot_replays() {
        for shape in shapes() {
            let mut w = World::with_seed(8);
            let env = FlatEnvironment::default();
            let surface = obstacle(
                &mut w,
                Collider::CapsuleY {
                    radius: 0.5,
                    half_height: 5.0,
                },
                Vec3::new(0.0, 5.0, 0.0),
            );
            let id = actor(&mut w, shape, Vec3::new(0.8, 3.0, 0.0));
            input(
                &mut w,
                id,
                LocomotionInput {
                    direction: Vec3::NEG_X,
                    climb: Vec2::Y,
                    grip: true,
                    ..Default::default()
                },
            );
            w.step(&env);
            let before = w.entity(id).unwrap().transform.position;
            w.entity_mut(surface).unwrap().transform.position += Vec3::X * 0.3;
            w.step(&env);
            assert!((w.entity(id).unwrap().transform.position.x - before.x - 0.3).abs() < 0.01);
            let snapshot = w.snapshot();
            for _ in 0..60 {
                w.step(&env);
            }
            let expected = w.snapshot();
            w.restore(snapshot);
            for _ in 0..60 {
                w.step(&env);
            }
            assert_eq!(expected, w.snapshot());
            w.remove(surface);
            w.step(&env);
            assert_eq!(
                w.entity(id).unwrap().locomotion.unwrap().mode,
                LocomotionMode::Airborne
            );
            assert!(w.entity(id).unwrap().locomotion.unwrap().support.is_none());
        }
    }
    #[test]
    fn jump_detaches_and_exhaustion_requires_ground_recovery() {
        for shape in shapes() {
            let mut w = World::with_seed(2);
            let env = FlatEnvironment::default();
            obstacle(
                &mut w,
                Collider::CapsuleY {
                    radius: 0.5,
                    half_height: 8.0,
                },
                Vec3::new(0.0, 8.0, 0.0),
            );
            let id = actor(&mut w, shape, Vec3::new(0.8, 5.0, 0.0));
            input(
                &mut w,
                id,
                LocomotionInput {
                    direction: Vec3::NEG_X,
                    grip: true,
                    jump: true,
                    ..Default::default()
                },
            );
            w.step(&env);
            let e = w.entity(id).unwrap();
            assert_eq!(e.locomotion.unwrap().mode, LocomotionMode::Airborne);
            assert!(e.body.unwrap().linear_velocity.x > 2.0);
            assert!(!e.locomotion.unwrap().input.jump);
            let e = w.entity_mut(id).unwrap();
            e.transform.position = Vec3::new(0.8, 5.0, 0.0);
            let m = e.locomotion.as_mut().unwrap();
            m.stamina = 0.001;
            m.regrip_delay = 0.0;
            for _ in 0..4 {
                w.step(&env);
            }
            assert_eq!(
                w.entity(id).unwrap().locomotion.unwrap().mode,
                LocomotionMode::Airborne
            );
            assert_eq!(w.entity(id).unwrap().locomotion.unwrap().stamina, 0.0);
        }
    }
    #[test]
    fn substeps_stop_fast_motion_at_two_obstacle_shapes() {
        for shape in [
            Collider::Sphere { radius: 0.15 },
            Collider::CapsuleY {
                radius: 0.15,
                half_height: 2.0,
            },
        ] {
            let mut w = World::with_seed(1);
            let env = FlatEnvironment::default();
            obstacle(&mut w, shape, Vec3::new(0.0, 1.0, 0.0));
            let id = actor(&mut w, shapes()[0], Vec3::new(-2.0, 1.0, 0.0));
            let e = w.entity_mut(id).unwrap();
            e.body.as_mut().unwrap().linear_velocity = Vec3::X * 240.0;
            w.step(&env);
            assert!(w.entity(id).unwrap().transform.position.x < -0.40);
        }
    }
}

#[cfg(test)]
mod transition_tests {
    use super::*;
    use crate::{Body, Collider, EntityBundle, FlatEnvironment, ReactiveState, Transform};
    #[test]
    fn an_existing_grip_releases_when_its_material_becomes_wet_or_hot() {
        for moisture in [true, false] {
            let mut w = World::with_seed(19);
            let mut surface =
                EntityBundle::new(Transform::from_translation(Vec3::new(0.0, 4.0, 0.0)));
            surface.collider = Some(Collider::CapsuleY {
                radius: 0.5,
                half_height: 4.0,
            });
            surface.surface.friction = 0.85;
            let support = w.spawn(surface);
            let mut actor =
                EntityBundle::new(Transform::from_translation(Vec3::new(0.8, 3.0, 0.0)));
            let mut body = Body::static_body();
            body.mode = BodyMode::Kinematic;
            actor.body = Some(body);
            actor.collider = Some(Collider::Sphere { radius: 0.28 });
            actor.locomotion = Some(Locomotion {
                input: LocomotionInput {
                    direction: Vec3::NEG_X,
                    grip: true,
                    ..Default::default()
                },
                ..Default::default()
            });
            let id = w.spawn(actor);
            let env = FlatEnvironment::default();
            w.step(&env);
            assert_eq!(
                w.entity(id).unwrap().locomotion.unwrap().mode,
                LocomotionMode::Climbing
            );
            let old_position = w.entity(id).unwrap().transform.position;
            let rotation = glam::Quat::from_rotation_y(0.25);
            w.entity_mut(support).unwrap().transform.rotation = rotation;
            w.step(&env);
            let expected =
                Vec3::new(0.0, 4.0, 0.0) + rotation * (old_position - Vec3::new(0.0, 4.0, 0.0));
            assert!(w.entity(id).unwrap().transform.position.distance(expected) < 0.01);
            w.entity_mut(support).unwrap().reactive_state = Some(ReactiveState::new(
                if moisture { 20.0 } else { 100.0 },
                if moisture { 1.0 } else { 0.0 },
                1.0,
            ));
            w.step(&env);
            assert_eq!(
                w.entity(id).unwrap().locomotion.unwrap().mode,
                LocomotionMode::Airborne
            );
            assert!(w.entity(id).unwrap().body.unwrap().linear_velocity.y < 0.0);
        }
    }
}
