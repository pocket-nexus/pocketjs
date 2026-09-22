//! Entity lump: a text blob of `{ "key" "value" ... }` blocks.

use std::collections::HashMap;

use glam::Vec3;

use crate::types::{SunLight, q2y};

#[derive(Clone, Debug, Default)]
pub struct Entity {
    pub kv: HashMap<String, String>,
}

impl Entity {
    pub fn get(&self, key: &str) -> Option<&str> {
        self.kv.get(key).map(String::as_str)
    }

    pub fn classname(&self) -> &str {
        self.get("classname").unwrap_or("")
    }

    /// Origin converted to Y-up space.
    pub fn origin(&self) -> Option<Vec3> {
        let raw = self.get("origin")?;
        let mut it = raw.split_ascii_whitespace().map(|s| s.parse::<f32>());
        let x = it.next()?.ok()?;
        let y = it.next()?.ok()?;
        let z = it.next()?.ok()?;
        Some(q2y(Vec3::new(x, y, z)))
    }

    /// Quake yaw in degrees (key "angle", or the second component of
    /// "angles"), converted to a Pocket3D camera yaw in radians.
    pub fn yaw(&self) -> Option<f32> {
        let deg = if let Some(a) = self.get("angle") {
            a.parse::<f32>().ok()?
        } else {
            let angles = self.get("angles")?;
            angles
                .split_ascii_whitespace()
                .nth(1)?
                .parse::<f32>()
                .ok()?
        };
        Some(quake_yaw_to_pocket(deg))
    }

    /// The `*N` brush-model index this entity points at, if any.
    pub fn brush_model(&self) -> Option<usize> {
        let m = self.get("model")?;
        m.strip_prefix('*')?.parse().ok()
    }
}

/// Quake yaw (degrees CCW from +X east, around +Z up) to Pocket3D yaw
/// (radians around +Y, 0 = -Z).
pub fn quake_yaw_to_pocket(deg: f32) -> f32 {
    let rad = deg.to_radians();
    (-rad.cos()).atan2(rad.sin())
}

/// A brush model reference: (model index, world offset).
pub type BrushModelRef = (usize, Vec3);

/// How brush-model entities enter the map: `(include, solids)` — models to
/// bake into render geometry (with world offset) and models registered for
/// collision. Model 0 (worldspawn) is always included.
pub fn brush_entity_layout(
    ents: &[Entity],
    model_count: usize,
) -> (Vec<BrushModelRef>, Vec<BrushModelRef>) {
    let mut include: Vec<BrushModelRef> = vec![(0, Vec3::ZERO)];
    let mut solids: Vec<BrushModelRef> = Vec::new();
    for e in ents {
        let Some(mi) = e.brush_model() else { continue };
        if mi == 0 || mi >= model_count {
            continue;
        }
        let cls = e.classname();
        let hidden = cls.starts_with("trigger")
            || matches!(
                cls,
                "func_buyzone"
                    | "func_bomb_target"
                    | "func_hostage_rescue"
                    | "func_escapezone"
                    | "func_vip_safetyzone"
                    | "func_ladder"
                    | "env_bubbles"
            );
        let offset = e.origin().unwrap_or(Vec3::ZERO);
        if !hidden {
            include.push((mi, offset));
        }
        if !hidden && cls != "func_illusionary" {
            solids.push((mi, offset));
        }
    }
    (include, solids)
}

/// Interpret a `light_environment` entity as a directional sun.
pub fn parse_sun(e: &Entity) -> Option<SunLight> {
    // Light travel direction in Quake space from pitch/yaw; pitch usually
    // negative (downwards). "pitch" overrides angles[0] when present.
    let angles = e.get("angles").unwrap_or("0 0 0");
    let mut it = angles
        .split_ascii_whitespace()
        .map(|v| v.parse::<f32>().unwrap_or(0.0));
    let mut pitch = it.next().unwrap_or(0.0);
    let yaw = it.next().unwrap_or(0.0);
    if let Some(p) = e.get("pitch").and_then(|p| p.parse::<f32>().ok()) {
        pitch = p;
    }
    let (pr, yr) = (pitch.to_radians(), yaw.to_radians());
    let travel_q = Vec3::new(pr.cos() * yr.cos(), pr.cos() * yr.sin(), pr.sin());
    let dir = q2y(-travel_q).normalize_or_zero();

    let color = e
        .get("_light")
        .map(|l| {
            let v: Vec<f32> = l
                .split_ascii_whitespace()
                .filter_map(|x| x.parse().ok())
                .collect();
            match v.len() {
                0 => Vec3::ONE,
                1 | 2 => Vec3::splat(v[0] / 255.0),
                _ => Vec3::new(v[0], v[1], v[2]) / 255.0,
            }
        })
        .unwrap_or(Vec3::ONE);
    if dir.y <= 0.0 {
        // Sun below the horizon — treat as absent.
        return None;
    }
    Some(SunLight { dir, color })
}

pub fn parse_entities(text: &str) -> Vec<Entity> {
    let mut out = Vec::new();
    let mut chars = text.chars().peekable();
    while let Some(c) = chars.next() {
        if c != '{' {
            continue;
        }
        let mut ent = Entity::default();
        loop {
            // Scan to a quote, a closing brace, or EOF.
            let mut key = None;
            loop {
                match chars.next() {
                    Some('"') => {
                        let mut s = String::new();
                        for q in chars.by_ref() {
                            if q == '"' {
                                break;
                            }
                            s.push(q);
                        }
                        key = Some(s);
                        break;
                    }
                    Some('}') | None => break,
                    Some(_) => {}
                }
            }
            let Some(key) = key else { break };
            // Value string.
            let mut value = String::new();
            let mut in_value = false;
            for q in chars.by_ref() {
                if q == '"' {
                    if in_value {
                        break;
                    }
                    in_value = true;
                } else if in_value {
                    value.push(q);
                }
            }
            ent.kv.insert(key, value);
        }
        if !ent.kv.is_empty() {
            out.push(ent);
        }
    }
    out
}

/// Optional worldspawn colors; both must be present to avoid partial presets.
pub fn parse_sky(entity: &Entity) -> Result<Option<crate::types::SkyColors>, &'static str> {
    let a = entity.get("pocket_sky_zenith");
    let b = entity.get("pocket_sky_horizon");
    if a.is_none() && b.is_none() {
        return Ok(None);
    }
    let color = |text: Option<&str>| -> Result<Vec3, &'static str> {
        let values = text
            .ok_or("both sky colors required")?
            .split_whitespace()
            .map(str::parse::<f32>)
            .collect::<Result<Vec<_>, _>>()
            .map_err(|_| "invalid sky color")?;
        if values.len() != 3
            || values
                .iter()
                .any(|v| !v.is_finite() || !(0.0..=1.0).contains(v))
        {
            return Err("sky colors require three finite channels in [0,1]");
        }
        Ok(Vec3::new(values[0], values[1], values[2]))
    };
    Ok(Some(crate::types::SkyColors {
        zenith: color(a)?,
        horizon: color(b)?,
    }))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_blocks() {
        let src = r#"
{
"classname" "worldspawn"
"wad" "\half-life\cstrike\cs_dust.wad;\half-life\valve\halflife.wad"
}
{
"classname" "info_player_start"
"origin" "160 -96 64"
"angle" "90"
}
"#;
        let ents = parse_entities(src);
        assert_eq!(ents.len(), 2);
        assert_eq!(ents[0].classname(), "worldspawn");
        let spawn = &ents[1];
        // Quake (160, -96, 64) -> Y-up (160, 64, 96).
        assert_eq!(spawn.origin(), Some(Vec3::new(160.0, 64.0, 96.0)));
        // Quake yaw 90 deg = +Y north -> Y-up -Z, which is pocket yaw 0.
        let yaw = spawn.yaw().unwrap();
        assert!(yaw.abs() < 1e-5, "yaw was {yaw}");
    }
}
