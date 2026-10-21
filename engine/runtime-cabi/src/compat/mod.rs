//! Transitional entry points for hosts awaiting instance registration.
#[cfg(feature="legacy-ui")]
pub mod ui;
#[cfg(feature="legacy-idf")]
pub mod idf;
