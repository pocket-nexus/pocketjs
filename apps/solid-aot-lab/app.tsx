import { Match, Show, Switch } from "solid-js";
import { ActionHandler, AxisHandler, For, Text, View } from "@pocketjs/framework/solid/components";
import { BTN } from "@pocketjs/framework/input";
import { ThemeContext, adjustCount, count, enabledCount, features, resetCount, setCount, theme, toggleFeature } from "./app";
import FeatureCard from "./FeatureCard.tsx";
import FeatureList from "./FeatureList.tsx";
import FeatureToggle from "./FeatureToggle.tsx";
import ModelButton from "./ModelButton.tsx";

export default function App() {
  return (
    <ThemeContext.Provider value={theme}>
      <View debugName="SolidAotLab" class="w-full h-full flex-col gap-2 p-4 bg-gradient-to-b from-slate-50 to-slate-100">
        <ActionHandler button={BTN.CROSS} active={count() !== 0} latched onPress={() => resetCount()} />
        <AxisHandler axis="primary" onDelta={(delta) => adjustCount(delta)} />
        <View class="flex-row items-center justify-between">
          <View class="flex-col">
            <Text class="text-lg text-slate-950 font-bold">Solid AOT Feature Lab</Text>
            <Text class="text-xs text-slate-500">typed TSX views · PocketJS Vapor</Text>
          </View>
          <Text class="text-xs text-blue-600 font-bold">{enabledCount()}/3 ON</Text>
        </View>

        <FeatureCard
          title="PROPS + CALLBACKS"
          badge={<Text class="text-xs text-blue-600">Accessor + Setter</Text>}
          footer={
            <>
              <Text class="text-xs text-slate-500">props + emits + named slots</Text>
              <Text class="text-xs text-slate-400">signal + memo</Text>
            </>
          }
        >
          <ModelButton value={count()} onChange={setCount} label="VALUE +1" />
          <View class="flex-row items-center justify-between">
            <Switch fallback={<Text class="text-xs text-emerald-600">Switch: complete</Text>}>
              <Match when={count() === 0}><Text class="text-xs text-slate-500">Switch: idle</Text></Match>
              <Match when={count() < 4}><Text class="text-xs text-blue-600">Switch: active</Text></Match>
            </Switch>
            <Text class="text-xs text-slate-600">parent value: {count()}</Text>
          </View>
          <Show
            when={count() > 0}
            fallback={
              <>
                <Text class="text-xs text-slate-400">Show fallback: press → then ○</Text>
                <View class="h-1 w-16 rounded-full bg-slate-200" />
              </>
            }
          >
            <Text class="text-xs text-slate-600">Show: fragment</Text>
            <View class="h-1 rounded-md bg-gradient-to-r from-blue-500 to-cyan-500" style={{ width: 80 + count() * 12 }} />
          </Show>
        </FeatureCard>

        <FeatureList
          items={features()}
          row={({ item: feature }) => (
            <FeatureToggle label={feature().label} enabled={feature().enabled} onToggle={() => toggleFeature(feature().id)} />
          )}
        />

        <View class="flex-row items-center justify-between">
          <View class="flex-row gap-2">
            <For each={features()} by={(feature) => `summary-${feature.id}`}>
              {(feature, index) => <Text class="text-xs text-slate-500">{index() + 1}.{feature().label}</Text>}
            </For>
          </View>
          <Text class="text-xs text-slate-400">→ focus · ○ activate · × reset</Text>
        </View>
      </View>
    </ThemeContext.Provider>
  );
}
