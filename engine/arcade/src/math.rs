//! Column-major 4x4 matrices and the few vector helpers the renderer needs.
pub type Mat4 = [f32; 16];
pub type Vec3 = [f32; 3];

pub fn sub(a: Vec3, b: Vec3) -> Vec3 {
    [a[0] - b[0], a[1] - b[1], a[2] - b[2]]
}
pub fn cross(a: Vec3, b: Vec3) -> Vec3 {
    [
        a[1] * b[2] - a[2] * b[1],
        a[2] * b[0] - a[0] * b[2],
        a[0] * b[1] - a[1] * b[0],
    ]
}
pub fn dot(a: Vec3, b: Vec3) -> f32 {
    a[0] * b[0] + a[1] * b[1] + a[2] * b[2]
}
pub fn normalize(a: Vec3) -> Vec3 {
    let length = dot(a, a).sqrt();
    if length <= f32::EPSILON {
        return [0.0, 0.0, 0.0];
    }
    [a[0] / length, a[1] / length, a[2] / length]
}
pub fn lerp(a: Vec3, b: Vec3, t: f32) -> Vec3 {
    [
        a[0] + (b[0] - a[0]) * t,
        a[1] + (b[1] - a[1]) * t,
        a[2] + (b[2] - a[2]) * t,
    ]
}

pub fn perspective(fov_y: f32, aspect: f32, near: f32, far: f32) -> Mat4 {
    let f = 1.0 / (fov_y * 0.5).tan();
    let d = 1.0 / (near - far);
    [
        f / aspect,
        0.0,
        0.0,
        0.0,
        0.0,
        f,
        0.0,
        0.0,
        0.0,
        0.0,
        (far + near) * d,
        -1.0,
        0.0,
        0.0,
        2.0 * far * near * d,
        0.0,
    ]
}

pub fn look_at(eye: Vec3, target: Vec3, up: Vec3) -> Mat4 {
    let forward = normalize(sub(target, eye));
    let right = normalize(cross(forward, up));
    let upward = cross(right, forward);
    [
        right[0],
        upward[0],
        -forward[0],
        0.0,
        right[1],
        upward[1],
        -forward[1],
        0.0,
        right[2],
        upward[2],
        -forward[2],
        0.0,
        -dot(right, eye),
        -dot(upward, eye),
        dot(forward, eye),
        1.0,
    ]
}

pub fn multiply(a: &Mat4, b: &Mat4) -> Mat4 {
    let mut out = [0.0; 16];
    for column in 0..4 {
        for row in 0..4 {
            out[column * 4 + row] = (0..4).map(|k| a[k * 4 + row] * b[column * 4 + k]).sum();
        }
    }
    out
}

/// Clip-space projection of a world point; `None` behind the camera.
pub fn project(matrix: &Mat4, p: Vec3) -> Option<[f32; 3]> {
    let w = matrix[3] * p[0] + matrix[7] * p[1] + matrix[11] * p[2] + matrix[15];
    if w <= 1e-4 {
        return None;
    }
    let x = matrix[0] * p[0] + matrix[4] * p[1] + matrix[8] * p[2] + matrix[12];
    let y = matrix[1] * p[0] + matrix[5] * p[1] + matrix[9] * p[2] + matrix[13];
    let z = matrix[2] * p[0] + matrix[6] * p[1] + matrix[10] * p[2] + matrix[14];
    Some([x / w, y / w, z / w])
}

/// Rows of the affine transform with rotation order Y, X, Z, then scale.
pub fn affine_rows(position: [f32; 3], euler: [f32; 3], scale: [f32; 3]) -> [f32; 12] {
    let (sx, cx) = euler[0].sin_cos();
    let (sy, cy) = euler[1].sin_cos();
    let (sz, cz) = euler[2].sin_cos();
    let r00 = cy * cz + sy * sx * sz;
    let r01 = cz * sy * sx - cy * sz;
    let r02 = cx * sy;
    let r10 = cx * sz;
    let r11 = cx * cz;
    let r12 = -sx;
    let r20 = cy * sx * sz - cz * sy;
    let r21 = cy * cz * sx + sy * sz;
    let r22 = cy * cx;
    [
        r00 * scale[0],
        r01 * scale[1],
        r02 * scale[2],
        position[0],
        r10 * scale[0],
        r11 * scale[1],
        r12 * scale[2],
        position[1],
        r20 * scale[0],
        r21 * scale[1],
        r22 * scale[2],
        position[2],
    ]
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn look_at_centers_the_target() {
        let view = look_at([0.0, 0.0, 5.0], [0.0, 0.0, 0.0], [0.0, 1.0, 0.0]);
        let projection = perspective(1.0, 16.0 / 9.0, 0.1, 100.0);
        let p = project(&multiply(&projection, &view), [0.0, 0.0, 0.0]).unwrap();
        assert!(p[0].abs() < 1e-5 && p[1].abs() < 1e-5);
        assert!(p[2] > -1.0 && p[2] < 1.0);
        assert!(project(&multiply(&projection, &view), [0.0, 0.0, 9.0]).is_none());
    }

    #[test]
    fn affine_identity_keeps_axes() {
        let rows = affine_rows([1.0, 2.0, 3.0], [0.0; 3], [2.0, 2.0, 2.0]);
        assert_eq!(
            rows,
            [2.0, 0.0, 0.0, 1.0, 0.0, 2.0, 0.0, 2.0, 0.0, 0.0, 2.0, 3.0]
        );
    }

    #[test]
    fn yaw_turns_forward_axis() {
        let rows = affine_rows([0.0; 3], [0.0, std::f32::consts::FRAC_PI_2, 0.0], [1.0; 3]);
        // Local +Z maps to world +X.
        assert!((rows[2] - 1.0).abs() < 1e-5 && rows[6].abs() < 1e-5 && rows[10].abs() < 1e-5);
    }
}
