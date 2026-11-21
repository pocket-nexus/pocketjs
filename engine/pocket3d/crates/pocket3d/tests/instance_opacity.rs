//! Run explicitly on a machine with a wgpu adapter.
use glam::{Mat4, Vec3};
use pocket3d::{
    camera::Camera,
    gpu::{Gpu, OFFSCREEN_FORMAT, OffscreenTarget},
    hud::Hud,
    model::{ModelAsset, ModelInstance, ModelVertex},
    renderer::Renderer,
    scene::Scene,
};

#[test]
#[ignore = "requires a wgpu adapter; run with --ignored"]
fn opaque_and_cutout_instances_fade_without_hiding_the_background() {
    let gpu = Gpu::new_headless().unwrap();
    let mut renderer = Renderer::new(&gpu, OFFSCREEN_FORMAT).unwrap();
    let verts = [
        [-1.0, -1.0, 0.0],
        [1.0, -1.0, 0.0],
        [1.0, 1.0, 0.0],
        [-1.0, 1.0, 0.0],
    ]
    .map(|pos| ModelVertex {
        pos,
        normal: [0.0, 0.0, 1.0],
        uv: [0.5, 0.5],
        joints: [0; 4],
        weights: [1.0, 0.0, 0.0, 0.0],
    });
    let asset = ModelAsset::from_geometry(
        &gpu,
        &renderer.model_material_layout,
        &renderer.samplers,
        "opacity fixture",
        &verts,
        &[0, 1, 2, 0, 2, 3],
        None,
    );
    let target = OffscreenTarget::new(&gpu, 32, 32);
    let camera = Camera {
        pos: Vec3::new(0.0, 0.0, 3.0),
        znear: 0.1,
        ..Default::default()
    };
    for cutout in [0.0, 0.5] {
        for opacity in [0.0, 0.25, 1.0] {
            let mut scene = Scene {
                draw_sky: false,
                ..Default::default()
            };
            let mut front = ModelInstance::new(asset.clone());
            front.tint = [1.0, 0.0, 0.0, opacity];
            front.lit = 0.0;
            front.cutout = cutout;
            let mut back = ModelInstance::new(asset.clone());
            back.transform = Mat4::from_translation(Vec3::NEG_Z * 0.2);
            back.tint = [0.0, 0.0, 1.0, 1.0];
            back.lit = 0.0;
            // Front-first input order must still draw opaque background first.
            scene.models = vec![front, back];
            renderer.render(
                &gpu,
                &target.view,
                (32, 32),
                &scene,
                &camera,
                &Hud::default(),
            );
            let rgba = target.read_rgba(&gpu).unwrap();
            let pixel = &rgba[(16 * 32 + 16) * 4..(16 * 32 + 16) * 4 + 4];
            if opacity == 0.0 {
                assert!(pixel[0] < 5 && pixel[2] > 245, "{pixel:?}");
            } else if opacity == 1.0 {
                assert!(pixel[0] > 245 && pixel[2] < 5, "{pixel:?}");
            } else {
                assert!(
                    pixel[0] > 30 && pixel[0] < 200 && pixel[2] > 150,
                    "{cutout}: {pixel:?}"
                );
            }
        }
    }
}
