//! The agent loop's host. The loop itself is `agent/harness.ts`, run on this
//! thread in a QuickJS runtime capped at a few megabytes: it never holds a
//! screenshot or a stream. Model turns and tool work block this thread only.
use crate::{
    files,
    llm::{Delta, Llm},
};
use anyhow::Result;
use pocket_arcade::script;
use rquickjs::{
    allocator::{Allocator, RustAllocator},
    function::Func,
    CatchResultExt, CaughtError, Context, Object, Runtime,
};
use serde_json::{json, Value};
use std::{
    cell::RefCell,
    path::{Path, PathBuf},
    rc::Rc,
    sync::{
        atomic::{AtomicBool, AtomicUsize, Ordering},
        mpsc::{self, Sender},
        Arc,
    },
    thread::JoinHandle,
    time::Instant,
};

const HARNESS: &str = include_str!("../agent/harness.ts");
const HEAP_LIMIT: usize = 12 * 1024 * 1024;

#[derive(Debug)]
pub enum Event {
    Status(String),
    Line {
        kind: String,
        text: String,
    },
    Stream(String),
    Usage {
        input: u64,
        output: u64,
        cached: u64,
    },
    /// Run the game in `directory` and answer on `reply`.
    Run {
        options: Value,
        directory: PathBuf,
        reply: Sender<RunReply>,
    },
    Finished {
        summary: String,
        meta: Value,
    },
    Failed(String),
    Stopped {
        heap_peak: usize,
    },
}

#[derive(Debug, Default)]
pub struct RunReply {
    pub report: Value,
    pub shots: Vec<Vec<u8>>,
}

pub struct Task {
    pub prompt: String,
    pub directory: PathBuf,
    pub previous_summary: Option<String>,
    pub data: PathBuf,
}

pub struct AgentHandle {
    pub cancel: Arc<AtomicBool>,
    pub thread: Option<JoinHandle<()>>,
}

impl AgentHandle {
    pub fn start(task: Task, events: Sender<Event>) -> Self {
        let cancel = Arc::new(AtomicBool::new(false));
        let flag = cancel.clone();
        let thread = std::thread::Builder::new()
            .name("agent".into())
            .stack_size(2 * 1024 * 1024)
            .spawn(move || {
                // Whatever ends the loop, the screen hears that it ended.
                let mut heap_peak = 0;
                let outcome = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
                    run(&task, &events, &flag, &mut heap_peak)
                }));
                let failure = match outcome {
                    Ok(Ok(())) => None,
                    Ok(Err(error)) => Some(format!("{error:#}")),
                    Err(_) => Some("the agent loop panicked".to_owned()),
                };
                if let Some(failure) = failure {
                    let _ = events.send(Event::Failed(failure));
                }
                let _ = events.send(Event::Stopped { heap_peak });
            })
            .expect("agent thread");
        Self {
            cancel,
            thread: Some(thread),
        }
    }

    pub fn is_running(&self) -> bool {
        self.thread
            .as_ref()
            .is_some_and(|thread| !thread.is_finished())
    }
}

/// Counts the harness heap through its allocator: the runtime's own usage query
/// cannot run inside a host call, which is where the loop spends its life.
struct CountingAllocator {
    inner: RustAllocator,
    used: Arc<AtomicUsize>,
    peak: Arc<AtomicUsize>,
}

unsafe impl Allocator for CountingAllocator {
    fn alloc(&mut self, size: usize) -> *mut u8 {
        let pointer = self.inner.alloc(size);
        if !pointer.is_null() {
            let used = self.used.fetch_add(
                unsafe { RustAllocator::usable_size(pointer) },
                Ordering::Relaxed,
            );
            self.peak.fetch_max(used + size, Ordering::Relaxed);
        }
        pointer
    }
    fn calloc(&mut self, count: usize, size: usize) -> *mut u8 {
        let pointer = self.inner.calloc(count, size);
        if !pointer.is_null() {
            let used = self.used.fetch_add(
                unsafe { RustAllocator::usable_size(pointer) },
                Ordering::Relaxed,
            );
            self.peak.fetch_max(used + count * size, Ordering::Relaxed);
        }
        pointer
    }
    unsafe fn dealloc(&mut self, pointer: *mut u8) {
        self.used
            .fetch_sub(RustAllocator::usable_size(pointer), Ordering::Relaxed);
        self.inner.dealloc(pointer);
    }
    unsafe fn realloc(&mut self, pointer: *mut u8, new_size: usize) -> *mut u8 {
        let before = if pointer.is_null() {
            0
        } else {
            RustAllocator::usable_size(pointer)
        };
        let moved = self.inner.realloc(pointer, new_size);
        if !moved.is_null() {
            let after = RustAllocator::usable_size(moved);
            let used = self.used.fetch_add(after, Ordering::Relaxed) + after - before;
            self.used.fetch_sub(before, Ordering::Relaxed);
            self.peak.fetch_max(used, Ordering::Relaxed);
        }
        moved
    }
    unsafe fn usable_size(pointer: *mut u8) -> usize {
        RustAllocator::usable_size(pointer)
    }
}

struct Shared {
    next_shot: u32,
    llm: Llm,
    root: PathBuf,
    events: Sender<Event>,
    cancel: Arc<AtomicBool>,
    finished: bool,
}

fn run(
    task: &Task,
    events: &Sender<Event>,
    cancel: &Arc<AtomicBool>,
    heap_peak: &mut usize,
) -> Result<()> {
    let llm = Llm::new(&task.data)?;
    std::fs::create_dir_all(&task.directory)?;
    let _ = events.send(Event::Status(format!(
        "{} at {}",
        llm.config.model, llm.config.effort
    )));
    let peak = Arc::new(AtomicUsize::new(0));
    let runtime = Runtime::new_with_alloc(CountingAllocator {
        inner: RustAllocator,
        used: Arc::new(AtomicUsize::new(0)),
        peak: peak.clone(),
    })?;
    let shared = Rc::new(RefCell::new(Shared {
        next_shot: 0,
        llm,
        root: task.directory.clone(),
        events: events.clone(),
        cancel: cancel.clone(),
        finished: false,
    }));
    runtime.set_memory_limit(HEAP_LIMIT);
    runtime.set_max_stack_size(256 * 1024);
    runtime.set_gc_threshold(512 * 1024);
    let stop = cancel.clone();
    runtime.set_interrupt_handler(Some(Box::new(move || stop.load(Ordering::Relaxed))));
    let context = Context::full(&runtime)?;

    let override_path = task.data.join("harness.ts");
    let source = std::fs::read_to_string(&override_path).unwrap_or_else(|_| HARNESS.to_owned());
    let harness = script::strip("harness.ts", &source).map_err(|error| anyhow::anyhow!(error))?;

    let brief = json!({
        "prompt": task.prompt,
        "previousSummary": task.previous_summary,
        "files": files::list(&task.directory),
        "types": pocket_arcade::game::SDK_TYPES,
    })
    .to_string();

    let outcome: Result<(), String> = context.with(|ctx| {
        mount(&ctx, shared.clone()).map_err(|error| error.to_string())?;
        ctx.eval::<(), _>(harness.code.as_bytes().to_vec())
            .catch(&ctx)
            .map_err(describe)?;
        let main: rquickjs::Function = ctx.globals().get("main").catch(&ctx).map_err(describe)?;
        main.call::<_, ()>((brief,)).catch(&ctx).map_err(describe)
    });
    if cancel.load(Ordering::Relaxed) {
        let _ = events.send(Event::Failed("cancelled".to_owned()));
    } else if let Err(error) = outcome {
        let _ = events.send(Event::Failed(error));
    } else if !shared.borrow().finished {
        let _ = events.send(Event::Failed(
            "the agent stopped without finishing".to_owned(),
        ));
    }
    *heap_peak = peak.load(Ordering::Relaxed);
    Ok(())
}

fn describe(error: CaughtError<'_>) -> String {
    match error {
        CaughtError::Exception(exception) => format!(
            "{}\n{}",
            exception.message().unwrap_or_default(),
            exception.stack().unwrap_or_default()
        ),
        other => other.to_string(),
    }
}

fn mount(ctx: &rquickjs::Ctx<'_>, shared: Rc<RefCell<Shared>>) -> rquickjs::Result<()> {
    let host = Object::new(ctx.clone())?;

    let s = shared.clone();
    host.set(
        "status",
        Func::from(move |text: String| {
            let _ = s.borrow().events.send(Event::Status(text));
        }),
    )?;
    let s = shared.clone();
    host.set(
        "line",
        Func::from(move |kind: String, text: String| {
            let _ = s.borrow().events.send(Event::Line { kind, text });
        }),
    )?;

    // One model turn: request JSON in, `{items, input, output, cached}` or
    // `{error}` out. Deltas go straight to the screen.
    let s = shared.clone();
    host.set("model", Func::from(move |request: String| -> String {
        let shared = &mut *s.borrow_mut();
        let Ok(request) = serde_json::from_str::<Value>(&request) else {
            return json!({ "error": "bad request JSON" }).to_string();
        };
        let events = shared.events.clone();
        let started = Instant::now();
        let mut bytes = 0usize;
        let mut on_delta = |delta: Delta| match delta {
            Delta::Text(text) | Delta::Thinking(text) => {
                let _ = events.send(Event::Stream(text));
            }
            Delta::ToolArguments(count) => {
                bytes += count;
                if bytes % 2048 < count {
                    let _ = events.send(Event::Status(format!("writing code: {} KB", bytes / 1024)));
                }
            }
        };
        match shared.llm.respond(request, &shared.cancel, &mut on_delta) {
            Ok(reply) => {
                let _ = events.send(Event::Usage { input: reply.input_tokens, output: reply.output_tokens, cached: reply.cached_tokens });
                json!({ "items": reply.items, "input": reply.input_tokens, "output": reply.output_tokens, "cached": reply.cached_tokens, "seconds": started.elapsed().as_secs_f32() }).to_string()
            }
            Err(error) => json!({ "error": format!("{error:#}") }).to_string(),
        }
    }))?;

    let s = shared.clone();
    host.set(
        "listFiles",
        Func::from(move || -> String { files::list(&s.borrow().root) }),
    )?;
    let s = shared.clone();
    host.set(
        "readFile",
        Func::from(move |path: String| -> String {
            files::read(&s.borrow().root, &path).unwrap_or_else(|error| format!("ERROR: {error}"))
        }),
    )?;
    let s = shared.clone();
    host.set(
        "writeFile",
        Func::from(move |path: String, content: String| -> String {
            files::write(&s.borrow().root, &path, &content)
                .unwrap_or_else(|error| format!("ERROR: {error}"))
        }),
    )?;
    let s = shared.clone();
    host.set(
        "editFile",
        Func::from(move |path: String, old: String, new: String| -> String {
            files::edit(&s.borrow().root, &path, &old, &new)
                .unwrap_or_else(|error| format!("ERROR: {error}"))
        }),
    )?;

    // Run the game on the console's screen; screenshots stay on this side.
    let s = shared.clone();
    host.set(
        "runGame",
        Func::from(move |options: String| -> String {
            let shared = &mut *s.borrow_mut();
            let options: Value = serde_json::from_str(&options).unwrap_or(Value::Null);
            let (reply, answer) = mpsc::channel();
            if shared
                .events
                .send(Event::Run {
                    options,
                    directory: shared.root.clone(),
                    reply,
                })
                .is_err()
            {
                return json!({ "ok": false, "error": "the main loop has gone" }).to_string();
            }
            let Ok(result) = answer.recv() else {
                return json!({ "ok": false, "error": "the run was abandoned" }).to_string();
            };
            let mut report = result.report;
            let mut names = Vec::new();
            for png in result.shots {
                let name = format!("shot-{}", shared.next_shot);
                shared.next_shot += 1;
                shared.llm.store_image(name.clone(), png);
                names.push(name);
            }
            report["images"] = json!(names);
            report.to_string()
        }),
    )?;
    let s = shared.clone();
    host.set(
        "forgetImage",
        Func::from(move |name: String| s.borrow_mut().llm.forget_image(&name)),
    )?;

    let s = shared.clone();
    host.set(
        "finish",
        Func::from(move |meta: String| {
            let shared = &mut *s.borrow_mut();
            shared.finished = true;
            let meta: Value = serde_json::from_str(&meta).unwrap_or(Value::Null);
            let _ = std::fs::write(
                shared.root.join("game.json"),
                serde_json::to_vec_pretty(&meta).unwrap_or_default(),
            );
            let summary = meta["summary"].as_str().unwrap_or("").to_owned();
            let _ = shared.events.send(Event::Finished { summary, meta });
        }),
    )?;

    let s = shared;
    host.set(
        "cancelled",
        Func::from(move || s.borrow().cancel.load(Ordering::Relaxed)),
    )?;
    ctx.globals().set("host", host)?;

    let console = Object::new(ctx.clone())?;
    console.set(
        "log",
        Func::from(|text: String| eprintln!("harness: {text}")),
    )?;
    ctx.globals().set("console", console)?;
    Ok(())
}

/// A headless check of the loop, for a computer or an `adb shell`: runs one task
/// with `run_game` answered from a stub, printing what the screen would show.
pub fn cli(prompt: &str, data: &Path, directory: &Path) -> Result<()> {
    let (events, inbox) = mpsc::channel();
    let handle = AgentHandle::start(
        Task {
            prompt: prompt.to_owned(),
            directory: directory.to_owned(),
            previous_summary: None,
            data: data.to_owned(),
        },
        events,
    );
    for event in inbox {
        match event {
            Event::Status(text) => eprintln!("[status] {text}"),
            Event::Line { kind, text } => eprintln!("[{kind}] {text}"),
            Event::Stream(text) => eprint!("{text}"),
            Event::Usage {
                input,
                output,
                cached,
            } => eprintln!("\n[usage] in {input} (cached {cached}) out {output}"),
            Event::Run { reply, .. } => {
                let _ = reply.send(RunReply { report: json!({ "ok": true, "ticks": 0, "logs": [], "note": "no screen in this mode: the game did not run" }), shots: Vec::new() });
            }
            Event::Finished { summary, .. } => eprintln!("[finished] {summary}"),
            Event::Failed(text) => eprintln!("[failed] {text}"),
            Event::Stopped { heap_peak } => {
                eprintln!("[stopped] harness heap {} KB", heap_peak / 1024);
                break;
            }
        }
    }
    drop(handle);
    Ok(())
}
