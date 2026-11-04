//! `.vrma` (VRMC_vrm_animation) loading and retargeting onto a VRM model.
//!
//! Both rigs are VRM-normalized (identity rest rotations), so humanoid
//! rotation channels transfer by bone name without basis conversion. Hips
//! translation is scaled by the rest hips-height ratio and re-anchored so
//! the first key sits over the origin in X/Z (mirrors airi's
//! `reAnchorRootPositionTrack`).
//!
//! Heights are measured in *channel units* — parent chains accumulated with
//! rotations but ancestor scales ignored — because glTF translation keys
//! live in the node's parent-local space. That absorbs unit mismatches: the
//! airi `idle_loop.vrma` fixture is authored in centimeters under a
//! 0.01-scale parent node, and the ratio still lands hips keys in the
//! model's meters.

use anyhow::{Context, Result, bail, ensure};
use pocket3d::anim::{Channel, ChannelPath, Clip, Interpolation, NodeTrs, Skeleton};
use serde_json::Value;

use crate::glb::{self, GltfNodes};

/// A parsed `.vrma` document: glTF animation 0 decoded into pocket3d
/// [`Channel`]s (node = vrma node index) plus the humanoid map and the rest
/// hierarchy needed for hips-height scaling.
pub struct VrmaDoc {
    pub name: String,
    pub duration: f32,
    /// VRM humanoid bone name → vrma node index.
    pub humanoid: Vec<(String, usize)>,
    /// Translation/rotation channels of glTF animation 0.
    pub channels: Vec<Channel>,
    /// Rest hierarchy of the vrma's own nodes.
    pub nodes: GltfNodes,
}

impl VrmaDoc {
    /// Look up a humanoid bone's vrma node index.
    pub fn humanoid_node(&self, bone: &str) -> Option<usize> {
        self.humanoid
            .iter()
            .find(|(name, _)| name == bone)
            .map(|&(_, node)| node)
    }
}

/// Parse a `.vrma` GLB: glTF animation 0 plus `VRMC_vrm_animation`.
/// Sampler interpolation LINEAR/STEP is kept; CUBICSPLINE keeps the middle
/// values and degrades to LINEAR. Sparse accessors are rejected.
pub fn load_vrma_bytes(bytes: &[u8]) -> Result<VrmaDoc> {
    let glb = glb::parse_glb(bytes)?;
    let ext = glb
        .json
        .get("extensions")
        .and_then(|e| e.get("VRMC_vrm_animation"))
        .context("not a .vrma: missing extensions.VRMC_vrm_animation")?;

    // humanoid.humanBones is an object: { boneName: { node } }. serde_json
    // objects iterate in sorted key order, so this Vec is deterministic.
    let mut humanoid = Vec::new();
    if let Some(bones) = ext
        .get("humanoid")
        .and_then(|h| h.get("humanBones"))
        .and_then(Value::as_object)
    {
        for (name, v) in bones {
            if let Some(node) = v.get("node").and_then(Value::as_u64) {
                humanoid.push((name.clone(), node as usize));
            }
        }
    }

    let anim = glb
        .json
        .get("animations")
        .and_then(|a| a.get(0))
        .context(".vrma has no animations")?;
    let name = anim
        .get("name")
        .and_then(Value::as_str)
        .unwrap_or("vrma")
        .to_string();
    let samplers = anim
        .get("samplers")
        .and_then(Value::as_array)
        .context("animation has no samplers")?;

    let mut channels = Vec::new();
    let mut duration = 0.0f32;
    for ch in anim
        .get("channels")
        .and_then(Value::as_array)
        .context("animation has no channels")?
    {
        let target = ch.get("target").context("channel has no target")?;
        let Some(node) = target.get("node").and_then(Value::as_u64) else {
            continue; // targets without a node are legal glTF; skip
        };
        let path = match target.get("path").and_then(Value::as_str) {
            Some("translation") => ChannelPath::Translation,
            Some("rotation") => ChannelPath::Rotation,
            // "scale"/"weights" (and unknown paths) are out of scope.
            _ => continue,
        };
        let si = ch
            .get("sampler")
            .and_then(Value::as_u64)
            .context("channel has no sampler")? as usize;
        let sampler = samplers.get(si).context("sampler index out of range")?;
        let input = sampler
            .get("input")
            .and_then(Value::as_u64)
            .context("sampler input")?;
        let output = sampler
            .get("output")
            .and_then(Value::as_u64)
            .context("sampler output")?;
        let interp = sampler
            .get("interpolation")
            .and_then(Value::as_str)
            .unwrap_or("LINEAR");

        let (times, tc) = glb::read_f32_accessor(&glb.json, glb.bin, input as usize)?;
        ensure!(tc == 1, "sampler input must be SCALAR");
        let (mut values, comps) = glb::read_f32_accessor(&glb.json, glb.bin, output as usize)?;
        let expected = match path {
            ChannelPath::Translation => 3,
            ChannelPath::Rotation => 4,
            ChannelPath::Scale => unreachable!(),
        };
        ensure!(
            comps == expected,
            "sampler output has {comps} components, expected {expected}"
        );
        let interpolation = match interp {
            "STEP" => Interpolation::Step,
            "CUBICSPLINE" => {
                // Keys are (in-tangent, value, out-tangent); keep the values.
                ensure!(
                    values.len() == times.len() * comps * 3,
                    "CUBICSPLINE output count mismatch"
                );
                values = (0..times.len())
                    .flat_map(|k| {
                        let base = (k * 3 + 1) * comps;
                        values[base..base + comps].to_vec()
                    })
                    .collect();
                Interpolation::Linear
            }
            _ => Interpolation::Linear,
        };
        ensure!(
            values.len() == times.len() * comps,
            "sampler output count mismatch"
        );
        duration = duration.max(times.last().copied().unwrap_or(0.0));
        channels.push(Channel {
            node: node as usize,
            path,
            interpolation,
            times,
            values,
        });
    }

    Ok(VrmaDoc {
        name,
        duration,
        humanoid,
        channels,
        nodes: GltfNodes::parse(&glb.json)?,
    })
}

/// Retarget a vrma clip onto a model: rotation channels transfer by humanoid
/// bone name, hips translation is scaled by the rest hips-height ratio and
/// re-anchored over the origin in X/Z, everything else is dropped.
///
/// `humanoid` is the model's bone map (e.g. [`crate::VrmDoc::humanoid`]);
/// `model_skeleton` supplies the model's rest globals for the hips height.
pub fn retarget(
    vrma: &VrmaDoc,
    humanoid: &[(String, usize)],
    model_skeleton: &Skeleton,
) -> Result<Clip> {
    let model_hips = humanoid
        .iter()
        .find(|(name, _)| name == "hips")
        .map(|&(_, node)| node)
        .context("model humanoid has no hips")?;
    ensure!(
        model_hips < model_skeleton.rest.len(),
        "model hips node out of range"
    );
    let vrma_hips = vrma.humanoid_node("hips");

    let model_h = channel_units_height(model_hips, &model_skeleton.parents, &model_skeleton.rest);
    ensure!(
        model_h > 1e-4,
        "model hips rest height is not positive ({model_h})"
    );

    // vrma node → bone name (first mapping wins; maps are tiny).
    let bone_of = |node: usize| -> Option<&str> {
        vrma.humanoid
            .iter()
            .find(|&&(_, n)| n == node)
            .map(|(name, _)| name.as_str())
    };

    let mut channels = Vec::new();
    for ch in &vrma.channels {
        let Some(bone) = bone_of(ch.node) else {
            continue; // non-humanoid channel: drop
        };
        let Some(model_node) = humanoid
            .iter()
            .find(|(name, _)| name == bone)
            .map(|&(_, node)| node)
        else {
            continue; // model lacks this bone: drop
        };
        match ch.path {
            ChannelPath::Rotation => {
                // VRMC_vrm_animation poses live in the VRM 1.0 humanoid
                // space (character faces +Z); VRM 0.x rigs face -Z. Conjugate
                // every rotation by the 180° yaw between the spaces —
                // R_y(π) q R_y(π)⁻¹ — which for quaternions is (-x, y, -z, w).
                let values: Vec<f32> = ch
                    .values
                    .as_chunks::<4>()
                    .0
                    .iter()
                    .flat_map(|q| [-q[0], q[1], -q[2], q[3]])
                    .collect();
                channels.push(Channel {
                    node: model_node,
                    path: ChannelPath::Rotation,
                    interpolation: ch.interpolation,
                    times: ch.times.clone(),
                    values,
                });
            }
            ChannelPath::Translation if bone == "hips" => {
                let hips_node = vrma_hips.context("vrma humanoid has no hips")?;
                ensure!(
                    hips_node < vrma.nodes.rest.len(),
                    "vrma hips node out of range"
                );
                let vrma_h = channel_units_height(hips_node, &vrma.nodes.parents, &vrma.nodes.rest);
                ensure!(
                    vrma_h > 1e-4,
                    "vrma hips rest height is not positive ({vrma_h})"
                );
                let scale = model_h / vrma_h;
                let mut values: Vec<f32> = ch.values.iter().map(|v| v * scale).collect();
                // Re-anchor: keep the loop centered over the origin in X/Z.
                // The same +Z→-Z yaw flip as rotations applies: negate X/Z.
                if values.len() >= 3 {
                    let (x0, z0) = (values[0], values[2]);
                    for key in values.as_chunks_mut::<3>().0 {
                        key[0] = -(key[0] - x0);
                        key[2] = -(key[2] - z0);
                    }
                }
                channels.push(Channel {
                    node: model_node,
                    path: ChannelPath::Translation,
                    interpolation: ch.interpolation,
                    times: ch.times.clone(),
                    values,
                });
            }
            _ => {} // non-hips translation, scale: drop
        }
    }
    if channels.is_empty() {
        bail!("retarget produced no channels (no humanoid overlap?)");
    }
    Ok(Clip {
        name: vrma.name.clone(),
        duration: vrma.duration,
        channels,
    })
}

/// Rest-pose hips height in channel units: the parent chain accumulated
/// with rotations applied but ancestor scales ignored, because animation
/// translation keys are parent-local (see the module docs).
fn channel_units_height(node: usize, parents: &[usize], rest: &[NodeTrs]) -> f32 {
    let mut p = rest[node].translation;
    let mut cur = parents[node];
    while cur != usize::MAX {
        let t = &rest[cur];
        p = t.translation + t.rotation * p;
        cur = parents[cur];
    }
    p.y
}

#[cfg(test)]
mod tests {
    use glam::Vec3;

    use super::*;

    /// Synthetic rig: vrma hips at rest height 2.0, model hips at 1.0 —
    /// hips translation must scale by 0.5 and re-anchor X/Z to the first key.
    #[test]
    fn retarget_scales_and_reanchors_hips() {
        let vrma = VrmaDoc {
            name: "test".into(),
            duration: 1.0,
            humanoid: vec![("hips".into(), 1), ("spine".into(), 2)],
            channels: vec![
                Channel {
                    node: 1,
                    path: ChannelPath::Translation,
                    interpolation: Interpolation::Linear,
                    times: vec![0.0, 1.0],
                    values: vec![1.0, 2.0, 3.0, 2.0, 2.2, 4.0],
                },
                Channel {
                    node: 2,
                    path: ChannelPath::Rotation,
                    interpolation: Interpolation::Linear,
                    times: vec![0.0, 1.0],
                    values: vec![
                        0.0,
                        0.0,
                        0.0,
                        1.0,
                        0.0,
                        std::f32::consts::FRAC_1_SQRT_2,
                        0.0,
                        std::f32::consts::FRAC_1_SQRT_2,
                    ],
                },
                Channel {
                    // Not in the humanoid map: must be dropped.
                    node: 3,
                    path: ChannelPath::Rotation,
                    interpolation: Interpolation::Linear,
                    times: vec![0.0],
                    values: vec![0.0, 0.0, 0.0, 1.0],
                },
            ],
            nodes: {
                let mut rest = vec![NodeTrs::IDENTITY; 3];
                rest[1].translation = Vec3::new(0.0, 2.0, 0.0);
                GltfNodes {
                    names: vec!["root".into(), "hips".into(), "spine".into()],
                    parents: vec![usize::MAX, 0, 1],
                    rest,
                    children: vec![vec![1], vec![2], vec![]],
                }
            },
        };
        let mut rest = vec![NodeTrs::IDENTITY; 2];
        rest[1].translation = Vec3::new(0.0, 1.0, 0.0);
        let model = Skeleton {
            parents: vec![usize::MAX, 0],
            rest,
            order: vec![0, 1],
        };
        let humanoid = vec![("hips".to_string(), 1usize), ("spine".to_string(), 0)];
        let clip = retarget(&vrma, &humanoid, &model).unwrap();
        assert_eq!(clip.channels.len(), 2);
        let t = clip
            .channels
            .iter()
            .find(|c| c.path == ChannelPath::Translation)
            .unwrap();
        assert_eq!(t.node, 1);
        // Scaled by 0.5, X/Z re-anchored to key 0, then the +Z→-Z facing
        // flip negates X/Z.
        assert_eq!(t.values, vec![-0.0, 1.0, -0.0, -0.5, 1.1, -0.5]);
        let r = clip
            .channels
            .iter()
            .find(|c| c.path == ChannelPath::Rotation)
            .unwrap();
        assert_eq!(r.node, 0); // "spine" mapped onto model node 0
    }
}
