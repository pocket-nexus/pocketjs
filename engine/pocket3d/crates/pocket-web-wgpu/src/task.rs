//! Something that waits (a read, a device's answer), started from a frame.

use std::future::Future;

/// Runs `work` beside the frames. In a tab it goes on when what it waits for arrives; elsewhere nothing here
/// waits on a network, and it has run to its end when this returns.
pub fn spawn(work: impl Future<Output = ()> + 'static) {
    #[cfg(target_arch = "wasm32")]
    wasm_bindgen_futures::spawn_local(work);
    #[cfg(not(target_arch = "wasm32"))]
    pollster::block_on(work);
}

/// Runs `work` to its end on this thread. Not in a tab: a tab's thread must not wait.
#[cfg(not(target_arch = "wasm32"))]
pub fn wait<T>(work: impl Future<Output = T>) -> T {
    pollster::block_on(work)
}

/// Milliseconds on a clock that only goes forward, from some start.
pub fn now() -> f64 {
    #[cfg(target_arch = "wasm32")]
    {
        use wasm_bindgen::JsCast;
        let global = js_sys::global();
        let clock = match global.dyn_ref::<web_sys::Window>() {
            Some(window) => window.performance(),
            None => global.unchecked_ref::<web_sys::WorkerGlobalScope>().performance(),
        };
        clock.map(|c| c.now()).unwrap_or(0.0)
    }
    #[cfg(not(target_arch = "wasm32"))]
    {
        use std::sync::OnceLock;
        use std::time::Instant;
        static START: OnceLock<Instant> = OnceLock::new();
        START.get_or_init(Instant::now).elapsed().as_secs_f64() * 1000.0
    }
}
