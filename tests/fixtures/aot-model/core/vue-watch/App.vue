<script setup lang="ts">
import { Text, View, ActionHandler } from "@pocketjs/framework/vue-vapor/components";
import { BTN } from "@pocketjs/framework/input";
import { result, press } from "./App";
</script>
<template><View><ActionHandler :button="BTN.CROSS" @press="press" /><Text>{{ result }}</Text></View></template>
