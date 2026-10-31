//! The program's main loop: the room or a full-screen game each frame, the UI on
//! top, and everything asynchronous (agent, recognizer, test runs) arriving here
//! on channels so all GL stays on this thread.
use crate::{
    agent::{AgentHandle, Event, RunReply, Task},
    audio,
    egl::Egl,
    library::{self, Entry, Library},
    mic::{self, Mic, Recognition},
    overlay::Overlay,
    pad::{self, Gamepad},
    room::{on_spot, Room, Spot},
};
use anyhow::Result;
use pocket_arcade::{
    game::{Game, HudCommand, Pad},
    gl::*,
    hud::{Align, Hud},
    render::Renderer,
    synth::Voice,
};
use serde_json::{json, Value};
use std::{
    collections::{HashMap, VecDeque},
    ffi::c_void,
    path::{Path, PathBuf},
    sync::{
        atomic::Ordering,
        mpsc::{self, Receiver, Sender},
    },
    time::Instant,
};

const PREVIEW: [i32; 2] = [640, 360];
const COVER: [i32; 2] = [400, 560];
const CASE_W: f32 = 0.2;
const CASE_H: f32 = 0.28;
const CASE_D: f32 = 0.024;
const LEAN: f32 = 0.122;
const SLOTS_PER_PAGE: usize = 12;
const CONSOLE_W: f32 = 0.3;
const CONSOLE_H: f32 = 0.11;
const CONSOLE_D: f32 = 0.026;
const SCREEN_W: f32 = 0.143;
const SCREEN_H: f32 = 0.0805;
const LOG_LINES: usize = 12;
const INK: [f32; 4] = [0.99, 0.96, 1.0, 1.0];
const DIM: [f32; 4] = [0.68, 0.62, 0.82, 1.0];
const YELLOW: [f32; 4] = [1.0, 0.82, 0.25, 1.0];
const PINK: [f32; 4] = [1.0, 0.37, 0.62, 1.0];
const CYAN: [f32; 4] = [0.25, 0.82, 0.91, 1.0];

#[derive(Clone, Copy, PartialEq, Debug)]
enum Stage {
    Room,
    Entering(f32),
    Playing,
    Leaving(f32),
}

struct TestRun {
    game: Game,
    ticks: u64,
    inputs: Vec<(u32, u64, u64)>,
    shots: Vec<u64>,
    shot_ticks: Vec<u64>,
    images: Vec<Vec<u8>>,
    reply: Sender<RunReply>,
    started: Instant,
    directory: PathBuf,
}

#[derive(Default)]
struct AgentView {
    running: bool,
    phase: String,
    line: String,
    stream: String,
    failed: String,
    done_id: String,
    game_id: String,
    started: Option<Instant>,
    input_tokens: u64,
    output_tokens: u64,
    cached_tokens: u64,
    runs: u32,
    heap_peak: usize,
}

pub struct Options {
    pub data: PathBuf,
    pub package: PathBuf,
    pub font: String,
    pub control: PathBuf,
    pub play: Option<String>,
}

pub struct Studio {
    egl: Egl,
    renderer: Renderer,
    hud: Hud,
    room: Room,
    overlay: Overlay,
    gamepad: Gamepad,
    virtual_buttons: Vec<(u32, u32)>,
    held_buttons: u32,
    last_pad: Pad,
    library: Library,
    data: PathBuf,
    games: Vec<Entry>,
    covers: HashMap<String, Canvas>,
    placeholder: u32,
    preview: Canvas,
    laptop: Canvas,
    tv: Canvas,
    laptop_lines: VecDeque<(String, [f32; 4])>,
    laptop_dirty: bool,
    tv_dirty: bool,
    agent: Option<AgentHandle>,
    agent_events: Receiver<Event>,
    agent_sender: Sender<Event>,
    view: AgentView,
    mic: Option<Mic>,
    recognition: Option<Receiver<Recognition>>,
    recognizer: mic::Recognizer,
    transcribing: bool,
    transcript: String,
    transcript_seq: u32,
    mic_error: String,
    stage: Stage,
    playing: Option<Game>,
    preview_live: bool,
    queued_run: Option<(Value, PathBuf, Sender<RunReply>)>,
    test_run: Option<TestRun>,
    play_error: String,
    play_time: f32,
    selected_case: Option<usize>,
    rack_page: usize,
    focus: String,
    case_pull: Vec<f32>,
    console_on_play: f32,
    console_target: f32,
    fade: f32,
    audio: Sender<Vec<Voice>>,
    state_stamp: String,
    state_clock: f32,
    control: Option<std::fs::File>,
    control_buffer: String,
    pending_shot: Option<String>,
    stats_clock: Instant,
    stats_frames: u32,
    stats_max_ms: f32,
    last_frame: Instant,
    pub quit: bool,
}

fn read_png(path: &Path) -> Option<(Vec<u8>, u32, u32)> {
    let file = std::fs::File::open(path).ok()?;
    let mut decoder = png::Decoder::new(std::io::BufReader::new(file));
    decoder.set_transformations(png::Transformations::EXPAND | png::Transformations::STRIP_16);
    let mut reader = decoder.read_info().ok()?;
    let mut buffer = vec![0; reader.output_buffer_size()?];
    let info = reader.next_frame(&mut buffer).ok()?;
    buffer.truncate(info.buffer_size());
    let (width, height) = (info.width, info.height);
    let pixels = match info.color_type {
        png::ColorType::Rgba => buffer,
        png::ColorType::Rgb => buffer
            .chunks_exact(3)
            .flat_map(|c| [c[0], c[1], c[2], 255])
            .collect(),
        _ => return None,
    };
    Some((pixels, width, height))
}

fn encode_png(pixels: &[u8], width: u32, height: u32) -> Vec<u8> {
    let mut out = Vec::new();
    {
        let mut encoder = png::Encoder::new(&mut out, width, height);
        encoder.set_color(png::ColorType::Rgb);
        encoder.set_depth(png::BitDepth::Eight);
        encoder.set_compression(png::Compression::Fast);
        if let Ok(mut writer) = encoder.write_header() {
            let rgb: Vec<u8> = pixels
                .chunks_exact(4)
                .flat_map(|p| [p[0], p[1], p[2]])
                .collect();
            let _ = writer.write_image_data(&rgb);
        }
    }
    out
}

/// Read the bound framebuffer into a top-row-first PNG.
unsafe fn capture(width: i32, height: i32) -> Vec<u8> {
    let mut pixels = vec![0u8; (width * height * 4) as usize];
    glPixelStorei(PACK_ALIGNMENT, 1);
    glReadPixels(
        0,
        0,
        width,
        height,
        RGBA,
        UNSIGNED_BYTE,
        pixels.as_mut_ptr() as *mut c_void,
    );
    let stride = width as usize * 4;
    let mut flipped = vec![0u8; pixels.len()];
    for (row, line) in pixels.chunks_exact(stride).enumerate() {
        flipped[(height as usize - 1 - row) * stride..][..stride].copy_from_slice(line);
    }
    encode_png(&flipped, width as u32, height as u32)
}

fn hex_color(text: &str, fallback: [f32; 4]) -> [f32; 4] {
    match u32::from_str_radix(text.trim_start_matches('#'), 16) {
        Ok(v) if text.len() >= 6 => [
            ((v >> 16) & 255) as f32 / 255.0,
            ((v >> 8) & 255) as f32 / 255.0,
            (v & 255) as f32 / 255.0,
            1.0,
        ],
        _ => fallback,
    }
}

fn button_named(name: &str) -> u32 {
    match name {
        "up" => pad::UP,
        "down" => pad::DOWN,
        "left" => pad::LEFT,
        "right" => pad::RIGHT,
        "a" => pad::A,
        "b" => pad::B,
        "x" => pad::X,
        "y" => pad::Y,
        "l" => pad::L,
        "r" => pad::R,
        "start" => pad::START,
        "select" => pad::SELECT,
        "menu" => pad::MENU,
        _ => 0,
    }
}

fn resident_kb() -> u64 {
    std::fs::read_to_string("/proc/self/statm")
        .ok()
        .and_then(|text| text.split_whitespace().nth(1)?.parse::<u64>().ok())
        .map_or(0, |pages| pages * 4)
}

impl Studio {
    /// # Safety
    /// Takes over the display; call once, on the thread that stays the GL thread.
    pub unsafe fn open(
        options: &Options,
        profile: pocket_runtime::Profile,
        host_abi: u32,
        hash: [u8; 32],
    ) -> Result<Self> {
        let egl = Egl::open()?;
        eprintln!("pocket-studio: panel {}x{}", egl.width, egl.height);
        let renderer = Renderer::new()?;
        let mut hud = Hud::new(&options.font)?;
        let room = Room::load(
            &options.data.join("assets/room.pak"),
            egl.width as f32 / egl.height as f32,
        )?;
        let package = std::fs::read(&options.package)
            .map_err(|error| anyhow::anyhow!("{}: {error}", options.package.display()))?;
        let overlay = Overlay::new(profile, host_abi, hash, package)?;
        let preview = Canvas::new(PREVIEW[0], PREVIEW[1], true)?;
        let laptop = Canvas::new(800, 600, false)?;
        let tv = Canvas::new(320, 240, false)?;
        let placeholder = Self::paint_placeholder(&mut hud, &preview);
        let library = Library::new(&options.data);
        let games = library.list();
        let (agent_sender, agent_events) = mpsc::channel();
        let control = std::fs::OpenOptions::new()
            .read(true)
            .custom_flags_nonblock()
            .open(&options.control)
            .ok();
        let mut studio = Self {
            egl,
            renderer,
            hud,
            room,
            overlay,
            gamepad: Gamepad::open(),
            virtual_buttons: Vec::new(),
            held_buttons: 0,
            last_pad: Pad::default(),
            library,
            data: options.data.clone(),
            games,
            covers: HashMap::new(),
            placeholder,
            preview,
            laptop,
            tv,
            laptop_lines: VecDeque::new(),
            laptop_dirty: true,
            tv_dirty: true,
            agent: None,
            agent_events,
            agent_sender,
            view: AgentView::default(),
            mic: None,
            recognition: None,
            recognizer: mic::Recognizer::new(),
            transcribing: false,
            transcript: String::new(),
            transcript_seq: 0,
            mic_error: String::new(),
            stage: Stage::Room,
            playing: None,
            preview_live: false,
            queued_run: None,
            test_run: None,
            play_error: String::new(),
            play_time: 0.0,
            selected_case: None,
            rack_page: 0,
            focus: "desk".to_owned(),
            case_pull: vec![0.0; SLOTS_PER_PAGE],
            console_on_play: 1.0,
            console_target: 1.0,
            fade: 0.0,
            audio: audio::start(),
            state_stamp: String::new(),
            state_clock: 0.0,
            control,
            control_buffer: String::new(),
            pending_shot: None,
            stats_clock: Instant::now(),
            stats_frames: 0,
            stats_max_ms: 0.0,
            last_frame: Instant::now(),
            quit: false,
        };
        if let Some(id) = &options.play {
            studio.start_play(id);
            studio.stage = Stage::Playing;
        }
        Ok(studio)
    }

    /// The console's screen when no game runs: a texture left in the preview's size.
    unsafe fn paint_placeholder(hud: &mut Hud, like: &Canvas) -> u32 {
        let mut canvas = Canvas::new(like.width, like.height, false).expect("placeholder canvas");
        canvas.bind();
        glClearColor(0.09, 0.07, 0.17, 1.0);
        glClear(COLOR_BUFFER_BIT);
        hud.set_space(1280.0, 720.0);
        hud.text("POCKET", 640.0, 240.0, 120.0, YELLOW, Align::Center);
        hud.text("STUDIO", 640.0, 370.0, 90.0, PINK, Align::Center);
        hud.flush();
        glBindFramebuffer(FRAMEBUFFER, 0);
        let texture = canvas.texture;
        canvas.texture = 0;
        canvas.destroy();
        texture
    }

    fn push_line(&mut self, text: impl Into<String>, color: [f32; 4]) {
        self.laptop_lines.push_back((text.into(), color));
        while self.laptop_lines.len() > 120 {
            self.laptop_lines.pop_front();
        }
        self.laptop_dirty = true;
    }

    unsafe fn paint_laptop(&mut self) {
        self.laptop.bind();
        glClearColor(0.05, 0.04, 0.1, 1.0);
        glClear(COLOR_BUFFER_BIT);
        let hud = &mut self.hud;
        hud.set_space(800.0, 600.0);
        hud.rect(0.0, 0.0, 800.0, 64.0, [0.14, 0.11, 0.24, 1.0]);
        hud.text("agent", 18.0, 10.0, 38.0, YELLOW, Align::Left);
        let status = if self.view.running {
            self.view.phase.as_str()
        } else if !self.view.failed.is_empty() {
            "stopped"
        } else {
            "ready"
        };
        let status: String = status.chars().take(24).collect();
        hud.text(&status, 782.0, 16.0, 28.0, CYAN, Align::Right);
        // Newest lines at the bottom, wrapped to the screen's width.
        let mut wrapped: Vec<(String, [f32; 4])> = Vec::new();
        let tail = self.view.stream.trim();
        let mut lines: Vec<(String, [f32; 4])> = self
            .laptop_lines
            .iter()
            .rev()
            .take(LOG_LINES)
            .rev()
            .cloned()
            .collect();
        if !tail.is_empty() {
            let chars: Vec<char> = tail.chars().collect();
            let from = chars.len().saturating_sub(220);
            lines.push((chars[from..].iter().collect(), DIM));
        }
        for (line, color) in lines {
            for piece in hud.wrap(&line, 36.0, 764.0) {
                wrapped.push((piece, color));
            }
        }
        let visible = wrapped.len().saturating_sub(LOG_LINES);
        for (index, (line, color)) in wrapped[visible..].iter().enumerate() {
            hud.text(
                line,
                18.0,
                76.0 + index as f32 * 43.0,
                36.0,
                *color,
                Align::Left,
            );
        }
        hud.flush();
        self.laptop_dirty = false;
    }

    unsafe fn paint_tv(&mut self) {
        self.tv.bind();
        glClearColor(0.07, 0.06, 0.12, 1.0);
        glClear(COLOR_BUFFER_BIT);
        let hud = &mut self.hud;
        hud.set_space(320.0, 240.0);
        hud.text("POCKET TV", 160.0, 16.0, 26.0, CYAN, Align::Center);
        if let Some(game) = self.games.first() {
            let title: String = game.title.chars().take(14).collect();
            hud.text(&title, 160.0, 96.0, 32.0, YELLOW, Align::Center);
            hud.text("press A", 160.0, 180.0, 18.0, DIM, Align::Center);
        } else {
            hud.text("no games yet", 160.0, 104.0, 22.0, DIM, Align::Center);
        }
        hud.flush();
        self.tv_dirty = false;
    }

    /// The case's front: a colour field, the game's last screenshot and its title.
    unsafe fn cover(&mut self, entry: &Entry) -> Result<u32> {
        if let Some(canvas) = self.covers.get(&entry.id) {
            return Ok(canvas.texture);
        }
        let canvas = Canvas::new(COVER[0], COVER[1], false)?;
        let field = hex_color(&entry.color, [0.34, 0.28, 0.56, 1.0]);
        canvas.bind();
        glClearColor(field[0], field[1], field[2], 1.0);
        glClear(COLOR_BUFFER_BIT);
        let hud = &mut self.hud;
        hud.set_space(COVER[0] as f32, COVER[1] as f32);
        let luminance = 0.2126 * field[0] + 0.7152 * field[1] + 0.0722 * field[2];
        let ink = if luminance > 0.45 {
            [0.09, 0.07, 0.15, 1.0]
        } else {
            INK
        };
        if let Some((pixels, width, height)) =
            read_png(&self.library.directory(&entry.id).join("shot.png"))
        {
            let mut texture = 0;
            glGenTextures(1, &mut texture);
            glBindTexture(TEXTURE_2D, texture);
            glTexImage2D(
                TEXTURE_2D,
                0,
                RGBA8 as i32,
                width as i32,
                height as i32,
                0,
                RGBA,
                UNSIGNED_BYTE,
                pixels.as_ptr() as *const c_void,
            );
            glTexParameteri(TEXTURE_2D, TEXTURE_MIN_FILTER, LINEAR);
            glTexParameteri(TEXTURE_2D, TEXTURE_MAG_FILTER, LINEAR);
            hud.rect(14.0, 14.0, 372.0, 214.0, [0.0, 0.0, 0.0, 0.4]);
            hud.image(texture, 18.0, 18.0, 364.0, 206.0, false, [1.0; 4]);
            glDeleteTextures(1, &texture);
        }
        let mut y = 250.0;
        for line in hud.wrap(&entry.title, 52.0, 372.0).into_iter().take(3) {
            hud.text(&line, 200.0, y, 52.0, ink, Align::Center);
            y += 62.0;
        }
        for line in hud.wrap(&entry.tagline, 26.0, 360.0).into_iter().take(3) {
            hud.text(&line, 200.0, y + 8.0, 26.0, ink, Align::Center);
            y += 32.0;
        }
        hud.flush();
        glBindFramebuffer(FRAMEBUFFER, 0);
        let texture = canvas.texture;
        self.covers.insert(entry.id.clone(), canvas);
        Ok(texture)
    }

    fn refresh_library(&mut self) {
        self.games = self.library.list();
        for (_, mut canvas) in self.covers.drain() {
            unsafe { canvas.destroy() };
        }
        self.tv_dirty = true;
    }

    fn start_agent(&mut self, prompt: String, game: Option<String>) {
        if self.agent.as_ref().is_some_and(AgentHandle::is_running) {
            return;
        }
        let id = match game {
            Some(id) => id,
            None => match self.library.create() {
                Ok(id) => id,
                Err(error) => {
                    self.view.failed = error.to_string();
                    return;
                }
            },
        };
        let previous_summary = self
            .games
            .iter()
            .find(|entry| entry.id == id)
            .map(|entry| entry.summary.clone());
        self.view = AgentView {
            running: true,
            phase: "starting".to_owned(),
            game_id: id.clone(),
            started: Some(Instant::now()),
            ..AgentView::default()
        };
        self.laptop_lines.clear();
        let preview: String = prompt.chars().take(160).collect();
        self.push_line(format!("> {preview}"), YELLOW);
        self.console_target = 0.0;
        self.agent = Some(AgentHandle::start(
            Task {
                prompt,
                directory: self.library.directory(&id),
                previous_summary,
                data: self.data.clone(),
            },
            self.agent_sender.clone(),
        ));
    }

    fn take_agent_events(&mut self) {
        while let Ok(event) = self.agent_events.try_recv() {
            match event {
                Event::Status(text) => {
                    self.view.phase = text;
                    self.laptop_dirty = true;
                }
                Event::Line { kind, text } => {
                    self.view.stream.clear();
                    let color = match kind.as_str() {
                        "error" => PINK,
                        "run" => CYAN,
                        "done" => YELLOW,
                        "say" => INK,
                        _ => DIM,
                    };
                    self.view.line = text.clone();
                    self.push_line(text, color);
                }
                Event::Stream(text) => {
                    self.view.stream.push_str(&text);
                    let excess = self.view.stream.len().saturating_sub(1200);
                    if excess > 0 {
                        let mut at = excess;
                        while !self.view.stream.is_char_boundary(at) {
                            at += 1;
                        }
                        self.view.stream.drain(..at);
                    }
                    self.laptop_dirty = true;
                }
                Event::Usage {
                    input,
                    output,
                    cached,
                } => {
                    self.view.input_tokens = input;
                    self.view.output_tokens += output;
                    self.view.cached_tokens = cached;
                }
                Event::Run {
                    options,
                    directory,
                    reply,
                } => self.begin_test_run(&options, directory, reply),
                Event::Finished { .. } => {
                    self.view.done_id = self.view.game_id.clone();
                    self.refresh_library();
                    self.push_line("on the shelf", YELLOW);
                }
                Event::Failed(text) => {
                    self.view.failed = text.chars().take(400).collect();
                    let line = format!("stopped: {}", self.view.failed);
                    self.push_line(line, PINK);
                }
                Event::Stopped { heap_peak } => {
                    self.view.running = false;
                    self.view.heap_peak = heap_peak;
                    // A new game that never reached the shelf leaves no directory behind.
                    let directory = self.library.directory(&self.view.game_id);
                    if !self.view.game_id.is_empty() && !directory.join("game.json").exists() {
                        let _ = self.library.remove(&self.view.game_id);
                    }
                    self.laptop_dirty = true;
                    eprintln!(
                        "pocket-studio: agent stopped: {:.0}s, {} runs, context {} (cached {}), generated {}, harness heap {} KB",
                        self.view.started.map_or(0.0, |t| t.elapsed().as_secs_f32()),
                        self.view.runs,
                        self.view.input_tokens,
                        self.view.cached_tokens,
                        self.view.output_tokens,
                        heap_peak / 1024
                    );
                }
            }
        }
    }

    fn begin_test_run(&mut self, options: &Value, directory: PathBuf, reply: Sender<RunReply>) {
        // A player's game holds the renderer: a test waits for them by failing clearly.
        if self.stage != Stage::Room {
            let _ = reply.send(RunReply { report: json!({ "ok": false, "error": "the player is playing a game; run again in a moment" }), shots: Vec::new() });
            return;
        }
        unsafe { self.renderer.reset_game_meshes() };
        let game = match Game::load(&directory) {
            Ok(game) => game,
            Err(error) => {
                let _ = reply.send(RunReply {
                    report: json!({ "ok": false, "phase": "load", "error": error }),
                    shots: Vec::new(),
                });
                return;
            }
        };
        self.view.runs += 1;
        let ticks = options["ticks"].as_u64().unwrap_or(180).clamp(1, 600);
        let inputs = options["inputs"].as_array().map(|list| {
            list.iter()
                .map(|entry| {
                    (
                        button_named(entry["button"].as_str().unwrap_or("")),
                        entry["from"].as_u64().unwrap_or(0),
                        entry["to"].as_u64().unwrap_or(0),
                    )
                })
                .collect()
        });
        let mut shots: Vec<u64> = options["screenshots"]
            .as_array()
            .map(|list| {
                list.iter()
                    .filter_map(Value::as_u64)
                    .filter(|&t| t < ticks)
                    .take(3)
                    .collect()
            })
            .unwrap_or_default();
        if shots.is_empty() {
            shots.push(ticks - 1);
        }
        self.test_run = Some(TestRun {
            game,
            ticks,
            inputs: inputs.unwrap_or_default(),
            shots,
            shot_ticks: Vec::new(),
            images: Vec::new(),
            reply,
            started: Instant::now(),
            directory,
        });
    }

    fn finish_test_run(&mut self, error: Option<String>) {
        let Some(run) = self.test_run.take() else {
            return;
        };
        let logs: Vec<String> = run
            .game
            .frame
            .borrow()
            .logs
            .iter()
            .rev()
            .take(30)
            .rev()
            .cloned()
            .collect();
        let seconds = run.started.elapsed().as_secs_f32();
        let mut report = json!({
            "ok": error.is_none(),
            "ticks": run.game.tick,
            "entities": run.game.entities().len() / pocket_arcade::world::STRIDE,
            "fps": ((run.game.tick as f32 / seconds.max(0.001)).round()),
            "heapKB": run.game.heap_peak / 1024,
            "logs": logs,
            "shotTicks": run.shot_ticks,
        });
        if let Some(error) = error {
            report["error"] = json!(error);
        }
        if let Some(png) = run.images.last() {
            let _ = std::fs::write(run.directory.join("shot.png"), png);
        }
        self.preview_live = true;
        let _ = run.reply.send(RunReply {
            report,
            shots: run.images,
        });
    }

    fn start_play(&mut self, id: &str) {
        self.recognizer.stop();
        unsafe { self.renderer.reset_game_meshes() };
        self.play_error.clear();
        self.play_time = 0.0;
        match Game::load(&self.library.directory(id)) {
            Ok(game) => self.playing = Some(game),
            Err(error) => {
                self.play_error = error;
                self.playing = None;
            }
        }
        self.console_target = 1.0;
        self.stage = Stage::Entering(0.0);
        if let Some(pose) = self.room.pose("play") {
            self.room.rig.shift = 0.0;
            self.room.rig.go(pose, 1.0);
        }
    }

    fn sync_meshes(&mut self, game_id: u8) {
        let game = if game_id == 0 {
            self.playing.as_ref()
        } else {
            self.test_run.as_ref().map(|run| &run.game)
        };
        let Some(game) = game else { return };
        let meshes = std::mem::take(&mut game.frame.borrow_mut().meshes);
        for (_, shape) in meshes {
            unsafe { self.renderer.add_mesh(&shape) };
        }
    }

    unsafe fn draw_game_hud(hud: &mut Hud, commands: &[HudCommand]) {
        hud.set_space(1280.0, 720.0);
        for command in commands {
            match command {
                HudCommand::Rect { x, y, w, h, color } => hud.rect(*x, *y, *w, *h, *color),
                HudCommand::Text {
                    text,
                    x,
                    y,
                    px,
                    color,
                    align,
                } => hud.text(text, *x, *y, *px, *color, *align),
            }
        }
        hud.flush();
    }

    unsafe fn draw_playing(&mut self, size: [i32; 2]) {
        let Some(game) = self.playing.as_ref() else {
            return;
        };
        let frame = game.frame.borrow();
        self.renderer
            .draw(&frame.scene, game.entities(), &frame.particles, size);
        Self::draw_game_hud(&mut self.hud, &frame.hud);
    }

    fn step_play(&mut self, pad: Pad) {
        let result = match self.playing.as_mut() {
            Some(game) => game.step(pad),
            None => return,
        };
        self.sync_meshes(0);
        if let Some(game) = self.playing.as_ref() {
            let voices = std::mem::take(&mut game.frame.borrow_mut().voices);
            if !voices.is_empty() {
                let _ = self.audio.send(voices);
            }
        }
        if let Err(error) = result {
            eprintln!("pocket-studio: game error: {error}");
            self.play_error = error;
            self.playing = None;
        }
    }

    fn step_test_run(&mut self) {
        let Some(run) = self.test_run.as_mut() else {
            return;
        };
        let tick = run.game.tick;
        let mut buttons = 0;
        for &(bit, from, to) in &run.inputs {
            if tick >= from && tick <= to {
                buttons |= bit;
            }
        }
        let result = run.game.step(Pad {
            buttons,
            ..Pad::default()
        });
        run.game.frame.borrow_mut().voices.clear();
        if let Err(error) = result {
            self.finish_test_run(Some(error));
            return;
        }
        self.sync_meshes(1);
        unsafe {
            let run = self.test_run.as_mut().unwrap();
            let frame = run.game.frame.borrow();
            self.preview.bind();
            self.renderer
                .draw(&frame.scene, run.game.entities(), &frame.particles, PREVIEW);
            Self::draw_game_hud(&mut self.hud, &frame.hud);
            drop(frame);
            if run.shots.contains(&tick) {
                run.images.push(capture(PREVIEW[0], PREVIEW[1]));
                run.shot_ticks.push(tick);
            }
            glBindFramebuffer(FRAMEBUFFER, 0);
        }
        let done = self
            .test_run
            .as_ref()
            .is_some_and(|run| run.game.tick >= run.ticks);
        if done {
            self.finish_test_run(None);
        }
    }

    fn command(&mut self, line: &str) {
        let Ok(command) = serde_json::from_str::<Value>(line) else {
            return;
        };
        match command["t"].as_str().unwrap_or("") {
            "pose" => {
                if let Some(pose) = command["name"]
                    .as_str()
                    .and_then(|name| self.room.pose(name))
                {
                    self.room.rig.shift = command["shift"].as_f64().unwrap_or(0.0) as f32;
                    self.room
                        .rig
                        .go(pose, command["seconds"].as_f64().unwrap_or(0.9) as f32);
                }
                self.console_target = if command["name"] == "build"
                    || command["name"] == "desk"
                    || command["name"] == "laptop"
                {
                    0.0
                } else {
                    1.0
                };
            }
            "focus" => self.focus = command["name"].as_str().unwrap_or("").to_owned(),
            "case" => {
                self.selected_case = command["index"].as_u64().map(|index| index as usize);
                self.rack_page = command["page"].as_u64().unwrap_or(0) as usize;
            }
            "mic" => self.set_mic(command["on"].as_bool().unwrap_or(false)),
            "asr" => self.recognizer.start(&self.data.join("asr")),
            "make" => {
                let prompt = command["prompt"].as_str().unwrap_or("").trim().to_owned();
                if !prompt.is_empty() {
                    self.start_agent(prompt, command["game"].as_str().map(str::to_owned));
                }
            }
            "cancel" => {
                if let Some(agent) = &self.agent {
                    agent.cancel.store(true, Ordering::Relaxed);
                }
            }
            "clear" => {
                if !self.view.running {
                    self.view = AgentView::default();
                    self.transcript.clear();
                    self.mic_error.clear();
                }
            }
            "play" => {
                if let Some(id) = command["id"].as_str() {
                    if self.test_run.is_none() {
                        let id = id.to_owned();
                        self.start_play(&id);
                    }
                }
            }
            "delete" => {
                if let Some(id) = command["id"].as_str() {
                    let _ = self.library.remove(id);
                    self.refresh_library();
                }
            }
            "quit" => self.quit = true,
            _ => {}
        }
    }

    fn set_mic(&mut self, on: bool) {
        if on {
            if self.mic.is_none() && !self.transcribing {
                self.mic_error.clear();
                match Mic::start() {
                    Ok(mic) => self.mic = Some(mic),
                    Err(error) => self.mic_error = error.to_string(),
                }
            }
        } else if let Some(recording) = self.mic.take() {
            let mut samples = recording.stop();
            if samples.len() < (mic::SAMPLE_RATE / 3) as usize {
                self.mic_error = "too short: hold the button while you speak".to_owned();
                return;
            }
            mic::condition(&mut samples);
            self.begin_recognition(samples);
        }
    }

    fn begin_recognition(&mut self, samples: Vec<i16>) {
        self.recognizer.start(&self.data.join("asr"));
        self.transcribing = true;
        self.recognition = Some(mic::recognize(samples));
    }

    fn take_recognition(&mut self) {
        let Some(receiver) = &self.recognition else {
            return;
        };
        let Ok(result) = receiver.try_recv() else {
            return;
        };
        self.recognition = None;
        self.transcribing = false;
        match result.text {
            Ok(text) => {
                eprintln!("pocket-studio: heard in {:.1}s: {text}", result.seconds);
                if text.is_empty() {
                    self.mic_error = "no speech heard".to_owned();
                } else {
                    self.transcript = text;
                    self.transcript_seq += 1;
                }
            }
            Err(error) => {
                eprintln!("pocket-studio: recognizer: {error:#}");
                self.mic_error = format!("{error:#}");
            }
        }
    }

    /// Lines from the validation pipe: `press a 8`, `hold x`, `release x`,
    /// `prompt …`, `voice /path.wav`, `shot /path.png`, `quit`.
    fn poll_control(&mut self) {
        use std::io::Read;
        let Some(file) = self.control.as_mut() else {
            return;
        };
        let mut buffer = [0u8; 4096];
        if let Ok(read) = file.read(&mut buffer) {
            if read > 0 {
                self.control_buffer
                    .push_str(&String::from_utf8_lossy(&buffer[..read]));
            }
        }
        while let Some(end) = self.control_buffer.find('\n') {
            let line: String = self.control_buffer.drain(..=end).collect();
            let line = line.trim().to_owned();
            let (verb, rest) = line.split_once(' ').unwrap_or((&line, ""));
            match verb {
                "press" => {
                    let mut parts = rest.split_whitespace();
                    let bit = button_named(parts.next().unwrap_or(""));
                    let frames = parts.next().and_then(|n| n.parse().ok()).unwrap_or(6);
                    self.virtual_buttons.push((bit, frames));
                }
                "hold" => self.held_buttons |= button_named(rest.trim()),
                "release" => self.held_buttons &= !button_named(rest.trim()),
                "prompt" => self.start_agent(rest.to_owned(), None),
                "voice" => {
                    // 16 kHz mono 16-bit WAV with a 44-byte header.
                    if let Ok(bytes) = std::fs::read(rest.trim()) {
                        let samples = bytes
                            .get(44..)
                            .unwrap_or(&[])
                            .chunks_exact(2)
                            .map(|b| i16::from_le_bytes([b[0], b[1]]))
                            .collect();
                        self.begin_recognition(samples);
                    }
                }
                "shot" => self.pending_shot = Some(rest.trim().to_owned()),
                "quit" => self.quit = true,
                _ => {}
            }
        }
    }

    fn state(&self) -> (Value, String) {
        let agent = &self.view;
        let shown: Vec<Value> = self.games.iter().map(library::entry_json).collect();
        let level = self
            .mic
            .as_ref()
            .map_or(0, |mic| mic.level.load(Ordering::Relaxed));
        let seconds = self
            .mic
            .as_ref()
            .map_or(0.0, |mic| mic.started.elapsed().as_secs_f32());
        let anchors = json!({
            "laptop": self.room.project(self.room.laptop_screen[2]),
            "rack": self.room.slots.get(1).and_then(|slot| self.room.project([slot.position[0] + 0.12, slot.position[1] + 0.4, slot.position[2]])),
            "tv": self.room.project(self.room.tv_screen[2]),
            "console": self.room.project(self.room.play_spot.position),
            "agent": self.room.project(self.room.agent_spot),
        });
        let mut text = String::new();
        for game in &self.games {
            text.push_str(&game.title);
            text.push_str(&game.tagline);
            text.push_str(&game.summary);
        }
        text.push_str(&self.transcript);
        text.push_str(&self.mic_error);
        text.push_str(&agent.phase);
        text.push_str(&agent.line);
        text.push_str(&agent.failed);
        let value = json!({
            "games": shown,
            "mic": { "on": self.mic.is_some(), "level": level as f32 / 1000.0, "seconds": seconds, "busy": self.transcribing, "error": self.mic_error },
            "transcript": self.transcript,
            "transcriptSeq": self.transcript_seq,
            "agent": {
                "running": agent.running,
                "phase": agent.phase,
                "line": agent.line,
                "failed": agent.failed,
                "doneId": agent.done_id,
                "gameId": agent.game_id,
                "elapsed": agent.started.map_or(0.0, |t| t.elapsed().as_secs_f32()) as u32,
                "tokens": agent.output_tokens,
                "runs": agent.runs,
            },
            "stage": match self.stage { Stage::Room => "room", _ => "play" },
            "testing": self.test_run.is_some(),
            "anchors": anchors,
        });
        (value, text)
    }

    fn push_state(&mut self, dt: f32) {
        self.state_clock += dt;
        if self.state_clock < 0.05 {
            return;
        }
        self.state_clock = 0.0;
        let (value, text) = self.state();
        let stamp = value.to_string();
        if stamp != self.state_stamp {
            self.state_stamp = stamp;
            self.overlay.send_state(&value, &text);
        }
    }

    fn console_spot(&self) -> Spot {
        let k = self.console_on_play;
        let (a, b) = (self.room.build_spot, self.room.play_spot);
        Spot {
            position: pocket_arcade::math::lerp(a.position, b.position, k),
            yaw: a.yaw + (b.yaw - a.yaw) * k,
            tilt: a.tilt + (b.tilt - a.tilt) * k,
        }
    }

    fn console_screen_corners(&self) -> [[f32; 3]; 4] {
        let spot = self.console_spot();
        let (w, h) = (SCREEN_W / 2.0, SCREEN_H / 2.0);
        let (cy, z) = (CONSOLE_H * 0.5 + 0.012, CONSOLE_D * 0.5 + 0.0012);
        [
            on_spot(spot, [-w, cy - h, z]),
            on_spot(spot, [w, cy - h, z]),
            on_spot(spot, [w, cy + h, z]),
            on_spot(spot, [-w, cy + h, z]),
        ]
    }

    /// The TrimUI Smart Pro in the room, composed from boxes and cylinders.
    fn queue_console(&mut self) {
        let spot = self.console_spot();
        let rotation = [-spot.tilt, spot.yaw, 0.0];
        let dark = [0.1, 0.1, 0.12];
        let mid = [0.2, 0.2, 0.23];
        let center_y = CONSOLE_H * 0.5;
        let z = CONSOLE_D * 0.5;
        let room = &mut self.room;
        let mut part = |shape: f32,
                        local: [f32; 3],
                        scale: [f32; 3],
                        color: [f32; 3],
                        emissive: f32,
                        x_turn: f32| {
            let position = on_spot(spot, local);
            room.prop(
                shape,
                position,
                [rotation[0] + x_turn, rotation[1], 0.0],
                scale,
                color,
                emissive,
            );
        };
        part(
            0.0,
            [0.0, center_y, 0.0],
            [CONSOLE_W, CONSOLE_H, CONSOLE_D],
            dark,
            0.0,
            0.0,
        );
        part(
            0.0,
            [0.0, center_y + 0.012, z + 0.0004],
            [SCREEN_W + 0.012, SCREEN_H + 0.012, 0.001],
            [0.02, 0.02, 0.03],
            0.0,
            0.0,
        );
        let stick = [0.07, 0.07, 0.08];
        let turn = std::f32::consts::FRAC_PI_2;
        part(
            3.0,
            [-0.118, center_y + 0.028, z + 0.004],
            [0.026, 0.01, 0.026],
            stick,
            0.0,
            turn,
        );
        part(
            3.0,
            [0.118, center_y - 0.03, z + 0.004],
            [0.026, 0.01, 0.026],
            stick,
            0.0,
            turn,
        );
        part(
            0.0,
            [-0.118, center_y - 0.024, z + 0.002],
            [0.03, 0.009, 0.004],
            mid,
            0.0,
            0.0,
        );
        part(
            0.0,
            [-0.118, center_y - 0.024, z + 0.002],
            [0.009, 0.03, 0.004],
            mid,
            0.0,
            0.0,
        );
        for (dx, dy, color) in [
            (0.0, 0.012, [0.92, 0.75, 0.2]),
            (0.012, 0.0, [0.88, 0.25, 0.32]),
            (0.0, -0.012, [0.28, 0.72, 0.42]),
            (-0.012, 0.0, [0.25, 0.5, 0.9]),
        ] {
            part(
                3.0,
                [0.118 + dx, center_y + 0.028 + dy, z + 0.002],
                [0.009, 0.004, 0.009],
                color,
                0.25,
                turn,
            );
        }
    }

    fn queue_cases(&mut self) -> Vec<(usize, u32)> {
        let start = self.rack_page * SLOTS_PER_PAGE;
        let entries: Vec<Entry> = self
            .games
            .iter()
            .skip(start)
            .take(SLOTS_PER_PAGE)
            .cloned()
            .collect();
        let mut covers = Vec::new();
        for (index, entry) in entries.iter().enumerate() {
            let Some(&slot) = self.room.slots.get(index) else {
                break;
            };
            let selected = self.selected_case == Some(index);
            let target = if selected { 1.0 } else { 0.0 };
            let pull = &mut self.case_pull[index];
            *pull += (target - *pull) * 0.18;
            let t = *pull;
            let lean = LEAN * (1.0 - t);
            let spot = Spot {
                position: [
                    slot.position[0],
                    slot.position[1] + t * 0.03,
                    slot.position[2] + t * 0.1,
                ],
                yaw: slot.yaw,
                tilt: lean,
            };
            let color = hex_color(&entry.color, [0.34, 0.28, 0.56, 1.0]);
            self.room.prop(
                0.0,
                on_spot(spot, [0.0, CASE_H / 2.0, 0.0]),
                [-lean, slot.yaw, 0.0],
                [CASE_W, CASE_H, CASE_D],
                [color[0], color[1], color[2]],
                0.0,
            );
            if let Ok(texture) = unsafe { self.cover(entry) } {
                covers.push((index, texture));
            }
        }
        covers
    }

    fn case_corners(&self, index: usize) -> [[f32; 3]; 4] {
        let slot = self.room.slots[index];
        let t = self.case_pull[index];
        let spot = Spot {
            position: [
                slot.position[0],
                slot.position[1] + t * 0.03,
                slot.position[2] + t * 0.1,
            ],
            yaw: slot.yaw,
            tilt: LEAN * (1.0 - t),
        };
        let (w, h, z) = (CASE_W / 2.0 - 0.003, CASE_H - 0.003, CASE_D / 2.0 + 0.0008);
        [
            on_spot(spot, [-w, 0.003, z]),
            on_spot(spot, [w, 0.003, z]),
            on_spot(spot, [w, h, z]),
            on_spot(spot, [-w, h, z]),
        ]
    }

    unsafe fn draw_room(&mut self, pad_state: Pad, dt: f32) {
        self.room.rig.orbit = [pad_state.axes[2] * 0.25, -pad_state.axes[3] * 0.12];
        self.room.rig.update(dt);
        self.console_on_play +=
            (self.console_target - self.console_on_play) * (1.0 - (-5.0 * dt).exp());

        if self.laptop_dirty {
            self.paint_laptop();
        }
        if self.tv_dirty {
            self.paint_tv();
        }

        self.room.clear_props();
        self.queue_console();
        let covers = self.queue_cases();
        glBindFramebuffer(FRAMEBUFFER, 0);
        glViewport(0, 0, self.egl.width, self.egl.height);
        self.hud.set_space(1280.0, 720.0);

        self.room.draw_shell();
        self.room.draw_props(&mut self.renderer);
        let laptop = self.room.laptop_screen;
        self.room
            .draw_screen(&laptop, self.laptop.texture, true, [1.0; 4]);
        let tv = self.room.tv_screen;
        self.room.draw_screen(&tv, self.tv.texture, true, [1.0; 4]);
        for (index, texture) in covers {
            let corners = self.case_corners(index);
            self.room.draw_screen(&corners, texture, true, [1.0; 4]);
        }
        let showing_game = self.test_run.is_some() || self.preview_live || self.playing.is_some();
        let screen = self.console_screen_corners();
        let (texture, flip) = if showing_game {
            (self.preview.texture, true)
        } else {
            (self.placeholder, true)
        };
        self.room.draw_screen(&screen, texture, flip, [1.0; 4]);

        // A pulse at whatever the player has focused, and around the working agent.
        let pulse = (self.room.rig.time * 3.0).sin() * 0.5 + 0.5;
        let mut extra = Vec::new();
        let focus_at = match self.focus.as_str() {
            "desk" => Some((self.room.laptop_screen[2], 0.5)),
            "rack" => self.room.slots.get(1).map(|slot| {
                (
                    [
                        slot.position[0] + 0.12,
                        slot.position[1] + 0.1,
                        slot.position[2] + 0.1,
                    ],
                    0.9,
                )
            }),
            "tv" => Some((self.room.tv_screen[2], 0.5)),
            "console" => Some((self.room.play_spot.position, 0.4)),
            _ => None,
        };
        if let Some((at, size)) = focus_at {
            extra.push((at, [1.0, 0.82, 0.25], size, 0.22 + pulse * 0.2));
        }
        if self.view.running {
            extra.push((
                self.room.agent_spot,
                [0.66, 0.71, 1.0],
                0.26,
                0.35 + pulse * 0.45,
            ));
        }
        self.room.draw_glows(&extra);
    }

    /// Fade the whole panel toward black.
    unsafe fn draw_fade(&mut self) {
        if self.fade > 0.001 {
            self.hud.set_space(1280.0, 720.0);
            self.hud
                .rect(0.0, 0.0, 1280.0, 720.0, [0.0, 0.0, 0.0, self.fade.min(1.0)]);
            self.hud.flush();
        }
    }

    unsafe fn draw_play_error(&mut self) {
        if self.play_error.is_empty() {
            return;
        }
        let hud = &mut self.hud;
        hud.set_space(1280.0, 720.0);
        hud.rect(0.0, 0.0, 1280.0, 720.0, [0.08, 0.05, 0.12, 1.0]);
        hud.text("The game stopped", 60.0, 50.0, 44.0, PINK, Align::Left);
        let mut y = 120.0;
        let text = self.play_error.clone();
        for line in hud.wrap(&text, 26.0, 1160.0).into_iter().take(18) {
            hud.text(&line, 60.0, y, 26.0, INK, Align::Left);
            y += 32.0;
        }
        hud.text(
            "MENU or B to return",
            640.0,
            660.0,
            28.0,
            YELLOW,
            Align::Center,
        );
        hud.flush();
    }

    /// One frame: gather inputs, advance, draw, present.
    pub fn frame(&mut self) -> Result<()> {
        let now = Instant::now();
        let dt = (now - self.last_frame).as_secs_f32().min(0.1);
        self.last_frame = now;

        self.poll_control();
        let mut state = self.gamepad.poll();
        state.buttons |= self.held_buttons;
        for (bit, frames) in &mut self.virtual_buttons {
            state.buttons |= *bit;
            *frames = frames.saturating_sub(1);
        }
        self.virtual_buttons.retain(|(_, frames)| *frames > 0);
        let pressed = state.buttons & !self.last_pad.buttons;
        self.last_pad = state;

        self.take_agent_events();
        self.take_recognition();
        for line in self.overlay.commands() {
            self.command(&line);
        }

        if self.stage == Stage::Room {
            if let Some((options, directory, reply)) = self.queued_run.take() {
                self.begin_test_run(&options, directory, reply);
            }
        }
        // A running test game advances once per frame in any stage but play.
        if self.stage == Stage::Room && self.test_run.is_some() {
            self.step_test_run();
        }

        let mut ui_buttons = 0;
        let mut show_ui = false;
        unsafe {
            match self.stage {
                Stage::Room => {
                    self.fade = (self.fade - dt * 3.0).max(0.0);
                    ui_buttons = pad::pocket_buttons(state.buttons);
                    show_ui = true;
                    self.draw_room(state, dt);
                    if pressed & pad::MENU != 0 {
                        // The UI owns quitting from the room; MENU reaches it as SELECT+START.
                        ui_buttons |= pad::pocket_buttons(pad::SELECT);
                    }
                }
                Stage::Entering(t) => {
                    let t = t + dt / 1.0;
                    self.step_play(state);
                    self.preview.bind();
                    self.draw_playing(PREVIEW);
                    glBindFramebuffer(FRAMEBUFFER, 0);
                    self.draw_room(state, dt);
                    self.fade = ((t - 0.7) / 0.3).clamp(0.0, 1.0);
                    self.stage = if t >= 1.0 {
                        Stage::Playing
                    } else {
                        Stage::Entering(t)
                    };
                }
                Stage::Playing => {
                    self.fade = (self.fade - dt * 4.0).max(0.0);
                    self.play_time += dt;
                    self.step_play(state);
                    glBindFramebuffer(FRAMEBUFFER, 0);
                    glViewport(0, 0, self.egl.width, self.egl.height);
                    if self.playing.is_some() {
                        self.draw_playing([self.egl.width, self.egl.height]);
                    } else {
                        glDisable(SCISSOR_TEST);
                        glClearColor(0.0, 0.0, 0.0, 1.0);
                        glClear(COLOR_BUFFER_BIT);
                    }
                    self.draw_play_error();
                    if self.play_time < 4.0 && self.playing.is_some() {
                        self.hud.set_space(1280.0, 720.0);
                        self.hud.text(
                            "MENU to leave",
                            1256.0,
                            16.0,
                            22.0,
                            [1.0, 1.0, 1.0, (4.0 - self.play_time).min(1.0) * 0.7],
                            Align::Right,
                        );
                        self.hud.flush();
                    }
                    let leave = pressed & pad::MENU != 0
                        || (self.playing.is_none() && pressed & pad::B != 0);
                    if leave {
                        self.stage = Stage::Leaving(0.0);
                        self.playing = None;
                        self.preview_live = true;
                        self.play_error.clear();
                        if let Some(pose) = self.room.pose("overview") {
                            self.room.rig.go(pose, 1.0);
                        }
                    }
                }
                Stage::Leaving(t) => {
                    let t = t + dt / 0.9;
                    self.draw_room(state, dt);
                    self.fade = (1.0 - t * 2.0).clamp(0.0, 1.0);
                    self.stage = if t >= 1.0 {
                        Stage::Room
                    } else {
                        Stage::Leaving(t)
                    };
                }
            }
            self.draw_fade();
            glBindVertexArray(0);
            glBindBuffer(ARRAY_BUFFER, 0);
            glBindBuffer(ELEMENT_ARRAY_BUFFER, 0);
        }
        self.push_state(dt);
        if show_ui {
            self.overlay.frame(ui_buttons)?;
        }
        if let Some(path) = self.pending_shot.take() {
            let png = unsafe { capture(self.egl.width, self.egl.height) };
            if let Err(error) = std::fs::write(&path, png) {
                eprintln!("pocket-studio: shot: {error}");
            }
        }
        self.egl.swap();

        self.stats_frames += 1;
        self.stats_max_ms = self.stats_max_ms.max(now.elapsed().as_secs_f32() * 1000.0);
        let window = self.stats_clock.elapsed().as_secs_f32();
        if window >= 5.0 {
            eprintln!(
                "pocket-studio: {:.1} fps, worst {:.1} ms, resident {} MB, stage {:?}, testing {}, case {:?}",
                self.stats_frames as f32 / window,
                self.stats_max_ms,
                resident_kb() / 1024,
                self.stage,
                self.test_run.is_some(),
                self.selected_case,
            );
            self.stats_clock = Instant::now();
            self.stats_frames = 0;
            self.stats_max_ms = 0.0;
        }
        Ok(())
    }
}

trait NonBlocking {
    fn custom_flags_nonblock(&mut self) -> &mut Self;
}

impl NonBlocking for std::fs::OpenOptions {
    fn custom_flags_nonblock(&mut self) -> &mut Self {
        use std::os::unix::fs::OpenOptionsExt;
        self.custom_flags(libc::O_NONBLOCK)
    }
}
