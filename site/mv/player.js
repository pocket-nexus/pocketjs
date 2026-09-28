// site/mv/player.js — the page that plays the film.
//
// The picture comes from film.js and the music from score.js, and both are
// functions of one clock: the AudioContext's. The song is synthesized once, in
// a worker, into a single AudioBuffer; playback position is read back from the
// context and handed to drawFrame, so a dropped animation frame slips the
// picture rather than desynchronizing it from the music.

import { drawFrame, W, H, DURATION } from "./film.js";

const canvas = document.getElementById("film");
// film.js owns the resolution; the page follows it.
canvas.width = W;
canvas.height = H;
const ctx = canvas.getContext("2d", { alpha: false });
const startButton = document.querySelector("[data-start]");
const status = document.querySelector("[data-status]");
const controls = document.querySelector("[data-controls]");
const toggle = document.querySelector("[data-toggle]");
const seek = document.querySelector("[data-seek]");
const timeOut = document.querySelector("[data-time]");
const muteButton = document.querySelector("[data-mute]");
const iconPlay = document.querySelector("[data-icon-play]");
const iconPause = document.querySelector("[data-icon-pause]");
const iconLoud = document.querySelector("[data-icon-loud]");
const iconMuted = document.querySelector("[data-icon-muted]");

const make = (w, h) => {
  const c = document.createElement("canvas");
  c.width = w;
  c.height = h;
  return c;
};

// The poster: a chorus frame, so the page shows the film rather than a black
// box. The page sits on it before the first play and returns to it at the end.
const POSTER = 45.7;
let poster = true;
drawFrame(ctx, POSTER, make);

const clock = (s) => `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, "0")}`;

let audio = null;
let buffer = null;
let gain = null;
let source = null;
let startedAt = 0; // audio-context time the film's t=0 would have been at
let paused = 0; // where the film sits while stopped
let playing = false;
let loading = false;

function now() {
  if (!audio) return paused;
  return playing ? Math.min(audio.currentTime - startedAt, buffer.duration) : paused;
}

function paint() {
  const t = poster ? POSTER : now();
  drawFrame(ctx, t, make);
  const shown = poster ? 0 : t;
  seek.value = String(Math.round((shown / DURATION) * 1000));
  timeOut.textContent = `${clock(Math.min(shown, DURATION))} / ${clock(DURATION)}`;
  if (playing && t >= buffer.duration - 0.02) finish();
  if (playing) requestAnimationFrame(paint);
}

/** The film ran out: park on the poster and offer it again. */
function finish() {
  stop(0);
  poster = true;
  controls.hidden = true;
  startButton.hidden = false;
  startButton.disabled = false;
  paint();
}

function startSource(offset) {
  source = audio.createBufferSource();
  source.buffer = buffer;
  source.connect(gain);
  source.start(0, offset);
  startedAt = audio.currentTime - offset;
}

function play(offset = paused) {
  if (!buffer) return;
  poster = false;
  if (offset >= buffer.duration - 0.05) offset = 0;
  startSource(offset);
  playing = true;
  iconPlay.hidden = true;
  iconPause.hidden = false;
  requestAnimationFrame(paint);
}

function stop(at) {
  if (source) {
    source.onended = null;
    source.stop();
    source.disconnect();
    source = null;
  }
  paused = at;
  playing = false;
  iconPlay.hidden = false;
  iconPause.hidden = true;
  paint();
}

async function load() {
  if (loading || buffer) return;
  loading = true;
  status.hidden = false;
  audio = new (window.AudioContext || window.webkitAudioContext)();
  gain = audio.createGain();
  gain.connect(audio.destination);

  const worker = new Worker(new URL("./audio-worker.js", import.meta.url), { type: "module" });
  const song = await new Promise((resolve, reject) => {
    worker.onmessage = (event) => resolve(event.data);
    worker.onerror = reject;
    worker.postMessage({ sampleRate: audio.sampleRate });
  });
  worker.terminate();

  buffer = audio.createBuffer(2, song.length, song.sampleRate);
  buffer.copyToChannel(song.left, 0);
  buffer.copyToChannel(song.right, 1);
  status.hidden = true;
  loading = false;
}

startButton.addEventListener("click", async () => {
  startButton.disabled = true;
  try {
    await load();
  } catch (error) {
    status.hidden = false;
    status.textContent = "The song could not be synthesized in this browser.";
    console.error(error);
    return;
  }
  startButton.hidden = true;
  controls.hidden = false;
  await audio.resume();
  play(0);
});

toggle.addEventListener("click", () => {
  if (playing) stop(now());
  else play();
});

seek.addEventListener("input", () => {
  poster = false;
  const t = (Number(seek.value) / 1000) * DURATION;
  if (playing) {
    if (source) {
      source.onended = null;
      source.stop();
      source.disconnect();
    }
    startSource(t);
  } else {
    paused = t;
    paint();
  }
});

muteButton.addEventListener("click", () => {
  if (!gain) return;
  const muted = gain.gain.value === 0;
  gain.gain.value = muted ? 1 : 0;
  iconLoud.hidden = !muted;
  iconMuted.hidden = muted;
});

document.addEventListener("keydown", (event) => {
  if (event.target instanceof HTMLInputElement) return;
  if (event.key === " ") {
    event.preventDefault();
    if (startButton.hidden) toggle.click();
    else startButton.click();
    return;
  }
  if (!buffer) return;
  if (event.key === "ArrowRight" || event.key === "ArrowLeft") {
    event.preventDefault();
    const step = event.key === "ArrowRight" ? 5 : -5;
    const t = Math.max(0, Math.min(DURATION, now() + step));
    if (playing) {
      if (source) {
        source.onended = null;
        source.stop();
        source.disconnect();
      }
      startSource(t);
    } else {
      paused = t;
      paint();
    }
  }
});

// Fonts land after the first paint; redraw the poster once they do so the
// title is set in the face the film was designed around.
if (document.fonts?.ready) document.fonts.ready.then(() => { if (!playing) paint(); });

// Give the canvas back its pixels if the page is restored from the back cache.
window.addEventListener("pageshow", () => { if (!playing) paint(); });
