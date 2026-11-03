use pocket_render::{word_len, DecodeError, DrawOps, MAX_CLIP_DEPTH};
use pocket_drivers::DamageRect;
use pocket_spec::draw_op::*;

const SCREEN: DamageRect = DamageRect::new(0, 0, 100, 80);

fn xy(x: i16, y: i16) -> u32 {
    x as u16 as u32 | ((y as u16 as u32) << 16)
}

fn wh(w: u16, h: u16) -> u32 {
    w as u32 | ((h as u32) << 16)
}

#[test]
fn all_ten_records_preserve_the_original_words_and_offsets() {
    let records: &[&[u32]] = &[
        &[RECT, 0, 0, 0xff00_0000],
        &[GRAD_RECT, 0, 0, 1, 2, 0],
        &[GLYPH_RUN, 2 << 16, 0xff00_0000, 0, 4, 0, 9],
        &[TEX_QUAD, 0, 0, 0, 0, 0, 0, 0, 0],
        &[SCISSOR, 0, 0],
        &[SCISSOR_POP],
        &[TRI, 0, 0, 0, 1, 2, 3],
        &[TEX_TRI, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0],
        &[TEXT_RUN, 0, 0, 0, 0, 0, 0, 5, 0x6463_6261, 0x65],
        &[SURFACE_QUAD, 0, 0, 0, 0, 0, 0, 0, 0],
    ];
    let words: Vec<u32> = records
        .iter()
        .flat_map(|record| record.iter().copied())
        .collect();
    let decoded: Vec<_> = DrawOps::new(&words, SCREEN)
        .collect::<Result<_, _>>()
        .unwrap();
    assert_eq!(decoded.len(), 10);
    let mut offset = 0;
    for (operation, record) in decoded.iter().zip(records) {
        assert_eq!(operation.words, *record);
        assert_eq!(operation.words.as_ptr(), words[offset..].as_ptr());
        assert_eq!(operation.opcode, record[0]);
        offset += record.len();
    }
    assert_eq!(offset, words.len());
}

#[test]
fn absolute_scissors_restore_the_previous_clip_and_guard_the_viewport() {
    let words = [
        SCISSOR,
        xy(-3, 4),
        wh(10, 20),
        RECT,
        0,
        0,
        0,
        // The producer supplies absolute clips. SET does not intersect the
        // earlier scissor a second time; the viewport remains a hard bound.
        SCISSOR,
        xy(5, 6),
        wh(200, 200),
        RECT,
        0,
        0,
        0,
        SCISSOR_POP,
        RECT,
        0,
        0,
        0,
        SCISSOR_POP,
        RECT,
        0,
        0,
        0,
    ];
    let clips: Vec<_> = DrawOps::new(&words, SCREEN)
        .map(Result::unwrap)
        .filter(|operation| operation.opcode == RECT)
        .map(|operation| operation.clip)
        .collect();
    assert_eq!(
        clips,
        [
            DamageRect::new(0, 4, 7, 24),
            DamageRect::new(5, 6, 100, 80),
            DamageRect::new(0, 4, 7, 24),
            SCREEN
        ]
    );
}

#[test]
fn truncated_variable_records_and_unknown_opcodes_end_iteration() {
    for words in [
        vec![GLYPH_RUN, 1 << 16, 0, 0],
        vec![TEXT_RUN, 0, 0, 0, 0, 0, 0, u32::MAX],
        vec![TEX_TRI, 0],
        vec![SCISSOR, 0],
    ] {
        let mut decoder = DrawOps::new(&words, SCREEN);
        assert_eq!(decoder.next(), Some(Err(DecodeError::Truncated)));
        assert_eq!(decoder.next(), None);
        assert_eq!(decoder.next(), None);
    }
    let mut decoder = DrawOps::new(&[u32::MAX, RECT, 0, 0, 0], SCREEN);
    assert_eq!(decoder.next(), Some(Err(DecodeError::UnknownOperation)));
    assert_eq!(decoder.next(), None);
    assert_eq!(
        word_len(&[RECT, 0, 0, 0], usize::MAX),
        Err(DecodeError::Truncated)
    );
}

#[test]
fn every_short_prefix_of_a_record_is_rejected() {
    let records: &[&[u32]] = &[
        &[RECT, 0, 0, 0],
        &[GRAD_RECT, 0, 0, 0, 0, 0],
        &[GLYPH_RUN, 1 << 16, 0, 0, 0],
        &[TEX_QUAD, 0, 0, 0, 0, 0, 0, 0, 0],
        &[SCISSOR, 0, 0],
        &[SCISSOR_POP],
        &[TRI, 0, 0, 0, 0, 0, 0],
        &[TEX_TRI, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0],
        &[TEXT_RUN, 0, 0, 0, 0, 0, 0, 4, 0],
        &[SURFACE_QUAD, 0, 0, 0, 0, 0, 0, 0, 0],
    ];
    for record in records {
        for cut in 0..record.len() {
            assert_eq!(word_len(&record[..cut], 0), Err(DecodeError::Truncated));
        }
        assert_eq!(word_len(record, 0), Ok(record.len()));
    }
}

#[test]
fn clip_stack_errors_are_explicit_and_terminal() {
    let mut underflow = DrawOps::new(&[SCISSOR_POP], SCREEN);
    assert_eq!(underflow.next(), Some(Err(DecodeError::ClipUnderflow)));
    assert_eq!(underflow.next(), None);
    let mut unbalanced = DrawOps::new(&[SCISSOR, 0, 0], SCREEN);
    assert!(unbalanced.next().unwrap().is_ok());
    assert_eq!(unbalanced.next(), Some(Err(DecodeError::UnbalancedClip)));
    assert_eq!(unbalanced.next(), None);
    let words: Vec<_> = (0..MAX_CLIP_DEPTH + 1)
        .flat_map(|_| [SCISSOR, 0, 0])
        .collect();
    let mut overflow = DrawOps::new(&words, SCREEN);
    for _ in 0..MAX_CLIP_DEPTH {
        assert!(overflow.next().unwrap().is_ok());
    }
    assert_eq!(overflow.next(), Some(Err(DecodeError::ClipOverflow)));
    assert_eq!(overflow.next(), None);
}

mod records {
    use super::{wh, xy, SCREEN};
    use pocket_render::record::{
        Glyph, GradRect, Rect, Scissor, SurfaceQuad, TexQuad, TexTri, Tri,
    };
    use pocket_render::{gradient_corners, record, Corners, DecodeError, DrawOps, Record};
    use pocket_drivers::DamageRect;
    use pocket_spec::draw_op::*;
    use pocket_spec::GradDir;

    #[test]
    fn every_record_decodes_its_fields_from_the_operation() {
        let words = [
            RECT,
            xy(-3, 4),
            wh(5, 6),
            0x8040_3020,
            GRAD_RECT,
            xy(7, -8),
            wh(9, 10),
            0xff00_0001,
            0xff00_0002,
            GradDir::ToLeft as u32,
            GLYPH_RUN,
            2 << 16 | 0x0100 | 5,
            0xff11_2233,
            xy(1, 2),
            0x0001_0007,
            xy(3, 4),
            9,
            TEX_QUAD,
            12,
            xy(10, 11),
            wh(12, 13),
            0.25f32.to_bits(),
            0.5f32.to_bits(),
            0.75f32.to_bits(),
            1.0f32.to_bits(),
            0x8000_00ff,
            SCISSOR,
            xy(-1, -2),
            wh(300, 400),
            SCISSOR_POP,
            TRI,
            xy(1, 2),
            xy(3, 4),
            xy(5, 6),
            7,
            8,
            9,
            TEX_TRI,
            3,
            xy(1, 2),
            0.1f32.to_bits(),
            0.2f32.to_bits(),
            xy(3, 4),
            0.3f32.to_bits(),
            0.4f32.to_bits(),
            xy(5, 6),
            0.5f32.to_bits(),
            0.6f32.to_bits(),
            0x1234_5678,
            TEXT_RUN,
            0x0201,
            1.5f32.to_bits(),
            2.5f32.to_bits(),
            100.0f32.to_bits(),
            f32::NAN.to_bits(),
            0xff00_ff00,
            5,
            0x6463_6261,
            0x65,
            SURFACE_QUAD,
            4,
            1.5f32.to_bits(),
            2.5f32.to_bits(),
            30.0f32.to_bits(),
            40.0f32.to_bits(),
            xy(2, 3),
            wh(20, 30),
            1,
        ];
        let records: Vec<_> = DrawOps::new(&words, DamageRect::new(0, 0, 1000, 1000))
            .map(|operation| operation.unwrap().record().unwrap())
            .collect();
        assert_eq!(records.len(), 10);
        assert_eq!(
            records[0],
            Record::Rect(Rect {
                x: -3,
                y: 4,
                width: 5,
                height: 6,
                color: 0x8040_3020
            })
        );
        let Record::GradRect(gradient) = records[1] else {
            panic!("{:?}", records[1]);
        };
        assert_eq!(
            gradient,
            GradRect {
                x: 7,
                y: -8,
                width: 9,
                height: 10,
                from: 0xff00_0001,
                to: 0xff00_0002,
                direction: GradDir::ToLeft as u32
            }
        );
        assert_eq!(gradient.bounds(), DamageRect::new(7, -8, 16, 2));
        let Record::GlyphRun(run) = records[2] else {
            panic!("{:?}", records[2]);
        };
        assert_eq!((run.slot, run.color, run.len()), (5, 0xff11_2233, 2));
        assert_eq!(
            run.glyphs().collect::<Vec<_>>(),
            [Glyph { x: 1, y: 2, gid: 7 }, Glyph { x: 3, y: 4, gid: 9 }]
        );
        assert_eq!(run.cell_words(), &words[13..17]);
        assert_eq!(
            records[3],
            Record::TexQuad(TexQuad {
                texture: 12,
                x: 10,
                y: 11,
                width: 12,
                height: 13,
                uv0: [0.25, 0.5],
                uv1: [0.75, 1.0],
                color: 0x8000_00ff
            })
        );
        assert_eq!(
            records[4],
            Record::Scissor(Scissor {
                rect: DamageRect::new(-1, -2, 299, 398)
            })
        );
        assert_eq!(records[5], Record::ScissorPop);
        assert_eq!(
            records[6],
            Record::Tri(Tri {
                positions: [[1, 2], [3, 4], [5, 6]],
                colors: [7, 8, 9]
            })
        );
        assert_eq!(
            records[7],
            Record::TexTri(TexTri {
                texture: 3,
                positions: [[1, 2], [3, 4], [5, 6]],
                uvs: [[0.1, 0.2], [0.3, 0.4], [0.5, 0.6]],
                color: 0x1234_5678
            })
        );
        let Record::TextRun(text) = records[8] else {
            panic!("{:?}", records[8]);
        };
        assert_eq!((text.slot, text.align), (1, 2));
        assert_eq!(text.origin, [1.5, 2.5]);
        assert_eq!(text.box_width, 100.0);
        assert!(text.line_height.is_nan());
        assert_eq!((text.color, text.bytes), (0xff00_ff00, 5));
        assert_eq!(text.payload_words(), &[0x6463_6261, 0x65]);
        let Record::SurfaceQuad(surface) = records[9] else {
            panic!("{:?}", records[9]);
        };
        assert_eq!(
            surface,
            SurfaceQuad {
                surface: 4,
                x: 1.5,
                y: 2.5,
                width: 30.0,
                height: 40.0,
                clip_x: 2,
                clip_y: 3,
                clip_width: 20,
                clip_height: 30,
                flags: 1
            }
        );
        assert_eq!(surface.clip(), DamageRect::new(2, 3, 22, 33));
        assert!(surface.focused());
    }

    #[test]
    fn gradient_corners_place_from_at_the_axis_start_or_end() {
        let (from, to) = (1, 2);
        let corners = |direction: GradDir| gradient_corners(from, to, direction as u32);
        assert_eq!(
            corners(GradDir::ToBottom),
            Corners {
                top_left: 1,
                top_right: 1,
                bottom_right: 2,
                bottom_left: 2
            }
        );
        assert_eq!(
            corners(GradDir::ToTop),
            Corners {
                top_left: 2,
                top_right: 2,
                bottom_right: 1,
                bottom_left: 1
            }
        );
        assert_eq!(
            corners(GradDir::ToRight),
            Corners {
                top_left: 1,
                top_right: 2,
                bottom_right: 2,
                bottom_left: 1
            }
        );
        assert_eq!(
            corners(GradDir::ToLeft),
            Corners {
                top_left: 2,
                top_right: 1,
                bottom_right: 1,
                bottom_left: 2
            }
        );
        assert_eq!(
            gradient_corners(from, to, 99),
            corners(GradDir::ToBottom),
            "an unknown direction paints to the bottom"
        );
        assert_eq!(corners(GradDir::ToRight).clockwise(), [1, 2, 2, 1]);
        assert_eq!(
            GradRect {
                x: 0,
                y: 0,
                width: 1,
                height: 1,
                from,
                to,
                direction: GradDir::ToTop as u32
            }
            .corners(),
            corners(GradDir::ToTop)
        );
    }

    #[test]
    fn records_reject_short_and_unknown_words_and_ignore_trailing_words() {
        assert_eq!(record(&[RECT, 0, 0]), Err(DecodeError::Truncated));
        assert_eq!(record(&[]), Err(DecodeError::Truncated));
        assert_eq!(
            record(&[u32::MAX, 0, 0, 0]),
            Err(DecodeError::UnknownOperation)
        );
        assert_eq!(
            record(&[SCISSOR_POP, RECT, 0, 0, 0]),
            Ok(Record::ScissorPop)
        );
        let words = [RECT, 0, wh(1, 1), 0];
        let mut operation = DrawOps::new(&words, SCREEN).next().unwrap().unwrap();
        operation.words = &operation.words[..2];
        assert_eq!(operation.record(), Err(DecodeError::Truncated));
    }
}
