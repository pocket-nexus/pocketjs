//! Authored device loading and model-independent interaction proxies for the
//! first Pocket Stage package.
//!
//! The visual shell is a pair of cooked glTF LODs. Model-specific facts live
//! in a JSON profile: orientation/scale, semantic screen material, and CPU-only
//! picking boxes. The runtime never relies on primitive indices or authoring
//! node names, so another device can reuse this code with another profile.

use std::collections::HashSet;
use std::path::{Path, PathBuf};
use std::sync::Arc;

use anyhow::{Context, Result, anyhow, ensure};
use glam::{EulerRot, Mat4, Quat, Vec3};
use pocket_widget::parts::{PartMap, PartShape, btn};
use pocket3d::gpu::Gpu;
use pocket3d::model::{
    MaterialTextureOverride, ModelAsset, ModelInstance, ModelLoadOptions, ModelTextureCache,
};
use pocket3d::renderer::Renderer;
use pocket3d::scene::Scene;
use pocket3d::texture::create_rgba_texture;
use serde::Deserialize;

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
struct DeviceProfile {
    schema_version: u32,
    name: String,
    attribution: String,
    lods: LodProfile,
    target_width_mm: f32,
    rotation_degrees: [f32; 3],
    screen: ScreenProfile,
    #[serde(default)]
    suppressed_materials: Vec<MaterialProfile>,
    parts: Vec<PartProfile>,
    display: DisplayProfile,
    view: ViewProfile,
    #[serde(default)]
    rotary: Option<RotaryProfile>,
}

/// Every package states its own display facts; the runtime carries no
/// model-shaped defaults (a missing block is a package-authoring error).
#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
struct DisplayProfile {
    logical_size: [u32; 2],
    raster_density: u32,
    window_size: [u32; 2],
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
struct ViewProfile {
    desk_position_mm: [f32; 3],
    #[serde(default)]
    desk_target_mm: [f32; 3],
    focus_distance_mm: f32,
    fov_y_degrees: f32,
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
struct RotaryProfile {
    adapter: String,
    name: String,
    center_mm: [f32; 3],
    inner_radius_mm: f32,
    outer_radius_mm: f32,
    step_degrees: f32,
    clockwise_button: String,
    counterclockwise_button: String,
    #[serde(default)]
    sectors: Vec<RotarySectorProfile>,
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
struct RotarySectorProfile {
    name: String,
    center_degrees: f32,
    half_width_degrees: f32,
    button: String,
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
struct LodProfile {
    settled: String,
    orbit: String,
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
struct ScreenProfile {
    material_role: String,
    material_name_prefix: String,
    expected_primitives: usize,
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
struct MaterialProfile {
    material_role: String,
    material_name_prefix: String,
    expected_primitives: usize,
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
struct PartProfile {
    name: String,
    #[serde(default)]
    button: Option<String>,
    center_mm: [f32; 3],
    half_extents_mm: [f32; 3],
    #[serde(default)]
    rotation_degrees: [f32; 3],
}

#[derive(Clone, Debug)]
pub struct ViewSettings {
    pub desk_position: Vec3,
    pub desk_target: Vec3,
    pub focus_distance: f32,
    pub fov_y: f32,
}

#[derive(Clone, Debug)]
pub struct StageSettings {
    pub logical_size: (u32, u32),
    pub raster_density: u32,
    pub physical_size: (u32, u32),
    pub window_size: (u32, u32),
    pub view: ViewSettings,
}

#[derive(Clone, Debug)]
pub struct RotarySector {
    pub name: String,
    pub center_radians: f32,
    pub half_width_radians: f32,
    pub buttons: u32,
}

#[derive(Clone, Debug)]
pub struct RotaryControl {
    pub name: String,
    pub center: Vec3,
    pub inner_radius: f32,
    pub outer_radius: f32,
    pub step_radians: f32,
    pub clockwise_buttons: u32,
    pub counterclockwise_buttons: u32,
    pub sectors: Vec<RotarySector>,
}

impl RotaryControl {
    /// Angle around the canonical XY wheel plane. Stage packages normalize
    /// authored controls into this plane, just as they normalize model scale.
    pub fn angle_from_ray(&self, origin: Vec3, dir: Vec3, require_ring: bool) -> Option<f32> {
        if dir.z.abs() <= 1e-6 {
            return None;
        }
        let t = (self.center.z - origin.z) / dir.z;
        if t < 0.0 {
            return None;
        }
        let local = origin + dir * t - self.center;
        let radius = local.truncate().length();
        if require_ring && !(self.inner_radius..=self.outer_radius).contains(&radius) {
            return None;
        }
        Some(local.y.atan2(local.x))
    }

    pub fn sector_at(&self, angle: f32) -> Option<&RotarySector> {
        self.sectors.iter().find(|sector| {
            angular_delta(angle, sector.center_radians).abs() <= sector.half_width_radians
        })
    }
}

pub fn angular_delta(next: f32, previous: f32) -> f32 {
    let tau = std::f32::consts::TAU;
    (next - previous + std::f32::consts::PI).rem_euclid(tau) - std::f32::consts::PI
}

/// One CPU interaction proxy. The high-detail shell is intentionally a single
/// static model instance; button motion can later come from a cooker-emitted
/// node sidecar without changing the input/runtime contract.
pub struct DevicePart {
    pub name: String,
    pub buttons: u32,
}

pub struct Device {
    pub parts: Vec<DevicePart>,
    pub map: PartMap,
    pub screen_center: Vec3,
    pub rotary: Option<RotaryControl>,
    shell_instance: usize,
    settled_lod: Arc<ModelAsset>,
    orbit_lod: Arc<ModelAsset>,
    using_orbit_lod: bool,
}

impl Device {
    /// Use the cheaper LOD only while the camera is being manipulated. Once
    /// the angle settles, one high-quality frame is drawn and then the window
    /// compositor retains it until another dirty event.
    pub fn set_orbit_lod(&mut self, scene: &mut Scene, orbiting: bool) -> bool {
        if self.using_orbit_lod == orbiting {
            return false;
        }
        self.using_orbit_lod = orbiting;
        scene.models[self.shell_instance].asset = if orbiting {
            self.orbit_lod.clone()
        } else {
            self.settled_lod.clone()
        };
        true
    }
}

pub fn default_profile_path() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("assets/dibad-psp/profile.json")
}

pub fn load_settings(profile_path: &Path) -> Result<StageSettings> {
    let profile_path = profile_path
        .canonicalize()
        .with_context(|| format!("missing stage profile {}", profile_path.display()))?;
    let profile = read_profile(&profile_path)?;
    validate_profile(&profile)?;
    let logical = profile.display.logical_size;
    let density = profile.display.raster_density;
    let physical = (
        logical[0]
            .checked_mul(density)
            .ok_or_else(|| anyhow!("display width overflows"))?,
        logical[1]
            .checked_mul(density)
            .ok_or_else(|| anyhow!("display height overflows"))?,
    );
    Ok(StageSettings {
        logical_size: (logical[0], logical[1]),
        raster_density: density,
        physical_size: physical,
        window_size: (
            profile.display.window_size[0],
            profile.display.window_size[1],
        ),
        view: ViewSettings {
            desk_position: Vec3::from_array(profile.view.desk_position_mm),
            desk_target: Vec3::from_array(profile.view.desk_target_mm),
            focus_distance: profile.view.focus_distance_mm,
            fov_y: profile.view.fov_y_degrees.to_radians(),
        },
    })
}

/// Resolve a declared package file through the filesystem, then enforce the
/// canonical package boundary. The textual `..`/absolute-path validation is
/// useful diagnostics, but this check also closes symlink escapes.
fn canonical_package_file(
    package_dir: &Path,
    relative_path: &Path,
    description: &str,
) -> Result<PathBuf> {
    let package_dir = package_dir
        .canonicalize()
        .with_context(|| format!("missing stage package {}", package_dir.display()))?;
    let candidate = package_dir.join(relative_path);
    let canonical = candidate
        .canonicalize()
        .with_context(|| format!("missing {description} {}", candidate.display()))?;
    ensure!(
        canonical.starts_with(&package_dir),
        "{description} resolves outside the stage package: {}",
        canonical.display()
    );
    ensure!(
        canonical.is_file(),
        "{description} is not a file: {}",
        canonical.display()
    );
    Ok(canonical)
}

fn read_profile(profile_path: &Path) -> Result<DeviceProfile> {
    serde_json::from_slice(
        &std::fs::read(profile_path)
            .with_context(|| format!("reading {}", profile_path.display()))?,
    )
    .with_context(|| format!("parsing {}", profile_path.display()))
}

/// Load both visual LODs, bind the persistent PocketJS texture directly onto
/// the exact semantic screen primitive, and construct cold-path pick proxies.
pub fn build(
    gpu: &Gpu,
    renderer: &Renderer,
    scene: &mut Scene,
    screen_view: &wgpu::TextureView,
    profile_path: &Path,
) -> Result<Device> {
    let profile_path = profile_path
        .canonicalize()
        .with_context(|| format!("missing stage profile {}", profile_path.display()))?;
    let profile = read_profile(&profile_path)?;
    validate_profile(&profile)?;
    let profile_dir = profile_path.parent().expect("profile has a parent");
    let settled_path =
        canonical_package_file(profile_dir, Path::new(&profile.lods.settled), "settled LOD")?;
    let orbit_path =
        canonical_package_file(profile_dir, Path::new(&profile.lods.orbit), "orbit LOD")?;
    let attribution_path = canonical_package_file(
        profile_dir,
        Path::new(&profile.attribution),
        "model attribution",
    )?;

    let opts = ModelLoadOptions {
        // More than enough for a 480 logical pixel widget, and a hard guard
        // against an authored model accidentally uploading 4K utility maps.
        max_texture_dim: Some(1024),
    };
    // Some authored assets put a strongly tinted glass sheet in front of the
    // LCD. Profiles can suppress such cosmetic layers with a transparent
    // 1x1 material while retaining their geometry in the source GLB.
    let transparent = create_rgba_texture(
        gpu,
        "stage transparent material",
        1,
        1,
        &[0, 0, 0, 0],
        true,
        false,
    );
    let mut texture_cache = ModelTextureCache::new();
    let (settled_lod, orbit_lod) = {
        let mut load_lod = |path: &Path| -> Result<Arc<ModelAsset>> {
            let screen = MaterialTextureOverride::new(
                &profile.screen.material_role,
                Some(&profile.screen.material_name_prefix),
                screen_view,
                &renderer.samplers.linear_clamp,
            )
            .expect_primitives(profile.screen.expected_primitives)
            .force_white()
            .force_unlit()
            .force_opaque()
            .require_normalized_texcoord0();
            let mut overrides = vec![screen];
            overrides.extend(profile.suppressed_materials.iter().map(|material| {
                MaterialTextureOverride::new(
                    &material.material_role,
                    Some(&material.material_name_prefix),
                    &transparent.view,
                    &renderer.samplers.linear_clamp,
                )
                .expect_primitives(material.expected_primitives)
                .force_white()
                .force_unlit()
                .force_blend()
            }));
            ModelAsset::load_glb_opts_with_overrides_and_cache(
                gpu,
                &renderer.model_material_layout,
                &renderer.samplers,
                path,
                &opts,
                &overrides,
                &mut texture_cache,
            )
        };

        let settled_lod = load_lod(&settled_path)
            .with_context(|| format!("loading settled LOD {}", settled_path.display()))?;
        let orbit_lod = if orbit_path == settled_path {
            // A profile may intentionally use one asset for both states. Keep one
            // set of GPU buffers/textures resident instead of loading it twice.
            settled_lod.clone()
        } else {
            load_lod(&orbit_path)
                .with_context(|| format!("loading orbit LOD {}", orbit_path.display()))?
        };
        (settled_lod, orbit_lod)
    };
    log::info!(
        "pocket-stage texture cache: {} unique upload(s), {} reuse hit(s)",
        texture_cache.len(),
        texture_cache.hit_count()
    );
    // The assets retain Arc<GpuTexture>; release the exact CPU RGBA keys as
    // soon as the batch load is complete.
    drop(texture_cache);
    let transform = canonical_transform(
        settled_lod.aabb,
        profile.target_width_mm,
        profile.rotation_degrees,
    )?;
    validate_lod_bounds(
        settled_lod.aabb,
        orbit_lod.aabb,
        transform,
        profile.target_width_mm,
    )?;

    let mut shell = ModelInstance::new(settled_lod.clone());
    shell.transform = transform;
    shell.lit = 1.0;
    let shell_instance = scene.models.len();
    scene.models.push(shell);

    let screen_center = profile
        .parts
        .iter()
        .find(|part| part.name == "screen")
        .map(|part| Vec3::from_array(part.center_mm))
        .expect("validated profile has a screen part");
    let mut parts = Vec::with_capacity(profile.parts.len());
    let mut map = PartMap::default();
    for part in profile.parts {
        let center = Vec3::from_array(part.center_mm);
        let half = Vec3::from_array(part.half_extents_mm);
        ensure!(
            half.min_element() > 0.0,
            "{} has a non-positive pick extent",
            part.name
        );
        let buttons = button_bits(part.button.as_deref())?;
        let radians = part.rotation_degrees.map(f32::to_radians);
        let rotation = Quat::from_euler(EulerRot::XYZ, radians[0], radians[1], radians[2]);
        map.push(PartShape {
            name: part.name.clone(),
            buttons,
            transform: Mat4::from_translation(center) * Mat4::from_quat(rotation),
            aabb: (-half, half),
        });
        parts.push(DevicePart {
            name: part.name,
            buttons,
        });
    }

    log::info!(
        "pocket-stage model: {} (settled {} tris, orbit {} tris; attribution {})",
        profile.name,
        settled_lod
            .primitives
            .iter()
            .map(|p| p.index_count / 3)
            .sum::<u32>(),
        orbit_lod
            .primitives
            .iter()
            .map(|p| p.index_count / 3)
            .sum::<u32>(),
        attribution_path.display()
    );
    let rotary = profile.rotary.map(|rotary| RotaryControl {
        name: rotary.name,
        center: Vec3::from_array(rotary.center_mm),
        inner_radius: rotary.inner_radius_mm,
        outer_radius: rotary.outer_radius_mm,
        step_radians: rotary.step_degrees.to_radians(),
        clockwise_buttons: button_bits(Some(&rotary.clockwise_button))
            .expect("validated rotary clockwise button"),
        counterclockwise_buttons: button_bits(Some(&rotary.counterclockwise_button))
            .expect("validated rotary counterclockwise button"),
        sectors: rotary
            .sectors
            .into_iter()
            .map(|sector| RotarySector {
                name: sector.name,
                center_radians: sector.center_degrees.to_radians(),
                half_width_radians: sector.half_width_degrees.to_radians(),
                buttons: button_bits(Some(&sector.button)).expect("validated rotary sector"),
            })
            .collect(),
    });
    Ok(Device {
        parts,
        map,
        screen_center,
        rotary,
        shell_instance,
        settled_lod,
        orbit_lod,
        using_orbit_lod: false,
    })
}

fn canonical_transform(
    aabb: (Vec3, Vec3),
    target_width_mm: f32,
    rotation_degrees: [f32; 3],
) -> Result<Mat4> {
    ensure!(target_width_mm > 0.0, "target_width_mm must be positive");
    let radians = rotation_degrees.map(f32::to_radians);
    let rotation = Quat::from_euler(EulerRot::XYZ, radians[0], radians[1], radians[2]);
    let rotation_matrix = Mat4::from_quat(rotation);

    // Measure after the profile orientation so a cooker may supply a Z-up or
    // rotated asset without changing the runtime's canonical X-width rule.
    let mut oriented_min = Vec3::splat(f32::INFINITY);
    let mut oriented_max = Vec3::splat(f32::NEG_INFINITY);
    for x in [aabb.0.x, aabb.1.x] {
        for y in [aabb.0.y, aabb.1.y] {
            for z in [aabb.0.z, aabb.1.z] {
                let point = rotation_matrix.transform_point3(Vec3::new(x, y, z));
                oriented_min = oriented_min.min(point);
                oriented_max = oriented_max.max(point);
            }
        }
    }
    let width = oriented_max.x - oriented_min.x;
    ensure!(
        width > f32::EPSILON,
        "model has a degenerate oriented X extent"
    );
    let center = (oriented_min + oriented_max) * 0.5;
    let scale = target_width_mm / width;
    Ok(Mat4::from_scale(Vec3::splat(scale)) * Mat4::from_translation(-center) * rotation_matrix)
}

pub fn button_bits(name: Option<&str>) -> Result<u32> {
    Ok(match name {
        None => 0,
        Some("up") => btn::UP,
        Some("down") => btn::DOWN,
        Some("left") => btn::LEFT,
        Some("right") => btn::RIGHT,
        Some("cross") => btn::CROSS,
        Some("circle") => btn::CIRCLE,
        Some("square") => btn::SQUARE,
        Some("triangle") => btn::TRIANGLE,
        Some("start") => btn::START,
        Some("select") => btn::SELECT,
        Some("l") => btn::LTRIGGER,
        Some("r") => btn::RTRIGGER,
        Some(other) => return Err(anyhow!("unknown profile button '{other}'")),
    })
}

fn validate_lod_bounds(
    settled: (Vec3, Vec3),
    orbit: (Vec3, Vec3),
    settled_transform: Mat4,
    target_width_mm: f32,
) -> Result<()> {
    // A simplifier may perturb extrema slightly, but each authored axis must
    // stay within 1%; using the largest axis as a universal tolerance would
    // let a thin device change thickness substantially.
    let settled_size = settled.1 - settled.0;
    let orbit_size = orbit.1 - orbit.0;
    for axis in 0..3 {
        let tolerance = (settled_size[axis].abs() * 0.01).max(1e-5);
        ensure!(
            (settled_size[axis] - orbit_size[axis]).abs() <= tolerance,
            "LOD axis {axis} extent differs by more than 1%: settled {settled_size:?}, orbit {orbit_size:?}"
        );
    }

    // Equal-size LODs can still be translated. Measure center drift in final
    // canonical millimetres so a swap cannot visibly jump.
    let settled_center = (settled.0 + settled.1) * 0.5;
    let orbit_center = (orbit.0 + orbit.1) * 0.5;
    let center_drift_mm = settled_transform
        .transform_vector3(orbit_center - settled_center)
        .abs()
        .max_element();
    let center_tolerance_mm = (target_width_mm * 0.001).max(0.05);
    ensure!(
        center_drift_mm <= center_tolerance_mm,
        "LOD centers drift by {center_drift_mm:.3} mm (limit {center_tolerance_mm:.3} mm)"
    );
    Ok(())
}

fn validate_profile(profile: &DeviceProfile) -> Result<()> {
    ensure!(
        profile.schema_version == 1,
        "unsupported profile schema {}",
        profile.schema_version
    );
    ensure!(!profile.name.trim().is_empty(), "profile name is empty");
    for (path, description) in [
        (&profile.attribution, "model attribution"),
        (&profile.lods.settled, "settled LOD"),
        (&profile.lods.orbit, "orbit LOD"),
    ] {
        let path = Path::new(path);
        ensure!(
            !path.as_os_str().is_empty()
                && !path.is_absolute()
                && !path
                    .components()
                    .any(|part| matches!(part, std::path::Component::ParentDir)),
            "{description} escapes the stage package"
        );
    }
    ensure!(
        profile.display.logical_size[0] > 0 && profile.display.logical_size[1] > 0,
        "display logical_size must be positive"
    );
    ensure!(
        (1..=4).contains(&profile.display.raster_density),
        "display raster_density must be 1 through 4"
    );
    ensure!(
        profile.display.window_size[0] > 0 && profile.display.window_size[1] > 0,
        "display window_size must be positive"
    );
    ensure!(
        profile.view.focus_distance_mm > 0.0
            && profile.view.fov_y_degrees > 1.0
            && profile.view.fov_y_degrees < 120.0,
        "view focus distance and fov are invalid"
    );
    ensure!(
        profile.screen.expected_primitives > 0,
        "screen primitive count must be positive"
    );
    for material in &profile.suppressed_materials {
        ensure!(
            !material.material_role.trim().is_empty()
                && !material.material_name_prefix.trim().is_empty(),
            "suppressed material selectors must not be empty"
        );
        ensure!(
            material.expected_primitives > 0,
            "suppressed material primitive count must be positive"
        );
    }
    let mut names: HashSet<&str> = HashSet::new();
    for part in &profile.parts {
        ensure!(
            names.insert(part.name.as_str()),
            "duplicate part name {}",
            part.name
        );
        button_bits(part.button.as_deref())?;
        ensure!(
            Vec3::from_array(part.half_extents_mm).min_element() > 0.0,
            "{} has a non-positive pick extent",
            part.name
        );
    }
    ensure!(
        names.contains("screen"),
        "profile is missing required part screen"
    );
    if let Some(rotary) = &profile.rotary {
        ensure!(
            rotary.adapter == "rotary-wheel@1",
            "unsupported rotary adapter {}",
            rotary.adapter
        );
        ensure!(
            rotary.inner_radius_mm >= 0.0
                && rotary.outer_radius_mm > rotary.inner_radius_mm
                && rotary.step_degrees > 0.0
                && rotary.step_degrees <= 90.0,
            "rotary radii or step are invalid"
        );
        button_bits(Some(&rotary.clockwise_button))?;
        button_bits(Some(&rotary.counterclockwise_button))?;
        for sector in &rotary.sectors {
            ensure!(
                !sector.name.trim().is_empty(),
                "rotary sector name is empty"
            );
            ensure!(
                sector.center_degrees.is_finite()
                    && sector.half_width_degrees > 0.0
                    && sector.half_width_degrees <= 180.0,
                "rotary sector {} has invalid angles",
                sector.name
            );
            button_bits(Some(&sector.button))?;
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn bundled_profile_and_assets_are_valid() {
        let path = default_profile_path();
        let profile: DeviceProfile =
            serde_json::from_slice(&std::fs::read(&path).unwrap()).unwrap();
        validate_profile(&profile).unwrap();
        let dir = path.parent().unwrap();
        assert!(dir.join(profile.lods.settled).is_file());
        assert!(dir.join(profile.lods.orbit).is_file());
        assert!(dir.join(profile.attribution).is_file());
    }

    #[test]
    fn bundled_ipod_profile_display_is_valid() {
        let path =
            PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("assets/ipod-nano-2/profile.json");
        let profile = read_profile(&path).unwrap();
        validate_profile(&profile).unwrap();
        let settings = load_settings(&path).unwrap();
        assert_eq!(settings.logical_size, (176, 132));
        assert_eq!(settings.physical_size, (176, 132));
        assert_eq!(settings.window_size, (320, 600));
        assert!(profile.rotary.is_some());
    }

    #[test]
    fn canonical_transform_centers_and_scales_width() {
        let aabb = (Vec3::new(2.0, 4.0, 6.0), Vec3::new(4.0, 5.0, 7.0));
        let transform = canonical_transform(aabb, 170.0, [0.0; 3]).unwrap();
        let left = transform.transform_point3(Vec3::new(2.0, 4.5, 6.5));
        let right = transform.transform_point3(Vec3::new(4.0, 4.5, 6.5));
        assert!((left.x + 85.0).abs() < 1e-4);
        assert!((right.x - 85.0).abs() < 1e-4);
        assert!(left.y.abs() < 1e-4 && left.z.abs() < 1e-4);
    }

    #[test]
    fn canonical_transform_measures_width_after_profile_rotation() {
        let aabb = (Vec3::ZERO, Vec3::new(1.0, 2.0, 0.5));
        let transform = canonical_transform(aabb, 170.0, [0.0, 0.0, 90.0]).unwrap();
        let a = transform.transform_point3(Vec3::new(0.5, 0.0, 0.25));
        let b = transform.transform_point3(Vec3::new(0.5, 2.0, 0.25));
        assert!((a.x.abs() - 85.0).abs() < 1e-3);
        assert!((b.x.abs() - 85.0).abs() < 1e-3);
        assert!(((a.x - b.x).abs() - 170.0).abs() < 1e-3);
    }

    #[test]
    fn lod_validation_rejects_equal_size_but_shifted_bounds() {
        let settled = (Vec3::ZERO, Vec3::new(10.0, 5.0, 1.0));
        let orbit = (Vec3::new(1.0, 0.0, 0.0), Vec3::new(11.0, 5.0, 1.0));
        let transform = canonical_transform(settled, 170.0, [0.0; 3]).unwrap();
        assert!(validate_lod_bounds(settled, orbit, transform, 170.0).is_err());
    }

    #[test]
    fn angular_delta_unwraps_across_pi() {
        let previous = 179.0_f32.to_radians();
        let next = (-179.0_f32).to_radians();
        assert!((angular_delta(next, previous).to_degrees() - 2.0).abs() < 1e-3);
        assert!((angular_delta(previous, next).to_degrees() + 2.0).abs() < 1e-3);
    }

    #[cfg(unix)]
    #[test]
    fn canonical_package_file_rejects_symlink_escape() {
        use std::os::unix::fs::symlink;
        use std::time::{SystemTime, UNIX_EPOCH};

        let nonce = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let sandbox = std::env::temp_dir().join(format!(
            "pocket-stage-package-path-{}-{nonce}",
            std::process::id()
        ));
        let package = sandbox.join("package");
        let outside = sandbox.join("outside");
        std::fs::create_dir_all(&package).unwrap();
        std::fs::create_dir_all(&outside).unwrap();
        let outside_model = outside.join("model.glb");
        std::fs::write(&outside_model, b"not a model").unwrap();
        symlink(&outside_model, package.join("model.glb")).unwrap();

        let error =
            canonical_package_file(&package, Path::new("model.glb"), "test LOD").unwrap_err();
        assert!(error.to_string().contains("outside the stage package"));

        std::fs::remove_dir_all(&sandbox).unwrap();
    }
}
