//! Ticker deadlines on a 32,768 Hz clock, the rate of embassy-nrf's RTC time driver.
use embassy_time_driver::{Driver, TICK_HZ, time_driver_impl};
use pocket_embassy::runner::Ticker;
use pocket_runtime::Timing;
use std::{
    future::Future,
    pin::pin,
    sync::{
        Arc, Mutex,
        atomic::{AtomicU64, AtomicUsize, Ordering},
    },
    task::{Context, Poll, Wake, Waker},
};

/// A clock that advances when the test steps it, with one pending alarm.
struct SteppedClock {
    now: AtomicU64,
    alarm: Mutex<Option<(u64, Waker)>>,
}
impl Driver for SteppedClock {
    fn now(&self) -> u64 {
        self.now.load(Ordering::SeqCst)
    }
    fn schedule_wake(&self, at: u64, waker: &Waker) {
        if at <= self.now() {
            waker.wake_by_ref();
        } else {
            *self.alarm.lock().unwrap() = Some((at, waker.clone()));
        }
    }
}
time_driver_impl!(static CLOCK: SteppedClock = SteppedClock {
    now: AtomicU64::new(0),
    alarm: Mutex::new(None),
});
fn step_to(ticks: u64) {
    CLOCK.now.store(ticks, Ordering::SeqCst);
    let due = CLOCK.alarm.lock().unwrap().take_if(|(at, _)| *at <= ticks);
    if let Some((_, waker)) = due {
        waker.wake();
    }
}
fn alarm() -> Option<u64> {
    CLOCK.alarm.lock().unwrap().as_ref().map(|(at, _)| *at)
}

#[derive(Default)]
struct Wakes(AtomicUsize);
impl Wake for Wakes {
    fn wake(self: Arc<Self>) {
        self.wake_by_ref();
    }
    fn wake_by_ref(self: &Arc<Self>) {
        self.0.fetch_add(1, Ordering::SeqCst);
    }
}

#[test]
fn ticker_sleeps_until_the_first_clock_tick_at_or_after_each_deadline() {
    assert_eq!(TICK_HZ, 32_768);
    let wakes = Arc::new(Wakes::default());
    let waker = Waker::from(wakes.clone());
    let mut context = Context::from_waker(&waker);
    let woken = || wakes.0.load(Ordering::SeqCst);
    let mut ticker = Ticker::new(
        Timing {
            tick_hz: 30,
            cadence_hz: 30,
        },
        100_000,
    )
    .unwrap();
    {
        // Tick 0 is due at the start time; an expired Timer yields once.
        let mut next = pin!(ticker.next());
        assert!(next.as_mut().poll(&mut context).is_pending());
        let Poll::Ready(Ok(tick)) = next.as_mut().poll(&mut context) else {
            panic!("tick 0 is due at 0 us");
        };
        assert_eq!(tick.index, 0);
    }
    // Tick 1 is due at 33,333 us: clock tick 1,092 is 33,325 us and 1,093 is 33,355 us.
    let mut next = pin!(ticker.next());
    let before = woken();
    assert!(next.as_mut().poll(&mut context).is_pending());
    assert_eq!(alarm(), Some(1_093));
    step_to(1_092);
    assert_eq!(woken(), before, "the alarm fired before the deadline");
    step_to(1_093);
    assert_eq!(woken(), before + 1);
    let Poll::Ready(Ok(tick)) = next.as_mut().poll(&mut context) else {
        panic!("tick 1 is due at clock tick 1,093");
    };
    assert_eq!((tick.index, tick.deadline, tick.skipped), (1, 33_333, 0));
    assert_eq!(
        woken(),
        before + 1,
        "the ticker re-polled without a clock advance"
    );
}
