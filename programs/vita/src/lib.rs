#![allow(static_mut_refs)]
extern crate alloc;
pub use pocket_vita_audio as audio;
pub mod dbg;
pub mod dev;
#[cfg(feature = "usb-debug")]
mod dev_delivery;
pub mod dev_protocol;
pub mod devmenu;
pub mod scene;
pub mod service_bindings;
pub use pocket_vita_input as input;
pub use scene as graphics;
mod instance;
pub use pocket_vita_net as net;
#[cfg(feature = "runtime")]
pub mod package_file;
pub use pocket_package::pak;
pub mod stats;
pub mod svc;
pub mod switch;
pub mod vid;

mod program;
pub use pocket_vita_system::vita_log;
pub use program::{Runtime, UiGuard};
