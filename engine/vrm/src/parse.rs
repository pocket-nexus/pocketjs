//! VRM 0.x extension parsing: `extensions.VRM` out of a `.vrm` GLB.
//!
//! Everything lands in plain-data structs; mesh/texture loading stays with
//! the host. VRM 1.0 files (`VRMC_vrm`) are rejected with a clear error.

use std::path::Path;

use anyhow::{Context, Result, bail};
use glam::Vec3;
use pocket3d::anim::Skeleton;
use serde_json::Value;

use crate::glb::{self, GltfNodes};

/// VRM 0.x `meta` (the commonly useful subset).
#[derive(Clone, Debug, Default)]
pub struct VrmMeta {
    pub title: Option<String>,
    pub version: Option<String>,
    pub author: Option<String>,
    pub license_name: Option<String>,
}

/// One morph-target binding of an expression. VRM0 stores the weight as
/// 0–100; it is normalized to 0–1 here.
#[derive(Clone, Copy, Debug)]
pub struct MorphBind {
    pub mesh: usize,
    pub target: usize,
    pub weight: f32,
}

/// A blend-shape expression (`blendShapeMaster.blendShapeGroups[]`).
#[derive(Clone, Debug)]
pub struct VrmExpression {
    /// Lowercased `presetName` when it is set and not `"unknown"`, else the
    /// custom `name` (so "Surprised" keeps its name instead of "unknown").
    pub name: String,
    pub is_binary: bool,
    pub binds: Vec<MorphBind>,
}

/// A sphere collider; `offset` is in the owning node's local space.
#[derive(Clone, Copy, Debug)]
pub struct SphereCollider {
    pub offset: Vec3,
    pub radius: f32,
}

/// Colliders attached to one node (`secondaryAnimation.colliderGroups[]`).
#[derive(Clone, Debug)]
pub struct ColliderGroup {
    pub node: usize,
    pub spheres: Vec<SphereCollider>,
}

/// One spring-bone group (`secondaryAnimation.boneGroups[]`). The JSON field
/// is spelled `stiffiness` — the typo IS the VRM 0.x spec.
#[derive(Clone, Debug)]
pub struct SpringGroup {
    pub comment: String,
    pub stiffness: f32,
    pub gravity_power: f32,
    pub gravity_dir: Vec3,
    pub drag_force: f32,
    pub hit_radius: f32,
    /// Root node indices; every descendant joint belongs to the group.
    pub bones: Vec<usize>,
    /// Indices into [`SpringConfig::collider_groups`].
    pub collider_group_indices: Vec<usize>,
}

/// Full spring-bone configuration of a model.
#[derive(Clone, Debug, Default)]
pub struct SpringConfig {
    pub bone_groups: Vec<SpringGroup>,
    pub collider_groups: Vec<ColliderGroup>,
}

/// One look-at degree mapping: input degrees are clamped to `x_range` and
/// scaled onto `y_range` output degrees (the VRM0 curve is ignored; VRoid
/// exports it linear).
#[derive(Clone, Copy, Debug)]
pub struct LookAtDegreeMap {
    pub x_range: f32,
    pub y_range: f32,
}

impl Default for LookAtDegreeMap {
    fn default() -> Self {
        // VRM 0.x CurveMapper defaults.
        Self {
            x_range: 90.0,
            y_range: 10.0,
        }
    }
}

/// Look-at ranges from `firstPerson` (degrees).
#[derive(Clone, Debug)]
pub struct LookAtRanges {
    /// Limits the eye rotating toward the nose.
    pub horizontal_inner: LookAtDegreeMap,
    /// Limits the eye rotating away from the nose.
    pub horizontal_outer: LookAtDegreeMap,
    pub vertical_up: LookAtDegreeMap,
    pub vertical_down: LookAtDegreeMap,
    /// `lookAtTypeName`: "Bone" or "BlendShape".
    pub type_name: String,
}

impl Default for LookAtRanges {
    fn default() -> Self {
        Self {
            horizontal_inner: LookAtDegreeMap::default(),
            horizontal_outer: LookAtDegreeMap::default(),
            vertical_up: LookAtDegreeMap::default(),
            vertical_down: LookAtDegreeMap::default(),
            type_name: "Bone".to_string(),
        }
    }
}

/// Render-relevant facts from one `materialProperties[]` entry.
///
/// VRM0 `materialProperties` are index-aligned with glTF `materials` (same
/// count and order) — verified on the VRoid `AvatarSample_A` fixture, where
/// all 7 entries match the glTF materials by index and name.
#[derive(Clone, Debug)]
pub struct VrmMaterialInfo {
    pub name: String,
    /// `shader == "VRM/MToon"`.
    pub is_mtoon: bool,
    /// `_Cutoff` when `keywordMap._ALPHATEST_ON` is set (0.5 when the
    /// keyword is on but the float is missing).
    pub cutoff: Option<f32>,
    /// `_ALPHABLEND_ON` keyword, or `renderQueue >= 3000` (Unity's
    /// Transparent queue).
    pub transparent: bool,
    pub render_queue: Option<i64>,
    /// `_Color` RGBA.
    pub base_color: Option<[f32; 4]>,
    /// `_ShadeColor` RGB.
    pub shade_color: Option<[f32; 3]>,
    /// `_CullMode == 0` (double-sided).
    pub cull_off: bool,
}

/// A parsed VRM 0.x document: the `extensions.VRM` payload plus the rest
/// node hierarchy (for building a [`Skeleton`] and rest-pose queries).
///
/// Facing convention, verified on `AvatarSample_A`: VRM 0.x glTF data faces
/// **-Z** — the left eye (`J_Adj_L_FaceEye`) rests at x = -0.0146, the right
/// eye at x = +0.0146, so the model's left is -X and a camera should sit at
/// -Z looking toward +Z to see the face.
#[derive(Debug)]
pub struct VrmDoc {
    pub meta: VrmMeta,
    /// VRM humanoid bone name (e.g. "hips", "head", "leftEye") → glTF node.
    pub humanoid: Vec<(String, usize)>,
    pub expressions: Vec<VrmExpression>,
    pub springs: SpringConfig,
    pub look_at: LookAtRanges,
    /// Index-aligned with glTF `materials` (see [`VrmMaterialInfo`]).
    pub materials: Vec<VrmMaterialInfo>,
    /// Length of the glTF `materials` array, for hosts mapping
    /// [`VrmDoc::materials`] onto loaded primitives by index.
    pub gltf_material_count: usize,
    /// Rest-pose node hierarchy (index-aligned with glTF `nodes`).
    pub nodes: GltfNodes,
}

impl VrmDoc {
    /// Parse a `.vrm` (GLB) byte buffer. VRM 1.0 files are rejected.
    pub fn from_glb_bytes(bytes: &[u8]) -> Result<VrmDoc> {
        let glb = glb::parse_glb(bytes)?;
        let exts = glb.json.get("extensions");
        if exts.and_then(|e| e.get("VRMC_vrm")).is_some() {
            bail!("VRM 1.0 (VRMC_vrm) is not supported; expected VRM 0.x");
        }
        let vrm = exts
            .and_then(|e| e.get("VRM"))
            .context("not a VRM 0.x file: missing extensions.VRM")?;

        let nodes = GltfNodes::parse(&glb.json)?;
        let gltf_material_count = glb
            .json
            .get("materials")
            .and_then(Value::as_array)
            .map_or(0, Vec::len);

        Ok(VrmDoc {
            meta: parse_meta(vrm.get("meta")),
            humanoid: parse_humanoid(vrm.get("humanoid")),
            expressions: parse_expressions(vrm.get("blendShapeMaster")),
            springs: parse_springs(vrm.get("secondaryAnimation")),
            look_at: parse_look_at(vrm.get("firstPerson")),
            materials: parse_materials(vrm.get("materialProperties")),
            gltf_material_count,
            nodes,
        })
    }

    /// Read and parse a `.vrm` file.
    pub fn from_path(path: &Path) -> Result<VrmDoc> {
        let bytes = std::fs::read(path).with_context(|| format!("reading {}", path.display()))?;
        Self::from_glb_bytes(&bytes).with_context(|| format!("parsing {}", path.display()))
    }

    /// Look up a humanoid bone's glTF node index by VRM bone name.
    pub fn humanoid_node(&self, bone: &str) -> Option<usize> {
        self.humanoid
            .iter()
            .find(|(name, _)| name == bone)
            .map(|&(_, node)| node)
    }

    /// Build a pocket3d [`Skeleton`] over the full glTF node hierarchy.
    pub fn skeleton(&self) -> Skeleton {
        self.nodes.skeleton()
    }
}

fn opt_str(v: Option<&Value>, key: &str) -> Option<String> {
    v?.get(key)?.as_str().map(str::to_string)
}

fn f32_of(v: &Value, key: &str, default: f32) -> f32 {
    v.get(key)
        .and_then(Value::as_f64)
        .map_or(default, |f| f as f32)
}

fn usize_list(v: Option<&Value>) -> Vec<usize> {
    v.and_then(Value::as_array)
        .map(|a| {
            a.iter()
                .filter_map(|e| e.as_u64().map(|u| u as usize))
                .collect()
        })
        .unwrap_or_default()
}

/// VRM0 vectors are `{x, y, z}` objects.
fn vec3_of(v: Option<&Value>, default: Vec3) -> Vec3 {
    let Some(v) = v else { return default };
    Vec3::new(
        f32_of(v, "x", default.x),
        f32_of(v, "y", default.y),
        f32_of(v, "z", default.z),
    )
}

fn parse_meta(meta: Option<&Value>) -> VrmMeta {
    VrmMeta {
        title: opt_str(meta, "title"),
        version: opt_str(meta, "version"),
        author: opt_str(meta, "author"),
        license_name: opt_str(meta, "licenseName"),
    }
}

fn parse_humanoid(humanoid: Option<&Value>) -> Vec<(String, usize)> {
    let bones = humanoid
        .and_then(|h| h.get("humanBones"))
        .and_then(Value::as_array);
    let Some(bones) = bones else {
        return Vec::new();
    };
    bones
        .iter()
        .filter_map(|b| {
            let name = b.get("bone")?.as_str()?.to_string();
            let node = b.get("node")?.as_u64()? as usize;
            Some((name, node))
        })
        .collect()
}

fn parse_expressions(master: Option<&Value>) -> Vec<VrmExpression> {
    let groups = master
        .and_then(|m| m.get("blendShapeGroups"))
        .and_then(Value::as_array);
    let Some(groups) = groups else {
        return Vec::new();
    };
    groups
        .iter()
        .map(|g| {
            let preset = g.get("presetName").and_then(Value::as_str).unwrap_or("");
            let name = if preset.is_empty() || preset.eq_ignore_ascii_case("unknown") {
                g.get("name")
                    .and_then(Value::as_str)
                    .unwrap_or("")
                    .to_string()
            } else {
                preset.to_ascii_lowercase()
            };
            let binds = g
                .get("binds")
                .and_then(Value::as_array)
                .map(|binds| {
                    binds
                        .iter()
                        .filter_map(|b| {
                            Some(MorphBind {
                                mesh: b.get("mesh")?.as_u64()? as usize,
                                target: b.get("index")?.as_u64()? as usize,
                                // VRM0 weights are 0–100.
                                weight: f32_of(b, "weight", 100.0) / 100.0,
                            })
                        })
                        .collect()
                })
                .unwrap_or_default();
            VrmExpression {
                name,
                is_binary: g.get("isBinary").and_then(Value::as_bool).unwrap_or(false),
                binds,
            }
        })
        .collect()
}

fn parse_springs(secondary: Option<&Value>) -> SpringConfig {
    let Some(secondary) = secondary else {
        return SpringConfig::default();
    };
    let bone_groups = secondary
        .get("boneGroups")
        .and_then(Value::as_array)
        .map(|groups| {
            groups
                .iter()
                .map(|g| SpringGroup {
                    comment: g
                        .get("comment")
                        .and_then(Value::as_str)
                        .unwrap_or("")
                        .to_string(),
                    // sic: the VRM 0.x JSON field is "stiffiness".
                    stiffness: f32_of(g, "stiffiness", 1.0),
                    gravity_power: f32_of(g, "gravityPower", 0.0),
                    gravity_dir: vec3_of(g.get("gravityDir"), Vec3::NEG_Y),
                    drag_force: f32_of(g, "dragForce", 0.4),
                    hit_radius: f32_of(g, "hitRadius", 0.02),
                    bones: usize_list(g.get("bones")),
                    collider_group_indices: usize_list(g.get("colliderGroups")),
                })
                .collect()
        })
        .unwrap_or_default();
    let collider_groups = secondary
        .get("colliderGroups")
        .and_then(Value::as_array)
        .map(|groups| {
            groups
                .iter()
                .filter_map(|g| {
                    let node = g.get("node")?.as_u64()? as usize;
                    let spheres = g
                        .get("colliders")
                        .and_then(Value::as_array)
                        .map(|cs| {
                            cs.iter()
                                .map(|c| SphereCollider {
                                    offset: vec3_of(c.get("offset"), Vec3::ZERO),
                                    radius: f32_of(c, "radius", 0.0),
                                })
                                .collect()
                        })
                        .unwrap_or_default();
                    Some(ColliderGroup { node, spheres })
                })
                .collect()
        })
        .unwrap_or_default();
    SpringConfig {
        bone_groups,
        collider_groups,
    }
}

fn degree_map(v: Option<&Value>) -> LookAtDegreeMap {
    let default = LookAtDegreeMap::default();
    let Some(v) = v else { return default };
    LookAtDegreeMap {
        x_range: f32_of(v, "xRange", default.x_range),
        y_range: f32_of(v, "yRange", default.y_range),
    }
}

fn parse_look_at(first_person: Option<&Value>) -> LookAtRanges {
    let Some(fp) = first_person else {
        return LookAtRanges::default();
    };
    LookAtRanges {
        horizontal_inner: degree_map(fp.get("lookAtHorizontalInner")),
        horizontal_outer: degree_map(fp.get("lookAtHorizontalOuter")),
        vertical_up: degree_map(fp.get("lookAtVerticalUp")),
        vertical_down: degree_map(fp.get("lookAtVerticalDown")),
        type_name: fp
            .get("lookAtTypeName")
            .and_then(Value::as_str)
            .unwrap_or("Bone")
            .to_string(),
    }
}

fn parse_materials(props: Option<&Value>) -> Vec<VrmMaterialInfo> {
    let Some(props) = props.and_then(Value::as_array) else {
        return Vec::new();
    };
    props
        .iter()
        .map(|m| {
            let floats = m.get("floatProperties");
            let vectors = m.get("vectorProperties");
            let keyword = |k: &str| {
                m.get("keywordMap")
                    .and_then(|kw| kw.get(k))
                    .and_then(Value::as_bool)
                    .unwrap_or(false)
            };
            let float = |k: &str| {
                floats
                    .and_then(|f| f.get(k))
                    .and_then(Value::as_f64)
                    .map(|f| f as f32)
            };
            let render_queue = m.get("renderQueue").and_then(Value::as_i64);
            VrmMaterialInfo {
                name: m
                    .get("name")
                    .and_then(Value::as_str)
                    .unwrap_or("")
                    .to_string(),
                is_mtoon: m.get("shader").and_then(Value::as_str) == Some("VRM/MToon"),
                cutoff: keyword("_ALPHATEST_ON").then(|| float("_Cutoff").unwrap_or(0.5)),
                transparent: keyword("_ALPHABLEND_ON") || render_queue.is_some_and(|q| q >= 3000),
                render_queue,
                base_color: vectors
                    .and_then(|v| v.get("_Color"))
                    .and_then(glb::f32_array::<4>),
                shade_color: vectors
                    .and_then(|v| v.get("_ShadeColor"))
                    .and_then(glb::f32_array::<3>),
                cull_off: float("_CullMode") == Some(0.0),
            }
        })
        .collect()
}
