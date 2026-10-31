//! One game: a QuickJS runtime of its own, the shared entity array, and the
//! host calls that fill a frame. The host ticks it at a fixed 60 Hz.
use crate::{
    hud::Align,
    script,
    shapes::Shape,
    synth::Voice,
    world::{self, Particle, Scene, MAX_ENTITIES, STRIDE},
};
use rquickjs::{
    function::{Func, Rest},
    loader::{Loader, Resolver},
    module::Declared,
    CatchResultExt, CaughtError, Context, Ctx, Function, Module, Object, Runtime, TypedArray,
    Value,
};
use std::{
    cell::RefCell,
    collections::VecDeque,
    path::{Path, PathBuf},
    rc::Rc,
    sync::{
        atomic::{AtomicI64, Ordering},
        Arc,
    },
    time::{SystemTime, UNIX_EPOCH},
};

/// The module games import the SDK from.
pub const SDK_MODULE: &str = "@pocketjs/framework/arcade";
pub const SDK_SOURCE: &str = include_str!("../ts/arcade.ts");
pub const SDK_TYPES: &str = include_str!("../ts/arcade.d.ts");

const HEAP_LIMIT: usize = 48 * 1024 * 1024;
const STACK_LIMIT: usize = 512 * 1024;
const TURN_LIMIT_MS: i64 = 4000;
const LOG_LINES: usize = 200;

#[derive(Clone, Debug)]
pub enum HudCommand {
    Rect {
        x: f32,
        y: f32,
        w: f32,
        h: f32,
        color: [f32; 4],
    },
    Text {
        text: String,
        x: f32,
        y: f32,
        px: f32,
        color: [f32; 4],
        align: Align,
    },
}

/// What a game produces, read by the host once per frame.
#[derive(Default)]
pub struct Frame {
    pub scene: Scene,
    pub hud: Vec<HudCommand>,
    pub particles: Vec<Particle>,
    pub meshes: Vec<(usize, Shape)>,
    pub voices: Vec<Voice>,
    pub logs: VecDeque<String>,
    pub seed: u32,
    next_mesh: usize,
    pub quit: bool,
}

/// Button bits the SDK reads, in `input.ts` order.
#[derive(Clone, Copy, Default, Debug, PartialEq)]
pub struct Pad {
    pub buttons: u32,
    pub axes: [f32; 4],
    pub triggers: [f32; 2],
}

pub struct Game {
    runtime: Runtime,
    context: Context,
    pub frame: Rc<RefCell<Frame>>,
    deadline: Arc<AtomicI64>,
    entities: Vec<f32>,
    pub tick: u64,
    pub heap_peak: usize,
    pub directory: PathBuf,
}

fn now_ms() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_or(0, |time| time.as_millis() as i64)
}

fn color(value: u32, alpha: f32) -> [f32; 4] {
    [
        ((value >> 16) & 255) as f32 / 255.0,
        ((value >> 8) & 255) as f32 / 255.0,
        (value & 255) as f32 / 255.0,
        alpha,
    ]
}

struct GameResolver;
impl Resolver for GameResolver {
    fn resolve<'js>(
        &mut self,
        _: &Ctx<'js>,
        base: &str,
        name: &str,
        _: Option<rquickjs::loader::ImportAttributes<'js>>,
    ) -> rquickjs::Result<String> {
        if name == SDK_MODULE {
            return Ok(name.to_owned());
        }
        if !name.starts_with('.') {
            return Err(rquickjs::Error::new_resolving_message(
                base,
                name,
                "games import only relative files and @pocketjs/framework/arcade",
            ));
        }
        let parent = Path::new(base).parent().unwrap_or(Path::new(""));
        let mut parts: Vec<String> = Vec::new();
        for part in parent.join(name).components() {
            match part {
                std::path::Component::ParentDir => {
                    if parts.pop().is_none() {
                        return Err(rquickjs::Error::new_resolving_message(
                            base,
                            name,
                            "import leaves the game's directory",
                        ));
                    }
                }
                std::path::Component::Normal(value) => {
                    parts.push(value.to_string_lossy().into_owned())
                }
                _ => {}
            }
        }
        let mut path = parts.join("/");
        if Path::new(&path).extension().is_none() {
            path.push_str(".ts");
        }
        Ok(path)
    }
}

struct GameLoader {
    directory: PathBuf,
}
impl Loader for GameLoader {
    fn load<'js>(
        &mut self,
        ctx: &Ctx<'js>,
        name: &str,
        _: Option<rquickjs::loader::ImportAttributes<'js>>,
    ) -> rquickjs::Result<Module<'js, Declared>> {
        let source = if name == SDK_MODULE {
            SDK_SOURCE.to_owned()
        } else {
            std::fs::read_to_string(self.directory.join(name))
                .map_err(|error| rquickjs::Error::new_loading_message(name, error.to_string()))?
        };
        let label = if name == SDK_MODULE {
            "arcade.ts"
        } else {
            name
        };
        let stripped = script::strip(label, &source)
            .map_err(|error| rquickjs::Error::new_loading_message(name, error))?;
        Module::declare(ctx.clone(), name, stripped.code)
    }
}

fn describe(error: CaughtError<'_>) -> String {
    match error {
        CaughtError::Exception(exception) => {
            let message = exception.message().unwrap_or_else(|| "exception".into());
            let stack = exception.stack().unwrap_or_default();
            if stack.is_empty() {
                message
            } else {
                format!("{message}\n{stack}")
            }
        }
        CaughtError::Value(value) => format!("thrown value: {value:?}"),
        CaughtError::Error(error) => error.to_string(),
    }
}

impl Game {
    /// Load `<directory>/main.ts` and run its setup.
    pub fn load(directory: &Path) -> Result<Self, String> {
        let runtime = Runtime::new().map_err(|error| error.to_string())?;
        runtime.set_memory_limit(HEAP_LIMIT);
        runtime.set_max_stack_size(STACK_LIMIT);
        let deadline = Arc::new(AtomicI64::new(now_ms() + TURN_LIMIT_MS));
        let limit = deadline.clone();
        runtime.set_interrupt_handler(Some(Box::new(move || {
            now_ms() > limit.load(Ordering::Relaxed)
        })));
        runtime.set_loader(
            GameResolver,
            GameLoader {
                directory: directory.to_owned(),
            },
        );
        let context = Context::full(&runtime).map_err(|error| error.to_string())?;
        let frame = Rc::new(RefCell::new(Frame {
            seed: 0x9e3779b9,
            next_mesh: 6,
            ..Frame::default()
        }));
        let game_directory = directory.to_owned();
        context
            .with(|ctx| mount(&ctx, frame.clone(), game_directory))
            .map_err(|error| format!("mount: {error}"))?;
        let mut game = Self {
            runtime,
            context,
            frame,
            deadline,
            entities: Vec::new(),
            tick: 0,
            heap_peak: 0,
            directory: directory.to_owned(),
        };
        game.boot()?;
        Ok(game)
    }

    fn boot(&mut self) -> Result<(), String> {
        self.deadline
            .store(now_ms() + TURN_LIMIT_MS, Ordering::Relaxed);
        let source = "import start from './__boot.ts';\n".replace("./__boot.ts", "./main.ts");
        let boot = format!("{source}import {{ __start }} from '{SDK_MODULE}';\n__start(start);\n");
        let result = self.context.with(|ctx| -> Result<(), String> {
            let promise = Module::evaluate(ctx.clone(), "__boot.js", boot)
                .catch(&ctx)
                .map_err(describe)?;
            while ctx.execute_pending_job() {}
            promise.finish::<()>().catch(&ctx).map_err(describe)
        });
        self.drain_jobs()?;
        result
    }

    fn drain_jobs(&self) -> Result<(), String> {
        loop {
            match self.runtime.execute_pending_job() {
                Ok(true) => continue,
                Ok(false) => return Ok(()),
                Err(_) => return Err("an async job threw".to_owned()),
            }
        }
    }

    /// Advance the game one 1/60 s step with this frame's pad.
    pub fn step(&mut self, pad: Pad) -> Result<(), String> {
        self.deadline
            .store(now_ms() + TURN_LIMIT_MS, Ordering::Relaxed);
        {
            let mut frame = self.frame.borrow_mut();
            frame.hud.clear();
            world::step_particles(&mut frame.particles, 1.0 / 60.0);
        }
        let entities = &mut self.entities;
        let result = self.context.with(|ctx| -> Result<(), String> {
            let globals = ctx.globals();
            let tick: Function = globals.get("__arcade_tick").catch(&ctx).map_err(describe)?;
            let args = (
                pad.buttons,
                pad.axes[0],
                pad.axes[1],
                pad.axes[2],
                pad.axes[3],
                pad.triggers[0],
                pad.triggers[1],
            );
            let count: i32 = tick.call(args).catch(&ctx).map_err(describe)?;
            let array: TypedArray<f32> = globals
                .get("__arcade_entities")
                .catch(&ctx)
                .map_err(describe)?;
            let values: &[f32] = array.as_ref();
            let used = (count.max(0) as usize * STRIDE).min(values.len());
            entities.clear();
            entities.extend_from_slice(&values[..used]);
            Ok(())
        });
        self.tick += 1;
        self.drain_jobs()?;
        if self.tick.is_multiple_of(60) {
            let usage = self.runtime.memory_usage();
            self.heap_peak = self.heap_peak.max(usage.malloc_size as usize);
        }
        result
    }

    /// The live entity table, `STRIDE` floats per entity.
    pub fn entities(&self) -> &[f32] {
        &self.entities
    }
}

fn log_line<'js>(ctx: &Ctx<'js>, level: &str, values: &[Value<'js>]) -> String {
    let mut line = String::from(level);
    for value in values {
        line.push(' ');
        let text = match value.as_string() {
            Some(text) => text.to_string().ok(),
            None => ctx
                .json_stringify(value.clone())
                .ok()
                .flatten()
                .and_then(|json| json.to_string().ok()),
        };
        line.push_str(text.as_deref().unwrap_or("undefined"));
    }
    line
}

fn mount<'js>(
    ctx: &Ctx<'js>,
    frame: Rc<RefCell<Frame>>,
    directory: PathBuf,
) -> rquickjs::Result<()> {
    let globals = ctx.globals();
    let host = Object::new(ctx.clone())?;
    host.set("stride", STRIDE as i32)?;
    host.set("maxEntities", MAX_ENTITIES as i32)?;

    macro_rules! scene_call {
        ($name:literal, |$scene:ident $(, $arg:ident : $kind:ty)*| $body:block) => {{
            let frame = frame.clone();
            host.set($name, Func::from(move |$($arg: $kind),*| {
                let $scene = &mut frame.borrow_mut().scene;
                $body
            }))?;
        }};
    }
    scene_call!("camera", |scene,
                           x: f32,
                           y: f32,
                           z: f32,
                           tx: f32,
                           ty: f32,
                           tz: f32,
                           fov: f32| {
        scene.eye = [x, y, z];
        scene.target = [tx, ty, tz];
        scene.fov = fov.clamp(10.0, 120.0).to_radians();
    });
    scene_call!("sky", |scene, value: u32| {
        let c = color(value, 1.0);
        scene.sky = [c[0], c[1], c[2]];
    });
    scene_call!("fog", |scene, value: u32, near: f32, far: f32| {
        let c = color(value, 1.0);
        scene.fog_color = [c[0], c[1], c[2]];
        scene.fog_near = near;
        scene.fog_far = far;
    });
    scene_call!("sun", |scene,
                        x: f32,
                        y: f32,
                        z: f32,
                        value: u32,
                        strength: f32| {
        let c = color(value, 1.0);
        scene.sun = [x, y, z];
        scene.sun_color = [c[0] * strength, c[1] * strength, c[2] * strength];
    });
    scene_call!("ambient", |scene, top: u32, bottom: u32| {
        let (t, b) = (color(top, 1.0), color(bottom, 1.0));
        scene.ambient_top = [t[0], t[1], t[2]];
        scene.ambient_bottom = [b[0], b[1], b[2]];
    });
    scene_call!("ground", |scene, y: f32| {
        scene.ground = y;
    });

    let target = frame.clone();
    host.set(
        "rect",
        Func::from(
            move |x: f32, y: f32, w: f32, h: f32, value: u32, alpha: f32| {
                target.borrow_mut().hud.push(HudCommand::Rect {
                    x,
                    y,
                    w,
                    h,
                    color: color(value, alpha),
                });
            },
        ),
    )?;
    let target = frame.clone();
    host.set(
        "text",
        Func::from(
            move |text: String, x: f32, y: f32, px: f32, value: u32, alpha: f32, align: i32| {
                let align = match align {
                    1 => Align::Center,
                    2 => Align::Right,
                    _ => Align::Left,
                };
                target.borrow_mut().hud.push(HudCommand::Text {
                    text,
                    x,
                    y,
                    px,
                    color: color(value, alpha),
                    align,
                });
            },
        ),
    )?;
    let target = frame.clone();
    host.set(
        "burst",
        Func::from(move |x: f32, y: f32, z: f32, value: u32, shape: Vec<f32>| {
            let frame = &mut *target.borrow_mut();
            let c = color(value, 1.0);
            let at = |index: usize, fallback: f32| shape.get(index).copied().unwrap_or(fallback);
            world::burst(
                &mut frame.particles,
                &mut frame.seed,
                [x, y, z],
                [c[0], c[1], c[2]],
                at(0, 16.0) as u32,
                at(1, 5.0),
                at(2, 0.6),
                at(3, 0.18),
            );
        }),
    )?;
    let target = frame.clone();
    host.set(
        "tone",
        Func::from(
            move |frequency: f32, seconds: f32, volume: f32, wave: u32, slide: f32| {
                target
                    .borrow_mut()
                    .voices
                    .push(Voice::tone(frequency, seconds, volume, wave, slide));
            },
        ),
    )?;
    let target = frame.clone();
    host.set(
        "mesh",
        Func::from(move |vertices: Vec<f32>, indices: Vec<u16>| -> i32 {
            let mut frame = target.borrow_mut();
            let id = frame.next_mesh;
            frame.next_mesh += 1;
            frame.meshes.push((id, Shape { vertices, indices }));
            id as i32
        }),
    )?;
    let target = frame.clone();
    host.set(
        "quit",
        Func::from(move || {
            target.borrow_mut().quit = true;
        }),
    )?;
    let save = directory.join("save.json");
    host.set(
        "loadSave",
        Func::from(move || -> Option<String> { std::fs::read_to_string(&save).ok() }),
    )?;
    let save = directory.join("save.json");
    host.set(
        "writeSave",
        Func::from(move |json: String| {
            let _ = std::fs::write(&save, json);
        }),
    )?;
    globals.set("__arcade", host)?;

    let console = Object::new(ctx.clone())?;
    for (name, level) in [("log", "log:"), ("warn", "warn:"), ("error", "error:")] {
        let target = frame.clone();
        console.set(
            name,
            Func::from(move |ctx: Ctx<'js>, values: Rest<Value<'js>>| {
                let line = log_line(&ctx, level, &values);
                let mut frame = target.borrow_mut();
                if frame.logs.len() >= LOG_LINES {
                    frame.logs.pop_front();
                }
                frame.logs.push_back(line);
            }),
        )?;
    }
    globals.set("console", console)?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn game_with(name: &str, files: &[(&str, &str)]) -> PathBuf {
        let directory =
            std::env::temp_dir().join(format!("pocket-arcade-{name}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&directory);
        std::fs::create_dir_all(&directory).unwrap();
        for (file, text) in files {
            std::fs::write(directory.join(file), text).unwrap();
        }
        directory
    }

    #[test]
    fn runs_typescript_modules_and_shares_entities() {
        let directory = game_with(
            "modules",
            &[
                ("speed.ts", "export const SPEED: number = 60;\n"),
                (
                    "main.ts",
                    r#"
import { camera, game, hud, input, spawn, type Entity } from "@pocketjs/framework/arcade";
import { SPEED } from "./speed";
let player: Entity;
export default game({
  setup() { player = spawn({ color: 0xff0000, shadow: true }); console.log("ready", { n: 1 }); },
  update(dt) {
    if (input.held("right")) player.x += SPEED * dt;
    camera.look(0, 5, 5, player.x, 0, 0);
  },
  draw() { hud.text(`x=${player.x}`, 10, 10); },
});
"#,
                ),
            ],
        );
        let mut game = Game::load(&directory).unwrap();
        for _ in 0..3 {
            game.step(Pad {
                buttons: 8,
                ..Pad::default()
            })
            .unwrap();
        }
        let table = game.entities();
        assert_eq!(table.len(), STRIDE);
        assert!((table[0] - 3.0).abs() < 1e-3, "x = {}", table[0]);
        assert!((table[9] - 1.0).abs() < 1e-3, "red = {}", table[9]);
        assert_eq!(table[14] as u32, 3, "visible and shadow");
        let frame = game.frame.borrow();
        assert!(
            frame.logs.iter().any(|line| line == "log: ready {\"n\":1}"),
            "{:?}",
            frame.logs
        );
        assert!((frame.scene.target[0] - 3.0).abs() < 1e-3);
        match &frame.hud[0] {
            HudCommand::Text { text, .. } => assert!(text.starts_with("x=3")),
            other => panic!("{other:?}"),
        }
        std::fs::remove_dir_all(&directory).unwrap();
    }

    #[test]
    fn reports_load_errors_a_model_can_act_on() {
        let syntax = game_with(
            "syntax",
            &[("main.ts", "export default game({\n  update(dt) {\n")],
        );
        assert!(
            Game::load(&syntax).err().unwrap().contains("main.ts:"),
            "syntax error names the file"
        );
        let missing = game_with("missing", &[("main.ts", "export const x = 1;\n")]);
        assert!(Game::load(&missing).is_err());
        let import = game_with(
            "import",
            &[("main.ts", "import 'three';\nexport default {};\n")],
        );
        assert!(Game::load(&import).is_err());
        for directory in [syntax, missing, import] {
            std::fs::remove_dir_all(&directory).unwrap();
        }
    }

    #[test]
    fn a_runtime_error_and_a_hang_become_errors() {
        let thrower = game_with(
            "throw",
            &[("main.ts", "import { game } from '@pocketjs/framework/arcade';\nexport default game({ update() { throw new Error('boom'); } });\n")],
        );
        let mut game = Game::load(&thrower).unwrap();
        assert!(game.step(Pad::default()).err().unwrap().contains("boom"));
        let hang = game_with(
            "hang",
            &[("main.ts", "import { game } from '@pocketjs/framework/arcade';\nexport default game({ update() { for (;;) {} } });\n")],
        );
        let mut game = Game::load(&hang).unwrap();
        game.deadline.store(0, Ordering::Relaxed);
        let started = std::time::Instant::now();
        assert!(game.step(Pad::default()).is_err());
        assert!(
            started.elapsed().as_secs() < 10,
            "the turn limit stops a hang"
        );
        for directory in [thrower, hang] {
            std::fs::remove_dir_all(&directory).unwrap();
        }
    }

    #[test]
    fn a_reused_entity_keeps_the_table_small() {
        let directory = game_with(
            "reuse",
            &[("main.ts", "import { game, spawn } from '@pocketjs/framework/arcade';\nexport default game({ update() { const e = spawn(); e.remove(); } });\n")],
        );
        let mut game = Game::load(&directory).unwrap();
        for _ in 0..50 {
            game.step(Pad::default()).unwrap();
        }
        assert_eq!(game.entities().len(), STRIDE);
        std::fs::remove_dir_all(&directory).unwrap();
    }
}
