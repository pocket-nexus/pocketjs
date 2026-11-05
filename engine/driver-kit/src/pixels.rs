//! Byte-exact CPU renderer checks using caller-supplied golden pixels.
use alloc::vec;
use pocket_drivers::*;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum PixelViolation {
    Geometry,
    Descriptor,
    Render(RenderError),
    Wait(RenderError),
    Pixels,
    Padding,
}

/// Exercise the supplied renderer using an unaligned CPU allocation and row
/// padding. Expected pixels are tightly packed rows for this acquired region.
/// The renderer owns completion/retirement; the caller supplies the scene and
/// pixel oracle, so the test never compares the renderer with itself.
pub fn check_cpu_frame(
    renderer: &mut impl Renderer,
    list: &DrawList,
    resources: &dyn RenderResources,
    region: Rect,
    format: PixelFormat,
    stride: usize,
    expected: &[u8],
) -> Result<(), PixelViolation> {
    let row = format
        .row_bytes(region.width)
        .ok_or(PixelViolation::Geometry)?;
    let packed = row
        .checked_mul(region.height as usize)
        .ok_or(PixelViolation::Geometry)?;
    let size = stride
        .checked_mul(region.height as usize)
        .ok_or(PixelViolation::Geometry)?;
    if region.width == 0 || region.height == 0 || stride < row || packed != expected.len() {
        return Err(PixelViolation::Geometry);
    }
    let descriptor = renderer.descriptor();
    if descriptor.target_ownership() != TargetOwnership::CpuVisible
        || descriptor.synchronization() != Synchronization::Immediate
        || !descriptor.formats().contains(&format)
        || descriptor.draw_list_version() != pocket_spec::DRAW_LIST_VERSION
    {
        return Err(PixelViolation::Descriptor);
    }
    let length = size.checked_add(2).ok_or(PixelViolation::Geometry)?;
    let mut bytes = vec![0xA7; length];
    {
        let damage = [region];
        let surface = Surface::new(&mut bytes[1..=size], region, stride, format)
            .map_err(|_| PixelViolation::Geometry)?;
        let mut frame = FrameInput::new(list, resources, &damage, Target::CpuVisible(surface));
        let submission = renderer
            .render(&mut frame)
            .map_err(PixelViolation::Render)?;
        let waited = renderer.wait(&submission);
        renderer.retire(submission);
        waited.map_err(PixelViolation::Wait)?;
    }
    for y in 0..region.height as usize {
        let at = 1 + y * stride;
        if bytes[at..at + row] != expected[y * row..(y + 1) * row] {
            return Err(PixelViolation::Pixels);
        }
        if bytes[at + row..at + stride]
            .iter()
            .any(|byte| *byte != 0xA7)
        {
            return Err(PixelViolation::Padding);
        }
    }
    if bytes[0] != 0xA7 || bytes[length - 1] != 0xA7 {
        return Err(PixelViolation::Padding);
    }
    Ok(())
}
