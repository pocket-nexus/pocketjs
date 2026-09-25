//! Negotiated receiver guarantees (R5 draft §3.2, R5-P02).
//!
//! A peer advertises in HELLO only limits it can itself honour; the pair in
//! force is the per-field minimum of the two advertisements. This module holds
//! the arithmetic. The metadata that carries these numbers is parsed one layer
//! up — nothing here reads JSON.

use crate::frame::FrameOptions;
use crate::spec;

/// Per-direction receiver guarantees, mirroring `RelayRxLimits` in
/// `contracts/spec/relay.ts` field for field.
///
/// [`RxLimits::UNBOUNDED_FIELD`] marks a field on which this side imposes no
/// ceiling. It is the identity of [`RxLimits::negotiate`]'s per-field minimum,
/// so an unbounded field takes the peer's value verbatim.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct RxLimits {
    /// Largest record, length prefix included.
    pub max_wire_bytes: u32,
    /// Largest metadata region.
    pub max_meta_bytes: u32,
    /// Frames that may be in flight before a CREDIT release.
    pub window_frames: u32,
    /// Bytes that may be in flight before a CREDIT release.
    pub window_bytes: u32,
    /// Admitted in-flight requests.
    pub max_pending: u32,
    /// Largest single resource object after reassembly.
    pub max_object_bytes: u32,
    /// Chunked assemblies open at once.
    pub max_assemblies: u32,
    /// Scratch bytes the receiver will hold for decode.
    pub max_scratch_bytes: u32,
}

impl RxLimits {
    /// "No ceiling from this side." Chosen as `u32::MAX` because
    /// [`RxLimits::negotiate`] takes a minimum.
    pub const UNBOUNDED_FIELD: u32 = u32::MAX;

    /// The control attachment: every frame fits 4096 bytes including the
    /// header, eight frames or 32 KiB in flight, eight pending requests.
    ///
    /// R5's limit table defines no control-specific `maxMetaBytes`,
    /// `maxObjectBytes`, `maxAssemblies` or `maxScratchBytes` (draft erratum);
    /// the metadata ceiling falls back to the decoder default and the other
    /// three are [`RxLimits::UNBOUNDED_FIELD`].
    pub const CONTROL: Self = Self {
        max_wire_bytes: spec::limits::CONTROL_MAX_WIRE_BYTES,
        max_meta_bytes: spec::limits::DEFAULT_MAX_META_BYTES,
        window_frames: spec::limits::CONTROL_WINDOW_FRAMES,
        window_bytes: spec::limits::CONTROL_WINDOW_BYTES,
        max_pending: spec::limits::MAX_PENDING,
        max_object_bytes: Self::UNBOUNDED_FIELD,
        max_assemblies: Self::UNBOUNDED_FIELD,
        max_scratch_bytes: Self::UNBOUNDED_FIELD,
    };

    /// The bulk attachment: 64 KiB frames, two frames or 128 KiB in flight,
    /// two open assemblies. R5 defines no bulk `maxObjectBytes` or
    /// `maxScratchBytes`; both are [`RxLimits::UNBOUNDED_FIELD`].
    pub const BULK: Self = Self {
        max_wire_bytes: spec::limits::BULK_MAX_WIRE_BYTES,
        max_meta_bytes: spec::limits::BULK_MAX_META_BYTES,
        window_frames: spec::limits::BULK_WINDOW_FRAMES,
        window_bytes: spec::limits::BULK_WINDOW_BYTES,
        max_pending: spec::limits::MAX_PENDING,
        max_object_bytes: Self::UNBOUNDED_FIELD,
        max_assemblies: spec::limits::BULK_MAX_ASSEMBLIES,
        max_scratch_bytes: Self::UNBOUNDED_FIELD,
    };

    /// The bootstrap HELLO exchange, before any attachment exists.
    pub const BOOTSTRAP: Self = Self {
        max_wire_bytes: spec::limits::BOOTSTRAP_MAX_WIRE_BYTES,
        ..Self::CONTROL
    };

    /// The pair in force between two advertisements: the minimum of each
    /// field. R5-P02.
    pub const fn negotiate(self, peer: Self) -> Self {
        const fn min(a: u32, b: u32) -> u32 {
            if a < b {
                a
            } else {
                b
            }
        }
        Self {
            max_wire_bytes: min(self.max_wire_bytes, peer.max_wire_bytes),
            max_meta_bytes: min(self.max_meta_bytes, peer.max_meta_bytes),
            window_frames: min(self.window_frames, peer.window_frames),
            window_bytes: min(self.window_bytes, peer.window_bytes),
            max_pending: min(self.max_pending, peer.max_pending),
            max_object_bytes: min(self.max_object_bytes, peer.max_object_bytes),
            max_assemblies: min(self.max_assemblies, peer.max_assemblies),
            max_scratch_bytes: min(self.max_scratch_bytes, peer.max_scratch_bytes),
        }
    }

    /// The two fields the frame layer enforces, as decoder options with the
    /// v1 codec set and no session pin.
    pub const fn frame_options(self) -> FrameOptions {
        FrameOptions::unbounded().with_limits(self.max_wire_bytes, self.max_meta_bytes)
    }

    /// Whether a record of `wire_bytes` fits this receiver's guarantee.
    pub const fn admits_wire(self, wire_bytes: u64) -> bool {
        wire_bytes <= self.max_wire_bytes as u64
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn negotiation_takes_the_minimum_of_each_field() {
        let mine = RxLimits { max_wire_bytes: 4096, max_meta_bytes: 2048, ..RxLimits::BULK };
        let peer = RxLimits { max_wire_bytes: 65536, max_meta_bytes: 512, ..RxLimits::CONTROL };
        let agreed = mine.negotiate(peer);
        assert_eq!(agreed.max_wire_bytes, 4096);
        assert_eq!(agreed.max_meta_bytes, 512);
        assert_eq!(agreed.window_frames, RxLimits::BULK.window_frames.min(peer.window_frames));
        // Order does not matter.
        assert_eq!(agreed, peer.negotiate(mine));
    }

    #[test]
    fn an_unbounded_field_takes_the_peers_value() {
        let mine = RxLimits { max_object_bytes: RxLimits::UNBOUNDED_FIELD, ..RxLimits::CONTROL };
        let peer = RxLimits { max_object_bytes: 131_072, ..RxLimits::CONTROL };
        assert_eq!(mine.negotiate(peer).max_object_bytes, 131_072);
        // Negotiating with oneself changes nothing.
        assert_eq!(RxLimits::CONTROL.negotiate(RxLimits::CONTROL), RxLimits::CONTROL);
    }

    #[test]
    fn frame_options_carry_the_two_limits_the_frame_layer_enforces() {
        let opts = RxLimits::CONTROL.frame_options();
        assert_eq!(opts.max_wire_bytes, Some(RxLimits::CONTROL.max_wire_bytes));
        assert_eq!(opts.max_meta_bytes, Some(RxLimits::CONTROL.max_meta_bytes));
        assert_eq!(opts.session, None, "the bootstrap exchange is unpinned");
    }

    #[test]
    fn admits_wire_is_inclusive_at_the_ceiling() {
        let l = RxLimits::CONTROL;
        assert!(l.admits_wire(l.max_wire_bytes as u64));
        assert!(!l.admits_wire(l.max_wire_bytes as u64 + 1));
        assert!(l.admits_wire(0));
    }
}
