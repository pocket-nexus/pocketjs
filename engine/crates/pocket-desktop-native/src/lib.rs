//! Trusted, co-built native apps. A versioned C entry validates build identity
//! before borrowing Rust GPU objects. The host owns scheduling, focus and the
//! render target; the module owns its state, guest realms and GPU resources.
use anyhow::{Result, anyhow};
pub use pocket3d::gpu::Gpu;
use std::{
    ffi::c_void,
    panic::{AssertUnwindSafe, catch_unwind},
    path::Path,
};
pub use wgpu;
pub const ABI: u32 = 1;
pub const BUILD: &str = env!("POCKET_NATIVE_BUILD");
pub const FORMAT: wgpu::TextureFormat = wgpu::TextureFormat::Rgba8Unorm;
/// View that encodes linear-light 3D shader output into the compositor image.
pub const LINEAR_FORMAT: wgpu::TextureFormat = wgpu::TextureFormat::Rgba8UnormSrgb;
pub const POINTER_LOCK: u32 = 1;
pub const KEY: u32 = 1;
pub const POINTER: u32 = 2;
pub const MOTION: u32 = 3;
pub const RESET: u32 = 4;
pub const SCROLL: u32 = 5;
pub const RESIZE: u32 = 6;

#[repr(C)]
#[derive(Clone, Copy, Debug, Default)]
pub struct Event {
    pub kind: u32,
    pub down: u32,
    pub button: u32,
    pub x: f32,
    pub y: f32,
    pub key: [u8; 32],
}
impl Event {
    pub fn key(name: &str, down: bool) -> Self {
        let mut event = Self {
            kind: KEY,
            down: u32::from(down),
            ..Self::default()
        };
        let len = name.len().min(31);
        event.key[..len].copy_from_slice(&name.as_bytes()[..len]);
        event
    }
    pub fn key_name(&self) -> &str {
        std::str::from_utf8(&self.key)
            .unwrap_or("")
            .trim_end_matches('\0')
    }
}
#[repr(C)]
pub struct Init {
    pub gpu: *const c_void,
    pub root: *const u8,
    pub root_len: usize,
    pub config: *const u8,
    pub config_len: usize,
    pub width: u32,
    pub height: u32,
    pub density: u32,
}
#[repr(C)]
pub struct Frame {
    pub gpu: *const c_void,
    pub encoder: *mut c_void,
    pub target: *const c_void,
    pub linear_target: *const c_void,
    pub width: u32,
    pub height: u32,
}
/// No allocator-owned strings, errors or collections cross the C boundary.
#[repr(C)]
#[derive(Clone, Copy)]
pub struct Api {
    pub abi: u32,
    pub size: u32,
    pub build: [u8; 64],
    pub graph: [u8; 64],
    pub package: [u8; 128],
    pub flags: u32,
    pub create: unsafe extern "C" fn(*const Init, *mut u8, usize) -> *mut c_void,
    pub event: unsafe extern "C" fn(*mut c_void, *const Event, *mut u8, usize) -> bool,
    pub tick: unsafe extern "C" fn(*mut c_void, f64, *mut u8, usize) -> bool,
    pub render: unsafe extern "C" fn(*mut c_void, *const Frame, *mut u8, usize) -> bool,
    pub destroy: unsafe extern "C" fn(*mut c_void),
}
pub struct Context<'a> {
    pub gpu: &'a Gpu,
    pub root: &'a Path,
    pub config: &'a str,
    pub logical: (u32, u32),
    pub density: u32,
}
pub struct Render<'a> {
    pub gpu: &'a Gpu,
    pub encoder: &'a mut wgpu::CommandEncoder,
    pub target: &'a wgpu::TextureView,
    pub linear_target: &'a wgpu::TextureView,
    pub pixels: (u32, u32),
}
pub trait Application: Sized + 'static {
    fn create(context: Context<'_>) -> Result<Self>;
    fn event(&mut self, event: &Event) -> Result<()>;
    fn tick(&mut self, dt: f64) -> Result<()>;
    fn render(&mut self, context: Render<'_>) -> Result<()>;
}
const fn fixed<const N: usize>(s: &str) -> [u8; N] {
    let mut out = [0; N];
    let mut i = 0;
    assert!(s.len() <= N);
    while i < s.len() {
        out[i] = s.as_bytes()[i];
        i += 1;
    }
    out
}
fn guard<T>(error: *mut u8, cap: usize, run: impl FnOnce() -> Result<T>) -> Option<T> {
    match catch_unwind(AssertUnwindSafe(run))
        .unwrap_or_else(|_| Err(anyhow!("native application panicked")))
    {
        Ok(value) => Some(value),
        Err(e) => {
            let text = format!("{e:#}");
            if !error.is_null() && cap > 0 {
                let n = text.len().min(cap - 1);
                unsafe {
                    std::ptr::copy_nonoverlapping(text.as_ptr(), error, n);
                    *error.add(n) = 0;
                }
            }
            None
        }
    }
}
unsafe extern "C" fn create<A: Application>(
    init: *const Init,
    error: *mut u8,
    cap: usize,
) -> *mut c_void {
    guard(error, cap, || {
        let init = unsafe { init.as_ref() }.ok_or_else(|| anyhow!("missing native init"))?;
        let root =
            std::str::from_utf8(unsafe { std::slice::from_raw_parts(init.root, init.root_len) })?;
        let config = std::str::from_utf8(unsafe {
            std::slice::from_raw_parts(init.config, init.config_len)
        })?;
        let app = A::create(Context {
            gpu: unsafe { &*(init.gpu as *const Gpu) },
            root: Path::new(root),
            config,
            logical: (init.width, init.height),
            density: init.density,
        })?;
        Ok(Box::into_raw(Box::new(app)).cast())
    })
    .unwrap_or(std::ptr::null_mut())
}
unsafe extern "C" fn event<A: Application>(
    app: *mut c_void,
    event: *const Event,
    error: *mut u8,
    cap: usize,
) -> bool {
    guard(error, cap, || unsafe {
        (&mut *app.cast::<A>()).event(&*event)
    })
    .is_some()
}
unsafe extern "C" fn tick<A: Application>(
    app: *mut c_void,
    dt: f64,
    error: *mut u8,
    cap: usize,
) -> bool {
    guard(error, cap, || unsafe { (&mut *app.cast::<A>()).tick(dt) }).is_some()
}
unsafe extern "C" fn render<A: Application>(
    app: *mut c_void,
    frame: *const Frame,
    error: *mut u8,
    cap: usize,
) -> bool {
    guard(error, cap, || unsafe {
        let frame = &*frame;
        (&mut *app.cast::<A>()).render(Render {
            gpu: &*frame.gpu.cast::<Gpu>(),
            encoder: &mut *frame.encoder.cast(),
            target: &*frame.target.cast(),
            linear_target: &*frame.linear_target.cast(),
            pixels: (frame.width, frame.height),
        })
    })
    .is_some()
}
unsafe extern "C" fn destroy<A: Application>(app: *mut c_void) {
    let _ = catch_unwind(AssertUnwindSafe(|| unsafe {
        drop(Box::from_raw(app.cast::<A>()))
    }));
}
pub const fn api<A: Application>(package: &str, flags: u32, graph: &str) -> Api {
    Api {
        abi: ABI,
        size: std::mem::size_of::<Api>() as u32,
        build: fixed(BUILD),
        graph: fixed(graph),
        package: fixed(package),
        flags,
        create: create::<A>,
        event: event::<A>,
        tick: tick::<A>,
        render: render::<A>,
        destroy: destroy::<A>,
    }
}
#[macro_export]
macro_rules! export_application {
    ($app:ty, $package:literal, $flags:expr) => {
        #[unsafe(no_mangle)]
        pub extern "C" fn pocket_native_app_v1() -> *const $crate::Api {
            static API: $crate::Api =
                $crate::api::<$app>($package, $flags, env!("POCKET_NATIVE_GRAPH"));
            &API
        }
    };
}
