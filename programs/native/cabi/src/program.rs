//! Program composition for the existing portable C hosts. Canonical Runtime
//! owns the guest, package, retained tree, input encoding and presentation.
#[cfg(any(feature = "std", feature = "software-only"))]
use alloc::vec::Vec;
use alloc::{boxed::Box, format, rc::Rc, string::String};
use core::{
    cell::{Cell, RefCell},
    ffi::{c_char, c_void, CStr},
    ptr,
};
use pocket_drivers::*;
use pocket_runtime::{Cow, OpContext, Profile, RuntimeConfig};
use pocket_runtime_cabi::{abi::*, adapters::CInputSource, embedding as embed};

const INPUT_CLASSES: u32 = POCKET_INPUT_CLASS_BUTTONS
    | POCKET_INPUT_CLASS_AXIS_ABSOLUTE
    | POCKET_INPUT_CLASS_AXIS_RELATIVE
    | POCKET_INPUT_CLASS_POINTER
    | POCKET_INPUT_CLASS_CONTACT
    | POCKET_INPUT_CLASS_TEXT
    | POCKET_INPUT_CLASS_MOTION;
struct Input(Rc<RefCell<InputFrameBuilder>>);
impl InputSource for Input {
    fn classes(&self) -> InputClasses {
        InputClasses::BUTTONS
            | InputClasses::AXIS_ABSOLUTE
            | InputClasses::AXIS_RELATIVE
            | InputClasses::POINTER
            | InputClasses::CONTACT
            | InputClasses::TEXT
            | InputClasses::MOTION
    }
    fn poll(&mut self, out: &mut InputFrameBuilder) {
        *out = core::mem::take(&mut *self.0.borrow_mut());
    }
}
unsafe extern "C" fn input_classes(_: *mut c_void) -> u32 {
    INPUT_CLASSES
}
unsafe extern "C" fn input_poll(
    context: *mut c_void,
    builder: *mut PocketInputFrameBuilder,
) -> i32 {
    let Some(builder) = (unsafe { PocketInputFrameBuilder::read_prefix(builder) }) else {
        return POCKET_STATUS_INVALID;
    };
    let Some(append) = builder.append else {
        return POCKET_STATUS_INVALID;
    };
    unsafe { append(builder.context, context.cast()) }
}
unsafe fn decode_input(frame: *const PocketInputFrame) -> Result<InputFrameBuilder, i32> {
    let table = PocketInputSourceV1 {
        classes: Some(input_classes),
        poll: Some(input_poll),
        ..PocketInputSourceV1::empty()
    };
    let mut adapter =
        unsafe { CInputSource::new(&table, frame.cast_mut().cast()) }.map_err(|e| e.status())?;
    let mut out = InputFrameBuilder::new();
    adapter.poll(&mut out);
    match adapter.last_error() {
        Some(error) => Err(error.status()),
        None => Ok(out),
    }
}
#[derive(Default)]
struct State {
    pending: bool,
    attempts: u64,
    failures: u64,
    redraws: u64,
    pixels: u64,
    last_bounds: Option<[i32; 4]>,
}

/// Private opaque program handle. It never exposes a mutable core reference.
pub struct PocketNativeProgram {
    runtime: *mut PocketRuntime,
    ops: OpContext,
    input: Rc<RefCell<InputFrameBuilder>>,
    viewport: Cell<[u32; 2]>,
    pixels: *const u8,
    length: usize,
    busy: Cell<bool>,
    attached: bool,
    state: Rc<RefCell<State>>,
    #[cfg(all(not(feature = "std"), not(feature = "software-only")))]
    gl: Rc<RefCell<gpu::State>>,
}
struct Busy<'a>(&'a Cell<bool>);
impl Drop for Busy<'_> {
    fn drop(&mut self) {
        self.0.set(false);
    }
}
impl PocketNativeProgram {
    fn enter(&self) -> Result<Busy<'_>, i32> {
        if self.busy.replace(true) {
            Err(POCKET_STATUS_FAILED)
        } else {
            Ok(Busy(&self.busy))
        }
    }
    fn begin_render(&self) {
        let mut s = self.state.borrow_mut();
        s.pixels = 0;
        s.last_bounds = None;
    }
    fn record(&self, status: i32, _width: u32, _height: u32) {
        let mut s = self.state.borrow_mut();
        s.pending = false;
        s.attempts = s.attempts.saturating_add(1);
        if status != 0 {
            s.failures = s.failures.saturating_add(1);
            s.pixels = 0;
            s.last_bounds = None;
        }
        #[cfg(all(not(feature = "std"), not(feature = "software-only")))]
        if status == 0 {
            s.redraws = s.redraws.saturating_add(1);
            s.pixels = u64::from(_width) * u64::from(_height);
            s.last_bounds = Some([0, 0, _width as i32, _height as i32]);
        }
    }
}
impl Drop for PocketNativeProgram {
    fn drop(&mut self) {
        unsafe {
            // The legacy inspection namespace follows the active program's core.
            if self.attached {
                pocket_runtime_cabi::compat::ui::attach_context(None);
            }
            pocket_runtime_cabi::pocket_runtime_destroy(self.runtime);
        }
    }
}

#[cfg(any(feature = "std", feature = "software-only"))]
struct CpuDisplay {
    width: u32,
    height: u32,
    pixels: Vec<u8>,
    stats: Rc<RefCell<State>>,
}
#[cfg(any(feature = "std", feature = "software-only"))]
impl DisplayOutput for CpuDisplay {
    type Token = ();
    fn descriptor(&self) -> DisplayDescriptor {
        let mut descriptor = DisplayDescriptor::new(
            DisplayRole::Primary,
            self.width,
            self.height,
            PixelFormat::Argb8888,
            self.width as usize * 4,
            TargetOwnership::CpuVisible,
        );
        descriptor.partial_refresh = true;
        descriptor
    }
    fn frame_identity(&mut self) -> Result<Option<BufferIdentity>, DisplayError> {
        Ok(Some(BufferIdentity {
            buffer: 1,
            generation: 1,
        }))
    }
    fn acquire(&mut self, region: Rect) -> Result<Target<'_>, DisplayError> {
        if region != Rect::new(0, 0, self.width, self.height) {
            return Err(DisplayError::InvalidTarget);
        }
        Ok(Target::CpuVisible(Surface::new(
            &mut self.pixels,
            region,
            self.width as usize * 4,
            PixelFormat::Argb8888,
        )?))
    }
    fn flush(&mut self, regions: &[Rect]) -> Result<(), DisplayError> {
        let mut stats = self.stats.borrow_mut();
        for r in regions {
            stats.pixels = stats
                .pixels
                .saturating_add(u64::from(r.width) * u64::from(r.height));
            let b = [
                r.x as i32,
                r.y as i32,
                (r.x + r.width) as i32,
                (r.y + r.height) as i32,
            ];
            stats.last_bounds = Some(stats.last_bounds.map_or(b, |old| {
                [
                    old[0].min(b[0]),
                    old[1].min(b[1]),
                    old[2].max(b[2]),
                    old[3].max(b[3]),
                ]
            }));
        }
        if regions == [Rect::new(0, 0, self.width, self.height)] {
            stats.redraws = stats.redraws.saturating_add(1);
        }
        Ok(())
    }
    fn wait(&mut self, _: ()) -> Result<(), DisplayError> {
        Ok(())
    }
    fn vsync(&mut self) -> VsyncSource {
        VsyncSource::None
    }
}

#[cfg(any(feature = "std", feature = "software-only"))]
struct CpuRenderer;
#[cfg(any(feature = "std", feature = "software-only"))]
impl Renderer for CpuRenderer {
    type Submission = ();
    fn descriptor(&self) -> RendererDescriptor {
        RendererDescriptor::new(
            &[PixelFormat::Argb8888],
            TargetOwnership::CpuVisible,
            Synchronization::Immediate,
            POCKET_DRAW_LIST_VERSION,
            false,
        )
        .unwrap()
    }
    fn render(&mut self, frame: &mut FrameInput<'_>) -> Result<(), RenderError> {
        let Target::CpuVisible(surface) = &mut frame.target else {
            return Err(RenderError::Unsupported);
        };
        let full = surface.region();
        let stride = surface.stride_bytes();
        if surface.format() != PixelFormat::Argb8888 {
            return Err(RenderError::Unsupported);
        }
        for &r in frame.damage {
            if r.x < full.x
                || r.y < full.y
                || r.width == 0
                || r.height == 0
                || r.x
                    .checked_add(r.width)
                    .is_none_or(|x| x > full.x + full.width)
                || r.y
                    .checked_add(r.height)
                    .is_none_or(|y| y > full.y + full.height)
            {
                return Err(RenderError::InvalidFrame);
            }
            let offset = (r.y - full.y) as usize * stride + (r.x - full.x) as usize * 4;
            let bytes = surface
                .pixels_mut()
                .get_mut(offset..)
                .ok_or(RenderError::InvalidFrame)?;
            let mut region = Surface::new(bytes, r, stride, PixelFormat::Argb8888)
                .map_err(|_| RenderError::InvalidFrame)?;
            pocket_raster::render_surface(frame.resources, &frame.list.words, &mut region, 1)?;
        }
        Ok(())
    }
    fn wait(&mut self, _: &()) -> Result<(), RenderError> {
        Ok(())
    }
    fn retire(&mut self, _: ()) {}
}

#[allow(clippy::too_many_arguments)] // Mirrors the private C program constructor.
unsafe fn create(
    target: *const c_char,
    host_abi: u32,
    code: *const u8,
    code_length: usize,
    pak: *const u8,
    pak_length: usize,
    width: u32,
    height: u32,
    density: u32,
    physics: u32,
    original_package: Option<&[u8]>,
    trusted_profile: Option<(Profile, [u8; 32])>,
) -> Result<Box<PocketNativeProgram>, i32> {
    if host_abi != pocket_spec::BINDING_GENERATION
        || target.is_null()
        || width == 0
        || height == 0
        || width > 4096
        || height > 4096
        || !(1..=255).contains(&density)
        || physics > 1
    {
        return Err(POCKET_STATUS_INVALID);
    }
    let target = unsafe { CStr::from_ptr(target) }
        .to_str()
        .map_err(|_| POCKET_STATUS_INVALID)?;
    let code = unsafe { pocket_runtime_cabi::adapters::borrowed(code, code_length) }
        .map_err(|e| e.status())?;
    let pak = unsafe { pocket_runtime_cabi::adapters::borrowed(pak, pak_length) }
        .map_err(|e| e.status())?;
    let length = (width as usize)
        .checked_mul(height as usize)
        .and_then(|n| n.checked_mul(4))
        .ok_or(POCKET_STATUS_INVALID)?;
    let (profile, profile_hash) = match trusted_profile {
        Some(profile) => profile,
        // Explicit private adapter for callers supplying raw JS/pak spans: the
        // profile is the one viewport they name, and the all-zero hash pairs
        // it with the package encoded below.
        None => (
            Profile {
                id: Cow::Owned(String::from(target)),
                tick_hz: 60,
                viewport: [width, height],
                logical_viewports: Cow::Owned(alloc::vec![[width, height]]),
                dynamic_viewport: None,
                auxiliary: None,
                auxiliary_logical: Cow::Borrowed(&[]),
                density,
                required_inputs: InputClasses::BUTTONS
                    | InputClasses::AXIS_ABSOLUTE
                    | InputClasses::CONTACT,
            },
            [0; 32],
        ),
    };
    if profile.id != target || profile.density != density {
        return Err(POCKET_STATUS_INVALID);
    }
    let plan = format!(
        r#"{{"features":{{"ui.physics":{}}},"viewport":{{"logical":[{width},{height}],"rasterDensity":{density}}}}}"#,
        physics != 0
    );
    let identity = pocket_package::embedded::identity(
        "embedded",
        "dev.pocketjs.native.embedded",
        "Embedded guest",
    )
    .map_err(|_| POCKET_STATUS_INVALID)?;
    let package = if let Some(original) = original_package {
        original.to_vec()
    } else {
        pocket_package::embedded::encode(pocket_package::embedded::EmbeddedPackage {
            target,
            host_abi,
            profile_hash,
            identity: &identity,
            plan: plan.as_bytes(),
            code,
            pak,
        })
        .map_err(|_| POCKET_STATUS_INVALID)?
    };
    let runtime = embed::create(RuntimeConfig {
        profile_hash,
        host_abi,
        heap_limit: 128 * 1024 * 1024,
        frame_buffer_budget: length,
        profile,
    })
    .map_err(|_| POCKET_STATUS_INVALID)?;
    let ops = match unsafe { embed::op_context(runtime) } {
        Ok(ops) => ops,
        Err(_) => {
            unsafe { pocket_runtime_cabi::pocket_runtime_destroy(runtime) };
            return Err(POCKET_STATUS_FAILED);
        }
    };
    let input = Rc::new(RefCell::new(InputFrameBuilder::new()));
    #[allow(unused_mut)] // CPU builds set the stable display buffer pointer.
    let mut program = Box::new(PocketNativeProgram {
        runtime,
        ops,
        input,
        viewport: Cell::new([width, height]),
        pixels: ptr::null(),
        length,
        busy: Cell::new(false),
        attached: false,
        state: Rc::new(RefCell::new(State::default())),
        #[cfg(all(not(feature = "std"), not(feature = "software-only")))]
        gl: Rc::new(RefCell::new(gpu::State::new(width, height))),
    });
    let check = |status| if status == 0 { Ok(()) } else { Err(status) };
    check(unsafe {
        embed::set_package_source(
            runtime,
            Box::new(pocket_package::source::MemorySource(package)),
        )
    })?;
    check(unsafe { embed::set_native_asset_loading(runtime, false) })?;
    check(unsafe { embed::add_input_source(runtime, Box::new(Input(program.input.clone()))) })?;
    program
        .ops
        .set_compositor_enabled(true)
        .map_err(|_| POCKET_STATUS_FAILED)?;
    #[cfg(any(feature = "std", feature = "software-only"))]
    {
        let mut pixels = Vec::new();
        pixels
            .try_reserve_exact(length)
            .map_err(|_| POCKET_STATUS_FAILED)?;
        pixels.resize(length, 0);
        program.pixels = pixels.as_ptr();
        let renderer = unsafe { embed::add_renderer(runtime, CpuRenderer) }?;
        check(unsafe {
            embed::add_display(
                runtime,
                CpuDisplay {
                    width,
                    height,
                    pixels,
                    stats: program.state.clone(),
                },
                renderer,
            )
        })?;
    }
    #[cfg(all(not(feature = "std"), not(feature = "software-only")))]
    {
        let renderer = unsafe { embed::add_renderer(runtime, gpu::Render(program.gl.clone())) }?;
        check(unsafe { embed::add_display(runtime, gpu::Display(program.gl.clone()), renderer) })?;
    }
    // Native hosts own the final presentation transform, including logical-sized CPU buffers.
    check(unsafe { embed::allow_embedded_viewport_changes(runtime) })?;
    program.attached = true;
    unsafe { pocket_runtime_cabi::compat::ui::attach_context(Some(program.ops.clone())) };
    Ok(program)
}
/// # Safety
/// All input spans are readable; target is a terminated UTF-8 string.
#[no_mangle]
pub unsafe extern "C" fn pocket_native_program_create(
    target: *const c_char,
    host_abi: u32,
    code: *const u8,
    code_length: usize,
    pak: *const u8,
    pak_length: usize,
    width: u32,
    height: u32,
    density: u32,
    physics: u32,
) -> *mut PocketNativeProgram {
    unsafe {
        create(
            target,
            host_abi,
            code,
            code_length,
            pak,
            pak_length,
            width,
            height,
            density,
            physics,
            None,
            None,
        )
    }
    .map(Box::into_raw)
    .unwrap_or(ptr::null_mut())
}
/// # Safety
/// Input spans are readable; profile is null or an exported facts record and
/// profile_hash names 32 readable bytes. Both come from the host build, not
/// its package.
#[no_mangle]
pub unsafe extern "C" fn pocket_native_program_create_profile(
    target: *const c_char,
    host_abi: u32,
    code: *const u8,
    code_length: usize,
    pak: *const u8,
    pak_length: usize,
    width: u32,
    height: u32,
    density: u32,
    physics: u32,
    profile: *const PocketProfileFacts,
    profile_hash: *const u8,
) -> *mut PocketNativeProgram {
    let checked = || -> Result<Box<PocketNativeProgram>, i32> {
        let profile = unsafe { trusted_profile(profile, profile_hash) }?;
        unsafe {
            create(
                target,
                host_abi,
                code,
                code_length,
                pak,
                pak_length,
                width,
                height,
                density,
                physics,
                None,
                Some(profile),
            )
        }
    };
    checked().map(Box::into_raw).unwrap_or(ptr::null_mut())
}
/// The exporter wrote the facts and the hash from one profile; the hash is
/// the identity packages are admitted against.
unsafe fn trusted_profile(
    facts: *const PocketProfileFacts,
    hash: *const u8,
) -> Result<(Profile, [u8; 32]), i32> {
    if hash.is_null() {
        return Err(POCKET_STATUS_INVALID);
    }
    let profile = unsafe { embed::profile_from_facts(facts) }.ok_or(POCKET_STATUS_INVALID)?;
    let hash: [u8; 32] = unsafe { core::slice::from_raw_parts(hash, 32) }
        .try_into()
        .unwrap();
    Ok((profile, hash))
}
/// # Safety
/// Strings are terminated UTF-8; package is readable for length bytes;
/// profile and profile_hash follow `pocket_native_program_create_profile`. The
/// complete original package is copied and admitted again by Runtime at boot.
#[no_mangle]
pub unsafe extern "C" fn pocket_native_program_create_package(
    target: *const c_char,
    host_abi: u32,
    bytes: *const u8,
    length: usize,
    output: *const c_char,
    id: *const c_char,
    title: *const c_char,
    width: u32,
    height: u32,
    density: u32,
    physics: u32,
    profile: *const PocketProfileFacts,
    profile_hash: *const u8,
) -> *mut PocketNativeProgram {
    let checked = || -> Result<Box<PocketNativeProgram>, i32> {
        let string = |pointer: *const c_char| -> Result<&str, i32> {
            if pointer.is_null() {
                return Err(POCKET_STATUS_INVALID);
            }
            unsafe { CStr::from_ptr(pointer) }
                .to_str()
                .map_err(|_| POCKET_STATUS_INVALID)
        };
        let profile = unsafe { trusted_profile(profile, profile_hash) }?;
        let target_name = string(target)?;
        let bytes = unsafe { pocket_runtime_cabi::adapters::borrowed(bytes, length) }
            .map_err(|error| error.status())?;
        let package =
            pocket_package::Package::parse(bytes, false).map_err(|_| POCKET_STATUS_INVALID)?;
        let variant = package
            .find_variant(target_name)
            .map_err(|_| POCKET_STATUS_INVALID)?
            .ok_or(POCKET_STATUS_INVALID)?;
        let identity = variant
            .identity()
            .map_err(|_| POCKET_STATUS_INVALID)?
            .ok_or(POCKET_STATUS_INVALID)?;
        if identity.output != string(output)?
            || identity.id != string(id)?
            || identity.title != string(title)?
        {
            return Err(POCKET_STATUS_INVALID);
        }
        let guest = pocket_package::select_guest(bytes, target_name, host_abi, &profile.1, false)
            .map_err(|_| POCKET_STATUS_INVALID)?;
        let facts = pocket_package::plan_facts(guest.plan).map_err(|_| POCKET_STATUS_INVALID)?;
        if [facts.viewport.width, facts.viewport.height] != [width, height]
            || facts.viewport.raster_density != density
            || facts.auxiliary.is_some()
            || (facts.feature("ui.physics") && physics == 0)
        {
            return Err(POCKET_STATUS_INVALID);
        }
        unsafe {
            create(
                target,
                host_abi,
                ptr::null(),
                0,
                ptr::null(),
                0,
                width,
                height,
                density,
                physics,
                Some(bytes),
                Some(profile),
            )
        }
    };
    checked().map(Box::into_raw).unwrap_or(ptr::null_mut())
}
/// # Safety
/// The program is live on its owning thread.
#[no_mangle]
pub unsafe extern "C" fn pocket_native_program_runtime(
    program: *mut PocketNativeProgram,
) -> *mut PocketRuntime {
    unsafe { program.as_ref() }.map_or(ptr::null_mut(), |p| p.runtime)
}
/// # Safety
/// The program is live; its guest has been registered.
#[no_mangle]
pub unsafe extern "C" fn pocket_native_program_boot(program: *mut PocketNativeProgram) -> i32 {
    let Some(p) = (unsafe { program.as_ref() }) else {
        return POCKET_STATUS_INVALID;
    };
    let Ok(_busy) = p.enter() else {
        return POCKET_STATUS_FAILED;
    };
    let result = unsafe { embed::boot_deferred(p.runtime) };
    if result != 0 {
        return result;
    }
    unsafe { embed::skip_presentation(p.runtime) }
}
/// # Safety
/// Program and input's nested records are readable on the owning thread.
#[no_mangle]
pub unsafe extern "C" fn pocket_native_program_advance(
    program: *mut PocketNativeProgram,
    input: *const PocketInputFrame,
    core_ticks: u32,
) -> i32 {
    let Some(p) = (unsafe { program.as_ref() }) else {
        return POCKET_STATUS_INVALID;
    };
    let Ok(_busy) = p.enter() else {
        return POCKET_STATUS_FAILED;
    };
    let input = match unsafe { decode_input(input) } {
        Ok(input) => input,
        Err(error) => return error,
    };
    if p.state.borrow().pending {
        let status = unsafe { embed::skip_presentation(p.runtime) };
        if status != 0 {
            return status;
        }
    }
    *p.input.borrow_mut() = input;
    let status = unsafe { embed::advance_with_core_ticks(p.runtime, core_ticks) };
    p.state.borrow_mut().pending = status == 0;
    status
}
/// # Safety
/// Program is live; returned bytes are read-only until the next program call.
#[no_mangle]
pub unsafe extern "C" fn pocket_native_program_render_argb(
    program: *mut PocketNativeProgram,
) -> *const u8 {
    let Some(p) = (unsafe { program.as_ref() }) else {
        return ptr::null();
    };
    let Ok(_busy) = p.enter() else {
        return ptr::null();
    };
    if p.pixels.is_null() {
        return ptr::null();
    }
    p.begin_render();
    let status = unsafe { embed::present(p.runtime) };
    p.record(status, p.viewport.get()[0], p.viewport.get()[1]);
    if status == 0 {
        p.pixels
    } else {
        ptr::null()
    }
}
macro_rules! read_value {
    ($name:ident,$type:ty,$default:expr,$read:expr) => {
        /// # Safety
        /// The program is live on its owning thread.
        #[no_mangle]
        pub unsafe extern "C" fn $name(program: *const PocketNativeProgram) -> $type {
            unsafe { program.as_ref() }.map_or($default, $read)
        }
    };
}
read_value!(pocket_native_program_width, u32, 0, |p| p.viewport.get()[0]);
read_value!(pocket_native_program_height, u32, 0, |p| p.viewport.get()
    [1]);
read_value!(pocket_native_program_stride, u32, 0, |p| p.viewport.get()
    [0]
    * 4);
read_value!(pocket_native_program_length, usize, 0, |p| p.length);
read_value!(pocket_native_program_damage_attempts, u64, 0, |p| p
    .state
    .borrow()
    .attempts);
read_value!(pocket_native_program_damage_failures, u64, 0, |p| p
    .state
    .borrow()
    .failures);
read_value!(pocket_native_program_damage_full_redraws, u64, 0, |p| p
    .state
    .borrow()
    .redraws);
read_value!(pocket_native_program_damage_pixels, u64, 0, |p| p
    .state
    .borrow()
    .pixels);
/// # Safety
/// Program is live; xywh writes four int32 values when nonnull.
#[no_mangle]
pub unsafe extern "C" fn pocket_native_program_damage_bounds(
    program: *const PocketNativeProgram,
    xywh: *mut i32,
) -> i32 {
    let Some(p) = (unsafe { program.as_ref() }) else {
        return 0;
    };
    if xywh.is_null() {
        return 0;
    }
    if let Some(bounds) = p.state.borrow().last_bounds {
        unsafe { ptr::copy_nonoverlapping(bounds.as_ptr(), xywh, 4) };
        1
    } else {
        0
    }
}
/// # Safety
/// Program is live on its owning thread with no outstanding callback.
#[no_mangle]
pub unsafe extern "C" fn pocket_native_program_destroy(program: *mut PocketNativeProgram) {
    if !program.is_null() && !unsafe { (*program).busy.replace(true) } {
        drop(unsafe { Box::from_raw(program) });
    }
}

#[cfg(all(not(feature = "std"), not(feature = "software-only")))]
mod gpu {
    use super::*;
    use pocket_gles::{ClearMode, ContextAccess, TargetConfig, Viewport};
    pub(super) struct Context;
    // This unsafe program ABI requires the host to make its GL context current
    // before initialize/render/reset/shutdown; no context survives those calls.
    unsafe impl ContextAccess for Context {
        type NativeTarget = ();
        fn ensure_current(&mut self) -> Result<(), RenderError> {
            Ok(())
        }
        fn bind_target(&mut self, _: &()) -> Result<(), RenderError> {
            Ok(())
        }
    }
    #[cfg(feature = "gles1")]
    type Driver = pocket_gles1::Renderer<Context>;
    #[cfg(not(feature = "gles1"))]
    type Driver = pocket_gles2::Renderer<Context>;
    pub(super) struct State {
        pub driver: Option<Driver>,
        pub window: [u32; 2],
        pub viewport: Viewport,
        pub over: bool,
        pub trace: Option<pocket_gles::Trace>,
        target: Option<u64>,
    }
    impl State {
        pub fn new(w: u32, h: u32) -> Self {
            Self {
                driver: None,
                window: [w, h],
                viewport: Viewport::new(0, 0, w, h),
                over: false,
                trace: None,
                target: None,
            }
        }
        fn target(&mut self) -> Result<DeviceTarget, RenderError> {
            let driver = self.driver.as_mut().ok_or(RenderError::Failed)?;
            if let Some(old) = self.target.take() {
                driver.unregister_target(old)?;
            }
            let mut config =
                TargetConfig::new((), self.window, self.viewport, PixelFormat::Rgba8888);
            config.clear = if self.over {
                ClearMode::Preserve
            } else {
                ClearMode::OpaqueBlack
            };
            config.external_compositor = true;
            let handle = driver.register_target(config)?;
            self.target = Some(handle);
            driver.target(handle)
        }
        pub fn initialize(&mut self) -> Result<(), RenderError> {
            self.driver = None;
            self.target = None;
            let mut driver = Driver::new(Context)?;
            driver.set_trace(self.trace);
            self.driver = Some(driver);
            Ok(())
        }
        pub fn reset(&mut self) {
            if let Some(driver) = self.driver.as_mut() {
                let _ = driver.reset_resources();
            }
        }
        pub fn shutdown(&mut self) {
            self.driver = None;
            self.target = None;
        }
    }
    pub(super) struct Render(pub Rc<RefCell<State>>);
    impl Renderer for Render {
        type Submission = pocket_gles::Submission;
        fn descriptor(&self) -> RendererDescriptor {
            RendererDescriptor::new(
                &[PixelFormat::Rgba8888],
                TargetOwnership::DeviceOwned,
                Synchronization::Deferred,
                POCKET_DRAW_LIST_VERSION,
                false,
            )
            .unwrap()
        }
        fn render(&mut self, frame: &mut FrameInput<'_>) -> Result<Self::Submission, RenderError> {
            if let Some(trace) = self.0.borrow().trace {
                trace(1, 0, 0);
            }
            self.0
                .borrow_mut()
                .driver
                .as_mut()
                .ok_or(RenderError::Failed)?
                .render(frame)
        }
        fn wait(&mut self, token: &Self::Submission) -> Result<(), RenderError> {
            self.0
                .borrow_mut()
                .driver
                .as_mut()
                .ok_or(RenderError::Failed)?
                .wait(token)
        }
        fn retire(&mut self, token: Self::Submission) {
            if let Some(driver) = self.0.borrow_mut().driver.as_mut() {
                driver.retire(token);
            }
        }
    }
    pub(super) struct Display(pub Rc<RefCell<State>>);
    impl DisplayOutput for Display {
        type Token = ();
        fn descriptor(&self) -> DisplayDescriptor {
            let s = self.0.borrow();
            DisplayDescriptor::new(
                DisplayRole::Primary,
                s.window[0],
                s.window[1],
                PixelFormat::Rgba8888,
                s.window[0] as usize * 4,
                TargetOwnership::DeviceOwned,
            )
        }
        fn acquire(&mut self, region: Rect) -> Result<Target<'_>, DisplayError> {
            let mut s = self.0.borrow_mut();
            if region != Rect::new(0, 0, s.window[0], s.window[1]) {
                return Err(DisplayError::InvalidTarget);
            }
            s.target()
                .map(Target::DeviceOwned)
                .map_err(|_| DisplayError::Failed)
        }
        fn flush(&mut self, _: &[Rect]) -> Result<(), DisplayError> {
            Ok(())
        }
        fn wait(&mut self, _: ()) -> Result<(), DisplayError> {
            Ok(())
        }
        fn vsync(&mut self) -> VsyncSource {
            VsyncSource::None
        }
    }
}
/// # Safety
/// Program is live and its native GL context is current.
#[no_mangle]
pub unsafe extern "C" fn pocket_native_program_gl_initialize(
    program: *mut PocketNativeProgram,
) -> i32 {
    let Some(p) = (unsafe { program.as_ref() }) else {
        return POCKET_STATUS_INVALID;
    };
    let Ok(_busy) = p.enter() else {
        return POCKET_STATUS_FAILED;
    };
    #[cfg(all(not(feature = "std"), not(feature = "software-only")))]
    {
        return if p.gl.borrow_mut().initialize().is_ok() {
            POCKET_STATUS_OK
        } else {
            POCKET_STATUS_FAILED
        };
    }
    #[cfg(any(feature = "std", feature = "software-only"))]
    {
        POCKET_STATUS_UNSUPPORTED
    }
}
/// # Safety
/// Program is live; context is current and native pre-UI commands are complete.
#[no_mangle]
pub unsafe extern "C" fn pocket_native_program_gl_render(
    program: *mut PocketNativeProgram,
    width: u32,
    height: u32,
    over: u32,
) -> i32 {
    unsafe {
        pocket_native_program_gl_render_rect(program, 0, 0, width, height, width, height, over)
    }
}
/// # Safety
/// Program is live and its GL context is current. The viewport is in physical
/// window coordinates and may extend beyond the window during native navigation.
#[no_mangle]
pub unsafe extern "C" fn pocket_native_program_gl_render_rect(
    program: *mut PocketNativeProgram,
    x: i32,
    y: i32,
    target_width: u32,
    target_height: u32,
    width: u32,
    height: u32,
    over: u32,
) -> i32 {
    let Some(p) = (unsafe { program.as_ref() }) else {
        return POCKET_STATUS_INVALID;
    };
    let Ok(_busy) = p.enter() else {
        return POCKET_STATUS_FAILED;
    };
    if width == 0
        || height == 0
        || width > 65535
        || height > 65535
        || over > 1
        || target_width == 0
        || target_height == 0
        || target_width > i32::MAX as u32
        || target_height > i32::MAX as u32
        || x.checked_add(target_width as i32).is_none()
        || y.checked_add(target_height as i32).is_none()
    {
        return POCKET_STATUS_INVALID;
    }
    #[cfg(all(not(feature = "std"), not(feature = "software-only")))]
    {
        let old = {
            let mut s = p.gl.borrow_mut();
            let old = s.window;
            s.window = [width, height];
            s.viewport = pocket_gles::Viewport::new(x, y, target_width, target_height);
            s.over = over != 0;
            old
        };
        if old != [width, height] {
            let status = unsafe { embed::resize_embedded_presentation(p.runtime, [width, height]) };
            if status != 0 {
                p.gl.borrow_mut().window = old;
                return status;
            }
        }
        p.begin_render();
        if let Some(trace) = p.gl.borrow().trace {
            trace(0, 0, 0);
        }
        let status = unsafe { embed::present(p.runtime) };
        p.record(status, width, height);
        status
    }
    #[cfg(any(feature = "std", feature = "software-only"))]
    {
        POCKET_STATUS_UNSUPPORTED
    }
}
/// # Safety
/// Program is live on its owning thread. Guest collect may call canonical ops.
#[no_mangle]
pub unsafe extern "C" fn pocket_native_program_collect(program: *mut PocketNativeProgram) -> i32 {
    let Some(p) = (unsafe { program.as_ref() }) else {
        return POCKET_STATUS_INVALID;
    };
    let Ok(_busy) = p.enter() else {
        return POCKET_STATUS_FAILED;
    };
    unsafe { embed::collect(p.runtime) }
}
/// # Safety
/// Program is live; called between guest turns. Only GPU programs support a
/// changing logical viewport; software buffers keep their construction size.
#[no_mangle]
pub unsafe extern "C" fn pocket_native_program_resize_viewport(
    program: *mut PocketNativeProgram,
    width: u32,
    height: u32,
) -> i32 {
    let Some(p) = (unsafe { program.as_ref() }) else {
        return POCKET_STATUS_INVALID;
    };
    let Ok(_busy) = p.enter() else {
        return POCKET_STATUS_FAILED;
    };
    if width == 0 || height == 0 || width > 4096 || height > 4096 {
        return POCKET_STATUS_INVALID;
    }
    #[cfg(all(not(feature = "std"), not(feature = "software-only")))]
    {
        let old = p.gl.borrow().window;
        p.gl.borrow_mut().window = [width, height];
        let status = unsafe { embed::resize_embedded(p.runtime, [width, height], [width, height]) };
        p.gl.borrow_mut().window = old;
        if status != 0 {
            return status;
        }
        p.viewport.set([width, height]);
        // Restore the native window extent after changing the logical viewport.
        unsafe { embed::resize_embedded_presentation(p.runtime, old) }
    }
    #[cfg(any(feature = "std", feature = "software-only"))]
    {
        POCKET_STATUS_UNSUPPORTED
    }
}
/// # Safety
/// Program is live; its GL context is current.
#[no_mangle]
pub unsafe extern "C" fn pocket_native_program_gl_reset(program: *mut PocketNativeProgram) {
    let Some(p) = (unsafe { program.as_ref() }) else {
        return;
    };
    let Ok(_busy) = p.enter() else {
        return;
    };
    #[cfg(all(not(feature = "std"), not(feature = "software-only")))]
    p.gl.borrow_mut().reset();
}
/// # Safety
/// Program is live; context remains current until graphics resources retire.
#[no_mangle]
pub unsafe extern "C" fn pocket_native_program_gl_shutdown(program: *mut PocketNativeProgram) {
    let Some(p) = (unsafe { program.as_ref() }) else {
        return;
    };
    let Ok(_busy) = p.enter() else {
        return;
    };
    #[cfg(all(not(feature = "std"), not(feature = "software-only")))]
    p.gl.borrow_mut().shutdown();
}

/// # Safety
/// Program and callback stay live on the owning thread. No GL access occurs.
#[no_mangle]
pub unsafe extern "C" fn pocket_native_program_set_gl_trace(
    program: *mut PocketNativeProgram,
    trace: Option<extern "C" fn(u32, u32, u32)>,
) {
    let Some(p) = (unsafe { program.as_ref() }) else {
        return;
    };
    let Ok(_busy) = p.enter() else {
        return;
    };
    #[cfg(all(not(feature = "std"), not(feature = "software-only")))]
    {
        let mut state = p.gl.borrow_mut();
        state.trace = trace;
        if let Some(driver) = state.driver.as_mut() {
            driver.set_trace(trace);
        }
    }
    #[cfg(any(feature = "std", feature = "software-only"))]
    let _ = trace;
}

#[cfg(all(test, feature = "std"))]
mod tests {
    use super::*;
    use pocket_runtime::{Guest, GuestEnvironment, GuestFrame, RuntimeError};
    use std::sync::Mutex;
    static SERIAL: Mutex<()> = Mutex::new(());
    #[derive(Default)]
    struct Facts {
        frames: usize,
        buttons: u32,
        touches: Vec<u32>,
        shutdowns: usize,
        initialized: bool,
    }
    struct TestGuest {
        facts: Rc<RefCell<Facts>>,
    }
    impl Guest for TestGuest {
        fn initialize(
            &mut self,
            _: OpContext,
            environment: &GuestEnvironment<'_>,
        ) -> Result<(), RuntimeError> {
            assert_eq!(environment.viewport, [32, 24]);
            assert!(environment.assets.is_none());
            self.facts.borrow_mut().initialized = true;
            Ok(())
        }
        fn evaluate(&mut self, code: &[u8]) -> Result<(), RuntimeError> {
            assert_eq!(code, b"fixture\0");
            Ok(())
        }
        fn frame(&mut self, input: &GuestFrame<'_>) -> Result<(), RuntimeError> {
            let mut f = self.facts.borrow_mut();
            f.frames += 1;
            f.buttons = input.buttons;
            f.touches = input.touches.to_vec();
            Ok(())
        }
        fn shutdown(&mut self) {
            self.facts.borrow_mut().shutdowns += 1;
        }
    }
    unsafe fn program() -> (*mut PocketNativeProgram, Rc<RefCell<Facts>>) {
        let code = b"fixture";
        let p = unsafe {
            pocket_native_program_create(
                c"qnx".as_ptr(),
                pocket_spec::BINDING_GENERATION,
                code.as_ptr(),
                code.len(),
                ptr::null(),
                0,
                32,
                24,
                1,
                0,
            )
        };
        assert!(!p.is_null());
        let facts = Rc::new(RefCell::new(Facts::default()));
        assert_eq!(
            unsafe {
                embed::set_guest(
                    (*p).runtime,
                    Box::new(TestGuest {
                        facts: facts.clone(),
                    }),
                )
            },
            0
        );
        assert_eq!(unsafe { pocket_native_program_boot(p) }, 0);
        (p, facts)
    }
    #[test]
    fn original_package_admission_preserves_plan_and_copies_source() {
        let _lock = SERIAL.lock().unwrap();
        let logical = [32u32, 24];
        let display = PocketProfileDisplay {
            physical: [32, 24],
            logical: logical.as_ptr(),
            logical_count: 1,
            raster_density: 1,
            ..PocketProfileDisplay::empty()
        };
        let profile = PocketProfileFacts {
            id: b"qnx".as_ptr(),
            id_length: 3,
            tick_hz: 60,
            input_classes: POCKET_INPUT_CLASS_BUTTONS,
            display: &display,
            ..PocketProfileFacts::empty()
        };
        let profile_hash = [0x51; 32];
        let package = |physics: bool| {
            let identity =
                pocket_package::embedded::identity("fixture", "dev.fixture", "Fixture").unwrap();
            let plan = format!(
                r#"{{"features":{{"ui.physics":{physics}}},"viewport":{{"logical":[32,24],"rasterDensity":1}}}}"#
            );
            pocket_package::embedded::encode(pocket_package::embedded::EmbeddedPackage {
                target: "qnx",
                host_abi: pocket_spec::BINDING_GENERATION,
                profile_hash,
                identity: &identity,
                plan: plan.as_bytes(),
                code: b"fixture",
                pak: &[],
            })
            .unwrap()
        };
        unsafe {
            let create_with =
                |bytes: &[u8], profile: *const PocketProfileFacts, hash: &[u8; 32]| {
                    pocket_native_program_create_package(
                        c"qnx".as_ptr(),
                        pocket_spec::BINDING_GENERATION,
                        bytes.as_ptr(),
                        bytes.len(),
                        c"fixture".as_ptr(),
                        c"dev.fixture".as_ptr(),
                        c"Fixture".as_ptr(),
                        32,
                        24,
                        1,
                        1,
                        profile,
                        hash.as_ptr(),
                    )
                };
            let bytes = package(false);
            // Admission needs the host build's facts, its hash, and a facts id equal to the target.
            assert!(create_with(&bytes, ptr::null(), &profile_hash).is_null());
            assert!(create_with(&bytes, &profile, &[0x52; 32]).is_null());
            let other = PocketProfileFacts {
                id: b"qnx-2".as_ptr(),
                id_length: 5,
                ..profile
            };
            assert!(create_with(&bytes, &other, &profile_hash).is_null());
            drop(bytes);
            let create = |bytes: &[u8], target, abi, title, width, density, physics| {
                pocket_native_program_create_package(
                    target,
                    abi,
                    bytes.as_ptr(),
                    bytes.len(),
                    c"fixture".as_ptr(),
                    c"dev.fixture".as_ptr(),
                    title,
                    width,
                    24,
                    density,
                    physics,
                    &profile,
                    profile_hash.as_ptr(),
                )
            };
            let bytes = package(false);
            assert!(create(
                &bytes,
                c"wrong".as_ptr(),
                pocket_spec::BINDING_GENERATION,
                c"Fixture".as_ptr(),
                32,
                1,
                1
            )
            .is_null());
            assert!(create(&bytes, c"qnx".as_ptr(), 2, c"Fixture".as_ptr(), 32, 1, 1).is_null());
            assert!(create(
                &bytes,
                c"qnx".as_ptr(),
                pocket_spec::BINDING_GENERATION,
                c"Wrong".as_ptr(),
                32,
                1,
                1
            )
            .is_null());
            assert!(create(
                &bytes,
                c"qnx".as_ptr(),
                pocket_spec::BINDING_GENERATION,
                c"Fixture".as_ptr(),
                33,
                1,
                1
            )
            .is_null());
            assert!(create(
                &bytes,
                c"qnx".as_ptr(),
                pocket_spec::BINDING_GENERATION,
                c"Fixture".as_ptr(),
                32,
                2,
                1
            )
            .is_null());
            assert!(create(
                &package(true),
                c"qnx".as_ptr(),
                pocket_spec::BINDING_GENERATION,
                c"Fixture".as_ptr(),
                32,
                1,
                0
            )
            .is_null());
            let p = create(
                &bytes,
                c"qnx".as_ptr(),
                pocket_spec::BINDING_GENERATION,
                c"Fixture".as_ptr(),
                32,
                1,
                1,
            );
            assert!(!p.is_null());
            drop(bytes);
            let facts = Rc::new(RefCell::new(Facts::default()));
            assert_eq!(
                embed::set_guest(
                    (*p).runtime,
                    Box::new(TestGuest {
                        facts: facts.clone()
                    })
                ),
                0
            );
            assert_eq!(pocket_native_program_boot(p), 0);
            assert!(facts.borrow().initialized);
            // Host permission does not turn on a feature absent from the original plan.
            assert!(!(*p).ops.supports_op(52));
            pocket_native_program_destroy(p);
        }
    }
    #[test]
    fn cpu_buffer_preserves_pixels_and_reports_actual_damage() {
        let _lock = SERIAL.lock().unwrap();
        unsafe {
            let (p, facts) = program();
            assert!(facts.borrow().initialized);
            let node = {
                let mut state = (*p).ops.core_mut().unwrap();
                let node = state.ui.create_node(0);
                state.ui.set_prop(node, 1, 8.);
                state.ui.set_prop(node, 2, 8.);
                state.ui.set_prop(node, 64, 0xff00_00ffu32 as f64);
                state.ui.insert_before(1, node, 0);
                state.ui.tick();
                node
            };
            let pixels = pocket_native_program_render_argb(p);
            assert!(!pixels.is_null());
            let before = core::slice::from_raw_parts(pixels, 32 * 24 * 4).to_vec();
            assert_eq!(pocket_native_program_damage_pixels(p), 32 * 24);
            assert_eq!(pocket_native_program_damage_full_redraws(p), 1);
            assert_eq!(pocket_native_program_render_argb(p), pixels);
            assert_eq!(pocket_native_program_damage_pixels(p), 0);
            assert_eq!(core::slice::from_raw_parts(pixels, before.len()), before);
            {
                let mut state = (*p).ops.core_mut().unwrap();
                state.ui.set_prop(node, 64, 0xff00_ff00u32 as f64);
                state.ui.tick();
            }
            assert_eq!(pocket_native_program_render_argb(p), pixels);
            let area = pocket_native_program_damage_pixels(p);
            assert!(area > 0 && area < 32 * 24, "{area}");
            let mut expected = alloc::vec![0;before.len()];
            {
                let mut state = (*p).ops.core_mut().unwrap();
                state.ui.draw();
                pocket_raster::render_scaled_argb(
                    &state.ui,
                    &state.ui.current_draw_list().words,
                    &mut expected,
                    1,
                );
            }
            assert_eq!(core::slice::from_raw_parts(pixels, before.len()), expected);
            pocket_native_program_destroy(p);
            assert_eq!(facts.borrow().shutdowns, 1);
        }
    }
    #[test]
    fn canonical_input_validation_precedes_guest_and_unpresented_turns_can_be_skipped() {
        let _lock = SERIAL.lock().unwrap();
        unsafe {
            let (p, facts) = program();
            let mut contact = PocketContact {
                x: 3.,
                y: 4.,
                id: 7,
                ..PocketContact::empty()
            };
            let mut input = PocketInputFrame {
                buttons: 123,
                contacts: &contact,
                contact_count: 1,
                ..PocketInputFrame::empty()
            };
            assert_eq!(pocket_native_program_advance(p, &input, 2), 0);
            assert_eq!(facts.borrow().touches, [7 << 18 | 4 << 9 | 3]);
            assert_eq!(facts.borrow().buttons, 123);
            assert_eq!(pocket_native_program_advance(p, &input, 1), 0);
            assert_eq!(facts.borrow().frames, 2);
            contact.x = f32::NAN;
            input.contacts = &contact;
            assert_eq!(
                pocket_native_program_advance(p, &input, 1),
                POCKET_STATUS_INVALID
            );
            assert_eq!(facts.borrow().frames, 2);
            assert!(!pocket_native_program_render_argb(p).is_null());
            pocket_native_program_destroy(p);
            assert_eq!(facts.borrow().shutdowns, 1);
        }
    }
    #[test]
    fn operation_context_becomes_inactive_after_program_destroy() {
        let _lock = SERIAL.lock().unwrap();
        unsafe {
            let (p, facts) = program();
            let ops = (*p).ops.clone();
            assert_eq!(
                pocket_native_program_gl_initialize(p),
                POCKET_STATUS_UNSUPPORTED
            );
            pocket_native_program_destroy(p);
            assert!(ops.core().is_err());
            assert_eq!(facts.borrow().shutdowns, 1);
        }
    }
}
