#![no_std]
#![allow(static_mut_refs)]
extern crate alloc;
pub mod debug_mailbox;
pub mod local;
pub mod mailbox;
pub mod offload;
pub mod package;
pub mod packet;
pub mod stats;
