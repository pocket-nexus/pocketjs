import { Text, View, type NodeMirror } from "@pocketjs/framework/components";
import { animate, jump } from "@pocketjs/framework/animation";
import { getOps } from "@pocketjs/framework/host";
import { virtualNow } from "@pocketjs/framework/clock";
import { onFrame } from "@pocketjs/framework/lifecycle";
import { textResources } from "@pocketjs/framework/text";
import { createTextPainter } from "@pocketjs/framework/text-view";
import { onScopeDispose } from "vue";

export const hasCompanion = () => !!(globalThis as { offload?: unknown }).offload;

/** Presentation only: framework text resources own glyph identity and reuse. */
export function remoteText(text: () => string, width: number, size: 12 | 14 | 16 | 20, color: () => string = () => "#ffffff", bold = false,
  waiting: () => boolean = () => false, visible: () => boolean = () => true, priority: number | (() => number) = 1,
  measured?: (width: number) => void) {
  const height = size + 8;
  const style = { width, size, density: 2, bold, fontSlot: (size === 20 ? 4 : size === 16 ? 2 : size === 14 ? 1 : 0) + (bold ? 7 : 0) };
  if (!hasCompanion()) {
    let previous: string | undefined;
    onFrame(() => {
      const value = text();
      if (value !== previous) { previous = value; measured?.(Math.min(width, getOps().measureText(value, style.fontSlot))); }
    });
    return <View class="relative overflow-hidden flex-row items-center" style={{ width, height }}>
      <Text class={bold ? "text-xl font-bold" : size === 12 ? "text-xs" : size === 14 ? "text-sm" : "text-base"} style={{ textColor: color() }}>{text()}</Text>
    </View>;
  }
  const label = textResources().createLayout(style);
  let painter: ReturnType<typeof createTextPainter> | undefined, content: NodeMirror | null = null, skeleton: NodeMirror | null = null;
  let loading = false, pulseAt = Infinity, pulseHigh = false, retained = "", measuredRevision = -1;
  onFrame(() => {
    const busy = waiting(), now = virtualNow();
    if (!busy) retained = text();
    label.set(retained, !busy && visible(), typeof priority === "function" ? priority() : priority);
    const layout = label.snapshot();
    if (layout.revision !== measuredRevision && !busy) {
      measuredRevision = layout.revision; measured?.(Math.min(width, layout.width));
    }
    if (busy !== loading) {
      loading = busy;
      if (content) jump(content, "opacity", busy ? 0 : 1);
      if (skeleton) {
        if (busy) animate(skeleton, "opacity", 0.42, { delay: 80, dur: 180, easing: "out" });
        else jump(skeleton, "opacity", 0);
      }
      pulseAt = busy ? now + 0.26 : Infinity; pulseHigh = false;
    }
    if (busy && now >= pulseAt) {
      pulseHigh = !pulseHigh; pulseAt = now + 0.9;
      if (skeleton) animate(skeleton, "opacity", pulseHigh ? 0.58 : 0.42, { dur: 900, easing: "in-out" });
    }
    // A glyph miss affects its own cell. Resident text is never hidden by it.
    if (!busy) painter?.paint(layout, color());
  });
  onScopeDispose(() => { painter?.dispose(); label.dispose(); });
  return <View class="relative overflow-hidden" style={{ width, height }}>
    <View nodeRef={n => { content = n ?? null; if (n) painter = createTextPainter(n, style); }} class="absolute inset-0" />
    <View nodeRef={n => { skeleton = n ?? null; }} class="absolute rounded-sm bg-[#6c7785]"
      style={{ insetL: 0, insetT: Math.round((height - size * 0.55) / 2), width: Math.min(width - 4, size * (bold ? 5 : 2.25)), height: Math.round(size * 0.55), opacity: 0 }} />
  </View>;
}
