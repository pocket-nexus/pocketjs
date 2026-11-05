//! The media stream's wire (contracts/spec/media.ts; platforms/3ds/media_wire.h
//! and media_adpcm.h are the 3DS's copy): header and packet checks, the PAL8
//! reference picture and IMA ADPCM blocks. No device calls, so the host
//! fixture (tests/fixtures/psp-runtime) runs these.

pub const MAGIC: u32 = 0x564d_4b50;
pub const HEADER_BYTES: usize = 32;
pub const PACKET_HEADER_BYTES: usize = 16;
pub const PACKET_BYTES: usize = 128 * 1024;
pub const WIDTH: usize = 512;
pub const HEIGHT: usize = 256;
pub const SAMPLE_RATE: u32 = 22050;
pub const AUDIO_FRAMES: usize = 1024;
pub const CODEC_H264: u16 = 1;
pub const CODEC_PAL8: u16 = 2;
pub const PACKET_VIDEO: u8 = 1;
pub const PACKET_AUDIO: u8 = 2;
pub const PACKET_END: u8 = 3;
pub const PACKET_ERROR: u8 = 4;

pub fn u16_at(p: &[u8], at: usize) -> u16 {
    u16::from_le_bytes([p[at], p[at + 1]])
}

pub fn u32_at(p: &[u8], at: usize) -> u32 {
    u32::from_le_bytes([p[at], p[at + 1], p[at + 2], p[at + 3]])
}

/// The stream header's fields this console reads.
pub struct Header {
    pub fps: u16,
    pub codec: u16,
    pub origin_ms: u32,
    pub duration_ms: u32,
}

pub fn header(p: &[u8; HEADER_BYTES]) -> Option<Header> {
    let fps = u16_at(p, 12);
    let codec = u16_at(p, 14);
    let valid = u32_at(p, 0) == MAGIC
        && u16_at(p, 4) == 1
        && u16_at(p, 6) == HEADER_BYTES as u16
        && u16_at(p, 8) as usize == WIDTH
        && u16_at(p, 10) as usize == HEIGHT
        && (1..=60).contains(&fps)
        && (codec == CODEC_H264 || codec == CODEC_PAL8)
        && u32_at(p, 16) == SAMPLE_RATE
        && u16_at(p, 20) == 2
        && u16_at(p, 22) == 2;
    valid.then(|| Header {
        fps,
        codec,
        origin_ms: u32_at(p, 24),
        duration_ms: u32_at(p, 28),
    })
}

/// A packet header: (kind, payload bytes, pts) when it is well formed.
pub fn packet(p: &[u8; PACKET_HEADER_BYTES]) -> Option<(u8, usize, u32)> {
    let n = u32_at(p, 4) as usize;
    if p[1] != 0 || u16_at(p, 2) != 0 || u32_at(p, 12) != 0 || n > PACKET_BYTES {
        return None;
    }
    let valid = match p[0] {
        PACKET_VIDEO => n >= 4,
        PACKET_AUDIO => (8..=AUDIO_FRAMES + 7).contains(&n),
        PACKET_END => n == 0,
        PACKET_ERROR => n > 0 && n <= 160,
        _ => false,
    };
    valid.then(|| (p[0], n, u32_at(p, 8)))
}

/// The PAL8 reference picture both ends keep for one stream: its size, fixed
/// by the first packet, and the palette as a GE CLUT (256 R,G,B,A entries).
pub struct Pal8 {
    pub width: usize,
    pub height: usize,
    pub palette_set: bool,
    pub clut: [u8; 1024],
}

impl Pal8 {
    pub const fn new() -> Self {
        Self {
            width: 0,
            height: 0,
            palette_set: false,
            clut: [0; 1024],
        }
    }
}

/// The size a PAL8 packet names, before any of it is applied.
pub fn pal8_size(p: &[u8]) -> Option<(usize, usize)> {
    if p.len() < 8 {
        return None;
    }
    let (w, h) = (u16_at(p, 0) as usize, u16_at(p, 2) as usize);
    (w > 0 && h > 0 && w <= WIDTH && h <= HEIGHT).then_some((w, h))
}

fn varint(p: &[u8], at: &mut usize) -> Option<usize> {
    let mut value = 0usize;
    for shift in [0, 7, 14] {
        let byte = *p.get(*at)?;
        *at += 1;
        value |= ((byte & 127) as usize) << shift;
        if byte & 128 == 0 {
            return Some(value);
        }
    }
    None
}

/// RGB565 to a CLUT entry: 8-bit channels with the high bits repeated, opaque.
pub fn clut_entry(c: u16) -> [u8; 4] {
    let (r, g, b) = ((c >> 11) & 31, (c >> 5) & 63, c & 31);
    [
        ((r << 3) | (r >> 2)) as u8,
        ((g << 2) | (g >> 4)) as u8,
        ((b << 3) | (b >> 2)) as u8,
        0xff,
    ]
}

/// Apply one PAL8 packet to `reference` (width x height index bytes). False
/// when it is malformed; `reference` may then be partly updated and the
/// stream must stop.
pub fn pal8_apply(state: &mut Pal8, reference: &mut [u8], p: &[u8]) -> bool {
    let Some((w, h)) = pal8_size(p) else { return false };
    let colors = u16_at(p, 4) as usize;
    if u16_at(p, 6) != 0 || colors > 256 {
        return false;
    }
    if state.width != 0 && (w != state.width || h != state.height) {
        return false;
    }
    if colors == 0 && !state.palette_set {
        return false;
    }
    let mut at = 8 + colors * 2;
    if at > p.len() || reference.len() < w * h {
        return false;
    }
    for i in 0..colors {
        state.clut[i * 4..i * 4 + 4].copy_from_slice(&clut_entry(u16_at(p, 8 + i * 2)));
    }
    if colors != 0 {
        state.palette_set = true;
    }
    state.width = w;
    state.height = h;
    let total = w * h;
    let mut pixel = 0;
    while pixel < total {
        let (Some(skip), Some(count)) = (varint(p, &mut at), varint(p, &mut at)) else {
            return false;
        };
        if pixel + skip + count > total || at + count > p.len() {
            return false;
        }
        pixel += skip;
        reference[pixel..pixel + count].copy_from_slice(&p[at..at + count]);
        pixel += count;
        at += count;
    }
    at == p.len()
}

const IMA_STEPS: [u16; 89] = [
    7, 8, 9, 10, 11, 12, 13, 14, 16, 17, 19, 21, 23, 25, 28, 31, 34, 37, 41, 45, 50, 55, 60, 66,
    73, 80, 88, 97, 107, 118, 130, 143, 157, 173, 190, 209, 230, 253, 279, 307, 337, 371, 408,
    449, 494, 544, 598, 658, 724, 796, 876, 963, 1060, 1166, 1282, 1411, 1552, 1707, 1878, 2066,
    2272, 2499, 2749, 3024, 3327, 3660, 4026, 4428, 4871, 5358, 5894, 6484, 7132, 7845, 8630,
    9493, 10442, 11487, 12635, 13899, 15289, 16818, 18500, 20350, 22385, 24623, 27086, 29794,
    32767,
];
const IMA_INDEX: [i32; 8] = [-1, -1, -1, -1, 2, 4, 6, 8];

/// One stereo IMA ADPCM block into interleaved PCM: the frames written, 0
/// when the block is malformed. `out` holds AUDIO_FRAMES * 2 samples.
pub fn decode_audio(p: &[u8], out: &mut [i16]) -> usize {
    let n = p.len();
    if !(8..=AUDIO_FRAMES + 7).contains(&n) || p[2] > 88 || p[6] > 88 || p[3] != 0 || p[7] != 0 {
        return 0;
    }
    let frames = n - 7;
    if out.len() < frames * 2 {
        return 0;
    }
    let mut value = [u16_at(p, 0) as i16 as i32, u16_at(p, 4) as i16 as i32];
    let mut index = [p[2] as i32, p[6] as i32];
    out[0] = value[0] as i16;
    out[1] = value[1] as i16;
    for frame in 1..frames {
        for ch in 0..2 {
            let code = ((p[frame + 7] >> (ch * 4)) & 15) as i32;
            let step = IMA_STEPS[index[ch] as usize] as i32;
            let mut delta = step >> 3;
            if code & 4 != 0 {
                delta += step;
            }
            if code & 2 != 0 {
                delta += step >> 1;
            }
            if code & 1 != 0 {
                delta += step >> 2;
            }
            value[ch] = (value[ch] + if code & 8 != 0 { -delta } else { delta }).clamp(-32768, 32767);
            index[ch] = (index[ch] + IMA_INDEX[(code & 7) as usize]).clamp(0, 88);
            out[frame * 2 + ch] = value[ch] as i16;
        }
    }
    frames
}

/// Expand a `w` x `h` index picture into the 512-wide texture `out`, and
/// repeat its last column and row once, so linear filtering at the picture's
/// edge reads no pixel from outside it.
pub fn expand(picture: &[u8], w: usize, h: usize, out: &mut [u8]) {
    for y in 0..h {
        let row = &mut out[y * WIDTH..y * WIDTH + w];
        row.copy_from_slice(&picture[y * w..(y + 1) * w]);
        if w < WIDTH {
            out[y * WIDTH + w] = picture[y * w + w - 1];
        }
    }
    if h < HEIGHT {
        let span = (w + usize::from(w < WIDTH)).min(WIDTH);
        out.copy_within((h - 1) * WIDTH..(h - 1) * WIDTH + span, h * WIDTH);
    }
}
