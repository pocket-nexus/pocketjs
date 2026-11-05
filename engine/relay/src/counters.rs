//! Sequence and credit counters (R5 draft §3.9, R5-P09).
//!
//! [`Seq`] is the per-`(session, stream, direction)` frame counter: it starts
//! at 1 and never wraps, so a receiver that sees a gap or a repeat has lost
//! frame boundaries and must reset the stream rather than carry on.
//!
//! [`Credit`] is the bounded-queue half. The sender tracks what it has put in
//! flight; the receiver publishes cumulative `framesReleased`/`bytesReleased`
//! in a CREDIT frame. In flight is the difference, and both cumulative
//! counters are u64 and monotone — a CREDIT that moves one backwards, or past
//! what was sent, is a protocol error, not a number to clamp.

/// A counter refused an update.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub enum CounterError {
    /// The first frame on the stream did not carry seq 1.
    SeqStart,
    /// A sequence number was skipped.
    SeqGap,
    /// A sequence number was seen again or moved backwards.
    SeqReplay,
    /// The u32 sequence space is spent. Sequence numbers never wrap, so the
    /// stream must be reopened.
    SeqExhausted,
    /// The send would exceed the window that is currently released.
    CreditExhausted,
    /// The frame is larger than the whole window, so no release can ever admit
    /// it. The window was negotiated too small for this frame size.
    CreditWindowTooSmall,
    /// A cumulative release counter moved backwards.
    CreditRegression,
    /// A release claimed more frames or bytes than were ever sent.
    CreditOverrun,
}

impl core::fmt::Display for CounterError {
    fn fmt(&self, f: &mut core::fmt::Formatter<'_>) -> core::fmt::Result {
        f.write_str(match self {
            Self::SeqStart => "SEQ_START",
            Self::SeqGap => "SEQ_GAP",
            Self::SeqReplay => "SEQ_REPLAY",
            Self::SeqExhausted => "SEQ_EXHAUSTED",
            Self::CreditExhausted => "CREDIT_EXHAUSTED",
            Self::CreditWindowTooSmall => "CREDIT_WINDOW_TOO_SMALL",
            Self::CreditRegression => "CREDIT_REGRESSION",
            Self::CreditOverrun => "CREDIT_OVERRUN",
        })
    }
}

#[cfg(feature = "std")]
impl std::error::Error for CounterError {}

/// The frame counter for one `(session, stream, direction)`.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct Seq {
    last: u32,
}

impl Seq {
    /// A counter on a stream that has carried no frame yet.
    pub const fn new() -> Self {
        Self { last: 0 }
    }

    /// The last number emitted or accepted; 0 before the first frame.
    pub const fn last(&self) -> u32 {
        self.last
    }

    /// Advances the counter and returns the number to send. The first call
    /// returns 1.
    pub fn advance(&mut self) -> Result<u32, CounterError> {
        if self.last == u32::MAX {
            return Err(CounterError::SeqExhausted);
        }
        self.last += 1;
        Ok(self.last)
    }

    /// Accepts a received number, which must be exactly one past the last.
    pub fn accept(&mut self, seq: u32) -> Result<(), CounterError> {
        if seq == 0 {
            return Err(CounterError::SeqStart);
        }
        if seq <= self.last {
            return Err(CounterError::SeqReplay);
        }
        if seq != self.last + 1 {
            return Err(if self.last == 0 { CounterError::SeqStart } else { CounterError::SeqGap });
        }
        self.last = seq;
        Ok(())
    }
}

/// The sender's half of one direction's bounded queue.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Credit {
    window_frames: u32,
    window_bytes: u32,
    sent_frames: u64,
    sent_bytes: u64,
    released_frames: u64,
    released_bytes: u64,
}

impl Credit {
    /// A window with nothing in flight. Both bounds come from the negotiated
    /// [`crate::RxLimits`].
    pub const fn new(window_frames: u32, window_bytes: u32) -> Self {
        Self {
            window_frames,
            window_bytes,
            sent_frames: 0,
            sent_bytes: 0,
            released_frames: 0,
            released_bytes: 0,
        }
    }

    /// Frames sent and not yet released.
    pub const fn in_flight_frames(&self) -> u64 {
        self.sent_frames - self.released_frames
    }

    /// Bytes sent and not yet released.
    pub const fn in_flight_bytes(&self) -> u64 {
        self.sent_bytes - self.released_bytes
    }

    /// Cumulative frames the peer has released.
    pub const fn released_frames(&self) -> u64 {
        self.released_frames
    }

    /// Cumulative bytes the peer has released.
    pub const fn released_bytes(&self) -> u64 {
        self.released_bytes
    }

    /// Whether a record of `wire_bytes` fits the window right now.
    pub const fn may_send(&self, wire_bytes: u32) -> bool {
        self.in_flight_frames() < self.window_frames as u64
            && self.in_flight_bytes() + wire_bytes as u64 <= self.window_bytes as u64
    }

    /// Charges one record against the window.
    ///
    /// [`CounterError::CreditExhausted`] is backpressure: the caller waits for
    /// a CREDIT frame. [`CounterError::CreditWindowTooSmall`] is not — no
    /// release will ever admit this frame.
    pub fn on_send(&mut self, wire_bytes: u32) -> Result<(), CounterError> {
        if wire_bytes as u64 > self.window_bytes as u64 || self.window_frames == 0 {
            return Err(CounterError::CreditWindowTooSmall);
        }
        if !self.may_send(wire_bytes) {
            return Err(CounterError::CreditExhausted);
        }
        self.sent_frames += 1;
        self.sent_bytes += wire_bytes as u64;
        Ok(())
    }

    /// Applies a CREDIT frame's cumulative counters.
    pub fn on_release(&mut self, frames: u64, bytes: u64) -> Result<(), CounterError> {
        if frames < self.released_frames || bytes < self.released_bytes {
            return Err(CounterError::CreditRegression);
        }
        if frames > self.sent_frames || bytes > self.sent_bytes {
            return Err(CounterError::CreditOverrun);
        }
        self.released_frames = frames;
        self.released_bytes = bytes;
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn seq_starts_at_one_and_steps_by_one() {
        let mut seq = Seq::new();
        assert_eq!(seq.last(), 0);
        assert_eq!(seq.advance(), Ok(1));
        assert_eq!(seq.advance(), Ok(2));
        assert_eq!(seq.advance(), Ok(3));
        assert_eq!(seq.last(), 3);
    }

    #[test]
    fn seq_never_wraps() {
        let mut seq = Seq::new();
        for _ in 0..3 {
            seq.advance().unwrap();
        }
        // Walk the counter to the top without looping four billion times.
        let mut at_top = Seq { last: u32::MAX - 1 };
        assert_eq!(at_top.advance(), Ok(u32::MAX));
        assert_eq!(at_top.advance(), Err(CounterError::SeqExhausted));
        assert_eq!(at_top.last(), u32::MAX);
    }

    #[test]
    fn receiver_refuses_zero_gaps_and_repeats() {
        let mut seq = Seq::new();
        assert_eq!(seq.accept(0), Err(CounterError::SeqStart));
        assert_eq!(seq.accept(2), Err(CounterError::SeqStart), "a stream must open at 1");
        assert_eq!(seq.accept(1), Ok(()));
        assert_eq!(seq.accept(3), Err(CounterError::SeqGap));
        assert_eq!(seq.accept(1), Err(CounterError::SeqReplay));
        assert_eq!(seq.accept(2), Ok(()));
        assert_eq!(seq.last(), 2);
    }

    #[test]
    fn credit_admits_up_to_the_window_then_blocks() {
        let mut credit = Credit::new(2, 1000);
        assert!(credit.may_send(400));
        credit.on_send(400).unwrap();
        credit.on_send(400).unwrap();
        assert_eq!(credit.in_flight_frames(), 2);
        assert_eq!(credit.in_flight_bytes(), 800);
        // The frame window is spent even though bytes remain.
        assert!(!credit.may_send(100));
        assert_eq!(credit.on_send(100), Err(CounterError::CreditExhausted));

        credit.on_release(1, 400).unwrap();
        assert_eq!(credit.in_flight_frames(), 1);
        assert!(credit.may_send(400));
        // The byte window is now the binding one.
        assert!(!credit.may_send(601));
    }

    #[test]
    fn credit_separates_backpressure_from_an_unusable_window() {
        let mut credit = Credit::new(8, 4096);
        assert_eq!(credit.on_send(4097), Err(CounterError::CreditWindowTooSmall));
        assert_eq!(credit.on_send(4096), Ok(()), "a frame the size of the window still fits");
        assert_eq!(credit.on_send(1), Err(CounterError::CreditExhausted));
        assert_eq!(Credit::new(0, 4096).on_send(1), Err(CounterError::CreditWindowTooSmall));
    }

    #[test]
    fn credit_counters_are_cumulative_and_monotone() {
        let mut credit = Credit::new(8, 32768);
        for _ in 0..4 {
            credit.on_send(100).unwrap();
        }
        credit.on_release(2, 200).unwrap();
        assert_eq!((credit.released_frames(), credit.released_bytes()), (2, 200));
        // A repeat of the same cumulative value is not a regression.
        assert_eq!(credit.on_release(2, 200), Ok(()));
        assert_eq!(credit.on_release(1, 200), Err(CounterError::CreditRegression));
        assert_eq!(credit.on_release(2, 100), Err(CounterError::CreditRegression));
        assert_eq!(credit.on_release(5, 200), Err(CounterError::CreditOverrun));
        assert_eq!(credit.on_release(4, 500), Err(CounterError::CreditOverrun));
        assert_eq!(credit.on_release(4, 400), Ok(()));
        assert_eq!(credit.in_flight_frames(), 0);
        assert_eq!(credit.in_flight_bytes(), 0);
    }

    #[test]
    fn credit_survives_a_long_run_without_drift() {
        // Cumulative counters are u64; a release always trails a send by the
        // window, and in-flight is the difference, never a running subtraction.
        let mut credit = Credit::new(4, 40000);
        let mut released = 0u64;
        let mut bytes = 0u64;
        for i in 1..=10_000u64 {
            credit.on_send(1000).unwrap();
            if i >= 4 {
                released = i - 3;
                bytes = released * 1000;
                credit.on_release(released, bytes).unwrap();
            }
        }
        assert_eq!(credit.released_frames(), released);
        assert_eq!(credit.released_bytes(), bytes);
        assert_eq!(credit.in_flight_frames(), 3);
        assert_eq!(credit.in_flight_bytes(), 3000);
    }
}
