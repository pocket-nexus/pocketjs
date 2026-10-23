//! Run an app headless on the development machine and write PNG frames.
//!
//!     cargo run --release --example preview -- APP.js APP.pak OUT_DIR \
//!         --size=480x760 --density=1 --hz=40 --host=passport-prime-dev --abi=12 \
//!         --wait=40 --shot=idle --tap=240,100 --drag=40,200,400,200,12 --shot=swiped
//!
//! Actions run in order: `--wait=N` steps N frames, `--tap=X,Y` presses and
//! releases at a physical point, `--drag=X0,Y0,X1,Y1,N` moves a held contact
//! over N frames, `--down=X,Y`, `--move=X,Y,N` and `--up` split a drag into
//! its parts, `--shot=NAME` writes OUT_DIR/NAME.png. Each step's damage is
//! painted into one retained frame. The summary line reports the per-step
//! guest, tick, draw and paint time.

use std::path::PathBuf;
use std::time::Duration;

use anyhow::{Context, Result, bail};
use pocketjs_keyos_runtime::{Config, Phase, PixelOrder, Runtime};

fn numbers(value: &str) -> Result<Vec<i32>> {
    value
        .split([',', 'x'])
        .map(|n| n.parse::<i32>().with_context(|| format!("not a number: {n}")))
        .collect()
}

#[derive(Default)]
struct Totals {
    steps: u32,
    guest: Duration,
    tick: Duration,
    draw: Duration,
    paint: Duration,
    worst: Duration,
    area: u64,
}

struct Preview {
    runtime: Runtime,
    frame: Vec<u8>,
    totals: Totals,
}

impl Preview {
    fn run(&mut self) -> Result<()> {
        let step = self.runtime.step()?;
        let painted = std::time::Instant::now();
        let row_bytes = self.runtime.size().0 as usize * 4;
        let d = self.runtime.density() as usize;
        for r in &step.regions {
            let rows = &mut self.frame[r.y0 as usize * d * row_bytes..r.y1 as usize * d * row_bytes];
            self.runtime.paint_rows(*r, rows);
        }
        let paint = painted.elapsed();
        let (t, totals) = (step.timing, &mut self.totals);
        totals.steps += 1;
        totals.guest += t.guest;
        totals.tick += t.tick;
        totals.draw += t.draw;
        totals.paint += paint;
        totals.worst = totals.worst.max(t.guest + t.tick + t.draw + paint);
        totals.area += step.area();
        Ok(())
    }
}

fn shot(preview: &Preview, order: PixelOrder, path: PathBuf) -> Result<()> {
    let (w, h) = preview.runtime.size();
    let mut rgba = preview.frame.clone();
    if order == PixelOrder::Bgra {
        rgba.as_chunks_mut::<4>().0.iter_mut().for_each(|p| p.swap(0, 2));
    }
    let file = std::fs::File::create(&path).with_context(|| format!("creating {}", path.display()))?;
    let mut encoder = png::Encoder::new(std::io::BufWriter::new(file), w, h);
    encoder.set_color(png::ColorType::Rgba);
    encoder.write_header()?.write_image_data(&rgba)?;
    println!("preview: {}", path.display());
    Ok(())
}

fn main() -> Result<()> {
    let args: Vec<String> = std::env::args().skip(1).collect();
    let positional: Vec<&String> = args.iter().filter(|a| !a.starts_with("--")).collect();
    let [js, pak, out] = positional[..] else {
        bail!("usage: preview APP.js APP.pak OUT_DIR [--size=WxH] [--density=N] [--hz=N] [actions…]");
    };
    let flag = |name: &str| {
        args.iter().find_map(|a| a.strip_prefix(&format!("--{name}=")).map(str::to_string))
    };
    let size = numbers(&flag("size").unwrap_or("480x760".into()))?;
    let density: u32 = flag("density").unwrap_or("1".into()).parse()?;
    let tick_hz: u32 = flag("hz").unwrap_or("60".into()).parse()?;
    let host = flag("host").unwrap_or("desktop".into());
    let abi: u32 = flag("abi").unwrap_or("0".into()).parse()?;
    let order = if flag("order").as_deref() == Some("bgra") { PixelOrder::Bgra } else { PixelOrder::Rgba };
    let config = Config {
        host_id: &host,
        host_abi: abi,
        width: size[0] as u32,
        height: size[1] as u32,
        density,
        tick_hz,
        order,
    };
    let bundle = std::fs::read_to_string(js).with_context(|| format!("reading {js}"))?;
    let pak = std::fs::read(pak).with_context(|| format!("reading {pak}"))?;
    let out = PathBuf::from(out);
    std::fs::create_dir_all(&out)?;

    let booted = std::time::Instant::now();
    let runtime = Runtime::boot(&config, &bundle, &pak)?;
    println!("preview: booted in {:.1} ms", booted.elapsed().as_secs_f64() * 1e3);
    let (w, h) = runtime.size();
    let mut preview = Preview { runtime, frame: vec![0; (w * h * 4) as usize], totals: Totals::default() };
    let mut held = (0, 0);
    for arg in args.iter().filter(|a| a.starts_with("--")) {
        let (name, value) = arg[2..].split_once('=').unwrap_or((&arg[2..], ""));
        match name {
            "wait" => {
                for _ in 0..value.parse::<u32>()? {
                    preview.run()?;
                }
            }
            "tap" => {
                let p = numbers(value)?;
                preview.runtime.touch(Phase::Down, 0, p[0], p[1]);
                preview.run()?;
                preview.runtime.touch(Phase::Up, 0, p[0], p[1]);
                preview.run()?;
            }
            "drag" => {
                let p = numbers(value)?;
                let frames = p[4].max(1);
                preview.runtime.touch(Phase::Down, 0, p[0], p[1]);
                preview.run()?;
                for i in 1..=frames {
                    let x = p[0] + (p[2] - p[0]) * i / frames;
                    let y = p[1] + (p[3] - p[1]) * i / frames;
                    preview.runtime.touch(Phase::Move, 0, x, y);
                    preview.run()?;
                }
                preview.runtime.touch(Phase::Up, 0, p[2], p[3]);
                preview.run()?;
            }
            "down" => {
                let p = numbers(value)?;
                held = (p[0], p[1]);
                preview.runtime.touch(Phase::Down, 0, p[0], p[1]);
                preview.run()?;
            }
            "move" => {
                let p = numbers(value)?;
                let frames = p[2].max(1);
                let from = held;
                for i in 1..=frames {
                    held = (from.0 + (p[0] - from.0) * i / frames, from.1 + (p[1] - from.1) * i / frames);
                    preview.runtime.touch(Phase::Move, 0, held.0, held.1);
                    preview.run()?;
                }
            }
            "up" => {
                preview.runtime.touch(Phase::Up, 0, held.0, held.1);
                preview.run()?;
            }
            "shot" => shot(&preview, order, out.join(format!("{value}.png")))?,
            _ => {}
        }
    }
    let totals = &preview.totals;
    let n = totals.steps.max(1);
    let ms = |d: Duration| d.as_secs_f64() * 1e3 / f64::from(n);
    println!(
        "preview: {} steps, per step guest {:.2} ms, tick {:.2} ms, draw {:.2} ms, paint {:.2} ms, worst {:.2} ms, repainted {:.1}% of the frame",
        totals.steps,
        ms(totals.guest),
        ms(totals.tick),
        ms(totals.draw),
        ms(totals.paint),
        totals.worst.as_secs_f64() * 1e3,
        totals.area as f64 * 100.0 / (f64::from(n) * f64::from(config.width * config.height)),
    );
    Ok(())
}
