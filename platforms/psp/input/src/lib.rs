#![no_std]
use psp::sys::{self, CtrlMode, SceCtrlData};
pub fn initialize() {
    unsafe {
        sys::sceCtrlSetSamplingCycle(0);
        sys::sceCtrlSetSamplingMode(CtrlMode::Analog);
    }
}
pub fn sample() -> SceCtrlData {
    let mut state: SceCtrlData = unsafe { core::mem::zeroed() };
    unsafe {
        sys::sceCtrlPeekBufferPositive(&mut state, 1);
    }
    state
}
