use std::collections::{BTreeMap, BTreeSet};
use std::error::Error;
use std::fmt;

use glam::{Quat, Vec3};

use crate::rng::WorldRng;
use crate::types::*;
use crate::{HeatTransfer, TransportChannel, TransportReport, WaterSource};

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum SpawnError {
    ReservedId,
    DuplicateId(EntityId),
}

impl fmt::Display for SpawnError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::ReservedId => write!(f, "entity id 0 is reserved"),
            Self::DuplicateId(id) => write!(f, "entity id {} already exists", id.0),
        }
    }
}

impl Error for SpawnError {}

/// Authoritative state advanced at one fixed rate.
pub struct World {
    config: WorldConfig,
    seed: u64,
    rng: WorldRng,
    tick: u64,
    next_id: u64,
    entities: BTreeMap<EntityId, Entity>,
    interactions: Vec<Interaction>,
}

impl World {
    pub fn new(config: WorldConfig) -> Self {
        Self::with_config_seed(config, 1)
    }

    pub fn with_seed(seed: u64) -> Self {
        Self::with_config_seed(WorldConfig::default(), seed)
    }

    pub fn with_config_seed(config: WorldConfig, seed: u64) -> Self {
        assert!(config.fixed_dt.is_finite() && config.fixed_dt > 0.0);
        Self {
            config,
            seed,
            rng: WorldRng::new(seed),
            tick: 0,
            next_id: EntityId::FIRST.0,
            entities: BTreeMap::new(),
            interactions: Vec::new(),
        }
    }

    pub fn config(&self) -> &WorldConfig {
        &self.config
    }

    pub fn config_mut(&mut self) -> &mut WorldConfig {
        &mut self.config
    }

    pub fn seed(&self) -> u64 {
        self.seed
    }

    pub fn tick(&self) -> u64 {
        self.tick
    }

    pub fn rng_mut(&mut self) -> &mut WorldRng {
        &mut self.rng
    }

    pub fn spawn(&mut self, bundle: EntityBundle) -> EntityId {
        while self.next_id == 0 || self.entities.contains_key(&EntityId(self.next_id)) {
            self.next_id = self.next_id.wrapping_add(1);
        }
        let id = EntityId(self.next_id);
        self.next_id = self.next_id.wrapping_add(1);
        self.entities.insert(id, entity_from_bundle(id, bundle));
        id
    }

    pub fn spawn_with_id(
        &mut self,
        id: EntityId,
        bundle: EntityBundle,
    ) -> Result<EntityId, SpawnError> {
        if id.0 == 0 {
            return Err(SpawnError::ReservedId);
        }
        if self.entities.contains_key(&id) {
            return Err(SpawnError::DuplicateId(id));
        }
        self.next_id = self.next_id.max(id.0.saturating_add(1));
        self.entities.insert(id, entity_from_bundle(id, bundle));
        Ok(id)
    }

    pub fn remove(&mut self, id: EntityId) -> Option<Entity> {
        let removed = self.entities.remove(&id);
        if removed.is_some() {
            for entity in self.entities.values_mut() {
                if entity
                    .attachment
                    .is_some_and(|attachment| attachment.parent == id)
                {
                    entity.attachment = None;
                    if let Some(body) = entity.body.as_mut() {
                        body.wake();
                    }
                }
            }
        }
        removed
    }

    pub fn entity(&self, id: EntityId) -> Option<&Entity> {
        self.entities.get(&id)
    }

    pub fn entity_mut(&mut self, id: EntityId) -> Option<&mut Entity> {
        self.entities.get_mut(&id)
    }

    pub fn entities(&self) -> impl ExactSizeIterator<Item = (&EntityId, &Entity)> {
        self.entities.iter()
    }

    pub fn ids_with_tag<'a>(&'a self, tag: &'a str) -> impl Iterator<Item = EntityId> + 'a {
        self.entities
            .iter()
            .filter(move |(_, entity)| entity.has_tag(tag))
            .map(|(&id, _)| id)
    }

    pub fn clear(&mut self) {
        self.entities.clear();
        self.interactions.clear();
        self.tick = 0;
        self.next_id = EntityId::FIRST.0;
        self.rng = WorldRng::new(self.seed);
    }

    pub fn reset(&mut self, seed: u64) {
        self.seed = seed;
        self.clear();
    }

    pub fn queue_interaction(&mut self, interaction: Interaction) {
        self.interactions.push(interaction);
    }

    /// Alias that emphasizes interactions become authoritative on the next
    /// fixed turn, never in an input or collision callback.
    pub fn apply_interaction(&mut self, interaction: Interaction) {
        self.queue_interaction(interaction);
    }

    pub fn snapshot(&self) -> WorldSnapshot {
        WorldSnapshot {
            config: self.config,
            seed: self.seed,
            rng_state: self.rng.state(),
            tick: self.tick,
            next_id: self.next_id,
            entities: self.entities.clone(),
            queued_interactions: self.interactions.clone(),
        }
    }

    pub fn restore(&mut self, snapshot: WorldSnapshot) {
        self.config = snapshot.config;
        self.seed = snapshot.seed;
        self.rng = WorldRng::new(snapshot.rng_state);
        self.tick = snapshot.tick;
        self.next_id = snapshot.next_id.max(EntityId::FIRST.0);
        self.entities = snapshot.entities;
        // The map key is authoritative. Serialized snapshots are public data,
        // so do not let a stale or hand-edited `Entity::id` disagree with it.
        for (&id, entity) in &mut self.entities {
            entity.id = id;
        }
        self.interactions = snapshot.queued_interactions;
    }

    pub fn step<E: Environment + ?Sized>(&mut self, environment: &E) -> StepReport {
        let mut events = Vec::new();
        let mut fracture_causes: BTreeMap<EntityId, (Vec3, f32)> = BTreeMap::new();

        let mut transport = TransportReport::default();
        self.sync_attachments();
        self.consume_interactions(&mut fracture_causes, &mut transport);
        if let Some(rain) = environment.rainfall() {
            self.transport_rain(rain, &mut transport);
        }
        self.step_reactions(environment, &mut events, &mut transport);
        self.integrate_bodies();
        self.step_locomotion(environment);
        let contacts = self.solve_ground(environment);
        let mut pair_contacts = self.solve_pairs();
        let mut contacts = contacts;
        contacts.append(&mut pair_contacts);
        self.apply_contact_damage(&contacts, &mut fracture_causes);
        events.extend(contacts.into_iter().map(WorldEvent::Contact));
        // Physics may have moved a parent. Keep attached presentation and
        // reaction transforms current before any fracture releases children.
        self.sync_attachments();
        self.commit_fractures(fracture_causes, &mut events);

        self.tick = self.tick.wrapping_add(1);
        let state_hash = self.state_hash();
        StepReport {
            transport,
            tick: self.tick,
            events,
            state_hash,
        }
    }

    fn consume_interactions(
        &mut self,
        fractures: &mut BTreeMap<EntityId, (Vec3, f32)>,
        transport: &mut TransportReport,
    ) {
        let config = self.config;
        for interaction in std::mem::take(&mut self.interactions) {
            match interaction {
                Interaction::Water(emission) => {
                    self.transport_water(&emission, WaterSource::Emission, transport);
                }
                Interaction::Cut {
                    target,
                    direction,
                    energy,
                } => {
                    let Some(entity) = self.entities.get_mut(&target) else {
                        continue;
                    };
                    let energy = finite_non_negative(energy);
                    if let Some(structure) = entity.structure.as_mut()
                        && !structure.fractured
                    {
                        structure.integrity = (structure.integrity
                            - energy / structure.cut_resistance.max(0.001))
                        .max(0.0);
                        if structure.integrity <= 0.0 {
                            fractures
                                .entry(target)
                                .or_insert((safe_direction(direction), energy));
                        }
                    }
                }
                Interaction::Impulse {
                    target,
                    impulse,
                    point,
                } => {
                    let Some(entity) = self.entities.get_mut(&target) else {
                        continue;
                    };
                    if !impulse.is_finite() || !point.is_finite() {
                        continue;
                    }
                    if let Some(body) = entity.body.as_mut()
                        && body.mode == BodyMode::Dynamic
                        && entity.attachment.is_none()
                    {
                        let inv_mass = body.mass.max(0.001).recip();
                        body.linear_velocity += impulse * inv_mass;
                        let lever = point - entity.transform.position;
                        body.angular_velocity += lever.cross(impulse) * inv_mass * 0.35;
                        body.wake();
                    }
                }
                Interaction::Ignite { target, energy } => {
                    let Some(entity) = self.entities.get_mut(&target) else {
                        continue;
                    };
                    if let (Some(material), Some(state)) =
                        (entity.reactive_material, entity.reactive_state.as_mut())
                    {
                        add_sensible_heat(state, material, config, finite_non_negative(energy));
                    }
                }
                Interaction::Douse { target, amount } => {
                    let Some(entity) = self.entities.get_mut(&target) else {
                        continue;
                    };
                    let (Some(material), Some(state)) =
                        (entity.reactive_material, entity.reactive_state.as_mut())
                    else {
                        continue;
                    };
                    let amount = finite_non_negative(amount);
                    if amount <= 0.0 {
                        continue;
                    }
                    mix_liquid_water(
                        state,
                        material,
                        config,
                        amount,
                        config.water_inlet_temperature_c,
                    );
                }
            }
        }
    }

    fn sync_attachments(&mut self) {
        let attached: Vec<_> = self
            .entities
            .iter()
            .filter_map(|(&id, entity)| entity.attachment.map(|attachment| (id, attachment)))
            .collect();
        for (id, attachment) in attached {
            let Some(parent) = self.entities.get(&attachment.parent) else {
                if let Some(entity) = self.entities.get_mut(&id) {
                    entity.attachment = None;
                    if let Some(body) = entity.body.as_mut() {
                        body.wake();
                    }
                }
                continue;
            };
            let transform = parent.transform.compose(attachment.local);
            let parent_body = parent.body;
            let parent_position = parent.transform.position;
            if let Some(entity) = self.entities.get_mut(&id) {
                entity.transform = transform;
                if let Some(body) = entity.body.as_mut() {
                    if let Some(parent_body) = parent_body {
                        let arm = transform.position - parent_position;
                        body.linear_velocity =
                            parent_body.linear_velocity + parent_body.angular_velocity.cross(arm);
                        body.angular_velocity = parent_body.angular_velocity;
                    } else {
                        body.linear_velocity = Vec3::ZERO;
                        body.angular_velocity = Vec3::ZERO;
                    }
                    body.sleeping = true;
                    body.quiet_turns = 0;
                }
            }
        }
    }

    fn step_reactions<E: Environment + ?Sized>(
        &mut self,
        environment: &E,
        events: &mut Vec<WorldEvent>,
        transport: &mut TransportReport,
    ) {
        let dt = self.config.fixed_dt;
        let config = self.config;
        let ids: Vec<_> = self
            .entities
            .iter()
            .filter(|(_, entity)| {
                entity.reactive_material.is_some() && entity.reactive_state.is_some()
            })
            .map(|(&id, _)| id)
            .collect();
        let transport_surfaces: Vec<_> = self
            .entities
            .iter()
            .filter_map(|(&id, entity)| {
                entity
                    .transport_surface
                    .map(|surface| (id, entity.transform, surface))
            })
            .collect();
        let previous_burning: BTreeMap<_, _> = ids
            .iter()
            .map(|&id| {
                (
                    id,
                    self.entities[&id].reactive_state.expect("filtered").burning,
                )
            })
            .collect();

        // Ambient exchange is an external energy flux. Cool bodies can also
        // absorb a small amount of ambient water; it enters at ambient
        // temperature and therefore follows the same sensible-heat mixing law
        // as explicit dousing.
        for &id in &ids {
            let position = self.entities[&id].transform.position;
            let sample = environment.sample(position);
            let entity = self.entities.get_mut(&id).expect("id came from map");
            let material = entity.reactive_material.expect("filtered");
            let state = entity.reactive_state.as_mut().expect("filtered");
            let capacity = thermal_capacity(material, *state, config);
            let exchange = finite_non_negative(config.ambient_exchange) * dt / capacity;
            let temperature_delta =
                (sample.ambient_temperature_c - state.temperature_c) * exchange.clamp(0.0, 1.0);
            add_sensible_heat(state, material, config, temperature_delta * capacity);
            if state.temperature_c <= 55.0 {
                let absorbed = sample.ambient_moisture.clamp(0.0, 1.0) * 0.002 * dt;
                mix_liquid_water(
                    state,
                    material,
                    config,
                    absorbed,
                    sample.ambient_temperature_c,
                );
            }
        }

        // Close objects exchange energy in both directions, independently of
        // burning. Pair transfer is capped at the shared equilibrium
        // temperature, so a large fixed step cannot create energy by crossing
        // the two temperatures.
        let snapshots = reaction_snapshots(&self.entities, &ids, config);
        let mut sensible_energy_delta: BTreeMap<EntityId, f32> = BTreeMap::new();
        for i in 0..snapshots.len() {
            for j in i + 1..snapshots.len() {
                let a = snapshots[i];
                let b = snapshots[j];
                let (point_a, point_b) =
                    closest_segment_points(a.shape_a, a.shape_b, b.shape_a, b.shape_b);
                let reach =
                    a.radius + b.radius + finite_non_negative(config.thermal_contact_tolerance);
                if point_a.distance_squared(point_b) > reach * reach {
                    continue;
                }
                // A separating transport volume interrupts this contact path.
                if crate::exposure::trace_exposure(
                    &transport_surfaces,
                    point_a,
                    point_b,
                    TransportChannel::RadiantHeat,
                    &[a.id, b.id],
                )
                .transmission
                    < 1.0
                {
                    continue;
                }
                let conductivity = (a.material.conductivity + b.material.conductivity) * 0.5;
                let requested = (a.state.temperature_c - b.state.temperature_c)
                    * conductivity
                    * finite_non_negative(config.contact_heat_exchange)
                    * dt;
                let equilibrium_limit = (a.state.temperature_c - b.state.temperature_c).abs()
                    / (a.capacity.recip() + b.capacity.recip());
                let transfer = requested.clamp(-equilibrium_limit, equilibrium_limit);
                *sensible_energy_delta.entry(a.id).or_default() -= transfer;
                *sensible_energy_delta.entry(b.id).or_default() += transfer;
            }
        }
        apply_sensible_energy_deltas(&mut self.entities, sensible_energy_delta, config);

        // Determine which entities actually combust during this interval from
        // their post-interaction, post-conduction state. Fuel is the sole
        // source of combustion energy: no fuel consumed means no heat emitted.
        let snapshots = reaction_snapshots(&self.entities, &ids, config);
        let local_fraction = clamp_unit(config.combustion_local_heat_fraction);
        let mut combustion_energy_delta: BTreeMap<EntityId, f32> = BTreeMap::new();
        let mut combustion_sources = Vec::new();
        for source in &snapshots {
            let was_burning = previous_burning[&source.id];
            if !combustion_is_active(source.material, source.state, was_burning, config) {
                continue;
            }
            let fuel_consumed = (finite_non_negative(source.material.burn_rate)
                * combustion_rate_factor(source.material, source.state, config)
                * dt)
                .min(finite_non_negative(source.state.fuel));
            if fuel_consumed <= 0.0 {
                continue;
            }
            let released = fuel_consumed * finite_non_negative(source.material.heat_output);
            *combustion_energy_delta.entry(source.id).or_default() += released * local_fraction;
            combustion_sources.push((*source, fuel_consumed, released * (1.0 - local_fraction)));
        }

        for &(source, _, transferable_energy) in &combustion_sources {
            if transferable_energy <= 0.0 {
                continue;
            }
            let mut receivers = Vec::new();
            let mut total_weight = 0.0;
            for target in &snapshots {
                if target.id == source.id {
                    continue;
                }
                let (source_point, target_point) = closest_segment_points(
                    source.shape_a,
                    source.shape_b,
                    target.shape_a,
                    target.shape_b,
                );
                let delta = target_point - source_point;
                let distance = delta.length();
                let reach =
                    finite_non_negative(config.reaction_radius) + source.radius + target.radius;
                if !distance.is_finite() || reach <= 0.0 || distance >= reach {
                    continue;
                }
                let sample = environment.sample(target.position);
                let wind_alignment = if distance > 0.001 && sample.wind.length_squared() > 0.001 {
                    sample.wind.normalize().dot(delta / distance).max(0.0)
                } else {
                    0.0
                };
                let weight = ((1.0 - distance / reach).max(0.0).powi(2)
                    * (1.0 + wind_alignment * 0.35))
                    .min(1.0);
                if weight > 0.0 {
                    receivers.push((target.id, weight));
                    total_weight += weight;
                }
            }
            if total_weight > 0.0 {
                // Geometry controls how much of the outgoing budget is
                // captured; receiver count only divides that fixed budget.
                // This prevents cloning heat by adding overlapping entities.
                let capture = receivers
                    .iter()
                    .map(|(_, weight)| *weight)
                    .fold(0.0_f32, f32::max);
                let absorbed = transferable_energy * capture;
                for (target, weight) in receivers {
                    let sent = absorbed * weight / total_weight;
                    let exposure = crate::exposure::trace_exposure(
                        &transport_surfaces,
                        source.position,
                        self.entities[&target].transform.position,
                        TransportChannel::RadiantHeat,
                        &[source.id, target],
                    );
                    let mut remaining = sent;
                    let mut blockers = Vec::new();
                    for hit in &exposure.hits {
                        let intercepted = remaining * (1.0 - hit.transmission);
                        remaining -= intercepted;
                        if intercepted > 0.0 {
                            blockers.push(hit.entity);
                            // Reactive barriers absorb their intercepted share; other
                            // barriers export it to the unmodelled environment.
                            *combustion_energy_delta.entry(hit.entity).or_default() += intercepted;
                        }
                    }
                    *combustion_energy_delta.entry(target).or_default() += remaining;
                    transport.heat.push(HeatTransfer {
                        source: source.id,
                        target,
                        sent,
                        received: remaining,
                        intercepted: sent - remaining,
                        blockers,
                    });
                }
            }
        }

        for &(source, fuel_consumed, _) in &combustion_sources {
            let state = self
                .entities
                .get_mut(&source.id)
                .and_then(|entity| entity.reactive_state.as_mut())
                .expect("source came from reactive snapshot");
            state.fuel = (state.fuel - fuel_consumed).max(0.0);
        }
        let combusted: BTreeSet<_> = combustion_sources
            .iter()
            .map(|(source, _, _)| source.id)
            .collect();
        apply_sensible_energy_deltas(&mut self.entities, combustion_energy_delta, config);

        // Evaporation is a phase change, not a free moisture decrement. It can
        // remove only as much water as both the material transfer rate and the
        // available sensible heat permit, and every removed unit pays latent
        // heat before the final temperature is derived.
        for &id in &ids {
            let entity = self.entities.get_mut(&id).expect("id came from map");
            let material = entity.reactive_material.expect("filtered");
            let state = entity.reactive_state.as_mut().expect("filtered");
            transport.water_evaporated += evaporate_liquid_water(state, material, config, dt);
            transport.water_evaporated += crate::exposure::surface_evaporation(
                state,
                material,
                config,
                environment.sample(entity.transform.position),
            );
        }

        for id in ids {
            let entity = self.entities.get_mut(&id).expect("id came from map");
            let material = entity.reactive_material.expect("filtered");
            let state = entity.reactive_state.as_mut().expect("filtered");
            let was_burning = previous_burning[&id];
            if state.fuel <= 0.0 && (was_burning || combusted.contains(&id)) {
                state.burning = false;
                if !state.burned_out {
                    state.burned_out = true;
                    events.push(WorldEvent::BurnedOut { entity: id });
                }
            } else {
                state.burning = combustion_is_active(material, *state, was_burning, config);
                match (was_burning, state.burning) {
                    (false, true) => events.push(WorldEvent::Ignited { entity: id }),
                    (true, false) => events.push(WorldEvent::Extinguished { entity: id }),
                    _ => {}
                }
            }

            if state.temperature_c >= material.cook_temperature_c && !state.cooked {
                state.cook_progress +=
                    (state.temperature_c - material.cook_temperature_c + 1.0) * dt / 180.0;
                if state.cook_progress >= 1.0 {
                    state.cook_progress = 1.0;
                    state.cooked = true;
                    events.push(WorldEvent::Cooked { entity: id });
                }
            }
            if state.temperature_c >= material.char_temperature_c && !state.charred {
                state.char_progress +=
                    (state.temperature_c - material.char_temperature_c + 1.0) * dt / 240.0;
                if state.char_progress >= 1.0 {
                    state.char_progress = 1.0;
                    state.charred = true;
                    events.push(WorldEvent::Charred { entity: id });
                }
            }
        }
    }

    fn integrate_bodies(&mut self) {
        let dt = self.config.fixed_dt;
        for entity in self.entities.values_mut() {
            let attached = entity.attachment.is_some();
            let Some(body) = entity.body.as_mut() else {
                continue;
            };
            if body.mode != BodyMode::Dynamic || attached || body.sleeping {
                continue;
            }
            body.linear_velocity += self.config.gravity * body.gravity_scale * dt;
            body.linear_velocity /= 1.0 + body.linear_damping.max(0.0) * dt;
            body.angular_velocity /= 1.0 + body.angular_damping.max(0.0) * dt;
            entity.transform.position += body.linear_velocity * dt;
            let angular_speed = body.angular_velocity.length();
            if angular_speed > 1e-6 && angular_speed.is_finite() {
                let delta = Quat::from_axis_angle(
                    body.angular_velocity / angular_speed,
                    angular_speed * dt,
                );
                entity.transform.rotation = (delta * entity.transform.rotation).normalize();
            }
        }
    }

    fn solve_ground<E: Environment + ?Sized>(&mut self, environment: &E) -> Vec<ContactEvent> {
        let ids: Vec<_> = self.entities.keys().copied().collect();
        let mut contacts = Vec::new();
        for id in ids {
            let Some(snapshot) = self.entities.get(&id).cloned() else {
                continue;
            };
            let (Some(_collider), Some(body)) = (snapshot.collider, snapshot.body) else {
                continue;
            };
            if body.mode != BodyMode::Dynamic || snapshot.attachment.is_some() {
                continue;
            }
            let sample = environment.sample(snapshot.transform.position);
            let normal = safe_ground_normal(sample.ground_normal);
            let (segment_a, segment_b, radius) = collider_segment(&snapshot);
            let ground_point = Vec3::new(
                snapshot.transform.position.x,
                sample.ground_height,
                snapshot.transform.position.z,
            );
            let support_center = if segment_a.dot(normal) <= segment_b.dot(normal) {
                segment_a
            } else {
                segment_b
            };
            let signed_distance = (support_center - ground_point).dot(normal) - radius;
            let penetration = -signed_distance;
            if penetration <= 0.0 || !penetration.is_finite() {
                continue;
            }
            let entity = self.entities.get_mut(&id).expect("snapshot id exists");
            let body = entity.body.as_mut().expect("snapshot had body");
            entity.transform.position += normal * penetration;
            let normal_speed = body.linear_velocity.dot(normal);
            let mut impulse = 0.0;
            if normal_speed < 0.0 {
                impulse = -(1.0 + clamp_unit(entity.surface.restitution))
                    * normal_speed
                    * body.mass.max(0.001);
                body.linear_velocity -=
                    normal * normal_speed * (1.0 + clamp_unit(entity.surface.restitution));
            }
            let tangent = body.linear_velocity - normal * body.linear_velocity.dot(normal);
            let friction = finite_non_negative(entity.surface.friction);
            body.linear_velocity -= tangent * (friction * self.config.fixed_dt * 8.0).min(1.0);
            body.angular_velocity /= 1.0 + friction * self.config.fixed_dt * 2.0;
            update_sleep(body, &self.config);
            if impulse > 0.02 {
                contacts.push(ContactEvent {
                    a: id,
                    b: None,
                    normal,
                    position: support_center + normal * (penetration - radius),
                    impulse,
                    surface_a: entity.surface,
                    surface_b: PhysicalSurface {
                        friction: 0.86,
                        restitution: 0.04,
                    },
                });
            }
        }
        contacts
    }

    fn solve_pairs(&mut self) -> Vec<ContactEvent> {
        let ids: Vec<_> = self
            .entities
            .iter()
            .filter(|(_, entity)| entity.collider.is_some())
            .map(|(&id, _)| id)
            .collect();
        let mut contacts = Vec::new();
        for i in 0..ids.len() {
            for j in i + 1..ids.len() {
                let a_id = ids[i];
                let b_id = ids[j];
                let a = self.entities[&a_id].clone();
                let b = self.entities[&b_id].clone();
                let inv_a = a
                    .body
                    .map_or(0.0, |body| body.inverse_mass(a.attachment.is_some()));
                let inv_b = b
                    .body
                    .map_or(0.0, |body| body.inverse_mass(b.attachment.is_some()));
                if inv_a + inv_b <= 0.0 {
                    continue;
                }
                let (a0, a1, ar) = collider_segment(&a);
                let (b0, b1, br) = collider_segment(&b);
                let (point_a, point_b) = closest_segment_points(a0, a1, b0, b1);
                let offset = point_a - point_b;
                let distance_squared = offset.length_squared();
                let radius_sum = ar + br;
                if distance_squared >= radius_sum * radius_sum {
                    continue;
                }
                let distance = distance_squared.sqrt();
                let normal = if distance > 1e-5 {
                    offset / distance
                } else if a_id < b_id {
                    Vec3::X
                } else {
                    -Vec3::X
                };
                let penetration = radius_sum - distance;
                let inv_sum = inv_a + inv_b;
                let correction = normal * (penetration.max(0.0) / inv_sum * 0.82);
                if inv_a > 0.0 {
                    let entity = self.entities.get_mut(&a_id).unwrap();
                    entity.transform.position += correction * inv_a;
                    entity.body.as_mut().unwrap().wake();
                }
                if inv_b > 0.0 {
                    let entity = self.entities.get_mut(&b_id).unwrap();
                    entity.transform.position -= correction * inv_b;
                    entity.body.as_mut().unwrap().wake();
                }

                let relative_velocity = body_velocity(&a) - body_velocity(&b);
                let normal_speed = relative_velocity.dot(normal);
                let restitution = clamp_unit(a.surface.restitution.min(b.surface.restitution));
                let impulse = if normal_speed < 0.0 {
                    -(1.0 + restitution) * normal_speed / inv_sum
                } else {
                    0.0
                };
                if impulse > 0.0 {
                    let tangent_velocity = relative_velocity - normal * normal_speed;
                    let friction_impulse = if tangent_velocity.length_squared() > 1e-10 {
                        let tangent = tangent_velocity.normalize();
                        let unconstrained = -relative_velocity.dot(tangent) / inv_sum;
                        let friction = (finite_non_negative(a.surface.friction)
                            * finite_non_negative(b.surface.friction))
                        .sqrt();
                        tangent * unconstrained.clamp(-impulse * friction, impulse * friction)
                    } else {
                        Vec3::ZERO
                    };
                    let impulse_vector = normal * impulse + friction_impulse;
                    if inv_a > 0.0 {
                        let body = self.entities.get_mut(&a_id).unwrap().body.as_mut().unwrap();
                        body.linear_velocity += impulse_vector * inv_a;
                        body.wake();
                    }
                    if inv_b > 0.0 {
                        let body = self.entities.get_mut(&b_id).unwrap().body.as_mut().unwrap();
                        body.linear_velocity -= impulse_vector * inv_b;
                        body.wake();
                    }
                }
                if impulse > 0.02 {
                    let contact_a = point_a - normal * ar;
                    let contact_b = point_b + normal * br;
                    contacts.push(ContactEvent {
                        a: a_id,
                        b: Some(b_id),
                        normal,
                        position: (contact_a + contact_b) * 0.5,
                        impulse,
                        surface_a: a.surface,
                        surface_b: b.surface,
                    });
                }
            }
        }
        contacts
    }

    fn apply_contact_damage(
        &mut self,
        contacts: &[ContactEvent],
        fractures: &mut BTreeMap<EntityId, (Vec3, f32)>,
    ) {
        let mut damage: BTreeMap<EntityId, (Vec3, f32)> = BTreeMap::new();
        for contact in contacts {
            let participants = [
                Some((contact.a, contact.normal)),
                contact.b.map(|id| (id, -contact.normal)),
            ];
            for (id, direction) in participants.into_iter().flatten() {
                let Some(structure) = self.entities.get(&id).and_then(|entity| entity.structure)
                else {
                    continue;
                };
                if contact.impulse > structure.impact_threshold {
                    let amount = (contact.impulse - structure.impact_threshold)
                        * structure.impact_damage_scale;
                    let entry = damage.entry(id).or_insert((direction, 0.0));
                    entry.1 += amount;
                }
            }
        }
        for (id, (direction, amount)) in damage {
            let Some(structure) = self
                .entities
                .get_mut(&id)
                .and_then(|entity| entity.structure.as_mut())
            else {
                continue;
            };
            if structure.fractured {
                continue;
            }
            structure.integrity = (structure.integrity - amount).max(0.0);
            if structure.integrity <= 0.0 {
                fractures.entry(id).or_insert((direction, amount));
            }
        }
    }

    fn commit_fractures(
        &mut self,
        fractures: BTreeMap<EntityId, (Vec3, f32)>,
        events: &mut Vec<WorldEvent>,
    ) {
        for (id, (direction, energy)) in fractures {
            let direction = safe_direction(direction);
            let Some(entity) = self.entities.get_mut(&id) else {
                continue;
            };
            let Some(structure) = entity.structure.as_mut() else {
                continue;
            };
            if structure.fractured || structure.integrity > 0.0 {
                continue;
            }
            structure.fractured = true;
            if let Some(body) = entity.body.as_mut() {
                body.mode = BodyMode::Dynamic;
                body.gravity_scale = 1.0;
                let inv_mass = body.mass.max(0.001).recip();
                body.linear_velocity += direction * energy * inv_mass * 0.08;
                let torque_axis = Vec3::Y.cross(direction).normalize_or(Vec3::X);
                body.angular_velocity += torque_axis * (0.65 + energy * inv_mass * 0.1);
                body.wake();
            }
            events.push(WorldEvent::Fractured {
                entity: id,
                direction,
                energy,
            });

            let parent_transform = entity.transform;
            let parent_body = entity.body.unwrap_or_default();
            let children: Vec<_> = self
                .entities
                .iter()
                .filter(|(_, child)| {
                    child
                        .attachment
                        .is_some_and(|attachment| attachment.parent == id)
                })
                .map(|(&child_id, _)| child_id)
                .collect();
            for child_id in children {
                let child = self.entities.get_mut(&child_id).expect("child id exists");
                let attachment = child.attachment.take().expect("filtered attachment");
                if let Some(body) = child.body.as_mut() {
                    body.mode = BodyMode::Dynamic;
                    body.gravity_scale = 1.0;
                    let arm = child.transform.position - parent_transform.position;
                    let jitter = Vec3::new(
                        self.rng.signed_f32(),
                        self.rng.next_f32(),
                        self.rng.signed_f32(),
                    ) * 0.18;
                    body.linear_velocity = parent_body.linear_velocity
                        + parent_body.angular_velocity.cross(arm)
                        + attachment.release_impulse
                        + jitter;
                    body.wake();
                }
                events.push(WorldEvent::Detached {
                    entity: child_id,
                    parent: id,
                });
            }
        }
    }

    pub fn state_hash(&self) -> u64 {
        let mut hash = StableHash::new();
        hash.u64(self.seed);
        hash.u64(self.rng.state());
        hash.u64(self.tick);
        hash.u64(self.next_id);
        hash.f32(self.config.fixed_dt);
        hash.vec3(self.config.gravity);
        hash.f32(self.config.reaction_radius);
        hash.f32(self.config.ambient_exchange);
        hash.f32(self.config.contact_heat_exchange);
        hash.f32(self.config.thermal_contact_tolerance);
        hash.f32(self.config.surface_evaporation_rate);
        hash.f32(self.config.evaporative_cooling_range_c);
        hash.f32(self.config.water_inlet_temperature_c);
        hash.f32(self.config.water_specific_heat);
        hash.f32(self.config.water_vaporization_heat);
        hash.f32(self.config.water_boiling_temperature_c);
        hash.f32(self.config.combustion_local_heat_fraction);
        hash.f32(self.config.ignition_temperature_margin_c);
        hash.f32(self.config.extinction_temperature_margin_c);
        hash.f32(self.config.ignition_max_moisture);
        hash.f32(self.config.extinction_min_moisture);
        hash.f32(self.config.sleep_linear_speed);
        hash.f32(self.config.sleep_angular_speed);
        hash.u64(self.config.sleep_turns as u64);
        hash.u64(self.entities.len() as u64);
        for (&id, entity) in &self.entities {
            hash.u64(id.0);
            match &entity.name {
                Some(name) => {
                    hash.u8(1);
                    hash.string(name);
                }
                None => hash.u8(0),
            }
            hash.u64(entity.tags.len() as u64);
            for tag in &entity.tags {
                hash.string(tag);
            }
            hash.transform(entity.transform);
            match entity.body {
                Some(body) => {
                    hash.u8(1);
                    hash.u8(body.mode as u8);
                    hash.f32(body.mass);
                    hash.vec3(body.linear_velocity);
                    hash.vec3(body.angular_velocity);
                    hash.f32(body.gravity_scale);
                    hash.f32(body.linear_damping);
                    hash.f32(body.angular_damping);
                    hash.u8(body.sleeping as u8);
                    hash.u64(body.quiet_turns as u64);
                }
                None => hash.u8(0),
            }
            match entity.collider {
                Some(Collider::Sphere { radius }) => {
                    hash.u8(1);
                    hash.f32(radius);
                }
                Some(Collider::CapsuleY {
                    radius,
                    half_height,
                }) => {
                    hash.u8(2);
                    hash.f32(radius);
                    hash.f32(half_height);
                }
                None => hash.u8(0),
            }
            match entity.transport_surface {
                Some(surface) => {
                    hash.u8(1);
                    hash.vec3(surface.half_extents);
                    hash.f32(surface.heat_transmission);
                    hash.f32(surface.water_transmission);
                }
                None => hash.u8(0),
            }
            match entity.locomotion {
                Some(motor) => {
                    hash.u8(1);
                    let c = motor.config;
                    for value in [
                        c.walk_speed,
                        c.climb_speed,
                        c.jump_speed,
                        c.min_ground_dot,
                        c.contact_offset,
                        c.grip_reach,
                        c.grip_acceleration,
                        c.max_temperature_c,
                        c.stamina_seconds,
                        c.recovery_per_second,
                    ] {
                        hash.f32(value);
                    }
                    hash.vec3(motor.input.direction);
                    hash.f32(motor.input.climb.x);
                    hash.f32(motor.input.climb.y);
                    hash.u8(motor.input.grip as u8);
                    hash.u8(motor.input.jump as u8);
                    hash.u8(motor.mode as u8);
                    hash.vec3(motor.normal);
                    hash.f32(motor.stamina);
                    hash.f32(motor.regrip_delay);
                    match motor.support {
                        Some(anchor) => {
                            hash.u8(1);
                            hash.u64(anchor.entity.0);
                            hash.vec3(anchor.local_point);
                            hash.vec3(anchor.world_point);
                        }
                        None => hash.u8(0),
                    }
                }
                None => hash.u8(0),
            }
            hash.f32(entity.surface.friction);
            hash.f32(entity.surface.restitution);
            match entity.attachment {
                Some(attachment) => {
                    hash.u8(1);
                    hash.u64(attachment.parent.0);
                    hash.transform(attachment.local);
                    hash.vec3(attachment.release_impulse);
                }
                None => hash.u8(0),
            }
            match entity.structure {
                Some(structure) => {
                    hash.u8(1);
                    hash.f32(structure.integrity);
                    hash.f32(structure.max_integrity);
                    hash.f32(structure.cut_resistance);
                    hash.f32(structure.impact_threshold);
                    hash.f32(structure.impact_damage_scale);
                    hash.u8(structure.fractured as u8);
                }
                None => hash.u8(0),
            }
            match entity.reactive_material {
                Some(material) => {
                    hash.u8(1);
                    hash.f32(material.heat_capacity);
                    hash.f32(material.conductivity);
                    hash.f32(material.ignition_temperature_c);
                    hash.f32(material.burn_rate);
                    hash.f32(material.heat_output);
                    hash.f32(material.drying_rate);
                    hash.f32(material.moisture_resistance);
                    hash.f32(material.cook_temperature_c);
                    hash.f32(material.char_temperature_c);
                }
                None => hash.u8(0),
            }
            match entity.reactive_state {
                Some(state) => {
                    hash.u8(1);
                    hash.f32(state.temperature_c);
                    hash.f32(state.moisture);
                    hash.f32(state.fuel);
                    hash.u8(state.burning as u8);
                    hash.f32(state.cook_progress);
                    hash.f32(state.char_progress);
                    hash.u8(state.cooked as u8);
                    hash.u8(state.charred as u8);
                    hash.u8(state.burned_out as u8);
                }
                None => hash.u8(0),
            }
        }
        hash.u64(self.interactions.len() as u64);
        for interaction in &self.interactions {
            match interaction {
                Interaction::Water(emission) => {
                    hash.u8(5);
                    hash.u64(emission.points.len() as u64);
                    for point in &emission.points {
                        hash.vec3(*point);
                    }
                    hash.f32(emission.amount);
                    hash.f32(emission.temperature_c);
                    hash.u64(emission.source.map_or(0, |source| source.0));
                }
                Interaction::Cut {
                    target,
                    direction,
                    energy,
                } => {
                    hash.u8(1);
                    hash.u64(target.0);
                    hash.vec3(*direction);
                    hash.f32(*energy);
                }
                Interaction::Impulse {
                    target,
                    impulse,
                    point,
                } => {
                    hash.u8(2);
                    hash.u64(target.0);
                    hash.vec3(*impulse);
                    hash.vec3(*point);
                }
                Interaction::Ignite { target, energy } => {
                    hash.u8(3);
                    hash.u64(target.0);
                    hash.f32(*energy);
                }
                Interaction::Douse { target, amount } => {
                    hash.u8(4);
                    hash.u64(target.0);
                    hash.f32(*amount);
                }
            }
        }
        hash.finish()
    }
}

#[derive(Clone, Copy)]
struct ReactionSnapshot {
    id: EntityId,
    position: Vec3,
    shape_a: Vec3,
    shape_b: Vec3,
    radius: f32,
    material: ReactiveMaterial,
    state: ReactiveState,
    capacity: f32,
}

fn reaction_snapshots(
    entities: &BTreeMap<EntityId, Entity>,
    ids: &[EntityId],
    config: WorldConfig,
) -> Vec<ReactionSnapshot> {
    ids.iter()
        .map(|&id| {
            let entity = &entities[&id];
            let (shape_a, shape_b, radius) = reaction_shape(entity);
            let material = entity.reactive_material.expect("filtered");
            let state = entity.reactive_state.expect("filtered");
            ReactionSnapshot {
                id,
                position: entity.transform.position,
                shape_a,
                shape_b,
                radius,
                material,
                state,
                capacity: thermal_capacity(material, state, config),
            }
        })
        .collect()
}

fn dry_heat_capacity(material: ReactiveMaterial) -> f32 {
    if material.heat_capacity.is_finite() {
        material.heat_capacity.max(0.05)
    } else {
        0.05
    }
}

fn liquid_water_heat_capacity(config: WorldConfig) -> f32 {
    finite_non_negative(config.water_specific_heat)
}

pub(crate) fn thermal_capacity(
    material: ReactiveMaterial,
    state: ReactiveState,
    config: WorldConfig,
) -> f32 {
    dry_heat_capacity(material) + clamp_unit(state.moisture) * liquid_water_heat_capacity(config)
}

fn sensible_energy(material: ReactiveMaterial, state: ReactiveState, config: WorldConfig) -> f32 {
    thermal_capacity(material, state, config) * state.temperature_c
}

fn add_sensible_heat(
    state: &mut ReactiveState,
    material: ReactiveMaterial,
    config: WorldConfig,
    energy: f32,
) {
    if !energy.is_finite() || !state.temperature_c.is_finite() {
        return;
    }
    state.temperature_c += energy / thermal_capacity(material, *state, config);
}

pub(crate) fn mix_liquid_water(
    state: &mut ReactiveState,
    material: ReactiveMaterial,
    config: WorldConfig,
    requested_mass: f32,
    inlet_temperature_c: f32,
) -> f32 {
    let current_water = clamp_unit(state.moisture);
    state.moisture = current_water;
    let incoming = finite_non_negative(requested_mass);
    if incoming <= 0.0 || !state.temperature_c.is_finite() {
        return 0.0;
    }
    let water_capacity = liquid_water_heat_capacity(config);
    let inlet_temperature_c = if inlet_temperature_c.is_finite() {
        inlet_temperature_c
    } else {
        state.temperature_c
    };
    let initial_energy = sensible_energy(material, *state, config);
    let mixed_water = current_water + incoming;
    let mixed_capacity = dry_heat_capacity(material) + mixed_water * water_capacity;
    let mixed_energy = initial_energy + incoming * water_capacity * inlet_temperature_c;
    state.temperature_c = mixed_energy / mixed_capacity;
    state.moisture = mixed_water.min(1.0);
    // Water beyond saturation leaves at the mixed temperature. Removing that
    // mass and its sensible energy does not change the retained temperature.
    state.moisture - current_water
}

fn evaporate_liquid_water(
    state: &mut ReactiveState,
    material: ReactiveMaterial,
    config: WorldConfig,
    dt: f32,
) -> f32 {
    let water = clamp_unit(state.moisture);
    state.moisture = water;
    let boiling_temperature_c = if config.water_boiling_temperature_c.is_finite() {
        config.water_boiling_temperature_c
    } else {
        100.0
    };
    if water <= 0.0
        || !state.temperature_c.is_finite()
        || state.temperature_c <= boiling_temperature_c
    {
        return 0.0;
    }

    let superheat = state.temperature_c - boiling_temperature_c;
    let water_capacity = liquid_water_heat_capacity(config);
    let latent_heat = finite_non_negative(config.water_vaporization_heat);
    let capacity = thermal_capacity(material, *state, config);
    let phase_energy_per_mass = latent_heat + water_capacity * superheat;
    let energy_limited = if phase_energy_per_mass > 0.0 {
        capacity * superheat / phase_energy_per_mass
    } else {
        water
    };
    let transfer_multiplier = (1.0 + superheat / 120.0).clamp(1.0, 4.0);
    let rate_limited =
        finite_non_negative(material.drying_rate) * transfer_multiplier * finite_non_negative(dt);
    let evaporated = water.min(energy_limited).min(rate_limited);
    if evaporated <= 0.0 {
        return 0.0;
    }

    let initial_temperature = state.temperature_c;
    let initial_energy = sensible_energy(material, *state, config);
    let exported_energy = evaporated * (water_capacity * initial_temperature + latent_heat);
    state.moisture = water - evaporated;
    state.temperature_c =
        (initial_energy - exported_energy) / thermal_capacity(material, *state, config);
    evaporated
}

pub(crate) fn moisture_adjusted_ignition(material: ReactiveMaterial, state: ReactiveState) -> f32 {
    finite_non_negative(material.ignition_temperature_c)
        * (1.0 + clamp_unit(state.moisture) * finite_non_negative(material.moisture_resistance))
}

fn combustion_is_active(
    material: ReactiveMaterial,
    state: ReactiveState,
    was_burning: bool,
    config: WorldConfig,
) -> bool {
    if state.burned_out
        || finite_non_negative(state.fuel) <= 0.0
        || !state.temperature_c.is_finite()
    {
        return false;
    }
    let adjusted_ignition = moisture_adjusted_ignition(material, state);
    let ignition_temperature =
        adjusted_ignition + finite_non_negative(config.ignition_temperature_margin_c);
    let extinction_temperature =
        adjusted_ignition - finite_non_negative(config.extinction_temperature_margin_c);
    let ignition_moisture = clamp_unit(config.ignition_max_moisture);
    let extinction_moisture = clamp_unit(config.extinction_min_moisture).max(ignition_moisture);
    if was_burning {
        state.moisture < extinction_moisture && state.temperature_c >= extinction_temperature
    } else {
        state.moisture <= ignition_moisture && state.temperature_c >= ignition_temperature
    }
}

fn combustion_rate_factor(
    material: ReactiveMaterial,
    state: ReactiveState,
    config: WorldConfig,
) -> f32 {
    let dry_fraction = 1.0 - clamp_unit(state.moisture);
    let adjusted_ignition = moisture_adjusted_ignition(material, state);
    let lower = adjusted_ignition - finite_non_negative(config.extinction_temperature_margin_c);
    let upper = adjusted_ignition + finite_non_negative(config.ignition_temperature_margin_c);
    let span = upper - lower;
    let thermal_fraction = if span > 1e-6 {
        ((state.temperature_c - lower) / span).clamp(0.0, 1.0)
    } else if state.temperature_c >= upper {
        1.0
    } else {
        0.0
    };
    dry_fraction * thermal_fraction
}

fn apply_sensible_energy_deltas(
    entities: &mut BTreeMap<EntityId, Entity>,
    deltas: BTreeMap<EntityId, f32>,
    config: WorldConfig,
) {
    for (id, energy) in deltas {
        let Some(entity) = entities.get_mut(&id) else {
            continue;
        };
        let (Some(material), Some(state)) =
            (entity.reactive_material, entity.reactive_state.as_mut())
        else {
            continue;
        };
        add_sensible_heat(state, material, config, energy);
    }
}

fn entity_from_bundle(id: EntityId, bundle: EntityBundle) -> Entity {
    Entity {
        id,
        name: bundle.name,
        tags: bundle.tags,
        transform: bundle.transform,
        body: bundle.body,
        collider: bundle.collider,
        surface: bundle.surface,
        transport_surface: bundle.transport_surface,
        locomotion: bundle.locomotion,
        attachment: bundle.attachment,
        structure: bundle.structure,
        reactive_material: bundle.reactive_material,
        reactive_state: bundle.reactive_state,
    }
}

fn finite_non_negative(value: f32) -> f32 {
    if value.is_finite() {
        value.max(0.0)
    } else {
        0.0
    }
}

fn clamp_unit(value: f32) -> f32 {
    if value.is_finite() {
        value.clamp(0.0, 1.0)
    } else {
        0.0
    }
}

fn safe_direction(direction: Vec3) -> Vec3 {
    if direction.is_finite() && direction.length_squared() > 1e-8 {
        direction.normalize()
    } else {
        Vec3::X
    }
}

fn safe_ground_normal(normal: Vec3) -> Vec3 {
    if !normal.is_finite() || normal.length_squared() <= 1e-8 {
        return Vec3::Y;
    }
    let normal = normal.normalize();
    if normal.y < 0.0 { -normal } else { normal }
}

fn body_velocity(entity: &Entity) -> Vec3 {
    match entity.body {
        Some(body) if body.mode != BodyMode::Static && body.linear_velocity.is_finite() => {
            body.linear_velocity
        }
        _ => Vec3::ZERO,
    }
}

fn reaction_shape(entity: &Entity) -> (Vec3, Vec3, f32) {
    if entity.collider.is_some() {
        collider_segment(entity)
    } else {
        (entity.transform.position, entity.transform.position, 0.0)
    }
}

pub(crate) fn collider_segment(entity: &Entity) -> (Vec3, Vec3, f32) {
    let collider = entity.collider.expect("caller filters collider");
    match collider {
        Collider::Sphere { .. } => {
            let uniform_scale = entity.transform.scale.abs().max_element().max(0.001);
            let radius = collider.radius() * uniform_scale;
            (entity.transform.position, entity.transform.position, radius)
        }
        Collider::CapsuleY { .. } => {
            let radial_scale = entity
                .transform
                .scale
                .x
                .abs()
                .max(entity.transform.scale.z.abs())
                .max(0.001);
            let radius = collider.radius() * radial_scale;
            let half_height = collider.half_height() * entity.transform.scale.y.abs();
            let axis = entity.transform.rotation * Vec3::Y * half_height;
            (
                entity.transform.position - axis,
                entity.transform.position + axis,
                radius,
            )
        }
    }
}

/// Closest points on two finite segments. Based on the standard clamped
/// two-parameter solution, with explicit degenerate handling for spheres.
pub(crate) fn closest_segment_points(p1: Vec3, q1: Vec3, p2: Vec3, q2: Vec3) -> (Vec3, Vec3) {
    let d1 = q1 - p1;
    let d2 = q2 - p2;
    let r = p1 - p2;
    let a = d1.dot(d1);
    let e = d2.dot(d2);
    let f = d2.dot(r);
    let epsilon = 1e-8;
    let (mut s, mut t);
    if a <= epsilon && e <= epsilon {
        return (p1, p2);
    }
    if a <= epsilon {
        s = 0.0;
        t = (f / e).clamp(0.0, 1.0);
    } else {
        let c = d1.dot(r);
        if e <= epsilon {
            t = 0.0;
            s = (-c / a).clamp(0.0, 1.0);
        } else {
            let b = d1.dot(d2);
            let denominator = a * e - b * b;
            s = if denominator.abs() > epsilon {
                ((b * f - c * e) / denominator).clamp(0.0, 1.0)
            } else {
                0.0
            };
            t = (b * s + f) / e;
            if t < 0.0 {
                t = 0.0;
                s = (-c / a).clamp(0.0, 1.0);
            } else if t > 1.0 {
                t = 1.0;
                s = ((b - c) / a).clamp(0.0, 1.0);
            }
        }
    }
    (p1 + d1 * s, p2 + d2 * t)
}

fn update_sleep(body: &mut Body, config: &WorldConfig) {
    if body.linear_velocity.length() < config.sleep_linear_speed
        && body.angular_velocity.length() < config.sleep_angular_speed
    {
        body.quiet_turns = body.quiet_turns.saturating_add(1);
        if body.quiet_turns >= config.sleep_turns {
            body.sleeping = true;
            body.linear_velocity = Vec3::ZERO;
            body.angular_velocity = Vec3::ZERO;
        }
    } else {
        body.quiet_turns = 0;
        body.sleeping = false;
    }
}

struct StableHash(u64);

impl StableHash {
    const OFFSET: u64 = 0xcbf2_9ce4_8422_2325;
    const PRIME: u64 = 0x0000_0100_0000_01b3;

    fn new() -> Self {
        Self(Self::OFFSET)
    }

    fn bytes(&mut self, bytes: &[u8]) {
        for &byte in bytes {
            self.0 ^= byte as u64;
            self.0 = self.0.wrapping_mul(Self::PRIME);
        }
    }

    fn u8(&mut self, value: u8) {
        self.bytes(&[value]);
    }

    fn u64(&mut self, value: u64) {
        self.bytes(&value.to_le_bytes());
    }

    fn f32(&mut self, value: f32) {
        self.bytes(&value.to_bits().to_le_bytes());
    }

    fn vec3(&mut self, value: Vec3) {
        self.f32(value.x);
        self.f32(value.y);
        self.f32(value.z);
    }

    fn transform(&mut self, value: Transform) {
        self.vec3(value.position);
        self.f32(value.rotation.x);
        self.f32(value.rotation.y);
        self.f32(value.rotation.z);
        self.f32(value.rotation.w);
        self.vec3(value.scale);
    }

    fn string(&mut self, value: &str) {
        self.u64(value.len() as u64);
        self.bytes(value.as_bytes());
    }

    fn finish(self) -> u64 {
        self.0
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn wood_material_fixture() -> ReactiveMaterial {
        ReactiveMaterial {
            heat_capacity: 2.4,
            conductivity: 0.26,
            ignition_temperature_c: 235.0,
            burn_rate: 0.018,
            heat_output: 28_900.0,
            drying_rate: 0.055,
            moisture_resistance: 1.8,
            cook_temperature_c: 90.0,
            char_temperature_c: 285.0,
        }
    }

    fn fruit_material_fixture() -> ReactiveMaterial {
        ReactiveMaterial {
            heat_capacity: 3.6,
            conductivity: 0.42,
            ignition_temperature_c: 310.0,
            burn_rate: 0.012,
            heat_output: 17_500.0,
            drying_rate: 0.035,
            moisture_resistance: 2.4,
            cook_temperature_c: 72.0,
            char_temperature_c: 185.0,
        }
    }

    fn flame_material_fixture() -> ReactiveMaterial {
        ReactiveMaterial {
            heat_capacity: 0.25,
            conductivity: 1.0,
            ignition_temperature_c: 80.0,
            burn_rate: 0.07,
            heat_output: 12_600.0,
            drying_rate: 0.2,
            moisture_resistance: 0.6,
            cook_temperature_c: f32::INFINITY,
            char_temperature_c: f32::INFINITY,
        }
    }

    fn reactive_entity(
        position: Vec3,
        material: ReactiveMaterial,
        state: ReactiveState,
    ) -> EntityBundle {
        let mut entity = EntityBundle::new(Transform::from_translation(position));
        entity.body = Some(Body::dynamic(1.0));
        entity.collider = Some(Collider::Sphere { radius: 0.25 });
        entity.reactive_material = Some(material);
        entity.reactive_state = Some(state);
        entity
    }

    fn static_reactive_entity(
        position: Vec3,
        material: ReactiveMaterial,
        state: ReactiveState,
    ) -> EntityBundle {
        let mut entity = reactive_entity(position, material, state);
        entity.body = Some(Body::static_body());
        entity
    }

    fn entity_sensible_energy(world: &World, id: EntityId) -> f32 {
        let entity = world.entity(id).unwrap();
        sensible_energy(
            entity.reactive_material.unwrap(),
            entity.reactive_state.unwrap(),
            *world.config(),
        )
    }

    fn assert_close(actual: f32, expected: f32, tolerance: f32) {
        assert!(
            (actual - expected).abs() <= tolerance,
            "expected {expected}, got {actual} (tolerance {tolerance})"
        );
    }

    #[test]
    fn same_seed_and_script_have_the_same_state_and_events() {
        let run = || {
            let mut world = World::with_seed(73);
            let id = world.spawn(reactive_entity(
                Vec3::new(0.0, 2.0, 0.0),
                fruit_material_fixture(),
                ReactiveState::new(20.0, 0.2, 0.4),
            ));
            world.queue_interaction(Interaction::Impulse {
                target: id,
                impulse: Vec3::new(1.0, 2.0, -0.5),
                point: Vec3::new(0.0, 2.2, 0.0),
            });
            let environment = FlatEnvironment::default();
            let mut reports = Vec::new();
            for turn in 0..180 {
                if turn == 30 {
                    world.queue_interaction(Interaction::Ignite {
                        target: id,
                        energy: 1_400.0,
                    });
                }
                let report = world.step(&environment);
                reports.push((report.tick, report.events, report.transport));
            }
            (world.snapshot(), reports)
        };
        assert_eq!(run(), run());
    }

    #[test]
    fn cutting_fractures_parent_and_releases_falling_fruit() {
        let mut world = World::with_seed(9);
        let mut tree = EntityBundle::new(Transform::from_translation(Vec3::new(0.0, 2.0, 0.0)))
            .named("tree")
            .tagged("tree");
        tree.body = Some(Body::static_body());
        tree.body.as_mut().unwrap().mass = 18.0;
        tree.collider = Some(Collider::CapsuleY {
            radius: 0.35,
            half_height: 2.0,
        });
        tree.structure = Some(Structure::new(2.0, 1.0));
        let tree_id = world.spawn(tree);

        let mut apple = reactive_entity(
            Vec3::ZERO,
            fruit_material_fixture(),
            ReactiveState::new(20.0, 0.35, 0.35),
        )
        .named("apple")
        .tagged("apple");
        apple.attachment = Some(Attachment {
            parent: tree_id,
            local: Transform::from_translation(Vec3::new(0.7, 1.9, 0.1)),
            release_impulse: Vec3::new(0.2, 0.4, 0.0),
        });
        let apple_id = world.spawn(apple);
        let environment = FlatEnvironment::default();
        world.step(&environment);
        world.queue_interaction(Interaction::Cut {
            target: tree_id,
            direction: Vec3::X,
            energy: 1.0,
        });
        assert!(
            !world
                .step(&environment)
                .events
                .iter()
                .any(|event| matches!(event, WorldEvent::Fractured { .. }))
        );
        world.queue_interaction(Interaction::Cut {
            target: tree_id,
            direction: Vec3::X,
            energy: 1.0,
        });
        let report = world.step(&environment);
        assert!(report.events.iter().any(
            |event| matches!(event, WorldEvent::Fractured { entity, .. } if *entity == tree_id)
        ));
        assert!(report.events.iter().any(
            |event| matches!(event, WorldEvent::Detached { entity, parent } if *entity == apple_id && *parent == tree_id)
        ));
        assert!(world.entity(apple_id).unwrap().attachment.is_none());

        let release_y = world.entity(apple_id).unwrap().transform.position.y;
        let mut hit_ground = false;
        for _ in 0..240 {
            let report = world.step(&environment);
            hit_ground |= report.events.iter().any(|event| {
                matches!(event, WorldEvent::Contact(contact) if contact.a == apple_id && contact.b.is_none())
            });
        }
        assert!(world.entity(apple_id).unwrap().transform.position.y < release_y);
        assert!(hit_ground, "released fruit must produce a terrain contact");
    }

    #[test]
    fn moisture_raises_ignition_threshold_without_changing_surface() {
        let mut material = wood_material_fixture();
        material.ignition_temperature_c = 100.0;
        material.heat_capacity = 1.0;
        let mut world = World::with_seed(1);
        let dry = world.spawn(reactive_entity(
            Vec3::new(-8.0, 0.25, 0.0),
            material,
            ReactiveState::new(20.0, 0.0, 1.0),
        ));
        let wet = world.spawn(reactive_entity(
            Vec3::new(8.0, 0.25, 0.0),
            material,
            ReactiveState::new(20.0, 0.8, 1.0),
        ));
        assert_eq!(
            world.entity(dry).unwrap().surface,
            world.entity(wet).unwrap().surface
        );
        for id in [dry, wet] {
            world.queue_interaction(Interaction::Ignite {
                target: id,
                energy: 110.0,
            });
        }
        world.step(&FlatEnvironment::default());
        assert!(world.entity(dry).unwrap().reactive_state.unwrap().burning);
        assert!(!world.entity(wet).unwrap().reactive_state.unwrap().burning);
    }

    #[test]
    fn douse_mixes_sensible_heat_conservatively_for_different_materials_and_water() {
        let cases = [
            (
                wood_material_fixture(),
                WorldConfig {
                    ambient_exchange: 0.0,
                    contact_heat_exchange: 0.0,
                    water_inlet_temperature_c: 12.0,
                    water_specific_heat: 4.18,
                    ..WorldConfig::default()
                },
                ReactiveState::new(82.0, 0.20, 0.0),
                0.35,
            ),
            (
                fruit_material_fixture(),
                WorldConfig {
                    ambient_exchange: 0.0,
                    contact_heat_exchange: 0.0,
                    water_inlet_temperature_c: 31.0,
                    water_specific_heat: 2.65,
                    ..WorldConfig::default()
                },
                ReactiveState::new(67.0, 0.10, 0.0),
                0.45,
            ),
        ];

        for (material, config, state, water_added) in cases {
            let initial_energy = sensible_energy(material, state, config);
            let expected_energy = initial_energy
                + water_added * config.water_specific_heat * config.water_inlet_temperature_c;
            let mut world = World::new(config);
            let id = world.spawn(static_reactive_entity(Vec3::ZERO, material, state));
            world.queue_interaction(Interaction::Douse {
                target: id,
                amount: water_added,
            });
            world.step(&FlatEnvironment::default());

            let final_state = world.entity(id).unwrap().reactive_state.unwrap();
            assert_close(final_state.moisture, state.moisture + water_added, 1e-6);
            assert_close(entity_sensible_energy(&world, id), expected_energy, 1e-3);
        }
    }

    #[test]
    fn contact_exchange_conserves_pair_energy_across_materials() {
        let config = WorldConfig {
            fixed_dt: 0.75,
            gravity: Vec3::ZERO,
            reaction_radius: 0.0,
            ambient_exchange: 0.0,
            contact_heat_exchange: 0.9,
            ..WorldConfig::default()
        };
        let mut world = World::new(config);
        let wood = world.spawn(static_reactive_entity(
            Vec3::ZERO,
            wood_material_fixture(),
            ReactiveState::new(90.0, 0.25, 0.0),
        ));
        let fruit = world.spawn(static_reactive_entity(
            Vec3::new(0.1, 0.0, 0.0),
            fruit_material_fixture(),
            ReactiveState::new(25.0, 0.40, 0.0),
        ));
        let before = entity_sensible_energy(&world, wood) + entity_sensible_energy(&world, fruit);

        world.step(&FlatEnvironment::default());

        let after = entity_sensible_energy(&world, wood) + entity_sensible_energy(&world, fruit);
        assert_close(after, before, 1e-3);
        assert!(
            world
                .entity(wood)
                .unwrap()
                .reactive_state
                .unwrap()
                .temperature_c
                > world
                    .entity(fruit)
                    .unwrap()
                    .reactive_state
                    .unwrap()
                    .temperature_c
        );
    }

    #[test]
    fn evaporation_pays_latent_heat_for_multiple_material_and_water_configs() {
        let cases = [
            (
                wood_material_fixture(),
                WorldConfig {
                    fixed_dt: 1.0,
                    ambient_exchange: 0.0,
                    contact_heat_exchange: 0.0,
                    water_specific_heat: 4.18,
                    water_vaporization_heat: 1_000.0,
                    ..WorldConfig::default()
                },
            ),
            (
                fruit_material_fixture(),
                WorldConfig {
                    fixed_dt: 1.0,
                    ambient_exchange: 0.0,
                    contact_heat_exchange: 0.0,
                    water_specific_heat: 2.5,
                    water_vaporization_heat: 650.0,
                    ..WorldConfig::default()
                },
            ),
        ];

        for (mut material, config) in cases {
            material.drying_rate = 10.0;
            let initial_state = ReactiveState::new(180.0, 0.50, 0.0);
            let initial_energy = sensible_energy(material, initial_state, config);
            let mut world = World::new(config);
            let id = world.spawn(static_reactive_entity(Vec3::ZERO, material, initial_state));

            world.step(&FlatEnvironment::default());

            let final_state = world.entity(id).unwrap().reactive_state.unwrap();
            let evaporated = initial_state.moisture - final_state.moisture;
            assert!(evaporated > 0.0 && final_state.moisture > 0.0);
            assert_close(
                final_state.temperature_c,
                config.water_boiling_temperature_c,
                1e-4,
            );
            let exported = evaporated
                * (config.water_specific_heat * initial_state.temperature_c
                    + config.water_vaporization_heat);
            assert_close(
                entity_sensible_energy(&world, id) + exported,
                initial_energy,
                2e-3,
            );
        }
    }

    #[test]
    fn sufficient_douse_stays_extinguished_without_external_heat() {
        let cases = [
            (
                wood_material_fixture(),
                WorldConfig {
                    water_inlet_temperature_c: 16.0,
                    ..WorldConfig::default()
                },
            ),
            (
                fruit_material_fixture(),
                WorldConfig {
                    water_inlet_temperature_c: 24.0,
                    water_vaporization_heat: 1_800.0,
                    ..WorldConfig::default()
                },
            ),
        ];
        for (material, config) in cases {
            let mut state = ReactiveState::new(650.0, 0.0, 1.0);
            state.burning = true;
            let mut world = World::new(config);
            let id = world.spawn(static_reactive_entity(Vec3::ZERO, material, state));
            world.queue_interaction(Interaction::Douse {
                target: id,
                amount: 1.0,
            });
            let report = world.step(&FlatEnvironment::default());
            assert_eq!(
                report
                    .events
                    .iter()
                    .filter(|event| matches!(event, WorldEvent::Extinguished { entity } if *entity == id))
                    .count(),
                1
            );
            for _ in 0..600 {
                let report = world.step(&FlatEnvironment::default());
                assert!(
                    !report.events.iter().any(
                        |event| matches!(event, WorldEvent::Ignited { entity } if *entity == id)
                    )
                );
            }
            let final_state = world.entity(id).unwrap().reactive_state.unwrap();
            assert!(!final_state.burning);
            assert!(
                final_state.temperature_c
                    < moisture_adjusted_ignition(material, final_state)
                        + config.ignition_temperature_margin_c
            );
        }
    }

    #[test]
    fn external_heat_must_evaporate_water_before_reignition() {
        let config = WorldConfig {
            fixed_dt: 0.1,
            gravity: Vec3::ZERO,
            reaction_radius: 0.0,
            ambient_exchange: 0.0,
            contact_heat_exchange: 0.0,
            water_specific_heat: 4.0,
            water_vaporization_heat: 220.0,
            ignition_temperature_margin_c: 0.0,
            extinction_temperature_margin_c: 10.0,
            ignition_max_moisture: 0.15,
            extinction_min_moisture: 0.30,
            ..WorldConfig::default()
        };
        let mut material = wood_material_fixture();
        material.heat_capacity = 2.0;
        material.ignition_temperature_c = 150.0;
        material.drying_rate = 10.0;
        let mut world = World::new(config);
        let id = world.spawn(static_reactive_entity(
            Vec3::ZERO,
            material,
            ReactiveState::new(20.0, 0.80, 1.0),
        ));

        for _ in 0..20 {
            let report = world.step(&FlatEnvironment::default());
            assert!(
                !report
                    .events
                    .iter()
                    .any(|event| matches!(event, WorldEvent::Ignited { entity } if *entity == id))
            );
        }
        assert_close(
            world.entity(id).unwrap().reactive_state.unwrap().moisture,
            0.80,
            1e-6,
        );

        let mut saw_evaporation = false;
        let mut ignited_state = None;
        for _ in 0..120 {
            let before = world.entity(id).unwrap().reactive_state.unwrap().moisture;
            world.queue_interaction(Interaction::Ignite {
                target: id,
                energy: 40.0,
            });
            let report = world.step(&FlatEnvironment::default());
            let state = world.entity(id).unwrap().reactive_state.unwrap();
            saw_evaporation |= state.moisture < before;
            if report
                .events
                .iter()
                .any(|event| matches!(event, WorldEvent::Ignited { entity } if *entity == id))
            {
                ignited_state = Some(state);
                break;
            }
        }
        let state =
            ignited_state.expect("continued external heat should eventually ignite dry fuel");
        assert!(saw_evaporation);
        assert!(state.moisture <= config.ignition_max_moisture);
        assert!(
            state.temperature_c
                >= moisture_adjusted_ignition(material, state)
                    + config.ignition_temperature_margin_c
        );
    }

    #[test]
    fn fuel_loss_exactly_funds_combustion_energy_with_dry_fraction() {
        let config = WorldConfig {
            fixed_dt: 0.5,
            gravity: Vec3::ZERO,
            reaction_radius: 0.0,
            ambient_exchange: 0.0,
            contact_heat_exchange: 0.0,
            combustion_local_heat_fraction: 1.0,
            ..WorldConfig::default()
        };
        let mut material = wood_material_fixture();
        material.heat_capacity = 2.0;
        material.ignition_temperature_c = 50.0;
        material.burn_rate = 0.20;
        material.heat_output = 1_000.0;
        material.drying_rate = 0.0;
        let mut state = ReactiveState::new(200.0, 0.25, 1.0);
        state.burning = true;
        let mut world = World::new(config);
        let id = world.spawn(static_reactive_entity(Vec3::ZERO, material, state));
        let initial_energy = entity_sensible_energy(&world, id);

        world.step(&FlatEnvironment::default());

        let final_state = world.entity(id).unwrap().reactive_state.unwrap();
        let fuel_consumed = state.fuel - final_state.fuel;
        assert_close(
            fuel_consumed,
            material.burn_rate * 0.75 * config.fixed_dt,
            1e-6,
        );
        assert_close(
            entity_sensible_energy(&world, id) - initial_energy,
            fuel_consumed * material.heat_output,
            2e-3,
        );
    }

    #[test]
    fn spatial_combustion_budget_is_not_duplicated_by_receiver_count() {
        let run = |receiver_count: usize| {
            let config = WorldConfig {
                fixed_dt: 0.5,
                gravity: Vec3::ZERO,
                reaction_radius: 1.0,
                ambient_exchange: 0.0,
                contact_heat_exchange: 0.0,
                combustion_local_heat_fraction: 0.25,
                ..WorldConfig::default()
            };
            let mut source_material = wood_material_fixture();
            source_material.heat_capacity = 2.0;
            source_material.ignition_temperature_c = 50.0;
            source_material.burn_rate = 0.2;
            source_material.heat_output = 1_000.0;
            source_material.drying_rate = 0.0;
            let mut source_state = ReactiveState::new(200.0, 0.0, 1.0);
            source_state.burning = true;
            let mut world = World::new(config);
            let source = world.spawn(static_reactive_entity(
                Vec3::ZERO,
                source_material,
                source_state,
            ));
            let mut receivers = Vec::new();
            for _ in 0..receiver_count {
                let mut receiver_material = fruit_material_fixture();
                receiver_material.ignition_temperature_c = 10_000.0;
                receiver_material.drying_rate = 0.0;
                receivers.push(world.spawn(static_reactive_entity(
                    Vec3::ZERO,
                    receiver_material,
                    ReactiveState::new(20.0, 0.0, 0.0),
                )));
            }
            let source_before = entity_sensible_energy(&world, source);
            let receiver_before: f32 = receivers
                .iter()
                .map(|&id| entity_sensible_energy(&world, id))
                .sum();
            world.step(&FlatEnvironment::default());
            let source_after = entity_sensible_energy(&world, source);
            let receiver_after: f32 = receivers
                .iter()
                .map(|&id| entity_sensible_energy(&world, id))
                .sum();
            let final_source = world.entity(source).unwrap().reactive_state.unwrap();
            let released = (source_state.fuel - final_source.fuel) * source_material.heat_output;
            (
                source_after - source_before,
                receiver_after - receiver_before,
                released,
            )
        };

        let one = run(1);
        let three = run(3);
        let expected_released = 0.2 * 0.5 * 1_000.0;
        assert_close(one.2, expected_released, 1e-3);
        assert_close(three.2, expected_released, 1e-3);
        assert_close(one.0, one.2 * 0.25, 2e-3);
        assert_close(three.0, three.2 * 0.25, 2e-3);
        assert_close(one.1, one.2 * 0.75, 2e-3);
        assert_close(three.1, three.2 * 0.75, 2e-3);
        assert_close(one.1, three.1, 2e-3);
        assert_close(one.0 + one.1, one.2, 3e-3);
        assert_close(three.0 + three.1, three.2, 3e-3);
    }

    #[test]
    fn generic_three_material_cluster_stays_out_after_dousing() {
        let config = WorldConfig::default();
        let materials = [
            flame_material_fixture(),
            wood_material_fixture(),
            fruit_material_fixture(),
        ];
        let mut world = World::new(config);
        let ids: Vec<_> = materials
            .into_iter()
            .enumerate()
            .map(|(index, material)| {
                let mut state = ReactiveState::new(800.0, 0.0, 1.0);
                state.burning = true;
                world.spawn(static_reactive_entity(
                    Vec3::new(index as f32 * 0.3, 0.0, 0.0),
                    material,
                    state,
                ))
            })
            .collect();
        for &id in &ids {
            world.queue_interaction(Interaction::Douse {
                target: id,
                amount: 1.0,
            });
        }
        let report = world.step(&FlatEnvironment::default());
        for &id in &ids {
            assert_eq!(
                report
                    .events
                    .iter()
                    .filter(|event| matches!(event, WorldEvent::Extinguished { entity } if *entity == id))
                    .count(),
                1
            );
        }
        for _ in 0..600 {
            let report = world.step(&FlatEnvironment::default());
            assert!(
                !report
                    .events
                    .iter()
                    .any(|event| matches!(event, WorldEvent::Ignited { .. }))
            );
        }
        assert!(
            ids.iter()
                .all(|&id| { !world.entity(id).unwrap().reactive_state.unwrap().burning })
        );
    }

    #[test]
    fn one_entity_emits_at_most_one_combustion_transition_per_tick() {
        let mut material = wood_material_fixture();
        material.ignition_temperature_c = 100.0;
        let mut state = ReactiveState::new(900.0, 0.0, 1.0);
        state.burning = true;
        let mut world = World::with_seed(17);
        let id = world.spawn(static_reactive_entity(Vec3::ZERO, material, state));
        world.queue_interaction(Interaction::Douse {
            target: id,
            amount: 1.0,
        });

        let report = world.step(&FlatEnvironment::default());
        let transitions: Vec<_> = report
            .events
            .iter()
            .filter(|event| {
                matches!(event, WorldEvent::Ignited { entity } | WorldEvent::Extinguished { entity } if *entity == id)
            })
            .collect();
        assert_eq!(transitions.len(), 1);
        assert!(matches!(transitions[0], WorldEvent::Extinguished { .. }));
        let next = world.step(&FlatEnvironment::default());
        assert!(!next.events.iter().any(|event| {
            matches!(event, WorldEvent::Ignited { entity } | WorldEvent::Extinguished { entity } if *entity == id)
        }));
    }

    #[test]
    fn flame_spreads_then_water_extinguishes() {
        let mut world = World::with_seed(2);
        let mut flame = reactive_entity(
            Vec3::new(0.0, 0.25, 0.0),
            flame_material_fixture(),
            ReactiveState::new(720.0, 0.0, 1.0),
        );
        flame.reactive_state.as_mut().unwrap().burning = true;
        flame.body = Some(Body::static_body());
        world.spawn(flame);
        let mut wood_material = wood_material_fixture();
        wood_material.ignition_temperature_c = 145.0;
        let wood = world.spawn(reactive_entity(
            Vec3::new(0.75, 0.25, 0.0),
            wood_material,
            ReactiveState::new(20.0, 0.0, 1.0),
        ));
        let environment = FlatEnvironment::default();
        let mut ignited = false;
        for _ in 0..180 {
            let report = world.step(&environment);
            ignited |= report
                .events
                .iter()
                .any(|event| matches!(event, WorldEvent::Ignited { entity } if *entity == wood));
            if ignited {
                break;
            }
        }
        assert!(ignited, "nearby dry fuel should ignite from spatial heat");
        world.queue_interaction(Interaction::Douse {
            target: wood,
            amount: 1.0,
        });
        let report = world.step(&environment);
        assert!(
            report.events.iter().any(
                |event| matches!(event, WorldEvent::Extinguished { entity } if *entity == wood)
            )
        );
        assert!(!world.entity(wood).unwrap().reactive_state.unwrap().burning);
    }

    #[test]
    fn snapshot_restore_recovers_exact_state() {
        let mut world = World::with_seed(55);
        world.spawn(reactive_entity(
            Vec3::new(0.0, 1.0, 0.0),
            fruit_material_fixture(),
            ReactiveState::new(20.0, 0.2, 0.3),
        ));
        let environment = FlatEnvironment::default();
        for _ in 0..12 {
            world.step(&environment);
        }
        let snapshot = world.snapshot();
        let expected = world.snapshot();
        for _ in 0..10 {
            world.step(&environment);
        }
        assert_ne!(world.snapshot(), expected);
        world.restore(snapshot);
        assert_eq!(world.snapshot(), expected);
    }

    #[test]
    fn segment_solver_handles_spheres_and_crossed_capsules() {
        assert_eq!(
            closest_segment_points(Vec3::ZERO, Vec3::ZERO, Vec3::X, Vec3::X),
            (Vec3::ZERO, Vec3::X)
        );
        let (a, b) = closest_segment_points(-Vec3::X, Vec3::X, -Vec3::Y, Vec3::Y);
        assert!(a.length() < 1e-5 && b.length() < 1e-5);
    }

    #[test]
    fn terrain_contact_applies_structural_damage_once() {
        let config = WorldConfig {
            gravity: Vec3::ZERO,
            ..WorldConfig::default()
        };
        let mut world = World::new(config);
        let mut bundle = EntityBundle::new(Transform::from_translation(Vec3::new(0.0, 0.4, 0.0)));
        let mut body = Body::dynamic(1.0);
        body.linear_velocity = -Vec3::Y;
        body.linear_damping = 0.0;
        bundle.body = Some(body);
        bundle.collider = Some(Collider::Sphere { radius: 0.5 });
        bundle.surface.restitution = 0.0;
        let mut structure = Structure::new(10.0, 1.0);
        structure.impact_threshold = 0.0;
        structure.impact_damage_scale = 1.0;
        bundle.structure = Some(structure);
        let id = world.spawn(bundle);

        let report = world.step(&FlatEnvironment::default());
        let impulse = report
            .events
            .iter()
            .find_map(|event| match event {
                WorldEvent::Contact(contact) if contact.a == id && contact.b.is_none() => {
                    Some(contact.impulse)
                }
                _ => None,
            })
            .expect("penetrating body should contact terrain");
        let integrity = world.entity(id).unwrap().structure.unwrap().integrity;
        assert!((integrity - (10.0 - impulse)).abs() < 1e-5);
    }

    #[test]
    fn zero_or_invalid_douse_does_not_extinguish_a_fire() {
        for amount in [0.0, -1.0, f32::NAN] {
            let mut world = World::with_seed(3);
            let mut material = wood_material_fixture();
            material.ignition_temperature_c = 100.0;
            let mut state = ReactiveState::new(400.0, 0.0, 1.0);
            state.burning = true;
            let id = world.spawn(reactive_entity(Vec3::ZERO, material, state));
            world.queue_interaction(Interaction::Douse { target: id, amount });

            let report = world.step(&FlatEnvironment::default());
            assert!(world.entity(id).unwrap().reactive_state.unwrap().burning);
            assert!(!report.events.iter().any(
                |event| matches!(event, WorldEvent::Extinguished { entity } if *entity == id)
            ));
        }
    }

    #[test]
    fn detached_body_wakes_when_parent_is_removed_or_missing() {
        let mut world = World::with_seed(5);
        let parent = world.spawn(EntityBundle::default());
        let mut attached = EntityBundle {
            body: Some(Body::dynamic(1.0)),
            ..EntityBundle::default()
        };
        attached.body.as_mut().unwrap().sleeping = true;
        attached.attachment = Some(Attachment {
            parent,
            local: Transform::IDENTITY,
            release_impulse: Vec3::ZERO,
        });
        let child = world.spawn(attached);
        world.remove(parent);
        let child_entity = world.entity(child).unwrap();
        assert!(child_entity.attachment.is_none());
        assert!(!child_entity.body.unwrap().sleeping);

        let mut missing_parent = EntityBundle {
            body: Some(Body::dynamic(1.0)),
            ..EntityBundle::default()
        };
        missing_parent.body.as_mut().unwrap().sleeping = true;
        missing_parent.attachment = Some(Attachment {
            parent: EntityId(999),
            local: Transform::IDENTITY,
            release_impulse: Vec3::ZERO,
        });
        let orphan = world.spawn(missing_parent);
        world.step(&FlatEnvironment::default());
        let orphan_entity = world.entity(orphan).unwrap();
        assert!(orphan_entity.attachment.is_none());
        assert!(!orphan_entity.body.unwrap().sleeping);
    }

    #[test]
    fn attachment_tracks_parent_after_same_turn_integration() {
        let config = WorldConfig {
            gravity: Vec3::ZERO,
            ..WorldConfig::default()
        };
        let dt = config.fixed_dt;
        let mut world = World::new(config);
        let mut parent_bundle = EntityBundle::default();
        let mut parent_body = Body::dynamic(1.0);
        parent_body.linear_velocity = Vec3::X;
        parent_body.linear_damping = 0.0;
        parent_bundle.body = Some(parent_body);
        let parent = world.spawn(parent_bundle);

        let child_bundle = EntityBundle {
            body: Some(Body::dynamic(1.0)),
            attachment: Some(Attachment {
                parent,
                local: Transform::from_translation(Vec3::Y),
                release_impulse: Vec3::ZERO,
            }),
            ..EntityBundle::default()
        };
        let child = world.spawn(child_bundle);

        world.step(&FlatEnvironment::default());
        assert_eq!(world.entity(parent).unwrap().transform.position.x, dt);
        assert_eq!(world.entity(child).unwrap().transform.position.x, dt);
        assert_eq!(
            world.entity(child).unwrap().body.unwrap().linear_velocity,
            Vec3::X
        );
    }

    #[test]
    fn static_body_velocity_does_not_inject_pair_collision_energy() {
        let config = WorldConfig {
            gravity: Vec3::ZERO,
            ..WorldConfig::default()
        };
        let mut world = World::new(config);
        let mut wall = EntityBundle::new(Transform::from_translation(Vec3::new(0.0, 5.0, 0.0)));
        let mut wall_body = Body::static_body();
        wall_body.linear_velocity = Vec3::X * 100.0;
        wall.body = Some(wall_body);
        wall.collider = Some(Collider::Sphere { radius: 0.5 });
        world.spawn(wall);

        let mut ball = EntityBundle::new(Transform::from_translation(Vec3::new(0.9, 5.0, 0.0)));
        let mut ball_body = Body::dynamic(1.0);
        ball_body.linear_damping = 0.0;
        ball.body = Some(ball_body);
        ball.collider = Some(Collider::Sphere { radius: 0.5 });
        let ball_id = world.spawn(ball);

        world.step(&FlatEnvironment::default());
        assert_eq!(
            world.entity(ball_id).unwrap().body.unwrap().linear_velocity,
            Vec3::ZERO
        );
    }

    #[test]
    fn pair_contact_friction_reduces_tangential_velocity() {
        let config = WorldConfig {
            gravity: Vec3::ZERO,
            ..WorldConfig::default()
        };
        let mut world = World::new(config);
        let mut wall = EntityBundle::new(Transform::from_translation(Vec3::new(0.0, 5.0, 0.0)));
        wall.body = Some(Body::static_body());
        wall.collider = Some(Collider::Sphere { radius: 0.5 });
        wall.surface.friction = 1.0;
        wall.surface.restitution = 0.0;
        world.spawn(wall);

        let mut ball = EntityBundle::new(Transform::from_translation(Vec3::new(0.9, 5.0, 0.0)));
        let mut ball_body = Body::dynamic(1.0);
        ball_body.linear_velocity = Vec3::new(-2.0, 0.0, 1.0);
        ball_body.linear_damping = 0.0;
        ball.body = Some(ball_body);
        ball.collider = Some(Collider::Sphere { radius: 0.5 });
        ball.surface.friction = 1.0;
        ball.surface.restitution = 0.0;
        let ball_id = world.spawn(ball);

        world.step(&FlatEnvironment::default());
        let velocity = world.entity(ball_id).unwrap().body.unwrap().linear_velocity;
        assert!(velocity.x.abs() < 1e-5);
        assert!(velocity.z.abs() < 1e-5);
    }

    #[test]
    fn reaction_distance_uses_capsule_extent_instead_of_only_its_center() {
        let config = WorldConfig {
            fixed_dt: 1.0,
            gravity: Vec3::ZERO,
            reaction_radius: 0.5,
            ambient_exchange: 0.0,
            contact_heat_exchange: 0.0,
            ..WorldConfig::default()
        };
        let mut world = World::new(config);

        let mut flame_material = flame_material_fixture();
        flame_material.burn_rate = 0.1;
        let mut flame_state = ReactiveState::new(720.0, 0.0, 1.0);
        flame_state.burning = true;
        let mut flame = reactive_entity(Vec3::ZERO, flame_material, flame_state);
        flame.body = Some(Body::static_body());
        flame.collider = Some(Collider::CapsuleY {
            radius: 0.25,
            half_height: 5.0,
        });
        flame.transform.rotation = Quat::from_rotation_z(std::f32::consts::FRAC_PI_2);
        world.spawn(flame);

        let mut wood_material = wood_material_fixture();
        wood_material.ignition_temperature_c = 50.0;
        wood_material.heat_capacity = 1.0;
        let target = world.spawn(reactive_entity(
            Vec3::new(5.5, 0.0, 0.0),
            wood_material,
            ReactiveState::new(20.0, 0.0, 1.0),
        ));

        let report = world.step(&FlatEnvironment::default());
        assert!(
            world
                .entity(target)
                .unwrap()
                .reactive_state
                .unwrap()
                .burning
        );
        assert!(
            report
                .events
                .iter()
                .any(|event| matches!(event, WorldEvent::Ignited { entity } if *entity == target))
        );
    }

    #[test]
    fn restore_reconciles_public_snapshot_entity_ids_with_map_keys() {
        let mut world = World::with_seed(6);
        let id = world.spawn(EntityBundle::default());
        let mut snapshot = world.snapshot();
        snapshot.entities.get_mut(&id).unwrap().id = EntityId(999);
        world.restore(snapshot);
        assert_eq!(world.entity(id).unwrap().id, id);
    }
}
