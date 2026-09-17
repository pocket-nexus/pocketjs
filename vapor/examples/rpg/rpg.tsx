// POCKET VAPOR RPG — one complete reactive gameplay loop for the GBA host.
//
// All mutable game state is ordinary Vue ref/computed state. Under Pocket
// Vapor it becomes fixed native C slots and functions; the host module owns
// only static map data, collision/event lookup, and rendering. There is no JS
// engine, hidden RPG state machine, device SDK input, or fake crank button.
//
// Test route: spawn (2,2); Right, Down, Right turns into the solid Elder at
// (4,3), then A talks. Choose YES and press A again to close. Up, then Right
// x5 reaches the Slime at (8,2). Select ATTACK and press A three times. Close
// the victory dialog, then return and face the Elder with Left x5, Down,
// Right, A to complete the quest.

import { computed, ref } from "vue";
import { onFrame } from "@pocketjs/framework/vue-vapor/lifecycle";
import { BTN } from "@pocketjs/framework/vue-vapor/input";
import { Button, onButton } from "../../host/input.ts";
import {
  defineRpgMap,
  RpgScreen,
  rpgBlocked,
  rpgEventAt,
} from "../../host/rpg.ts";

type Keymap = Record<number, () => void>;

const Mode = {
  World: 0,
  Dialog: 1,
  Battle: 2,
};

const Facing = {
  Down: 0,
  Up: 1,
  Left: 2,
  Right: 3,
};

const Quest = {
  NotStarted: 0,
  Accepted: 1,
  Won: 2,
  Complete: 3,
};

const Dialog = {
  None: 0,
  Offer: 1,
  Accepted: 2,
  Declined: 3,
  Victory: 4,
  Complete: 5,
};

const Event = {
  None: 0,
  Elder: 1,
  Slime: 2,
};

const RPG_MAP = defineRpgMap({
  rows: [
    "##############################",
    "#....T......~~~~......T......#",
    "#.......S....==..............#",
    "#...N........==....T.........#",
    "#............==..............#",
    "#....######..==..~~~~........#",
    "#............==..~~~~........#",
    "#..**........==........T.....#",
    "#............======..........#",
    "#......T.....................#",
    "#............~~~~............#",
    "#............~~~~....**......#",
    "#..T.........................#",
    "#........=====...............#",
    "#........=...=.......T.......#",
    "#..~~~~..=====...............#",
    "#..~~~~..................**..#",
    "#..............T.............#",
    "#............................#",
    "##############################",
  ],
  solid: "#NT~",
  events: {
    N: Event.Elder,
    S: Event.Slime,
  },
  // Dialog ids are one-based: Dialog.Offer selects dialogs[0].
  dialogs: [
    {
      speaker: "ELDER",
      line1: "SLIME BLOCKS EAST ROAD.",
      line2: "WILL YOU HELP?",
      choice0: "YES",
      choice1: "NO",
    },
    {
      speaker: "ELDER",
      line1: "THANK YOU, BRAVE HERO.",
      line2: "FOLLOW THE ROAD EAST.",
    },
    {
      speaker: "ELDER",
      line1: "COME BACK WHEN READY.",
    },
    {
      speaker: "HERO",
      line1: "THE SLIME IS DEFEATED!",
      line2: "REPORT TO THE ELDER.",
    },
    {
      speaker: "ELDER",
      line1: "THE VILLAGE IS SAFE.",
      line2: "QUEST COMPLETE!",
    },
  ],
});

export default () => {
  // Eleven refs: comfortably inside Pocket Vapor's current 16-ref budget.
  const mode = ref<number>(0);
  const playerX = ref<number>(2);
  const playerY = ref<number>(2);
  const facing = ref<number>(0);
  const quest = ref<number>(0);
  const dialog = ref<number>(0);
  const choice = ref<number>(0);
  const heroHp = ref<number>(30);
  const enemyHp = ref<number>(18);
  const battleCursor = ref<number>(0);
  // -1 is idle; a live cardinal step advances 0, 2, ... 14 pixels before
  // committing its destination cell on the following fixed semantic frame.
  const walkPx = ref<number>(-1);

  const questActive = computed(() => quest.value === Quest.Accepted);

  function openDialog(id: number) {
    dialog.value = id;
    choice.value = 0;
    mode.value = Mode.Dialog;
  }

  function closeDialog() {
    dialog.value = Dialog.None;
    choice.value = 0;
    mode.value = Mode.World;
  }

  function startBattle() {
    heroHp.value = 30;
    enemyHp.value = 18;
    battleCursor.value = 0;
    mode.value = Mode.Battle;
  }

  function handleEvent(event: number) {
    if (event === Event.Elder) {
      if (quest.value === Quest.NotStarted) {
        openDialog(Dialog.Offer);
      } else if (quest.value === Quest.Accepted) {
        openDialog(Dialog.Accepted);
      } else if (quest.value === Quest.Won) {
        quest.value = Quest.Complete;
        openDialog(Dialog.Complete);
      } else {
        openDialog(Dialog.Complete);
      }
    } else if (event === Event.Slime) {
      if (questActive.value) startBattle();
    }
  }

  function beginMove(dx: number, dy: number, nextFacing: number) {
    if (walkPx.value >= 0) return;
    facing.value = nextFacing;
    const nextX = playerX.value + dx;
    const nextY = playerY.value + dy;
    if (!rpgBlocked(RPG_MAP, nextX, nextY)) {
      walkPx.value = 0;
    }
  }

  function advanceMove() {
    if (walkPx.value < 0) return;
    if (walkPx.value < 14) {
      walkPx.value += 2;
      return;
    }

    if (facing.value === Facing.Up) playerY.value -= 1;
    else if (facing.value === Facing.Down) playerY.value += 1;
    else if (facing.value === Facing.Left) playerX.value -= 1;
    else playerX.value += 1;
    walkPx.value = -1;

    const event = rpgEventAt(RPG_MAP, playerX.value, playerY.value);
    if (event !== Event.None) handleEvent(event);
  }

  function tickWorld(buttons: number) {
    advanceMove();
    if (mode.value !== Mode.World || walkPx.value >= 0) return;

    if (buttons & BTN.UP) beginMove(0, -1, Facing.Up);
    else if (buttons & BTN.DOWN) beginMove(0, 1, Facing.Down);
    else if (buttons & BTN.LEFT) beginMove(-1, 0, Facing.Left);
    else if (buttons & BTN.RIGHT) beginMove(1, 0, Facing.Right);
  }

  function moveChoice(delta: number) {
    if (dialog.value === Dialog.Offer) {
      choice.value = (choice.value + delta + 2) % 2;
    }
  }

  function interact() {
    if (walkPx.value >= 0) return;
    if (facing.value === Facing.Up) {
      handleEvent(rpgEventAt(RPG_MAP, playerX.value, playerY.value - 1));
    } else if (facing.value === Facing.Down) {
      handleEvent(rpgEventAt(RPG_MAP, playerX.value, playerY.value + 1));
    } else if (facing.value === Facing.Left) {
      handleEvent(rpgEventAt(RPG_MAP, playerX.value - 1, playerY.value));
    } else {
      handleEvent(rpgEventAt(RPG_MAP, playerX.value + 1, playerY.value));
    }
  }

  function advanceDialog() {
    if (dialog.value === Dialog.Offer) {
      if (choice.value === 0) {
        quest.value = Quest.Accepted;
        dialog.value = Dialog.Accepted;
      } else {
        dialog.value = Dialog.Declined;
      }
      choice.value = 0;
    } else {
      closeDialog();
    }
  }

  function enemyTurn() {
    heroHp.value = Math.max(0, heroHp.value - 4);
    if (heroHp.value === 0) {
      heroHp.value = 30;
      enemyHp.value = 18;
      mode.value = Mode.World;
    }
  }

  function attack() {
    enemyHp.value = Math.max(0, enemyHp.value - 6);
    if (enemyHp.value === 0) {
      quest.value = Quest.Won;
      openDialog(Dialog.Victory);
    } else {
      enemyTurn();
    }
  }

  function heal() {
    heroHp.value = Math.min(30, heroHp.value + 8);
    enemyTurn();
  }

  const worldKeys: Keymap = {
    [Button.A]: interact,
  };

  const dialogKeys: Keymap = {
    [Button.Up]: () => moveChoice(-1),
    [Button.Down]: () => moveChoice(1),
    [Button.A]: advanceDialog,
  };

  const battleKeys: Keymap = {
    [Button.Up]: () => {
      battleCursor.value = 0;
    },
    [Button.Down]: () => {
      battleCursor.value = 1;
    },
    [Button.A]: () => {
      if (battleCursor.value === 0) attack();
      else heal();
    },
  };

  onButton(
    (button) =>
      (mode.value === Mode.Dialog
        ? dialogKeys
        : mode.value === Mode.Battle
          ? battleKeys
          : worldKeys)[button]?.(),
  );

  // Movement advances on fixed semantic frames using the framework's shared
  // held-button mask. Menus still consume only physical press edges above.
  onFrame((buttons) => tickWorld(buttons));

  return (
    <>
      <RpgScreen
        map={RPG_MAP}
        mode={mode.value}
        playerX={playerX.value}
        playerY={playerY.value}
        playerOffsetX={
          walkPx.value < 0
            ? 0
            : facing.value === Facing.Left
              ? -walkPx.value
              : facing.value === Facing.Right
                ? walkPx.value
                : 0
        }
        playerOffsetY={
          walkPx.value < 0
            ? 0
            : facing.value === Facing.Up
              ? -walkPx.value
              : facing.value === Facing.Down
                ? walkPx.value
                : 0
        }
        facing={facing.value}
        playerFrame={walkPx.value < 0 ? 0 : 1 + Math.trunc(walkPx.value / 4)}
        quest={quest.value}
        dialog={dialog.value}
        choice={choice.value}
        heroHp={heroHp.value}
        enemyHp={enemyHp.value}
        battleCursor={battleCursor.value}
      />
    </>
  );
};
