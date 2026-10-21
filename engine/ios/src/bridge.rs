use super::{PocketApple, PocketAppleFrame, POCKET_APPLE_MAX_DAMAGE_REGIONS};
use pocket_runtime_cabi::abi::*;
use std::{cell::RefCell, collections::VecDeque, ffi::c_void, mem};

#[derive(Default)]
pub(crate) struct Services {
    pub allow: Vec<String>,
    pub incoming: VecDeque<String>,
    pub outgoing: VecDeque<String>,
    reply: Vec<u8>,
}
pub(crate) struct Frame {
    pixels: Vec<u8>,
    width: u32,
    height: u32,
    region: PocketRect,
    surface: PocketSurface,
    regions: [[i32; 4]; POCKET_APPLE_MAX_DAMAGE_REGIONS],
    pub region_count: u32,
    full: bool,
}
impl Frame {
    pub fn snapshot(&self) -> PocketAppleFrame {
        PocketAppleFrame {
            pixels: self.pixels.as_ptr(),
            width_px: self.width,
            height_px: self.height,
            stride_bytes: self.width * 4,
            regions: self.regions,
            region_count: self.region_count,
            full_redraw: i32::from(self.full),
        }
    }
}
#[derive(Default)]
struct Input {
    buttons: u32,
    axes: Vec<PocketAxisSample>,
    contacts: Vec<PocketContact>,
}
pub(crate) struct Bridge {
    pub density: u32,
    pub logical: [u32; 2],
    pub frame: RefCell<Frame>,
    pub services: RefCell<Services>,
    input: RefCell<Input>,
}
impl Bridge {
    pub fn new(density: u32, width: u32, height: u32) -> Option<Self> {
        if !(1..=4).contains(&density)
            || !(1..=4096).contains(&width)
            || !(1..=4096).contains(&height)
        {
            return None;
        }
        let w = width.checked_mul(density)?;
        let h = height.checked_mul(density)?;
        let length = (w as usize).checked_mul(h as usize)?.checked_mul(4)?;
        if length > 128 * 1024 * 1024 {
            return None;
        }
        let mut pixels = Vec::new();
        pixels.try_reserve_exact(length).ok()?;
        pixels.resize(length, 0);
        Some(Self {
            density,
            logical: [width, height],
            frame: RefCell::new(Frame {
                pixels,
                width: w,
                height: h,
                region: PocketRect::empty(),
                surface: PocketSurface::empty(),
                regions: [[0; 4]; POCKET_APPLE_MAX_DAMAGE_REGIONS],
                region_count: 0,
                full: false,
            }),
            services: RefCell::default(),
            input: RefCell::default(),
        })
    }
    pub fn begin_frame(&self) {
        let mut frame = self.frame.borrow_mut();
        frame.region_count = 0;
        frame.full = false;
    }
    pub fn byte_length(&self) -> usize {
        self.frame.borrow().pixels.len()
    }
    pub fn reset(&self) {
        let mut frame = self.frame.borrow_mut();
        frame.pixels.fill(0);
        frame.region_count = 0;
        frame.full = false;
        let mut services = self.services.borrow_mut();
        services.incoming.clear();
        services.outgoing.clear();
        services.reply.clear();
        *self.input.borrow_mut() = Input::default();
    }
    pub fn set_input(&self, buttons: u32, analog: u32, words: &[u32]) {
        let mut input = self.input.borrow_mut();
        input.buttons = buttons;
        input.axes = vec![
            PocketAxisSample {
                axis: POCKET_AXIS_LEFT_X,
                value: ((analog >> 8) & 255) as f32,
                ..PocketAxisSample::empty()
            },
            PocketAxisSample {
                axis: POCKET_AXIS_LEFT_Y,
                value: (analog & 255) as f32,
                ..PocketAxisSample::empty()
            },
        ];
        input.contacts = words
            .iter()
            .map(|&word| {
                let wide = word & 0x80000000 != 0;
                let (x, y, id) = if wide {
                    (word & 1023, (word >> 10) & 1023, (word >> 20) & 255)
                } else {
                    (word & 511, (word >> 9) & 511, (word >> 18) & 255)
                };
                PocketContact {
                    surface: 0,
                    id,
                    x: x as f32,
                    y: y as f32,
                    cancelled: u32::from(word & 0x40000000 != 0),
                    ..PocketContact::empty()
                }
            })
            .collect();
    }
}
unsafe fn bridge<'a>(context: *mut c_void) -> &'a Bridge {
    unsafe { &*context.cast::<Bridge>() }
}
unsafe extern "C" fn descriptor(context: *mut c_void, out: *mut PocketDisplayDescriptor) -> i32 {
    let frame = unsafe { bridge(context) }.frame.borrow();
    let value = PocketDisplayDescriptor {
        role: POCKET_DISPLAY_ROLE_PRIMARY,
        width: frame.width,
        height: frame.height,
        pixel_format: POCKET_PIXEL_FORMAT_ARGB8888,
        stride_bytes: frame.width as usize * 4,
        target_kind: POCKET_TARGET_CPU_VISIBLE,
        flags: POCKET_DISPLAY_PARTIAL_REFRESH | POCKET_DISPLAY_FRAME_STORAGE,
        refresh_width: 1,
        refresh_height: 1,
        window_x_alignment: 1,
        window_y_alignment: 1,
        vsync_source: POCKET_VSYNC_CLOCK,
        ..PocketDisplayDescriptor::empty()
    };
    if unsafe { value.write_prefix(out) } {
        0
    } else {
        POCKET_STATUS_INVALID
    }
}
unsafe extern "C" fn acquire(
    context: *mut c_void,
    region: *const PocketRect,
    out: *mut PocketTarget,
) -> i32 {
    let Some(region) = (unsafe { PocketRect::read_prefix(region) }) else {
        return POCKET_STATUS_INVALID;
    };
    let mut frame = unsafe { bridge(context) }.frame.borrow_mut();
    if region.width == 0
        || region.height == 0
        || region
            .x
            .checked_add(region.width)
            .is_none_or(|x| x > frame.width)
        || region
            .y
            .checked_add(region.height)
            .is_none_or(|y| y > frame.height)
    {
        return POCKET_STATUS_INVALID;
    }
    let offset = (region.y as usize * frame.width as usize + region.x as usize) * 4;
    frame.region = region;
    frame.surface = PocketSurface {
        pixels: unsafe { frame.pixels.as_mut_ptr().add(offset) },
        byte_length: frame.pixels.len() - offset,
        region: &frame.region,
        stride_bytes: frame.width as usize * 4,
        pixel_format: POCKET_PIXEL_FORMAT_ARGB8888,
        ..PocketSurface::empty()
    };
    let target = PocketTarget {
        kind: POCKET_TARGET_CPU_VISIBLE,
        region: &frame.region,
        pixel_format: POCKET_PIXEL_FORMAT_ARGB8888,
        surface: &mut frame.surface,
        ..PocketTarget::empty()
    };
    if unsafe { target.write_prefix(out) } {
        0
    } else {
        POCKET_STATUS_INVALID
    }
}
unsafe extern "C" fn flush(
    context: *mut c_void,
    regions: *const PocketRect,
    count: usize,
    token: *mut u64,
) -> i32 {
    if token.is_null() || (count != 0 && regions.is_null()) {
        return POCKET_STATUS_INVALID;
    }
    let mut frame = unsafe { bridge(context) }.frame.borrow_mut();
    // The display buffer persists. CGImage receives an owned copy outside the
    // runtime call, so this transfer is terminal when the metadata is recorded.
    for index in 0..count {
        let Some(region) = (unsafe { PocketRect::read_prefix(regions.add(index)) }) else {
            return POCKET_STATUS_INVALID;
        };
        if frame.region_count as usize == POCKET_APPLE_MAX_DAMAGE_REGIONS {
            frame.full = true;
            break;
        }
        let index = frame.region_count as usize;
        frame.regions[index] = [
            region.x as i32,
            region.y as i32,
            region.width as i32,
            region.height as i32,
        ];
        frame.region_count += 1;
        frame.full |= region.x == 0
            && region.y == 0
            && region.width == frame.width
            && region.height == frame.height;
    }
    if frame.full {
        frame.regions[0] = [0, 0, frame.width as i32, frame.height as i32];
        frame.region_count = 1;
    }
    unsafe { token.write(1) };
    0
}
unsafe extern "C" fn wait(_: *mut c_void, token: u64) -> i32 {
    if token == 1 {
        0
    } else {
        POCKET_STATUS_INVALID
    }
}
unsafe extern "C" fn vsync(_: *mut c_void) -> u32 {
    POCKET_VSYNC_CLOCK
}
unsafe extern "C" fn frame_identity(_: *mut c_void, out: *mut PocketBufferIdentity) -> i32 {
    let value = PocketBufferIdentity {
        buffer: 1,
        generation: 1,
        ..PocketBufferIdentity::empty()
    };
    if unsafe { value.write_prefix(out) } {
        0
    } else {
        POCKET_STATUS_INVALID
    }
}
pub static DISPLAY: PocketDisplayOutputV1 = PocketDisplayOutputV1 {
    struct_size: mem::size_of::<PocketDisplayOutputV1>(),
    descriptor: Some(descriptor),
    acquire: Some(acquire),
    flush: Some(flush),
    wait: Some(wait),
    vsync: Some(vsync),
    frame_identity: Some(frame_identity),
};
unsafe extern "C" fn classes(_: *mut c_void) -> u32 {
    POCKET_INPUT_CLASS_CONTACT | POCKET_INPUT_CLASS_BUTTONS | POCKET_INPUT_CLASS_AXIS_ABSOLUTE
}
unsafe extern "C" fn poll(context: *mut c_void, builder: *mut PocketInputFrameBuilder) -> i32 {
    let Some(builder) = (unsafe { PocketInputFrameBuilder::read_prefix(builder) }) else {
        return POCKET_STATUS_INVALID;
    };
    let Some(append) = builder.append else {
        return POCKET_STATUS_INVALID;
    };
    let input = unsafe { bridge(context) }.input.borrow();
    let frame = PocketInputFrame {
        buttons: input.buttons,
        axes: input.axes.as_ptr(),
        axis_count: input.axes.len(),
        contacts: input.contacts.as_ptr(),
        contact_count: input.contacts.len(),
        ..PocketInputFrame::empty()
    };
    unsafe { append(builder.context, &frame) }
}
pub static INPUT: PocketInputSourceV1 = PocketInputSourceV1 {
    struct_size: mem::size_of::<PocketInputSourceV1>(),
    classes: Some(classes),
    poll: Some(poll),
};
unsafe extern "C" fn length(context: *mut c_void, out: *mut usize) -> i32 {
    if out.is_null() {
        return POCKET_STATUS_INVALID;
    }
    let state = unsafe { &*context.cast::<PocketApple>() };
    unsafe { out.write(state.config.borrow().package.len()) };
    0
}
unsafe extern "C" fn all(context: *mut c_void, out: *mut *const u8, length: *mut usize) -> i32 {
    if out.is_null() || length.is_null() {
        return POCKET_STATUS_INVALID;
    }
    let state = unsafe { &*context.cast::<PocketApple>() };
    let config = state.config.borrow();
    unsafe {
        out.write(config.package.as_ptr());
        length.write(config.package.len())
    };
    0
}
unsafe extern "C" fn range(
    context: *mut c_void,
    offset: usize,
    out: *mut u8,
    capacity: usize,
    read: *mut usize,
) -> i32 {
    if read.is_null() || (capacity != 0 && out.is_null()) {
        return POCKET_STATUS_INVALID;
    }
    let config = unsafe { &*context.cast::<PocketApple>() }.config.borrow();
    let Some(bytes) = config.package.get(offset..) else {
        return POCKET_STATUS_INVALID;
    };
    let count = capacity.min(bytes.len());
    if count != 0 {
        unsafe { std::ptr::copy_nonoverlapping(bytes.as_ptr(), out, count) };
    }
    unsafe { read.write(count) };
    0
}
pub static SOURCE: PocketPackageSourceV1 = PocketPackageSourceV1 {
    struct_size: mem::size_of::<PocketPackageSourceV1>(),
    length: Some(length),
    all: Some(all),
    range: Some(range),
};
unsafe extern "C" fn dispatch(
    context: *mut c_void,
    op: u16,
    args: *const PocketOpArg,
    length: usize,
    out: *mut PocketResult,
) -> i32 {
    let mut services = unsafe { bridge(context) }.services.borrow_mut();
    let text = if op == 30 || op == 32 {
        if length != mem::size_of::<PocketOpArg>() {
            return POCKET_STATUS_INVALID;
        }
        let Some(arg) = (unsafe { PocketOpArg::read_prefix(args) }) else {
            return POCKET_STATUS_INVALID;
        };
        if arg.tag != POCKET_ARG_BYTES {
            return POCKET_STATUS_INVALID;
        }
        let Some(bytes) = (unsafe { super::bytes(arg.bytes, arg.byte_length) }) else {
            return POCKET_STATUS_INVALID;
        };
        let Ok(text) = std::str::from_utf8(bytes) else {
            return POCKET_STATUS_INVALID;
        };
        text
    } else {
        ""
    };
    let mut result = PocketResult::empty();
    match op {
        30 => {
            result.tag = POCKET_RESULT_I64;
            result.integer = i64::from(services.allow.iter().any(|name| name == text));
        }
        31 => {
            let mut reply = Vec::new();
            for line in services.incoming.drain(..) {
                reply.extend_from_slice(line.as_bytes());
                reply.push(b'\n');
            }
            services.reply = reply;
            if services.reply.is_empty() {
                result.tag = POCKET_RESULT_NONE;
            } else {
                result.tag = POCKET_RESULT_BYTES;
                result.bytes = services.reply.as_ptr();
                result.byte_length = services.reply.len();
            }
        }
        32 => {
            services.outgoing.push_back(text.into());
            result.tag = POCKET_RESULT_NONE;
        }
        _ => return POCKET_STATUS_UNSUPPORTED,
    }
    if unsafe { result.write_prefix(out) } {
        0
    } else {
        POCKET_STATUS_INVALID
    }
}
pub static PROVIDER: PocketOpProviderV1 = PocketOpProviderV1 {
    struct_size: mem::size_of::<PocketOpProviderV1>(),
    dispatch: Some(dispatch),
};
