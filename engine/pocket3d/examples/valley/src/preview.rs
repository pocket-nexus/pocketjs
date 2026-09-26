//! A CPU rasterizer for cooked scenes.
//!
//! It exists so the look can be judged, and regressions caught, without a
//! device in the loop. It consumes the same `.p3sn`, the same culling, the
//! same runtime surfaces and the same blend model the Vita backend uses:
//!
//! ```text
//! pixel = albedo x lit + fog.rgb x fog.a
//! ```
//!
//! The device evaluates that as three blended passes through an 8-bit
//! framebuffer; this evaluates it once in float. The two agree on composition,
//! geometry and colour, and differ by the rounding of the intermediate passes,
//! so this is a reference for the image rather than a byte oracle for it.

use std::path::Path;

use glam::{Mat4, Vec3, Vec4};
use pocket3d_scene::cull::{Frustum, VisibleSet};
use pocket3d_scene::format::{MaterialKind, Scene, Texture, VERTEX_STRIDE};
use pocket3d_scene::particles::{self, ParticleSettings};
use pocket3d_scene::runtime::{DynamicMesh, DynamicVertex, ViewPoint};
use pocket3d_scene::sky::{self, SkySettings};
use pocket3d_scene::water::{self, WaterSettings};

use pocket3d_scene::ride;

use crate::scene::{ValleyOptions, drift};

struct Target {
    width: usize,
    height: usize,
    color: Vec<Vec3>,
    depth: Vec<f32>,
}

impl Target {
    fn new(width: usize, height: usize) -> Self {
        Self {
            width,
            height,
            color: vec![Vec3::ZERO; width * height],
            depth: vec![f32::INFINITY; width * height],
        }
    }
}

/// One vertex ready for clipping: clip position plus everything interpolated.
#[derive(Clone, Copy)]
struct Shaded {
    clip: Vec4,
    uv: [f32; 2],
    lit: Vec3,
    fog: Vec3,
    coverage: f32,
    alpha: f32,
}

fn unpack(color: u32) -> (Vec3, f32) {
    (
        Vec3::new(
            (color & 0xff) as f32 / 255.0,
            ((color >> 8) & 0xff) as f32 / 255.0,
            ((color >> 16) & 0xff) as f32 / 255.0,
        ),
        ((color >> 24) & 0xff) as f32 / 255.0,
    )
}

fn lerp_shaded(a: &Shaded, b: &Shaded, t: f32) -> Shaded {
    Shaded {
        clip: a.clip + (b.clip - a.clip) * t,
        uv: [
            a.uv[0] + (b.uv[0] - a.uv[0]) * t,
            a.uv[1] + (b.uv[1] - a.uv[1]) * t,
        ],
        lit: a.lit + (b.lit - a.lit) * t,
        fog: a.fog + (b.fog - a.fog) * t,
        coverage: a.coverage + (b.coverage - a.coverage) * t,
        alpha: a.alpha + (b.alpha - a.alpha) * t,
    }
}

/// Clip a triangle against the near plane, returning a fan of triangles.
fn clip_near(triangle: [Shaded; 3]) -> Vec<[Shaded; 3]> {
    const EPSILON: f32 = 1e-3;
    let inside: Vec<Shaded> = {
        let mut out = Vec::with_capacity(4);
        for index in 0..3 {
            let current = triangle[index];
            let next = triangle[(index + 1) % 3];
            let current_in = current.clip.w > EPSILON;
            let next_in = next.clip.w > EPSILON;
            if current_in {
                out.push(current);
            }
            if current_in != next_in {
                let t = (EPSILON - current.clip.w) / (next.clip.w - current.clip.w);
                out.push(lerp_shaded(&current, &next, t));
            }
        }
        out
    };
    let mut triangles = Vec::new();
    for index in 1..inside.len().saturating_sub(1) {
        triangles.push([inside[0], inside[index], inside[index + 1]]);
    }
    triangles
}

/// How a rasterized surface combines with what is already in the target.
#[derive(Clone, Copy, PartialEq, Eq)]
enum Blend {
    /// Depth-tested and depth-written.
    Opaque,
    /// Alpha-blended, depth-tested, no depth write.
    Alpha,
    /// Additive, depth-tested, no depth write.
    Additive,
    /// Unconditional: the sky, which is behind everything.
    Background,
}

struct Surface<'a> {
    texture: Option<&'a Texture<'a>>,
    blend: Blend,
    /// Multiplies the sampled albedo, the cutout path's flat tint.
    tint: Vec3,
}

fn sample(texture: &Texture<'_>, u: f32, v: f32, level: f32) -> (Vec3, f32) {
    let level = level.clamp(0.0, (texture.levels - 1) as f32);
    let low = level.floor() as u8;
    let high = (low + 1).min(texture.levels - 1);
    let blend = level - low as f32;
    let first = sample_level(texture, u, v, low);
    if blend <= 1e-3 || high == low {
        return first;
    }
    let second = sample_level(texture, u, v, high);
    (
        first.0 + (second.0 - first.0) * blend,
        first.1 + (second.1 - first.1) * blend,
    )
}

fn sample_level(texture: &Texture<'_>, u: f32, v: f32, level: u8) -> (Vec3, f32) {
    let Some((offset, _, width, height)) = texture.level(level) else {
        return (Vec3::ONE, 1.0);
    };
    let x = u * width as f32 - 0.5;
    let y = v * height as f32 - 0.5;
    let x0 = x.floor();
    let y0 = y.floor();
    let fx = x - x0;
    let fy = y - y0;
    let texel = |ix: i32, iy: i32| -> (Vec3, f32) {
        let ix = ix.rem_euclid(width as i32) as usize;
        let iy = iy.rem_euclid(height as i32) as usize;
        let base = offset + (iy * width as usize + ix) * 4;
        (
            Vec3::new(
                texture.data[base] as f32 / 255.0,
                texture.data[base + 1] as f32 / 255.0,
                texture.data[base + 2] as f32 / 255.0,
            ),
            texture.data[base + 3] as f32 / 255.0,
        )
    };
    let (c00, a00) = texel(x0 as i32, y0 as i32);
    let (c10, a10) = texel(x0 as i32 + 1, y0 as i32);
    let (c01, a01) = texel(x0 as i32, y0 as i32 + 1);
    let (c11, a11) = texel(x0 as i32 + 1, y0 as i32 + 1);
    let top = c00 + (c10 - c00) * fx;
    let bottom = c01 + (c11 - c01) * fx;
    let top_alpha = a00 + (a10 - a00) * fx;
    let bottom_alpha = a01 + (a11 - a01) * fx;
    (
        top + (bottom - top) * fy,
        top_alpha + (bottom_alpha - top_alpha) * fy,
    )
}

fn raster(target: &mut Target, triangle: [Shaded; 3], surface: &Surface<'_>) {
    for clipped in clip_near(triangle) {
        raster_clipped(target, clipped, surface);
    }
}

fn raster_clipped(target: &mut Target, triangle: [Shaded; 3], surface: &Surface<'_>) {
    let width = target.width as f32;
    let height = target.height as f32;
    let mut screen = [Vec3::ZERO; 3];
    let mut inverse_w = [0.0f32; 3];
    for index in 0..3 {
        let clip = triangle[index].clip;
        let w = clip.w.max(1e-4);
        inverse_w[index] = 1.0 / w;
        screen[index] = Vec3::new(
            (clip.x / w * 0.5 + 0.5) * width,
            (0.5 - clip.y / w * 0.5) * height,
            clip.z / w,
        );
    }

    let area = (screen[1].x - screen[0].x) * (screen[2].y - screen[0].y)
        - (screen[2].x - screen[0].x) * (screen[1].y - screen[0].y);
    if area.abs() < 1e-7 {
        return;
    }
    // Backfaces are kept: cutout cards are two-sided and the rest is closed.
    let inverse_area = 1.0 / area;

    let min_x = screen.iter().map(|p| p.x).fold(f32::INFINITY, f32::min).floor().max(0.0) as usize;
    let max_x = (screen.iter().map(|p| p.x).fold(f32::NEG_INFINITY, f32::max).ceil())
        .min(width - 1.0)
        .max(0.0) as usize;
    let min_y = screen.iter().map(|p| p.y).fold(f32::INFINITY, f32::min).floor().max(0.0) as usize;
    let max_y = (screen.iter().map(|p| p.y).fold(f32::NEG_INFINITY, f32::max).ceil())
        .min(height - 1.0)
        .max(0.0) as usize;
    if min_x > max_x || min_y > max_y {
        return;
    }

    // One mip level per triangle, from its texel density on screen.
    let mip = surface.texture.map(|texture| {
        let (_, _, texture_width, _) = texture.level(0).unwrap_or((0, 0, 1, 1));
        let uv_area = ((triangle[1].uv[0] - triangle[0].uv[0])
            * (triangle[2].uv[1] - triangle[0].uv[1])
            - (triangle[2].uv[0] - triangle[0].uv[0]) * (triangle[1].uv[1] - triangle[0].uv[1]))
            .abs();
        let texels = uv_area * (texture_width * texture_width) as f32;
        let pixels = area.abs();
        if pixels < 1e-4 || texels < 1e-9 {
            0.0
        } else {
            (0.5 * (texels / pixels).log2()).max(0.0)
        }
    });

    for y in min_y..=max_y {
        for x in min_x..=max_x {
            let px = x as f32 + 0.5;
            let py = y as f32 + 0.5;
            let w0 = ((screen[1].x - px) * (screen[2].y - py)
                - (screen[2].x - px) * (screen[1].y - py))
                * inverse_area;
            let w1 = ((screen[2].x - px) * (screen[0].y - py)
                - (screen[0].x - px) * (screen[2].y - py))
                * inverse_area;
            let w2 = 1.0 - w0 - w1;
            if w0 < 0.0 || w1 < 0.0 || w2 < 0.0 {
                continue;
            }
            let depth = screen[0].z * w0 + screen[1].z * w1 + screen[2].z * w2;
            let offset = y * target.width + x;
            if surface.blend != Blend::Background && depth > target.depth[offset] {
                continue;
            }

            // Perspective-correct attribute interpolation.
            let inverse = inverse_w[0] * w0 + inverse_w[1] * w1 + inverse_w[2] * w2;
            let scale = 1.0 / inverse.max(1e-8);
            let weight = |index: usize, bary: f32| bary * inverse_w[index] * scale;
            let (b0, b1, b2) = (weight(0, w0), weight(1, w1), weight(2, w2));
            let u = triangle[0].uv[0] * b0 + triangle[1].uv[0] * b1 + triangle[2].uv[0] * b2;
            let v = triangle[0].uv[1] * b0 + triangle[1].uv[1] * b1 + triangle[2].uv[1] * b2;
            let lit = triangle[0].lit * b0 + triangle[1].lit * b1 + triangle[2].lit * b2;
            let fog = triangle[0].fog * b0 + triangle[1].fog * b1 + triangle[2].fog * b2;
            let coverage =
                triangle[0].coverage * b0 + triangle[1].coverage * b1 + triangle[2].coverage * b2;
            let vertex_alpha =
                triangle[0].alpha * b0 + triangle[1].alpha * b1 + triangle[2].alpha * b2;

            let (albedo, texture_alpha) = match surface.texture {
                Some(texture) => sample(texture, u, v, mip.unwrap_or(0.0)),
                None => (Vec3::ONE, 1.0),
            };
            let source = albedo * surface.tint * lit + fog * coverage;
            let alpha = texture_alpha * vertex_alpha;

            match surface.blend {
                Blend::Opaque | Blend::Background => {
                    target.color[offset] = source;
                    if surface.blend == Blend::Opaque {
                        target.depth[offset] = depth;
                    }
                }
                Blend::Alpha => {
                    if alpha <= 0.002 {
                        continue;
                    }
                    target.color[offset] = source * alpha + target.color[offset] * (1.0 - alpha);
                }
                Blend::Additive => {
                    if alpha <= 0.002 {
                        continue;
                    }
                    target.color[offset] += source * alpha;
                }
            }
        }
    }
}

fn dynamic_triangle(
    vertices: &[DynamicVertex],
    indices: &[u16],
    triangle: usize,
    view_proj: Mat4,
) -> [Shaded; 3] {
    let mut out = [Shaded {
        clip: Vec4::ZERO,
        uv: [0.0; 2],
        lit: Vec3::ZERO,
        fog: Vec3::ZERO,
        coverage: 0.0,
        alpha: 1.0,
    }; 3];
    for corner in 0..3 {
        let vertex = vertices[indices[triangle * 3 + corner] as usize];
        let (lit, alpha) = unpack(vertex.lit);
        let (fog, coverage) = unpack(vertex.fog);
        out[corner] = Shaded {
            clip: view_proj * vertex.position().extend(1.0),
            uv: [vertex.u, vertex.v],
            lit,
            fog,
            coverage,
            alpha,
        };
    }
    out
}

fn draw_dynamic(
    target: &mut Target,
    mesh: &DynamicMesh,
    view_proj: Mat4,
    surface: &Surface<'_>,
) {
    for triangle in 0..mesh.triangle_count() {
        raster(
            target,
            dynamic_triangle(&mesh.vertices, &mesh.indices, triangle, view_proj),
            surface,
        );
    }
}

/// Render one frame of the drift.
pub fn render(
    scene: &Scene<'_>,
    options: &ValleyOptions,
    time: f32,
    width: u32,
    height: u32,
) -> Vec<u8> {
    let mut target = Target::new(width as usize, height as usize);
    let shot = ride::ride(scene, &drift(options), time);
    let header = scene.header;
    let projection = glam::camera::rh::proj::opengl::perspective(
        header.camera_fov,
        width as f32 / height as f32,
        header.camera_near,
        header.camera_far,
    );
    let forward = (shot.target - shot.eye).normalize_or(Vec3::NEG_Z);
    let view = glam::camera::rh::view::look_to_mat4(shot.eye, forward, Vec3::Y);
    let view_proj = projection * view;
    let viewpoint = ViewPoint::new(shot.eye, forward);

    // Sky first: it has no depth and everything else covers it.
    let sky_settings = SkySettings::default();
    let mut dome = DynamicMesh::new();
    sky::build(&mut dome, scene, &viewpoint, &sky_settings);
    draw_dynamic(
        &mut target,
        &dome,
        view_proj,
        &Surface {
            texture: None,
            blend: Blend::Background,
            tint: Vec3::ONE,
        },
    );
    let mut clouds = DynamicMesh::new();
    sky::build_clouds(&mut clouds, scene, &viewpoint, time, &sky_settings);
    draw_dynamic(
        &mut target,
        &clouds,
        view_proj,
        &Surface {
            texture: role_texture(scene, pocket3d_scene::format::MaterialRole::Cloud),
            blend: Blend::Alpha,
            tint: Vec3::ONE,
        },
    );

    // Cooked geometry, opaque then cutout, in the renderer's own order.
    let mut visible = VisibleSet::new();
    visible.gather(scene, &Frustum::from_view_proj(view_proj), shot.eye);
    for entry in &visible.opaque {
        draw_chunk(&mut target, scene, entry.chunk as usize, view_proj, Vec3::ONE);
    }

    // Water sits between the opaque world and its cutouts, like on device.
    let mut river = DynamicMesh::new();
    water::build(&mut river, scene, &viewpoint, time, &WaterSettings::default());
    draw_dynamic(
        &mut target,
        &river,
        view_proj,
        &Surface {
            texture: role_texture(scene, pocket3d_scene::format::MaterialRole::Water),
            blend: Blend::Opaque,
            tint: Vec3::ONE,
        },
    );
    let mut wake = DynamicMesh::new();
    water::build_wake(
        &mut wake,
        scene,
        &viewpoint,
        shot.boat_position,
        shot.boat_heading,
        1.5,
        time,
    );
    draw_dynamic(
        &mut target,
        &wake,
        view_proj,
        &Surface {
            texture: role_texture(scene, pocket3d_scene::format::MaterialRole::Puff),
            blend: Blend::Alpha,
            tint: Vec3::ONE,
        },
    );

    // The boat, under the runtime transform the device would apply.
    if let Some(boat) = scene.object("boat").copied() {
        let boat_view_proj = view_proj * shot.boat;
        for index in boat.first_chunk as usize
            ..(boat.first_chunk as usize + boat.chunk_count as usize)
        {
            draw_chunk(&mut target, scene, index, boat_view_proj, Vec3::ONE);
        }
    }

    for entry in &visible.translucent {
        draw_chunk(&mut target, scene, entry.chunk as usize, view_proj, Vec3::ONE);
    }

    // Particles last, over everything they can be seen through.
    let particle_settings = ParticleSettings::default();
    for scatter in &scene.scatters {
        let mut mesh = DynamicMesh::new();
        let (role, blend) = match scatter.kind {
            pocket3d_scene::format::ScatterKind::Petal => {
                particles::build_petals(
                    &mut mesh,
                    scene,
                    &viewpoint,
                    time,
                    scatter,
                    &particle_settings,
                );
                (
                    pocket3d_scene::format::MaterialRole::Petal,
                    Blend::Alpha,
                )
            }
            _ => {
                particles::build_mist(
                    &mut mesh,
                    scene,
                    &viewpoint,
                    time,
                    scatter,
                    &particle_settings,
                );
                (pocket3d_scene::format::MaterialRole::Puff, Blend::Alpha)
            }
        };
        draw_dynamic(
            &mut target,
            &mesh,
            view_proj,
            &Surface {
                texture: role_texture(scene, role),
                blend,
                tint: Vec3::ONE,
            },
        );
    }

    let mut out = Vec::with_capacity(target.color.len() * 3);
    for color in &target.color {
        for channel in [color.x, color.y, color.z] {
            out.push((channel.clamp(0.0, 1.0) * 255.0 + 0.5) as u8);
        }
    }
    out
}

fn role_texture<'a>(
    scene: &'a Scene<'a>,
    role: pocket3d_scene::format::MaterialRole,
) -> Option<&'a Texture<'a>> {
    let material = scene.role_material(role)?;
    let texture = scene.materials.get(material as usize)?.texture;
    scene.textures.get(texture as usize)
}

fn draw_chunk(
    target: &mut Target,
    scene: &Scene<'_>,
    index: usize,
    view_proj: Mat4,
    tint: Vec3,
) {
    let Some(chunk) = scene.chunks.get(index) else {
        return;
    };
    let material = scene.materials[chunk.material as usize];
    let texture = scene.textures.get(material.texture as usize);
    let blend = match material.kind {
        MaterialKind::Opaque => Blend::Opaque,
        MaterialKind::Cutout | MaterialKind::Blended => Blend::Alpha,
        MaterialKind::Additive => Blend::Additive,
    };
    let transform = view_proj * chunk.dequantize();
    let surface = Surface {
        texture,
        blend,
        tint,
    };
    let vertex = |local: u16| -> Shaded {
        let base = (chunk.vertex_base as usize + local as usize) * VERTEX_STRIDE;
        let float = |offset: usize| {
            f32::from_le_bytes([
                scene.vertices[base + offset],
                scene.vertices[base + offset + 1],
                scene.vertices[base + offset + 2],
                scene.vertices[base + offset + 3],
            ])
        };
        let word = |offset: usize| {
            u32::from_le_bytes([
                scene.vertices[base + offset],
                scene.vertices[base + offset + 1],
                scene.vertices[base + offset + 2],
                scene.vertices[base + offset + 3],
            ])
        };
        let short = |offset: usize| {
            i16::from_le_bytes([scene.vertices[base + offset], scene.vertices[base + offset + 1]])
                as f32
        };
        let position = Vec3::new(short(16), short(18), short(20));
        let (lit, alpha) = unpack(word(8));
        let (fog, coverage) = unpack(word(12));
        Shaded {
            clip: transform * position.extend(1.0),
            uv: [float(0), float(4)],
            lit,
            fog,
            coverage,
            alpha,
        }
    };
    for triangle in 0..chunk.index_count as usize / 3 {
        let mut corners = [Shaded {
            clip: Vec4::ZERO,
            uv: [0.0; 2],
            lit: Vec3::ZERO,
            fog: Vec3::ZERO,
            coverage: 0.0,
            alpha: 1.0,
        }; 3];
        for corner in 0..3 {
            let index_offset = (chunk.index_base as usize + triangle * 3 + corner) * 2;
            let local = u16::from_le_bytes([
                scene.indices[index_offset],
                scene.indices[index_offset + 1],
            ]);
            corners[corner] = vertex(local);
        }
        raster(target, corners, &surface);
    }
}

/// Write an RGB8 buffer as a PNG.
pub fn write_png(path: &Path, rgb: &[u8], width: u32, height: u32) -> std::io::Result<()> {
    let file = std::fs::File::create(path)?;
    let writer = std::io::BufWriter::new(file);
    let mut encoder = png::Encoder::new(writer, width, height);
    encoder.set_color(png::ColorType::Rgb);
    encoder.set_depth(png::BitDepth::Eight);
    let mut writer = encoder
        .write_header()
        .map_err(|error| std::io::Error::other(error.to_string()))?;
    writer
        .write_image_data(rgb)
        .map_err(|error| std::io::Error::other(error.to_string()))?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::scene::build;

    fn options() -> ValleyOptions {
        ValleyOptions {
            texture_size: 32,
            corridor_near: 80.0,
            corridor_far: -420.0,
            drift_near: 40.0,
            drift_far: -60.0,
            near_tree_spacing: 900.0,
            mid_tree_spacing: 1600.0,
            ..ValleyOptions::default()
        }
    }

    #[test]
    fn a_rendered_frame_is_neither_blank_nor_uniform() {
        let options = options();
        let (bytes, _) = build(&options).unwrap();
        let scene = Scene::parse(&bytes).unwrap();
        let (width, height) = (160u32, 96u32);
        let image = render(&scene, &options, 0.0, width, height);
        assert_eq!(image.len(), (width * height * 3) as usize);
        let first = &image[..3];
        assert!(
            image.chunks_exact(3).any(|pixel| pixel != first),
            "the frame is one flat colour"
        );
        let lit = image.iter().filter(|&&value| value > 24).count();
        assert!(lit > image.len() / 3, "the frame is mostly black");
    }

    #[test]
    fn the_sky_fills_the_top_of_the_frame() {
        let options = options();
        let (bytes, _) = build(&options).unwrap();
        let scene = Scene::parse(&bytes).unwrap();
        let (width, height) = (160u32, 96u32);
        let image = render(&scene, &options, 0.0, width, height);
        let row = |y: u32| {
            let start = (y * width * 3) as usize;
            let slice = &image[start..start + (width * 3) as usize];
            slice.iter().map(|&value| value as u32).sum::<u32>() / (width * 3)
        };
        // The sky band is brighter than the bank in front of the camera.
        assert!(row(2) > row(height - 3), "{} vs {}", row(2), row(height - 3));
    }

    #[test]
    fn the_camera_stays_over_the_river_through_the_drift() {
        let options = options();
        let (bytes, _) = build(&options).unwrap();
        let scene = Scene::parse(&bytes).unwrap();
        for step in 0..8 {
            let time = step as f32 * 7.0;
            let shot = ride::ride(&scene, &drift(&options), time);
            let (center, half_width) = scene.river_at(shot.boat_position.z);
            assert!(
                (shot.boat_position.x - center).abs() < half_width,
                "boat strayed at t={time}"
            );
            assert!(shot.eye.y > scene.header.water_level + 1.0);
        }
    }
}
