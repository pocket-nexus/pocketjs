<script setup lang="ts">
import { Text, View } from "@pocketjs/framework/vue-vapor/components";
import { count, features, enabledCount, toggleFeature } from "./app";
import FeatureCard from "./FeatureCard.vue";
import FeatureToggle from "./FeatureToggle.vue";
import ModelButton from "./ModelButton.vue";
</script>

<template>
  <View
    debug-name="VueSfcLab"
    class="w-full h-full flex-col gap-2 p-4 bg-gradient-to-b from-slate-50 to-slate-100"
  >
    <View class="flex-row items-center justify-between">
      <View class="flex-col">
        <Text class="text-lg text-slate-950 font-bold">Vue SFC Feature Lab</Text>
        <Text class="text-xs text-slate-500">official template syntax · PocketJS Vapor</Text>
      </View>
      <Text class="text-xs text-blue-600 font-bold">{{ enabledCount }}/3 ON</Text>
    </View>

    <FeatureCard title="COMPONENT V-MODEL">
      <template #badge>
        <Text class="text-xs text-blue-600">defineModel()</Text>
      </template>

      <ModelButton v-model="count" label="VALUE +1" />

      <View class="flex-row items-center justify-between">
        <Text v-if="count === 0" class="text-xs text-slate-500">v-if: idle</Text>
        <Text v-else-if="count < 4" class="text-xs text-blue-600">v-else-if: active</Text>
        <Text v-else class="text-xs text-emerald-600">v-else: complete</Text>
        <Text class="text-xs text-slate-600">parent value: {{ count }}</Text>
      </View>

      <template v-if="count > 0">
        <Text class="text-xs text-slate-600">template v-if: fragment</Text>
        <View
          class="h-1 rounded-md bg-gradient-to-r from-blue-500 to-cyan-500"
          :style="{ width: 80 + count * 12 }"
        />
      </template>
      <template v-else>
        <Text class="text-xs text-slate-400">template v-else: press → then ○</Text>
        <View class="h-1 w-16 rounded-full bg-slate-200" />
      </template>

      <template #footer>
        <Text class="text-xs text-slate-500">props + emits + named slots</Text>
        <Text class="text-xs text-slate-400">ref + computed</Text>
      </template>
    </FeatureCard>

    <View class="flex-row gap-2">
      <template v-for="feature in features" :key="feature.id">
        <FeatureToggle
          :label="feature.label"
          :enabled="feature.enabled"
          @toggle="toggleFeature(feature.id)"
        />
      </template>
    </View>

    <View class="flex-row items-center justify-between">
      <View class="flex-row gap-2">
        <Text
          v-for="(feature, index) in features"
          :key="`summary-${feature.id}`"
          class="text-xs text-slate-500"
        >
          {{ index + 1 }}.{{ feature.label }}
        </Text>
      </View>
      <Text class="text-xs text-slate-400">→ focus · ○ activate</Text>
    </View>
  </View>
</template>
