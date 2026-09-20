//! Native service CPU costs, excluding frame delivery, UI rendering and font I/O.
//! Run from the repository root:
//! cargo run --release --manifest-path engine/crates/pocket-text/Cargo.toml --example runtime_cost -- 60
use pocket_text::runtime::RuntimeText;
use serde_json::{json, Value};
use std::collections::{BTreeMap, BTreeSet};
use std::time::Instant;

#[derive(Default)]
struct Measurements {
    phases: BTreeMap<String, Vec<f64>>,
}
impl Measurements {
    fn push(&mut self, name: &str, ms: f64) {
        self.phases.entry(name.into()).or_default().push(ms);
    }
    fn summary(self) -> Value {
        Value::Object(self.phases.into_iter().map(|(name, mut values)| {
            values.sort_by(f64::total_cmp);
            let n = values.len();
            (name, json!({"samples":n,"medianMs":values[n / 2],"p95Ms":values[(n * 95 / 100).min(n - 1)],"minMs":values[0],"maxMs":values[n - 1]}))
        }).collect())
    }
}
fn call(service: &mut RuntimeText, method: &str, args: Value) -> Value {
    service
        .dispatch(method, &args)
        .unwrap_or_else(|e| panic!("{method}: {e}"))
}
fn measured<T>(measurements: &mut Measurements, name: &str, run: impl FnOnce() -> T) -> T {
    let start = Instant::now();
    let result = run();
    measurements.push(name, start.elapsed().as_secs_f64() * 1000.0);
    result
}
fn font(service: &mut RuntimeText, size: u32) -> u64 {
    call(
        service,
        "runtime.font",
        json!({"family":"Inter","size":size,"fallback":["Pocket CJK Test"]}),
    )["font"]
        .as_u64()
        .unwrap()
}
fn layout_pages(service: &mut RuntimeText, layout: u64) -> (BTreeSet<u64>, usize, Vec<Value>) {
    let mut glyphs = BTreeSet::new();
    let mut count = 0;
    let mut pages = vec![];
    for kind in ["glyphs", "rows", "carets"] {
        let mut offset = 0;
        loop {
            let page = call(
                service,
                "runtime.layout.page",
                json!({"layout":layout,"kind":kind,"offset":offset}),
            );
            count += 1;
            if kind == "glyphs" {
                glyphs.extend(
                    page["items"]
                        .as_array()
                        .unwrap()
                        .iter()
                        .map(|g| g[0].as_u64().unwrap()),
                );
            }
            let next = page["next"].as_u64();
            pages.push(page);
            if let Some(n) = next {
                offset = n;
            } else {
                break;
            }
        }
    }
    (glyphs, count, pages)
}
fn glyph_pages(service: &mut RuntimeText, glyphs: &BTreeSet<u64>) -> (usize, usize, Vec<Value>) {
    let mut count = 0;
    let mut coverage = 0;
    let mut pages = vec![];
    for glyph in glyphs {
        let mut offset = 0;
        loop {
            let page = call(
                service,
                "runtime.glyph",
                json!({"glyph":glyph,"offset":offset}),
            );
            count += 1;
            if offset == 0 {
                coverage += page["total"].as_u64().unwrap() as usize;
            }
            let next = page["next"].as_u64();
            pages.push(page);
            if let Some(n) = next {
                offset = n;
            } else {
                break;
            }
        }
    }
    (count, coverage, pages)
}
fn main() {
    let samples = std::env::args()
        .nth(1)
        .map_or(60, |n| n.parse::<usize>().unwrap())
        .max(1);
    let latin = std::fs::read("assets/fonts/Inter-Regular.ttf").unwrap();
    let han = std::fs::read("tests/fixtures/runtime-font/NotoSansSC-Test.ttf").unwrap();
    let cjk: String = (0..256)
        .map(|i| char::from_u32(0x4e00 + i).unwrap())
        .collect();
    let cases = [
        ("cold-latin", "AV office variable width e\u{301} 你好", 16),
        ("new-han-256", cjk.as_str(), 16),
        ("large-128", "AV你好", 128),
    ];
    for (name, text, size) in cases {
        let mut timings = Measurements::default();
        let mut counts = Value::Null;
        for _ in 0..samples {
            let mut service = RuntimeText::new();
            measured(&mut timings, "fontLoad", || {
                assert!(service.load_font(&latin));
                assert!(service.load_font(&han));
            });
            let font = measured(&mut timings, "fontInstance", || font(&mut service, size));
            let shape = measured(&mut timings, "shapeCold", || {
                call(
                    &mut service,
                    "runtime.shape",
                    json!({"font":font,"text":text}),
                )
            })["shape"]
                .as_u64()
                .unwrap();
            let layout = measured(&mut timings, "layoutCold", || {
                call(
                    &mut service,
                    "runtime.layout",
                    json!({"shape":shape,"width":460}),
                )
            })["layout"]
                .as_u64()
                .unwrap();
            let (glyphs, layout_requests, pages) = measured(&mut timings, "layoutPages", || {
                layout_pages(&mut service, layout)
            });
            let (glyph_requests, coverage, bitmaps) =
                measured(&mut timings, "glyphsColdIncludingJsonAndBase64", || {
                    glyph_pages(&mut service, &glyphs)
                });
            let wire_bytes = measured(&mut timings, "serializeResponses", || {
                pages
                    .iter()
                    .chain(&bitmaps)
                    .map(|p| p.to_string().len())
                    .sum::<usize>()
            });
            measured(&mut timings, "shapeHit", || {
                call(
                    &mut service,
                    "runtime.shape",
                    json!({"font":font,"text":text}),
                )
            });
            measured(&mut timings, "layoutHit", || {
                call(
                    &mut service,
                    "runtime.layout",
                    json!({"shape":shape,"width":460}),
                )
            });
            measured(&mut timings, "widthChangeReusingShape", || {
                call(
                    &mut service,
                    "runtime.layout",
                    json!({"shape":shape,"width":320}),
                )
            });
            measured(&mut timings, "glyphsHitIncludingJsonAndBase64", || {
                glyph_pages(&mut service, &glyphs)
            });
            counts = json!({"uniqueGlyphs":glyphs.len(),"layoutPageRequests":layout_requests,"glyphPageRequests":glyph_requests,"coverageBytes":coverage,"responseJsonBytes":wire_bytes,"service":call(&mut service,"runtime.stats",json!({}))});
        }
        println!(
            "{}",
            json!({"case":name,"size":size,"platform":format!("{}/{}",std::env::consts::OS,std::env::consts::ARCH),"scope":"native CPU dispatch; warm file system; no UI, IPC, frame gate or GPU","timings":timings.summary(),"counts":counts})
        );
    }
    for name in ["editing", "multi-size"] {
        let mut timings = Measurements::default();
        let mut counts = Value::Null;
        for _ in 0..samples {
            let mut service = RuntimeText::new();
            assert!(service.load_font(&latin));
            assert!(service.load_font(&han));
            let mut cold = true;
            for step in 0..12 {
                let size = if name == "multi-size" {
                    [16, 24, 48, 128][step % 4]
                } else {
                    16
                };
                let font = font(&mut service, size);
                let text = if name == "editing" {
                    format!("AV office 你好{}", "x".repeat(step))
                } else {
                    "AV office 你好".into()
                };
                let total = Instant::now();
                let shape = call(
                    &mut service,
                    "runtime.shape",
                    json!({"font":font,"text":text}),
                )["shape"]
                    .as_u64()
                    .unwrap();
                let layout = call(
                    &mut service,
                    "runtime.layout",
                    json!({"shape":shape,"width":460}),
                )["layout"]
                    .as_u64()
                    .unwrap();
                let (glyphs, _, _) = layout_pages(&mut service, layout);
                glyph_pages(&mut service, &glyphs);
                timings.push(
                    if cold { "initial" } else { "subsequent" },
                    total.elapsed().as_secs_f64() * 1000.0,
                );
                cold = false;
            }
            counts = call(&mut service, "runtime.stats", json!({}));
        }
        println!(
            "{}",
            json!({"case":name,"platform":format!("{}/{}",std::env::consts::OS,std::env::consts::ARCH),"timings":timings.summary(),"service":counts})
        );
    }
    // Keep coverage and per-request payload close to constant while growing the
    // cache. Fractional sizes produce distinct stable identities and stay near
    // 16px; this isolates metadata lookup cost from large-raster cost.
    let mut service = RuntimeText::new();
    assert!(service.load_font(&latin));
    assert!(service.load_font(&han));
    call(
        &mut service,
        "runtime.budget",
        json!({"bitmap":8*1024*1024}),
    );
    let mut first = BTreeSet::new();
    for instance in 0..32 {
        let font = call(&mut service, "runtime.font", json!({"family":"Inter","size":16.0+instance as f64/64.0,"fallback":["Pocket CJK Test"]}))["font"].as_u64().unwrap();
        let shape = call(
            &mut service,
            "runtime.shape",
            json!({"font":font,"text":cjk}),
        )["shape"]
            .as_u64()
            .unwrap();
        let layout = call(
            &mut service,
            "runtime.layout",
            json!({"shape":shape,"width":460}),
        )["layout"]
            .as_u64()
            .unwrap();
        let (glyphs, _, _) = layout_pages(&mut service, layout);
        glyph_pages(&mut service, &glyphs);
        if instance == 0 {
            first = glyphs.clone();
        }
        if [0, 3, 15, 31].contains(&instance) {
            let mut timings = Measurements::default();
            for _ in 0..samples {
                measured(&mut timings, "first256Hits", || {
                    glyph_pages(&mut service, &first)
                });
                measured(&mut timings, "latest256Hits", || {
                    glyph_pages(&mut service, &glyphs)
                });
            }
            println!(
                "{}",
                json!({"case":"cache-cardinality","residentGlyphs":(instance+1)*256,"timings":timings.summary(),"service":call(&mut service,"runtime.stats",json!({}))})
            );
        }
    }
}
