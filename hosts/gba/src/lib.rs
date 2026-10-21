#![no_std]

pub mod video;

#[cfg(test)]
extern crate alloc;
#[cfg(test)]
extern crate self as pocketjs_gba;
#[cfg(test)]
mod presentation;
#[cfg(test)]
unsafe fn diagnostic(_: usize) -> u32 { panic!("hardware read in host test") }
#[cfg(test)]
unsafe fn diag(_: usize, _: u32) { panic!("hardware write in host test") }
#[cfg(test)]
unsafe fn cycles() -> u32 { panic!("hardware clock in host test") }
