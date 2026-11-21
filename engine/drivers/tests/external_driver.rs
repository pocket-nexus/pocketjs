//! An external implementation needs only the public contract crate.
use pocket_drivers::*;

struct Resources;
impl RenderResources for Resources {
    fn viewport(&self) -> (f32, f32) {
        (2.0, 2.0)
    }
    fn raster_revision(&self) -> u64 {
        0
    }
    fn texture(&self, _: i32) -> Option<TexView<'_>> {
        None
    }
    fn font_atlas(&self, _: u8) -> Option<FontView<'_>> {
        None
    }
}

struct Display {
    pixels: [u8; 8],
    transfer_pending: bool,
}
impl DisplayOutput for Display {
    type Token = ();
    fn descriptor(&self) -> DisplayDescriptor {
        DisplayDescriptor::new(
            DisplayRole::Primary,
            2,
            2,
            PixelFormat::Rgb565,
            4,
            TargetOwnership::CpuVisible,
        )
    }
    fn acquire(&mut self, region: Rect) -> Result<Target<'_>, DisplayError> {
        if self.transfer_pending {
            return Err(DisplayError::InvalidTarget);
        }
        Ok(Target::CpuVisible(Surface::new(
            &mut self.pixels,
            region,
            4,
            PixelFormat::Rgb565,
        )?))
    }
    fn flush(&mut self, _: &[Rect]) -> Result<(), DisplayError> {
        self.transfer_pending = true;
        Ok(())
    }
    fn wait(&mut self, _: ()) -> Result<(), DisplayError> {
        self.transfer_pending = false;
        Ok(())
    }
    fn vsync(&mut self) -> VsyncSource {
        VsyncSource::None
    }
}

struct RendererFixture;
impl Renderer for RendererFixture {
    type Submission = ();
    fn descriptor(&self) -> RendererDescriptor {
        RendererDescriptor::new(
            &[PixelFormat::Rgb565],
            TargetOwnership::CpuVisible,
            Synchronization::Immediate,
            spec::DRAW_LIST_VERSION,
            false,
        )
        .unwrap()
    }
    fn render(&mut self, frame: &mut FrameInput<'_>) -> Result<(), RenderError> {
        if !self.descriptor().accepts(&frame.target) {
            return Err(RenderError::Unsupported);
        }
        match &mut frame.target {
            Target::CpuVisible(surface) => {
                surface.pixels_mut().fill(0x3c);
                Ok(())
            }
            _ => Err(RenderError::Unsupported),
        }
    }
    fn wait(&mut self, _: &()) -> Result<(), RenderError> {
        Ok(())
    }
    fn retire(&mut self, _: ()) {}
}

#[test]
fn external_renderer_and_display_use_public_borrowed_types() {
    let mut display = Display {
        pixels: [0; 8],
        transfer_pending: false,
    };
    let mut renderer = RendererFixture;
    let region = Rect::new(0, 0, 2, 2);
    let list = DrawList::new();
    let resources = Resources;
    let target = display.acquire(region).unwrap();
    let damage = [region];
    let mut frame = FrameInput::new(&list, &resources, &damage, target);
    renderer.render(&mut frame).unwrap();
    renderer.wait(&()).unwrap();
    drop(frame);
    display.flush(&[region]).unwrap();
    assert!(display.acquire(region).is_err());
    display.wait(()).unwrap();
    renderer.retire(());
    assert_eq!(display.pixels, [0x3c; 8]);
    assert!(display.acquire(region).is_ok());
}

#[test]
fn cpu_targets_reject_deferred_writes_and_invalid_storage() {
    assert!(RendererDescriptor::new(
        &[PixelFormat::Rgb565],
        TargetOwnership::CpuVisible,
        Synchronization::Deferred,
        spec::DRAW_LIST_VERSION,
        false
    )
    .is_err());
    let mut bytes = [0; 8];
    assert!(Surface::new(&mut bytes, Rect::new(0, 0, 2, 2), 3, PixelFormat::Rgb565).is_err());
    assert!(Surface::new(&mut bytes, Rect::new(0, 0, 2, 3), 4, PixelFormat::Rgb565).is_err());
    assert!(Surface::new(
        &mut bytes,
        Rect::new(0, 0, 1, u32::MAX),
        usize::MAX,
        PixelFormat::Rgb565
    )
    .is_err());
    assert!(Surface::new(&mut bytes, Rect::new(0, 0, 0, 2), 4, PixelFormat::Rgb565).is_err());
}

#[test]
fn packed_pixel_rows_and_strips_bound_writable_bytes() {
    let mut pixels = [0; 12];
    let mut strip =
        Surface::new(&mut pixels, Rect::new(0, 4, 3, 2), 3, PixelFormat::Gray4).unwrap();
    assert_eq!(strip.region(), Rect::new(0, 4, 3, 2));
    assert_eq!(strip.pixels_mut().len(), 5);
    strip.pixels_mut().fill(7);
    drop(strip);
    assert_eq!(pixels, [7, 7, 7, 7, 7, 0, 0, 0, 0, 0, 0, 0]);
    assert_eq!(PixelFormat::Mono1.row_bytes(9), Some(2));
}

struct Buttons;
impl InputSource for Buttons {
    fn classes(&self) -> InputClasses {
        InputClasses::BUTTONS | InputClasses::AXIS_RELATIVE
    }
    fn poll(&mut self, frame: &mut InputFrameBuilder) {
        frame.buttons |= spec::btn::CROSS;
        frame.relative.push(AxisDelta {
            id: abi::POCKET_RELATIVE_AXIS_PRIMARY,
            delta: -90_000,
        });
    }
}

#[test]
fn external_input_contributes_without_wire_encoding() {
    let mut input = Buttons;
    assert!(input.classes().contains(InputClasses::BUTTONS));
    let mut builder = InputFrameBuilder::new();
    input.poll(&mut builder);
    assert_eq!(builder.frame().buttons, spec::btn::CROSS);
    assert_eq!(builder.frame().relative[0].delta, -90_000);
    builder.clear();
    assert_eq!(builder.frame().buttons, 0);
    assert!(builder.frame().relative.is_empty());
}

struct RangeSource(&'static [u8]);
impl PackageSource for RangeSource {
    fn length(&self) -> Result<usize, SourceError> {
        Ok(self.0.len())
    }
    fn range(&mut self, offset: usize, buffer: &mut [u8]) -> Result<usize, SourceError> {
        let remaining = self.0.get(offset..).ok_or(SourceError::OutOfBounds)?;
        let len = remaining.len().min(buffer.len());
        buffer[..len].copy_from_slice(&remaining[..len]);
        Ok(len)
    }
}

#[test]
fn a_range_only_source_does_not_need_contiguous_storage() {
    let mut source = RangeSource(b"package");
    assert_eq!(source.all(), Err(SourceError::Unsupported));
    let mut output = [0; 4];
    assert_eq!(source.range(4, &mut output), Ok(3));
    assert_eq!(&output[..3], b"age");
    assert_eq!(source.range(7, &mut output), Ok(0));
    assert_eq!(source.range(8, &mut output), Err(SourceError::OutOfBounds));
}
