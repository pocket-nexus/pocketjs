//! media.playback (contracts/spec/media.ts) over the USB carrier's media ring
//! (contracts/spec/link.ts "Media"): the stream a 3DS reads from a socket
//! (platforms/3ds/media.c), read here from `host0:/pocket-link/media.ring`.
//!
//! The guest's thread copies commands in, reads snapshots and commits
//! pictures. A worker thread does every host0 read and write of the stream,
//! applies PAL8 packets to the reference picture, copies each picture into
//! the frame ring and decodes IMA ADPCM into the audio output's ring
//! (pocket_psp_audio::output). The output's played position is the clock:
//! present() commits the latest picture whose time has come, as the 3DS's
//! media_present does. The worker reads no further than LEAD_MS of audio
//! ahead of that clock, and acknowledges what it read in media.ack, which
//! is what lets the companion write more.
//!
//! This console takes PAL8 only (`h264` is false in the status, so the app
//! asks for it); a stream of another codec fails as unsupported.
//!
//! The global allocator is single-threaded, so every buffer is allocated and
//! freed on the guest's thread: the packet and PCM buffers at the first
//! open, and the reference picture and frame ring when a stream's first
//! picture names its size. The worker posts that size in NEED and waits;
//! present() allocates and answers in HAVE.

use alloc::{format, string::String, vec::Vec};
use core::cell::UnsafeCell;
use core::ffi::c_void;
use core::sync::atomic::{
    AtomicBool, AtomicU32, AtomicUsize,
    Ordering::{AcqRel, Acquire, Relaxed, Release},
};

use pocketjs_core::spec::{img, psm};
use pocketjs_core::Ui;
use psp::sys::{self, IoOpenFlags, IoWhence, SceUid};

use crate::media_wire as wire;
use crate::{audio, ge, link};

// contracts/spec/link.ts "Media".
const RING_MAGIC: u32 = 0x4d4c_4b50;
const ACK_MAGIC: u32 = 0x414c_4b50;
const HEAD_BYTES: u32 = 64;
const CLOSED: u32 = 1;

/// Pictures decoded ahead of the clock: LEAD_MS at 12 frames a second, and
/// room for a frame a second more.
const FRAME_SLOTS: usize = 8;
/// Audio the worker keeps queued ahead of the clock.
const LEAD_MS: usize = 400;
/// Audio buffered before playback starts, and again after an underrun.
const START_MS: u32 = 300;
/// A silent stream (no audio channel) reads no further ahead than this.
const SILENT_LEAD_MS: u32 = 750;
/// No new stream byte for this long is a lost connection.
const STALL_US: u32 = 10_000_000;
/// Before the first picture or sound: a CardputerZero's ffmpeg took 14 to 18 s
/// from its start to the first frame (two HTTPS inputs through a proxy).
const OPEN_STALL_US: u32 = 40_000_000;
/// media.ack goes out after this many bytes, or when the reader waits.
const ACK_BYTES: u32 = 16 * 1024;
/// Stream bytes read out of the ring per pread: every byte the companion has
/// written, up to this, so a packet header and its payload cost one round
/// trip over usbhostfs, not two.
const AHEAD_BYTES: usize = 64 * 1024;
/// The wait between head reads while the ring holds nothing new.
const WAIT_US: u32 = 5_000;

const IDLE: u32 = 0;
const OPENING: u32 = 1;
const BUFFERING: u32 = 2;
const PLAYING: u32 = 3;
const ENDED: u32 = 4;
const FAILED: u32 = 5;

const ERR_NONE: u32 = 0;
const ERR_MEMORY: u32 = 1;
const ERR_CONNECTION: u32 = 2;
const ERR_HEADER: u32 = 3;
const ERR_PACKET: u32 = 4;
const ERR_REMOTE: u32 = 5;
const ERRORS: [&str; 6] = [
    "",
    "Media allocation failed",
    "Media connection lost",
    "Unsupported media stream",
    "Invalid media packet",
    "Companion media failed",
];

// Guest -> worker.
/// The stream the guest wants; every open and close counts it up.
static REQUESTED: AtomicU32 = AtomicU32::new(0);
static OPEN: AtomicBool = AtomicBool::new(false);
static PAUSED: AtomicBool = AtomicBool::new(false);
/// The token of stream REQUESTED, written before REQUESTED counts up.
struct Token(UnsafeCell<[u8; 64]>);
unsafe impl Sync for Token {}
static TOKEN: Token = Token(UnsafeCell::new([0; 64]));
/// The audio channel started for the open stream.
static AUDIO_OUT: AtomicBool = AtomicBool::new(false);

// Worker -> guest.
static STATUS_GENERATION: AtomicU32 = AtomicU32::new(0);
static PHASE: AtomicU32 = AtomicU32::new(IDLE);
static FAILURE: AtomicU32 = AtomicU32::new(ERR_NONE);
static ORIGIN_MS: AtomicU32 = AtomicU32::new(0);
static BUFFERED_UNTIL: AtomicU32 = AtomicU32::new(0);
static RECEIVED: AtomicU32 = AtomicU32::new(0);
static DECODED: AtomicU32 = AtomicU32::new(0);
static PRESENTED: AtomicU32 = AtomicU32::new(0);
static DROPPED: AtomicU32 = AtomicU32::new(0);
static DECODE_MAX: AtomicU32 = AtomicU32::new(0);
static UNDERRUNS: AtomicU32 = AtomicU32::new(0);
/// What an invalid packet was, for the status's error: the check it failed
/// (BAD_*), its kind, size and time, and where its header sat in the stream.
static BAD_CHECK: AtomicU32 = AtomicU32::new(0);
static BAD_KIND: AtomicU32 = AtomicU32::new(0);
static BAD_SIZE: AtomicU32 = AtomicU32::new(0);
static BAD_PTS: AtomicU32 = AtomicU32::new(0);
static BAD_AT: AtomicU32 = AtomicU32::new(0);
const BAD_CHECKS: [&str; 5] = ["", "header", "order", "picture", "sound"];
/// The clock: stream time AUDIO_PTS sits at played frame AUDIO_BASE; no
/// audio yet while AUDIO_KNOWN is false.
static AUDIO_KNOWN: AtomicBool = AtomicBool::new(false);
static AUDIO_PTS: AtomicU32 = AtomicU32::new(0);
static AUDIO_BASE: AtomicUsize = AtomicUsize::new(0);
/// The silent clock (no audio channel): stream time SILENT_PTS at system
/// time SILENT_AT, frozen while SILENT_AT is 0.
static SILENT_PTS: AtomicU32 = AtomicU32::new(0);
static SILENT_AT: AtomicU32 = AtomicU32::new(0);
/// The ended stream's last position.
static END_MS: AtomicU32 = AtomicU32::new(0);
/// The worker is inside a stream and may touch the picture buffers.
static BUSY: AtomicBool = AtomicBool::new(false);
/// The guest's volume (f32 bits), 1.0 until it sets one.
static VOLUME: AtomicU32 = AtomicU32::new(0x3f80_0000);

// The picture buffers: NEED is the size (w * h) the worker asks for, HAVE the
// size present() allocated. The pointers change only while the worker waits.
static NEED: AtomicU32 = AtomicU32::new(0);
static HAVE: AtomicU32 = AtomicU32::new(0);
struct Pictures {
    reference: *mut u8,
    slots: *mut u8,
}
struct Shared<T>(UnsafeCell<T>);
unsafe impl<T> Sync for Shared<T> {}
static PICTURES: Shared<Pictures> = Shared(UnsafeCell::new(Pictures {
    reference: core::ptr::null_mut(),
    slots: core::ptr::null_mut(),
}));

/// One decoded picture: its CLUT, size, time and stream.
#[derive(Clone, Copy)]
struct Frame {
    clut: [u8; 1024],
    width: usize,
    height: usize,
    pts: u32,
    generation: u32,
}
static FRAMES: Shared<[Frame; FRAME_SLOTS]> = Shared(UnsafeCell::new(
    [Frame {
        clut: [0; 1024],
        width: 0,
        height: 0,
        pts: 0,
        generation: 0,
    }; FRAME_SLOTS],
));
static FRAME_READ: AtomicU32 = AtomicU32::new(0);
static FRAME_WRITE: AtomicU32 = AtomicU32::new(0);

// Fixed worker buffers, allocated once on the guest's thread.
static PACKET: Shared<*mut u8> = Shared(UnsafeCell::new(core::ptr::null_mut()));
static AHEAD: Shared<*mut u8> = Shared(UnsafeCell::new(core::ptr::null_mut()));
static PCM: Shared<*mut i16> = Shared(UnsafeCell::new(core::ptr::null_mut()));

// Guest-thread state.
static mut STARTED: bool = false;
static mut OWNED: Option<(Vec<u8>, Vec<i16>, Vec<u8>)> = None;
static mut OWNED_PICTURES: Option<(Vec<u8>, Vec<u8>)> = None;
static mut TEXTURE: i32 = -1;
static mut STAGING: Vec<u8> = Vec::new();

fn now() -> u32 {
    unsafe { sys::sceKernelGetSystemTimeLow() }
}

fn frames_ms(frames: usize) -> u32 {
    (frames as u64 * 1000 / wire::SAMPLE_RATE as u64) as u32
}

fn note_decode(started: u32) {
    let us = now().wrapping_sub(started);
    if us > DECODE_MAX.load(Relaxed) {
        DECODE_MAX.store(us, Relaxed);
    }
}

/// The stream time now, from the audio output (or the silent clock).
fn position() -> u32 {
    if PHASE.load(Acquire) == ENDED {
        return END_MS.load(Relaxed);
    }
    if AUDIO_OUT.load(Acquire) {
        if !AUDIO_KNOWN.load(Acquire) {
            return ORIGIN_MS.load(Relaxed);
        }
        let played = audio::played().wrapping_sub(AUDIO_BASE.load(Relaxed));
        return AUDIO_PTS.load(Relaxed).wrapping_add(frames_ms(played));
    }
    let at = SILENT_AT.load(Acquire);
    let pts = SILENT_PTS.load(Relaxed);
    if at == 0 {
        pts
    } else {
        pts.wrapping_add(now().wrapping_sub(at) / 1000)
    }
}

// ---- the worker ------------------------------------------------------------------

struct Stream {
    generation: u32,
    ring: SceUid,
    ack: SceUid,
    ring_bytes: u32,
    /// Stream bytes handed to the decoder.
    pos: u32,
    /// Where the packet being read starts in the stream.
    packet_at: u32,
    /// Stream bytes read out of the ring (pos plus the read-ahead buffer);
    /// what media.ack reports, since the ring may then be overwritten.
    fetched: u32,
    acked: u32,
    /// Bytes in the read-ahead buffer from its start; the last
    /// `fetched - pos` of them are not yet handed out.
    ahead_len: usize,
    written: u32,
    closed: bool,
    answered: bool,
    progress_at: u32,
    /// Playback holds until START_MS is buffered (again after an underrun).
    started: bool,
    buffer_origin: u32,
    draining: bool,
}

fn current(generation: u32) -> bool {
    OPEN.load(Acquire) && REQUESTED.load(Acquire) == generation
}

/// Fail the stream on an invalid packet, recording what it was.
fn bad_packet(generation: u32, check: u32, kind: u32, size: u32, pts: u32, at: u32) {
    for (slot, value) in [(&BAD_CHECK, check), (&BAD_KIND, kind), (&BAD_SIZE, size), (&BAD_PTS, pts), (&BAD_AT, at)] {
        slot.store(value, Relaxed);
    }
    fail(generation, ERR_PACKET);
}

fn fail(generation: u32, error: u32) {
    if current(generation) {
        FAILURE.store(error, Relaxed);
        PHASE.store(FAILED, Release);
    }
}

/// Seek and read `into` whole (link::read_all's 32 KiB reads).
unsafe fn pread(fd: SceUid, offset: u32, into: &mut [u8]) -> bool {
    sys::sceIoLseek(fd, offset as i64, IoWhence::Set) == offset as i64 && link::read_all(fd, into.as_mut_ptr(), into.len())
}

impl Stream {
    /// Read the ring's head; false when it is torn or another stream's.
    unsafe fn head(&mut self) -> bool {
        let mut head = [0u8; 28];
        if !pread(self.ring, 0, &mut head) {
            return false;
        }
        if wire::u32_at(&head, 0) != RING_MAGIC || wire::u32_at(&head, 24) != link::fnv1a32(&head[..24]) {
            return false;
        }
        if wire::u32_at(&head, 4) != link::epoch() || wire::u32_at(&head, 8) != self.generation {
            return false;
        }
        let ring = wire::u32_at(&head, 20);
        if ring == 0 || ring > 16 * 1024 * 1024 {
            return false;
        }
        self.answered = true;
        self.ring_bytes = ring;
        self.written = wire::u32_at(&head, 12);
        self.closed = wire::u32_at(&head, 16) & CLOSED != 0;
        true
    }

    unsafe fn acknowledge(&mut self) {
        if self.acked == self.fetched {
            return;
        }
        let mut block = [0u8; 16];
        block[0..4].copy_from_slice(&ACK_MAGIC.to_le_bytes());
        block[4..8].copy_from_slice(&self.generation.to_le_bytes());
        block[8..12].copy_from_slice(&self.fetched.to_le_bytes());
        let hash = link::fnv1a32(&block[..12]);
        block[12..16].copy_from_slice(&hash.to_le_bytes());
        if sys::sceIoLseek(self.ack, 0, IoWhence::Set) == 0
            && sys::sceIoWrite(self.ack, block.as_ptr() as *const c_void, 16) == 16
        {
            self.acked = self.fetched;
        }
    }

    /// Keep the audio output's hold in step with the guest's pause and the
    /// start-up buffer, and count an underrun.
    fn tick(&mut self) {
        let paused = PAUSED.load(Acquire);
        if AUDIO_OUT.load(Acquire) {
            let queued = audio::queued();
            if self.started && !paused && !self.draining && queued == 0 && AUDIO_KNOWN.load(Acquire) {
                UNDERRUNS.fetch_add(1, Relaxed);
                self.started = false;
                self.buffer_origin = BUFFERED_UNTIL.load(Relaxed);
                PHASE.store(BUFFERING, Release);
            }
            audio::set_paused(paused || !self.started);
        } else if self.started {
            let at = SILENT_AT.load(Acquire);
            if paused && at != 0 {
                SILENT_PTS.store(position(), Relaxed);
                SILENT_AT.store(0, Release);
            } else if !paused && at == 0 {
                SILENT_AT.store(now().max(1), Release);
            }
        }
    }

    /// Copy `into.len()` ring bytes from stream position `from` (fetched by
    /// the caller's wait), in at most two preads across the ring's end.
    unsafe fn pull(&mut self, from: u32, into: &mut [u8]) -> bool {
        let at = from % self.ring_bytes;
        let first = (into.len() as u32).min(self.ring_bytes - at) as usize;
        pread(self.ring, HEAD_BYTES + at, &mut into[..first])
            && (first == into.len() || pread(self.ring, HEAD_BYTES, &mut into[first..]))
    }

    /// Wait until the ring holds a byte past `fetched`. False when the stream
    /// ends under the reader, stalls for STALL_US, or is no longer the guest's.
    unsafe fn wait(&mut self) -> bool {
        loop {
            // A stream the guest left touches the output no more: the next
            // stream's open() has restarted it.
            if !current(self.generation) {
                return false;
            }
            self.tick();
            if PAUSED.load(Acquire) {
                self.acknowledge();
                self.progress_at = now();
                sys::sceKernelDelayThread(WAIT_US);
                continue;
            }
            if self.answered && self.written != self.fetched {
                return true;
            }
            if self.head() && self.written != self.fetched {
                return true;
            }
            if self.answered && self.closed {
                return false;
            }
            let opening = DECODED.load(Relaxed) == 0 && !AUDIO_KNOWN.load(Acquire);
            if now().wrapping_sub(self.progress_at) > if opening { OPEN_STALL_US } else { STALL_US } {
                return false;
            }
            self.acknowledge();
            sys::sceKernelDelayThread(WAIT_US);
        }
    }

    /// The next `into.len()` stream bytes, from the read-ahead buffer and the
    /// ring. False when the stream ends under the reader, stalls for
    /// STALL_US, or is no longer the guest's.
    unsafe fn read(&mut self, into: &mut [u8]) -> bool {
        let ahead = core::slice::from_raw_parts_mut(*AHEAD.0.get(), AHEAD_BYTES);
        let mut done = 0;
        while done < into.len() {
            // The buffer's last `fetched - pos` bytes are not handed out yet.
            let buffered = self.fetched.wrapping_sub(self.pos) as usize;
            if buffered > 0 {
                let from = self.ahead_len - buffered;
                let k = buffered.min(into.len() - done);
                into[done..done + k].copy_from_slice(&ahead[from..from + k]);
                self.pos = self.pos.wrapping_add(k as u32);
                done += k;
                continue;
            }
            if !self.wait() {
                return false;
            }
            let available = self.written.wrapping_sub(self.fetched) as usize;
            let want = into.len() - done;
            let k = if want >= AHEAD_BYTES {
                // A large packet goes straight into its own buffer.
                let k = available.min(want);
                if !self.pull(self.fetched, &mut into[done..done + k]) {
                    return false;
                }
                self.pos = self.pos.wrapping_add(k as u32);
                self.ahead_len = 0;
                done += k;
                k
            } else {
                let k = available.min(AHEAD_BYTES);
                if !self.pull(self.fetched, &mut ahead[..k]) {
                    return false;
                }
                self.ahead_len = k;
                k
            };
            self.fetched = self.fetched.wrapping_add(k as u32);
            self.progress_at = now();
            RECEIVED.fetch_add(k as u32, Relaxed);
            if self.fetched.wrapping_sub(self.acked) >= ACK_BYTES {
                self.acknowledge();
            }
        }
        true
    }

    /// Wait until `pts` is at most `lead` ms ahead of the clock.
    unsafe fn wait_clock(&mut self, pts: u32, lead: u32) -> bool {
        while current(self.generation) && self.started && pts.wrapping_sub(position()) as i32 > lead as i32 {
            self.tick();
            self.acknowledge();
            sys::sceKernelDelayThread(2_000);
        }
        current(self.generation)
    }

    unsafe fn audio(&mut self, data: &[u8], pts: u32) -> bool {
        let started = now();
        let pcm = core::slice::from_raw_parts_mut(*PCM.0.get(), wire::AUDIO_FRAMES * 2);
        let frames = wire::decode_audio(data, pcm);
        note_decode(started);
        if frames == 0 {
            bad_packet(self.generation, 4, wire::PACKET_AUDIO as u32, data.len() as u32, pts, self.packet_at);
            return false;
        }
        if !AUDIO_OUT.load(Acquire) {
            BUFFERED_UNTIL.store(pts.wrapping_add(frames_ms(frames)), Relaxed);
            return self.silent_start();
        }
        let lead = wire::SAMPLE_RATE as usize * LEAD_MS / 1000;
        loop {
            self.tick();
            if !current(self.generation) {
                return false;
            }
            let queued = audio::queued();
            // Before playback starts the clock stands still: fill the start-up
            // buffer and no more, or nothing would ever play.
            let ahead = if self.started { lead } else { lead.max(wire::SAMPLE_RATE as usize * START_MS as usize / 1000 + frames) };
            if queued + frames <= ahead && audio::free_frames() >= frames {
                break;
            }
            self.acknowledge();
            sys::sceKernelDelayThread(2_000);
        }
        if !AUDIO_KNOWN.load(Acquire) {
            AUDIO_BASE.store(audio::written(), Relaxed);
            AUDIO_PTS.store(pts, Relaxed);
            AUDIO_KNOWN.store(true, Release);
        }
        audio::push(&pcm[..frames * 2], 2);
        let until = pts.wrapping_add(frames_ms(frames));
        BUFFERED_UNTIL.store(until, Relaxed);
        if !self.started && until.wrapping_sub(self.buffer_origin) >= START_MS {
            self.started = true;
            PHASE.store(PLAYING, Release);
            self.tick();
        }
        true
    }

    /// The silent clock starts with the first picture.
    fn silent_start(&mut self) -> bool {
        if !self.started && DECODED.load(Relaxed) > 0 {
            self.started = true;
            SILENT_PTS.store(ORIGIN_MS.load(Relaxed), Relaxed);
            SILENT_AT.store(now().max(1), Release);
            PHASE.store(PLAYING, Release);
        }
        current(self.generation)
    }

    unsafe fn video(&mut self, state: &mut wire::Pal8, data: &[u8], pts: u32) -> bool {
        let Some((w, h)) = wire::pal8_size(data) else {
            bad_packet(self.generation, 3, wire::PACKET_VIDEO as u32, data.len() as u32, pts, self.packet_at);
            return false;
        };
        let need = (w * h) as u32;
        if HAVE.load(Acquire) < need {
            // present() allocates on the guest's thread; wait for it.
            NEED.store(need, Release);
            let asked = now();
            while HAVE.load(Acquire) < need {
                if !current(self.generation) {
                    return false;
                }
                if now().wrapping_sub(asked) > 2_000_000 {
                    fail(self.generation, ERR_MEMORY);
                    return false;
                }
                self.tick();
                sys::sceKernelDelayThread(2_000);
            }
        }
        let pictures = &*PICTURES.0.get();
        // Slots sit HAVE bytes apart: a smaller picture than the last stream's
        // uses the start of each.
        let stride = HAVE.load(Acquire) as usize;
        let reference = core::slice::from_raw_parts_mut(pictures.reference, need as usize);
        let started = now();
        if !wire::pal8_apply(state, reference, data) {
            bad_packet(self.generation, 3, wire::PACKET_VIDEO as u32, data.len() as u32, pts, self.packet_at);
            return false;
        }
        // The reference already holds this picture, so a full ring drops it
        // instead of waiting: the next picture shown is still exact.
        let write = FRAME_WRITE.load(Relaxed);
        if write.wrapping_sub(FRAME_READ.load(Acquire)) as usize >= FRAME_SLOTS {
            DROPPED.fetch_add(1, Relaxed);
            note_decode(started);
            return current(self.generation);
        }
        let index = write as usize % FRAME_SLOTS;
        let slot = core::slice::from_raw_parts_mut(pictures.slots.add(index * stride), need as usize);
        slot.copy_from_slice(reference);
        let frame = &mut (*FRAMES.0.get())[index];
        frame.clut = state.clut;
        frame.width = w;
        frame.height = h;
        frame.pts = pts;
        frame.generation = self.generation;
        note_decode(started);
        DECODED.fetch_add(1, Relaxed);
        FRAME_WRITE.store(write.wrapping_add(1), Release);
        if !AUDIO_OUT.load(Acquire) {
            return self.silent_start();
        }
        true
    }

    /// Play the stream out after its end packet. With audio, the stream
    /// ends when the queued audio has played (the clock stops there, and
    /// present() then shows the last picture); a silent stream ends when its
    /// last picture is shown.
    unsafe fn drain(&mut self) {
        self.draining = true;
        self.started = true;
        while current(self.generation) {
            if AUDIO_OUT.load(Acquire) {
                audio::pad_to_block();
            }
            self.tick();
            let done = if AUDIO_OUT.load(Acquire) {
                audio::queued() == 0
            } else {
                FRAME_WRITE.load(Acquire) == FRAME_READ.load(Acquire)
            };
            if done {
                END_MS.store(position().max(BUFFERED_UNTIL.load(Relaxed)), Relaxed);
                PHASE.store(ENDED, Release);
                return;
            }
            sys::sceKernelDelayThread(4_000);
        }
    }
}

unsafe fn play(generation: u32, token: &[u8; 64]) {
    STATUS_GENERATION.store(generation, Release);
    for counter in [&RECEIVED, &DECODED, &PRESENTED, &DROPPED, &DECODE_MAX, &UNDERRUNS, &BUFFERED_UNTIL] {
        counter.store(0, Relaxed);
    }
    FAILURE.store(ERR_NONE, Relaxed);
    AUDIO_KNOWN.store(false, Release);
    SILENT_AT.store(0, Release);
    PHASE.store(OPENING, Release);
    if !link::media_request(generation, Some(token)) {
        fail(generation, ERR_CONNECTION);
        return;
    }
    let ring = sys::sceIoOpen(link::path(b"media.ring").as_ptr(), IoOpenFlags::RD_ONLY, 0o666);
    let ack = sys::sceIoOpen(link::path(b"media.ack").as_ptr(), IoOpenFlags::WR_ONLY | IoOpenFlags::CREAT, 0o666);
    if ring.0 < 0 || ack.0 < 0 {
        for fd in [ring, ack] {
            if fd.0 >= 0 {
                sys::sceIoClose(fd);
            }
        }
        fail(generation, ERR_CONNECTION);
        return;
    }
    let mut stream = Stream {
        generation,
        ring,
        ack,
        ring_bytes: 1,
        pos: 0,
        packet_at: 0,
        fetched: 0,
        ahead_len: 0,
        acked: u32::MAX,
        written: 0,
        closed: false,
        answered: false,
        progress_at: now(),
        started: false,
        buffer_origin: 0,
        draining: false,
    };
    stream.run();
    sys::sceIoClose(ring);
    sys::sceIoClose(ack);
}

impl Stream {
    unsafe fn run(&mut self) {
        let generation = self.generation;
        let mut header = [0u8; wire::HEADER_BYTES];
        if !self.read(&mut header) {
            fail(generation, ERR_CONNECTION);
            return;
        }
        let Some(header) = wire::header(&header) else {
            fail(generation, ERR_HEADER);
            return;
        };
        if header.codec != wire::CODEC_PAL8 {
            fail(generation, ERR_HEADER);
            return;
        }
        ORIGIN_MS.store(header.origin_ms, Relaxed);
        self.buffer_origin = header.origin_ms;
        PHASE.store(BUFFERING, Release);
        let packet = core::slice::from_raw_parts_mut(*PACKET.0.get(), wire::PACKET_BYTES);
        let mut state = wire::Pal8::new();
        let (mut last_video, mut last_audio) = (header.origin_ms, header.origin_ms);
        loop {
            let mut head = [0u8; wire::PACKET_HEADER_BYTES];
            self.packet_at = self.pos;
            if !self.read(&mut head) {
                fail(generation, ERR_CONNECTION);
                return;
            }
            let Some((kind, size, pts)) = wire::packet(&head) else {
                bad_packet(generation, 1, head[0] as u32, wire::u32_at(&head, 4), wire::u32_at(&head, 8), self.packet_at);
                return;
            };
            let behind = |last: u32| pts < last || pts - last > 1000;
            if (kind == wire::PACKET_VIDEO && behind(last_video)) || (kind == wire::PACKET_AUDIO && behind(last_audio)) {
                bad_packet(generation, 2, kind as u32, size as u32, pts, self.packet_at);
                return;
            }
            if size != 0 && !self.read(&mut packet[..size]) {
                fail(generation, ERR_CONNECTION);
                return;
            }
            let data = &packet[..size];
            let ok = match kind {
                wire::PACKET_VIDEO => {
                    last_video = pts;
                    if !AUDIO_OUT.load(Acquire) && !self.wait_clock(pts, SILENT_LEAD_MS) {
                        return;
                    }
                    self.video(&mut state, data, pts)
                }
                wire::PACKET_AUDIO => {
                    last_audio = pts;
                    if !AUDIO_OUT.load(Acquire) && !self.wait_clock(pts, SILENT_LEAD_MS) {
                        return;
                    }
                    self.audio(data, pts)
                }
                wire::PACKET_END => {
                    self.acknowledge();
                    self.drain();
                    return;
                }
                _ => {
                    fail(generation, ERR_REMOTE);
                    return;
                }
            };
            if !ok {
                return;
            }
        }
    }
}

unsafe extern "C" fn worker(_: usize, _: *mut c_void) -> i32 {
    let mut served = 0u32;
    let mut closed = 0u32;
    loop {
        let generation = REQUESTED.load(Acquire);
        if generation != served && OPEN.load(Acquire) {
            served = generation;
            let mut token = [0u8; 64];
            token.copy_from_slice(&*TOKEN.0.get());
            if REQUESTED.load(Acquire) != generation {
                continue;
            }
            BUSY.store(true, Release);
            play(generation, &token);
            BUSY.store(false, Release);
            continue;
        }
        if generation != closed && !OPEN.load(Acquire) && link::media_request(generation, None) {
            // The guest closed: the companion stops producing.
            closed = generation;
            served = generation;
        }
        sys::sceKernelDelayThread(4_000);
    }
}

// ---- the guest's side ------------------------------------------------------------

/// media.open(host, port, token): the token names the ticket; the address is
/// the companion's TCP endpoint, which this carrier does not use.
///
/// # Safety
/// The guest's thread.
pub unsafe fn open(token: &[u8]) -> bool {
    if token.len() != 64 || !token.iter().all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(b)) {
        return false;
    }
    if !STARTED {
        OWNED = Some((alloc::vec![0u8; wire::PACKET_BYTES], alloc::vec![0i16; wire::AUDIO_FRAMES * 2], alloc::vec![0u8; AHEAD_BYTES]));
        let (packet, pcm, ahead) = OWNED.as_mut().expect("allocated");
        *PACKET.0.get() = packet.as_mut_ptr();
        *PCM.0.get() = pcm.as_mut_ptr();
        *AHEAD.0.get() = ahead.as_mut_ptr();
        let thread = sys::sceKernelCreateThread(
            b"pocket-media\0".as_ptr(),
            worker,
            0x30,
            32 * 1024,
            sys::ThreadAttributes::USER,
            core::ptr::null_mut(),
        );
        if thread.0 < 0 {
            return false;
        }
        sys::sceKernelStartThread(thread, 0, core::ptr::null_mut());
        STARTED = true;
    }
    // The worker leaves the previous stream before the output restarts. A
    // worker still inside a host0: read after the wait keeps the output: this
    // open fails and the guest may try again.
    OPEN.store(false, Release);
    REQUESTED.fetch_add(1, AcqRel);
    if !wait_idle() {
        return false;
    }
    let audio_out = audio::start(wire::SAMPLE_RATE);
    if audio_out {
        audio::set_paused(true);
        audio::set_volume(f32::from_bits(VOLUME.load(Relaxed)));
    }
    AUDIO_OUT.store(audio_out, Release);
    (*TOKEN.0.get()).copy_from_slice(token);
    PAUSED.store(false, Release);
    PHASE.store(OPENING, Release);
    OPEN.store(true, Release);
    REQUESTED.fetch_add(1, AcqRel);
    true
}

/// Wait (bounded, one second) for the worker to leave a stream it may still
/// be reading.
unsafe fn wait_idle() -> bool {
    for _ in 0..500 {
        if !BUSY.load(Acquire) {
            return true;
        }
        sys::sceKernelDelayThread(2_000);
    }
    false
}

/// media.close().
///
/// # Safety
/// The guest's thread.
pub unsafe fn close() {
    if !OPEN.swap(false, AcqRel) {
        return;
    }
    REQUESTED.fetch_add(1, AcqRel);
    PAUSED.store(false, Release);
    wait_idle();
    if AUDIO_OUT.swap(false, AcqRel) {
        audio::stop();
    }
}

pub fn set_paused(value: bool) {
    PAUSED.store(value, Release);
}

/// The guest's volume holds across streams: open() gives it to the output it
/// restarts.
pub fn set_volume(value: f32) {
    VOLUME.store(value.to_bits(), Relaxed);
    audio::set_volume(value);
}

/// media.texture(): the 512x256 T8 plane, made on first use in this guest.
///
/// # Safety
/// The guest's thread.
pub unsafe fn texture(ui: &mut Ui) -> i32 {
    if TEXTURE < 0 {
        // Opaque black (palette entry 0) until the first picture, sampled
        // linearly because the plane is drawn scaled.
        let mut init = alloc::vec![0u8; 1024 + wire::WIDTH * wire::HEIGHT];
        init[3] = 0xff;
        let tex = ui.upload_texture_flags(&init, wire::WIDTH as u32, wire::HEIGHT as u32, psm::PSM_T8, img::FLAG_LINEAR);
        if tex < 0 {
            return -1;
        }
        ge::writeback_texture(ui, tex);
        TEXTURE = tex;
        STAGING = alloc::vec![0u8; wire::WIDTH * wire::HEIGHT];
    }
    TEXTURE
}

/// Before each list is encoded (Runtime::present): answer a picture-buffer
/// request, then commit the latest picture whose time has come. The core
/// keeps the storage a list in flight samples until that list retires.
///
/// # Safety
/// The guest's thread, no core guard held elsewhere.
pub unsafe fn present(ui: &mut Ui) {
    let need = NEED.load(Acquire);
    if need > HAVE.load(Acquire) {
        let mut reference = alloc::vec![0u8; need as usize];
        let mut slots = alloc::vec![0u8; need as usize * FRAME_SLOTS];
        let pictures = &mut *PICTURES.0.get();
        pictures.reference = reference.as_mut_ptr();
        pictures.slots = slots.as_mut_ptr();
        OWNED_PICTURES = Some((reference, slots));
        HAVE.store(need, Release);
    }
    let write = FRAME_WRITE.load(Acquire);
    let mut read = FRAME_READ.load(Relaxed);
    let generation = REQUESTED.load(Acquire);
    let now = position();
    let ended = PHASE.load(Acquire) == ENDED;
    let mut chosen = None;
    while read != write {
        let index = read as usize % FRAME_SLOTS;
        let frame = &(*FRAMES.0.get())[index];
        if frame.generation == generation && !ended && frame.pts.wrapping_sub(now) as i32 > 20 {
            break;
        }
        if frame.generation == generation {
            if chosen.is_some() {
                DROPPED.fetch_add(1, Relaxed);
            }
            chosen = Some(index);
        }
        read = read.wrapping_add(1);
    }
    if let Some(index) = chosen {
        if TEXTURE >= 0 && STAGING.len() == wire::WIDTH * wire::HEIGHT {
            let frame = &(*FRAMES.0.get())[index];
            let size = frame.width * frame.height;
            let picture = core::slice::from_raw_parts((*PICTURES.0.get()).slots.add(index * HAVE.load(Relaxed) as usize), size);
            wire::expand(picture, frame.width, frame.height, &mut STAGING);
            if ui.update_texture_t8(TEXTURE, &frame.clut, &STAGING) {
                ge::writeback_texture(ui, TEXTURE);
                PRESENTED.fetch_add(1, Relaxed);
            }
        }
    }
    FRAME_READ.store(read, Release);
}

/// media.status(): a bounded snapshot (contracts/spec/media.ts MediaStatus).
pub fn status() -> String {
    let names = ["idle", "opening", "buffering", "playing", "ended", "error"];
    let mut phase = PHASE.load(Acquire);
    let mut error = FAILURE.load(Relaxed);
    let (mut now, mut until) = (position(), BUFFERED_UNTIL.load(Relaxed));
    if !OPEN.load(Acquire) {
        phase = IDLE;
        error = ERR_NONE;
    } else if STATUS_GENERATION.load(Acquire) != REQUESTED.load(Acquire) {
        phase = OPENING;
        error = ERR_NONE;
        now = 0;
        until = 0;
    }
    let mut name = names.get(phase as usize).copied().unwrap_or("error");
    if PAUSED.load(Acquire) && (phase == PLAYING || phase == BUFFERING) {
        name = "paused";
    }
    let message = if phase != FAILED {
        String::new()
    } else if error == ERR_PACKET {
        format!(
            "Invalid media packet ({} check, kind {} size {} pts {} at byte {})",
            BAD_CHECKS.get(BAD_CHECK.load(Relaxed) as usize).copied().unwrap_or("?"),
            BAD_KIND.load(Relaxed),
            BAD_SIZE.load(Relaxed),
            BAD_PTS.load(Relaxed),
            BAD_AT.load(Relaxed),
        )
    } else {
        String::from(ERRORS.get(error as usize).copied().unwrap_or("Media failed"))
    };
    format!(
        "{{\"phase\":\"{}\",\"positionMs\":{},\"bufferedMs\":{},\"decodedFrames\":{},\"presentedFrames\":{},\"droppedFrames\":{},\"receivedBytes\":{},\"decodeMaxUs\":{},\"audioUnderruns\":{},\"hardware\":false,\"h264\":false,\"audio\":{},\"error\":\"{}\"}}",
        name,
        now,
        until.saturating_sub(now),
        DECODED.load(Relaxed),
        PRESENTED.load(Relaxed),
        DROPPED.load(Relaxed),
        RECEIVED.load(Relaxed),
        DECODE_MAX.load(Relaxed),
        UNDERRUNS.load(Relaxed),
        AUDIO_OUT.load(Acquire) || !OPEN.load(Acquire),
        message,
    )
}

/// Guest teardown (Runtime's drop): stop the stream and forget the texture,
/// which the guest's core frees. The picture buffers go when the worker is
/// out of the stream; a worker still inside one keeps them.
///
/// # Safety
/// The guest's thread.
pub unsafe fn reset() {
    close();
    TEXTURE = -1;
    STAGING = Vec::new();
    if STARTED && !BUSY.load(Acquire) && NEED.load(Acquire) <= HAVE.load(Acquire) {
        HAVE.store(0, Release);
        NEED.store(0, Release);
        let pictures = &mut *PICTURES.0.get();
        pictures.reference = core::ptr::null_mut();
        pictures.slots = core::ptr::null_mut();
        OWNED_PICTURES = None;
    }
}
