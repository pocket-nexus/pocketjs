//! Monotonic deadlines for one guest turn per runtime tick. Platform code owns
//! waiting, cancellation and threads; a missed wall-clock slot does not execute
//! extra guest turns or advance simulation time.

use crate::RuntimeError;
use pocket_drivers::Clock;

const MICROS_PER_SECOND: u64 = 1_000_000;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct TickTiming {
    pub index: u64,
    pub deadline: u64,
    pub skipped: u64,
}

pub struct TickSchedule {
    tick_hz: u32,
    started: u64,
    next: u64,
    max_lag_us: u64,
}
impl TickSchedule {
    pub fn new(tick_hz: u32, started: u64, max_lag_us: u64) -> Result<Self, RuntimeError> {
        if tick_hz == 0 || tick_hz > pocketjs_core::MAX_TICK_HZ || max_lag_us == 0 {
            return Err(RuntimeError::InvalidConfiguration);
        }
        Ok(Self {
            tick_hz,
            started,
            next: 0,
            max_lag_us,
        })
    }
    fn deadline_for(&self, tick: u64) -> Result<u64, RuntimeError> {
        let hz = self.tick_hz as u64;
        // Division before multiplication prevents overflow without u128
        // arithmetic on targets whose compiler lowers it to helper calls.
        (tick / hz)
            .checked_mul(MICROS_PER_SECOND)
            .and_then(|whole| whole.checked_add((tick % hz) * MICROS_PER_SECOND / hz))
            .and_then(|offset| self.started.checked_add(offset))
            .ok_or(RuntimeError::InvalidState)
    }
    pub fn deadline(&self) -> Result<u64, RuntimeError> {
        self.deadline_for(self.next)
    }
    /// Reserve one due slot. Early wakeups leave the schedule unchanged. Lag
    /// above the configured limit skips old slots, then returns exactly one.
    pub fn poll(&mut self, now: u64) -> Result<Option<TickTiming>, RuntimeError> {
        if now < self.started {
            return Err(RuntimeError::InvalidArgument);
        }
        let deadline = self.deadline()?;
        if now < deadline {
            return Ok(None);
        }
        let mut index = self.next;
        if now - deadline > self.max_lag_us {
            let elapsed = now - self.started;
            let hz = self.tick_hz as u64;
            index = (elapsed / MICROS_PER_SECOND) * hz
                + (elapsed % MICROS_PER_SECOND) * hz / MICROS_PER_SECOND;
            index = index.max(self.next);
        }
        let result = TickTiming {
            index,
            deadline: self.deadline_for(index)?,
            skipped: index - self.next,
        };
        self.next = index.checked_add(1).ok_or(RuntimeError::InvalidState)?;
        Ok(Some(result))
    }
    /// Convenience for a thread whose clock wait cannot be cancelled. Event
    /// loops and cancellable threads use deadline/poll around their own wait.
    pub fn wait_next(&mut self, clock: &mut impl Clock) -> Result<TickTiming, RuntimeError> {
        loop {
            if let Some(tick) = self.poll(clock.now())? {
                return Ok(tick);
            }
            clock.sleep_until(self.deadline()?);
        }
    }
}
