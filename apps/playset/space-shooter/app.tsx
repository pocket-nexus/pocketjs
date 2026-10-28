// Space Shooter on the playset shell: the game (game.ts) behind the shared
// title, readouts and pause screens (apps/playset/kit/shell.tsx).

import { GameShell, type GameStatus, type Pad, type PlaysetGame } from "../kit/shell.tsx";
import { SpaceShooter } from "./game.ts";

export default function App() {
  const game = new SpaceShooter();
  let paused = false;
  let overAt = -1;
  const shell: PlaysetGame = {
    title: "Space Shooter",
    tagline: "Hold the line against raiders and asteroids.\nGrab rapid fire, shields and repairs.",
    accent: "#2f8fd8",
    controls: [
      ["Circle Pad / D-Pad", "Fly"],
      ["Fire", "Automatic"],
      ["START", "Pause"],
      ["Y", "Developer stats"],
      ["SELECT", "Home"],
    ],
    readouts: [
      { label: "Hull", value: () => game.hud.health, bar: () => game.hud.health / 100, color: "#ff6f8f" },
      { label: "Score", value: () => game.hud.score },
      { label: "Wave", value: () => game.hud.wave },
      { label: "Shield", value: () => (game.hud.shield > 0 ? game.hud.shield.toFixed(1) + " s" : "-"), bar: () => game.hud.shield / 8, color: "#58a6ff" },
      { label: "Rapid fire", value: () => (game.hud.rapid > 0 ? game.hud.rapid.toFixed(1) + " s" : "-"), bar: () => game.hud.rapid / 7, color: "#8bff7a" },
    ],
    play: game.play,
    status(): GameStatus {
      if (game.hud.status === "title") return "title";
      if (game.hud.status === "gameover") return game.hud.demo ? "title" : "gameover";
      return paused ? "paused" : "playing";
    },
    start(demo: boolean) {
      paused = false;
      game.reset(demo);
      if (!demo) game.hud.status = "playing";
    },
    pause(p: boolean) {
      paused = p;
    },
    frame(pad: Pad) {
      // the attract loop restarts itself two seconds after a demo ends
      if (game.hud.demo && game.hud.status === "gameover") {
        if (overAt < 0) overAt = game.play.tick;
        else if (game.play.tick - overAt > 120) {
          overAt = -1;
          game.reset(true);
        }
      }
      if (paused) return;
      game.frame(pad.x, pad.y);
    },
    topLine: () => `SCORE ${game.hud.score}    WAVE ${game.hud.wave}    HULL ${game.hud.health}`,
    result: () => `Score ${game.hud.score} · reached wave ${game.hud.wave}`,
  };
  return <GameShell game={shell} />;
}
