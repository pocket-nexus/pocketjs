//! Game sound: one thread owns the PCM device while voices are playing, and
//! releases it when they end so the microphone and the firmware can use the codec.
use pocket_arcade::synth::{self, Voice};
use std::{
    sync::mpsc::{self, Sender},
    time::Duration,
};

pub fn start() -> Sender<Vec<Voice>> {
    let (sender, receiver) = mpsc::channel::<Vec<Voice>>();
    let _ = std::thread::Builder::new()
        .name("audio".into())
        .spawn(move || {
            let format = pocket_linux_alsa::Format {
                sample_rate: synth::SAMPLE_RATE,
                channels: 2,
            };
            let mut voices: Vec<Voice> = Vec::new();
            let mut buffer = vec![0i16; 1024];
            loop {
                // Idle until a game makes a sound.
                match receiver.recv() {
                    Ok(new) => voices.extend(new),
                    Err(_) => return,
                }
                let Ok(mut pcm) = pocket_linux_alsa::Pcm::open("default", format) else {
                    voices.clear();
                    continue;
                };
                let mut idle = 0;
                loop {
                    while let Ok(new) = receiver.try_recv() {
                        voices.extend(new);
                    }
                    synth::mix(&mut voices, &mut buffer);
                    if pcm.write(&buffer).is_err() {
                        voices.clear();
                        break;
                    }
                    idle = if voices.is_empty() { idle + 1 } else { 0 };
                    if idle > 40 {
                        break;
                    }
                    std::thread::sleep(Duration::from_millis(1));
                }
            }
        });
    sender
}
