//! The Pocket Studio workshop: baked meshes and ASTC atlases from room.pak,
//! the camera rig that flies between the manifest's poses, and the props the
//! room shows live (game cases, this console, laptop and TV screens, glows).
use pocket_arcade::{
    gl::*,
    math::{self, Mat4, Vec3},
    render::Renderer,
    world::{Scene, STRIDE},
};
use serde_json::Value;
use std::{collections::HashMap, ffi::c_void, path::Path};

const VERTEX: &str = "#version 300 es
in vec3 a_pos;
in vec2 a_uv;
uniform mat4 u_vp;
out mediump vec2 v_uv;
void main() {
  v_uv = a_uv;
  gl_Position = u_vp * vec4(a_pos, 1.0);
}
";
const FRAGMENT: &str = "#version 300 es
precision mediump float;
uniform sampler2D u_map;
uniform lowp vec4 u_tint;
in mediump vec2 v_uv;
out vec4 out_color;
void main() {
  out_color = texture(u_map, v_uv) * u_tint;
}
";
const GLOW_VERTEX: &str = "#version 300 es
in vec2 a_corner;
uniform mat4 u_vp;
uniform vec3 u_center;
uniform vec3 u_right;
uniform vec3 u_up;
uniform float u_size;
out mediump vec2 v_at;
void main() {
  v_at = a_corner;
  gl_Position = u_vp * vec4(u_center + (u_right * a_corner.x + u_up * a_corner.y) * u_size, 1.0);
}
";
const GLOW_FRAGMENT: &str = "#version 300 es
precision mediump float;
uniform lowp vec4 u_color;
in mediump vec2 v_at;
out vec4 out_color;
void main() {
  float d = max(1.0 - length(v_at), 0.0);
  out_color = vec4(u_color.rgb, u_color.a * d * d);
}
";

#[derive(Clone, Copy, Debug)]
pub struct Pose {
    pub position: Vec3,
    pub target: Vec3,
    pub fit: [f32; 2],
}

fn vec3(value: &Value) -> Vec3 {
    let n = |i: usize| value[i].as_f64().unwrap_or(0.0) as f32;
    [n(0), n(1), n(2)]
}

fn ease(t: f32) -> f32 {
    let t = t.clamp(0.0, 1.0);
    t * t * (3.0 - 2.0 * t)
}

/// Flies between poses along a lifted arc, as the web room's rig does. The fov
/// comes from each pose's fit rectangle, so a pose frames the same content at
/// any aspect. `shift` moves the picture sideways to make room for a card.
pub struct Rig {
    from: Pose,
    to: Pose,
    t: f32,
    duration: f32,
    pub shift: f32,
    shown_shift: f32,
    pub orbit: [f32; 2],
    shown_orbit: [f32; 2],
    pub time: f32,
    aspect: f32,
    pub eye: Vec3,
    pub view_projection: Mat4,
}

impl Rig {
    pub fn new(pose: Pose, aspect: f32) -> Self {
        Self {
            from: pose,
            to: pose,
            t: 1.0,
            duration: 1.0,
            shift: 0.0,
            shown_shift: 0.0,
            orbit: [0.0; 2],
            shown_orbit: [0.0; 2],
            time: 0.0,
            aspect,
            eye: pose.position,
            view_projection: [0.0; 16],
        }
    }

    pub fn go(&mut self, pose: Pose, seconds: f32) {
        self.from = self.current();
        self.to = pose;
        self.t = 0.0;
        self.duration = seconds.max(0.01);
    }

    pub fn settled(&self) -> bool {
        self.t >= 1.0
    }

    fn current(&self) -> Pose {
        let k = ease(self.t);
        let mut position = math::lerp(self.from.position, self.to.position, k);
        let distance = {
            let d = math::sub(self.to.position, self.from.position);
            math::dot(d, d).sqrt()
        };
        position[1] += (self.t.clamp(0.0, 1.0) * std::f32::consts::PI).sin() * distance * 0.08;
        Pose {
            position,
            target: math::lerp(self.from.target, self.to.target, k),
            fit: [
                self.from.fit[0] + (self.to.fit[0] - self.from.fit[0]) * k,
                self.from.fit[1] + (self.to.fit[1] - self.from.fit[1]) * k,
            ],
        }
    }

    pub fn update(&mut self, dt: f32) {
        self.time += dt;
        self.t = (self.t + dt / self.duration).min(1.0);
        let follow = 1.0 - (-8.0 * dt).exp();
        self.shown_shift += (self.shift - self.shown_shift) * follow;
        self.shown_orbit[0] += (self.orbit[0] - self.shown_orbit[0]) * follow;
        self.shown_orbit[1] += (self.orbit[1] - self.shown_orbit[1]) * follow;

        let pose = self.current();
        let arm = math::sub(pose.position, pose.target);
        let length = math::dot(arm, arm).sqrt().max(0.01);
        // Idle drift plus the right stick, both turning the arm around the target.
        let azimuth = arm[0].atan2(arm[2]) + self.shown_orbit[0] + (self.time * 0.31).sin() * 0.012;
        let elevation =
            ((arm[1] / length).asin() + self.shown_orbit[1] + (self.time * 0.23).sin() * 0.006)
                .clamp(-1.4, 1.4);
        let turned = [
            azimuth.sin() * elevation.cos() * length,
            elevation.sin() * length,
            azimuth.cos() * elevation.cos() * length,
        ];
        self.eye = [
            pose.target[0] + turned[0],
            pose.target[1] + turned[1],
            pose.target[2] + turned[2],
        ];
        let half = (pose.fit[1] / 2.0).max(pose.fit[0] / (2.0 * self.aspect));
        let fov = 2.0 * (half / length).atan();
        let mut projection = math::perspective(fov, self.aspect, (length * 0.02).max(0.02), 60.0);
        // A lens shift keeps straight lines straight while the picture slides.
        projection[8] = -self.shown_shift;
        self.view_projection = math::multiply(
            &projection,
            &math::look_at(self.eye, pose.target, [0.0, 1.0, 0.0]),
        );
    }
}

struct Part {
    vao: u32,
    index_count: i32,
    texture: u32,
}

/// Positions and yaw of an anchored spot.
#[derive(Clone, Copy, Debug)]
pub struct Spot {
    pub position: Vec3,
    pub yaw: f32,
    pub tilt: f32,
}

pub struct Room {
    program: u32,
    vp_at: i32,
    tint_at: i32,
    parts: Vec<Part>,
    glow_program: u32,
    glow_at: [i32; 6],
    glow_vao: u32,
    quad_vao: u32,
    quad_buffer: u32,
    glows: Vec<(Vec3, [f32; 3], f32)>,
    pub poses: HashMap<String, Pose>,
    pub slots: Vec<Spot>,
    pub play_spot: Spot,
    pub build_spot: Spot,
    pub laptop_screen: [Vec3; 4],
    pub tv_screen: [Vec3; 4],
    pub agent_spot: Vec3,
    pub rig: Rig,
    props: Vec<f32>,
    scene: Scene,
}

fn spot(value: &Value) -> Spot {
    Spot {
        position: vec3(&value["position"]),
        yaw: value["yaw"].as_f64().unwrap_or(0.0) as f32,
        tilt: value["tilt"].as_f64().unwrap_or(0.0) as f32,
    }
}

fn corners(value: &Value) -> [Vec3; 4] {
    [
        vec3(&value[0]),
        vec3(&value[1]),
        vec3(&value[2]),
        vec3(&value[3]),
    ]
}

fn hex(text: &str) -> [f32; 3] {
    let v = u32::from_str_radix(text.trim_start_matches('#'), 16).unwrap_or(0xffffff);
    [
        ((v >> 16) & 255) as f32 / 255.0,
        ((v >> 8) & 255) as f32 / 255.0,
        (v & 255) as f32 / 255.0,
    ]
}

impl Room {
    /// # Safety
    /// A GLES 3 context must be current on this thread.
    pub unsafe fn load(path: &Path, aspect: f32) -> anyhow::Result<Self> {
        let file =
            std::fs::read(path).map_err(|error| anyhow::anyhow!("{}: {error}", path.display()))?;
        anyhow::ensure!(
            file.len() > 12 && &file[..4] == b"PSRM",
            "{} is not a room file",
            path.display()
        );
        let header_bytes = u32::from_le_bytes([file[8], file[9], file[10], file[11]]) as usize;
        let header: Value = serde_json::from_slice(&file[12..12 + header_bytes])?;

        let mut textures: HashMap<String, u32> = HashMap::new();
        for (name, atlas) in header["atlases"]
            .as_object()
            .ok_or_else(|| anyhow::anyhow!("no atlases"))?
        {
            let mut texture = 0;
            glGenTextures(1, &mut texture);
            glBindTexture(TEXTURE_2D, texture);
            for (level, entry) in atlas["levels"].as_array().unwrap().iter().enumerate() {
                let size = entry["size"].as_i64().unwrap() as i32;
                let offset = entry["offset"].as_u64().unwrap() as usize;
                let bytes = entry["bytes"].as_u64().unwrap() as usize;
                glCompressedTexImage2D(
                    TEXTURE_2D,
                    level as i32,
                    COMPRESSED_RGBA_ASTC_4X4,
                    size,
                    size,
                    0,
                    bytes as i32,
                    file[offset..offset + bytes].as_ptr() as *const c_void,
                );
            }
            let levels = atlas["levels"].as_array().unwrap().len() as i32;
            glTexParameteri(TEXTURE_2D, 0x813d, levels - 1); // TEXTURE_MAX_LEVEL
            glTexParameteri(TEXTURE_2D, TEXTURE_MIN_FILTER, LINEAR_MIPMAP_LINEAR);
            glTexParameteri(TEXTURE_2D, TEXTURE_MAG_FILTER, LINEAR);
            glTexParameteri(TEXTURE_2D, TEXTURE_WRAP_S, CLAMP_TO_EDGE);
            glTexParameteri(TEXTURE_2D, TEXTURE_WRAP_T, CLAMP_TO_EDGE);
            textures.insert(name.clone(), texture);
        }

        let mut parts = Vec::new();
        for mesh in header["meshes"]
            .as_array()
            .ok_or_else(|| anyhow::anyhow!("no meshes"))?
        {
            let vertex_offset = mesh["vertices"]["offset"].as_u64().unwrap() as usize;
            let vertex_count = mesh["vertices"]["count"].as_u64().unwrap() as usize;
            let index_offset = mesh["indices"]["offset"].as_u64().unwrap() as usize;
            let index_count = mesh["indices"]["count"].as_u64().unwrap() as usize;
            let (mut vao, mut vertex_buffer, mut index_buffer) = (0, 0, 0);
            glGenVertexArrays(1, &mut vao);
            glBindVertexArray(vao);
            glGenBuffers(1, &mut vertex_buffer);
            glBindBuffer(ARRAY_BUFFER, vertex_buffer);
            glBufferData(
                ARRAY_BUFFER,
                (vertex_count * 20) as isize,
                file[vertex_offset..].as_ptr() as *const c_void,
                STATIC_DRAW,
            );
            glEnableVertexAttribArray(0);
            glVertexAttribPointer(0, 3, FLOAT, 0, 20, std::ptr::null());
            glEnableVertexAttribArray(1);
            glVertexAttribPointer(1, 2, FLOAT, 0, 20, 12 as *const c_void);
            glGenBuffers(1, &mut index_buffer);
            glBindBuffer(ELEMENT_ARRAY_BUFFER, index_buffer);
            glBufferData(
                ELEMENT_ARRAY_BUFFER,
                (index_count * 4) as isize,
                file[index_offset..].as_ptr() as *const c_void,
                STATIC_DRAW,
            );
            glBindVertexArray(0);
            let atlas = mesh["atlas"].as_str().unwrap_or("");
            parts.push(Part {
                vao,
                index_count: index_count as i32,
                texture: *textures
                    .get(atlas)
                    .ok_or_else(|| anyhow::anyhow!("mesh names atlas {atlas}"))?,
            });
        }

        let program = program(VERTEX, FRAGMENT, &["a_pos", "a_uv"])?;
        let vp_at = uniform(program, "u_vp");
        let tint_at = uniform(program, "u_tint");
        let glow_program = self::program(GLOW_VERTEX, GLOW_FRAGMENT, &["a_corner"])?;
        let glow_at = [
            uniform(glow_program, "u_vp"),
            uniform(glow_program, "u_center"),
            uniform(glow_program, "u_right"),
            uniform(glow_program, "u_up"),
            uniform(glow_program, "u_size"),
            uniform(glow_program, "u_color"),
        ];
        let (mut glow_vao, mut glow_buffer, mut quad_vao, mut quad_buffer) = (0, 0, 0, 0);
        glGenVertexArrays(1, &mut glow_vao);
        glBindVertexArray(glow_vao);
        glGenBuffers(1, &mut glow_buffer);
        glBindBuffer(ARRAY_BUFFER, glow_buffer);
        let corners_data: [f32; 8] = [-1.0, -1.0, 1.0, -1.0, 1.0, 1.0, -1.0, 1.0];
        glBufferData(
            ARRAY_BUFFER,
            32,
            corners_data.as_ptr() as *const c_void,
            STATIC_DRAW,
        );
        glEnableVertexAttribArray(0);
        glVertexAttribPointer(0, 2, FLOAT, 0, 8, std::ptr::null());
        glGenVertexArrays(1, &mut quad_vao);
        glBindVertexArray(quad_vao);
        glGenBuffers(1, &mut quad_buffer);
        glBindBuffer(ARRAY_BUFFER, quad_buffer);
        glBufferData(ARRAY_BUFFER, 80, std::ptr::null(), STREAM_DRAW);
        glEnableVertexAttribArray(0);
        glVertexAttribPointer(0, 3, FLOAT, 0, 20, std::ptr::null());
        glEnableVertexAttribArray(1);
        glVertexAttribPointer(1, 2, FLOAT, 0, 20, 12 as *const c_void);
        glBindVertexArray(0);

        let mut poses = HashMap::new();
        for (name, pose) in header["cameras"]
            .as_object()
            .ok_or_else(|| anyhow::anyhow!("no cameras"))?
        {
            poses.insert(
                name.clone(),
                Pose {
                    position: vec3(&pose["position"]),
                    target: vec3(&pose["target"]),
                    fit: [
                        pose["fit"][0].as_f64().unwrap_or(1.0) as f32,
                        pose["fit"][1].as_f64().unwrap_or(1.0) as f32,
                    ],
                },
            );
        }
        let anchors = &header["anchors"];
        let glows = header["glows"]
            .as_array()
            .map(|list| {
                list.iter()
                    .map(|glow| {
                        (
                            vec3(&glow["position"]),
                            hex(glow["color"].as_str().unwrap_or("#ffffff")),
                            glow["size"].as_f64().unwrap_or(0.1) as f32,
                        )
                    })
                    .collect()
            })
            .unwrap_or_default();
        let overview = *poses
            .get("overview")
            .ok_or_else(|| anyhow::anyhow!("no overview camera"))?;
        let mut scene = Scene {
            clear: false,
            ..Scene::default()
        };
        scene.sun = [-0.68, -0.45, -0.58];
        scene.sun_color = [0.55, 0.42, 0.3];
        scene.ambient_top = [0.72, 0.62, 0.78];
        scene.ambient_bottom = [0.33, 0.25, 0.36];
        scene.fog_near = 100.0;
        scene.fog_far = 200.0;
        Ok(Self {
            program,
            vp_at,
            tint_at,
            parts,
            glow_program,
            glow_at,
            glow_vao,
            quad_vao,
            quad_buffer,
            glows,
            poses,
            slots: anchors["appSlots"]
                .as_array()
                .map(|list| list.iter().map(spot).collect())
                .unwrap_or_default(),
            play_spot: spot(&anchors["playSpot"]),
            build_spot: spot(&anchors["buildSpot"]),
            laptop_screen: corners(&anchors["laptopScreen"]["corners"]),
            tv_screen: corners(&anchors["tvScreen"]["corners"]),
            agent_spot: vec3(&anchors["agentSpots"]["codex"]["position"]),
            rig: Rig::new(overview, aspect),
            props: Vec::new(),
            scene,
        })
    }

    pub fn pose(&self, name: &str) -> Option<Pose> {
        self.poses.get(name).copied()
    }

    /// World point to overlay logical pixels (640x360); `None` when behind.
    pub fn project(&self, point: Vec3) -> Option<[f32; 2]> {
        let clip = math::project(&self.rig.view_projection, point)?;
        Some([(clip[0] * 0.5 + 0.5) * 640.0, (0.5 - clip[1] * 0.5) * 360.0])
    }

    /// # Safety
    /// The context that loaded this room must be current on this thread.
    pub unsafe fn draw_shell(&self) {
        glEnable(DEPTH_TEST);
        glDepthFunc(LEQUAL);
        glDepthMask(1);
        glDisable(BLEND);
        glDisable(CULL_FACE);
        glDisable(SCISSOR_TEST);
        glClearColor(0.09, 0.07, 0.15, 1.0);
        glClear(COLOR_BUFFER_BIT | DEPTH_BUFFER_BIT);
        glUseProgram(self.program);
        glUniformMatrix4fv(self.vp_at, 1, 0, self.rig.view_projection.as_ptr());
        glUniform4f(self.tint_at, 1.0, 1.0, 1.0, 1.0);
        glActiveTexture(TEXTURE0);
        for part in &self.parts {
            glBindTexture(TEXTURE_2D, part.texture);
            glBindVertexArray(part.vao);
            glDrawElements(TRIANGLES, part.index_count, UNSIGNED_INT, std::ptr::null());
        }
        glBindVertexArray(0);
    }

    pub fn clear_props(&mut self) {
        self.props.clear();
    }

    /// Queue one lit box-like prop.
    #[allow(clippy::too_many_arguments)]
    pub fn prop(
        &mut self,
        shape: f32,
        position: Vec3,
        euler: Vec3,
        scale: Vec3,
        color: [f32; 3],
        emissive: f32,
    ) {
        self.props.extend_from_slice(&[
            position[0],
            position[1],
            position[2],
            euler[0],
            euler[1],
            euler[2],
            scale[0],
            scale[1],
            scale[2],
            color[0],
            color[1],
            color[2],
            emissive,
            shape,
            1.0,
            1.0,
        ]);
        debug_assert_eq!(self.props.len() % STRIDE, 0);
    }

    /// # Safety
    /// The context that loaded this room must be current on this thread.
    pub unsafe fn draw_props(&mut self, renderer: &mut Renderer) {
        self.scene.view_projection = Some(self.rig.view_projection);
        self.scene.eye = self.rig.eye;
        renderer.draw(&self.scene, &self.props, &[], [1280, 720]);
    }

    /// Draw `texture` on a world-space quad given bottom-left, bottom-right,
    /// top-right and top-left corners. `flip` is for canvas textures.
    ///
    /// # Safety
    /// The context that loaded this room must be current on this thread.
    pub unsafe fn draw_screen(
        &self,
        corners: &[Vec3; 4],
        texture: u32,
        flip: bool,
        tint: [f32; 4],
    ) {
        let (bottom, top) = if flip { (0.0, 1.0) } else { (1.0, 0.0) };
        let [bl, br, tr, tl] = *corners;
        let vertices: [f32; 20] = [
            bl[0], bl[1], bl[2], 0.0, bottom, br[0], br[1], br[2], 1.0, bottom, tr[0], tr[1],
            tr[2], 1.0, top, tl[0], tl[1], tl[2], 0.0, top,
        ];
        glEnable(DEPTH_TEST);
        glDisable(CULL_FACE);
        glEnable(0x8037); // POLYGON_OFFSET_FILL
        glPolygonOffset(-2.0, -2.0);
        glUseProgram(self.program);
        glUniformMatrix4fv(self.vp_at, 1, 0, self.rig.view_projection.as_ptr());
        glUniform4f(self.tint_at, tint[0], tint[1], tint[2], tint[3]);
        glActiveTexture(TEXTURE0);
        glBindTexture(TEXTURE_2D, texture);
        glBindVertexArray(self.quad_vao);
        glBindBuffer(ARRAY_BUFFER, self.quad_buffer);
        glBufferData(
            ARRAY_BUFFER,
            80,
            vertices.as_ptr() as *const c_void,
            STREAM_DRAW,
        );
        glDrawArrays(0x0006, 0, 4); // TRIANGLE_FAN
        glBindVertexArray(0);
        glDisable(0x8037);
    }

    /// Additive sprites: the room's practical lights plus `extra` for focus.
    ///
    /// # Safety
    /// The context that loaded this room must be current on this thread.
    pub unsafe fn draw_glows(&self, extra: &[(Vec3, [f32; 3], f32, f32)]) {
        glEnable(DEPTH_TEST);
        glDepthMask(0);
        glEnable(BLEND);
        glBlendFunc(SRC_ALPHA, ONE);
        glDisable(CULL_FACE);
        glUseProgram(self.glow_program);
        let vp = &self.rig.view_projection;
        glUniformMatrix4fv(self.glow_at[0], 1, 0, vp.as_ptr());
        let eye = self.rig.eye;
        glBindVertexArray(self.glow_vao);
        let draw = |center: Vec3, color: [f32; 3], size: f32, alpha: f32| {
            let forward = math::normalize(math::sub(center, eye));
            let right = math::normalize(math::cross(forward, [0.0, 1.0, 0.0]));
            let up = math::cross(right, forward);
            glUniform3f(self.glow_at[1], center[0], center[1], center[2]);
            glUniform3f(self.glow_at[2], right[0], right[1], right[2]);
            glUniform3f(self.glow_at[3], up[0], up[1], up[2]);
            glUniform1f(self.glow_at[4], size);
            glUniform4f(self.glow_at[5], color[0], color[1], color[2], alpha);
            glDrawArrays(0x0006, 0, 4);
        };
        for &(center, color, size) in &self.glows {
            draw(center, color, size, 0.55);
        }
        for &(center, color, size, alpha) in extra {
            draw(center, color, size, alpha);
        }
        glBindVertexArray(0);
        glDepthMask(1);
        glDisable(BLEND);
    }
}

/// Local (x, y, z) on an anchor's frame to world: a lean back by tilt, then yaw.
pub fn on_spot(spot: Spot, local: Vec3) -> Vec3 {
    let (st, ct) = spot.tilt.sin_cos();
    let y = local[1] * ct + local[2] * st;
    let z = -local[1] * st + local[2] * ct;
    let (sy, cy) = spot.yaw.sin_cos();
    [
        spot.position[0] + local[0] * cy + z * sy,
        spot.position[1] + y,
        spot.position[2] - local[0] * sy + z * cy,
    ]
}
