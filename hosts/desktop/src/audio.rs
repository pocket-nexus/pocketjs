//! Desktop implementation of the `globalThis.audio` PCM module.
//!
//! Guest calls run on the runtime worker. A CPAL callback or clocked null sink
//! owns the audio clock and reads fixed-capacity per-stream rings through
//! atomics; it never calls the guest, waits for the guest, or allocates. If no
//! output device can be opened, the null sink keeps credit and terminal events
//! moving.

use std::{
    cell::RefCell,
    collections::VecDeque,
    rc::Rc,
    sync::{
        Arc, OnceLock,
        atomic::{AtomicBool, AtomicI16, AtomicI32, AtomicU32, AtomicUsize, Ordering},
    },
    thread::{self, JoinHandle},
    time::{Duration, Instant},
};

use anyhow::Result;
#[cfg(feature = "audio-output")]
use cpal::{
    SampleFormat, Stream, StreamConfig, SupportedStreamConfigRange,
    traits::{DeviceTrait, HostTrait, StreamTrait},
};
use pocket_mod::{
    Guest,
    qjs::{ArrayBuffer, Function},
};
use pocketjs_core::spec::audio as spec;

const OUTPUT_RATE: u32 = 44_100;
const OUTPUT_CHANNELS: u32 = 2;
const OUTPUT_BLOCK_FRAMES: usize = 1024;
const TICK_RATE: usize = 60;
const TICK_OUTPUT_SAMPLES: usize = OUTPUT_RATE as usize / TICK_RATE * OUTPUT_CHANNELS as usize;
const HANDLE_SLOT_BITS: u32 = 3;
const HANDLE_GENERATION_MASK: u32 = 0x0fff_ffff;
const VOLUME_ONE: i32 = 32_768;

struct StreamSlot {
    /// Stereo source-rate samples. Mono is expanded while the guest writes.
    ring: OnceLock<Box<[AtomicI16]>>,
    live: AtomicBool,
    generation: AtomicU32,
    upsample: AtomicUsize,
    channels: AtomicUsize,
    write_pos: AtomicUsize,
    read_pos: AtomicUsize,
    playing: AtomicBool,
    end_flagged: AtomicBool,
    starved: AtomicBool,
    underrun_edge: AtomicBool,
    ended_edge: AtomicBool,
    volume: AtomicI32,
    /// Invalidates callback interpolation state after create/stop.
    reset_epoch: AtomicU32,
}

impl StreamSlot {
    fn new() -> Self {
        Self {
            ring: OnceLock::new(),
            live: AtomicBool::new(false),
            generation: AtomicU32::new(0),
            upsample: AtomicUsize::new(1),
            channels: AtomicUsize::new(2),
            write_pos: AtomicUsize::new(0),
            read_pos: AtomicUsize::new(0),
            playing: AtomicBool::new(false),
            end_flagged: AtomicBool::new(false),
            starved: AtomicBool::new(false),
            underrun_edge: AtomicBool::new(false),
            ended_edge: AtomicBool::new(false),
            volume: AtomicI32::new(VOLUME_ONE),
            reset_epoch: AtomicU32::new(0),
        }
    }

    fn queued_frames(&self) -> usize {
        self.write_pos
            .load(Ordering::Acquire)
            .wrapping_sub(self.read_pos.load(Ordering::Acquire))
            .min(spec::RING_FRAMES)
    }

    fn ensure_ring(&self) -> &[AtomicI16] {
        self.ring.get_or_init(|| {
            std::iter::repeat_with(|| AtomicI16::new(0))
                .take(spec::RING_FRAMES * OUTPUT_CHANNELS as usize)
                .collect::<Vec<_>>()
                .into_boxed_slice()
        })
    }
}

struct AudioShared {
    slots: [StreamSlot; spec::MAX_STREAMS],
    live_streams: AtomicUsize,
}

impl AudioShared {
    fn new() -> Self {
        Self {
            slots: std::array::from_fn(|_| StreamSlot::new()),
            live_streams: AtomicUsize::new(0),
        }
    }
}

struct AudioClock {
    /// One device or fallback callback owns all stream cursors at a time.
    active: AtomicBool,
    /// A device error permanently hands the clock to the parked null sink.
    fallback: AtomicBool,
    /// The null-sink worker or host tick reports device failure away from the callback.
    report_device_failure: AtomicBool,
    /// Consume from host ticks when no null-sink worker could be created.
    tick_fallback: AtomicBool,
}

impl AudioClock {
    fn new() -> Self {
        Self {
            active: AtomicBool::new(false),
            fallback: AtomicBool::new(false),
            report_device_failure: AtomicBool::new(false),
            tick_fallback: AtomicBool::new(false),
        }
    }
}

struct ClockLease {
    clock: Arc<AudioClock>,
}

impl ClockLease {
    fn acquire(clock: &Arc<AudioClock>) -> Option<Self> {
        clock
            .active
            .compare_exchange(false, true, Ordering::SeqCst, Ordering::SeqCst)
            .ok()
            .map(|_| Self {
                clock: clock.clone(),
            })
    }
}

impl Drop for ClockLease {
    fn drop(&mut self) {
        self.clock.active.store(false, Ordering::SeqCst);
    }
}

#[derive(Clone, Copy, Default)]
struct RenderCursor {
    generation: u32,
    reset_epoch: u32,
    phase: usize,
    source_pos: usize,
    previous: [i32; 2],
    current: [i32; 2],
}

/// Callback-owned resampler/mixer state. `render` is the real-time hot path.
struct Mixer {
    clients: Arc<[Arc<AudioShared>]>,
    clock: Arc<AudioClock>,
    cursors: Vec<[RenderCursor; spec::MAX_STREAMS]>,
}

impl Mixer {
    fn new(clients: Arc<[Arc<AudioShared>]>, clock: Arc<AudioClock>) -> Self {
        let cursors = vec![[RenderCursor::default(); spec::MAX_STREAMS]; clients.len()];
        Self {
            clients,
            clock,
            cursors,
        }
    }

    /// Fill an interleaved stereo s16 buffer at 44.1 kHz. Tests and the null
    /// sink use this entry point.
    fn render(&mut self, output: &mut [i16]) {
        self.render_with(output, OUTPUT_CHANNELS as usize, false, |sample| {
            sample.clamp(i16::MIN as i32, i16::MAX as i32) as i16
        });
    }

    /// Device callback hot path: fixed loops over preallocated state, atomic
    /// ring access, and no locks or heap allocation.
    fn render_with<T>(
        &mut self,
        output: &mut [T],
        channels: usize,
        device_clock: bool,
        encode: impl Fn(i32) -> T,
    ) {
        debug_assert!(channels > 0);
        debug_assert_eq!(output.len() % channels, 0);
        // CPAL serializes its callback. The lease also arbitrates the one-block
        // handoff to the null sink after a device error and pairs with
        // AudioCore::deactivate for synchronous slot reuse.
        let Some(_lease) = ClockLease::acquire(&self.clock) else {
            for sample in output {
                *sample = encode(0);
            }
            return;
        };
        if device_clock && self.clock.fallback.load(Ordering::SeqCst) {
            for sample in output {
                *sample = encode(0);
            }
            return;
        }
        for frame in output.chunks_exact_mut(channels) {
            let mixed = self.mix_frame();
            if channels == 1 {
                frame[0] = encode((mixed[0] + mixed[1]) / 2);
                continue;
            }
            frame[0] = encode(mixed[0]);
            frame[1] = encode(mixed[1]);
            for sample in &mut frame[2..] {
                *sample = encode(0);
            }
        }
    }

    fn mix_frame(&mut self) -> [i32; 2] {
        let mut mixed = [0i32; 2];
        for client_index in 0..self.clients.len() {
            if self.clients[client_index]
                .live_streams
                .load(Ordering::Acquire)
                == 0
            {
                continue;
            }
            for slot_index in 0..spec::MAX_STREAMS {
                if let Some(sample) = self.next_sample(client_index, slot_index) {
                    mixed[0] += sample[0];
                    mixed[1] += sample[1];
                }
            }
        }
        [
            mixed[0].clamp(i16::MIN as i32, i16::MAX as i32),
            mixed[1].clamp(i16::MIN as i32, i16::MAX as i32),
        ]
    }

    fn next_sample(&mut self, client_index: usize, slot_index: usize) -> Option<[i32; 2]> {
        let slot = &self.clients[client_index].slots[slot_index];
        if !slot.live.load(Ordering::SeqCst) {
            return None;
        }
        if !slot.playing.load(Ordering::Acquire) {
            return None;
        }
        let generation = slot.generation.load(Ordering::Acquire);
        let reset_epoch = slot.reset_epoch.load(Ordering::Acquire);
        let cursor = &mut self.cursors[client_index][slot_index];
        if cursor.generation != generation || cursor.reset_epoch != reset_epoch {
            *cursor = RenderCursor {
                generation,
                reset_epoch,
                ..RenderCursor::default()
            };
        }
        let factor = slot.upsample.load(Ordering::Relaxed);
        if cursor.phase == 0 {
            let read = slot.read_pos.load(Ordering::Relaxed);
            let write = slot.write_pos.load(Ordering::Acquire);
            if write.wrapping_sub(read) == 0 {
                if slot.end_flagged.swap(false, Ordering::AcqRel) {
                    slot.playing.store(false, Ordering::Release);
                    slot.starved.store(false, Ordering::Relaxed);
                    slot.ended_edge.store(true, Ordering::Release);
                } else if !slot.starved.swap(true, Ordering::AcqRel) {
                    slot.underrun_edge.store(true, Ordering::Release);
                }
                return None;
            }
            let offset = (read % spec::RING_FRAMES) * OUTPUT_CHANNELS as usize;
            let ring = slot
                .ring
                .get()
                .expect("a live stream publishes its ring before the callback");
            cursor.source_pos = read;
            cursor.current = [
                ring[offset].load(Ordering::Relaxed) as i32,
                ring[offset + 1].load(Ordering::Relaxed) as i32,
            ];
        }

        let step = cursor.phase + 1;
        let volume = slot.volume.load(Ordering::Relaxed);
        let mut sample = [0i32; 2];
        for (channel, value) in sample.iter_mut().enumerate() {
            let interpolated = (cursor.previous[channel] * (factor - step) as i32
                + cursor.current[channel] * step as i32)
                / factor as i32;
            *value = interpolated * volume / VOLUME_ONE;
        }
        cursor.phase = step;

        if cursor.phase == factor {
            // stop() can move read_pos while this callback owns a sample. A
            // failed CAS discards the callback's stale cursor without moving
            // the newly flushed stream.
            if slot
                .read_pos
                .compare_exchange(
                    cursor.source_pos,
                    cursor.source_pos.wrapping_add(1),
                    Ordering::Release,
                    Ordering::Relaxed,
                )
                .is_ok()
            {
                cursor.previous = cursor.current;
                cursor.phase = 0;
                slot.starved.store(false, Ordering::Relaxed);
                let now = cursor.source_pos.wrapping_add(1);
                if now == slot.write_pos.load(Ordering::Acquire)
                    && slot.end_flagged.swap(false, Ordering::AcqRel)
                {
                    slot.playing.store(false, Ordering::Release);
                    slot.starved.store(false, Ordering::Relaxed);
                    slot.ended_edge.store(true, Ordering::Release);
                }
            } else {
                cursor.phase = 0;
                cursor.previous = [0; 2];
            }
        }
        // A destroyed/reused slot may race a callback that began on the old
        // generation. Its cursor cannot advance the new ring because create
        // flushes read_pos and changes generation, and stale audio is dropped.
        if slot.live.load(Ordering::Acquire)
            && slot.generation.load(Ordering::Acquire) == generation
        {
            Some(sample)
        } else {
            None
        }
    }
}

#[derive(Clone, Copy)]
enum AudioEvent {
    Credit { handle: i32, free: usize },
    Underrun { handle: i32 },
    Ended { handle: i32 },
}

impl AudioEvent {
    fn handle(self) -> i32 {
        match self {
            Self::Credit { handle, .. } | Self::Underrun { handle } | Self::Ended { handle } => {
                handle
            }
        }
    }

    fn json(self) -> String {
        match self {
            Self::Credit { handle, free } => {
                format!(r#"{{"t":"credit","h":{handle},"free":{free}}}"#)
            }
            Self::Underrun { handle } => format!(r#"{{"t":"underrun","h":{handle}}}"#),
            Self::Ended { handle } => format!(r#"{{"t":"ended","h":{handle}}}"#),
        }
    }
}

struct AudioCore {
    shared: Arc<AudioShared>,
    clock: Arc<AudioClock>,
    last_free: [usize; spec::MAX_STREAMS],
    events: VecDeque<AudioEvent>,
}

impl AudioCore {
    fn new(shared: Arc<AudioShared>, clock: Arc<AudioClock>) -> Self {
        Self {
            shared,
            clock,
            last_free: [spec::RING_FRAMES; spec::MAX_STREAMS],
            events: VecDeque::new(),
        }
    }

    fn create_stream(&mut self, sample_rate: u32, channels: u32) -> i32 {
        let factor = match sample_rate {
            44_100 => 1,
            22_050 => 2,
            11_025 => 4,
            _ => return -1,
        };
        if !(1..=spec::MAX_CHANNELS).contains(&channels) {
            return -1;
        }
        let Some(slot_index) = self
            .shared
            .slots
            .iter()
            .position(|slot| !slot.live.load(Ordering::Acquire))
        else {
            return -1;
        };
        let slot = &self.shared.slots[slot_index];
        slot.ensure_ring();
        slot.playing.store(false, Ordering::Release);
        let write = slot.write_pos.load(Ordering::Acquire);
        slot.read_pos.store(write, Ordering::Release);
        slot.end_flagged.store(false, Ordering::Relaxed);
        slot.starved.store(false, Ordering::Relaxed);
        slot.underrun_edge.store(false, Ordering::Relaxed);
        slot.ended_edge.store(false, Ordering::Relaxed);
        slot.upsample.store(factor, Ordering::Relaxed);
        slot.channels.store(channels as usize, Ordering::Relaxed);
        slot.volume.store(VOLUME_ONE, Ordering::Relaxed);
        slot.reset_epoch.fetch_add(1, Ordering::AcqRel);
        let generation = slot
            .generation
            .load(Ordering::Relaxed)
            .wrapping_add(1)
            .max(1)
            & HANDLE_GENERATION_MASK;
        let generation = generation.max(1);
        slot.generation.store(generation, Ordering::Release);
        self.last_free[slot_index] = spec::RING_FRAMES;
        slot.live.store(true, Ordering::SeqCst);
        self.shared.live_streams.fetch_add(1, Ordering::AcqRel);
        handle_of(slot_index, generation)
    }

    fn destroy_stream(&mut self, handle: i32) {
        let Some(slot_index) = self.slot_of(handle) else {
            return;
        };
        let slot = &self.shared.slots[slot_index];
        self.deactivate(slot);
        self.shared.live_streams.fetch_sub(1, Ordering::AcqRel);
        let write = slot.write_pos.load(Ordering::Acquire);
        slot.read_pos.store(write, Ordering::Release);
        slot.end_flagged.store(false, Ordering::Relaxed);
        slot.starved.store(false, Ordering::Relaxed);
        slot.underrun_edge.store(false, Ordering::Relaxed);
        slot.ended_edge.store(false, Ordering::Relaxed);
        slot.reset_epoch.fetch_add(1, Ordering::AcqRel);
        self.events.retain(|event| event.handle() != handle);
    }

    fn write_pcm(&mut self, handle: i32, pcm: &[u8]) -> i32 {
        let Some(slot_index) = self.slot_of(handle) else {
            return 0;
        };
        let slot = &self.shared.slots[slot_index];
        let ring = slot
            .ring
            .get()
            .expect("a live stream has an initialized ring");
        let channels = slot.channels.load(Ordering::Relaxed);
        let input_samples = pcm.len() / 2;
        let input_frames = input_samples / channels;
        let write = slot.write_pos.load(Ordering::Relaxed);
        let queued = write
            .wrapping_sub(slot.read_pos.load(Ordering::Acquire))
            .min(spec::RING_FRAMES);
        let accepted = input_frames.min(spec::RING_FRAMES - queued);
        for frame in 0..accepted {
            let offset = ((write + frame) % spec::RING_FRAMES) * 2;
            let left = sample_le(pcm, frame * channels);
            let right = if channels == 1 {
                left
            } else {
                sample_le(pcm, frame * channels + 1)
            };
            ring[offset].store(left, Ordering::Relaxed);
            ring[offset + 1].store(right, Ordering::Relaxed);
        }
        slot.write_pos
            .store(write.wrapping_add(accepted), Ordering::Release);
        self.last_free[slot_index] = self.last_free[slot_index].saturating_sub(accepted);
        accepted as i32
    }

    fn play(&self, handle: i32) {
        if let Some(slot) = self.slot(handle) {
            slot.starved.store(false, Ordering::Relaxed);
            slot.playing.store(true, Ordering::Release);
        }
    }

    fn pause(&self, handle: i32) {
        if let Some(slot) = self.slot(handle) {
            slot.playing.store(false, Ordering::Release);
        }
    }

    fn stop(&self, handle: i32) {
        if let Some(slot) = self.slot(handle) {
            slot.playing.store(false, Ordering::Release);
            // Hide the slot and drain a callback that may have passed the
            // playing check before clearing any edge it published. The handle
            // and live-stream count stay unchanged while stop owns the slot.
            slot.live.store(false, Ordering::SeqCst);
            self.wait_for_callback();
            let write = slot.write_pos.load(Ordering::Acquire);
            slot.read_pos.store(write, Ordering::Release);
            slot.end_flagged.store(false, Ordering::Relaxed);
            slot.starved.store(false, Ordering::Relaxed);
            slot.underrun_edge.store(false, Ordering::Relaxed);
            slot.ended_edge.store(false, Ordering::Relaxed);
            slot.reset_epoch.fetch_add(1, Ordering::AcqRel);
            slot.live.store(true, Ordering::SeqCst);
        }
    }

    fn set_volume(&self, handle: i32, volume: f64) {
        if let Some(slot) = self.slot(handle) {
            let volume = if volume.is_finite() {
                volume.clamp(0.0, 1.0)
            } else {
                0.0
            };
            slot.volume.store(
                (volume * VOLUME_ONE as f64).round() as i32,
                Ordering::Relaxed,
            );
        }
    }

    fn end_stream(&self, handle: i32) {
        if let Some(slot) = self.slot(handle) {
            slot.end_flagged.store(true, Ordering::Release);
        }
    }

    /// Snapshot audio-clock facts before the guest turn. This is the tick
    /// boundary; poll() only drains this fixed batch.
    fn begin_tick(&mut self) {
        for slot_index in 0..spec::MAX_STREAMS {
            let slot = &self.shared.slots[slot_index];
            if !slot.live.load(Ordering::Acquire) {
                continue;
            }
            let handle = handle_of(slot_index, slot.generation.load(Ordering::Acquire));
            if slot.ended_edge.swap(false, Ordering::AcqRel) {
                self.events.push_back(AudioEvent::Ended { handle });
            }
            if slot.underrun_edge.swap(false, Ordering::AcqRel) {
                self.events.push_back(AudioEvent::Underrun { handle });
            }
            let free = spec::RING_FRAMES - slot.queued_frames();
            if free != self.last_free[slot_index] {
                self.last_free[slot_index] = free;
                self.events.push_back(AudioEvent::Credit { handle, free });
            }
        }
    }

    fn poll(&mut self) -> Option<String> {
        self.events.pop_front().map(AudioEvent::json)
    }

    fn reset(&mut self) {
        for slot in &self.shared.slots {
            if slot.live.swap(false, Ordering::SeqCst) {
                self.wait_for_callback();
                slot.playing.store(false, Ordering::Release);
                let write = slot.write_pos.load(Ordering::Acquire);
                slot.read_pos.store(write, Ordering::Release);
                slot.end_flagged.store(false, Ordering::Relaxed);
                slot.starved.store(false, Ordering::Relaxed);
                slot.underrun_edge.store(false, Ordering::Relaxed);
                slot.ended_edge.store(false, Ordering::Relaxed);
                slot.reset_epoch.fetch_add(1, Ordering::AcqRel);
                self.shared.live_streams.fetch_sub(1, Ordering::AcqRel);
            }
        }
        self.events.clear();
    }

    fn deactivate(&self, slot: &StreamSlot) {
        slot.live.store(false, Ordering::SeqCst);
        self.wait_for_callback();
        slot.playing.store(false, Ordering::Release);
    }

    fn wait_for_callback(&self) {
        while self.clock.active.load(Ordering::SeqCst) {
            thread::yield_now();
        }
    }

    fn slot_of(&self, handle: i32) -> Option<usize> {
        if handle < 0 {
            return None;
        }
        let slot_index = (handle as usize) & ((1 << HANDLE_SLOT_BITS) - 1);
        let slot = self.shared.slots.get(slot_index)?;
        let generation = (handle as u32) >> HANDLE_SLOT_BITS;
        (slot.live.load(Ordering::Acquire) && slot.generation.load(Ordering::Acquire) == generation)
            .then_some(slot_index)
    }

    fn slot(&self, handle: i32) -> Option<&StreamSlot> {
        self.slot_of(handle).map(|index| &self.shared.slots[index])
    }
}

fn handle_of(slot: usize, generation: u32) -> i32 {
    ((generation << HANDLE_SLOT_BITS) | slot as u32) as i32
}

fn sample_le(bytes: &[u8], sample: usize) -> i16 {
    let offset = sample * 2;
    i16::from_le_bytes([bytes[offset], bytes[offset + 1]])
}

enum AudioOutput {
    #[cfg(feature = "audio-output")]
    Device {
        _stream: cpal::Stream,
        _fallback: Option<SilentSink>,
        tick_sink: Option<TickSink>,
    },
    Silent {
        _sink: SilentSink,
    },
    TickDriven {
        sink: TickSink,
    },
}

impl AudioOutput {
    fn start(clients: Arc<[Arc<AudioShared>]>, clock: Arc<AudioClock>) -> Self {
        if std::env::var("POCKETJS_AUDIO").as_deref() == Ok("null") {
            log::info!("audio: POCKETJS_AUDIO=null; using clocked null sink");
            clock.fallback.store(true, Ordering::SeqCst);
            return Self::silent(clients, clock);
        }
        #[cfg(feature = "audio-output")]
        {
            Self::from_device_result(clients, clock, open_device)
        }
        #[cfg(not(feature = "audio-output"))]
        {
            log::info!("audio: device output excluded at build time; using clocked null sink");
            Self::silent(clients, clock)
        }
    }

    #[cfg(feature = "audio-output")]
    fn from_device_result(
        clients: Arc<[Arc<AudioShared>]>,
        clock: Arc<AudioClock>,
        open: impl FnOnce(
            Arc<[Arc<AudioShared>]>,
            Arc<AudioClock>,
            Option<thread::Thread>,
        ) -> std::result::Result<cpal::Stream, String>,
    ) -> Self {
        let tick_clients = clients.clone();
        let fallback = match SilentSink::start(clients.clone(), clock.clone()) {
            Ok(sink) => Some(sink),
            Err(error) => {
                log::warn!("audio: cannot prepare device-loss null sink: {error}");
                None
            }
        };
        let wake = fallback.as_ref().map(SilentSink::wake_handle);
        let needs_tick_sink = fallback.is_none();
        match open(clients, clock.clone(), wake) {
            Ok(stream) => {
                log::info!("audio: 44.1 kHz output started");
                Self::Device {
                    _stream: stream,
                    _fallback: fallback,
                    tick_sink: needs_tick_sink.then(|| TickSink::new(tick_clients, clock.clone())),
                }
            }
            Err(error) => {
                log::warn!("audio: output unavailable ({error}); using clocked null sink");
                clock.fallback.store(true, Ordering::SeqCst);
                if let Some(sink) = fallback {
                    sink.wake();
                    Self::Silent { _sink: sink }
                } else {
                    clock.tick_fallback.store(true, Ordering::Release);
                    Self::TickDriven {
                        sink: TickSink::new(tick_clients, clock),
                    }
                }
            }
        }
    }

    fn silent(clients: Arc<[Arc<AudioShared>]>, clock: Arc<AudioClock>) -> Self {
        clock.fallback.store(true, Ordering::SeqCst);
        let tick_clients = clients.clone();
        match SilentSink::start(clients, clock.clone()) {
            Ok(sink) => Self::Silent { _sink: sink },
            Err(error) => {
                log::error!("audio: cannot start null sink: {error}");
                clock.tick_fallback.store(true, Ordering::Release);
                Self::TickDriven {
                    sink: TickSink::new(tick_clients, clock),
                }
            }
        }
    }

    fn begin_tick(&mut self) {
        match self {
            #[cfg(feature = "audio-output")]
            Self::Device {
                tick_sink: Some(sink),
                ..
            } if sink.clock().tick_fallback.load(Ordering::Acquire) => sink.begin_tick(),
            Self::TickDriven { sink } => sink.begin_tick(),
            _ => {}
        }
    }

    #[cfg(test)]
    fn is_silent(&self) -> bool {
        matches!(self, Self::Silent { .. } | Self::TickDriven { .. })
    }
}

#[cfg(feature = "audio-output")]
fn open_device(
    clients: Arc<[Arc<AudioShared>]>,
    clock: Arc<AudioClock>,
    fallback_wake: Option<thread::Thread>,
) -> std::result::Result<Stream, String> {
    let host = cpal::default_host();
    let device = host
        .default_output_device()
        .ok_or_else(|| "no default output device".to_string())?;
    let range = device
        .supported_output_configs()
        .map_err(|error| error.to_string())?
        .filter(|range| {
            range.min_sample_rate() <= OUTPUT_RATE
                && range.max_sample_rate() >= OUTPUT_RATE
                && matches!(
                    range.sample_format(),
                    SampleFormat::I16 | SampleFormat::U16 | SampleFormat::F32
                )
        })
        .min_by_key(output_config_score)
        .ok_or_else(|| "device has no 44.1 kHz i16/u16/f32 output configuration".to_string())?;
    let format = range.sample_format();
    let supported = range.with_sample_rate(OUTPUT_RATE);
    let config = supported.config();
    let stream = match format {
        SampleFormat::I16 => {
            build_output_stream(&device, &config, clients, clock, fallback_wake, |sample| {
                sample as i16
            })
        }
        SampleFormat::U16 => {
            build_output_stream(&device, &config, clients, clock, fallback_wake, |sample| {
                (sample + 32_768) as u16
            })
        }
        SampleFormat::F32 => {
            build_output_stream(&device, &config, clients, clock, fallback_wake, |sample| {
                sample as f32 / 32_768.0
            })
        }
        _ => unreachable!("filtered output format"),
    }?;
    stream.play().map_err(|error| error.to_string())?;
    Ok(stream)
}

#[cfg(feature = "audio-output")]
fn output_config_score(range: &SupportedStreamConfigRange) -> (bool, u8, u16) {
    let format = match range.sample_format() {
        SampleFormat::I16 => 0,
        SampleFormat::F32 => 1,
        SampleFormat::U16 => 2,
        _ => 3,
    };
    (
        range.channels() != OUTPUT_CHANNELS as u16,
        format,
        range.channels().abs_diff(OUTPUT_CHANNELS as u16),
    )
}

#[cfg(feature = "audio-output")]
fn build_output_stream<T>(
    device: &cpal::Device,
    config: &StreamConfig,
    clients: Arc<[Arc<AudioShared>]>,
    clock: Arc<AudioClock>,
    fallback_wake: Option<thread::Thread>,
    encode: fn(i32) -> T,
) -> std::result::Result<Stream, String>
where
    T: cpal::SizedSample + 'static,
{
    let channels = config.channels as usize;
    let mut mixer = Mixer::new(clients, clock.clone());
    let output_clock = clock.clone();
    device
        .build_output_stream(
            *config,
            move |output: &mut [T], _| {
                if output_clock.fallback.load(Ordering::SeqCst) {
                    for sample in output {
                        *sample = encode(0);
                    }
                } else {
                    mixer.render_with(output, channels, true, encode);
                }
            },
            output_error_callback(clock, fallback_wake),
            None,
        )
        .map_err(|error| error.to_string())
}

/// CPAL may call this closure from a real-time thread. Keep it to atomics and
/// `unpark`; the null-sink worker or host tick emits the diagnostic.
#[cfg(feature = "audio-output")]
fn output_error_callback(
    clock: Arc<AudioClock>,
    fallback_wake: Option<thread::Thread>,
) -> impl FnMut(cpal::Error) + Send + 'static {
    move |_error| {
        activate_device_fallback(&clock, fallback_wake.as_ref());
    }
}

#[cfg(any(feature = "audio-output", test))]
fn activate_device_fallback(clock: &AudioClock, fallback_wake: Option<&thread::Thread>) {
    clock.report_device_failure.store(true, Ordering::Release);
    clock.fallback.store(true, Ordering::SeqCst);
    if let Some(worker) = fallback_wake {
        worker.unpark();
    } else {
        clock.tick_fallback.store(true, Ordering::Release);
    }
}

struct TickSink {
    mixer: Mixer,
}

impl TickSink {
    fn new(clients: Arc<[Arc<AudioShared>]>, clock: Arc<AudioClock>) -> Self {
        Self {
            mixer: Mixer::new(clients, clock),
        }
    }

    #[cfg(feature = "audio-output")]
    fn clock(&self) -> &AudioClock {
        &self.mixer.clock
    }

    fn begin_tick(&mut self) {
        if self
            .mixer
            .clock
            .report_device_failure
            .swap(false, Ordering::AcqRel)
        {
            log::error!("audio: output stream failed; using host-tick clock");
        }
        let mut output = [0i16; TICK_OUTPUT_SAMPLES];
        self.mixer.render(&mut output);
    }
}

struct SilentSink {
    running: Arc<AtomicBool>,
    worker: Option<JoinHandle<()>>,
}

impl SilentSink {
    fn start(clients: Arc<[Arc<AudioShared>]>, clock: Arc<AudioClock>) -> std::io::Result<Self> {
        let running = Arc::new(AtomicBool::new(true));
        let run = running.clone();
        let worker = thread::Builder::new()
            .name("pocket-audio-null".into())
            .spawn(move || {
                let mut mixer = Mixer::new(clients, clock.clone());
                let mut output = [0i16; OUTPUT_BLOCK_FRAMES * OUTPUT_CHANNELS as usize];
                let block =
                    Duration::from_secs_f64(OUTPUT_BLOCK_FRAMES as f64 / OUTPUT_RATE as f64);
                let mut deadline = Instant::now();
                while run.load(Ordering::Acquire) {
                    if clock.report_device_failure.swap(false, Ordering::AcqRel) {
                        log::error!("audio: output stream failed; switched to null sink");
                    }
                    if !clock.fallback.load(Ordering::SeqCst) {
                        thread::park();
                        deadline = Instant::now();
                        continue;
                    }
                    mixer.render(&mut output);
                    deadline += block;
                    if let Some(wait) = deadline.checked_duration_since(Instant::now()) {
                        thread::sleep(wait);
                    } else {
                        deadline = Instant::now();
                    }
                }
            })?;
        Ok(Self {
            running,
            worker: Some(worker),
        })
    }

    #[cfg(feature = "audio-output")]
    fn wake_handle(&self) -> thread::Thread {
        self.worker
            .as_ref()
            .expect("live silent sink has a worker")
            .thread()
            .clone()
    }

    #[cfg(feature = "audio-output")]
    fn wake(&self) {
        if let Some(worker) = &self.worker {
            worker.thread().unpark();
        }
    }
}

impl Drop for SilentSink {
    fn drop(&mut self) {
        self.running.store(false, Ordering::Release);
        if let Some(worker) = self.worker.take() {
            worker.thread().unpark();
            let _ = worker.join();
        }
    }
}

#[derive(Clone)]
pub(crate) struct AudioClient {
    shared: Arc<AudioShared>,
    clock: Arc<AudioClock>,
}

/// One process-local device callback with a preallocated client set. Each
/// QuickJS realm receives one client and its own four-stream handle domain.
pub(crate) struct AudioHost {
    clients: Vec<AudioClient>,
    output: AudioOutput,
}

impl AudioHost {
    pub(crate) fn new(client_count: usize) -> Self {
        let clock = Arc::new(AudioClock::new());
        let shared: Arc<[Arc<AudioShared>]> = (0..client_count.max(1))
            .map(|_| Arc::new(AudioShared::new()))
            .collect::<Vec<_>>()
            .into();
        let clients = shared
            .iter()
            .cloned()
            .map(|shared| AudioClient {
                shared,
                clock: clock.clone(),
            })
            .collect();
        let output = AudioOutput::start(shared, clock);
        Self { clients, output }
    }

    pub(crate) fn client(&self, index: usize) -> AudioClient {
        self.clients[index].clone()
    }

    pub(crate) fn begin_tick(&mut self) {
        self.output.begin_tick();
    }
}

/// Guest-local audio namespace attached to the process audio host.
pub(crate) struct AudioSurface {
    core: Rc<RefCell<AudioCore>>,
}

impl AudioSurface {
    pub(crate) fn new(client: AudioClient) -> Self {
        Self {
            core: Rc::new(RefCell::new(AudioCore::new(client.shared, client.clock))),
        }
    }

    pub(crate) fn begin_tick(&self) {
        self.core.borrow_mut().begin_tick();
    }

    pub(crate) fn reset(&self) {
        self.core.borrow_mut().reset();
    }

    pub(crate) fn mount(&self, guest: &Guest) -> Result<()> {
        guest.mount("audio", |ctx, ns| {
            let core = self.core.clone();
            ns.set(
                "createStream",
                Function::new(ctx.clone(), move |rate: i64, channels: i64| {
                    let (Ok(rate), Ok(channels)) = (u32::try_from(rate), u32::try_from(channels))
                    else {
                        return -1;
                    };
                    core.borrow_mut().create_stream(rate, channels)
                })?,
            )?;

            let core = self.core.clone();
            ns.set(
                "destroyStream",
                Function::new(ctx.clone(), move |handle: i32| {
                    core.borrow_mut().destroy_stream(handle)
                })?,
            )?;

            let core = self.core.clone();
            ns.set(
                "writePcm",
                Function::new(ctx.clone(), move |handle: i32, pcm: ArrayBuffer| {
                    pcm.as_bytes()
                        .map_or(0, |bytes| core.borrow_mut().write_pcm(handle, bytes))
                })?,
            )?;

            let core = self.core.clone();
            ns.set(
                "play",
                Function::new(ctx.clone(), move |handle: i32| core.borrow().play(handle))?,
            )?;

            let core = self.core.clone();
            ns.set(
                "pause",
                Function::new(ctx.clone(), move |handle: i32| core.borrow().pause(handle))?,
            )?;

            let core = self.core.clone();
            ns.set(
                "stop",
                Function::new(ctx.clone(), move |handle: i32| core.borrow().stop(handle))?,
            )?;

            let core = self.core.clone();
            ns.set(
                "setVolume",
                Function::new(ctx.clone(), move |handle: i32, volume: f64| {
                    core.borrow().set_volume(handle, volume)
                })?,
            )?;

            let core = self.core.clone();
            ns.set(
                "endStream",
                Function::new(ctx.clone(), move |handle: i32| {
                    core.borrow().end_stream(handle)
                })?,
            )?;

            let core = self.core.clone();
            ns.set(
                "poll",
                Function::new(ctx.clone(), move || core.borrow_mut().poll())?,
            )?;
            Ok(())
        })
    }
}

impl Drop for AudioSurface {
    fn drop(&mut self) {
        self.reset();
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn fixture() -> (AudioCore, Mixer) {
        let shared = Arc::new(AudioShared::new());
        let clock = Arc::new(AudioClock::new());
        let clients: Arc<[Arc<AudioShared>]> = vec![shared.clone()].into();
        (
            AudioCore::new(shared, clock.clone()),
            Mixer::new(clients, clock),
        )
    }

    fn pcm(samples: &[i16]) -> Vec<u8> {
        samples
            .iter()
            .flat_map(|sample| sample.to_le_bytes())
            .collect()
    }

    #[test]
    fn credit_tracks_consumption_and_stop_flush() {
        let (mut core, mut mixer) = fixture();
        let handle = core.create_stream(44_100, 2);
        assert!(handle > 0);
        assert_eq!(
            core.write_pcm(handle, &pcm(&[1, -1, 2, -2, 3, -3, 4, -4])),
            4
        );
        core.begin_tick();
        assert_eq!(
            core.poll(),
            None,
            "accepted writes update the credit mirror"
        );

        core.play(handle);
        let mut output = [0; 4];
        mixer.render(&mut output);
        core.begin_tick();
        assert_eq!(
            core.poll().as_deref(),
            Some(r#"{"t":"credit","h":8,"free":16382}"#)
        );

        core.stop(handle);
        core.begin_tick();
        assert_eq!(
            core.poll().as_deref(),
            Some(r#"{"t":"credit","h":8,"free":16384}"#)
        );
    }

    #[test]
    fn stop_waits_for_callback_and_discards_its_late_underrun() {
        let shared = Arc::new(AudioShared::new());
        let clock = Arc::new(AudioClock::new());
        let mut core = AudioCore::new(shared.clone(), clock.clone());
        let handle = core.create_stream(44_100, 1);
        assert_eq!(core.write_pcm(handle, &pcm(&[1234])), 1);
        core.play(handle);
        clock.active.store(true, Ordering::SeqCst);

        let worker = thread::spawn(move || {
            core.stop(handle);
            core
        });
        let slot = &shared.slots[0];
        while slot.playing.load(Ordering::Acquire) {
            thread::yield_now();
        }
        slot.starved.store(true, Ordering::Relaxed);
        slot.underrun_edge.store(true, Ordering::Release);
        clock.active.store(false, Ordering::SeqCst);

        let mut core = worker.join().unwrap();
        core.begin_tick();
        assert_eq!(
            core.poll().as_deref(),
            Some(r#"{"t":"credit","h":8,"free":16384}"#)
        );
        assert_eq!(core.poll(), None);
    }

    #[test]
    fn underrun_is_one_edge_per_starved_episode() {
        let (mut core, mut mixer) = fixture();
        let handle = core.create_stream(44_100, 1);
        core.play(handle);
        mixer.render(&mut [0; 8]);
        mixer.render(&mut [0; 8]);
        core.begin_tick();
        assert_eq!(core.poll().as_deref(), Some(r#"{"t":"underrun","h":8}"#));
        assert_eq!(core.poll(), None);
        mixer.render(&mut [0; 8]);
        core.begin_tick();
        assert_eq!(
            core.poll(),
            None,
            "continuous starvation must not emit another underrun edge"
        );

        assert_eq!(core.write_pcm(handle, &pcm(&[1234])), 1);
        mixer.render(&mut [0; 2]);
        mixer.render(&mut [0; 2]);
        core.begin_tick();
        assert_eq!(core.poll().as_deref(), Some(r#"{"t":"underrun","h":8}"#));
        assert_eq!(
            core.poll().as_deref(),
            Some(r#"{"t":"credit","h":8,"free":16384}"#)
        );
    }

    #[test]
    fn ended_fires_once_after_drain_without_underrun() {
        let (mut core, mut mixer) = fixture();
        let handle = core.create_stream(44_100, 1);
        assert_eq!(core.write_pcm(handle, &pcm(&[100, 200])), 2);
        core.end_stream(handle);
        core.play(handle);
        let mut output = [0; 4];
        mixer.render(&mut output);
        core.begin_tick();
        assert_eq!(core.poll().as_deref(), Some(r#"{"t":"ended","h":8}"#));
        assert_eq!(
            core.poll().as_deref(),
            Some(r#"{"t":"credit","h":8,"free":16384}"#)
        );
        assert_eq!(core.poll(), None);
        mixer.render(&mut output);
        core.begin_tick();
        assert_eq!(core.poll(), None);

        assert_eq!(core.write_pcm(handle, &pcm(&[300])), 1);
        mixer.render(&mut [0; 2]);
        assert_eq!(
            core.shared.slots[0].queued_frames(),
            1,
            "ended streams stay paused until replayed"
        );
        core.end_stream(handle);
        core.play(handle);
        mixer.render(&mut [0; 2]);
        core.begin_tick();
        assert_eq!(core.poll().as_deref(), Some(r#"{"t":"ended","h":8}"#));
        assert_eq!(
            core.poll().as_deref(),
            Some(r#"{"t":"credit","h":8,"free":16384}"#)
        );
        assert_eq!(core.poll(), None);
    }

    #[test]
    fn volume_is_applied_on_the_audio_clock_and_mono_is_upmixed() {
        let (mut core, mut mixer) = fixture();
        let handle = core.create_stream(44_100, 1);
        core.set_volume(handle, 0.25);
        core.write_pcm(handle, &pcm(&[12_000, 12_000, 12_000, 12_000]));
        core.play(handle);
        let mut output = [0; 2];
        mixer.render(&mut output);
        assert_eq!(output, [3_000, 3_000]);

        core.set_volume(handle, 0.5);
        mixer.render(&mut output);
        assert_eq!(output, [6_000, 6_000]);
        core.set_volume(handle, 2.0);
        mixer.render(&mut output);
        assert_eq!(output, [12_000, 12_000]);
        core.set_volume(handle, f64::NAN);
        mixer.render(&mut output);
        assert_eq!(output, [0, 0]);
    }

    #[test]
    fn one_callback_mixes_isolated_guest_clients_with_saturation() {
        let left = Arc::new(AudioShared::new());
        let right = Arc::new(AudioShared::new());
        let clock = Arc::new(AudioClock::new());
        let clients: Arc<[Arc<AudioShared>]> = vec![left.clone(), right.clone()].into();
        let mut mixer = Mixer::new(clients, clock.clone());
        let mut left_core = AudioCore::new(left, clock.clone());
        let mut right_core = AudioCore::new(right, clock);
        let left_handle = left_core.create_stream(44_100, 1);
        let right_handle = right_core.create_stream(44_100, 1);
        left_core.write_pcm(left_handle, &pcm(&[20_000]));
        right_core.write_pcm(right_handle, &pcm(&[20_000]));
        left_core.play(left_handle);
        right_core.play(right_handle);

        let mut output = [0; 2];
        mixer.render(&mut output);
        assert_eq!(output, [i16::MAX, i16::MAX]);
    }

    #[test]
    fn accepted_rates_consume_one_source_frame_per_integer_ratio() {
        for (rate, factor) in [(44_100, 1), (22_050, 2), (11_025, 4)] {
            let (mut core, mut mixer) = fixture();
            let handle = core.create_stream(rate, 1);
            core.write_pcm(handle, &pcm(&[4_000, 8_000, 12_000]));
            core.play(handle);
            let mut output = vec![0; (3 * factor - 1) * 2];
            mixer.render(&mut output);
            assert_eq!(core.shared.slots[0].queued_frames(), 1, "rate {rate}");
            let expected: Vec<i16> = (1..=3 * factor - 1)
                .map(|step| (step * 4_000 / factor) as i16)
                .collect();
            assert_eq!(
                output
                    .chunks_exact(2)
                    .map(|frame| frame[0])
                    .collect::<Vec<_>>(),
                expected,
                "rate {rate} interpolation"
            );

            mixer.render(&mut [0; 2]);
            assert_eq!(core.shared.slots[0].queued_frames(), 0, "rate {rate}");
        }
        let (mut core, _) = fixture();
        assert_eq!(core.create_stream(48_000, 2), -1);
        assert_eq!(core.create_stream(44_100, 3), -1);
    }

    #[test]
    fn destroyed_slot_is_reusable_before_another_audio_callback() {
        let (mut core, _) = fixture();
        let handles =
            std::array::from_fn::<_, { spec::MAX_STREAMS }, _>(|_| core.create_stream(44_100, 2));
        assert!(handles.iter().all(|handle| *handle > 0));
        assert_eq!(core.create_stream(44_100, 2), -1);

        core.destroy_stream(handles[0]);
        let replacement = core.create_stream(44_100, 2);
        assert!(replacement > 0);
        assert_ne!(replacement, handles[0]);
        assert_eq!(core.write_pcm(handles[0], &pcm(&[1, -1])), 0);
        assert_eq!(core.write_pcm(replacement, &pcm(&[1, -1])), 1);
    }

    #[test]
    fn pcm_rings_are_allocated_only_for_created_streams() {
        let shared = Arc::new(AudioShared::new());
        let clock = Arc::new(AudioClock::new());
        let mut core = AudioCore::new(shared.clone(), clock);
        assert!(shared.slots.iter().all(|slot| slot.ring.get().is_none()));

        assert!(core.create_stream(44_100, 2) > 0);
        assert!(shared.slots[0].ring.get().is_some());
        assert!(
            shared.slots[1..]
                .iter()
                .all(|slot| slot.ring.get().is_none())
        );
    }

    #[test]
    fn destroy_waits_for_the_active_callback_before_reusing_state() {
        let shared = Arc::new(AudioShared::new());
        let clock = Arc::new(AudioClock::new());
        let mut core = AudioCore::new(shared.clone(), clock.clone());
        let handle = core.create_stream(44_100, 1);
        clock.active.store(true, Ordering::SeqCst);

        let worker = thread::spawn(move || {
            core.destroy_stream(handle);
            core
        });
        while shared.slots[0].live.load(Ordering::SeqCst) {
            thread::yield_now();
        }
        assert!(!worker.is_finished());
        clock.active.store(false, Ordering::SeqCst);

        let mut core = worker.join().unwrap();
        assert!(core.create_stream(44_100, 1) > 0);
    }

    #[test]
    fn full_ring_credit_can_be_consumed_and_refilled_repeatedly() {
        let (mut core, mut mixer) = fixture();
        let handle = core.create_stream(44_100, 1);
        let full = pcm(&vec![7; spec::RING_FRAMES]);
        assert_eq!(core.write_pcm(handle, &full), spec::RING_FRAMES as i32);
        assert_eq!(core.write_pcm(handle, &pcm(&[8])), 0);
        core.play(handle);

        mixer.render(&mut [0; 4]);
        core.begin_tick();
        assert_eq!(
            core.poll().as_deref(),
            Some(r#"{"t":"credit","h":8,"free":2}"#)
        );
        assert_eq!(core.write_pcm(handle, &pcm(&[8, 9])), 2);
        core.begin_tick();
        assert_eq!(core.poll(), None, "accepted writes consume mirrored credit");

        mixer.render(&mut [0; 4]);
        core.begin_tick();
        assert_eq!(
            core.poll().as_deref(),
            Some(r#"{"t":"credit","h":8,"free":2}"#)
        );
    }

    #[test]
    #[cfg(feature = "audio-output")]
    fn failed_device_open_falls_back_to_a_clocked_null_sink() {
        let shared = Arc::new(AudioShared::new());
        let clock = Arc::new(AudioClock::new());
        let mut core = AudioCore::new(shared.clone(), clock.clone());
        let clients: Arc<[Arc<AudioShared>]> = vec![shared].into();
        let output =
            AudioOutput::from_device_result(clients, clock, |_, _, _| Err("no device".into()));
        assert!(output.is_silent());
        let handle = core.create_stream(44_100, 1);
        core.write_pcm(handle, &pcm(&[1; 64]));
        core.end_stream(handle);
        core.play(handle);

        let deadline = Instant::now() + Duration::from_secs(1);
        let mut ended = false;
        let mut credited = false;
        let mut underrun = false;
        while Instant::now() < deadline && !ended {
            thread::sleep(Duration::from_millis(5));
            core.begin_tick();
            while let Some(event) = core.poll() {
                ended |= event.contains(r#""t":"ended""#);
                credited |= event.contains(r#""t":"credit""#);
                underrun |= event.contains(r#""t":"underrun""#);
            }
        }
        assert!(ended, "null sink must drain streams and publish ended");
        assert!(credited, "null sink must return consumed-frame credit");
        assert!(!underrun, "an ended stream must not report underrun");
    }

    #[test]
    #[cfg(feature = "audio-output")]
    fn device_loss_wakes_the_prepared_null_sink() {
        let shared = Arc::new(AudioShared::new());
        let clock = Arc::new(AudioClock::new());
        let mut core = AudioCore::new(shared.clone(), clock.clone());
        let clients: Arc<[Arc<AudioShared>]> = vec![shared].into();
        let sink = SilentSink::start(clients, clock.clone()).unwrap();
        let handle = core.create_stream(44_100, 1);
        core.write_pcm(handle, &pcm(&[1; 64]));
        core.end_stream(handle);
        core.play(handle);

        thread::sleep(Duration::from_millis(40));
        assert_eq!(core.shared.slots[0].queued_frames(), 64);
        let mut on_error = output_error_callback(clock.clone(), Some(sink.wake_handle()));
        on_error(cpal::Error::new(cpal::ErrorKind::DeviceNotAvailable));
        assert!(clock.fallback.load(Ordering::SeqCst));

        let deadline = Instant::now() + Duration::from_secs(1);
        let mut ended = false;
        while Instant::now() < deadline && !ended {
            thread::sleep(Duration::from_millis(5));
            core.begin_tick();
            while let Some(event) = core.poll() {
                ended |= event.contains(r#""t":"ended""#);
            }
        }
        assert!(ended, "device-loss fallback must continue the module clock");
    }

    #[test]
    fn device_loss_without_a_prepared_null_sink_uses_the_tick_clock() {
        let shared = Arc::new(AudioShared::new());
        let clock = Arc::new(AudioClock::new());
        let mut core = AudioCore::new(shared.clone(), clock.clone());
        let clients: Arc<[Arc<AudioShared>]> = vec![shared].into();
        let mut output = AudioOutput::TickDriven {
            sink: TickSink::new(clients, clock.clone()),
        };
        let handle = core.create_stream(44_100, 1);
        core.write_pcm(handle, &pcm(&[1; 64]));
        core.end_stream(handle);
        core.play(handle);

        activate_device_fallback(&clock, None);
        assert!(clock.tick_fallback.load(Ordering::Acquire));
        output.begin_tick();
        core.begin_tick();

        assert_eq!(core.poll().as_deref(), Some(r#"{"t":"ended","h":8}"#));
        assert_eq!(
            core.poll().as_deref(),
            Some(r#"{"t":"credit","h":8,"free":16384}"#)
        );
        assert_eq!(core.poll(), None);
    }

    #[test]
    #[cfg(not(feature = "audio-output"))]
    fn build_without_device_output_uses_the_clocked_null_sink() {
        let shared = Arc::new(AudioShared::new());
        let clock = Arc::new(AudioClock::new());
        let clients: Arc<[Arc<AudioShared>]> = vec![shared].into();
        let output = AudioOutput::start(clients, clock.clone());

        assert!(output.is_silent());
        assert!(clock.fallback.load(Ordering::SeqCst));
    }

    #[test]
    fn mounted_namespace_exposes_every_audio_operation() {
        let shared = Arc::new(AudioShared::new());
        let surface = AudioSurface::new(AudioClient {
            shared,
            clock: Arc::new(AudioClock::new()),
        });
        let guest = Guest::new().unwrap();
        surface.mount(&guest).unwrap();
        guest
            .eval(
                "audio-mount-test",
                r#"
                const pcm = new ArrayBuffer(8);
                new Int16Array(pcm).set([100, -100, 200, -200]);
                const h = audio.createStream(44100, 2);
                globalThis.accepted = audio.writePcm(h, pcm);
                audio.setVolume(h, 0.5);
                audio.play(h);
                audio.pause(h);
                audio.stop(h);
                audio.endStream(h);
                globalThis.emptyPoll = audio.poll() === undefined;
                audio.destroyStream(h);
                globalThis.staleWrite = audio.writePcm(h, pcm);
                "#,
            )
            .unwrap();
        let (accepted, empty_poll, stale_write): (i32, bool, i32) = guest.with(|ctx| {
            let globals = ctx.globals();
            (
                globals.get("accepted").unwrap(),
                globals.get("emptyPoll").unwrap(),
                globals.get("staleWrite").unwrap(),
            )
        });
        assert_eq!(accepted, 2);
        assert!(empty_poll);
        assert_eq!(stale_write, 0);
    }
}
