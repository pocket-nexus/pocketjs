//! A device opened with the optional features a game wants and the adapter has.

use pocket_web_wgpu::gpu::Gpu;
use pocket_web_wgpu::task;
use pocket_web_wgpu::wgpu::{self, Features};

#[test]
fn a_device_has_the_wanted_features_its_adapter_has() {
    let wanted = Features::TEXTURE_COMPRESSION_BC | Features::TEXTURE_COMPRESSION_ETC2 | Features::TEXTURE_COMPRESSION_ASTC;
    let gpu = match task::wait(Gpu::headless_wanting(wanted)) {
        Ok(gpu) => gpu,
        Err(error) => {
            eprintln!("skipped: {error}");
            return;
        }
    };
    // Nothing that was not asked for, and the device holds what the kernel says it does.
    assert!(wanted.contains(gpu.features));
    assert_eq!(gpu.device.features() & wanted, gpu.features);
    // A device opened without a wish has none of them.
    let plain = task::wait(Gpu::headless()).unwrap();
    assert!(plain.features.is_empty());
    // A granted format makes a texture: blocks of BC1 where the adapter reads them.
    if gpu.features.contains(Features::TEXTURE_COMPRESSION_BC) {
        gpu.device.push_error_scope(wgpu::ErrorFilter::Validation);
        let _blocks = gpu.device.create_texture(&wgpu::TextureDescriptor {
            label: Some("blocks"),
            size: wgpu::Extent3d { width: 8, height: 8, depth_or_array_layers: 1 },
            mip_level_count: 1,
            sample_count: 1,
            dimension: wgpu::TextureDimension::D2,
            format: wgpu::TextureFormat::Bc1RgbaUnorm,
            usage: wgpu::TextureUsages::TEXTURE_BINDING | wgpu::TextureUsages::COPY_DST,
            view_formats: &[],
        });
        assert!(task::wait(gpu.device.pop_error_scope()).is_none());
    }
    eprintln!("features granted: {:?}", gpu.features);
}
