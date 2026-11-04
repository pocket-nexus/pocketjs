//! VRM 0.x spring-bone physics (UniVRM `VRMSpringBone` verlet semantics).
//!
//! Chains are precomputed in [`SpringSolver::new`]; [`SpringSolver::step`]
//! does no heap allocation and touches only `Vec`s in a fixed order, so runs
//! are f32-deterministic. Differences from UniVRM, on purpose:
//! - the stiffness target uses the *animated* local rotation of the frame
//!   (UniVRM caches the setup-time local rotation), so springs settle back
//!   onto whatever pose the animation drives;
//! - the VRM0 `center` field is ignored (springs always simulate in world
//!   space).

use glam::{Mat4, Quat, Vec3};
use pocket3d::anim::{NodeTrs, Skeleton};

use crate::parse::SpringConfig;

/// UniVRM synthesizes a 7 cm tail for leaf joints.
const LEAF_TAIL_LEN: f32 = 0.07;
/// Internal step clamp: substeps never integrate more than 1/30 s each, and
/// at most [`MAX_SUBSTEPS`] substeps run per `step` call — a huge `dt` (e.g.
/// after a hitch) simulates at most 4/30 s instead of exploding.
const MAX_SUB_DT: f32 = 1.0 / 30.0;
const MAX_SUBSTEPS: usize = 4;

/// Per-group simulation parameters plus the group's flattened collider range.
struct GroupParams {
    stiffness: f32,
    drag: f32,
    gravity_dir: Vec3,
    gravity_power: f32,
    hit_radius: f32,
    /// `[start, end)` into [`SpringSolver::colliders`].
    colliders: (u32, u32),
}

/// One sphere collider reference; `offset` is in the node's local space.
struct ColliderRef {
    node: usize,
    offset: Vec3,
    radius: f32,
}

/// One verlet particle: a joint head plus its tail position in world space.
struct Joint {
    node: usize,
    /// `usize::MAX` when the joint's node is a hierarchy root.
    parent: usize,
    group: u32,
    /// Rest direction to the tail, in the joint's local space (unit).
    bone_axis: Vec3,
    /// Rest distance to the tail (world units; assumes unit scale).
    length: f32,
    current_tail: Vec3,
    prev_tail: Vec3,
}

/// Spring-bone solver over a [`Skeleton`]. Joints are gathered per
/// [`crate::parse::SpringGroup`] root by walking all descendant chains in
/// `skeleton.order` sibling order; leaf joints get a synthesized 7 cm tail.
pub struct SpringSolver {
    groups: Vec<GroupParams>,
    colliders: Vec<ColliderRef>,
    joints: Vec<Joint>,
    // Scratch (preallocated; `step` never allocates).
    globals: Vec<Mat4>,
    world_rot: Vec<Quat>,
    anim_rot: Vec<Quat>,
    collider_world: Vec<(Vec3, f32)>,
}

impl SpringSolver {
    /// Precompute chains and seat particles at the pose given by
    /// `initial_locals` (usually the rest pose).
    pub fn new(config: &SpringConfig, skeleton: &Skeleton, initial_locals: &[NodeTrs]) -> Self {
        let n = skeleton.rest.len();
        assert_eq!(initial_locals.len(), n, "initial_locals length != skeleton");

        // Children per node, in `skeleton.order` sibling order (matches glTF
        // child order for skeletons built by GltfNodes::skeleton, which is
        // what UniVRM's "first child" tail selection keys off).
        let mut children: Vec<Vec<usize>> = vec![Vec::new(); n];
        for &i in &skeleton.order {
            if skeleton.parents[i] != usize::MAX {
                children[skeleton.parents[i]].push(i);
            }
        }

        let mut globals = vec![Mat4::IDENTITY; n];
        compute_globals(skeleton, initial_locals, Mat4::IDENTITY, &mut globals, None);

        let mut groups = Vec::with_capacity(config.bone_groups.len());
        let mut colliders = Vec::new();
        let mut joints = Vec::new();
        for (gi, group) in config.bone_groups.iter().enumerate() {
            let start = colliders.len() as u32;
            for &cgi in &group.collider_group_indices {
                let Some(cg) = config.collider_groups.get(cgi) else {
                    log::warn!("spring group {gi}: collider group {cgi} out of range");
                    continue;
                };
                if cg.node >= n {
                    log::warn!("collider group {cgi}: node {} out of range", cg.node);
                    continue;
                }
                for s in &cg.spheres {
                    colliders.push(ColliderRef {
                        node: cg.node,
                        offset: s.offset,
                        radius: s.radius,
                    });
                }
            }
            groups.push(GroupParams {
                stiffness: group.stiffness,
                drag: group.drag_force.clamp(0.0, 1.0),
                gravity_dir: group.gravity_dir.try_normalize().unwrap_or(Vec3::NEG_Y),
                gravity_power: group.gravity_power,
                hit_radius: group.hit_radius,
                colliders: (start, colliders.len() as u32),
            });

            // Walk every descendant chain of every root bone, parents first.
            let mut stack: Vec<usize> = Vec::new();
            for &root in group.bones.iter().rev() {
                if root < n {
                    stack.push(root);
                } else {
                    log::warn!("spring group {gi}: root bone {root} out of range");
                }
            }
            while let Some(node) = stack.pop() {
                for &c in children[node].iter().rev() {
                    stack.push(c);
                }
                // Tail: first child's rest position, or a synthesized 7 cm
                // continuation of the bone for leaves (mirrors UniVRM).
                let local_tail = match children[node].first() {
                    Some(&c) => initial_locals[c].translation,
                    None => leaf_tail(skeleton, &globals, node),
                };
                let Some(bone_axis) = local_tail.try_normalize() else {
                    log::warn!("spring joint at node {node} has a zero-length tail; skipped");
                    continue;
                };
                let tail_world = globals[node].transform_point3(local_tail);
                joints.push(Joint {
                    node,
                    parent: skeleton.parents[node],
                    group: gi as u32,
                    bone_axis,
                    length: local_tail.length(),
                    current_tail: tail_world,
                    prev_tail: tail_world,
                });
            }
        }

        let n_colliders = colliders.len();
        let n_joints = joints.len();
        Self {
            groups,
            colliders,
            joints,
            globals,
            world_rot: vec![Quat::IDENTITY; n],
            anim_rot: vec![Quat::IDENTITY; n_joints],
            collider_world: vec![(Vec3::ZERO, 0.0); n_colliders],
        }
    }

    /// Re-seat all particles at the pose given by `locals` (e.g. after a
    /// teleport), zeroing their velocity.
    pub fn reset(&mut self, skeleton: &Skeleton, locals: &[NodeTrs], root_transform: Mat4) {
        compute_globals(skeleton, locals, root_transform, &mut self.globals, None);
        for joint in &mut self.joints {
            let tail = self.globals[joint.node].transform_point3(joint.bone_axis * joint.length);
            joint.current_tail = tail;
            joint.prev_tail = tail;
        }
    }

    /// Advance the simulation by `dt` seconds and write spring rotations
    /// into `locals`. `locals` should hold the animated pose for the frame;
    /// the solver composes on top of it and recomputes globals incrementally
    /// as it walks each chain. `dt <= 0` is a no-op; large `dt` is clamped
    /// (see [`MAX_SUB_DT`]/[`MAX_SUBSTEPS`]).
    pub fn step(
        &mut self,
        dt: f32,
        skeleton: &Skeleton,
        locals: &mut [NodeTrs],
        root_transform: Mat4,
    ) {
        debug_assert_eq!(locals.len(), skeleton.rest.len());
        if self.joints.is_empty() || dt <= 0.0 || dt.is_nan() {
            return;
        }
        let substeps = ((dt / MAX_SUB_DT).ceil() as usize).clamp(1, MAX_SUBSTEPS);
        let sub_dt = (dt / substeps as f32).min(MAX_SUB_DT);
        let (_, root_rot, _) = root_transform.to_scale_rotation_translation();

        // The frame's animated local rotations, captured before any spring
        // writes so every substep targets the same animated pose.
        for (ji, joint) in self.joints.iter().enumerate() {
            self.anim_rot[ji] = locals[joint.node].rotation;
        }

        for _ in 0..substeps {
            compute_globals(
                skeleton,
                locals,
                root_transform,
                &mut self.globals,
                Some((&mut self.world_rot, root_rot)),
            );
            for (k, c) in self.colliders.iter().enumerate() {
                self.collider_world[k] =
                    (self.globals[c.node].transform_point3(c.offset), c.radius);
            }

            for ji in 0..self.joints.len() {
                let joint = &mut self.joints[ji];
                let g = &self.groups[joint.group as usize];
                let (parent_mat, parent_rot) = if joint.parent == usize::MAX {
                    (root_transform, root_rot)
                } else {
                    (self.globals[joint.parent], self.world_rot[joint.parent])
                };
                let head = parent_mat.transform_point3(locals[joint.node].translation);
                let anim_world_rot = (parent_rot * self.anim_rot[ji]).normalize();
                let rest_dir = anim_world_rot * joint.bone_axis;

                // Verlet: inertia (damped by drag) + stiffness toward the
                // animated rest direction + gravity, then re-normalize to
                // the bone length.
                let mut next = joint.current_tail
                    + (joint.current_tail - joint.prev_tail) * (1.0 - g.drag)
                    + rest_dir * (g.stiffness * sub_dt)
                    + g.gravity_dir * (g.gravity_power * sub_dt);
                next = head + (next - head).try_normalize().unwrap_or(rest_dir) * joint.length;

                // Sphere pushout against the group's colliders.
                let (c0, c1) = g.colliders;
                for &(center, radius) in &self.collider_world[c0 as usize..c1 as usize] {
                    let r = g.hit_radius + radius;
                    if (next - center).length_squared() < r * r {
                        let normal = (next - center).try_normalize().unwrap_or(rest_dir);
                        let pushed = center + normal * r;
                        next = head
                            + (pushed - head).try_normalize().unwrap_or(rest_dir) * joint.length;
                    }
                }

                joint.prev_tail = joint.current_tail;
                joint.current_tail = next;

                // Write back: the rotation taking the animated rest
                // direction to the new tail direction, composed onto the
                // animated rotation, expressed in parent space.
                let tail_dir = (next - head).try_normalize().unwrap_or(rest_dir);
                let world =
                    (Quat::from_rotation_arc(rest_dir, tail_dir) * anim_world_rot).normalize();
                let local = (parent_rot.inverse() * world).normalize();
                let node = joint.node;
                locals[node].rotation = local;
                // Keep globals current for the joints below this one.
                self.globals[node] = parent_mat * locals[node].matrix();
                self.world_rot[node] = world;
            }
        }
    }

    /// Number of simulated joints (useful for diagnostics).
    pub fn joint_count(&self) -> usize {
        self.joints.len()
    }
}

/// Synthesized leaf tail: 7 cm along the bone direction (head minus parent
/// head, in world space), expressed in the leaf's local space.
fn leaf_tail(skeleton: &Skeleton, globals: &[Mat4], node: usize) -> Vec3 {
    let head = globals[node].transform_point3(Vec3::ZERO);
    let parent = skeleton.parents[node];
    let dir = if parent == usize::MAX {
        Vec3::NEG_Y
    } else {
        let parent_head = globals[parent].transform_point3(Vec3::ZERO);
        (head - parent_head).try_normalize().unwrap_or(Vec3::NEG_Y)
    };
    globals[node]
        .inverse()
        .transform_point3(head + dir * LEAF_TAIL_LEN)
}

/// Recompute world matrices (and optionally world rotations) for all nodes,
/// parents first, seeding roots with `root_transform`.
fn compute_globals(
    skeleton: &Skeleton,
    locals: &[NodeTrs],
    root_transform: Mat4,
    globals: &mut [Mat4],
    world_rot: Option<(&mut [Quat], Quat)>,
) {
    match world_rot {
        None => {
            for &i in &skeleton.order {
                let local = locals[i].matrix();
                globals[i] = match skeleton.parents[i] {
                    usize::MAX => root_transform * local,
                    p => globals[p] * local,
                };
            }
        }
        Some((rot, root_rot)) => {
            for &i in &skeleton.order {
                let local = locals[i].matrix();
                match skeleton.parents[i] {
                    usize::MAX => {
                        globals[i] = root_transform * local;
                        rot[i] = (root_rot * locals[i].rotation).normalize();
                    }
                    p => {
                        globals[i] = globals[p] * local;
                        rot[i] = (rot[p] * locals[i].rotation).normalize();
                    }
                }
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::parse::SpringGroup;

    /// A 3-node chain: root (static) → a → b, hanging along +X so gravity
    /// (-Y) has a lever arm to act on.
    fn chain() -> (Skeleton, SpringConfig) {
        let mut rest = vec![NodeTrs::IDENTITY; 3];
        rest[1].translation = glam::Vec3::new(0.1, 0.0, 0.0);
        rest[2].translation = glam::Vec3::new(0.1, 0.0, 0.0);
        let skeleton = Skeleton {
            parents: vec![usize::MAX, 0, 1],
            rest,
            order: vec![0, 1, 2],
        };
        let config = SpringConfig {
            bone_groups: vec![SpringGroup {
                comment: "test".into(),
                stiffness: 1.0,
                gravity_power: 1.0,
                gravity_dir: glam::Vec3::NEG_Y,
                drag_force: 0.4,
                hit_radius: 0.01,
                bones: vec![1],
                collider_group_indices: vec![],
            }],
            collider_groups: vec![],
        };
        (skeleton, config)
    }

    #[test]
    fn joints_cover_subtree_and_leaf_gets_tail() {
        let (skeleton, config) = chain();
        let solver = SpringSolver::new(&config, &skeleton, &skeleton.rest);
        // Node 1 (tail = node 2's rest) and node 2 (synthesized leaf tail).
        assert_eq!(solver.joint_count(), 2);
        assert!((solver.joints[1].length - LEAF_TAIL_LEN).abs() < 1e-6);
    }

    #[test]
    fn gravity_pulls_chain_down_and_dt_zero_is_noop() {
        let (skeleton, config) = chain();
        let rest = skeleton.rest.clone();
        let mut solver = SpringSolver::new(&config, &skeleton, &rest);
        let mut locals = rest.clone();
        solver.step(0.0, &skeleton, &mut locals, Mat4::IDENTITY);
        assert_eq!(locals[1].rotation, rest[1].rotation);
        for _ in 0..120 {
            locals.copy_from_slice(&rest);
            solver.step(1.0 / 60.0, &skeleton, &mut locals, Mat4::IDENTITY);
        }
        // The chain sagged: node 1's spring rotation now tips its child
        // below the horizontal rest line.
        let tip = locals[1].rotation * glam::Vec3::X;
        assert!(tip.y < -0.05, "expected sag, got {tip:?}");
        assert!(locals[1].rotation.is_finite());
    }

    #[test]
    fn reset_reseats_particles() {
        let (skeleton, config) = chain();
        let rest = skeleton.rest.clone();
        let mut solver = SpringSolver::new(&config, &skeleton, &rest);
        let mut locals = rest.clone();
        for _ in 0..30 {
            locals.copy_from_slice(&rest);
            solver.step(1.0 / 60.0, &skeleton, &mut locals, Mat4::IDENTITY);
        }
        solver.reset(&skeleton, &rest, Mat4::IDENTITY);
        let expected = skeleton.rest[2].translation.length();
        let head = glam::Vec3::new(0.1, 0.0, 0.0);
        assert!(((solver.joints[0].current_tail - head).length() - expected).abs() < 1e-5);
        assert_eq!(solver.joints[0].current_tail, solver.joints[0].prev_tail);
    }
}
