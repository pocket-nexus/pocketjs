use std::collections::{BTreeMap, BTreeSet};

use glam::{Quat, Vec3};
use serde::{Deserialize, Serialize};

/// Stable identity. `0` is reserved so missing references stay obvious in
/// receipts and debuggers.
#[derive(Clone, Copy, Debug, PartialEq, Eq, PartialOrd, Ord, Hash, Serialize, Deserialize)]
#[serde(transparent)]
pub struct EntityId(pub u64);

impl EntityId {
    pub const FIRST: Self = Self(1);
}

#[derive(Clone, Copy, Debug, PartialEq, Serialize, Deserialize)]
pub struct Transform {
    pub position: Vec3,
    pub rotation: Quat,
    pub scale: Vec3,
}

impl Transform {
    pub const IDENTITY: Self = Self {
        position: Vec3::ZERO,
        rotation: Quat::IDENTITY,
        scale: Vec3::ONE,
    };

    pub const fn from_translation(position: Vec3) -> Self {
        Self {
            position,
            ..Self::IDENTITY
        }
    }

    pub fn transform_point(self, local: Vec3) -> Vec3 {
        self.position + self.rotation * (self.scale * local)
    }

    pub fn compose(self, local: Self) -> Self {
        Self {
            position: self.transform_point(local.position),
            rotation: (self.rotation * local.rotation).normalize(),
            scale: self.scale * local.scale,
        }
    }
}

impl Default for Transform {
    fn default() -> Self {
        Self::IDENTITY
    }
}

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
pub enum BodyMode {
    #[default]
    Static,
    Kinematic,
    Dynamic,
}

#[derive(Clone, Copy, Debug, PartialEq, Serialize, Deserialize)]
pub struct Body {
    pub mode: BodyMode,
    pub mass: f32,
    pub linear_velocity: Vec3,
    pub angular_velocity: Vec3,
    pub gravity_scale: f32,
    pub linear_damping: f32,
    pub angular_damping: f32,
    pub sleeping: bool,
    pub quiet_turns: u16,
}

impl Body {
    pub fn dynamic(mass: f32) -> Self {
        Self {
            mode: BodyMode::Dynamic,
            mass: mass.max(0.001),
            linear_velocity: Vec3::ZERO,
            angular_velocity: Vec3::ZERO,
            gravity_scale: 1.0,
            linear_damping: 0.12,
            angular_damping: 0.18,
            sleeping: false,
            quiet_turns: 0,
        }
    }

    pub const fn static_body() -> Self {
        Self {
            mode: BodyMode::Static,
            mass: 0.0,
            linear_velocity: Vec3::ZERO,
            angular_velocity: Vec3::ZERO,
            gravity_scale: 0.0,
            linear_damping: 0.0,
            angular_damping: 0.0,
            sleeping: true,
            quiet_turns: 0,
        }
    }

    pub fn inverse_mass(self, attached: bool) -> f32 {
        if self.mode == BodyMode::Dynamic && !attached && self.mass > 0.0 {
            self.mass.recip()
        } else {
            0.0
        }
    }

    pub fn wake(&mut self) {
        self.sleeping = false;
        self.quiet_turns = 0;
    }
}

impl Default for Body {
    fn default() -> Self {
        Self::static_body()
    }
}

/// Collision shape centred on the entity transform. `CapsuleY` follows the
/// entity's rotated local Y axis, so the same shape represents a standing or
/// fallen log.
#[derive(Clone, Copy, Debug, PartialEq, Serialize, Deserialize)]
pub enum Collider {
    Sphere { radius: f32 },
    CapsuleY { radius: f32, half_height: f32 },
}

impl Collider {
    pub fn radius(self) -> f32 {
        match self {
            Self::Sphere { radius } | Self::CapsuleY { radius, .. } => radius.max(0.001),
        }
    }

    pub fn half_height(self) -> f32 {
        match self {
            Self::Sphere { .. } => 0.0,
            Self::CapsuleY { half_height, .. } => half_height.max(0.0),
        }
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Serialize, Deserialize)]
pub struct PhysicalSurface {
    pub friction: f32,
    pub restitution: f32,
}

impl Default for PhysicalSurface {
    fn default() -> Self {
        Self {
            friction: 0.72,
            restitution: 0.12,
        }
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Serialize, Deserialize)]
pub struct Attachment {
    pub parent: EntityId,
    pub local: Transform,
    /// Added to the parent's inherited velocity when the attachment releases.
    pub release_impulse: Vec3,
}

#[derive(Clone, Copy, Debug, PartialEq, Serialize, Deserialize)]
pub struct Structure {
    pub integrity: f32,
    pub max_integrity: f32,
    /// Cut energy is divided by this value before reducing integrity.
    pub cut_resistance: f32,
    /// Contacts below this impulse do no structural damage.
    pub impact_threshold: f32,
    pub impact_damage_scale: f32,
    pub fractured: bool,
}

impl Structure {
    pub fn new(integrity: f32, cut_resistance: f32) -> Self {
        let integrity = integrity.max(0.001);
        Self {
            integrity,
            max_integrity: integrity,
            cut_resistance: cut_resistance.max(0.001),
            impact_threshold: f32::INFINITY,
            impact_damage_scale: 0.0,
            fractured: false,
        }
    }

    pub fn fraction(self) -> f32 {
        (self.integrity / self.max_integrity.max(0.001)).clamp(0.0, 1.0)
    }
}

/// Immutable reaction coefficients. This stays separate from
/// [`PhysicalSurface`]: friction and bounce do not determine ignition or heat
/// flow.
#[derive(Clone, Copy, Debug, PartialEq, Serialize, Deserialize)]
pub struct ReactiveMaterial {
    /// Sensible heat capacity of the dry body in simulation energy units per
    /// degree Celsius. Retained liquid water contributes its own capacity.
    pub heat_capacity: f32,
    pub conductivity: f32,
    pub ignition_temperature_c: f32,
    /// Maximum normalized fuel mass consumed per second while combustion is
    /// active.
    pub burn_rate: f32,
    /// Combustion energy released per normalized unit of fuel consumed.
    pub heat_output: f32,
    pub drying_rate: f32,
    /// Multiplies the ignition penalty contributed by moisture.
    pub moisture_resistance: f32,
    pub cook_temperature_c: f32,
    pub char_temperature_c: f32,
}

#[derive(Clone, Copy, Debug, PartialEq, Serialize, Deserialize)]
pub struct ReactiveState {
    pub temperature_c: f32,
    /// Retained liquid-water mass. `0` is dry and `1` is the saturation
    /// capacity used by [`Interaction::Douse`]; excess water runs off.
    pub moisture: f32,
    /// Normalized remaining combustible mass.
    pub fuel: f32,
    pub burning: bool,
    pub cook_progress: f32,
    pub char_progress: f32,
    pub cooked: bool,
    pub charred: bool,
    pub burned_out: bool,
}

impl ReactiveState {
    pub fn new(temperature_c: f32, moisture: f32, fuel: f32) -> Self {
        Self {
            temperature_c,
            moisture: moisture.clamp(0.0, 1.0),
            fuel: fuel.max(0.0),
            burning: false,
            cook_progress: 0.0,
            char_progress: 0.0,
            cooked: false,
            charred: false,
            burned_out: false,
        }
    }
}

impl Default for ReactiveState {
    fn default() -> Self {
        Self::new(20.0, 0.0, 0.0)
    }
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct Entity {
    pub id: EntityId,
    pub name: Option<String>,
    pub tags: BTreeSet<String>,
    pub transform: Transform,
    pub body: Option<Body>,
    pub collider: Option<Collider>,
    pub surface: PhysicalSurface,
    /// Optional transformed permeability volume for heat and liquid transport.
    #[serde(default)]
    pub transport_surface: Option<crate::TransportSurface>,
    /// Optional fixed-step surface locomotion for a kinematic collider.
    #[serde(default)]
    pub locomotion: Option<crate::Locomotion>,
    pub attachment: Option<Attachment>,
    pub structure: Option<Structure>,
    pub reactive_material: Option<ReactiveMaterial>,
    pub reactive_state: Option<ReactiveState>,
}

impl Entity {
    pub fn has_tag(&self, tag: &str) -> bool {
        self.tags.contains(tag)
    }
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct EntityBundle {
    pub name: Option<String>,
    pub tags: BTreeSet<String>,
    pub transform: Transform,
    pub body: Option<Body>,
    pub collider: Option<Collider>,
    pub surface: PhysicalSurface,
    /// Optional transformed permeability volume for heat and liquid transport.
    #[serde(default)]
    pub transport_surface: Option<crate::TransportSurface>,
    /// Optional fixed-step surface locomotion for a kinematic collider.
    #[serde(default)]
    pub locomotion: Option<crate::Locomotion>,
    pub attachment: Option<Attachment>,
    pub structure: Option<Structure>,
    pub reactive_material: Option<ReactiveMaterial>,
    pub reactive_state: Option<ReactiveState>,
}

impl EntityBundle {
    pub fn new(transform: Transform) -> Self {
        Self {
            name: None,
            tags: BTreeSet::new(),
            transform,
            body: None,
            collider: None,
            surface: PhysicalSurface::default(),
            transport_surface: None,
            locomotion: None,
            attachment: None,
            structure: None,
            reactive_material: None,
            reactive_state: None,
        }
    }

    pub fn named(mut self, name: impl Into<String>) -> Self {
        self.name = Some(name.into());
        self
    }

    pub fn tagged(mut self, tag: impl Into<String>) -> Self {
        self.tags.insert(tag.into());
        self
    }
}

impl Default for EntityBundle {
    fn default() -> Self {
        Self::new(Transform::default())
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Serialize, Deserialize)]
pub struct EnvironmentSample {
    pub ambient_temperature_c: f32,
    pub ambient_moisture: f32,
    pub wind: Vec3,
    pub ground_height: f32,
    pub ground_normal: Vec3,
}

impl Default for EnvironmentSample {
    fn default() -> Self {
        Self {
            ambient_temperature_c: 20.0,
            ambient_moisture: 0.0,
            wind: Vec3::ZERO,
            ground_height: 0.0,
            ground_normal: Vec3::Y,
        }
    }
}

pub trait Environment {
    fn sample(&self, position: Vec3) -> EnvironmentSample;

    /// Finite precipitation volume sampled on a deterministic horizontal grid.
    fn rainfall(&self) -> Option<crate::Rainfall> {
        None
    }

    /// Terrain contact coefficients; height and normal come from `sample`.
    fn surface(&self, _position: Vec3) -> PhysicalSurface {
        PhysicalSurface {
            friction: 0.86,
            restitution: 0.04,
        }
    }
}

#[derive(Clone, Copy, Debug, Default, PartialEq, Serialize, Deserialize)]
pub struct FlatEnvironment {
    pub sample: EnvironmentSample,
}

impl Environment for FlatEnvironment {
    fn sample(&self, _position: Vec3) -> EnvironmentSample {
        self.sample
    }
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub enum Interaction {
    Water(crate::WaterEmission),
    Cut {
        target: EntityId,
        direction: Vec3,
        energy: f32,
    },
    Impulse {
        target: EntityId,
        impulse: Vec3,
        point: Vec3,
    },
    Ignite {
        target: EntityId,
        energy: f32,
    },
    Douse {
        target: EntityId,
        amount: f32,
    },
}

#[derive(Clone, Copy, Debug, PartialEq, Serialize, Deserialize)]
pub struct ContactEvent {
    pub a: EntityId,
    /// `None` identifies terrain.
    pub b: Option<EntityId>,
    /// Points from `b` (or terrain) towards `a`.
    pub normal: Vec3,
    pub position: Vec3,
    pub impulse: f32,
    pub surface_a: PhysicalSurface,
    pub surface_b: PhysicalSurface,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub enum WorldEvent {
    Contact(ContactEvent),
    Detached {
        entity: EntityId,
        parent: EntityId,
    },
    Fractured {
        entity: EntityId,
        direction: Vec3,
        energy: f32,
    },
    Ignited {
        entity: EntityId,
    },
    Extinguished {
        entity: EntityId,
    },
    BurnedOut {
        entity: EntityId,
    },
    Cooked {
        entity: EntityId,
    },
    Charred {
        entity: EntityId,
    },
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct StepReport {
    #[serde(default)]
    pub transport: crate::TransportReport,
    pub tick: u64,
    pub events: Vec<WorldEvent>,
    pub state_hash: u64,
}

#[derive(Clone, Copy, Debug, PartialEq, Serialize, Deserialize)]
#[serde(default)]
pub struct WorldConfig {
    pub fixed_dt: f32,
    pub gravity: Vec3,
    pub reaction_radius: f32,
    pub ambient_exchange: f32,
    pub contact_heat_exchange: f32,
    /// Surface gap treated as thermal contact, in metres.
    pub thermal_contact_tolerance: f32,
    /// Evaporation below boiling, limited by the configured cooling floor.
    /// Zero retains the boiling-only model.
    pub surface_evaporation_rate: f32,
    /// Maximum evaporative cooling below ambient in dry air, in Celsius.
    pub evaporative_cooling_range_c: f32,
    /// Temperature of liquid water introduced by [`Interaction::Douse`].
    pub water_inlet_temperature_c: f32,
    /// Sensible heat capacity per normalized unit of retained liquid water.
    pub water_specific_heat: f32,
    /// Latent heat removed when one normalized unit of water evaporates.
    pub water_vaporization_heat: f32,
    /// Temperature above which retained water can evaporate in this compact
    /// phase model.
    pub water_boiling_temperature_c: f32,
    /// Fraction of combustion energy retained by the burning entity. The
    /// remainder can be absorbed by nearby reactive entities; it is never
    /// duplicated per neighbour.
    pub combustion_local_heat_fraction: f32,
    /// Extra temperature required to enter combustion.
    pub ignition_temperature_margin_c: f32,
    /// Temperature margin below the moisture-adjusted ignition point at which
    /// established combustion stops.
    pub extinction_temperature_margin_c: f32,
    /// Maximum retained water mass at which a non-burning entity may ignite.
    pub ignition_max_moisture: f32,
    /// Retained water mass at which established combustion is extinguished.
    /// This should be greater than `ignition_max_moisture` to provide
    /// hysteresis.
    pub extinction_min_moisture: f32,
    pub sleep_linear_speed: f32,
    pub sleep_angular_speed: f32,
    pub sleep_turns: u16,
}

impl Default for WorldConfig {
    fn default() -> Self {
        Self {
            fixed_dt: 1.0 / 60.0,
            gravity: Vec3::new(0.0, -9.81, 0.0),
            reaction_radius: 3.2,
            ambient_exchange: 0.018,
            contact_heat_exchange: 0.42,
            thermal_contact_tolerance: 0.02,
            surface_evaporation_rate: 0.0,
            evaporative_cooling_range_c: 8.0,
            water_inlet_temperature_c: 18.0,
            water_specific_heat: 4.18,
            water_vaporization_heat: 2_256.0,
            water_boiling_temperature_c: 100.0,
            combustion_local_heat_fraction: 0.35,
            ignition_temperature_margin_c: 8.0,
            extinction_temperature_margin_c: 18.0,
            ignition_max_moisture: 0.55,
            extinction_min_moisture: 0.72,
            sleep_linear_speed: 0.035,
            sleep_angular_speed: 0.04,
            sleep_turns: 45,
        }
    }
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct WorldSnapshot {
    pub config: WorldConfig,
    pub seed: u64,
    pub rng_state: u64,
    pub tick: u64,
    pub next_id: u64,
    pub entities: BTreeMap<EntityId, Entity>,
    pub queued_interactions: Vec<Interaction>,
}
