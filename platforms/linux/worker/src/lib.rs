//! A Linux program's worker domain (`domains.worker` in an app contract):
//! engine/worker's C runner on its own thread (runner.rs), the `http` node over
//! the program's own [`Exchange`] (http.rs), and the UI realm's channel bridge
//! beside the rquickjs guest (guest.rs). Pocket Hub's CardputerZero program and
//! Omarchy Pocket's host run their packages' workers with it.
mod guest;
mod http;
mod runner;

pub use guest::{WorkerDomain, WorkerGuest};
pub use http::{
    contract_response_bytes, parse, Call, Exchange, Failure, HttpNode, Request, Response,
    DEFAULT_RESPONSE_BYTES, MAX_RESPONSE_BYTES, METHODS,
};
pub use runner::{Notify, Worker};
