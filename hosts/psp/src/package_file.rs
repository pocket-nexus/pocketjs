//! The generic runtime's game (feature `runtime`): `app.pocket` beside the
//! EBOOT, read once at boot into a kernel block of its own.
//!
//! rust-psp's module entry changes the directory to the EBOOT's folder
//! (argv[0] up to its last '/') before `psp_main` runs, so the relative name
//! resolves to `ms0:/PSP/GAME/<folder>/app.pocket` from the XMB and to
//! `host0:/app.pocket` when PSPLINK starts `host0:/DATA.PSP`. The read runs
//! on that main thread before anything allocates: the block takes the place
//! the embedded build's .rodata copy takes, and the arena (arena.rs) reserves
//! what is left at the first allocation.
//!
//! The footer hash, the variant for this target and its host ABI are checked
//! here (`pocketjs_core::package::select_guest`). The block is never freed,
//! so the js and pak slices stay valid for the life of the process.

use alloc::format;
use alloc::string::String;
use core::ffi::c_void;
use core::ptr;

use pocketjs_core::package::{self, GuestError, Package, PackageError};
use psp::sys::{self, IoOpenFlags, IoWhence, SceSysMemBlockTypes, SceSysMemPartitionId};

/// The file the runtime reads, relative to the EBOOT's folder.
pub const FILE_NAME: &str = "app.pocket";
const PATH: &[u8] = b"app.pocket\0";
/// sceIoRead is called in pieces of this size (the Memory Stick driver
/// returns short reads for larger requests on some firmware).
const READ_CHUNK: usize = 1 << 20;

/// Why the file cannot start a game. Each has one line of text for the
/// screen (`message`).
#[derive(Clone, Copy)]
pub enum Fault {
    /// No file of that name in the EBOOT's folder.
    Missing,
    Empty,
    /// The kernel had no block of that size.
    TooLarge { size: usize, free: usize },
    /// sceIoRead failed or ended before the size sceIoLseek reported.
    Read { at: usize, size: usize, code: i32 },
    /// The bytes are not a package this runtime admits. `abi` is the
    /// variant's host ABI when it is the reason.
    Package { error: GuestError, abi: u32 },
}

/// The admitted game: zero-copy slices of the loaded block.
#[derive(Clone, Copy)]
pub struct Game {
    pub js: &'static [u8],
    pub pak: &'static [u8],
    /// Bytes of the whole file (its kernel block).
    pub file_bytes: usize,
}

static mut STATE: Option<Result<Game, Fault>> = None;

fn host_abi() -> u32 {
    let mut value = 0u32;
    for b in env!("POCKETJS_HOST_ABI").bytes() {
        value = value * 10 + (b - b'0') as u32;
    }
    value
}

/// Read and admit `app.pocket`. Call once, on the module's main thread,
/// before the first allocation.
///
/// # Safety
/// Single-threaded boot contract: no other thread reads `STATE` yet.
pub unsafe fn load() {
    STATE = Some(read_and_admit());
}

/// The result of `load` (Missing when `load` never ran).
///
/// # Safety
/// Read after `load` returned; never written again.
pub unsafe fn game() -> Result<Game, Fault> {
    STATE.unwrap_or(Err(Fault::Missing))
}

unsafe fn read_and_admit() -> Result<Game, Fault> {
    let fd = sys::sceIoOpen(PATH.as_ptr(), IoOpenFlags::RD_ONLY, 0);
    if fd.0 < 0 {
        return Err(Fault::Missing);
    }
    let end = sys::sceIoLseek(fd, 0, IoWhence::End);
    sys::sceIoLseek(fd, 0, IoWhence::Set);
    if end <= 0 {
        sys::sceIoClose(fd);
        return Err(Fault::Empty);
    }
    let size = end as usize;
    let block = sys::sceKernelAllocPartitionMemory(
        SceSysMemPartitionId::SceKernelPrimaryUserPartition,
        b"PocketJS-app\0".as_ptr(),
        SceSysMemBlockTypes::Low,
        size as u32,
        ptr::null_mut::<c_void>(),
    );
    if block.0 < 0 {
        sys::sceIoClose(fd);
        return Err(Fault::TooLarge { size, free: sys::sceKernelMaxFreeMemSize() as usize });
    }
    let base = sys::sceKernelGetBlockHeadAddr(block) as *mut u8;
    let mut at = 0usize;
    while at < size {
        let want = (size - at).min(READ_CHUNK);
        let got = sys::sceIoRead(fd, base.add(at) as *mut c_void, want as u32);
        if got <= 0 {
            sys::sceIoClose(fd);
            sys::sceKernelFreePartitionMemory(block);
            return Err(Fault::Read { at, size, code: got });
        }
        at += got as usize;
    }
    sys::sceIoClose(fd);

    let bytes: &'static [u8] = core::slice::from_raw_parts(base, size);
    let target = env!("POCKETJS_TARGET");
    match package::select_guest(bytes, target, host_abi(), false) {
        Ok(guest) => Ok(Game { js: guest.js, pak: guest.pak, file_bytes: size }),
        Err(error) => {
            let abi = Package::parse(bytes, true)
                .ok()
                .and_then(|p| p.find_variant(target).ok().flatten())
                .map(|v| v.host_abi)
                .unwrap_or(0);
            sys::sceKernelFreePartitionMemory(block);
            Err(Fault::Package { error, abi })
        }
    }
}

impl Fault {
    /// One line for the screen: what is wrong with the file.
    pub fn message(&self) -> String {
        let target = env!("POCKETJS_TARGET");
        match *self {
            Fault::Missing => format!("No {FILE_NAME} in this game's folder (next to EBOOT.PBP)."),
            Fault::Empty => format!("{FILE_NAME} is empty."),
            Fault::TooLarge { size, free } => format!(
                "{FILE_NAME} needs {} KB of memory; {} KB are free.",
                size / 1024,
                free / 1024
            ),
            Fault::Read { at, size, code } => format!(
                "{FILE_NAME} could not be read: stopped at byte {at} of {size} (0x{:08x}).",
                code as u32
            ),
            Fault::Package { error, abi } => match error {
                GuestError::Package(PackageError::Truncated) => format!("{FILE_NAME} is cut short."),
                GuestError::Package(PackageError::BadMagic) => {
                    format!("{FILE_NAME} is not a PocketJS package.")
                }
                GuestError::Package(PackageError::BadVersion) => {
                    format!("{FILE_NAME} has a package version this runtime does not read.")
                }
                GuestError::Package(PackageError::HashMismatch) => {
                    format!("{FILE_NAME} is damaged (its footer hash does not match).")
                }
                GuestError::Package(PackageError::BadUtf8) => {
                    format!("{FILE_NAME} has an unreadable variant table.")
                }
                GuestError::MissingVariant => format!("{FILE_NAME} has no {target} variant."),
                GuestError::HostAbiMismatch => format!(
                    "{FILE_NAME} is built for host ABI {abi}; this runtime is host ABI {}.",
                    host_abi()
                ),
                GuestError::MissingIdentity => {
                    format!("{FILE_NAME}'s {target} variant has no identity section.")
                }
                GuestError::MissingPlan => format!("{FILE_NAME}'s {target} variant has no plan section."),
                GuestError::MissingJavaScript => {
                    format!("{FILE_NAME}'s {target} variant has no JavaScript.")
                }
                GuestError::JavaScriptNotTerminated => {
                    format!("{FILE_NAME}'s {target} JavaScript does not end in NUL.")
                }
            },
        }
    }
}
