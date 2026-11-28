//! A PocketJS guest on JavaScriptCore (Apple platforms and Linux via WebKitGTK's
//! `javascriptcoregtk`).
//!
//! [`JscGuest`] implements [`pocket_runtime::Guest`]: the runtime's generated
//! operation table becomes `globalThis.ui`, the package script evaluates in a
//! global context, and `frame` receives the canonical eleven arguments. The
//! namespace, coercions and frame facts match `pocket-guest-rquickjs`'s
//! canonical binding profile, so a bundle runs unchanged on either guest.
//!
//! The [`jsc`] module is the C API and a thin handle layer that hosts use to
//! mount their own namespaces into the same realm ([`JscGuest::with_setup`])
//! and to call back into it ([`Realm::ctx`]).
//!
//! On macOS the engine JIT-compiles only in processes signed with the
//! `com.apple.security.cs.allow-jit` entitlement; without it the interpreter
//! runs the same code. On Linux `javascriptcoregtk-6.0` or `4.1` runs with JIT
//! out of the box.
#![cfg(any(target_vendor = "apple", pocket_guest_jsc_linux))]

mod guest;
pub mod jsc;

pub use guest::{call_frame, mount_ui, JscGuest, Realm};

#[cfg(test)]
mod tests;
