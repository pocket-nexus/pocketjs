//! Integration tests over the real VRoid/airi fixtures. The binaries are
//! git-ignored; tests skip (with a note) when they are absent — see
//! `fixtures/README.md` for download URLs.

use std::path::PathBuf;

use glam::Mat4;
use pocket_vrm::{SpringSolver, VrmDoc, load_vrma_bytes, retarget};
use pocket3d::anim::ChannelPath;

fn fixture(name: &str) -> Option<Vec<u8>> {
    let path = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("fixtures")
        .join(name);
    match std::fs::read(&path) {
        Ok(bytes) => Some(bytes),
        Err(_) => {
            eprintln!(
                "skipping: fixture {} not found (see fixtures/README.md)",
                path.display()
            );
            None
        }
    }
}

fn parse_model() -> Option<VrmDoc> {
    Some(VrmDoc::from_glb_bytes(&fixture("AvatarSample_A.vrm")?).expect("parse AvatarSample_A"))
}

#[test]
fn parses_avatar_sample_a() {
    let Some(doc) = parse_model() else { return };

    // Humanoid: the bones everything else keys off must be present.
    for bone in ["hips", "head", "leftEye", "rightEye"] {
        assert!(doc.humanoid_node(bone).is_some(), "missing humanoid {bone}");
    }

    // Facing convention: VRM0 faces -Z, so the (anatomical) left eye rests
    // at negative X and the right eye at positive X.
    let left = doc
        .nodes
        .rest_global_position(doc.humanoid_node("leftEye").unwrap());
    let right = doc
        .nodes
        .rest_global_position(doc.humanoid_node("rightEye").unwrap());
    assert!(left.x < 0.0, "left eye at {left:?}");
    assert!(right.x > 0.0, "right eye at {right:?}");

    // Hips rest height (drives VRMA scaling).
    let hips = doc
        .nodes
        .rest_global_position(doc.humanoid_node("hips").unwrap());
    assert!((hips.y - 0.8954).abs() < 1e-3, "hips at {hips:?}");

    // Expressions: preset blink with at least one bind onto the Face mesh.
    let blink = doc
        .expressions
        .iter()
        .find(|e| e.name == "blink")
        .expect("blink expression");
    assert!(!blink.binds.is_empty());
    assert_eq!(blink.binds[0].mesh, 0);
    assert_eq!(blink.binds[0].target, 13);
    assert!(
        (blink.binds[0].weight - 1.0).abs() < 1e-6,
        "weight normalized to 0-1"
    );

    // Springs: this model carries 10 bone groups and 10 collider groups.
    assert!(!doc.springs.bone_groups.is_empty());
    assert!(!doc.springs.collider_groups.is_empty());
    assert!(doc.springs.bone_groups.iter().all(|g| g.stiffness > 0.0));

    // Materials: MToon info, index-aligned with glTF materials.
    assert!(doc.materials.iter().any(|m| m.is_mtoon));
    assert_eq!(doc.materials.len(), doc.gltf_material_count);
    let raw = fixture("AvatarSample_A.vrm").unwrap();
    let glb = pocket_vrm::glb::parse_glb(&raw).unwrap();
    let gltf_names: Vec<&str> = glb.json["materials"]
        .as_array()
        .unwrap()
        .iter()
        .map(|m| m["name"].as_str().unwrap_or(""))
        .collect();
    for (i, m) in doc.materials.iter().enumerate() {
        assert_eq!(m.name, gltf_names[i], "materialProperties[{i}] misaligned");
    }

    // Look-at ranges came through in degrees.
    assert_eq!(doc.look_at.type_name, "Bone");
    assert!(doc.look_at.horizontal_outer.y_range > 0.0);
}

#[test]
fn retargets_idle_loop_onto_model() {
    let Some(doc) = parse_model() else { return };
    let Some(vrma_bytes) = fixture("idle_loop.vrma") else {
        return;
    };
    let vrma = load_vrma_bytes(&vrma_bytes).expect("parse idle_loop.vrma");
    assert!(vrma.humanoid_node("hips").is_some());

    let skeleton = doc.skeleton();
    let clip = retarget(&vrma, &doc.humanoid, &skeleton).expect("retarget");
    assert!(clip.channels.len() > 10, "{} channels", clip.channels.len());
    assert!(clip.duration > 1.0, "duration {}", clip.duration);

    let hips_node = doc.humanoid_node("hips").unwrap();
    let t = clip
        .channels
        .iter()
        .find(|c| c.node == hips_node && c.path == ChannelPath::Translation)
        .expect("hips translation channel");
    assert_eq!(t.values[0], 0.0, "first key X re-anchored");
    assert_eq!(t.values[2], 0.0, "first key Z re-anchored");
    for key in t.values.as_chunks::<3>().0 {
        assert!(key.iter().all(|v| v.is_finite()));
        // Scaled to the model's meters and re-anchored: an idle loop stays
        // well within a meter of the origin, at a plausible hips height.
        assert!(key[0].abs() < 1.0 && key[2].abs() < 1.0, "hips key {key:?}");
        assert!(key[1] > 0.5 && key[1] < 1.5, "hips height {key:?}");
    }
}

#[test]
fn spring_solver_is_stable_and_deterministic() {
    let Some(doc) = parse_model() else { return };
    let skeleton = doc.skeleton();
    let rest = skeleton.rest.clone();

    let run = || {
        let mut solver = SpringSolver::new(&doc.springs, &skeleton, &rest);
        assert!(solver.joint_count() > 0);
        let mut locals = rest.clone();
        for _ in 0..600 {
            locals.copy_from_slice(&rest);
            solver.step(1.0 / 60.0, &skeleton, &mut locals, Mat4::IDENTITY);
            for l in locals.iter() {
                assert!(l.rotation.is_finite() && l.translation.is_finite());
            }
        }
        locals
    };

    let a = run();
    // Bounded: starting at rest, springs must stay near it (gravity on the
    // hood strings sags them a little; nothing should swing past ~40°).
    let max_delta = a
        .iter()
        .zip(rest.iter())
        .map(|(l, r)| l.rotation.angle_between(r.rotation))
        .fold(0.0f32, f32::max);
    assert!(
        max_delta < 0.7,
        "max rotation delta from rest: {max_delta} rad"
    );

    // Deterministic: a second run is bitwise identical.
    let b = run();
    for (x, y) in a.iter().zip(b.iter()) {
        assert_eq!(
            x.rotation.to_array().map(f32::to_bits),
            y.rotation.to_array().map(f32::to_bits)
        );
    }
}

#[test]
fn eye_look_at_respects_model_ranges() {
    let Some(doc) = parse_model() else { return };
    let skeleton = doc.skeleton();
    let rest = skeleton.rest.clone();
    let mut locals = rest.clone();
    pocket_vrm::apply_eye_look(
        &mut locals,
        &rest,
        doc.humanoid_node("leftEye"),
        doc.humanoid_node("rightEye"),
        &doc.look_at,
        90.0,
        0.0,
    );
    let left = doc.humanoid_node("leftEye").unwrap();
    let right = doc.humanoid_node("rightEye").unwrap();
    let l_deg = locals[left]
        .rotation
        .angle_between(rest[left].rotation)
        .to_degrees();
    let r_deg = locals[right]
        .rotation
        .angle_between(rest[right].rotation)
        .to_degrees();
    // AvatarSample_A: outer 12°, inner 8° at full deflection.
    assert!(
        (l_deg - doc.look_at.horizontal_outer.y_range).abs() < 0.1,
        "{l_deg}"
    );
    assert!(
        (r_deg - doc.look_at.horizontal_inner.y_range).abs() < 0.1,
        "{r_deg}"
    );
}

#[test]
fn vrm1_is_rejected_clearly() {
    // A minimal GLB claiming VRMC_vrm must produce the dedicated error.
    let json = br#"{"asset":{"version":"2.0"},"extensions":{"VRMC_vrm":{}}}"#;
    let mut glb = Vec::new();
    glb.extend_from_slice(b"glTF");
    glb.extend_from_slice(&2u32.to_le_bytes());
    let mut payload = json.to_vec();
    while !payload.len().is_multiple_of(4) {
        payload.push(b' ');
    }
    glb.extend_from_slice(&((12 + 8 + payload.len()) as u32).to_le_bytes());
    glb.extend_from_slice(&(payload.len() as u32).to_le_bytes());
    glb.extend_from_slice(b"JSON");
    glb.extend_from_slice(&payload);
    let err = VrmDoc::from_glb_bytes(&glb).unwrap_err().to_string();
    assert!(err.contains("VRM 1.0"), "{err}");
}
