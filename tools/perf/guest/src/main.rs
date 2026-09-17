use std::alloc::{GlobalAlloc, Layout, System};
use std::collections::{BTreeMap, HashMap};
use std::fs;
use std::mem::MaybeUninit;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};

use anyhow::{Context as _, Result, anyhow, bail};
use pocket_mod::Guest;
use pocket_mod::qjs::{Array, CatchResultExt, Function};
use pocket_ui_surface::UiSurface;
use pocketjs_core::{raster, spec::btn};
use serde::{Deserialize, Serialize};
use serde_json::Value;

const GUEST_PREFIX: &str = "POCKETJS_PERF_GUEST ";
const MARKER_SYSCALL: u32 = 4096;
const MARKER_MAGIC: u32 = 0x504a_424d;
const MARKER_VERSION: u32 = 1;
const MARKER_COOKIE: u32 = 0xc001_c0de;
const MARKER_BEGIN: u32 = 1;
const MARKER_END: u32 = 2;

#[cfg(any(target_os = "linux", test))]
fn fill_deterministic_random(call: u64, bytes: &mut [u8]) {
    for (index, byte) in bytes.iter_mut().enumerate() {
        *byte = (call as u8)
            .wrapping_mul(0x9d)
            .wrapping_add(index as u8)
            .wrapping_add(0x53);
    }
}

#[cfg(all(target_os = "linux", not(test)))]
static DETERMINISTIC_RANDOM_CALLS: AtomicU64 = AtomicU64::new(0);

/// Rust's Linux `RandomState` initialization resolves this weak C symbol
/// before falling back to the guest `getrandom(2)` syscall. This symbol is
/// benchmark-only: it fixes benchmark entropy while preserving the workload's
/// inputs and logic. The guest is single-threaded, so the call-indexed stream
/// is reproducible.
#[cfg(all(target_os = "linux", not(test)))]
#[unsafe(no_mangle)]
unsafe extern "C" fn getrandom(
    buffer: *mut libc::c_void,
    length: libc::size_t,
    _flags: libc::c_uint,
) -> libc::ssize_t {
    if length == 0 {
        return 0;
    }
    if buffer.is_null() || length > isize::MAX as usize {
        return -1;
    }
    let call = DETERMINISTIC_RANDOM_CALLS.fetch_add(1, Ordering::Relaxed);
    let bytes = unsafe { std::slice::from_raw_parts_mut(buffer.cast::<u8>(), length) };
    fill_deterministic_random(call, bytes);
    length as libc::ssize_t
}

const SHA256_INITIAL_STATE: [u32; 8] = [
    0x6a09_e667,
    0xbb67_ae85,
    0x3c6e_f372,
    0xa54f_f53a,
    0x510e_527f,
    0x9b05_688c,
    0x1f83_d9ab,
    0x5be0_cd19,
];

const SHA256_ROUND_CONSTANTS: [u32; 64] = [
    0x428a_2f98,
    0x7137_4491,
    0xb5c0_fbcf,
    0xe9b5_dba5,
    0x3956_c25b,
    0x59f1_11f1,
    0x923f_82a4,
    0xab1c_5ed5,
    0xd807_aa98,
    0x1283_5b01,
    0x2431_85be,
    0x550c_7dc3,
    0x72be_5d74,
    0x80de_b1fe,
    0x9bdc_06a7,
    0xc19b_f174,
    0xe49b_69c1,
    0xefbe_4786,
    0x0fc1_9dc6,
    0x240c_a1cc,
    0x2de9_2c6f,
    0x4a74_84aa,
    0x5cb0_a9dc,
    0x76f9_88da,
    0x983e_5152,
    0xa831_c66d,
    0xb003_27c8,
    0xbf59_7fc7,
    0xc6e0_0bf3,
    0xd5a7_9147,
    0x06ca_6351,
    0x1429_2967,
    0x27b7_0a85,
    0x2e1b_2138,
    0x4d2c_6dfc,
    0x5338_0d13,
    0x650a_7354,
    0x766a_0abb,
    0x81c2_c92e,
    0x9272_2c85,
    0xa2bf_e8a1,
    0xa81a_664b,
    0xc24b_8b70,
    0xc76c_51a3,
    0xd192_e819,
    0xd699_0624,
    0xf40e_3585,
    0x106a_a070,
    0x19a4_c116,
    0x1e37_6c08,
    0x2748_774c,
    0x34b0_bcb5,
    0x391c_0cb3,
    0x4ed8_aa4a,
    0x5b9c_ca4f,
    0x682e_6ff3,
    0x748f_82ee,
    0x78a5_636f,
    0x84c8_7814,
    0x8cc7_0208,
    0x90be_fffa,
    0xa450_6ceb,
    0xbef9_a3f7,
    0xc671_78f2,
];

/// Small, dependency-free SHA-256 used only by the observational correctness
/// replay. Keeping the implementation in this fingerprinted harness avoids a
/// separately resolved crypto dependency becoming part of the executor.
struct Sha256 {
    state: [u32; 8],
    block: [u8; 64],
    block_len: usize,
    byte_len: u64,
}

impl Sha256 {
    fn new() -> Self {
        Self {
            state: SHA256_INITIAL_STATE,
            block: [0; 64],
            block_len: 0,
            byte_len: 0,
        }
    }

    fn digest(bytes: &[u8]) -> [u8; 32] {
        let mut digest = Self::new();
        digest.update(bytes);
        digest.finalize()
    }

    fn update(&mut self, mut bytes: &[u8]) {
        self.byte_len = self
            .byte_len
            .checked_add(bytes.len() as u64)
            .expect("benchmark SHA-256 input length overflowed u64");

        if self.block_len != 0 {
            let needed = 64 - self.block_len;
            let copied = needed.min(bytes.len());
            self.block[self.block_len..self.block_len + copied].copy_from_slice(&bytes[..copied]);
            self.block_len += copied;
            bytes = &bytes[copied..];
            if self.block_len == 64 {
                Self::compress(&mut self.state, &self.block);
                self.block_len = 0;
            } else {
                return;
            }
        }

        while bytes.len() >= 64 {
            let block: &[u8; 64] = bytes[..64]
                .try_into()
                .expect("SHA-256 block has a fixed length");
            Self::compress(&mut self.state, block);
            bytes = &bytes[64..];
        }
        self.block[..bytes.len()].copy_from_slice(bytes);
        self.block_len = bytes.len();
    }

    fn finalize(mut self) -> [u8; 32] {
        let bit_len = self.byte_len.wrapping_mul(8);
        self.block[self.block_len] = 0x80;
        self.block_len += 1;
        if self.block_len > 56 {
            self.block[self.block_len..].fill(0);
            Self::compress(&mut self.state, &self.block);
            self.block = [0; 64];
        } else {
            self.block[self.block_len..56].fill(0);
        }
        self.block[56..].copy_from_slice(&bit_len.to_be_bytes());
        Self::compress(&mut self.state, &self.block);

        let mut output = [0u8; 32];
        for (chunk, word) in output.chunks_exact_mut(4).zip(self.state) {
            chunk.copy_from_slice(&word.to_be_bytes());
        }
        output
    }

    fn compress(state: &mut [u32; 8], block: &[u8; 64]) {
        let mut schedule = [0u32; 64];
        for (index, bytes) in block.chunks_exact(4).enumerate() {
            schedule[index] =
                u32::from_be_bytes(bytes.try_into().expect("SHA-256 word is 4 bytes"));
        }
        for index in 16..64 {
            let s0 = schedule[index - 15].rotate_right(7)
                ^ schedule[index - 15].rotate_right(18)
                ^ (schedule[index - 15] >> 3);
            let s1 = schedule[index - 2].rotate_right(17)
                ^ schedule[index - 2].rotate_right(19)
                ^ (schedule[index - 2] >> 10);
            schedule[index] = schedule[index - 16]
                .wrapping_add(s0)
                .wrapping_add(schedule[index - 7])
                .wrapping_add(s1);
        }

        let [mut a, mut b, mut c, mut d, mut e, mut f, mut g, mut h] = *state;
        for index in 0..64 {
            let choice = (e & f) ^ ((!e) & g);
            let majority = (a & b) ^ (a & c) ^ (b & c);
            let sum1 = e.rotate_right(6) ^ e.rotate_right(11) ^ e.rotate_right(25);
            let sum0 = a.rotate_right(2) ^ a.rotate_right(13) ^ a.rotate_right(22);
            let temp1 = h
                .wrapping_add(sum1)
                .wrapping_add(choice)
                .wrapping_add(SHA256_ROUND_CONSTANTS[index])
                .wrapping_add(schedule[index]);
            let temp2 = sum0.wrapping_add(majority);
            h = g;
            g = f;
            f = e;
            e = d.wrapping_add(temp1);
            d = c;
            c = b;
            b = a;
            a = temp1.wrapping_add(temp2);
        }
        for (slot, value) in state.iter_mut().zip([a, b, c, d, e, f, g, h]) {
            *slot = slot.wrapping_add(value);
        }
    }
}

struct CountingGlobal;

static ALLOC_CALLS: AtomicU64 = AtomicU64::new(0);
static ALLOC_BYTES: AtomicU64 = AtomicU64::new(0);
static CURRENT_BYTES: AtomicU64 = AtomicU64::new(0);
static PEAK_BYTES: AtomicU64 = AtomicU64::new(0);
static PHASE_BASELINE_BYTES: AtomicU64 = AtomicU64::new(0);

#[global_allocator]
static GLOBAL: CountingGlobal = CountingGlobal;

#[inline]
fn record_alloc(bytes: usize) {
    let bytes = bytes as u64;
    ALLOC_CALLS.fetch_add(1, Ordering::Relaxed);
    ALLOC_BYTES.fetch_add(bytes, Ordering::Relaxed);
    let current = CURRENT_BYTES.fetch_add(bytes, Ordering::Relaxed) + bytes;
    let mut peak = PEAK_BYTES.load(Ordering::Relaxed);
    while current > peak {
        match PEAK_BYTES.compare_exchange_weak(peak, current, Ordering::Relaxed, Ordering::Relaxed)
        {
            Ok(_) => break,
            Err(next) => peak = next,
        }
    }
}

unsafe impl GlobalAlloc for CountingGlobal {
    unsafe fn alloc(&self, layout: Layout) -> *mut u8 {
        let ptr = unsafe { System.alloc(layout) };
        if !ptr.is_null() {
            record_alloc(layout.size());
        }
        ptr
    }

    unsafe fn alloc_zeroed(&self, layout: Layout) -> *mut u8 {
        let ptr = unsafe { System.alloc_zeroed(layout) };
        if !ptr.is_null() {
            record_alloc(layout.size());
        }
        ptr
    }

    unsafe fn dealloc(&self, ptr: *mut u8, layout: Layout) {
        CURRENT_BYTES.fetch_sub(layout.size() as u64, Ordering::Relaxed);
        unsafe { System.dealloc(ptr, layout) };
    }

    unsafe fn realloc(&self, ptr: *mut u8, layout: Layout, new_size: usize) -> *mut u8 {
        let next = unsafe { System.realloc(ptr, layout, new_size) };
        if !next.is_null() {
            CURRENT_BYTES.fetch_sub(layout.size() as u64, Ordering::Relaxed);
            record_alloc(new_size);
        }
        next
    }
}

#[derive(Clone, Copy)]
struct AllocationSnapshot {
    calls: u64,
    bytes: u64,
    current: u64,
    peak: u64,
    baseline: u64,
}

fn reset_allocation_phase() {
    ALLOC_CALLS.store(0, Ordering::Relaxed);
    ALLOC_BYTES.store(0, Ordering::Relaxed);
    let current = CURRENT_BYTES.load(Ordering::Relaxed);
    PHASE_BASELINE_BYTES.store(current, Ordering::Relaxed);
    PEAK_BYTES.store(current, Ordering::Relaxed);
}

fn allocation_snapshot() -> AllocationSnapshot {
    AllocationSnapshot {
        calls: ALLOC_CALLS.load(Ordering::Relaxed),
        bytes: ALLOC_BYTES.load(Ordering::Relaxed),
        current: CURRENT_BYTES.load(Ordering::Relaxed),
        peak: PEAK_BYTES.load(Ordering::Relaxed),
        baseline: PHASE_BASELINE_BYTES.load(Ordering::Relaxed),
    }
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Scenario {
    schema_version: u32,
    kind: String,
    id: String,
    suite: String,
    subject: Subject,
    #[serde(rename = "executorRequirements")]
    _executor_requirements: Vec<String>,
    frames: u32,
    tape: InputTape,
    phases: Vec<Phase>,
    checkpoints: Vec<Checkpoint>,
    params: HashMap<String, Value>,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Subject {
    id: String,
    family: String,
    framework: String,
    entry: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct InputTape {
    schema_version: u32,
    kind: String,
    id: String,
    frames: u32,
    tracks: Vec<InputTrack>,
}

#[derive(Deserialize)]
#[serde(tag = "kind", rename_all = "kebab-case", deny_unknown_fields)]
enum InputTrack {
    Button {
        control: String,
        samples: Vec<ButtonSample>,
    },
    Analog {
        control: String,
        samples: Vec<AnalogSample>,
    },
    Touch {
        control: String,
        samples: Vec<TouchSample>,
    },
    RelativeAxis {
        control: String,
        samples: Vec<AxisSample>,
    },
    Effect {
        effect: String,
        samples: Vec<EffectSample>,
    },
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct ButtonSample {
    frame: u32,
    pressed: bool,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct AnalogSample {
    frame: u32,
    value: f64,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct TouchSample {
    frame: u32,
    phase: TouchPhase,
    x: f64,
    y: f64,
}

#[derive(Clone, Copy, Deserialize)]
#[serde(rename_all = "lowercase")]
enum TouchPhase {
    Start,
    Move,
    End,
    Cancel,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct AxisSample {
    frame: u32,
    delta: f64,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct EffectSample {
    frame: u32,
    value: Value,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Phase {
    name: String,
    start_frame: u32,
    end_frame: u32,
    collect: bool,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Checkpoint {
    frame: u32,
    capture: Vec<String>,
}

#[derive(Clone, Default)]
struct FrameInput {
    buttons: u32,
    analog: u32,
    touches: Vec<u32>,
}

struct RenderConfig {
    viewport: (f32, f32),
    width: usize,
    height: usize,
    density: u32,
    scale: u32,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct GuestPhaseRecord<'a> {
    schema_version: u32,
    event: &'static str,
    scenario_id: &'a str,
    phase: &'a str,
    phase_id: u32,
    iteration: u32,
    alloc_calls: u64,
    allocated_bytes: u64,
    current_bytes: u64,
    peak_bytes: u64,
    quickjs_live_bytes_after_gc: u64,
    draw_list_hash: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct GuestComplete<'a> {
    schema_version: u32,
    event: &'static str,
    scenario_id: &'a str,
    suite: &'a str,
    framework: &'a str,
    final_draw_list_hash: String,
    final_state_hash: String,
    effect_hash: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    framebuffer_trace_hash: Option<String>,
}

struct Args {
    scenario: PathBuf,
    bundle: PathBuf,
    pak: Option<PathBuf>,
    framebuffer_out: Option<PathBuf>,
    framebuffer_dir: Option<PathBuf>,
    markers: bool,
    correctness: bool,
}

fn parse_args() -> Result<Args> {
    let mut scenario = None;
    let mut bundle = None;
    let mut pak = None;
    let mut framebuffer_out = None;
    let mut framebuffer_dir = None;
    let mut markers = false;
    let mut correctness = false;
    let mut args = std::env::args().skip(1);
    while let Some(arg) = args.next() {
        match arg.as_str() {
            "--scenario" => scenario = args.next().map(PathBuf::from),
            "--bundle" => bundle = args.next().map(PathBuf::from),
            "--pak" => pak = args.next().map(PathBuf::from),
            "--framebuffer-out" => framebuffer_out = args.next().map(PathBuf::from),
            "--framebuffer-dir" => framebuffer_dir = args.next().map(PathBuf::from),
            "--markers" => markers = true,
            "--correctness" => correctness = true,
            "--help" | "-h" => {
                println!(
                    "usage: pocketjs-perf-guest --scenario FILE --bundle FILE [--pak FILE] [--framebuffer-out FILE] [--framebuffer-dir DIR] [--markers] [--correctness]"
                );
                std::process::exit(0);
            }
            _ => bail!("unknown argument {arg}"),
        }
    }
    Ok(Args {
        scenario: scenario.ok_or_else(|| anyhow!("--scenario is required"))?,
        bundle: bundle.ok_or_else(|| anyhow!("--bundle is required"))?,
        pak,
        framebuffer_out,
        framebuffer_dir,
        markers,
        correctness,
    })
}

fn read_scenario(path: &Path) -> Result<Scenario> {
    let bytes = fs::read(path).with_context(|| format!("reading {}", path.display()))?;
    let scenario: Scenario =
        serde_json::from_slice(&bytes).with_context(|| format!("parsing {}", path.display()))?;
    if scenario.schema_version != 1 || scenario.kind != "pocketjs.perf.scenario" {
        bail!("unsupported scenario schema");
    }
    if scenario.tape.schema_version != 1 || scenario.tape.kind != "pocketjs.perf.input-tape" {
        bail!("unsupported input tape schema");
    }
    if scenario.frames != scenario.tape.frames {
        bail!("scenario/tape frame count mismatch");
    }
    if scenario.frames == 0 {
        bail!("scenario must contain at least one frame");
    }
    if scenario.subject.entry.is_empty()
        || scenario.subject.id.is_empty()
        || scenario.subject.family.is_empty()
        || scenario.tape.id.is_empty()
    {
        bail!("scenario subject and tape identifiers must be non-empty");
    }
    for checkpoint in &scenario.checkpoints {
        if checkpoint.frame >= scenario.frames {
            bail!(
                "checkpoint frame {} is outside the scenario",
                checkpoint.frame
            );
        }
        for capture in &checkpoint.capture {
            if !matches!(
                capture.as_str(),
                "framebuffer" | "drawList" | "state" | "effects"
            ) {
                bail!("unsupported correctness capture {capture}");
            }
        }
    }
    let mut previous_end = 0;
    for phase in &scenario.phases {
        if phase.name.is_empty() {
            bail!("phase names must be non-empty");
        }
        if phase.start_frame >= phase.end_frame || phase.end_frame > scenario.frames {
            bail!(
                "phase {} has invalid range {}..{} for {} frames",
                phase.name,
                phase.start_frame,
                phase.end_frame,
                scenario.frames
            );
        }
        if phase.start_frame < previous_end {
            bail!("phase {} overlaps the preceding phase", phase.name);
        }
        previous_end = phase.end_frame;
    }
    Ok(scenario)
}

fn render_config(scenario: &Scenario) -> Result<RenderConfig> {
    let viewport = scenario.params.get("viewport");
    let field = |name: &str| viewport.and_then(|value| value.get(name));
    let dimension = |name: &str, fallback: u32| -> Result<(f32, usize)> {
        let value = match field(name) {
            Some(value) => value
                .as_u64()
                .and_then(|value| u32::try_from(value).ok())
                .ok_or_else(|| anyhow!("viewport.{name} must be an unsigned integer"))?,
            None => fallback,
        };
        if !(1..=32_000).contains(&value) {
            bail!("viewport.{name} must be in 1..=32000");
        }
        Ok((value as f32, value as usize))
    };
    let integer = |name: &str, fallback: u32, maximum: u32| -> Result<u32> {
        let value = match field(name) {
            Some(value) => value
                .as_u64()
                .and_then(|value| u32::try_from(value).ok())
                .ok_or_else(|| anyhow!("viewport.{name} must be an unsigned integer"))?,
            None => fallback,
        };
        if !(1..=maximum).contains(&value) {
            bail!("viewport.{name} must be in 1..={maximum}");
        }
        Ok(value)
    };
    let (viewport_width, width) = dimension("width", 480)?;
    let (viewport_height, height) = dimension("height", 272)?;
    let density = integer("rasterDensity", 1, u8::MAX as u32)?;
    let scale = integer("renderScale", 1, raster::MAX_RENDER_SCALE)?;
    Ok(RenderConfig {
        viewport: (viewport_width, viewport_height),
        width,
        height,
        density,
        scale,
    })
}

fn button_mask(control: &str) -> Result<u32> {
    Ok(match control {
        "primary" | "circle" => btn::CIRCLE,
        "secondary" | "triangle" => btn::TRIANGLE,
        "tertiary" | "cross" => btn::CROSS,
        "quaternary" | "square" => btn::SQUARE,
        "select" => btn::SELECT,
        "start" => btn::START,
        "up" => btn::UP,
        "right" => btn::RIGHT,
        "down" => btn::DOWN,
        "left" => btn::LEFT,
        "shoulder-left" | "shoulderLeft" | "ltrigger" => btn::LTRIGGER,
        "shoulder-right" | "shoulderRight" | "rtrigger" => btn::RTRIGGER,
        _ => bail!("unknown logical button {control}"),
    })
}

fn contact_id(control: &str) -> Result<u32> {
    let digits = control
        .strip_prefix("contact-")
        .or_else(|| control.strip_prefix("touch-"))
        .unwrap_or(control);
    let id: u32 = digits
        .parse()
        .with_context(|| format!("touch control {control} must end in a numeric contact id"))?;
    if id > 7 {
        bail!("touch contact id {id} is outside 0..7");
    }
    Ok(id)
}

fn logical_coord(value: f64, name: &str) -> Result<u32> {
    if !value.is_finite() || value < 0.0 || value > 511.0 {
        bail!("{name} coordinate {value} is outside 0..511");
    }
    Ok(value.round() as u32)
}

fn analog_byte(value: f64) -> Result<u32> {
    if !value.is_finite() || !(-1.0..=1.0).contains(&value) {
        bail!("analog level {value} is outside -1..1");
    }
    Ok(if value == 0.0 {
        128
    } else if value < 0.0 {
        (128.0 + value * 128.0).round() as u32
    } else {
        (128.0 + value * 127.0).round() as u32
    })
}

fn expand_tape(scenario: &Scenario) -> Result<(Vec<FrameInput>, bool)> {
    let mut button_events = vec![Vec::<(u32, bool)>::new(); scenario.frames as usize];
    let mut analog_events = vec![Vec::<(String, f64)>::new(); scenario.frames as usize];
    let mut touch_events =
        vec![Vec::<(u32, TouchPhase, u32, u32)>::new(); scenario.frames as usize];
    let mut has_touch = false;

    for track in &scenario.tape.tracks {
        match track {
            InputTrack::Button { control, samples } => {
                let mask = button_mask(control)?;
                for sample in samples {
                    let at = button_events
                        .get_mut(sample.frame as usize)
                        .ok_or_else(|| {
                            anyhow!("button sample frame {} is outside the tape", sample.frame)
                        })?;
                    at.push((mask, sample.pressed));
                }
            }
            InputTrack::Analog { control, samples } => {
                for sample in samples {
                    let at = analog_events
                        .get_mut(sample.frame as usize)
                        .ok_or_else(|| {
                            anyhow!("analog sample frame {} is outside the tape", sample.frame)
                        })?;
                    at.push((control.clone(), sample.value));
                }
            }
            InputTrack::Touch { control, samples } => {
                has_touch = true;
                let id = contact_id(control)?;
                for sample in samples {
                    let x = logical_coord(sample.x, "touch x")?;
                    let y = logical_coord(sample.y, "touch y")?;
                    let at = touch_events.get_mut(sample.frame as usize).ok_or_else(|| {
                        anyhow!("touch sample frame {} is outside the tape", sample.frame)
                    })?;
                    let phase = match sample.phase {
                        TouchPhase::Start => TouchPhase::Start,
                        TouchPhase::Move => TouchPhase::Move,
                        TouchPhase::End => TouchPhase::End,
                        TouchPhase::Cancel => TouchPhase::Cancel,
                    };
                    at.push((id, phase, x, y));
                }
            }
            InputTrack::RelativeAxis { control, samples } => {
                if !samples.is_empty() {
                    let _sum = samples.iter().fold(0.0, |sum, sample| {
                        sum + sample.delta + f64::from(sample.frame)
                    });
                    bail!("relative axis {control} requires the Vapor executor");
                }
            }
            InputTrack::Effect { effect, samples } => {
                if !samples.is_empty() {
                    let _observed = samples
                        .iter()
                        .any(|sample| sample.frame < scenario.frames && !sample.value.is_null());
                    bail!("effect delivery {effect} requires a configured effect adapter");
                }
            }
        }
    }

    let mut buttons = 0u32;
    let mut analog_x = 128u32;
    let mut analog_y = 128u32;
    let mut contacts = BTreeMap::<u32, (u32, u32)>::new();
    let mut frames = Vec::with_capacity(scenario.frames as usize);
    for frame in 0..scenario.frames as usize {
        for &(mask, pressed) in &button_events[frame] {
            if pressed {
                buttons |= mask;
            } else {
                buttons &= !mask;
            }
        }
        for (control, value) in &analog_events[frame] {
            if !value.is_finite() {
                bail!("analog sample must be finite");
            }
            match control.as_str() {
                "x" | "horizontal" => analog_x = analog_byte(*value)?,
                "y" | "vertical" => analog_y = analog_byte(*value)?,
                "packed" => {
                    let packed = value.round().clamp(0.0, 65535.0) as u32;
                    analog_x = (packed >> 8) & 0xff;
                    analog_y = packed & 0xff;
                }
                _ => bail!("unknown analog control {control}"),
            }
        }
        for (id, phase, x, y) in &touch_events[frame] {
            match phase {
                TouchPhase::Start | TouchPhase::Move => {
                    contacts.insert(*id, (*x, *y));
                }
                TouchPhase::End | TouchPhase::Cancel => {
                    contacts.remove(id);
                }
            }
        }
        frames.push(FrameInput {
            buttons,
            analog: (analog_x << 8) | analog_y,
            touches: contacts
                .iter()
                .map(|(id, (x, y))| (id << 18) | (y << 9) | x)
                .collect(),
        });
    }
    Ok((frames, has_touch))
}

fn fnv1a64_bytes(bytes: impl IntoIterator<Item = u8>) -> String {
    let mut hash = 0xcbf2_9ce4_8422_2325u64;
    for byte in bytes {
        hash ^= u64::from(byte);
        hash = hash.wrapping_mul(0x0000_0100_0000_01b3);
    }
    format!("fnv1a64:{hash:016x}")
}

fn lowercase_hex(bytes: &[u8]) -> String {
    let mut output = String::with_capacity(bytes.len() * 2);
    for byte in bytes {
        use std::fmt::Write as _;
        write!(&mut output, "{byte:02x}").expect("writing to String cannot fail");
    }
    output
}

fn draw_hash(surface: &UiSurface) -> String {
    surface.with_ui(|ui| {
        fnv1a64_bytes(
            ui.current_draw_list()
                .words
                .iter()
                .flat_map(|word| word.to_le_bytes()),
        )
    })
}

fn frame_with_touch_hits(
    guest: &Guest,
    surface: &UiSurface,
    buttons: u32,
    analog: u32,
    touches: &[u32],
) -> Result<()> {
    // Match the native hosts' frame argument 4 contract: resolve each new
    // contact against the committed bounds tree once, then let Core carry the
    // hit fact until that contact lifts. Keeping this in the perf guest avoids
    // changing production Guest/UiSurface APIs solely for the harness.
    let mut hits = [0i32; 8];
    let hit_count = surface.with_ui(|ui| ui.touch_hits(touches, &mut hits));
    guest.with(|ctx| -> Result<()> {
        let frame: Option<Function> = ctx.globals().get("frame").ok();
        if let Some(frame) = frame {
            let touch_array = Array::new(ctx.clone())
                .map_err(|error| anyhow!("allocating benchmark touch array: {error}"))?;
            for (index, touch) in touches.iter().enumerate() {
                touch_array
                    .set(index, *touch)
                    .map_err(|error| anyhow!("setting benchmark touch {index}: {error}"))?;
            }
            let hit_array = Array::new(ctx.clone())
                .map_err(|error| anyhow!("allocating benchmark touch-hit array: {error}"))?;
            for (index, hit) in hits[..hit_count].iter().enumerate() {
                hit_array
                    .set(index, *hit)
                    .map_err(|error| anyhow!("setting benchmark touch hit {index}: {error}"))?;
            }
            frame
                .call::<_, ()>((buttons, analog, touch_array, hit_array))
                .catch(&ctx)
                .map_err(|error| anyhow!("benchmark frame() threw: {error}"))?;
        }
        Ok(())
    })?;
    guest.drain_jobs();
    Ok(())
}

fn render_frame(surface: &UiSurface, framebuffer: &mut [u8], scale: u32) {
    surface.with_ui(|ui| {
        // `draw()` returns storage owned by `ui`; rasterization only reads the
        // DrawList plus texture/font resources from that same Ui. This is the
        // same single-threaded reborrow used by the WASM host renderer.
        let draw_list: *const pocketjs_core::DrawList = ui.draw();
        let ui_ref = unsafe { &*(ui as *const pocketjs_core::Ui) };
        unsafe {
            raster::render_scaled(ui_ref, &(*draw_list).words, framebuffer, scale);
        }
    });
}

fn write_checkpoint_framebuffer(
    scenario: &Scenario,
    frame: u32,
    directory: Option<&Path>,
    framebuffer: &[u8],
) -> Result<()> {
    let Some(directory) = directory else {
        return Ok(());
    };
    let captures_framebuffer = scenario.checkpoints.iter().any(|checkpoint| {
        checkpoint.frame == frame
            && checkpoint
                .capture
                .iter()
                .any(|capture| capture == "framebuffer")
    });
    if !captures_framebuffer {
        return Ok(());
    }
    let path = directory.join(format!("{frame}.rgba"));
    fs::write(&path, framebuffer)
        .with_context(|| format!("writing correctness checkpoint {}", path.display()))
}

fn install_correctness_probes(guest: &Guest) -> Result<()> {
    guest
        .eval(
            "pocketjs-perf-probes",
            r#"
globalThis.__pocketPerfMessages = [];
globalThis.__pocketPerfInbox = [];
globalThis.__pocketDevtoolsTransport = {
  send(line) { globalThis.__pocketPerfMessages.push(String(line)); },
  recv() {
    return globalThis.__pocketPerfInbox.length > 0
      ? globalThis.__pocketPerfInbox.shift()
      : null;
  },
};
globalThis.__pocketPerfEffects = [];
globalThis.__pocketEffectTrace = (event) => {
  globalThis.__pocketPerfEffects.push(event);
};
"#,
        )
        .context("installing benchmark correctness probes")
}

fn effect_snapshot(guest: &Guest) -> Result<(String, String)> {
    let effects = guest
        .with(|ctx| ctx.eval::<String, _>(b"JSON.stringify(globalThis.__pocketPerfEffects)"))
        .context("serializing benchmark effect trace")?;
    Ok((fnv1a64_bytes(effects.bytes()), effects))
}

fn capture_state_snapshot(guest: &Guest, surface: &UiSurface) -> Result<(String, String)> {
    guest
        .with(|ctx| {
            ctx.eval::<(), _>(
                b"void globalThis.__pocketPerfInbox.push(JSON.stringify({t:'getTree'}))",
            )
        })
        .context("requesting final DevTools tree")?;
    // Match the Native correctness adapter: service the request in one extra
    // unmeasured frame, then advance Core once. This work is outside every
    // marker and cannot affect performance counters.
    guest.frame_with_analog(0, 0x8080)?;
    surface.tick();
    let state = guest
        .with(|ctx| {
            ctx.eval::<String, _>(
                br#"
(() => {
  const lines = globalThis.__pocketPerfMessages;
  for (let i = lines.length - 1; i >= 0; i--) {
    const message = JSON.parse(lines[i]);
    if (message && message.t === 'tree') return JSON.stringify(message.root);
  }
  throw new Error('benchmark DevTools tree response is missing');
})()
"#,
            )
        })
        .context("reading final DevTools tree")?;
    Ok((fnv1a64_bytes(state.bytes()), state))
}

fn phase_id(scenario: &str, phase: &str) -> u32 {
    let mut hash = 0x811c_9dc5u32;
    for byte in scenario.bytes().chain([0]).chain(phase.bytes()) {
        hash ^= u32::from(byte);
        hash = hash.wrapping_mul(0x0100_0193);
    }
    hash
}

fn marker(enabled: bool, opcode: u32, id: u32) -> Result<()> {
    if !enabled {
        return Ok(());
    }
    let packed = (MARKER_VERSION << 8) | opcode;
    #[cfg(target_os = "linux")]
    let result = unsafe {
        libc::syscall(
            MARKER_SYSCALL as libc::c_long,
            MARKER_MAGIC as libc::c_long,
            packed as libc::c_long,
            id as libc::c_long,
            0 as libc::c_long,
            MARKER_COOKIE as libc::c_long,
            0 as libc::c_long,
        )
    } as i64;
    #[cfg(not(target_os = "linux"))]
    let result = unsafe {
        libc::syscall(
            MARKER_SYSCALL as libc::c_int,
            MARKER_MAGIC as libc::c_long,
            packed as libc::c_long,
            id as libc::c_long,
            0 as libc::c_long,
            MARKER_COOKIE as libc::c_long,
            0 as libc::c_long,
        )
    } as i64;
    if result != 0 {
        bail!("QEMU marker rejected opcode {opcode}, phase {id}: return {result}");
    }
    Ok(())
}

fn print_json(value: &impl Serialize) -> Result<()> {
    println!("{GUEST_PREFIX}{}", serde_json::to_string(value)?);
    Ok(())
}

fn quickjs_live_bytes_after_gc(guest: &Guest) -> u64 {
    guest.with(|ctx| {
        ctx.run_gc();
        let mut usage = MaybeUninit::<pocket_mod::qjs::qjs::JSMemoryUsage>::uninit();
        unsafe {
            let runtime = pocket_mod::qjs::qjs::JS_GetRuntime(ctx.as_raw().as_ptr());
            pocket_mod::qjs::qjs::JS_ComputeMemoryUsage(runtime, usage.as_mut_ptr());
            usage.assume_init().memory_used_size.max(0) as u64
        }
    })
}

fn finish_phase(
    scenario: &Scenario,
    phase_name: &str,
    id: u32,
    allocation: AllocationSnapshot,
    guest: &Guest,
    surface: &UiSurface,
) -> Result<()> {
    print_json(&GuestPhaseRecord {
        schema_version: 1,
        event: "phase",
        scenario_id: &scenario.id,
        phase: phase_name,
        phase_id: id,
        iteration: 0,
        alloc_calls: allocation.calls,
        allocated_bytes: allocation.bytes,
        current_bytes: allocation.current,
        peak_bytes: allocation.peak.saturating_sub(allocation.baseline),
        quickjs_live_bytes_after_gc: quickjs_live_bytes_after_gc(guest),
        draw_list_hash: draw_hash(surface),
    })
}

fn main() -> Result<()> {
    let args = parse_args()?;
    if (args.framebuffer_out.is_some() || args.framebuffer_dir.is_some()) && !args.correctness {
        bail!("framebuffer output is only valid with --correctness");
    }
    if args.correctness && args.markers {
        bail!("--correctness and --markers are separate replays");
    }
    let scenario = read_scenario(&args.scenario)?;
    let render = render_config(&scenario)?;
    if let Some(directory) = &args.framebuffer_dir {
        fs::create_dir_all(directory).with_context(|| {
            format!(
                "creating correctness framebuffer directory {}",
                directory.display()
            )
        })?;
    }
    let (inputs, has_touch) = expand_tape(&scenario)?;
    let bundle = fs::read_to_string(&args.bundle)
        .with_context(|| format!("reading {}", args.bundle.display()))?;
    let pak = match &args.pak {
        Some(path) => fs::read(path).with_context(|| format!("reading {}", path.display()))?,
        None => Vec::new(),
    };

    let measure_boot = scenario
        .params
        .get("measureBoot")
        .and_then(Value::as_bool)
        .unwrap_or(false);

    let runtime_phase = "runtime-init";
    let runtime_phase_id = phase_id(&scenario.id, runtime_phase);
    if measure_boot {
        reset_allocation_phase();
        marker(args.markers, MARKER_BEGIN, runtime_phase_id)?;
    }
    let guest = Guest::new().context("creating QuickJS guest")?;
    let surface = UiSurface::new_with_density(render.viewport, render.density);
    // Allocate once; the measured frame loop includes raster work but never
    // pays a diagnostic framebuffer growth/allocation cost.
    let framebuffer_bytes = render
        .width
        .checked_mul(render.scale as usize)
        .and_then(|width| {
            render
                .height
                .checked_mul(render.scale as usize)
                .and_then(|height| width.checked_mul(height))
        })
        .and_then(|pixels| pixels.checked_mul(4))
        .ok_or_else(|| anyhow!("scaled framebuffer dimensions overflow"))?;
    let mut framebuffer = vec![0; framebuffer_bytes];
    if !pak.is_empty() {
        surface.feed_pak(&pak);
    }
    surface.mount(&guest).context("mounting ui surface")?;
    if measure_boot {
        let allocation = allocation_snapshot();
        marker(args.markers, MARKER_END, runtime_phase_id)?;
        finish_phase(
            &scenario,
            runtime_phase,
            runtime_phase_id,
            allocation,
            &guest,
            &surface,
        )?;
    }
    // Only the independent correctness replay installs observational JS
    // hooks. Even a trace-array push would otherwise change the instruction
    // and allocation counts of the measurement replay.
    if args.correctness {
        install_correctness_probes(&guest)?;
    }

    let eval_phase = "bundle-eval";
    let eval_phase_id = phase_id(&scenario.id, eval_phase);
    if measure_boot {
        reset_allocation_phase();
        marker(args.markers, MARKER_BEGIN, eval_phase_id)?;
    }
    guest
        .eval(&scenario.subject.entry, &bundle)
        .context("evaluating app bundle")?;
    if measure_boot {
        let allocation = allocation_snapshot();
        marker(args.markers, MARKER_END, eval_phase_id)?;
        finish_phase(
            &scenario,
            eval_phase,
            eval_phase_id,
            allocation,
            &guest,
            &surface,
        )?;
    }

    let mut active: Option<(&Phase, u32)> = None;
    // Native correctness hashes every raw RGBA frame, writes each lowercase
    // frame digest into a second SHA-256 stream, and finally digests that
    // stream. Keep the identical operation entirely out of the measurement
    // replay so it cannot affect marker counters or allocation samples.
    let mut framebuffer_trace = args.correctness.then(Sha256::new);
    for (frame_index, input) in inputs.iter().enumerate() {
        let frame = frame_index as u32;
        if let Some(phase) = scenario
            .phases
            .iter()
            .find(|phase| phase.collect && phase.start_frame == frame)
        {
            if active.is_some() {
                bail!("overlapping collected phases are not supported");
            }
            let id = phase_id(&scenario.id, &phase.name);
            reset_allocation_phase();
            marker(args.markers, MARKER_BEGIN, id)?;
            active = Some((phase, id));
        }

        if has_touch {
            frame_with_touch_hits(
                &guest,
                &surface,
                input.buttons,
                input.analog,
                &input.touches,
            )?;
        } else {
            guest.frame_with_analog(input.buttons, input.analog)?;
        }
        surface.tick();
        render_frame(&surface, &mut framebuffer, render.scale);
        if let Some(trace) = framebuffer_trace.as_mut() {
            let frame_hash = Sha256::digest(&framebuffer);
            let frame_hash_hex = lowercase_hex(&frame_hash);
            trace.update(frame_hash_hex.as_bytes());
        }
        if args.correctness {
            write_checkpoint_framebuffer(
                &scenario,
                frame,
                args.framebuffer_dir.as_deref(),
                &framebuffer,
            )?;
        }

        if let Some((phase, id)) = active {
            if phase.end_frame == frame + 1 {
                let allocation = allocation_snapshot();
                marker(args.markers, MARKER_END, id)?;
                finish_phase(&scenario, &phase.name, id, allocation, &guest, &surface)?;
                active = None;
            }
        }
    }
    if let Some((phase, _)) = active {
        bail!("phase {} did not close", phase.name);
    }

    if let Some(path) = &args.framebuffer_out {
        fs::write(path, &framebuffer)
            .with_context(|| format!("writing correctness framebuffer {}", path.display()))?;
    }
    let final_draw_list_hash = draw_hash(&surface);
    let (final_state_hash, effect_hash) = if args.correctness {
        let (effects_hash, effects_json) = effect_snapshot(&guest)?;
        let (state_hash, state_json) = capture_state_snapshot(&guest, &surface)?;
        if let Some(directory) = &args.framebuffer_dir {
            fs::write(directory.join("effects.json"), effects_json)
                .context("writing correctness effect trace")?;
            fs::write(directory.join("state.json"), state_json)
                .context("writing correctness state tree")?;
        }
        (state_hash, effects_hash)
    } else {
        // The bridge discards these two sentinels from the measurement replay
        // and combines its phase/allocation records with the independent
        // correctness replay's complete record.
        (
            fnv1a64_bytes(b"measurement-replay-state".iter().copied()),
            fnv1a64_bytes(b"measurement-replay-effects".iter().copied()),
        )
    };
    let framebuffer_trace_hash = framebuffer_trace.map(|trace| lowercase_hex(&trace.finalize()));
    print_json(&GuestComplete {
        schema_version: 1,
        event: "complete",
        scenario_id: &scenario.id,
        suite: &scenario.suite,
        framework: &scenario.subject.framework,
        final_draw_list_hash,
        final_state_hash,
        effect_hash,
        framebuffer_trace_hash,
    })?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::{Sha256, fill_deterministic_random, lowercase_hex};

    fn sha256(bytes: &[u8]) -> String {
        lowercase_hex(&Sha256::digest(bytes))
    }

    #[test]
    fn sha256_matches_standard_vectors() {
        assert_eq!(
            sha256(b""),
            "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855"
        );
        assert_eq!(
            sha256(b"abc"),
            "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad"
        );
        assert_eq!(
            sha256(b"abcdbcdecdefdefgefghfghighijhijkijkljklmklmnlmnomnopnopq"),
            "248d6a61d20638b8e5c026930c3e6039a33ce45964ff2167f6ecedd419db06c1"
        );
    }

    #[test]
    fn sha256_streaming_matches_one_shot_across_block_boundaries() {
        let bytes = (0..257).map(|value| value as u8).collect::<Vec<_>>();
        let expected = Sha256::digest(&bytes);
        let mut streaming = Sha256::new();
        for chunk in bytes.chunks(13) {
            streaming.update(chunk);
        }
        assert_eq!(streaming.finalize(), expected);
    }

    #[test]
    fn benchmark_random_stream_is_nonzero_and_call_indexed() {
        let mut first = [0; 16];
        let mut repeated = [0; 16];
        let mut second = [0; 16];
        fill_deterministic_random(0, &mut first);
        fill_deterministic_random(0, &mut repeated);
        fill_deterministic_random(1, &mut second);

        assert_eq!(first, repeated);
        assert_ne!(first, [0; 16]);
        assert_ne!(first, second);
        assert_eq!(first[..4], [0x53, 0x54, 0x55, 0x56]);
        assert_eq!(second[..4], [0xf0, 0xf1, 0xf2, 0xf3]);
    }
}
