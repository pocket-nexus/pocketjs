// @title PocketUI Gallery
// apps/pocketui/main.tsx — every part of @pocketjs/framework/ui on one page,
// written once: no colour, edge or font is named here. The View menu's Theme
// command (and the segmented control at the top) paints it in each theme
// PocketUI ships, under whatever is typed, toggled, scrolled or focused at
// the time.
import { createSignal, For } from "solid-js";
import {
  Badge, Bar, Bubble, Button, Callout, Card, CLASSIC_THEME, confirm, Divider, Fact, HStack, Label, Panes, PIXEL_FACES, PocketUI, presentMenu, Progress, Row, Scaffold, Scroll, Section, Segmented, StatusDot, Text,
  TextEditor, THEMES, Toast, Toggle, useCommands, useUI, VStack, Well, withFaces, ZStack, mountPocketUI, type Command, type Theme, type Tone, type UIElement,
} from "@pocketjs/framework/ui";

/** PocketUI's themes, Classic in the pixel face this gallery's pack carries (pak.json). */
const themes: readonly Theme[] = THEMES.map((theme) => (theme.id === CLASSIC_THEME.id ? withFaces(theme, PIXEL_FACES) : theme));
const TONES: readonly Tone[] = ["muted", "accent", "good", "warn", "bad", "note"];
const PLACES = ["Inbox", "Drafts", "Sent", "Archive"];

function Gallery(): UIElement {
  const ui = useUI();
  const [theme, setTheme] = createSignal(ui.theme.id);
  const [place, setPlace] = createSignal("Inbox");
  const [wifi, setWifi] = createSignal(true);
  const [sound, setSound] = createSignal(false);
  const [size, setSize] = createSignal<"s" | "m" | "l">("m");
  const [done, setDone] = createSignal(0.4);
  const [said, setSaid] = createSignal<string | null>(null);
  const pick = (id: string) => {
    setTheme(id);
    ui.setTheme(themes.find((entry) => entry.id === id) ?? themes[0]!);
  };
  // for a simulator's steps
  (globalThis as { __pocketUISetTheme?: (id: string) => void }).__pocketUISetTheme = pick;
  const say = (text: string) => {
    setSaid(text);
    let frames = 120;
    const wait = () => {
      if (--frames > 0) return;
      ui.root.frameHooks.delete(wait);
      setSaid((now) => (now === text ? null : now));
    };
    ui.root.frameHooks.add(wait);
  };
  const commands = (): Command[] => [
    { id: "file.new", title: "New Message", short: "New", button: "action", bar: true, run: () => say("A new message would start here.") },
    { id: "commands.menu", title: "Commands", short: "Menu", button: "option", run: () => ui.commands.openMenu?.() },
    { id: "view.theme", title: "Theme", menu: "View", run: () => presentMenu(ui, { title: "Theme", items: () => themes.map((entry) => ({ id: entry.id, title: entry.label, checked: entry.id === theme(), run: () => pick(entry.id) })) }) },
    { id: "view.progress", title: "Advance the Progress", menu: "View", run: () => setDone((value) => (value >= 1 ? 0 : Math.min(1, value + 0.2))) },
    { id: "edit.delete", title: "Delete the Message", short: "Delete", menu: "Edit", bar: true, destructive: true, run: () => confirm(ui, { title: "Delete this message?", message: "It goes to the Archive and can be moved back from there.", action: "Delete", destructive: true, run: () => say("Deleted.") }) },
  ];
  useCommands(commands, { id: "gallery" });
  return (
    <ZStack>
      <Scaffold title="PocketUI Gallery" status={`${place()} - ${themes.find((entry) => entry.id === theme())?.label}`} closable>
        <Panes
          depth={1}
          onClose={() => {}}
          listWidth={170}
          list={
            <VStack>
              <Bar title="Places" back={false} />
              <Scroll grow={1}>
                <Section title="Mail" trailing="4" />
                <For each={PLACES}>
                  {(name, index) => <Row title={name} detail={index() === 0 ? "3 unread" : undefined} leading={<StatusDot tone={index() === 0 ? "accent" : "muted"} />} selected={place() === name} onPress={() => setPlace(name)} name={`place.${name}`} />}
                </For>
                <Section title="Settings" />
                <Toggle label="Wi-Fi" on={wifi()} onChange={setWifi} name="toggle.wifi" />
                <Toggle label="Sound" on={sound()} onChange={setSound} name="toggle.sound" />
              </Scroll>
            </VStack>
          }
          detail={
            <VStack>
              <Bar title={place()} subtitle="Every part of the kit" commands={commands()} back={false} />
              <Scroll grow={1} padding={[10, 12]} spacing={10} name="page">
                <Label>Theme</Label>
                <Segmented options={themes.map((entry) => ({ id: entry.id, label: entry.label }))} value={theme()} onChange={pick} name="theme" />
                <Label>Buttons</Label>
                <HStack spacing={8}>
                  <Button label="Default" kind="filled" onPress={() => say("The default button.")} name="button.default" />
                  <Button label="Another" onPress={() => say("Another button.")} name="button.other" />
                  <Button label="Delete" tone="bad" onPress={() => run("edit.delete")} name="button.delete" />
                  <Button label="Disabled" disabled onPress={() => {}} />
                  <Button label="Plain" kind="plain" onPress={() => say("A plain button.")} />
                </HStack>
                <Label>A field, a choice, progress</Label>
                <TextEditor ui={ui} part="field" placeholder="Type here: it stays through a change of theme" maxLines={3} name="field" />
                <HStack spacing={10}>
                  <Segmented options={[{ id: "s", label: "Small" }, { id: "m", label: "Medium" }, { id: "l", label: "Large" }]} value={size()} onChange={setSize} name="size" />
                  <Progress value={done()} grow={1} alignSelf="center" />
                </HStack>
                <Label>Content</Label>
                <HStack justify="end">
                  <Bubble side="self" maxWidth={260}><Text>Can the same tree be drawn by four traditions?</Text></Bubble>
                </HStack>
                <HStack>
                  <Bubble maxWidth={260}><Text>It names parts. The theme paints them.</Text></Bubble>
                </HStack>
                <Card spacing={4}>
                  <HStack spacing={6}>
                    <For each={TONES}>{(tone) => <Badge label={tone} tone={tone} />}</For>
                  </HStack>
                  <Text tone="muted">A card groups content. Badges carry a meaning, not a colour.</Text>
                  <Well><Text role="mono">$ bun test tests/pocketui{"\n"}288 pass</Text></Well>
                </Card>
                <Callout tone="good"><Text role="caption" tone="good">A remark beside the content: what happened, and how it went.</Text></Callout>
                <Divider label="Facts" />
                <Fact label="Parts" value="45" />
                <Fact label="Themes" value={themes.map((entry) => entry.label).join(", ")} />
              </Scroll>
            </VStack>
          }
        />
      </Scaffold>
      {said() ? <Toast text={said()!} /> : null}
    </ZStack>
  ) as UIElement;

  function run(id: string): void {
    ui.commands.run(id);
  }
}

mountPocketUI({ children: () => <Gallery /> });
