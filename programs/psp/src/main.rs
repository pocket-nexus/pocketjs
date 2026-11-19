#![no_std]
#![no_main]

//! The stock PSP program: the embedded application, or app.pkb beside the
//! EBOOT in the generic runtime, driven by the library's frame loop
//! (src/frame.rs) until the process exits. A guest that fails to start halts
//! with its error on the debug screen.

use pocketjs_psp::frame::{self, Program};

pocketjs_psp::module!("pocketjs", run);

struct Stock;
impl Program for Stock {
    type Exit = core::convert::Infallible;
}

fn run() {
    unsafe {
        let ran = pocketjs_psp::embedded::source().and_then(|source| {
            frame::run(source, pocketjs_psp::Options::default(), &mut Stock)
        });
        match ran {
            Ok(never) => match never {},
            Err(error) => frame::halt(&error),
        }
    }
}
