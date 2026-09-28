// site/mv/audio-worker.js — render the song off the main thread.
// Synthesizing 79 seconds takes a couple of seconds of arithmetic; doing it
// here keeps the page from locking up between the play button and the music.
import { renderSong } from "./score.js";

self.onmessage = (event) => {
  const song = renderSong(event.data.sampleRate);
  self.postMessage(
    { left: song.left, right: song.right, sampleRate: song.sampleRate, length: song.length },
    [song.left.buffer, song.right.buffer],
  );
};
