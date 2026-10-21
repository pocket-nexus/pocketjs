use pocket_draw_ops::{word_len, DecodeError, DrawOps, MAX_CLIP_DEPTH};
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
