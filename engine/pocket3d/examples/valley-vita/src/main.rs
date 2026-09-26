//! River Valley on PS Vita.
//!
//! The scene is cooked at build time and embedded, so the VPK is
//! self-contained and boots with no side files. Each frame:
//!
//! 1. the sky dome and its cloud band, behind everything;
//! 2. the cooked world, three passes for opaque geometry and one for cutouts;
//! 3. the river, rebuilt around the camera with its reflection and glitter;
//! 4. the boat under the runtime transform, and its wake;
//! 5. blossom and mist.
//!
//! The camera and the hull come from `pocket3d_scene::ride`, which the desktop
//! preview also uses, so a still and a frame on the device are the same shot.

#[cfg(target_os = "vita")]
mod app {
    use glam::Vec3;
    use pocket3d_scene::format::{MaterialRole, Scene, ScatterKind};
    use pocket3d_scene::particles::{self, ParticleSettings};
    use pocket3d_scene::ride::{self, DriftSettings, look_angles};
    use pocket3d_scene::runtime::{DynamicMesh, ViewPoint};
    use pocket3d_scene::sky::{self, SkySettings};
    use pocket3d_scene::water::{self, WaterSettings};
    use pocket3d_vita::dynamic::{DynamicSurface, SurfaceKind};
    use pocket3d_vita::{Camera3d, FramePool, SceneRenderer, SceneStats, begin_3d, end_3d};
    use vita2d_sys as v2d;
    use vitasdk_sys as sdk;

    /// The cooked scene, produced by `build.rs`.
    static SCENE: &[u8] = include_bytes!(concat!(env!("OUT_DIR"), "/valley.p3sn"));

    /// vita2d's per-frame pool has to hold every runtime surface at once.
    const POOL_BYTES: u32 = 4 * 1024 * 1024;

    const FRAME_SECONDS: f32 = 1.0 / 60.0;

    /// Bright enough to notice if the scene ever fails to draw.
    const CLEAR_COLOR: u32 = 0xff20_1810;

    fn buttons() -> u32 {
        let mut pad: sdk::SceCtrlData = unsafe { core::mem::zeroed() };
        unsafe { sdk::sceCtrlPeekBufferPositive(0, &mut pad, 1) };
        pad.buttons
    }

    /// One flat colour for a blended surface, resolved on the CPU because the
    /// stock fragment shader takes a uniform tint rather than a vertex colour.
    fn tint(color: Vec3, alpha: f32) -> [f32; 4] {
        [color.x, color.y, color.z, alpha]
    }

    pub fn run() {
        unsafe {
            assert_eq!(v2d::vita2d_init_advanced(POOL_BYTES), 1);
            v2d::vita2d_set_vblank_wait(1);
            v2d::vita2d_set_clear_color(CLEAR_COLOR);
            sdk::sceCtrlSetSamplingMode(sdk::SCE_CTRL_MODE_ANALOG);

            let scene = match Scene::parse(SCENE) {
                Ok(scene) => scene,
                Err(_) => {
                    // Nothing to draw: leave the screen on its clear colour
                    // rather than faulting, so the failure is visible.
                    loop {
                        v2d::vita2d_start_drawing();
                        v2d::vita2d_clear_screen();
                        v2d::vita2d_end_drawing();
                        v2d::vita2d_swap_buffers();
                    }
                }
            };
            let drift = DriftSettings {
                near: 60.0,
                far: -180.0,
                ..DriftSettings::default()
            };
            let header = scene.header;
            let mut renderer = SceneRenderer::new(scene);
            let _ = renderer.upload();

            let water_texture = renderer.role_texture(MaterialRole::Water);
            let cloud_texture = renderer.role_texture(MaterialRole::Cloud);
            let petal_texture = renderer.role_texture(MaterialRole::Petal);
            let puff_texture = renderer.role_texture(MaterialRole::Puff);

            let mut pool = FramePool::new();
            let mut surface = DynamicSurface::new();
            let mut dome = DynamicMesh::new();
            let mut clouds = DynamicMesh::new();
            let mut river = DynamicMesh::new();
            let mut wake = DynamicMesh::new();
            let mut petals = DynamicMesh::new();
            let mut mist = DynamicMesh::new();

            let sky_settings = SkySettings::default();
            let water_settings = WaterSettings::default();
            let particle_settings = ParticleSettings::default();

            let mut time = 0.0f32;
            let mut paused = false;
            let mut previous = 0u32;

            loop {
                let held = buttons();
                let pressed = held & !previous;
                previous = held;
                if held & sdk::SCE_CTRL_START != 0 {
                    break;
                }
                if pressed & sdk::SCE_CTRL_CROSS != 0 {
                    paused = !paused;
                }
                // Shoulders scrub the drift, which is how a still gets framed.
                if held & sdk::SCE_CTRL_RTRIGGER != 0 {
                    time += FRAME_SECONDS * 20.0;
                }
                if held & sdk::SCE_CTRL_LTRIGGER != 0 {
                    time -= FRAME_SECONDS * 20.0;
                }
                if !paused {
                    time += FRAME_SECONDS;
                }

                let shot = ride::ride(renderer.scene(), &drift, time);
                let (yaw, pitch) = look_angles(shot.eye, shot.target);
                let camera = Camera3d {
                    pos: shot.eye,
                    yaw,
                    pitch,
                    fov_y: header.camera_fov,
                    aspect: pocket3d_vita::SCREEN_WIDTH / pocket3d_vita::SCREEN_HEIGHT,
                    znear: header.camera_near,
                    zfar: header.camera_far,
                };
                let view = ViewPoint::new(shot.eye, (shot.target - shot.eye).normalize());
                let view_proj = camera.view_proj().to_cols_array();

                // Build phase: every runtime surface is produced while the
                // scene is borrowed, so the draw phase below can take the
                // renderer mutably without the borrows overlapping.
                {
                    let scene = renderer.scene();
                    sky::build(&mut dome, scene, &view, &sky_settings);
                    sky::build_clouds(&mut clouds, scene, &view, time, &sky_settings);
                    water::build(&mut river, scene, &view, time, &water_settings);
                    water::build_wake(
                        &mut wake,
                        scene,
                        &view,
                        shot.boat_position,
                        shot.boat_heading,
                        1.5,
                        time,
                    );
                    petals.clear();
                    mist.clear();
                    for scatter in &scene.scatters {
                        match scatter.kind {
                            ScatterKind::Petal => particles::build_petals(
                                &mut petals,
                                scene,
                                &view,
                                time,
                                scatter,
                                &particle_settings,
                            ),
                            _ => particles::build_mist(
                                &mut mist,
                                scene,
                                &view,
                                time,
                                scatter,
                                &particle_settings,
                            ),
                        }
                    }
                }

                pool.reset();
                renderer.reset_stats();
                v2d::vita2d_start_drawing();
                v2d::vita2d_clear_screen();
                begin_3d(&camera);

                let mut dynamic_stats = SceneStats::default();
                surface.draw(
                    &dome,
                    SurfaceKind::Background,
                    core::ptr::null(),
                    tint(Vec3::ONE, 1.0),
                    &view_proj,
                    &mut dynamic_stats,
                );
                surface.draw(
                    &clouds,
                    SurfaceKind::Alpha,
                    cloud_texture,
                    tint(Vec3::ONE, 0.85),
                    &view_proj,
                    &mut dynamic_stats,
                );

                renderer.draw(&camera);

                surface.draw(
                    &river,
                    SurfaceKind::Opaque,
                    water_texture,
                    tint(Vec3::ONE, 1.0),
                    &view_proj,
                    &mut dynamic_stats,
                );
                surface.draw(
                    &wake,
                    SurfaceKind::Alpha,
                    puff_texture,
                    tint(Vec3::ONE, 0.75),
                    &view_proj,
                    &mut dynamic_stats,
                );

                renderer.draw_object("boat", shot.boat, &camera);

                // Particles last, over everything they can be seen through.
                surface.draw(
                    &mist,
                    SurfaceKind::Alpha,
                    puff_texture,
                    tint(Vec3::ONE, particle_settings.mist_opacity),
                    &view_proj,
                    &mut dynamic_stats,
                );
                surface.draw(
                    &petals,
                    SurfaceKind::Alpha,
                    petal_texture,
                    tint(Vec3::ONE, 1.0),
                    &view_proj,
                    &mut dynamic_stats,
                );
                renderer.stats.triangles += dynamic_stats.triangles;
                renderer.stats.submissions += dynamic_stats.submissions;
                renderer.stats.draw_calls += dynamic_stats.draw_calls;
                renderer.stats.dropped_triangles += dynamic_stats.dropped_triangles;
                renderer.stats.submission_errors += dynamic_stats.submission_errors;

                end_3d();
                v2d::vita2d_end_drawing();
                v2d::vita2d_swap_buffers();
            }

            v2d::vita2d_wait_rendering_done();
            renderer.release();
            pocket3d_vita::shutdown();
            v2d::vita2d_fini();
            // Returning ends the process; an explicit exit can fault Vita3K
            // while GXM is still tearing down.
        }
    }

}

#[cfg(target_os = "vita")]
fn main() {
    app::run();
}

#[cfg(not(target_os = "vita"))]
fn main() {
    // The scene still cooks on a desktop; `valley-cook` is how it is inspected.
    println!("valley-vita builds for armv7-sony-vita-newlibeabihf");
}
