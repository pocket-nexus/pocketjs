use core::ffi::c_void;
use pocket_drivers::{abi::*, *};
use pocket_runtime_cabi::adapters::*;

#[derive(Default)]
struct Device {
    events: Vec<(u8, u64)>,
    formats: Vec<u32>,
    next: u64,
    fail: bool,
}
unsafe extern "C" fn descriptor(context: *mut c_void, out: *mut PocketRendererDescriptor) -> i32 {
    let device = unsafe { &mut *context.cast::<Device>() };
    unsafe {
        out.write(PocketRendererDescriptor {
            pixel_formats: device.formats.as_ptr(),
            pixel_format_count: device.formats.len(),
            target_kind: POCKET_TARGET_DEVICE_OWNED,
            synchronization: POCKET_SYNC_DEFERRED,
            draw_list_version: POCKET_DRAW_LIST_VERSION,
            ..PocketRendererDescriptor::empty()
        })
    };
    0
}
unsafe extern "C" fn render(
    context: *mut c_void,
    frame: *const PocketFrameInput,
    out: *mut u64,
) -> i32 {
    let device = unsafe { &mut *context.cast::<Device>() };
    let frame = unsafe { PocketFrameInput::read_prefix(frame) }.unwrap();
    assert!(!frame.resources.is_null());
    device.next += 1;
    unsafe { out.write(device.next) };
    device.events.push((0, device.next));
    0
}
unsafe extern "C" fn wait(context: *mut c_void, id: u64) -> i32 {
    let device = unsafe { &mut *context.cast::<Device>() };
    device.events.push((1, id));
    if device.fail {
        -3
    } else {
        0
    }
}
unsafe extern "C" fn retire(context: *mut c_void, id: u64) {
    unsafe { &mut *context.cast::<Device>() }
        .events
        .push((2, id));
}
struct Empty;
impl RenderResources for Empty {
    fn viewport(&self) -> (f32, f32) {
        (4., 4.)
    }
    fn raster_revision(&self) -> u64 {
        1
    }
    fn texture(&self, _: i32) -> Option<TexView<'_>> {
        None
    }
    fn font_atlas(&self, _: u8) -> Option<FontView<'_>> {
        None
    }
}
fn table() -> PocketRendererV1 {
    PocketRendererV1 {
        descriptor: Some(descriptor),
        render: Some(render),
        wait: Some(wait),
        retire: Some(retire),
        ..PocketRendererV1::empty()
    }
}
fn submit(renderer: &mut CRenderer) -> u64 {
    let list = DrawList::default();
    let resources = Empty;
    let mut frame = FrameInput::new(
        &list,
        &resources,
        &[],
        Target::DeviceOwned(DeviceTarget::new(
            7,
            Rect::new(0, 0, 4, 4),
            PixelFormat::Rgba8888,
        )),
    );
    renderer.render(&mut frame).unwrap()
}
#[test]
fn descriptor_copies_formats_and_pending_submissions_retire_out_of_order() {
    let mut device = Device {
        formats: vec![POCKET_PIXEL_FORMAT_RGBA8888],
        ..Device::default()
    };
    let mut renderer =
        unsafe { CRenderer::new(&table(), (&mut device as *mut Device).cast()) }.unwrap();
    device.formats[0] = POCKET_PIXEL_FORMAT_RGB565;
    assert_eq!(renderer.descriptor().formats(), [PixelFormat::Rgba8888]);
    let a = submit(&mut renderer);
    let b = submit(&mut renderer);
    assert!(renderer.wait(&999).is_err());
    renderer.retire(999);
    renderer.retire(b);
    assert_eq!(device.events, [(0, 1), (0, 2), (1, 2), (2, 2)]);
    drop(renderer);
    assert_eq!(
        device.events,
        [(0, 1), (0, 2), (1, 2), (2, 2), (1, 1), (2, 1)]
    );
    assert_ne!(a, b);
}
#[test]
fn terminal_wait_errors_are_not_repolled_and_still_release_exactly_once() {
    let mut device = Device {
        formats: vec![POCKET_PIXEL_FORMAT_RGBA8888],
        fail: true,
        ..Device::default()
    };
    let mut renderer =
        unsafe { CRenderer::new(&table(), (&mut device as *mut Device).cast()) }.unwrap();
    let id = submit(&mut renderer);
    assert_eq!(renderer.wait(&id), Err(RenderError::Failed));
    assert_eq!(renderer.wait(&id), Err(RenderError::Failed));
    renderer.retire(id);
    renderer.retire(id);
    drop(renderer);
    assert_eq!(device.events, [(0, 1), (1, 1), (2, 1)]);
}
#[test]
fn zero_copy_keeps_local_c_headers_until_wait_and_retires_after_presentation() {
    let mut device = Device {
        formats: vec![POCKET_PIXEL_FORMAT_RGBA8888],
        ..Device::default()
    };
    unsafe extern "C" fn zero_descriptor(
        context: *mut c_void,
        out: *mut PocketRendererDescriptor,
    ) -> i32 {
        unsafe {
            descriptor(context, out);
            (*out).zero_copy = 1;
        }
        0
    }
    let mut table = table();
    table.descriptor = Some(zero_descriptor);
    table.render_zero_copy = Some(render);
    let mut renderer =
        unsafe { CRenderer::new(&table, (&mut device as *mut Device).cast()) }.unwrap();
    let list = DrawList::default();
    let resources = Empty;
    let mut frame = FrameInput::new(
        &list,
        &resources,
        &[],
        Target::DeviceOwned(DeviceTarget::new(
            7,
            Rect::new(0, 0, 4, 4),
            PixelFormat::Rgba8888,
        )),
    );
    let id = unsafe { renderer.render_zero_copy(&mut frame) }.unwrap();
    assert_eq!(device.events, [(0, 1), (1, 1)]);
    renderer.wait(&id).unwrap();
    renderer.retire(id);
    assert_eq!(device.events, [(0, 1), (1, 1), (2, 1)]);
}
#[test]
fn input_adapter_copies_extended_records_and_discards_failed_poll_contributions() {
    #[repr(C)]
    struct Extended {
        axis: PocketAxisSample,
        extra: u64,
    }
    struct Context {
        fail: bool,
    }
    unsafe extern "C" fn classes(_: *mut c_void) -> u32 {
        POCKET_INPUT_CLASS_AXIS_ABSOLUTE
    }
    unsafe extern "C" fn poll(context: *mut c_void, builder: *mut PocketInputFrameBuilder) -> i32 {
        let item = Extended {
            axis: PocketAxisSample {
                struct_size: core::mem::size_of::<Extended>(),
                axis: 2,
                value: 0.25,
            },
            extra: 99,
        };
        let frame = PocketInputFrame {
            buttons: 4,
            axes: &item.axis,
            axis_count: 1,
            ..PocketInputFrame::empty()
        };
        let builder = unsafe { PocketInputFrameBuilder::read_prefix(builder) }.unwrap();
        assert_eq!(
            unsafe { builder.append.unwrap()(builder.context, &frame) },
            0
        );
        if unsafe { &*context.cast::<Context>() }.fail {
            -3
        } else {
            0
        }
    }
    let mut context = Context { fail: false };
    let table = PocketInputSourceV1 {
        classes: Some(classes),
        poll: Some(poll),
        ..PocketInputSourceV1::empty()
    };
    let mut input =
        unsafe { CInputSource::new(&table, (&mut context as *mut Context).cast()) }.unwrap();
    let mut frame = InputFrameBuilder::new();
    input.poll(&mut frame);
    assert_eq!(frame.axes, [AxisSample { id: 2, value: 0.25 }]);
    assert_eq!(frame.buttons, 4);
    context.fail = true;
    assert!(context.fail);
    frame.clear();
    input.poll(&mut frame);
    assert!(frame.axes.is_empty());
    assert_eq!(frame.buttons, 0);
    assert_eq!(input.last_error(), Some(AdapterError::Failed));
}
#[test]
fn resource_bridge_writes_only_the_consumers_known_prefix() {
    #[repr(C)]
    struct Short {
        size: usize,
        pixels: *const u8,
        guard: usize,
    }
    struct Resource;
    impl RenderResources for Resource {
        fn viewport(&self) -> (f32, f32) {
            (1., 1.)
        }
        fn raster_revision(&self) -> u64 {
            9
        }
        fn texture(&self, _: i32) -> Option<TexView<'_>> {
            Some(TexView {
                pixels: &[1, 2, 3, 4],
                w: 1,
                h: 1,
                psm: 3,
                palette: None,
                linear: false,
            })
        }
        fn font_atlas(&self, _: u8) -> Option<FontView<'_>> {
            None
        }
    }
    let bridge = ResourceBridge::new(&Resource);
    let header = bridge.header();
    let mut output = Short {
        size: core::mem::offset_of!(Short, guard),
        pixels: core::ptr::null(),
        guard: 0x1234,
    };
    assert_eq!(
        unsafe { header.texture.unwrap()(header.context, 0, (&mut output as *mut Short).cast()) },
        0
    );
    assert!(!output.pixels.is_null());
    assert_eq!(output.guard, 0x1234);
}

struct Panel {
    pixels: [[u8; 16]; 2],
    surface: PocketSurface,
    slot: usize,
    short_identity: bool,
    waits: Vec<u64>,
}
unsafe extern "C" fn panel_descriptor(_: *mut c_void, out: *mut PocketDisplayDescriptor) -> i32 {
    unsafe {
        out.write(PocketDisplayDescriptor {
            role: POCKET_DISPLAY_ROLE_PRIMARY,
            width: 2,
            height: 2,
            pixel_format: POCKET_PIXEL_FORMAT_RGBA8888,
            stride_bytes: 8,
            target_kind: POCKET_TARGET_CPU_VISIBLE,
            flags: POCKET_DISPLAY_DOUBLE_BUFFERED
                | POCKET_DISPLAY_PIPELINED_ACQUIRE
                | POCKET_DISPLAY_FRAME_STORAGE,
            refresh_width: 1,
            refresh_height: 1,
            window_x_alignment: 1,
            window_y_alignment: 1,
            ..PocketDisplayDescriptor::empty()
        });
    }
    POCKET_STATUS_OK
}
unsafe extern "C" fn panel_identity(context: *mut c_void, out: *mut PocketBufferIdentity) -> i32 {
    let panel = unsafe { &mut *context.cast::<Panel>() };
    unsafe {
        out.write(PocketBufferIdentity {
            struct_size: if panel.short_identity {
                core::mem::offset_of!(PocketBufferIdentity, generation)
            } else {
                core::mem::size_of::<PocketBufferIdentity>()
            },
            buffer: 17,
            generation: 23,
        });
    }
    POCKET_STATUS_OK
}
unsafe extern "C" fn panel_acquire(
    context: *mut c_void,
    region: *const PocketRect,
    out: *mut PocketTarget,
) -> i32 {
    let panel = unsafe { &mut *context.cast::<Panel>() };
    panel.surface = PocketSurface {
        pixels: panel.pixels[panel.slot].as_mut_ptr(),
        byte_length: 16,
        stride_bytes: 8,
        pixel_format: POCKET_PIXEL_FORMAT_RGBA8888,
        region,
        ..PocketSurface::empty()
    };
    unsafe {
        out.write(PocketTarget {
            kind: POCKET_TARGET_CPU_VISIBLE,
            pixel_format: POCKET_PIXEL_FORMAT_RGBA8888,
            region,
            surface: &mut panel.surface,
            ..PocketTarget::empty()
        });
    }
    POCKET_STATUS_OK
}
unsafe extern "C" fn panel_flush(
    context: *mut c_void,
    _: *const PocketRect,
    _: usize,
    out: *mut u64,
) -> i32 {
    let panel = unsafe { &mut *context.cast::<Panel>() };
    unsafe {
        out.write(panel.slot as u64);
    }
    POCKET_STATUS_OK
}
unsafe extern "C" fn panel_wait(context: *mut c_void, token: u64) -> i32 {
    unsafe { &mut *context.cast::<Panel>() }.waits.push(token);
    POCKET_STATUS_OK
}
#[test]
fn display_pipeline_rejects_in_flight_storage_and_consumes_tokens_out_of_order() {
    let mut panel = Panel {
        pixels: [[0; 16]; 2],
        surface: PocketSurface::empty(),
        slot: 0,
        short_identity: false,
        waits: vec![],
    };
    let table = PocketDisplayOutputV1 {
        descriptor: Some(panel_descriptor),
        acquire: Some(panel_acquire),
        flush: Some(panel_flush),
        wait: Some(panel_wait),
        frame_identity: Some(panel_identity),
        ..PocketDisplayOutputV1::empty()
    };
    let mut display = unsafe { CDisplay::new(&table, (&mut panel as *mut Panel).cast()) }.unwrap();
    assert_eq!(
        display.frame_identity().unwrap(),
        Some(BufferIdentity {
            buffer: 17,
            generation: 23
        })
    );
    let region = Rect::new(0, 0, 2, 2);
    display.acquire(region).unwrap();
    // Abandon an acquired buffer after a renderer rejected its input.
    assert!(display.frame_identity().is_ok());
    display.acquire(region).unwrap();
    let a = display.flush(&[region]).unwrap();
    assert!(matches!(
        display.acquire(region),
        Err(DisplayError::InvalidTarget)
    ));
    assert!(display.frame_identity().is_err());
    panel.slot = 1;
    display.acquire(region).unwrap();
    let b = display.flush(&[region]).unwrap();
    assert!(matches!(
        display.acquire(region),
        Err(DisplayError::InvalidTarget)
    ));
    display.wait(b).unwrap();
    assert!(display.wait(b).is_err());
    display.wait(a).unwrap();
    assert_eq!(panel.waits, [1, 0]);
    panel.short_identity = true;
    assert_eq!(display.frame_identity(), Err(DisplayError::InvalidTarget));
    panel.short_identity = false;
    assert!(display.frame_identity().is_ok());
    display.acquire(region).unwrap();
    display.flush(&[region]).unwrap();
    drop(display);
    assert_eq!(panel.waits, [1, 0, 1]);
}

#[test]
fn queued_flush_flag_requires_a_device_owned_target() {
    unsafe extern "C" fn queued(context: *mut c_void, out: *mut PocketDisplayDescriptor) -> i32 {
        let target_kind = unsafe { *context.cast::<u32>() };
        unsafe {
            out.write(PocketDisplayDescriptor {
                role: POCKET_DISPLAY_ROLE_PRIMARY,
                width: 2,
                height: 2,
                pixel_format: POCKET_PIXEL_FORMAT_RGBA8888,
                stride_bytes: 8,
                target_kind,
                flags: POCKET_DISPLAY_QUEUED_FLUSH,
                refresh_width: 1,
                refresh_height: 1,
                window_x_alignment: 1,
                window_y_alignment: 1,
                ..PocketDisplayDescriptor::empty()
            });
        }
        POCKET_STATUS_OK
    }
    let table = PocketDisplayOutputV1 {
        descriptor: Some(queued),
        acquire: Some(panel_acquire),
        flush: Some(panel_flush),
        wait: Some(panel_wait),
        ..PocketDisplayOutputV1::empty()
    };
    let mut kind = POCKET_TARGET_DEVICE_OWNED;
    let display = unsafe { CDisplay::new(&table, (&mut kind as *mut u32).cast()) }.unwrap();
    assert!(display.descriptor().queued_flush);
    kind = POCKET_TARGET_CPU_VISIBLE;
    assert!(unsafe { CDisplay::new(&table, (&mut kind as *mut u32).cast()) }.is_err());
}
