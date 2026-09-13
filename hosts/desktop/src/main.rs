//! Native platform adapter: window, input, clipboard and GPU presentation.
//! Guests, layout, composition and GPU recording belong to the runtime worker.
//! Text capabilities run in separately budgeted io.offload workers. No platform
//! text system participates in layout, shaping or drawing.
use anyhow::{Context as _, Result, anyhow};
use pocket_mod::Guest;
use pocket_ui_surface::{UiSurface, offload::OffloadWorker};
use serde::Deserialize;
use serde_json::{Value, json};
use std::{
    cmp::Reverse,
    collections::{HashMap, HashSet, VecDeque},
    path::PathBuf,
    sync::mpsc::{Receiver, SyncSender, sync_channel},
    sync::{
        Arc,
        atomic::{AtomicBool, Ordering},
    },
    thread,
    time::{Duration, Instant},
};
use winit::{
    application::ApplicationHandler,
    dpi::{LogicalPosition, LogicalSize},
    event::{ElementState, Ime, MouseButton, MouseScrollDelta, WindowEvent},
    event_loop::{ActiveEventLoop, EventLoop, EventLoopProxy},
    keyboard::{Key, ModifiersState, NamedKey},
    window::{CursorIcon, Window, WindowId},
};
mod gpu;
mod net;
include!("plan.rs");
include!("supervisor.rs");
include!("buttons.rs");

fn text_worker(pak: Vec<u8>) -> OffloadWorker {
    OffloadWorker::spawn(move || {
        let mut engine = pocket_text::Engine::new();
        engine.load_pak(&pak);
        move |record: &str| engine.reply(record)
    })
}

enum Input {
    Service(Value),
    Pointer(Value),
    Resize(u32, u32),
    Button(u32, bool),
    Reset,
    Quit,
}
// Reservation covers queued GPU work as well as the output channel.
struct OutputPermit(Arc<AtomicBool>);
impl OutputPermit {
    fn acquire(available: &Arc<AtomicBool>) -> Option<Self> {
        available
            .compare_exchange(true, false, Ordering::AcqRel, Ordering::Acquire)
            .ok()
            .map(|_| Self(available.clone()))
    }
}
impl Drop for OutputPermit {
    fn drop(&mut self) {
        self.0.store(true, Ordering::Release);
    }
}
struct Output {
    _permit: OutputPermit,
    tick: u64,
    target: Option<Arc<gpu::Target>>,
    intents: Vec<Value>,
}
#[derive(Debug)]
enum Wake {
    Output,
    Exit(Option<String>),
}

struct Runtime {
    args: Args,
    surface: UiSurface,
    guest: Guest,
    supervisor: AppSupervisor,
    offload: OffloadWorker,
    viewport: (u32, u32),
    ticks: u64,
    buttons: u32,
    script: Vec<ScriptEvent>,
    script_buttons: u32,
    script_mouse: bool,
    click_edge: bool,
    mouse_down: bool,
    wire: Option<net::SvcWire>,
}
impl Runtime {
    fn boot(args: Args) -> Result<Self> {
        if args.native_text {
            return Err(anyhow!(
                "text.layout.native is unavailable; use the portable text offload capability"
            ));
        }
        let pak = std::fs::read(resolve_asset(args.pak.clone(), &args.app, "pak")?)?;
        let source = std::fs::read_to_string(resolve_asset(args.js.clone(), &args.app, "js")?)?;
        let surface = UiSurface::new_with_density(
            (args.viewport.0 as f32, args.viewport.1 as f32),
            args.density,
        );
        surface.set_identity(HOST_ID, HOST_ABI);
        surface.set_tick_rate(60);
        surface.set_svc_allowlist(args.companions.clone());
        surface.feed_pak(&pak);
        let supervisor = AppSupervisor::new(args.system.as_ref(), &surface)?;
        let guest = Guest::new()?;
        surface.mount(&guest)?;
        let offload = text_worker(pak);
        offload.mount(&guest)?;
        guest.eval(&args.app, &source)?;
        if !guest.has_frame() {
            return Err(anyhow!("bundle installed no frame handler"));
        }
        surface.svc_push(
            json!({"t":"hello","w":args.viewport.0,"h":args.viewport.1,"epoch":epoch_ms()})
                .to_string(),
        );
        if let Some(file) = &args.file
            && let Ok(text) = std::fs::read_to_string(file)
        {
            surface.svc_push(json!({"t":"load","text":text}).to_string());
        }
        let wire = args
            .svc_connect
            .clone()
            .map(|addr| net::SvcWire::spawn(addr, args.app.clone()));
        Ok(Self {
            viewport: args.viewport,
            script: args.script.clone(),
            args,
            surface,
            guest,
            supervisor,
            offload,
            ticks: 0,
            buttons: 0,
            script_buttons: 0,
            script_mouse: false,
            click_edge: false,
            mouse_down: false,
            wire,
        })
    }
    fn svc(&self, event: Value) {
        self.surface.svc_push(event.to_string());
    }
    fn input(&mut self, input: Input) -> Result<bool> {
        match input {
            Input::Quit => return Ok(false),
            Input::Reset => {
                self.buttons = 0;
                for child in &mut self.supervisor.instances {
                    child.buttons = 0;
                }
                self.svc(json!({"t":"mouse","d":false}));
            }
            Input::Service(v) | Input::Pointer(v) => {
                if self.args.editor && v["t"] == "mouse" {
                    if v["b"] == 2 {
                        return Ok(true);
                    }
                    if let Some(down) = v["d"].as_bool() {
                        self.click_edge |= down && !self.mouse_down;
                        self.mouse_down = down;
                    }
                }
                self.svc(v);
            }
            Input::Button(bit, down) => {
                if !self.supervisor.set_focused_button(bit, down) {
                    if down {
                        self.buttons |= bit;
                    } else {
                        self.buttons &= !bit;
                    }
                }
            }
            Input::Resize(w, h) if !self.args.fixed => {
                self.viewport = (w, h);
                self.surface
                    .with_ui(|ui| ui.set_viewport(w as f32, h as f32));
                self.guest.eval(
                    "resize",
                    &format!("globalThis.__pocketResizeViewport?.({w},{h})"),
                )?;
                self.svc(json!({"t":"resize","w":w,"h":h}));
            }
            _ => {}
        }
        Ok(true)
    }
    fn tick(&mut self) -> Result<Vec<Value>> {
        if let Some(wire) = self.wire.as_mut() {
            for line in wire.drain() {
                self.surface.svc_push(line);
            }
        }
        self.run_script();
        if let Some((cps, start, dur)) = self.args.storm
            && self.ticks >= start
            && self.ticks < start + dur
        {
            let i = self.ticks - start;
            let n = ((i + 1) * cps as u64) / 60 - (i * cps as u64) / 60;
            if n > 0 {
                self.svc(json!({"t":"ch","s":"x".repeat(n.min(512) as usize)}));
            }
        }
        self.offload.begin_frame();
        let buttons = if self.args.editor {
            if self.mouse_down || self.script_mouse || self.click_edge {
                BTN_CIRCLE
            } else {
                0
            }
        } else {
            self.buttons | self.script_buttons
        };
        self.guest.frame(buttons)?;
        self.click_edge = false;
        self.surface.tick();
        for (id, error) in self
            .supervisor
            .sync(&self.surface)
            .into_iter()
            .chain(self.supervisor.tick())
        {
            log::error!("AppInstance {id}: {error}");
        }
        let mut intents = Vec::new();
        for line in self.surface.svc_drain() {
            if let Some(wire) = &self.wire {
                wire.send(line);
                continue;
            }
            if let Ok(v) = serde_json::from_str::<Value>(&line) {
                if v["t"] == "save" {
                    if let (Some(file), Some(text)) = (&self.args.file, v["text"].as_str()) {
                        let tmp = file.with_extension("tmp");
                        std::fs::write(&tmp, text)?;
                        std::fs::rename(tmp, file)?;
                    }
                } else {
                    intents.push(v);
                }
            }
        }
        self.ticks += 1;
        Ok(intents)
    }
    fn hash(&mut self) -> u64 {
        self.surface
            .with_ui(|ui| fnv1a64(&ui.draw().words) ^ ui.raster_revision().rotate_left(7))
            ^ self.supervisor.visible_hash().rotate_left(17)
            ^ ((self.viewport.0 as u64) << 32 | self.viewport.1 as u64)
    }
    fn run_script(&mut self) {
        let tick = self.ticks;
        for ev in self.script.clone() {
            match ev {
                ScriptEvent::Type(t, s) if t == tick => {
                    self.svc(serde_json::json!({"t": "ch", "s": s}))
                }
                ScriptEvent::Click(t, x, y) if t == tick => {
                    self.svc(serde_json::json!({"t": "mouse", "x": x, "y": y, "d": true}));
                    self.svc(serde_json::json!({"t": "mouse", "x": x, "y": y, "d": false}));
                    self.click_edge = true;
                }
                // Held for 6 ticks so edge-detected button handlers latch.
                ScriptEvent::Press(t, bit) if tick >= t && tick < t + 6 => {
                    self.script_buttons |= bit;
                }
                ScriptEvent::Press(t, bit) if tick == t + 6 => {
                    self.script_buttons &= !bit;
                }
                ScriptEvent::Mouse(t, x, y, kind) if t == tick => {
                    if kind == 'r' {
                        // Right click: press + release in one tick (b:2 lines).
                        self.svc(serde_json::json!(
                            {"t": "mouse", "x": x, "y": y, "d": true, "b": 2, "sh": false}
                        ));
                        self.svc(serde_json::json!(
                            {"t": "mouse", "x": x, "y": y, "d": false, "b": 2, "sh": false}
                        ));
                    } else {
                        let down = match kind {
                            'd' => {
                                self.script_mouse = true;
                                true
                            }
                            'u' => {
                                self.script_mouse = false;
                                false
                            }
                            _ => self.script_mouse,
                        };
                        self.svc(serde_json::json!(
                            {"t": "mouse", "x": x, "y": y, "d": down, "sh": false}
                        ));
                    }
                }
                ScriptEvent::Key(t, ref k, cmd, alt, ctl, sh) if t == tick => {
                    self.svc(serde_json::json!(
                        {"t": "key", "k": k, "cmd": cmd, "sh": sh, "alt": alt, "ctl": ctl}
                    ));
                }
                _ => {}
            }
        }
    }
}
fn run_runtime(
    args: Args,
    inputs: Receiver<Input>,
    outputs: SyncSender<Output>,
    proxy: EventLoopProxy<Wake>,
    gpu: Arc<pocket3d::gpu::Gpu>,
) -> Result<()> {
    let available = Arc::new(AtomicBool::new(true));
    let mut renderer = gpu::Renderer::new(gpu);
    let mut runtime = Runtime::boot(args)?;
    let mut hash = None;
    let mut intents = Vec::new();
    let mut deadline = Instant::now();
    loop {
        for input in inputs.try_iter().take(256) {
            if !runtime.input(input)? {
                return Ok(());
            }
        }
        let work_start = Instant::now();
        intents.extend(runtime.tick()?);
        trace_frame(runtime.args.trace_frames, "tick", runtime.ticks, work_start);
        if intents.iter().any(|v| v["t"] == "quit") {
            return Ok(());
        }
        if intents.len() > 128 {
            return Err(anyhow!("Host intent queue exceeded budget"));
        }
        let next = runtime.hash();
        if (hash != Some(next) || !intents.is_empty())
            && let Some(permit) = OutputPermit::acquire(&available)
        {
            let target = if hash != Some(next) {
                let start = Instant::now();
                let frame = renderer.render(&mut runtime)?;
                trace_frame(
                    runtime.args.trace_frames,
                    "render-submit",
                    runtime.ticks,
                    start,
                );
                frame
            } else {
                None
            };
            let rendered = target.is_some();
            let output = Output {
                _permit: permit,
                tick: runtime.ticks,
                target,
                intents: std::mem::take(&mut intents),
            };
            match outputs.try_send(output) {
                Ok(()) => {
                    if rendered {
                        hash = Some(next);
                    }
                    let _ = proxy.send_event(Wake::Output);
                }
                Err(std::sync::mpsc::TrySendError::Full(output)) => intents = output.intents,
                Err(_) => return Ok(()),
            }
        }
        trace_frame(runtime.args.trace_frames, "work", runtime.ticks, work_start);
        if runtime
            .args
            .quit_after_ticks
            .is_some_and(|n| runtime.ticks >= n)
        {
            return Ok(());
        }
        deadline += Duration::from_nanos(1_000_000_000 / 60);
        if let Some(wait) = deadline.checked_duration_since(Instant::now()) {
            thread::sleep(wait);
        } else {
            deadline = Instant::now();
        }
    }
}
struct RuntimeStartup {
    args: Args,
    inputs: Receiver<Input>,
    outputs: SyncSender<Output>,
    proxy: EventLoopProxy<Wake>,
}
struct Host {
    window: Option<Arc<Window>>,
    surface: Option<gpu::Presentation>,
    startup: Option<RuntimeStartup>,
    tx: SyncSender<Input>,
    rx: Receiver<Output>,
    pending: VecDeque<Input>,
    frame: Option<(u64, Arc<gpu::Target>)>,
    title: String,
    viewport: (u32, u32),
    fixed: bool,
    modifiers: ModifiersState,
    pointer: (f64, f64),
    down: bool,
    ime: bool,
    clipboard: Option<arboard::Clipboard>,
    ready: bool,
    announce_ready: bool,
    trace_frames: bool,
    failure: Option<String>,
}
impl Host {
    fn send(&mut self, input: Input) {
        // Coalesce only motion; button and key edges retain FIFO order.
        if let Input::Pointer(value) = &input
            && let Some(Input::Pointer(last)) = self.pending.back_mut()
        {
            *last = value.clone();
            self.flush();
            return;
        }
        if self.pending.len() < 256 {
            self.pending.push_back(input);
        } else {
            self.pending.clear();
            self.pending.push_back(Input::Reset);
        }
        self.flush();
    }
    fn flush(&mut self) {
        while let Some(input) = self.pending.pop_front() {
            match self.tx.try_send(input) {
                Ok(()) => {}
                Err(std::sync::mpsc::TrySendError::Full(input)) => {
                    self.pending.push_front(input);
                    break;
                }
                Err(_) => break,
            }
        }
    }
    fn key_name(key: &Key) -> String {
        match key {
            Key::Character(s) => s.to_lowercase(),
            Key::Named(n) => match n {
                NamedKey::ArrowUp => "up",
                NamedKey::ArrowDown => "down",
                NamedKey::ArrowLeft => "left",
                NamedKey::ArrowRight => "right",
                NamedKey::Enter => "enter",
                NamedKey::Escape => "escape",
                NamedKey::Backspace => "backspace",
                NamedKey::Delete => "delete",
                NamedKey::Tab => "tab",
                NamedKey::Space => "space",
                NamedKey::Home => "home",
                NamedKey::End => "end",
                NamedKey::PageUp => "pageup",
                NamedKey::PageDown => "pagedown",
                _ => "",
            }
            .into(),
            _ => String::new(),
        }
    }
    fn present(&mut self) -> Result<()> {
        let (Some(surface), Some(window), Some(frame)) =
            (&mut self.surface, &self.window, &self.frame)
        else {
            return Ok(());
        };
        let (tick, target) = frame;
        let start = Instant::now();
        if !surface.present(window, target)? {
            return Ok(());
        }
        trace_frame(self.trace_frames, "present-submit", *tick, start);
        if !self.ready {
            self.ready = true;
            if self.announce_ready {
                println!("READY {}", epoch_ms());
            }
        }
        Ok(())
    }
}
impl ApplicationHandler<Wake> for Host {
    fn resumed(&mut self, event_loop: &ActiveEventLoop) {
        if self.window.is_some() {
            return;
        }
        let window = Arc::new(
            event_loop
                .create_window(
                    Window::default_attributes()
                        .with_title(&self.title)
                        .with_inner_size(LogicalSize::new(self.viewport.0, self.viewport.1))
                        .with_resizable(!self.fixed),
                )
                .expect("create window"),
        );
        window.set_ime_allowed(true);
        let presentation = match gpu::Presentation::new(window.clone()) {
            Ok(presentation) => presentation,
            Err(error) => {
                self.failure = Some(format!("GPU initialization: {error:#}"));
                event_loop.exit();
                return;
            }
        };
        let gpu = presentation.gpu.clone();
        self.surface = Some(presentation);
        let RuntimeStartup {
            args,
            inputs,
            outputs,
            proxy,
        } = self.startup.take().expect("runtime startup");
        if let Err(error) = thread::Builder::new()
            .name("pocket-runtime".into())
            .spawn(move || {
                let result = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
                    run_runtime(args, inputs, outputs, proxy.clone(), gpu)
                }))
                .unwrap_or_else(|_| Err(anyhow!("Runtime worker panicked")));
                let _ = proxy.send_event(Wake::Exit(result.err().map(|e| format!("{e:#}"))));
            })
        {
            self.failure = Some(format!("Runtime startup: {error}"));
            event_loop.exit();
        }
        self.window = Some(window);
    }
    fn user_event(&mut self, event_loop: &ActiveEventLoop, event: Wake) {
        match event {
            Wake::Exit(error) => {
                if let Some(error) = error {
                    log::error!("{error}");
                    self.failure = Some(error);
                }
                event_loop.exit();
            }
            Wake::Output => {
                while let Ok(mut output) = self.rx.try_recv() {
                    for v in std::mem::take(&mut output.intents) {
                        match v["t"].as_str() {
                            Some("copy") => {
                                if let (Some(clipboard), Some(text)) =
                                    (&mut self.clipboard, v["text"].as_str())
                                {
                                    let _ = clipboard.set_text(text);
                                }
                            }
                            Some("paste-req") => {
                                if let Some(Ok(text)) =
                                    self.clipboard.as_mut().map(|c| c.get_text())
                                {
                                    self.send(Input::Service(json!({"t":"paste","text":text})));
                                }
                            }
                            Some("caret") => {
                                if let Some(window) = &self.window {
                                    window.set_ime_cursor_area(
                                        LogicalPosition::new(
                                            v["x"].as_f64().unwrap_or(0.0),
                                            v["y"].as_f64().unwrap_or(0.0),
                                        ),
                                        LogicalSize::new(1.0, v["h"].as_f64().unwrap_or(16.0)),
                                    );
                                }
                            }
                            Some("cursor") => {
                                if let Some(window) = &self.window {
                                    window.set_cursor(match v["k"].as_str().unwrap_or("") {
                                        "text" => CursorIcon::Text,
                                        "pointer" => CursorIcon::Pointer,
                                        "move" => CursorIcon::Move,
                                        "grabbing" => CursorIcon::Grabbing,
                                        "ew" => CursorIcon::EwResize,
                                        "ns" => CursorIcon::NsResize,
                                        "nwse" => CursorIcon::NwseResize,
                                        "nesw" => CursorIcon::NeswResize,
                                        _ => CursorIcon::Default,
                                    });
                                }
                            }
                            _ => {}
                        }
                    }
                    if let Some(target) = output.target.take() {
                        self.frame = Some((output.tick, target));
                        if let Some(window) = &self.window {
                            window.request_redraw();
                        }
                    }
                }
            }
        }
        self.flush();
    }
    fn about_to_wait(&mut self, event_loop: &ActiveEventLoop) {
        self.flush();
        event_loop.set_control_flow(winit::event_loop::ControlFlow::Wait);
        if !self.pending.is_empty() {
            event_loop.set_control_flow(winit::event_loop::ControlFlow::WaitUntil(
                Instant::now() + Duration::from_millis(8),
            ));
        }
    }
    fn window_event(&mut self, event_loop: &ActiveEventLoop, _: WindowId, event: WindowEvent) {
        match event {
            WindowEvent::CloseRequested => {
                self.send(Input::Quit);
                event_loop.exit();
            }
            WindowEvent::RedrawRequested => {
                if let Err(error) = self.present() {
                    log::error!("{error}");
                    self.failure = Some(error.to_string());
                    event_loop.exit();
                }
            }
            WindowEvent::Resized(size) => {
                let scale = self.window.as_ref().unwrap().scale_factor();
                self.send(Input::Resize(
                    (size.width as f64 / scale).round().clamp(240.0, 4096.0) as u32,
                    (size.height as f64 / scale).round().clamp(180.0, 4096.0) as u32,
                ));
                self.window.as_ref().unwrap().request_redraw();
            }
            WindowEvent::ModifiersChanged(m) => self.modifiers = m.state(),
            WindowEvent::Focused(false) => {
                self.down = false;
                self.send(Input::Reset);
            }
            WindowEvent::CursorMoved { position, .. } => {
                let scale = self.window.as_ref().unwrap().scale_factor();
                self.pointer = (position.x / scale, position.y / scale);
                self.send(Input::Pointer(json!({"t":"mouse","x":self.pointer.0,"y":self.pointer.1,"d":self.down,"sh":self.modifiers.shift_key()})));
            }
            WindowEvent::MouseInput { state, button, .. } => {
                if button == MouseButton::Left {
                    self.down = state == ElementState::Pressed;
                }
                self.send(Input::Service(json!({"t":"mouse","x":self.pointer.0,"y":self.pointer.1,"d":state==ElementState::Pressed,"b":if button==MouseButton::Right{2}else{0},"sh":self.modifiers.shift_key()})));
            }
            WindowEvent::MouseWheel { delta, .. } => {
                let dy = match delta {
                    MouseScrollDelta::LineDelta(_, y) => -(y as f64) * 24.0,
                    MouseScrollDelta::PixelDelta(p) => -p.y,
                };
                self.send(Input::Service(json!({"t":"scroll","dy":dy})));
            }
            WindowEvent::Ime(Ime::Enabled) => {}
            WindowEvent::Ime(Ime::Disabled) => self.ime = false,
            WindowEvent::Ime(Ime::Preedit(s, cursor)) => {
                self.ime = !s.is_empty();
                let c = cursor
                    .map(|(start, _)| s[..start].encode_utf16().count())
                    .unwrap_or(0);
                self.send(Input::Service(json!({"t":"ime","s":s,"c":c})));
            }
            WindowEvent::Ime(Ime::Commit(s)) => {
                self.ime = false;
                self.send(Input::Service(json!({"t":"ime","s":"","c":0})));
                self.send(Input::Service(json!({"t":"ch","s":s})));
            }
            WindowEvent::KeyboardInput { event, .. } => {
                let name = Self::key_name(&event.logical_key);
                let down = event.state == ElementState::Pressed;
                let cmd = if cfg!(target_os = "macos") {
                    self.modifiers.super_key()
                } else {
                    self.modifiers.control_key()
                };
                if let Some(bit) = button_for(&name) {
                    self.send(Input::Button(bit, down));
                }
                if down {
                    if cmd && name == "q" {
                        self.send(Input::Quit);
                        event_loop.exit();
                        return;
                    }
                    if cmd && name == "v" {
                        if let Some(Ok(text)) = self.clipboard.as_mut().map(|c| c.get_text()) {
                            self.send(Input::Service(json!({"t":"paste","text":text})));
                        }
                        return;
                    }
                    self.send(Input::Service(json!({"t":"key","k":if cmd {name.clone()} else {match &event.logical_key {Key::Named(n)=>format!("{n:?}").replace("Arrow", ""),_=>name.clone()}},"cmd":cmd,"ctl":self.modifiers.control_key(),"alt":self.modifiers.alt_key(),"sh":self.modifiers.shift_key()})));
                    if !self.ime
                        && !cmd
                        && !self.modifiers.control_key()
                        && let Some(text) = event.text
                        && !text.chars().any(char::is_control)
                    {
                        self.send(Input::Service(json!({"t":"ch","s":text.as_str()})));
                    }
                }
            }
            _ => {}
        }
    }
}
fn main() -> Result<()> {
    env_logger::Builder::from_env(env_logger::Env::default().default_filter_or("info")).init();
    let args = parse_args()?;
    let event_loop = EventLoop::<Wake>::with_user_event().build()?;
    let (tx, inputs) = sync_channel(256);
    let (outputs, rx) = sync_channel(1);
    let mut host = Host {
        window: None,
        surface: None,
        startup: None,
        tx,
        rx,
        pending: VecDeque::new(),
        frame: None,
        title: args.title.clone(),
        viewport: args.viewport,
        fixed: args.fixed,
        modifiers: ModifiersState::empty(),
        pointer: (0.0, 0.0),
        down: false,
        ime: false,
        clipboard: arboard::Clipboard::new().ok(),
        ready: false,
        announce_ready: args.announce_ready,
        trace_frames: args.trace_frames,
        failure: None,
    };
    host.startup = Some(RuntimeStartup {
        args,
        inputs,
        outputs,
        proxy: event_loop.create_proxy(),
    });
    event_loop.run_app(&mut host)?;
    if let Some(error) = host.failure {
        return Err(anyhow!(error));
    }
    Ok(())
}

// These are CPU submission durations, not GPU completion or display latency.
fn trace_frame(enabled: bool, stage: &str, tick: u64, start: Instant) {
    if enabled {
        let elapsed = start.elapsed().as_micros();
        let wall = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap_or_default()
            .as_micros();
        eprintln!("FRAME_TRACE,{stage},{tick},{wall},{elapsed}");
    }
}

include!("tests.rs");
