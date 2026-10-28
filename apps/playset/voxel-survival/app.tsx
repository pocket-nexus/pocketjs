// Voxel Survival on the playset shell (apps/playset/kit/shell.tsx).

import { GameShell } from "../kit/shell.tsx";
import { createGame } from "./game.ts";

export default function App() {
  return <GameShell game={createGame()} />;
}
