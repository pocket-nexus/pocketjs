//! The valley's shape: one analytic height field carved by the river, plus the
//! queries every other generator asks of it.
//!
//! Keeping the terrain analytic rather than a stored grid means vegetation,
//! props and the camera can all sample the exact surface at any point, and the
//! mesh resolution becomes a cooking decision instead of a data format.

use glam::Vec3;

use crate::noise::{fbm, ridged, value};

/// Water sits at y = 0; everything else is measured from it.
pub const WATER_LEVEL: f32 = 0.0;

/// The corridor the scene occupies, in metres.
pub const Z_NEAR: f32 = 260.0;
pub const Z_FAR: f32 = -1720.0;
pub const X_HALF: f32 = 900.0;

/// Smooth 0..1 ramp between two edges.
pub fn smoothstep(edge0: f32, edge1: f32, value: f32) -> f32 {
    if (edge1 - edge0).abs() < 1e-6 {
        return if value < edge0 { 0.0 } else { 1.0 };
    }
    let t = ((value - edge0) / (edge1 - edge0)).clamp(0.0, 1.0);
    t * t * (3.0 - 2.0 * t)
}

pub fn mix(a: f32, b: f32, t: f32) -> f32 {
    a + (b - a) * t
}

/// A circular pad that flattens the ground, for a terrace or a jetty.
#[derive(Clone, Copy, Debug)]
pub struct Pad {
    pub center: Vec3,
    pub radius: f32,
    pub falloff: f32,
}

#[derive(Clone, Debug)]
pub struct Valley {
    pub seed: u32,
    pads: Vec<Pad>,
}

impl Valley {
    pub fn new(seed: u32) -> Self {
        Self {
            seed,
            pads: Vec::new(),
        }
    }

    /// Level the ground inside `pad` before any geometry samples the field.
    pub fn add_pad(&mut self, pad: Pad) {
        self.pads.push(pad);
    }

    pub fn pads(&self) -> &[Pad] {
        &self.pads
    }

    /// Centre line of the river at `z`. Two incommensurate meanders plus a
    /// slow drift keep the channel from ever repeating inside the corridor.
    pub fn river_x(&self, z: f32) -> f32 {
        let slow = (z * 0.0041).sin() * 46.0;
        let fast = (z * 0.0127 + 1.7).sin() * 17.0;
        let drift = (z * 0.0009 - 0.6).sin() * 30.0;
        let wander = (fbm(z * 0.004, 11.0, 3, self.seed ^ 0x51ed) - 0.5) * 26.0;
        slow + fast + drift + wander
    }

    /// Half the water's width at `z`. The channel narrows where the valley
    /// pinches and opens into a slow pool near the viewer's start.
    pub fn river_half_width(&self, z: f32) -> f32 {
        let base = 15.5 + (z * 0.0068 + 0.4).sin() * 4.2;
        let pinch = smoothstep(-560.0, -430.0, z) * smoothstep(-300.0, -420.0, z);
        let pool = smoothstep(40.0, 220.0, z) * 5.0;
        (base - pinch * 4.5 + pool).max(7.0)
    }

    /// Depth of the channel below the water line at `z`.
    pub fn river_depth(&self, z: f32) -> f32 {
        2.6 + (z * 0.0053 + 2.1).sin() * 0.7
    }

    /// Lateral distance from the centre line, and which bank the point is on.
    pub fn river_offset(&self, x: f32, z: f32) -> (f32, f32) {
        let center = self.river_x(z);
        let delta = x - center;
        (delta.abs(), if delta >= 0.0 { 1.0 } else { -1.0 })
    }

    /// Distance beyond the water's edge. Negative inside the channel.
    pub fn shore_distance(&self, x: f32, z: f32) -> f32 {
        let (distance, _) = self.river_offset(x, z);
        distance - self.river_half_width(z)
    }

    /// Where the valley wall starts to climb, on a given bank at `z`.
    fn wall_onset(&self, z: f32, side: f32) -> f32 {
        let key = if side > 0.0 { 3.0 } else { 71.0 };
        let base = if side > 0.0 { 96.0 } else { 74.0 };
        base + fbm(z * 0.0032, key, 3, self.seed ^ 0x2b19) * 130.0
    }

    /// How high that bank's ridge reaches.
    fn ridge_height(&self, z: f32, side: f32) -> f32 {
        let key = if side > 0.0 { 17.0 } else { 53.0 };
        let sweep = 170.0 + fbm(z * 0.0021, key, 4, self.seed ^ 0x7c2d) * 210.0;
        // The far half of the corridor stands taller, so the valley closes in
        // towards the horizon instead of running out flat.
        sweep * mix(1.0, 1.45, smoothstep(0.0, -1500.0, z))
    }

    /// Surface height at a world point, before pads.
    fn base_height(&self, x: f32, z: f32) -> f32 {
        let (distance, side) = self.river_offset(x, z);
        let half_width = self.river_half_width(z);
        let beyond = distance - half_width;

        if beyond < 0.0 {
            // Parabolic channel, with a rippled bed so the shallows read.
            let across = (distance / half_width.max(1e-3)).clamp(0.0, 1.0);
            let depth = self.river_depth(z) * (1.0 - across * across).powf(0.75);
            let bed = (value(x * 0.09, z * 0.09, self.seed ^ 0x9a1) - 0.5) * 0.35;
            return WATER_LEVEL - depth + bed * (1.0 - across);
        }

        // Beach, then floodplain, then the wall.
        let beach = 1.55 * smoothstep(0.0, 11.0, beyond);
        let plain = 0.030 * beyond;
        let onset = self.wall_onset(z, side);
        let climb = smoothstep(onset, onset + 300.0, beyond).powf(1.25);
        let wall = self.ridge_height(z, side) * climb;

        // Ridged noise only bites once the wall is under way, so the
        // floodplain stays walkable and the skyline stays broken.
        let crest = ridged(x * 0.0034, z * 0.0030, 5, self.seed ^ 0x40f7);
        let crest_gain = 120.0 * smoothstep(onset + 40.0, onset + 420.0, beyond);
        let rolling = (fbm(x * 0.0125, z * 0.0125, 4, self.seed ^ 0x1d33) - 0.5)
            * (2.2 + 16.0 * smoothstep(onset * 0.5, onset + 260.0, beyond));
        let grain = (fbm(x * 0.075, z * 0.075, 3, self.seed ^ 0x6e11) - 0.5) * 0.9;

        beach + plain + wall + crest * crest_gain + rolling + grain
    }

    /// Surface height at a world point.
    pub fn height(&self, x: f32, z: f32) -> f32 {
        let mut height = self.base_height(x, z);
        for pad in &self.pads {
            let distance = Vec3::new(x - pad.center.x, 0.0, z - pad.center.z).length();
            let inside = 1.0 - smoothstep(pad.radius, pad.radius + pad.falloff, distance);
            if inside > 0.0 {
                height = mix(height, pad.center.y, inside);
            }
        }
        height
    }

    /// Central-difference normal, in world space.
    pub fn normal(&self, x: f32, z: f32) -> Vec3 {
        let step = 1.25;
        let dx = self.height(x + step, z) - self.height(x - step, z);
        let dz = self.height(x, z + step) - self.height(x, z - step);
        Vec3::new(-dx, 2.0 * step, -dz).normalize()
    }

    /// How exposed a point is to the sky, from the local slope and how deeply
    /// it sits below its surroundings. Cheap, and enough to seat vegetation
    /// and buildings into the ground instead of floating them on it.
    pub fn ambient_occlusion(&self, x: f32, z: f32) -> f32 {
        let here = self.height(x, z);
        let mut open = 0.0f32;
        let mut samples = 0.0f32;
        for step in [4.0f32, 12.0, 30.0] {
            for (dx, dz) in [
                (1.0f32, 0.0f32),
                (-1.0, 0.0),
                (0.0, 1.0),
                (0.0, -1.0),
                (0.7, 0.7),
                (-0.7, 0.7),
                (0.7, -0.7),
                (-0.7, -0.7),
            ] {
                let neighbour = self.height(x + dx * step, z + dz * step);
                // Rising ground nearby closes the sky; falling ground opens it.
                open += 1.0 - smoothstep(0.0, step * 0.9, neighbour - here);
                samples += 1.0;
            }
        }
        (open / samples.max(1.0)).clamp(0.0, 1.0).powf(0.7)
    }

    /// March towards the sun and report whether the ridge line blocks it.
    ///
    /// Sixteen steps over 420 m is coarse, but a valley's shadowing is a large
    /// feature: what this catches is the far bank's shoulder falling across the
    /// water, which is exactly what makes the light read as late afternoon.
    pub fn sun_shadow(&self, x: f32, z: f32, sun_dir: Vec3) -> f32 {
        let here = self.height(x, z) + 0.35;
        if sun_dir.y <= 0.02 {
            return 0.0;
        }
        let mut blocked = 0.0f32;
        let mut distance = 3.0f32;
        for _ in 0..16 {
            let sample = Vec3::new(x, here, z) + sun_dir * distance;
            let ground = self.height(sample.x, sample.z);
            if ground > sample.y {
                // Soften with the overshoot so the shadow edge is not a step.
                blocked = blocked.max(smoothstep(0.0, 6.0, ground - sample.y));
            }
            distance *= 1.42;
            if distance > 420.0 {
                break;
            }
        }
        (1.0 - blocked).clamp(0.0, 1.0)
    }

    /// Wetness near the waterline, used to darken the shore texture blend.
    pub fn wetness(&self, x: f32, z: f32) -> f32 {
        let height = self.height(x, z);
        1.0 - smoothstep(0.0, 1.1, height - WATER_LEVEL)
    }

    /// Ground cover weight in `0..1`: 0 is bare rock, 1 is deep meadow.
    pub fn meadow(&self, x: f32, z: f32) -> f32 {
        let slope = self.normal(x, z).y;
        let height = self.height(x, z);
        let flat = smoothstep(0.62, 0.92, slope);
        let low = 1.0 - smoothstep(60.0, 190.0, height);
        let patch = fbm(x * 0.006, z * 0.006, 3, self.seed ^ 0x33aa);
        (flat * low * (0.55 + 0.75 * patch)).clamp(0.0, 1.0)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn valley() -> Valley {
        Valley::new(0xA11E)
    }

    #[test]
    fn the_channel_is_below_the_water_line_and_the_banks_are_above_it() {
        let valley = valley();
        for z in [-1400.0f32, -900.0, -300.0, 0.0, 200.0] {
            let center = valley.river_x(z);
            assert!(valley.height(center, z) < WATER_LEVEL - 1.0, "z={z}");
            let width = valley.river_half_width(z);
            assert!(
                valley.height(center + width + 30.0, z) > WATER_LEVEL,
                "right bank at z={z}"
            );
            assert!(
                valley.height(center - width - 30.0, z) > WATER_LEVEL,
                "left bank at z={z}"
            );
        }
    }

    #[test]
    fn the_valley_walls_rise_well_above_the_floodplain() {
        let valley = valley();
        for z in [-1500.0f32, -800.0, -100.0] {
            let center = valley.river_x(z);
            let floor = valley.height(center + 60.0, z);
            let wall = valley.height(center + 640.0, z);
            assert!(wall > floor + 80.0, "z={z}: floor {floor}, wall {wall}");
        }
    }

    #[test]
    fn a_pad_levels_the_ground_it_covers() {
        let mut valley = valley();
        let z = -240.0;
        let x = valley.river_x(z) + 120.0;
        let pad = Pad {
            center: Vec3::new(x, 14.0, z),
            radius: 20.0,
            falloff: 14.0,
        };
        valley.add_pad(pad);
        assert!((valley.height(x, z) - 14.0).abs() < 1e-3);
        assert!((valley.height(x + 12.0, z) - 14.0).abs() < 0.2);
        // Well outside the falloff the field is untouched.
        let far = valley.height(x + 200.0, z);
        let without = Valley::new(0xA11E).height(x + 200.0, z);
        assert!((far - without).abs() < 1e-3);
    }

    #[test]
    fn normals_point_up_on_the_floodplain() {
        let valley = valley();
        let z = -120.0;
        let x = valley.river_x(z) + 45.0;
        assert!(valley.normal(x, z).y > 0.85);
    }

    #[test]
    fn ground_at_the_foot_of_a_rise_is_less_exposed_than_open_ground() {
        let z = -700.0;
        let mut valley = valley();
        let center = valley.river_x(z);
        let open = center + 60.0;
        let exposed = valley.ambient_occlusion(open, z);
        // A plateau raised beside the sample point closes part of its sky.
        valley.add_pad(Pad {
            center: Vec3::new(open + 26.0, valley.height(open, z) + 30.0, z),
            radius: 20.0,
            falloff: 6.0,
        });
        let shadowed = valley.ambient_occlusion(open, z);
        assert!(shadowed < exposed, "{shadowed} vs {exposed}");
    }

    #[test]
    fn the_shadow_term_stays_inside_its_range() {
        let valley = valley();
        let sun = Vec3::new(0.42, 0.26, -0.87).normalize();
        for step in 0..120 {
            let z = -1500.0 + step as f32 * 14.0;
            let x = valley.river_x(z) + (step as f32 * 7.0) % 400.0 - 200.0;
            let shadow = valley.sun_shadow(x, z, sun);
            assert!((0.0..=1.0).contains(&shadow), "{shadow}");
        }
    }
}
