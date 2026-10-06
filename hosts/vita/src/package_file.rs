//! The generic runtime's game (feature `runtime`): `app0:app.pocket`, the file
//! the repack step (tools/repack/vita.ts) puts at the root of the VPK.
//!
//! Read once, on first use, into a 16-byte-aligned block that lives for the
//! process (package payloads are 16-aligned relative to the file start, as
//! the embedded packages build.rs anchors). `select_guest` checks the footer
//! hash, the `vita` variant and host ABI 2. The runtime has no compiled app
//! id: the file is the app.

use std::alloc::{alloc, Layout};
use std::io::Read;
use std::sync::OnceLock;

use pocketjs_core::package::{self, GuestError, Package, PackageError};

use crate::switch::GuestBytes;

/// The file the runtime reads.
pub const PATH: &str = "app0:app.pocket";
const NAME: &str = "app.pocket";
const HOST_ABI: u32 = 2;

static GAME: OnceLock<Result<GuestBytes, String>> = OnceLock::new();

/// The admitted game, or one line for the screen that says what is wrong.
pub fn game() -> Result<GuestBytes, String> {
    GAME.get_or_init(load).clone()
}

fn load() -> Result<GuestBytes, String> {
    let mut file = std::fs::File::open(PATH).map_err(|error| match error.kind() {
        std::io::ErrorKind::NotFound => format!("No {NAME} in this game's package ({PATH})."),
        _ => format!("{NAME} could not be opened: {error}."),
    })?;
    let size = file
        .metadata()
        .map_err(|error| format!("{NAME} could not be read: {error}."))?
        .len() as usize;
    if size == 0 {
        return Err(format!("{NAME} is empty."));
    }
    let layout = Layout::from_size_align(size, 16).map_err(|_| format!("{NAME} is too large."))?;
    // SAFETY: a non-zero size; the block is never freed (the game lives for
    // the process) and is fully written by read_exact before it is read.
    let bytes: &'static mut [u8] = unsafe {
        let pointer = alloc(layout);
        if pointer.is_null() {
            return Err(format!("{NAME} needs {} KB of memory, which is not free.", size / 1024));
        }
        std::slice::from_raw_parts_mut(pointer, size)
    };
    file.read_exact(bytes)
        .map_err(|error| format!("{NAME} could not be read: {error}."))?;
    let bytes: &'static [u8] = bytes;
    let target = env!("POCKETJS_TARGET");
    let guest = package::select_guest(bytes, target, HOST_ABI, false).map_err(|error| {
        let abi = Package::parse(bytes, true)
            .ok()
            .and_then(|p| p.find_variant(target).ok().flatten())
            .map(|v| v.host_abi)
            .unwrap_or(0);
        message(error, abi)
    })?;
    let js = std::str::from_utf8(guest.js)
        .map_err(|_| format!("{NAME}'s {target} JavaScript is not UTF-8."))?;
    Ok(GuestBytes { js, pak: guest.pak })
}

fn message(error: GuestError, abi: u32) -> String {
    let target = env!("POCKETJS_TARGET");
    match error {
        GuestError::Package(PackageError::Truncated) => format!("{NAME} is cut short."),
        GuestError::Package(PackageError::BadMagic) => format!("{NAME} is not a PocketJS package."),
        GuestError::Package(PackageError::BadVersion) => {
            format!("{NAME} has a package version this runtime does not read.")
        }
        GuestError::Package(PackageError::HashMismatch) => {
            format!("{NAME} is damaged (its footer hash does not match).")
        }
        GuestError::Package(PackageError::BadUtf8) => format!("{NAME} has an unreadable variant table."),
        GuestError::MissingVariant => format!("{NAME} has no {target} variant."),
        GuestError::HostAbiMismatch => {
            format!("{NAME} is built for host ABI {abi}; this runtime is host ABI {HOST_ABI}.")
        }
        GuestError::MissingIdentity => format!("{NAME}'s {target} variant has no identity section."),
        GuestError::MissingPlan => format!("{NAME}'s {target} variant has no plan section."),
        GuestError::MissingJavaScript => format!("{NAME}'s {target} variant has no JavaScript."),
        GuestError::JavaScriptNotTerminated => {
            format!("{NAME}'s {target} JavaScript does not end in NUL.")
        }
    }
}
