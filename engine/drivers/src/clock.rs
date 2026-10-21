//! Platform timing. The runtime owns tick policy and script execution.

pub trait Clock {
    /// Monotonic microseconds in this clock's time domain. Successive readings
    /// do not move backwards; the origin need not be a wall-clock epoch.
    fn now(&self) -> u64;

    /// Wait until the monotonic deadline. A deadline at or before `now()`
    /// returns without waiting. This method performs no runtime tick and
    /// executes no application code.
    fn sleep_until(&mut self, deadline: u64);
}
