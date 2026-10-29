//! The speaker as one stream. An `aplay` started for each sound loses the
//! start of it: the ES8389 powers its DAC and amplifier up when a PCM opens,
//! and a 150 ms beep played as its own `aplay` reached the microphone as one
//! faint 50 ms tail (measured 2026-10-29 by recording the microphone while
//! the speaker played). Here a sound is mixed into a queue of 16 kHz mono
//! samples. The first sound opens the output and writes 300 ms of silence
//! before it; from then the stream is kept about 80 ms ahead of the wall
//! clock, silence between sounds, so a metronome's clicks land on their beats
//! without waiting for the codec. Four seconds after the last sound the
//! output closes and the codec powers down.
//!
//! An output that fails (a player that cannot reach the codec) is replaced
//! by the next one the opener names, and the queued sound goes there.

use std::{
    collections::VecDeque,
    sync::{Arc, Mutex, MutexGuard},
    thread,
    time::{Duration, Instant},
};

pub const RATE: u32 = super::dsp::RATE;

/// Where the samples go: `aplay` on Linux, nowhere in the mock.
pub trait Output: Send {
    fn write(&mut self, samples: &[i16]) -> Result<(), String>;
}

/// The mock's output.
pub struct Silent;

impl Output for Silent {
    fn write(&mut self, _: &[i16]) -> Result<(), String> {
        Ok(())
    }
}

/// Opens output number `attempt`; `None` when there is no further one.
pub type Opener = dyn Fn(usize) -> Option<Result<Box<dyn Output>, String>> + Send + Sync;

#[derive(Clone, Copy, Debug)]
pub struct Timing {
    /// Silence written when the output opens, while the codec powers up.
    pub preroll: Duration,
    /// How far the stream runs ahead of the wall clock.
    pub lead: Duration,
    /// The size of one write.
    pub chunk: Duration,
    /// Silence after the last sound before the output closes.
    pub idle: Duration,
}

impl Default for Timing {
    fn default() -> Self {
        Self { preroll: Duration::from_millis(300), lead: Duration::from_millis(80), chunk: Duration::from_millis(20), idle: Duration::from_secs(4) }
    }
}

fn samples(duration: Duration) -> usize {
    (duration.as_secs_f64() * RATE as f64).round() as usize
}

struct State {
    queue: VecDeque<i16>,
    running: bool,
    last_sound: Instant,
    error: Option<String>,
}

struct Shared {
    state: Mutex<State>,
    open: Box<Opener>,
    timing: Timing,
}

impl Shared {
    fn lock(&self) -> MutexGuard<'_, State> {
        self.state.lock().unwrap_or_else(|poisoned| poisoned.into_inner())
    }
}

#[derive(Clone)]
pub struct Speaker(Arc<Shared>);

impl Speaker {
    pub fn new(timing: Timing, open: impl Fn(usize) -> Option<Result<Box<dyn Output>, String>> + Send + Sync + 'static) -> Speaker {
        Speaker(Arc::new(Shared {
            state: Mutex::new(State { queue: VecDeque::new(), running: false, last_sound: Instant::now(), error: None }),
            open: Box::new(open),
            timing,
        }))
    }

    /// Mix `sound` in from the next write on, opening the output if it is
    /// closed. Returns how long until the sound has played to its end.
    pub fn play(&self, sound: &[i16]) -> Duration {
        let mut state = self.0.lock();
        for (at, &sample) in sound.iter().enumerate() {
            match state.queue.get_mut(at) {
                Some(queued) => *queued = queued.saturating_add(sample),
                None => state.queue.push_back(sample),
            }
        }
        state.last_sound = Instant::now();
        let wait = if state.running {
            self.0.timing.lead
        } else {
            state.running = true;
            let shared = self.0.clone();
            let _ = thread::Builder::new().name("pocket-zero-speaker".into()).stack_size(256 * 1024).spawn(move || run(&shared));
            self.0.timing.preroll
        };
        wait + Duration::from_secs_f64(sound.len() as f64 / RATE as f64)
    }

    /// Why the last output failed, until one opens.
    pub fn error(&self) -> Option<String> {
        self.0.lock().error.clone()
    }

    #[cfg(test)]
    pub fn running(&self) -> bool {
        self.0.lock().running
    }
}

fn run(shared: &Shared) {
    let timing = shared.timing;
    let chunk = samples(timing.chunk).max(1);
    let lead = samples(timing.lead) as f64;
    let mut attempt = 0;
    let mut last_error = None;
    'output: loop {
        let mut output = match (shared.open)(attempt) {
            Some(Ok(output)) => output,
            Some(Err(error)) => {
                last_error = Some(error);
                attempt += 1;
                continue;
            }
            None => {
                let mut state = shared.lock();
                state.error = Some(last_error.unwrap_or_else(|| "no audio output".into()));
                state.queue.clear();
                state.running = false;
                return;
            }
        };
        let preroll = samples(timing.preroll);
        if let Err(error) = output.write(&vec![0; preroll]) {
            last_error = Some(error);
            attempt += 1;
            continue;
        }
        let start = Instant::now();
        let mut written = preroll as f64;
        let mut opened = false;
        loop {
            let ahead = written - start.elapsed().as_secs_f64() * RATE as f64;
            if ahead > lead {
                thread::sleep(Duration::from_secs_f64((ahead - lead) / RATE as f64));
                continue;
            }
            let (block, sound) = {
                let mut state = shared.lock();
                if state.queue.is_empty() && state.last_sound.elapsed() >= timing.idle {
                    state.running = false;
                    return;
                }
                let sound = chunk.min(state.queue.len());
                let mut block: Vec<i16> = state.queue.drain(..sound).collect();
                block.resize(chunk, 0);
                (block, sound)
            };
            if let Err(error) = output.write(&block) {
                // The queued sound goes to the next output.
                let mut state = shared.lock();
                for &sample in block[..sound].iter().rev() {
                    state.queue.push_front(sample);
                }
                drop(state);
                last_error = Some(error);
                attempt += 1;
                continue 'output;
            }
            if !opened {
                // The output took a write after its preroll: it is playing.
                opened = true;
                shared.lock().error = None;
            }
            written += chunk as f64;
        }
    }
}

/// The beep: 880 Hz for 180 ms at 70 % of full scale, full for its first
/// 90 ms and fading over the rest.
pub fn beep() -> Vec<i16> {
    let n = samples(Duration::from_millis(180));
    let hold = n / 2;
    (0..n)
        .map(|i| {
            let envelope = if i < hold { 1.0 } else { 1.0 - (i - hold) as f32 / (n - hold) as f32 };
            let phase = 2.0 * std::f32::consts::PI * 880.0 * i as f32 / RATE as f32;
            (0.7 * envelope * phase.sin() * 32767.0) as i16
        })
        .collect()
}

/// The samples of a 16 kHz mono 16-bit WAV file (the recorder's format).
pub fn wav_samples(bytes: &[u8]) -> Result<Vec<i16>, String> {
    let field = |at: usize, len: usize| bytes.get(at..at + len).ok_or("not a WAV file");
    if field(0, 4)? != b"RIFF" || field(8, 4)? != b"WAVE" {
        return Err("not a WAV file".into());
    }
    let mut at = 12;
    let mut format = None;
    while at + 8 <= bytes.len() {
        let id = field(at, 4)?;
        let size = u32::from_le_bytes(field(at + 4, 4)?.try_into().unwrap()) as usize;
        let body = &bytes[at + 8..(at + 8 + size).min(bytes.len())];
        if id == b"fmt " && body.len() >= 16 {
            let u16_at = |i: usize| u16::from_le_bytes([body[i], body[i + 1]]);
            format = Some((u16_at(0), u16_at(2), u32::from_le_bytes(body[4..8].try_into().unwrap()), u16_at(14)));
        } else if id == b"data" {
            if format != Some((1, 1, RATE, 16)) {
                return Err("the recording is not 16 kHz mono 16-bit PCM".into());
            }
            return Ok(body.chunks_exact(2).map(|pair| i16::from_le_bytes([pair[0], pair[1]])).collect());
        }
        at += 8 + size + (size & 1);
    }
    Err("the WAV file has no data".into())
}

#[cfg(test)]
mod tests {
    use super::*;

    type Sink = Arc<Mutex<Vec<i16>>>;

    struct Recorder {
        sink: Sink,
        writes_before_failing: Option<usize>,
    }

    impl Output for Recorder {
        fn write(&mut self, samples: &[i16]) -> Result<(), String> {
            if let Some(left) = self.writes_before_failing.as_mut() {
                if *left == 0 {
                    return Err("busy".into());
                }
                *left -= 1;
            }
            self.sink.lock().unwrap().extend_from_slice(samples);
            Ok(())
        }
    }

    fn timing() -> Timing {
        Timing { preroll: Duration::from_millis(30), lead: Duration::from_millis(10), chunk: Duration::from_millis(5), idle: Duration::from_millis(60) }
    }

    fn wait_closed(speaker: &Speaker) {
        let deadline = Instant::now() + Duration::from_secs(5);
        while speaker.running() {
            assert!(Instant::now() < deadline, "the output did not close");
            thread::sleep(Duration::from_millis(5));
        }
    }

    #[test]
    fn a_sound_follows_the_preroll_and_the_output_closes_when_idle() {
        let sink: Sink = Arc::default();
        let outputs = sink.clone();
        let speaker = Speaker::new(timing(), move |attempt| (attempt == 0).then(|| Ok(Box::new(Recorder { sink: outputs.clone(), writes_before_failing: None }) as Box<dyn Output>)));
        let sound: Vec<i16> = (1..=100).collect();
        let wait = speaker.play(&sound);
        assert_eq!(wait, Duration::from_millis(30) + Duration::from_secs_f64(100.0 / RATE as f64));
        wait_closed(&speaker);
        let written = sink.lock().unwrap().clone();
        let preroll = samples(Duration::from_millis(30));
        assert!(written[..preroll].iter().all(|&s| s == 0));
        assert_eq!(&written[preroll..preroll + 100], &sound[..]);
        assert!(written[preroll + 100..].iter().all(|&s| s == 0));
        assert_eq!(speaker.error(), None);
    }

    #[test]
    fn sounds_played_together_are_mixed() {
        let sink: Sink = Arc::default();
        let outputs = sink.clone();
        let speaker = Speaker::new(timing(), move |attempt| (attempt == 0).then(|| Ok(Box::new(Recorder { sink: outputs.clone(), writes_before_failing: None }) as Box<dyn Output>)));
        speaker.play(&[1000, 2000, i16::MAX]);
        speaker.play(&[1, 2, 3, 4]);
        wait_closed(&speaker);
        let written = sink.lock().unwrap().clone();
        let preroll = samples(Duration::from_millis(30));
        assert_eq!(&written[preroll..preroll + 4], &[1001, 2002, i16::MAX, 4]);
    }

    #[test]
    fn a_failing_output_hands_the_sound_to_the_next() {
        let first: Sink = Arc::default();
        let second: Sink = Arc::default();
        let (a, b) = (first.clone(), second.clone());
        let speaker = Speaker::new(timing(), move |attempt| match attempt {
            // Takes the preroll, then fails like an aplay that could not open its PCM.
            0 => Some(Ok(Box::new(Recorder { sink: a.clone(), writes_before_failing: Some(1) }) as Box<dyn Output>)),
            1 => Some(Ok(Box::new(Recorder { sink: b.clone(), writes_before_failing: None }) as Box<dyn Output>)),
            _ => None,
        });
        speaker.play(&[7; 50]);
        wait_closed(&speaker);
        let preroll = samples(Duration::from_millis(30));
        assert!(first.lock().unwrap().iter().all(|&s| s == 0));
        assert_eq!(&second.lock().unwrap()[preroll..preroll + 50], &[7; 50]);
        assert_eq!(speaker.error(), None);
    }

    #[test]
    fn no_output_leaves_the_reason() {
        let speaker = Speaker::new(timing(), |attempt| (attempt == 0).then(|| Err("aplay is not installed".to_string())));
        speaker.play(&[1; 10]);
        wait_closed(&speaker);
        assert_eq!(speaker.error().as_deref(), Some("aplay is not installed"));
    }

    #[test]
    fn a_recording_reads_back_as_samples() {
        let mut wav = Vec::new();
        wav.extend_from_slice(b"RIFF\0\0\0\0WAVEfmt ");
        wav.extend_from_slice(&16u32.to_le_bytes());
        wav.extend_from_slice(&1u16.to_le_bytes());
        wav.extend_from_slice(&1u16.to_le_bytes());
        wav.extend_from_slice(&RATE.to_le_bytes());
        wav.extend_from_slice(&(RATE * 2).to_le_bytes());
        wav.extend_from_slice(&2u16.to_le_bytes());
        wav.extend_from_slice(&16u16.to_le_bytes());
        wav.extend_from_slice(b"data");
        wav.extend_from_slice(&4u32.to_le_bytes());
        wav.extend_from_slice(&[0x01, 0x00, 0xff, 0xff]);
        assert_eq!(wav_samples(&wav).unwrap(), vec![1, -1]);
        assert!(wav_samples(b"RIFF").is_err());
    }

    #[test]
    fn the_beep_holds_then_fades() {
        let beep = beep();
        assert_eq!(beep.len(), samples(Duration::from_millis(180)));
        let peak = |range: std::ops::Range<usize>| beep[range].iter().map(|s| s.unsigned_abs()).max().unwrap();
        assert!(peak(0..400) > 22_000);
        assert!(peak(beep.len() - 100..beep.len()) < 2_000);
    }
}
