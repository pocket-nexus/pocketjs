//! Hero-specific hardware bindings for assets baked from the generated view.
//! Model, input, Show branches and easing still execute in the MicroTS app.

use pocketjs_gba::video::{Background, OamBuffer, Presenter, Sprite, SpriteShape};

mod art {
    include!(concat!(env!("GBA_GENERATED"), "/assets.rs"));
}

// Word offsets in the 32 KiB OBJ character memory. All allocations align to 8bpp tiles.
const SPINNER: usize = 0;
const UNDERLINE: usize = SPINNER + 32 * 48 / 2;
const BUTTON: usize = UNDERLINE + 160 * 16 / 2;
const MESSAGE: usize = BUTTON + 96 * 48 / 2;
const DIGITS: usize = MESSAGE + 224 * 16 / 2;

pub struct Scene {
    presenter: Presenter,
    oam: OamBuffer,
    previous_phase: usize,
    previous_width: usize,
    previous_button: usize,
    phase: usize,
    width: usize,
    button: usize,
}

impl Scene {
    pub unsafe fn new() -> Self {
        let mut presenter = Presenter::initialize(
            &Background {
                palette: &art::BG_PALETTE,
                tiles: &art::BG_TILES,
                map: &art::BG_MAP,
            },
            &art::OBJ_PALETTE,
        )
        .unwrap();
        presenter
            .upload_obj_tiles(MESSAGE, art::MESSAGE[0])
            .unwrap();
        for (index, digit) in art::DIGITS.iter().enumerate() {
            presenter
                .upload_obj_tiles(DIGITS + index * 256, digit)
                .unwrap();
        }
        Self {
            presenter,
            oam: OamBuffer::new(),
            previous_phase: usize::MAX,
            previous_width: usize::MAX,
            previous_button: usize::MAX,
            phase: 0,
            width: 0,
            button: 0,
        }
    }

    fn patch(&mut self, first: usize, crop: [i16; 4], words: usize, dx: i32, visible: bool) {
        let columns = crop[2] as usize / 32;
        let rows = crop[3] as usize / 16;
        for row in 0..rows {
            for column in 0..columns {
                let index = row * columns + column;
                let x = i32::from(crop[0]) + dx + column as i32 * 32;
                if !visible || x >= 240 || x + 32 <= 0 {
                    self.oam.hide(first + index).unwrap();
                } else {
                    self.oam
                        .set(
                            first + index,
                            Sprite {
                                x: x as i16,
                                y: crop[1] + row as i16 * 16,
                                shape: SpriteShape::Wide32x16,
                                tile_index: (words / 16 + index * 16) as u16,
                                priority: 0,
                            },
                        )
                        .unwrap();
                }
            }
        }
    }

    /// Build the OAM shadow during active display; upload only during VBlank.
    pub fn update(&mut self, count: i32, phase: i32, width: f32, translation: f32, color: u32) {
        self.phase = (phase as usize).min(art::SPINNER.len() - 1);
        self.width = (width.max(0.0).min(144.0) + 0.5) as usize;
        self.button = art::BUTTON_COLORS
            .iter()
            .enumerate()
            .min_by_key(|(_, sample)| {
                [0, 8, 16]
                    .iter()
                    .map(|shift| {
                        let difference =
                            ((color >> shift) & 255) as i32 - ((**sample >> shift) & 255) as i32;
                        difference * difference
                    })
                    .sum::<i32>()
            })
            .unwrap()
            .0;
        self.patch(0, art::MESSAGE_CROP, MESSAGE, 0, count > 3);
        self.patch(18, art::UNDERLINE_CROP, UNDERLINE, translation as i32, true);
        self.patch(23, art::SPINNER_CROP, SPINNER, 0, true);
        self.patch(26, art::BUTTON_CROP, BUTTON, 0, true);
        // Decimal formatting updates OAM tile references; glyph pixels stay in VRAM.
        let mut digits = [0usize; 11];
        let mut length = 0;
        let mut number = count.unsigned_abs();
        loop {
            digits[length] = (number % 10) as usize;
            length += 1;
            number /= 10;
            if number == 0 {
                break;
            }
        }
        if count < 0 {
            digits[length] = 10;
            length += 1;
        }
        let mut x = art::DIGITS_CROP[0] * 4 + art::PREFIX_ADVANCE;
        for index in 0..11 {
            if index >= length || x >= 240 * 4 {
                self.oam.hide(7 + index).unwrap();
                continue;
            }
            let digit = digits[length - 1 - index];
            self.oam
                .set(
                    7 + index,
                    Sprite {
                        x: (x + 2) / 4,
                        y: art::DIGITS_CROP[1],
                        shape: SpriteShape::Tall16x32,
                        tile_index: (DIGITS / 16 + digit * 16) as u16,
                        priority: 0,
                    },
                )
                .unwrap();
            x += art::DIGIT_ADVANCES[digit];
        }
    }

    /// The LCD controller draws BG/OBJ pixels. DMA only replaces changed art/OAM.
    pub unsafe fn present(&mut self) -> usize {
        let mut bytes = 0;
        if self.phase != self.previous_phase {
            bytes += self
                .presenter
                .upload_obj_tiles(SPINNER, art::SPINNER[self.phase])
                .unwrap();
            self.previous_phase = self.phase;
        }
        if self.width != self.previous_width {
            bytes += self
                .presenter
                .upload_obj_tiles(UNDERLINE, art::UNDERLINE[self.width])
                .unwrap();
            self.previous_width = self.width;
        }
        if self.button != self.previous_button {
            bytes += self
                .presenter
                .upload_obj_tiles(BUTTON, art::BUTTON[self.button])
                .unwrap();
            self.previous_button = self.button;
        }
        bytes += self.presenter.present(&mut self.oam);
        self.presenter.enable();
        bytes
    }
}
