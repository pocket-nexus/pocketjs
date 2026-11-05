use pocket_drivers::Clock;
use pocket_runtime::{timing::TickSchedule, RuntimeError};

#[test]
fn fractional_deadlines_do_not_accumulate_rounding_drift() {
    for hz in [1, 30, 59, 60, 120, 144, 240] {
        let mut schedule = TickSchedule::new(hz, 123, 500_000).unwrap();
        for tick in 0..hz as u64 * 3600 {
            let expected = 123 + tick * 1_000_000 / hz as u64;
            assert_eq!(schedule.deadline().unwrap(), expected);
            let due = schedule.poll(expected).unwrap().unwrap();
            assert_eq!((due.index, due.deadline, due.skipped), (tick, expected, 0));
            assert!(schedule.poll(expected).unwrap().is_none());
        }
    }
}

#[test]
fn lag_skips_wall_slots_without_extra_turns_or_losing_deadline_phase() {
    let mut schedule = TickSchedule::new(60, 1_000_000, 500_000).unwrap();
    assert_eq!(schedule.poll(1_000_000).unwrap().unwrap().index, 0);
    let due = schedule.poll(3_010_000).unwrap().unwrap();
    assert_eq!(
        (due.index, due.skipped, due.deadline),
        (120, 119, 3_000_000)
    );
    assert_eq!(schedule.deadline().unwrap(), 3_016_666);
    assert!(schedule.poll(3_010_000).unwrap().is_none());
}

#[test]
fn invalid_clock_origin_and_deadline_overflow_fail_without_wrapping() {
    assert!(TickSchedule::new(0, 0, 1).is_err());
    assert!(TickSchedule::new(241, 0, 1).is_err());
    assert!(TickSchedule::new(60, 0, 0).is_err());
    let mut schedule = TickSchedule::new(60, u64::MAX - 100, 1).unwrap();
    assert_eq!(schedule.poll(0), Err(RuntimeError::InvalidArgument));
    assert!(schedule.poll(u64::MAX - 100).unwrap().is_some());
    assert_eq!(schedule.deadline(), Err(RuntimeError::InvalidState));
    let mut schedule = TickSchedule::new(240, 0, 1).unwrap();
    let due = schedule.poll(u64::MAX).unwrap().unwrap();
    assert_eq!(due.index, ((u64::MAX as u128 * 240) / 1_000_000) as u64);
}

#[test]
fn clock_wait_helper_rechecks_after_early_wakeup() {
    struct TestClock {
        now: u64,
        waits: usize,
    }
    impl Clock for TestClock {
        fn now(&self) -> u64 {
            self.now
        }
        fn sleep_until(&mut self, deadline: u64) {
            self.waits += 1;
            self.now = if self.waits == 1 {
                deadline - 1
            } else {
                deadline
            };
        }
    }
    let mut schedule = TickSchedule::new(60, 10, 1).unwrap();
    let mut clock = TestClock { now: 10, waits: 0 };
    assert_eq!(schedule.wait_next(&mut clock).unwrap().index, 0);
    assert_eq!(schedule.wait_next(&mut clock).unwrap().index, 1);
    assert_eq!(clock.waits, 2);
}
