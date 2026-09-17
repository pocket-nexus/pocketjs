use std::alloc::{GlobalAlloc, Layout, System};
use std::collections::BTreeMap;
use std::env;
use std::fs;
use std::path::PathBuf;
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::Instant;

use pocketjs_core::Ui;
use pocketjs_core::damage::{DEFAULT_DAMAGE_REGIONS, DamagePlan, DamagePolicy, DamageTracker};
use pocketjs_core::raster;
use pocketjs_core::spec::{self, draw_op};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

const DAMAGE_PREFIX: &str = "POCKETJS_PERF_DAMAGE ";
const GUEST_PREFIX: &str = "POCKETJS_PERF_GUEST ";
const WIDTH: usize = 96;
const HEIGHT: usize = 64;
const SCALE: u32 = 1;

#[cfg(target_os = "linux")]
const MARKER_SYSCALL: u32 = 4096;
#[cfg(target_os = "linux")]
const MARKER_MAGIC: u32 = 0x504a_424d;
#[cfg(target_os = "linux")]
const MARKER_VERSION: u32 = 1;
#[cfg(target_os = "linux")]
const MARKER_COOKIE: u32 = 0xc001_c0de;
const MARKER_BEGIN: u32 = 1;
const MARKER_END: u32 = 2;

const EXPECTED_PHASES: [&str; 8] = [
    "single-small",
    "corner-touch",
    "overlap",
    "eight-sparse",
    "structural",
    "clip-transform",
    "texture-in-place",
    "settle",
];

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
    executor_requirements: Vec<String>,
    frames: u32,
    tape: serde_json::Value,
    phases: Vec<Phase>,
    checkpoints: Vec<Checkpoint>,
    params: serde_json::Value,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Subject {
    id: String,
    family: String,
    framework: String,
    entry: String,
}

#[derive(Clone, Deserialize)]
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

#[derive(Clone, Copy, PartialEq, Eq)]
enum Mode {
    Correctness,
    Measurement,
    Markers,
}

struct Args {
    scenario: PathBuf,
    mode: Mode,
}

fn parse_args() -> Result<Args, String> {
    let mut scenario = None;
    let mut mode = None;
    let mut args = env::args().skip(1);
    while let Some(arg) = args.next() {
        match arg.as_str() {
            "--scenario" => scenario = args.next().map(PathBuf::from),
            "--correctness" => set_mode(&mut mode, Mode::Correctness)?,
            "--measurement" => set_mode(&mut mode, Mode::Measurement)?,
            "--markers" => set_mode(&mut mode, Mode::Markers)?,
            "--help" | "-h" => {
                println!(
                    "usage: pocketjs-perf-damage --scenario FILE (--correctness|--measurement|--markers)"
                );
                std::process::exit(0);
            }
            _ => return Err(format!("unknown argument {arg}")),
        }
    }
    Ok(Args {
        scenario: scenario.ok_or_else(|| "--scenario is required".to_string())?,
        mode: mode.ok_or_else(|| {
            "exactly one of --correctness, --measurement, or --markers is required".to_string()
        })?,
    })
}

fn set_mode(slot: &mut Option<Mode>, next: Mode) -> Result<(), String> {
    if slot.replace(next).is_some() {
        return Err("mode flags are mutually exclusive".to_string());
    }
    Ok(())
}

fn read_scenario(path: &PathBuf) -> Result<Scenario, String> {
    let bytes = fs::read(path).map_err(|error| format!("reading {}: {error}", path.display()))?;
    let scenario: Scenario = serde_json::from_slice(&bytes)
        .map_err(|error| format!("parsing {}: {error}", path.display()))?;
    validate_scenario(&scenario)?;
    Ok(scenario)
}

fn validate_scenario(scenario: &Scenario) -> Result<(), String> {
    if scenario.schema_version != 1 || scenario.kind != "pocketjs.perf.scenario" {
        return Err("unsupported scenario schema".to_string());
    }
    if scenario.subject.family != "core-lab" || scenario.subject.framework != "core" {
        return Err(
            "damage fixture requires subject family core-lab and framework core".to_string(),
        );
    }
    if scenario.subject.id != "core-damage-lab"
        || scenario.subject.entry != "tools/perf/fixtures/core-damage-lab"
    {
        return Err("damage fixture received an unknown subject".to_string());
    }
    if scenario.frames == 0 || scenario.phases.len() != EXPECTED_PHASES.len() {
        return Err("damage fixture requires all eight non-empty phases".to_string());
    }
    let mut previous_end = 0;
    for (index, phase) in scenario.phases.iter().enumerate() {
        if phase.name != EXPECTED_PHASES[index] {
            return Err(format!(
                "damage phase {index} must be {}, got {}",
                EXPECTED_PHASES[index], phase.name
            ));
        }
        if !phase.collect
            || phase.start_frame != previous_end
            || phase.end_frame <= phase.start_frame
        {
            return Err(format!(
                "damage phase {} must be collected and contiguous",
                phase.name
            ));
        }
        previous_end = phase.end_frame;
    }
    if previous_end != scenario.frames {
        return Err("damage phases must cover every scenario frame".to_string());
    }
    for checkpoint in &scenario.checkpoints {
        if checkpoint.frame >= scenario.frames {
            return Err(format!(
                "checkpoint {} is outside the scenario",
                checkpoint.frame
            ));
        }
        for capture in &checkpoint.capture {
            if !matches!(
                capture.as_str(),
                "framebuffer" | "drawList" | "state" | "effects"
            ) {
                return Err(format!("unsupported correctness capture {capture}"));
            }
        }
    }
    // Deserializing these fields is deliberate: malformed manifests must not
    // turn into a valid-looking benchmark merely because this fixture ignores input.
    if !scenario.tape.is_object() || !scenario.params.is_object() {
        return Err("damage tape and params must be objects".to_string());
    }
    if !scenario
        .executor_requirements
        .iter()
        .any(|item| item == "fixture.core.damage")
    {
        return Err("damage scenario is missing fixture.core.damage".to_string());
    }
    Ok(())
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct PhaseStats {
    name: String,
    frames: u32,
    full_redraw_frames: u32,
    empty_frames: u32,
    max_regions: usize,
    total_damage_area: u64,
}

impl PhaseStats {
    fn new(name: &str) -> Self {
        Self {
            name: name.to_string(),
            frames: 0,
            full_redraw_frames: 0,
            empty_frames: 0,
            max_regions: 0,
            total_damage_area: 0,
        }
    }

    fn observe<const N: usize>(&mut self, plan: &DamagePlan<N>) {
        self.frames += 1;
        self.full_redraw_frames += u32::from(plan.is_full_redraw());
        self.empty_frames += u32::from(plan.is_empty());
        self.max_regions = self.max_regions.max(plan.region_count());
        self.total_damage_area = self.total_damage_area.saturating_add(plan.area());
    }
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct CorrectnessRecord {
    schema_version: u32,
    event: &'static str,
    scenario_id: String,
    framebuffer_trace_hash: String,
    final_framebuffer_hash: String,
    draw_list_hash: String,
    state_hash: String,
    effect_hash: String,
    checkpoints: BTreeMap<String, BTreeMap<String, String>>,
    phase_stats: Vec<PhaseStats>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct PhaseTiming {
    name: String,
    start_frame: u32,
    end_frame: u32,
    wall_time_ns: u64,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct MeasurementRecord {
    schema_version: u32,
    event: &'static str,
    scenario_id: String,
    boot_wall_time_ns: u64,
    phases: Vec<PhaseTiming>,
    final_framebuffer_hash: String,
    final_draw_list_hash: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct GuestPhaseRecord {
    schema_version: u32,
    event: &'static str,
    scenario_id: String,
    phase: String,
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
struct GuestCompleteRecord {
    schema_version: u32,
    event: &'static str,
    scenario_id: String,
    suite: String,
    framework: String,
    final_draw_list_hash: String,
    final_state_hash: String,
    effect_hash: String,
}

struct Fixture {
    ui: Ui,
    tracker: DamageTracker<DEFAULT_DAMAGE_REGIONS>,
    framebuffer: Vec<u8>,
    words: Vec<u32>,
    texture: i32,
    palette: [u8; 1024],
    pixels: [u8; 64],
}

impl Fixture {
    fn new() -> Result<Self, String> {
        let mut ui = Ui::new();
        ui.set_viewport(WIDTH as f32, HEIGHT as f32);
        let mut palette = [0u8; 1024];
        for index in 0..256usize {
            let color = 0xff00_0000u32
                | ((index as u32) << 16)
                | (((255 - index) as u32) << 8)
                | (index as u32 / 2);
            palette[index * 4..index * 4 + 4].copy_from_slice(&color.to_le_bytes());
        }
        let mut pixels = [0u8; 64];
        for (index, pixel) in pixels.iter_mut().enumerate() {
            *pixel = index as u8;
        }
        let mut texture_data = Vec::with_capacity(palette.len() + pixels.len());
        texture_data.extend_from_slice(&palette);
        texture_data.extend_from_slice(&pixels);
        let texture = ui.upload_texture(&texture_data, 8, 8, spec::psm::PSM_T8);
        if texture < 0 {
            return Err("core rejected the fixture texture".to_string());
        }
        Ok(Self {
            ui,
            tracker: DamageTracker::new(),
            framebuffer: vec![0; WIDTH * HEIGHT * 4],
            words: Vec::with_capacity(64),
            texture,
            palette,
            pixels,
        })
    }

    fn render_frame(
        &mut self,
        phase_name: &str,
        local_frame: u32,
    ) -> Result<DamagePlan<DEFAULT_DAMAGE_REGIONS>, String> {
        self.build_draw_list(phase_name, local_frame)?;
        raster::render_scaled_incremental(
            &self.ui,
            &self.words,
            &mut self.framebuffer,
            SCALE,
            &mut self.tracker,
            DamagePolicy::new(100),
        )
        .map_err(|error| format!("damage planning failed in {phase_name}: {error:?}"))
    }

    fn build_draw_list(&mut self, phase: &str, frame: u32) -> Result<(), String> {
        self.words.clear();
        push_rect(
            &mut self.words,
            0,
            0,
            WIDTH as u16,
            HEIGHT as u16,
            0xff18_1008,
        );
        let alternate = frame & 1;
        match phase {
            "single-small" => {
                push_rect(
                    &mut self.words,
                    8 + (frame % 3) as i16,
                    8,
                    5,
                    5,
                    if alternate == 0 {
                        0xff44_ccff
                    } else {
                        0xffff_8844
                    },
                );
            }
            "corner-touch" => {
                push_rect(&mut self.words, 12, 12, 4, 4, phase_color(alternate, 0));
                push_rect(&mut self.words, 16, 16, 4, 4, phase_color(alternate, 1));
            }
            "overlap" => {
                push_rect(&mut self.words, 20, 16, 10, 8, phase_color(alternate, 0));
                push_rect(&mut self.words, 25, 20, 10, 8, phase_color(alternate, 1));
            }
            "eight-sparse" => {
                for index in 0..8u32 {
                    let x = 5 + (index % 4) as i16 * 22;
                    let y = 7 + (index / 4) as i16 * 30;
                    push_rect(&mut self.words, x, y, 4, 4, phase_color(alternate, index));
                }
            }
            "structural" => {
                if alternate == 0 {
                    push_rect(&mut self.words, 18, 14, 22, 13, 0xff40_a0e0);
                } else {
                    push_gradient(&mut self.words, 18, 14, 22, 13, 0xff40_a0e0, 0xffe0_6040);
                    push_rect(&mut self.words, 48, 22, 9, 9, 0xff70_d060);
                }
            }
            "clip-transform" => {
                let shift = (frame % 5) as i16;
                push_scissor(&mut self.words, 11 + shift, 10, 34, 24);
                push_rect(
                    &mut self.words,
                    4 + shift,
                    5,
                    48,
                    34,
                    phase_color(alternate, 3),
                );
                self.words.push(draw_op::SCISSOR_POP);
            }
            "texture-in-place" => {
                for (index, pixel) in self.pixels.iter_mut().enumerate() {
                    *pixel = ((index as u32 + frame * 7) & 0xff) as u8;
                }
                self.palette[0..4].copy_from_slice(
                    &(if alternate == 0 {
                        0xff20_e080u32
                    } else {
                        0xffe0_4080u32
                    })
                    .to_le_bytes(),
                );
                if !self
                    .ui
                    .update_texture_t8(self.texture, &self.palette, &self.pixels)
                {
                    return Err("core rejected an in-place T8 texture update".to_string());
                }
                push_texture(&mut self.words, self.texture, 32, 18, 24, 24);
            }
            "settle" => {
                push_rect(&mut self.words, 36, 20, 18, 12, 0xff60_c080);
            }
            _ => return Err(format!("unknown damage phase {phase}")),
        }
        Ok(())
    }

    fn verify_full_render(&self) -> Result<(), String> {
        let mut full = vec![0; self.framebuffer.len()];
        raster::render_scaled(&self.ui, &self.words, &mut full, SCALE);
        if full != self.framebuffer {
            return Err("incremental framebuffer differs from a full software render".to_string());
        }
        Ok(())
    }
}

fn phase_color(alternate: u32, seed: u32) -> u32 {
    if alternate == 0 {
        0xff20_80d0u32.wrapping_add(seed.wrapping_mul(0x0008_1107))
    } else {
        0xffd0_7020u32.wrapping_sub(seed.wrapping_mul(0x0007_0905))
    }
}

fn xy_word(x: i16, y: i16) -> u32 {
    x as u16 as u32 | ((y as u16 as u32) << 16)
}

fn wh_word(w: u16, h: u16) -> u32 {
    w as u32 | ((h as u32) << 16)
}

fn push_rect(words: &mut Vec<u32>, x: i16, y: i16, w: u16, h: u16, color: u32) {
    words.extend_from_slice(&[draw_op::RECT, xy_word(x, y), wh_word(w, h), color]);
}

fn push_gradient(words: &mut Vec<u32>, x: i16, y: i16, w: u16, h: u16, from: u32, to: u32) {
    words.extend_from_slice(&[
        draw_op::GRAD_RECT,
        xy_word(x, y),
        wh_word(w, h),
        from,
        to,
        spec::GradDir::ToRight as u32,
    ]);
}

fn push_scissor(words: &mut Vec<u32>, x: i16, y: i16, w: u16, h: u16) {
    words.extend_from_slice(&[draw_op::SCISSOR, xy_word(x, y), wh_word(w, h)]);
}

fn push_texture(words: &mut Vec<u32>, texture: i32, x: i16, y: i16, w: u16, h: u16) {
    words.extend_from_slice(&[
        draw_op::TEX_QUAD,
        texture as u32,
        xy_word(x, y),
        wh_word(w, h),
        0.0f32.to_bits(),
        0.0f32.to_bits(),
        1.0f32.to_bits(),
        1.0f32.to_bits(),
        0xffff_ffff,
    ]);
}

fn phase_for_frame(scenario: &Scenario, frame: u32) -> (&Phase, u32) {
    let phase = scenario
        .phases
        .iter()
        .find(|phase| phase.start_frame <= frame && frame < phase.end_frame)
        .expect("validated phases cover all frames");
    (phase, frame - phase.start_frame)
}

fn phase_id(scenario: &str, phase: &str) -> u32 {
    let mut hash = 0x811c_9dc5u32;
    for byte in scenario.bytes().chain([0]).chain(phase.bytes()) {
        hash ^= u32::from(byte);
        hash = hash.wrapping_mul(0x0100_0193);
    }
    hash
}

fn marker(opcode: u32, id: u32) -> Result<(), String> {
    #[cfg(target_os = "linux")]
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
    let result = -1i64;
    if result != 0 {
        return Err(format!(
            "QEMU marker rejected opcode {opcode}, phase {id}: return {result}"
        ));
    }
    Ok(())
}

fn sha256(bytes: &[u8]) -> String {
    hex_digest(Sha256::digest(bytes).as_slice())
}

fn hex_digest(bytes: &[u8]) -> String {
    let mut output = String::with_capacity(bytes.len() * 2);
    for byte in bytes {
        use std::fmt::Write as _;
        write!(&mut output, "{byte:02x}").expect("writing to String cannot fail");
    }
    output
}

fn fnv1a64(bytes: impl IntoIterator<Item = u8>) -> String {
    let mut hash = 0xcbf2_9ce4_8422_2325u64;
    for byte in bytes {
        hash ^= u64::from(byte);
        hash = hash.wrapping_mul(0x0000_0100_0000_01b3);
    }
    format!("fnv1a64:{hash:016x}")
}

fn draw_hash(words: &[u32]) -> String {
    fnv1a64(words.iter().flat_map(|word| word.to_le_bytes()))
}

fn phase_state_bytes(stats: &[PhaseStats]) -> Result<Vec<u8>, String> {
    serde_json::to_vec(stats).map_err(|error| format!("serializing damage state: {error}"))
}

fn validate_stats(stats: &[PhaseStats]) -> Result<(), String> {
    let stat = |name: &str| {
        stats
            .iter()
            .find(|item| item.name == name)
            .expect("phase stats contain all validated phases")
    };
    for item in stats {
        if item.frames == 0 {
            return Err(format!("damage phase {} did not execute", item.name));
        }
    }
    if stat("single-small").max_regions != 1 {
        return Err("single-small did not stay within one damage region".to_string());
    }
    if stat("corner-touch").max_regions != 1 {
        return Err("corner-touch regions were not merged".to_string());
    }
    if stat("overlap").max_regions != 1 {
        return Err("overlap regions were not merged".to_string());
    }
    if stat("eight-sparse").max_regions != DEFAULT_DAMAGE_REGIONS {
        return Err("eight-sparse did not exercise all damage slots".to_string());
    }
    let structural = stat("structural");
    if structural.full_redraw_frames + 1 < structural.frames {
        return Err("structural did not force full redraws".to_string());
    }
    let texture = stat("texture-in-place");
    if texture.full_redraw_frames != texture.frames {
        return Err("texture-in-place did not invalidate every retained frame".to_string());
    }
    let settle = stat("settle");
    if settle.empty_frames + 1 < settle.frames {
        return Err("settle did not converge to empty damage".to_string());
    }
    Ok(())
}

fn run_correctness(scenario: &Scenario) -> Result<(), String> {
    let mut fixture = Fixture::new()?;
    let mut trace = Sha256::new();
    let mut stats = scenario
        .phases
        .iter()
        .map(|phase| PhaseStats::new(&phase.name))
        .collect::<Vec<_>>();
    let mut checkpoints = BTreeMap::<String, BTreeMap<String, String>>::new();

    for frame in 0..scenario.frames {
        let (phase, local_frame) = phase_for_frame(scenario, frame);
        let plan = fixture.render_frame(&phase.name, local_frame)?;
        fixture.verify_full_render()?;
        stats
            .iter_mut()
            .find(|item| item.name == phase.name)
            .expect("phase stat exists")
            .observe(&plan);
        let frame_hash = Sha256::digest(&fixture.framebuffer);
        trace.update(frame_hash);
        let framebuffer_hash = hex_digest(frame_hash.as_slice());
        let current_draw_hash = draw_hash(&fixture.words);
        if let Some(checkpoint) = scenario.checkpoints.iter().find(|item| item.frame == frame) {
            let mut captures = BTreeMap::new();
            for capture in &checkpoint.capture {
                match capture.as_str() {
                    "framebuffer" => {
                        captures.insert("framebuffer".to_string(), framebuffer_hash.clone());
                    }
                    "drawList" => {
                        captures.insert("drawList".to_string(), current_draw_hash.clone());
                    }
                    "effects" => {
                        captures.insert("effects".to_string(), sha256(b"[]"));
                    }
                    "state" => {}
                    _ => unreachable!("checkpoint captures were validated"),
                }
            }
            checkpoints.insert(frame.to_string(), captures);
        }
    }

    validate_stats(&stats)?;
    let state_bytes = phase_state_bytes(&stats)?;
    let state_hash = sha256(&state_bytes);
    if let Some(final_checkpoint) = checkpoints.get_mut(&(scenario.frames - 1).to_string()) {
        if scenario
            .checkpoints
            .iter()
            .find(|item| item.frame == scenario.frames - 1)
            .is_some_and(|item| item.capture.iter().any(|capture| capture == "state"))
        {
            final_checkpoint.insert("state".to_string(), state_hash.clone());
        }
    }
    let record = CorrectnessRecord {
        schema_version: 1,
        event: "correctness",
        scenario_id: scenario.id.clone(),
        framebuffer_trace_hash: hex_digest(trace.finalize().as_slice()),
        final_framebuffer_hash: sha256(&fixture.framebuffer),
        draw_list_hash: draw_hash(&fixture.words),
        state_hash,
        effect_hash: sha256(b"[]"),
        checkpoints,
        phase_stats: stats,
    };
    println!(
        "{DAMAGE_PREFIX}{}",
        serde_json::to_string(&record).map_err(|error| error.to_string())?
    );
    Ok(())
}

fn run_measurement(scenario: &Scenario) -> Result<(), String> {
    let boot_started = Instant::now();
    let mut fixture = Fixture::new()?;
    let boot_wall_time_ns = u64::try_from(boot_started.elapsed().as_nanos())
        .map_err(|_| "native boot time overflowed u64".to_string())?;
    let mut timings = Vec::with_capacity(scenario.phases.len());
    for phase in &scenario.phases {
        let started = Instant::now();
        for frame in phase.start_frame..phase.end_frame {
            fixture.render_frame(&phase.name, frame - phase.start_frame)?;
        }
        let wall_time_ns = u64::try_from(started.elapsed().as_nanos())
            .map_err(|_| format!("phase {} time overflowed u64", phase.name))?;
        timings.push(PhaseTiming {
            name: phase.name.clone(),
            start_frame: phase.start_frame,
            end_frame: phase.end_frame,
            wall_time_ns,
        });
    }
    fixture.verify_full_render()?;
    let record = MeasurementRecord {
        schema_version: 1,
        event: "measurement",
        scenario_id: scenario.id.clone(),
        boot_wall_time_ns,
        phases: timings,
        final_framebuffer_hash: sha256(&fixture.framebuffer),
        final_draw_list_hash: draw_hash(&fixture.words),
    };
    println!(
        "{DAMAGE_PREFIX}{}",
        serde_json::to_string(&record).map_err(|error| error.to_string())?
    );
    Ok(())
}

fn run_markers(scenario: &Scenario) -> Result<(), String> {
    let mut fixture = Fixture::new()?;
    for phase in &scenario.phases {
        let id = phase_id(&scenario.id, &phase.name);
        reset_allocation_phase();
        marker(MARKER_BEGIN, id)?;
        for frame in phase.start_frame..phase.end_frame {
            fixture.render_frame(&phase.name, frame - phase.start_frame)?;
        }
        let allocation = allocation_snapshot();
        marker(MARKER_END, id)?;
        let record = GuestPhaseRecord {
            schema_version: 1,
            event: "phase",
            scenario_id: scenario.id.clone(),
            phase: phase.name.clone(),
            phase_id: id,
            iteration: 0,
            alloc_calls: allocation.calls,
            allocated_bytes: allocation.bytes,
            current_bytes: allocation.current,
            peak_bytes: allocation.peak.saturating_sub(allocation.baseline),
            // This core-only fixture constructs no QuickJS runtime.
            quickjs_live_bytes_after_gc: 0,
            draw_list_hash: draw_hash(&fixture.words),
        };
        println!(
            "{GUEST_PREFIX}{}",
            serde_json::to_string(&record).map_err(|error| error.to_string())?
        );
    }
    fixture.verify_full_render()?;
    let final_draw_list_hash = draw_hash(&fixture.words);
    let final_state_hash = fnv1a64(
        fixture
            .framebuffer
            .iter()
            .copied()
            .chain(fixture.words.iter().flat_map(|word| word.to_le_bytes())),
    );
    let record = GuestCompleteRecord {
        schema_version: 1,
        event: "complete",
        scenario_id: scenario.id.clone(),
        suite: scenario.suite.clone(),
        framework: scenario.subject.framework.clone(),
        final_draw_list_hash,
        final_state_hash,
        effect_hash: fnv1a64(std::iter::empty()),
    };
    println!(
        "{GUEST_PREFIX}{}",
        serde_json::to_string(&record).map_err(|error| error.to_string())?
    );
    Ok(())
}

fn main() {
    let result = (|| {
        let args = parse_args()?;
        let scenario = read_scenario(&args.scenario)?;
        match args.mode {
            Mode::Correctness => run_correctness(&scenario),
            Mode::Measurement => run_measurement(&scenario),
            Mode::Markers => run_markers(&scenario),
        }
    })();
    if let Err(error) = result {
        eprintln!("pocketjs-perf-damage: {error}");
        std::process::exit(1);
    }
}
