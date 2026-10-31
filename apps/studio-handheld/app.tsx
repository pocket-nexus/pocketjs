// The Pocket Studio room's interface on a console with no pointer. The program
// (programs/trimui-smart-pro) owns the 3D room and every long job; this file
// owns the flow: what the d-pad focuses, which camera pose shows it, what each
// card says. It sends commands up the overlay channel and gets state back.
import { batch, createMemo, createSignal, For, onCleanup, Show } from "solid-js";
import { Text, View } from "@pocketjs/framework/components";
import { BTN } from "@pocketjs/framework/input";
import { onButtonPress, onFrame } from "@pocketjs/framework/lifecycle";
import { connectOverlay } from "@pocketjs/framework/overlay-host";
import { type Command, EMPTY_STATE, PRESETS, type State, wrap, gridStep, RACK_COLUMNS, RACK_SLOTS } from "./model.ts";

type View_ = "room" | "make" | "rack" | "tv";
const TARGETS = ["desk", "rack", "tv"] as const;
const TARGET_LABEL: Record<(typeof TARGETS)[number], { title: string; hint: string }> = {
  desk: { title: "做游戏", hint: "在电脑前说出你的想法" },
  rack: { title: "游戏架", hint: "玩、改、删你做的游戏" },
  tv: { title: "Pocket TV", hint: "玩最新做好的游戏" },
};

function Hint(props: { glyph: string; label: string }) {
  return <View class="flex-row items-center gap-[4]">
    <View class="w-[14] h-[14] rounded-full bg-[#fcf6ff] items-center justify-center">
      <Text class="text-2xs font-bold leading-[12] text-[#171226]">{props.glyph}</Text>
    </View>
    <Text class="text-2xs leading-[12] text-[#fcf6ff]">{props.label}</Text>
  </View>;
}

function HintBar(props: { children: any }) {
  return <View class="absolute left-0 bottom-0 w-[640] h-[24] flex-row items-center justify-center gap-[14] bg-[#171226c0]">
    {props.children}
  </View>;
}

function Card(props: { accent?: string; children: any }) {
  return <View class="absolute right-[10] top-[12] w-[224] h-[318] flex-col rounded-[10px] bg-[#231b3bf0] px-[10] py-[9] gap-[6]">
    <View class="absolute left-0 top-[12] w-[3] h-[22] rounded-[2px]" style={{ bgColor: props.accent ?? "#ffd23f" }} />
    {props.children}
  </View>;
}

function Lines(props: { text: string; width: number; slot?: "xs" | "sm"; color?: string; max?: number }) {
  const lines = createMemo(() => {
    const all = wrap(props.text, props.width, props.slot === "sm" ? 14 : 12);
    return props.max && all.length > props.max ? [...all.slice(0, props.max - 1), all[props.max - 1] + "…"] : all;
  });
  const cls = () => (props.slot === "sm" ? "text-sm leading-[18]" : "text-xs leading-[15]") + " " + (props.color ?? "text-[#cbbde2]");
  return <View class="flex-col"><For each={lines()}>{(line) => <Text class={cls()}>{line}</Text>}</For></View>;
}

export default function Studio() {
  const [state, setState] = createSignal<State>(EMPTY_STATE);
  const channel = connectOverlay<State, Command>((value) => setState(value));
  onCleanup(() => channel.dispose());
  const send = (command: Command) => channel.send(command);

  const [view, setView] = createSignal<View_>("room");
  const [target, setTarget] = createSignal(0);
  const [preset, setPreset] = createSignal(-1);
  const [reviewing, setReviewing] = createSignal("");
  const [editing, setEditing] = createSignal<string | null>(null);
  const [rackIndex, setRackIndex] = createSignal(0);
  const [confirmDelete, setConfirmDelete] = createSignal(false);
  const [confirmQuit, setConfirmQuit] = createSignal(false);
  const [confirmCancel, setConfirmCancel] = createSignal(false);
  let seenTranscript = 0;

  const games = () => state().games;
  const selectedGame = () => games()[rackIndex()];
  const agent = () => state().agent;
  const mic = () => state().mic;
  const inRoom = () => state().stage === "room";
  const focusName = () => TARGETS[target()]!;

  send({ t: "focus", name: focusName() });

  const enter = (next: View_) => {
    batch(() => {
      setView(next);
      setConfirmDelete(false);
      setConfirmCancel(false);
      setConfirmQuit(false);
    });
    switch (next) {
      case "room":
        send({ t: "pose", name: "overview", shift: 0 });
        send({ t: "focus", name: focusName() });
        send({ t: "case", index: null, page: 0 });
        setEditing(null);
        setReviewing("");
        break;
      case "make":
        if (!agent().running) send({ t: "clear" });
        send({ t: "asr" });
        send({ t: "pose", name: "build", shift: -0.35 });
        send({ t: "focus", name: "" });
        break;
      case "rack":
        send({ t: "asr" });
        send({ t: "pose", name: "apps", shift: -0.2 });
        send({ t: "focus", name: "" });
        syncCase();
        break;
      case "tv":
        send({ t: "pose", name: "tv", shift: 0 });
        send({ t: "focus", name: "" });
        break;
    }
  };

  const syncCase = () => {
    const index = rackIndex();
    send({ t: "case", index: index % RACK_SLOTS, page: Math.floor(index / RACK_SLOTS) });
  };

  const startAgent = (prompt: string) => {
    setReviewing("");
    send({ t: "make", prompt, game: editing() });
    setPreset(-1);
  };

  // Back from a game, the camera returns to whatever view the player left.
  let lastStage: State["stage"] = "room";
  onFrame(() => {
    const stage = state().stage;
    if (stage === "room" && lastStage !== "room") enter(view());
    lastStage = stage;
  });

  // A transcript arriving while the talk button is up becomes the review card.
  onFrame(() => {
    const current = state();
    if (current.transcriptSeq !== seenTranscript) {
      seenTranscript = current.transcriptSeq;
      if (seenTranscript > 0 && current.transcript) setReviewing(current.transcript);
    }
  });

  // Hold to talk: X anywhere in the desk's card, or on a game on the rack.
  let holding = false;
  onFrame((buttons) => {
    const down = (buttons & BTN.TRIANGLE) !== 0;
    const canTalk = inRoom() && !agent().running && (view() === "make" || view() === "rack");
    if (down && !holding && canTalk) {
      holding = true;
      setPreset(-1);
      if (view() === "rack") {
        setEditing(selectedGame()?.id ?? null);
        enter("make");
      } else if (agent().doneId && !agent().failed) {
        setEditing(agent().doneId);
      }
      send({ t: "mic", on: true });
    } else if (!down && holding) {
      holding = false;
      send({ t: "mic", on: false });
    }
  });

  onButtonPress(BTN.UP | BTN.DOWN | BTN.LEFT | BTN.RIGHT | BTN.CIRCLE | BTN.CROSS | BTN.SQUARE | BTN.SELECT | BTN.START, (pressed) => {
    if (!inRoom()) return;
    switch (view()) {
      case "room": {
        if (confirmQuit()) {
          if (pressed & BTN.CIRCLE) send({ t: "quit" });
          else if (pressed & (BTN.CROSS | BTN.SELECT)) setConfirmQuit(false);
          return;
        }
        if (pressed & (BTN.LEFT | BTN.UP)) {
          setTarget((target() + TARGETS.length - 1) % TARGETS.length);
          send({ t: "focus", name: focusName() });
        } else if (pressed & (BTN.RIGHT | BTN.DOWN)) {
          setTarget((target() + 1) % TARGETS.length);
          send({ t: "focus", name: focusName() });
        } else if (pressed & BTN.CIRCLE) {
          enter(focusName() === "desk" ? "make" : focusName() === "rack" ? "rack" : "tv");
        } else if (pressed & BTN.SELECT) {
          setConfirmQuit(true);
        }
        return;
      }
      case "make": {
        const running = agent().running;
        if (running) {
          if (confirmCancel()) {
            if (pressed & BTN.CIRCLE) {
              send({ t: "cancel" });
              setConfirmCancel(false);
            } else if (pressed & BTN.CROSS) setConfirmCancel(false);
          } else if (pressed & BTN.CROSS) {
            setConfirmCancel(true);
          }
          return;
        }
        if (reviewing()) {
          if (pressed & BTN.CIRCLE) startAgent(reviewing());
          else if (pressed & BTN.CROSS) setReviewing("");
          return;
        }
        if (pressed & BTN.CROSS) {
          enter("room");
        } else if (pressed & BTN.UP) {
          setPreset(preset() <= 0 ? PRESETS.length - 1 : preset() - 1);
        } else if (pressed & BTN.DOWN) {
          setPreset(preset() >= PRESETS.length - 1 ? 0 : preset() + 1);
        } else if (pressed & BTN.CIRCLE) {
          if (preset() >= 0) startAgent(PRESETS[preset()]!);
          else if (agent().doneId) send({ t: "play", id: agent().doneId });
        }
        return;
      }
      case "rack": {
        const count = games().length;
        if (pressed & BTN.CROSS) {
          if (confirmDelete()) setConfirmDelete(false);
          else enter("room");
          return;
        }
        if (!count) return;
        const direction = pressed & BTN.LEFT ? "left" : pressed & BTN.RIGHT ? "right" : pressed & BTN.UP ? "up" : pressed & BTN.DOWN ? "down" : null;
        if (direction) {
          setRackIndex(gridStep(rackIndex(), direction, count, RACK_COLUMNS));
          setConfirmDelete(false);
          syncCase();
        } else if (pressed & BTN.CIRCLE) {
          const game = selectedGame();
          if (confirmDelete() && game) {
            send({ t: "delete", id: game.id });
            setConfirmDelete(false);
            setRackIndex(Math.max(0, rackIndex() - 1));
          } else if (game) {
            send({ t: "play", id: game.id });
          }
        } else if (pressed & BTN.SQUARE) {
          setConfirmDelete(true);
        }
        return;
      }
      case "tv": {
        if (pressed & BTN.CROSS) enter("room");
        else if (pressed & BTN.CIRCLE && games()[0]) send({ t: "play", id: games()[0]!.id });
        return;
      }
    }
  });

  const label = createMemo(() => TARGET_LABEL[focusName()]);
  const labelAt = createMemo(() => {
    const at = state().anchors[focusName() === "desk" ? "laptop" : focusName()];
    if (!at) return [320, 150] as const;
    return [Math.min(Math.max(at[0], 90), 550), Math.min(Math.max(at[1] - 54, 16), 280)] as const;
  });

  return <Show when={inRoom()}>
    <View class="w-[640] h-[360]" debugName="Studio">
      <Show when={view() === "room"}>
        <View class="absolute left-[14] top-[10] flex-row items-center gap-[6]">
          <Text class="text-sm font-bold leading-[18] text-[#ffd23f]">POCKET</Text>
          <Text class="text-sm font-bold leading-[18] text-[#ff5f9e]">STUDIO</Text>
        </View>
        <View class="absolute w-[160] h-[44] flex-col items-center justify-center rounded-[8px] bg-[#231b3bf0]" style={{ insetL: labelAt()[0] - 80, insetT: labelAt()[1] }}>
          <Text class="text-sm font-bold leading-[18] text-[#fcf6ff]">{label().title}</Text>
          <Text class="text-2xs leading-[13] text-[#cbbde2]">{label().hint}</Text>
        </View>
        <HintBar>
          <Hint glyph="←" label="" />
          <Hint glyph="→" label="选择" />
          <Hint glyph="A" label="进入" />
          <Hint glyph="S" label="退出" />
        </HintBar>
        <Show when={confirmQuit()}>
          <View class="absolute left-[190] top-[140] w-[260] h-[70] flex-col items-center justify-center gap-[6] rounded-[10px] bg-[#231b3bfa]">
            <Text class="text-sm font-bold leading-[18] text-[#fcf6ff]">回到主菜单？</Text>
            <View class="flex-row gap-[14]"><Hint glyph="A" label="退出" /><Hint glyph="B" label="取消" /></View>
          </View>
        </Show>
      </Show>

      <Show when={view() === "make"}>
        <Card accent={mic().on ? "#ff5f9e" : "#ffd23f"}>
          <Show when={mic().on}>
            <Text class="text-sm font-bold leading-[18] text-[#ff5f9e]">正在听……</Text>
            <Text class="text-xs leading-[15] text-[#cbbde2]">{`松开 X 结束  ${mic().seconds.toFixed(0)} 秒`}</Text>
            <View class="w-[200] h-[10] rounded-[5px] bg-[#171226]">
              <View class="h-[10] rounded-[5px] bg-[#ff5f9e]" style={{ width: Math.max(4, Math.round(mic().level * 200)) }} />
            </View>
          </Show>

          <Show when={!mic().on && mic().busy}>
            <Text class="text-sm font-bold leading-[18] text-[#3fd0e8]">正在识别……</Text>
            <Text class="text-xs leading-[15] text-[#cbbde2]">语音在这台掌机上识别</Text>
          </Show>

          <Show when={!mic().on && !mic().busy && reviewing()}>
            <Text class="text-sm font-bold leading-[18] text-[#ffd23f]">我听到的是</Text>
            <Lines text={reviewing()} width={200} slot="sm" color="text-[#fcf6ff]" max={9} />
            <View class="absolute left-[10] bottom-[8] flex-row gap-[10]">
              <Hint glyph="A" label="开始做" /><Hint glyph="X" label="重说" /><Hint glyph="B" label="取消" />
            </View>
          </Show>

          <Show when={!mic().on && !mic().busy && !reviewing() && agent().running}>
            <Text class="text-sm font-bold leading-[18] text-[#a98bff]">Agent 在做</Text>
            <Lines text={agent().phase} width={200} color="text-[#3fd0e8]" max={2} />
            <Lines text={agent().line} width={200} color="text-[#fcf6ff]" max={7} />
            <Text class="text-2xs leading-[13] text-[#8e80ac]">{`${agent().elapsed} 秒 · 试玩 ${agent().runs} 次 · ${agent().tokens} tokens`}</Text>
            <View class="absolute left-[10] bottom-[8] flex-row gap-[10]">
              <Show when={confirmCancel()} fallback={<Hint glyph="B" label="停止" />}>
                <Hint glyph="A" label="确认停止" /><Hint glyph="B" label="继续做" />
              </Show>
            </View>
          </Show>

          <Show when={!mic().on && !mic().busy && !reviewing() && !agent().running}>
            <Show when={agent().failed}>
              <Text class="text-sm font-bold leading-[18] text-[#ff5f9e]">没做成</Text>
              <Lines text={agent().failed} width={200} max={5} />
            </Show>
            <Show when={agent().doneId && !agent().failed}>
              <Text class="text-sm font-bold leading-[18] text-[#ffd23f]">做好了</Text>
              <Lines text={agent().line} width={200} slot="sm" color="text-[#fcf6ff]" max={3} />
              <Text class="text-xs leading-[15] text-[#cbbde2]">想改的话，按住 X 说</Text>
              <Show when={mic().error}><Lines text={mic().error} width={200} color="text-[#ff5f9e]" max={3} /></Show>
              <View class="absolute left-[10] bottom-[8] flex-row gap-[10]">
                <Hint glyph="A" label="玩一下" /><Hint glyph="X" label="说改动" /><Hint glyph="B" label="返回" />
              </View>
            </Show>
            <Show when={!agent().doneId || agent().failed}>
              <Text class="text-sm font-bold leading-[18] text-[#ffd23f]">{editing() ? "想怎么改？" : "想做什么游戏？"}</Text>
              <Text class="text-xs leading-[15] text-[#cbbde2]">按住 X 说话，松开结束</Text>
              <Show when={mic().error}><Lines text={mic().error} width={200} color="text-[#ff5f9e]" max={3} /></Show>
              <Show when={!editing()}>
                <Text class="text-2xs leading-[13] text-[#8e80ac]">或者选一个开头</Text>
                <View class="flex-col gap-[3]">
                  <For each={PRESETS}>{(text, index) =>
                    <View class={preset() === index() ? "h-[24] rounded-[5px] bg-[#ffd23f] px-[6] justify-center" : "h-[24] rounded-[5px] bg-[#171226] px-[6] justify-center"}>
                      <Text class={preset() === index() ? "text-xs leading-[15] text-[#171226]" : "text-xs leading-[15] text-[#cbbde2]"}>{text.length > 15 ? text.slice(0, 15) + "…" : text}</Text>
                    </View>
                  }</For>
                </View>
              </Show>
              <View class="absolute left-[10] bottom-[8] flex-row gap-[10]">
                <Show when={!editing()}><Hint glyph="↕" label="选" /><Hint glyph="A" label="确定" /></Show><Hint glyph="B" label="返回" />
              </View>
            </Show>
          </Show>
        </Card>
      </Show>

      <Show when={view() === "rack"}>
        <Card accent={selectedGame()?.color ?? "#3fd0e8"}>
          <Show when={selectedGame()} fallback={<>
            <Text class="text-sm font-bold leading-[18] text-[#ffd23f]">架子还是空的</Text>
            <Text class="text-xs leading-[15] text-[#cbbde2]">去电脑前说一个游戏吧</Text>
          </>}>
            <Lines text={selectedGame()!.title} width={200} slot="sm" color="text-[#fcf6ff]" max={2} />
            <Lines text={selectedGame()!.tagline} width={200} color="text-[#ffd23f]" max={2} />
            <Lines text={selectedGame()!.summary} width={200} max={10} />
            <Show when={confirmDelete()}>
              <Text class="text-xs font-bold leading-[15] text-[#ff5f9e]">按 A 删除这个游戏</Text>
            </Show>
            <View class="absolute left-[10] bottom-[8] flex-col gap-[4]">
              <View class="flex-row gap-[10]"><Hint glyph="A" label={confirmDelete() ? "删除" : "玩"} /><Hint glyph="X" label="按住说改动" /></View>
              <View class="flex-row gap-[10]"><Hint glyph="Y" label="删除" /><Hint glyph="B" label="返回" /></View>
            </View>
          </Show>
        </Card>
      </Show>

      <Show when={view() === "tv"}>
        <View class="absolute left-[170] bottom-[34] w-[300] h-[50] flex-col items-center justify-center rounded-[8px] bg-[#231b3bf0]">
          <Show when={games()[0]} fallback={<Text class="text-sm leading-[18] text-[#cbbde2]">还没有游戏</Text>}>
            <Text class="text-sm font-bold leading-[18] text-[#fcf6ff]">{games()[0]!.title}</Text>
            <Text class="text-2xs leading-[13] text-[#cbbde2]">{games()[0]!.tagline}</Text>
          </Show>
        </View>
        <HintBar><Hint glyph="A" label="玩" /><Hint glyph="B" label="返回" /></HintBar>
      </Show>
    </View>
  </Show>;
}
