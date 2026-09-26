//! Procedural albedo maps.
//!
//! Every texture in the scene is synthesized here, so the cooked scene depends
//! on nothing but its seed and fits in the EBOOT alongside the geometry. The
//! tiling maps are built from seamless noise; the cutout maps are drawn as
//! shapes with coverage in alpha.
//!
//! Colours are authored in display space, which is the space the device
//! multiplies in.

use glam::Vec3;

use crate::noise::{Rng, fbm_tiled, value_tiled};

/// An RGBA8 image under construction.
pub struct Canvas {
    pub size: u32,
    pub pixels: Vec<u8>,
}

impl Canvas {
    pub fn new(size: u32) -> Self {
        Self {
            size,
            pixels: vec![0; (size * size * 4) as usize],
        }
    }

    pub fn put(&mut self, x: u32, y: u32, color: Vec3, alpha: f32) {
        if x >= self.size || y >= self.size {
            return;
        }
        let offset = ((y * self.size + x) * 4) as usize;
        let byte = |value: f32| (value.clamp(0.0, 1.0) * 255.0 + 0.5) as u8;
        self.pixels[offset] = byte(color.x);
        self.pixels[offset + 1] = byte(color.y);
        self.pixels[offset + 2] = byte(color.z);
        self.pixels[offset + 3] = byte(alpha);
    }

    pub fn get(&self, x: u32, y: u32) -> (Vec3, f32) {
        let offset = ((y.min(self.size - 1) * self.size + x.min(self.size - 1)) * 4) as usize;
        (
            Vec3::new(
                self.pixels[offset] as f32 / 255.0,
                self.pixels[offset + 1] as f32 / 255.0,
                self.pixels[offset + 2] as f32 / 255.0,
            ),
            self.pixels[offset + 3] as f32 / 255.0,
        )
    }

    /// Composite `color` over the existing texel with coverage `alpha`.
    pub fn blend(&mut self, x: u32, y: u32, color: Vec3, alpha: f32) {
        if x >= self.size || y >= self.size || alpha <= 0.0 {
            return;
        }
        let (existing, existing_alpha) = self.get(x, y);
        let out_alpha = alpha + existing_alpha * (1.0 - alpha);
        let out_color = if out_alpha > 1e-4 {
            (color * alpha + existing * existing_alpha * (1.0 - alpha)) / out_alpha
        } else {
            color
        };
        self.put(x, y, out_color, out_alpha);
    }

    /// Fill every texel from a closure over normalized coordinates.
    pub fn fill(&mut self, mut shade: impl FnMut(f32, f32) -> (Vec3, f32)) {
        for y in 0..self.size {
            for x in 0..self.size {
                let (color, alpha) =
                    shade(x as f32 / self.size as f32, y as f32 / self.size as f32);
                self.put(x, y, color, alpha);
            }
        }
    }
}

fn rgb(red: u32, green: u32, blue: u32) -> Vec3 {
    Vec3::new(red as f32, green as f32, blue as f32) / 255.0
}

fn mix(a: Vec3, b: Vec3, t: f32) -> Vec3 {
    a + (b - a) * t.clamp(0.0, 1.0)
}

fn smoothstep(edge0: f32, edge1: f32, value: f32) -> f32 {
    let t = ((value - edge0) / (edge1 - edge0).max(1e-6)).clamp(0.0, 1.0);
    t * t * (3.0 - 2.0 * t)
}

/// Meadow: layered greens with a dry-grass wash and scattered darker clumps.
pub fn meadow(size: u32, seed: u32) -> Canvas {
    let mut canvas = Canvas::new(size);
    let period = 8;
    let deep = rgb(46, 64, 33);
    let fresh = rgb(88, 110, 50);
    let dry = rgb(133, 130, 74);
    canvas.fill(|u, v| {
        let broad = fbm_tiled(u * period as f32, v * period as f32, period, 4, seed);
        let fine = fbm_tiled(u * 34.0, v * 34.0, 34, 3, seed ^ 0x77);
        let blades = value_tiled(u * 96.0, v * 20.0, 96, seed ^ 0x19);
        let mut color = mix(deep, fresh, broad);
        color = mix(color, dry, smoothstep(0.55, 0.95, broad * 0.6 + fine * 0.5));
        color *= 0.82 + 0.34 * fine;
        color *= 0.9 + 0.2 * blades;
        (color, 1.0)
    });
    canvas
}

/// Riverbed gravel: rounded pebbles over wet sand.
pub fn gravel(size: u32, seed: u32) -> Canvas {
    let mut canvas = Canvas::new(size);
    let sand = rgb(96, 92, 78);
    let stone_cool = rgb(120, 122, 118);
    let stone_warm = rgb(138, 122, 100);
    canvas.fill(|u, v| {
        let base = fbm_tiled(u * 12.0, v * 12.0, 12, 4, seed);
        (mix(sand, stone_cool, base * 0.5), 1.0)
    });
    // Pebbles as shaded discs, wrapped at the edges so the map tiles.
    let mut rng = Rng::new(seed ^ 0xbead);
    let count = (size as usize * size as usize) / 340;
    for _ in 0..count {
        let cx = rng.unit() * size as f32;
        let cy = rng.unit() * size as f32;
        let radius = rng.range(2.0, size as f32 * 0.035);
        let tone = rng.unit();
        let stone = mix(stone_cool, stone_warm, tone) * rng.range(0.75, 1.15);
        let low = radius.ceil() as i32 + 1;
        for dy in -low..=low {
            for dx in -low..=low {
                let distance = ((dx * dx + dy * dy) as f32).sqrt();
                if distance > radius {
                    continue;
                }
                // A cheap dome shade: brighter towards the upper left.
                let lift = 1.0
                    + 0.35 * (-(dx as f32) - dy as f32) / radius.max(1.0)
                    - 0.5 * (distance / radius).powi(3);
                let x = (cx as i32 + dx).rem_euclid(size as i32) as u32;
                let y = (cy as i32 + dy).rem_euclid(size as i32) as u32;
                let edge = smoothstep(radius, radius - 1.6, distance);
                canvas.blend(x, y, stone * lift.clamp(0.4, 1.4), edge);
            }
        }
    }
    canvas
}

/// Lichened rock for cliffs and boulders.
pub fn rock(size: u32, seed: u32) -> Canvas {
    let mut canvas = Canvas::new(size);
    let dark = rgb(64, 63, 60);
    let pale = rgb(146, 143, 134);
    let lichen = rgb(108, 118, 84);
    canvas.fill(|u, v| {
        let strata = fbm_tiled(u * 6.0, v * 18.0, 6, 5, seed);
        let crack = 1.0 - smoothstep(0.42, 0.5, (fbm_tiled(u * 9.0, v * 9.0, 9, 4, seed ^ 0x3f) - 0.5).abs());
        let grain = fbm_tiled(u * 44.0, v * 44.0, 44, 3, seed ^ 0x91);
        let moss = smoothstep(0.55, 0.78, fbm_tiled(u * 5.0, v * 5.0, 5, 3, seed ^ 0xa7));
        let mut color = mix(dark, pale, strata * 0.75 + grain * 0.35);
        color = mix(color, color * 0.45, crack * 0.8);
        color = mix(color, lichen, moss * 0.55);
        (color, 1.0)
    });
    canvas
}

/// Pine bark: deep vertical fissures.
pub fn pine_bark(size: u32, seed: u32) -> Canvas {
    let mut canvas = Canvas::new(size);
    let dark = rgb(42, 32, 26);
    let mid = rgb(92, 70, 52);
    canvas.fill(|u, v| {
        let ridge = fbm_tiled(u * 26.0, v * 4.0, 26, 4, seed);
        let fissure = smoothstep(0.34, 0.5, ridge);
        let grain = fbm_tiled(u * 60.0, v * 12.0, 60, 2, seed ^ 0x55);
        let color = mix(dark, mid, fissure * (0.7 + 0.5 * grain));
        (color, 1.0)
    });
    canvas
}

/// Cherry bark: smoother, greyer, with horizontal lenticel bands.
pub fn cherry_bark(size: u32, seed: u32) -> Canvas {
    let mut canvas = Canvas::new(size);
    let dark = rgb(58, 46, 44);
    let grey = rgb(126, 112, 106);
    canvas.fill(|u, v| {
        let broad = fbm_tiled(u * 7.0, v * 7.0, 7, 4, seed);
        let bands = value_tiled(u * 3.0, v * 30.0, 30, seed ^ 0x2c);
        let lenticel = smoothstep(0.72, 0.9, bands);
        let mut color = mix(dark, grey, broad * 0.8);
        color = mix(color, color * 0.55, lenticel * 0.7);
        (color, 1.0)
    });
    canvas
}

/// Weathered planking for the boat and the bridge deck.
pub fn planks(size: u32, seed: u32) -> Canvas {
    let mut canvas = Canvas::new(size);
    let light = rgb(134, 112, 86);
    let dark = rgb(74, 58, 44);
    let boards = 6.0;
    canvas.fill(|u, v| {
        let board = (v * boards).floor();
        let within = v * boards - board;
        let tint = value_tiled(board * 7.0 + 0.5, 0.5, boards as i32 * 7, seed);
        let grain = fbm_tiled(u * 40.0, board * 3.0 + v * 6.0, 40, 3, seed ^ 0x8d);
        let seam = smoothstep(0.06, 0.0, within.min(1.0 - within));
        let mut color = mix(dark, light, 0.35 + 0.5 * tint + 0.35 * grain);
        color = mix(color, dark * 0.5, seam);
        (color, 1.0)
    });
    canvas
}

/// Dark fired roof tiles in overlapping rows.
pub fn roof_tiles(size: u32, seed: u32) -> Canvas {
    let mut canvas = Canvas::new(size);
    let dark = rgb(42, 44, 50);
    let light = rgb(96, 100, 110);
    let rows = 8.0;
    let columns = 8.0;
    canvas.fill(|u, v| {
        let row = (v * rows).floor();
        let offset = if (row as i32) % 2 == 0 { 0.0 } else { 0.5 };
        let within_row = v * rows - row;
        let column = (u * columns + offset).fract();
        // A half-round tile: bright along its crown, dark in the valley.
        let crown = 1.0 - (column * 2.0 - 1.0).abs();
        let lip = smoothstep(0.0, 0.18, within_row) * smoothstep(1.0, 0.78, within_row);
        let weather = fbm_tiled(u * 16.0, v * 16.0, 16, 3, seed);
        let color = mix(dark, light, crown.powf(1.6) * 0.75 * lip + 0.18 * weather);
        (color, 1.0)
    });
    canvas
}

/// Vermilion lacquer for the bridge rails and the pagoda frame.
pub fn lacquer(size: u32, seed: u32) -> Canvas {
    let mut canvas = Canvas::new(size);
    let base = rgb(168, 62, 44);
    let worn = rgb(120, 52, 40);
    canvas.fill(|u, v| {
        let wear = fbm_tiled(u * 14.0, v * 14.0, 14, 4, seed);
        let streak = fbm_tiled(u * 3.0, v * 48.0, 48, 2, seed ^ 0x62);
        let color = mix(base, worn, wear * 0.7 + streak * 0.25);
        (color, 1.0)
    });
    canvas
}

/// Lime plaster walls.
pub fn plaster(size: u32, seed: u32) -> Canvas {
    let mut canvas = Canvas::new(size);
    let base = rgb(206, 198, 180);
    let stain = rgb(152, 145, 128);
    canvas.fill(|u, v| {
        let mottle = fbm_tiled(u * 10.0, v * 10.0, 10, 4, seed);
        let damp = smoothstep(0.75, 1.0, v) * 0.5;
        let color = mix(base, stain, mottle * 0.45 + damp);
        (color, 1.0)
    });
    canvas
}

/// Woven reed thatch for the boat's hood: bundles laid along one axis.
pub fn thatch(size: u32, seed: u32) -> Canvas {
    let mut canvas = Canvas::new(size);
    let straw = rgb(158, 132, 82);
    let shadow = rgb(78, 62, 38);
    canvas.fill(|u, v| {
        let bundles = value_tiled(u * 26.0, v * 2.0, 26, seed);
        let fibres = value_tiled(u * 150.0, v * 6.0, 150, seed ^ 0x3b);
        let rows = smoothstep(0.0, 0.25, (v * 5.0).fract());
        let mut color = mix(shadow, straw, bundles * 0.85 + fibres * 0.3);
        color *= 0.78 + 0.3 * rows;
        (color, 1.0)
    });
    canvas
}

/// Still-water ripple detail: overlapping low-contrast wave fronts.
///
/// The runtime scrolls two copies of this across the river at different rates,
/// which is what turns a flat plane into moving water on hardware with no
/// fragment maths of its own.
pub fn ripples(size: u32, seed: u32) -> Canvas {
    let mut canvas = Canvas::new(size);
    let deep = rgb(58, 72, 86);
    let crest = rgb(228, 236, 242);
    canvas.fill(|u, v| {
        let broad = fbm_tiled(u * 5.0, v * 9.0, 5, 3, seed);
        let fine = fbm_tiled(u * 21.0, v * 33.0, 21, 3, seed ^ 0x4d);
        let glint = fbm_tiled(u * 47.0, v * 61.0, 47, 2, seed ^ 0x8e);
        // Stretched along x so the pattern reads as travelling downstream.
        let front = smoothstep(0.42, 0.70, broad * 0.6 + fine * 0.5);
        let sparkle = smoothstep(0.72, 0.94, glint);
        (mix(deep, crest, front * 0.9 + sparkle * 0.5 + 0.06), 1.0)
    });
    canvas
}

/// A band of soft cloud, opaque at its core and clear at its edges.
pub fn clouds(size: u32, seed: u32) -> Canvas {
    let mut canvas = Canvas::new(size);
    let lit = rgb(252, 226, 198);
    let shade = rgb(150, 148, 162);
    canvas.fill(|u, v| {
        let body = fbm_tiled(u * 6.0, v * 6.0, 6, 5, seed);
        let detail = fbm_tiled(u * 19.0, v * 19.0, 19, 3, seed ^ 0x2f);
        // Clouds thin out towards the top and bottom of the band.
        let band = smoothstep(0.0, 0.35, v) * smoothstep(1.0, 0.62, v);
        let coverage = smoothstep(0.46, 0.68, body * 0.8 + detail * 0.35) * band;
        // Sunlit tops, shaded undersides.
        let color = mix(shade, lit, smoothstep(0.75, 0.25, v));
        (color, coverage)
    });
    canvas
}

// ---------------------------------------------------------------------------
// Cutouts
// ---------------------------------------------------------------------------

/// Draw one tapered blade or needle from `(x0, y0)` towards `(x1, y1)`.
fn stroke(
    canvas: &mut Canvas,
    from: (f32, f32),
    to: (f32, f32),
    width: f32,
    color: Vec3,
    taper: f32,
) {
    let steps = ((to.0 - from.0).hypot(to.1 - from.1).ceil() as i32).max(1) * 2;
    for step in 0..=steps {
        let t = step as f32 / steps as f32;
        let x = from.0 + (to.0 - from.0) * t;
        let y = from.1 + (to.1 - from.1) * t;
        let radius = width * (1.0 - taper * t);
        if radius <= 0.0 {
            continue;
        }
        let low = radius.ceil() as i32;
        for dy in -low..=low {
            for dx in -low..=low {
                let distance = ((dx * dx + dy * dy) as f32).sqrt();
                let coverage = smoothstep(radius, radius - 0.9, distance);
                if coverage <= 0.0 {
                    continue;
                }
                let px = x as i32 + dx;
                let py = y as i32 + dy;
                if px < 0 || py < 0 {
                    continue;
                }
                canvas.blend(px as u32, py as u32, color, coverage);
            }
        }
    }
}

/// A spray of pine needles on transparent black, for a branch card.
pub fn pine_spray(size: u32, seed: u32) -> Canvas {
    let mut canvas = Canvas::new(size);
    let mut rng = Rng::new(seed ^ 0x9f31);
    let deep = rgb(34, 54, 38);
    let lit = rgb(78, 104, 56);
    let extent = size as f32;
    // A central stem with needle fans stepping outwards along it.
    let stem_base = (extent * 0.06, extent * 0.5);
    let stem_tip = (extent * 0.96, extent * 0.5);
    stroke(
        &mut canvas,
        stem_base,
        stem_tip,
        extent * 0.012,
        rgb(62, 48, 34),
        0.7,
    );
    let fans = 15;
    for index in 0..fans {
        let t = index as f32 / (fans - 1) as f32;
        let x = stem_base.0 + (stem_tip.0 - stem_base.0) * t;
        let spread = extent * 0.42 * (1.0 - t * 0.75) * rng.range(0.8, 1.15);
        let needles = 9;
        for needle in 0..needles {
            let n = needle as f32 / (needles - 1) as f32;
            let sign = if needle % 2 == 0 { 1.0 } else { -1.0 };
            let lean = rng.range(0.25, 0.75);
            let end = (
                x + spread * lean * 0.8,
                extent * 0.5 + sign * spread * (0.25 + 0.75 * n),
            );
            let shade = mix(deep, lit, rng.unit() * 0.9);
            stroke(
                &mut canvas,
                (x, extent * 0.5),
                end,
                extent * 0.010,
                shade,
                0.85,
            );
        }
    }
    canvas
}

/// A cluster of five-petal blossoms with a few leaves, for a cherry canopy card.
pub fn blossom_cluster(size: u32, seed: u32) -> Canvas {
    let mut canvas = Canvas::new(size);
    let mut rng = Rng::new(seed ^ 0x51a7);
    let extent = size as f32;
    let leaf = rgb(72, 92, 52);
    // Twigs first, so blossoms sit over them.
    for _ in 0..7 {
        let from = (rng.range(0.0, extent * 0.3), rng.range(0.1, 0.9) * extent);
        let to = (
            from.0 + rng.range(extent * 0.4, extent * 0.9),
            from.1 + rng.range(-0.25, 0.25) * extent,
        );
        stroke(&mut canvas, from, to, extent * 0.009, rgb(70, 54, 46), 0.6);
    }
    for _ in 0..14 {
        let cx = rng.range(0.08, 0.92) * extent;
        let cy = rng.range(0.08, 0.92) * extent;
        let radius = rng.range(0.05, 0.10) * extent;
        stroke(
            &mut canvas,
            (cx, cy),
            (cx + rng.range(-0.6, 0.6) * radius, cy + radius * 1.6),
            extent * 0.012,
            leaf * rng.range(0.8, 1.2),
            0.75,
        );
    }
    // Blossoms: five rounded petals around a warm centre.
    let petal_pale = rgb(248, 226, 232);
    let petal_deep = rgb(226, 158, 182);
    for _ in 0..22 {
        let cx = rng.range(0.07, 0.93) * extent;
        let cy = rng.range(0.07, 0.93) * extent;
        let radius = rng.range(0.055, 0.105) * extent;
        let phase = rng.range(0.0, core::f32::consts::TAU);
        let tone = rng.unit();
        for petal in 0..5 {
            let angle = phase + petal as f32 * core::f32::consts::TAU / 5.0;
            let px = cx + angle.cos() * radius * 0.62;
            let py = cy + angle.sin() * radius * 0.62;
            let petal_radius = radius * 0.5;
            let low = petal_radius.ceil() as i32 + 1;
            for dy in -low..=low {
                for dx in -low..=low {
                    let distance = ((dx * dx + dy * dy) as f32).sqrt();
                    let coverage = smoothstep(petal_radius, petal_radius - 1.1, distance);
                    if coverage <= 0.0 {
                        continue;
                    }
                    let shade = mix(petal_deep, petal_pale, tone * 0.6 + 0.5 * (1.0 - distance / petal_radius));
                    let x = px as i32 + dx;
                    let y = py as i32 + dy;
                    if x < 0 || y < 0 {
                        continue;
                    }
                    canvas.blend(x as u32, y as u32, shade, coverage);
                }
            }
        }
        let centre = rgb(240, 198, 120);
        let core_radius = radius * 0.2;
        let low = core_radius.ceil() as i32 + 1;
        for dy in -low..=low {
            for dx in -low..=low {
                let distance = ((dx * dx + dy * dy) as f32).sqrt();
                let coverage = smoothstep(core_radius, core_radius - 0.8, distance);
                let x = cx as i32 + dx;
                let y = cy as i32 + dy;
                if coverage <= 0.0 || x < 0 || y < 0 {
                    continue;
                }
                canvas.blend(x as u32, y as u32, centre, coverage);
            }
        }
    }
    canvas
}

/// Tall riverside reeds rising from the bottom edge of the card.
pub fn reeds(size: u32, seed: u32) -> Canvas {
    let mut canvas = Canvas::new(size);
    let mut rng = Rng::new(seed ^ 0x2d4b);
    let extent = size as f32;
    let deep = rgb(52, 70, 38);
    let pale = rgb(126, 138, 70);
    for _ in 0..40 {
        let root = rng.range(0.02, 0.98) * extent;
        let height = rng.range(0.55, 0.99) * extent;
        let lean = rng.range(-0.22, 0.22) * extent;
        let shade = mix(deep, pale, rng.unit());
        stroke(
            &mut canvas,
            (root, extent - 1.0),
            (root + lean, extent - height),
            extent * 0.011,
            shade,
            0.8,
        );
    }
    // A few seed heads so the silhouette is not all parallel lines.
    for _ in 0..7 {
        let x = rng.range(0.05, 0.95) * extent;
        let y = rng.range(0.03, 0.30) * extent;
        stroke(
            &mut canvas,
            (x, y),
            (x + rng.range(-3.0, 3.0), y + extent * 0.10),
            extent * 0.018,
            rgb(146, 122, 76),
            0.55,
        );
    }
    canvas
}

/// A distant tree line: opaque silhouettes that stand in for a whole slope.
pub fn treeline(size: u32, seed: u32) -> Canvas {
    let mut canvas = Canvas::new(size);
    let mut rng = Rng::new(seed ^ 0x77c3);
    let extent = size as f32;
    let dark = rgb(46, 58, 44);
    let light = rgb(84, 96, 64);
    let count = 26;
    for index in 0..count {
        let x = (index as f32 + rng.range(-0.35, 0.35)) / count as f32 * extent;
        let height = rng.range(0.45, 0.95) * extent;
        let width = rng.range(0.018, 0.038) * extent;
        let conifer = rng.chance(0.55);
        let shade = mix(dark, light, rng.unit() * 0.8);
        let top = extent - height;
        let steps = height.ceil() as i32;
        for step in 0..steps {
            let t = step as f32 / steps as f32;
            let y = extent - 1.0 - step as f32;
            let profile = if conifer {
                // A cone that narrows towards the tip.
                (1.0 - t).powf(0.75)
            } else {
                // A rounded crown sitting on a short trunk.
                let crown = smoothstep(0.0, 0.25, t) * smoothstep(1.0, 0.55, t);
                (crown * 1.25 + 0.12).min(1.0)
            };
            let half = width * (1.0 + 3.0 * profile);
            let span = half.ceil() as i32;
            for dx in -span..=span {
                let coverage = smoothstep(half, half - 1.0, (dx as f32).abs());
                if coverage <= 0.0 {
                    continue;
                }
                let px = (x as i32 + dx).rem_euclid(size as i32) as u32;
                let depth = 0.82 + 0.3 * (1.0 - t);
                canvas.blend(px, y as u32, shade * depth, coverage);
            }
        }
        let _ = top;
    }
    canvas
}

/// One whole tree on a transparent card, for the billboard LOD band.
///
/// A leaf texture scaled up to tree size reads as a blob; a card that already
/// contains a trunk and a crown keeps the stand looking like trees right up to
/// the distance where the fog takes over.
pub fn tree_card(size: u32, seed: u32, conifer: bool) -> Canvas {
    let mut canvas = Canvas::new(size);
    let mut rng = Rng::new(seed ^ 0x6ca7);
    let extent = size as f32;
    let trunk = rgb(62, 48, 40);
    let (dark, light) = if conifer {
        (rgb(38, 56, 40), rgb(86, 108, 60))
    } else {
        (rgb(176, 120, 146), rgb(246, 214, 224))
    };

    // Trunk first, from the bottom edge up into the crown.
    let root = extent * 0.5 + rng.range(-0.03, 0.03) * extent;
    let crown_base = if conifer { 0.82 } else { 0.58 };
    stroke(
        &mut canvas,
        (root, extent - 1.0),
        (root + rng.range(-0.02, 0.02) * extent, extent * (1.0 - crown_base)),
        extent * if conifer { 0.016 } else { 0.026 },
        trunk,
        0.55,
    );

    if conifer {
        // Stacked skirts narrowing to a leader.
        let tiers = 9;
        for tier in 0..tiers {
            let t = tier as f32 / (tiers - 1) as f32;
            let y = extent * (0.94 - 0.86 * t);
            let half = extent * 0.30 * (1.0 - t).powf(0.8) * rng.range(0.85, 1.12);
            let thickness = extent * 0.055 * (1.0 - t * 0.5);
            let shade = mix(dark, light, rng.range(0.15, 0.85));
            let span = half.ceil() as i32;
            let rise = thickness.ceil() as i32;
            for dy in -rise..=rise {
                for dx in -span..=span {
                    // A drooping skirt: widest at its centre line, tapering out.
                    let across = (dx as f32).abs() / half.max(1.0);
                    let profile = (1.0 - across).max(0.0);
                    let limit = thickness * profile;
                    let coverage = smoothstep(limit, limit - 1.2, (dy as f32).abs());
                    if coverage <= 0.0 {
                        continue;
                    }
                    let x = root as i32 + dx;
                    let py = y as i32 + dy;
                    if x < 0 || py < 0 {
                        continue;
                    }
                    canvas.blend(x as u32, py as u32, shade * (0.85 + 0.3 * profile), coverage);
                }
            }
        }
    } else {
        // A rounded crown built from overlapping blobs.
        let centre = (root, extent * 0.33);
        let radius = extent * 0.31;
        for _ in 0..26 {
            let angle = rng.range(0.0, core::f32::consts::TAU);
            let reach = radius * rng.unit().sqrt() * 0.85;
            let cx = centre.0 + angle.cos() * reach;
            let cy = centre.1 + angle.sin() * reach * 0.82;
            let blob = radius * rng.range(0.22, 0.40);
            let shade = mix(dark, light, rng.unit());
            let span = blob.ceil() as i32 + 1;
            for dy in -span..=span {
                for dx in -span..=span {
                    let distance = ((dx * dx + dy * dy) as f32).sqrt();
                    let coverage = smoothstep(blob, blob - 1.4, distance);
                    if coverage <= 0.0 {
                        continue;
                    }
                    let x = cx as i32 + dx;
                    let y = cy as i32 + dy;
                    if x < 0 || y < 0 {
                        continue;
                    }
                    canvas.blend(x as u32, y as u32, shade, coverage);
                }
            }
        }
    }
    canvas
}

/// A single petal, drawn once and instanced by the runtime's particles.
pub fn petal(size: u32, seed: u32) -> Canvas {
    let mut canvas = Canvas::new(size);
    let pale = rgb(255, 238, 242);
    let deep = rgb(238, 168, 190);
    let _ = seed;
    canvas.fill(|u, v| {
        // A rounded teardrop: wide at the base, notched at the tip.
        let x = (u - 0.5) * 2.0;
        let y = (v - 0.5) * 2.0;
        let body = 1.0 - (x * x / 0.55 + y * y / 0.95);
        let notch = smoothstep(0.0, 0.35, (y + 0.72).max(0.0) * (0.34 - x.abs() * 1.6).max(0.0) * 9.0);
        let coverage = smoothstep(0.0, 0.22, body) * (1.0 - notch);
        let shade = mix(deep, pale, smoothstep(-0.9, 0.7, y) * 0.85 + 0.15);
        (shade, coverage)
    });
    canvas
}

/// A soft round puff for mist and the sun's bloom.
pub fn puff(size: u32) -> Canvas {
    let mut canvas = Canvas::new(size);
    canvas.fill(|u, v| {
        let distance = ((u - 0.5).powi(2) + (v - 0.5).powi(2)).sqrt() * 2.0;
        let coverage = (1.0 - distance).clamp(0.0, 1.0).powf(2.4);
        (Vec3::ONE, coverage)
    });
    canvas
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn tiling_textures_are_opaque_everywhere() {
        for canvas in [
            meadow(32, 1),
            gravel(32, 2),
            rock(32, 3),
            pine_bark(32, 4),
            cherry_bark(32, 5),
            planks(32, 6),
            roof_tiles(32, 7),
            thatch(32, 10),
            ripples(32, 11),
            lacquer(32, 8),
            plaster(32, 9),
        ] {
            assert!(canvas.pixels.chunks_exact(4).all(|texel| texel[3] == 255));
        }
    }

    #[test]
    fn cutouts_carry_both_covered_and_clear_texels() {
        for canvas in [
            pine_spray(64, 1),
            blossom_cluster(64, 2),
            reeds(64, 3),
            treeline(64, 4),
            tree_card(64, 5, true),
            tree_card(64, 6, false),
            petal(32, 5),
        ] {
            let covered = canvas
                .pixels
                .chunks_exact(4)
                .filter(|texel| texel[3] > 200)
                .count();
            let clear = canvas
                .pixels
                .chunks_exact(4)
                .filter(|texel| texel[3] < 20)
                .count();
            assert!(covered > 16, "nothing was drawn");
            assert!(clear > 16, "the card has no transparent background");
        }
    }

    #[test]
    fn a_tiling_texture_matches_across_its_seam() {
        let canvas = meadow(64, 11);
        let size = canvas.size;
        let mut worst = 0.0f32;
        for y in 0..size {
            let (left, _) = canvas.get(0, y);
            let (right, _) = canvas.get(size - 1, y);
            worst = worst.max((left - right).abs().max_element());
        }
        // Adjacent texels across the wrap should differ no more than
        // neighbouring texels inside the map do.
        let mut interior = 0.0f32;
        for y in 0..size {
            let (a, _) = canvas.get(size / 2, y);
            let (b, _) = canvas.get(size / 2 + 1, y);
            interior = interior.max((a - b).abs().max_element());
        }
        assert!(worst <= interior * 2.0 + 0.05, "{worst} vs {interior}");
    }

    #[test]
    fn reeds_are_rooted_at_the_bottom_edge() {
        let canvas = reeds(64, 3);
        let size = canvas.size;
        let bottom = (0..size)
            .filter(|&x| canvas.get(x, size - 2).1 > 0.5)
            .count();
        let top = (0..size).filter(|&x| canvas.get(x, 1).1 > 0.5).count();
        assert!(bottom > top, "{bottom} vs {top}");
    }
}
