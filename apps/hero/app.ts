import type { i32 } from "@pocketjs/framework/solid/std";

export interface HeroProps {
  actionLabel?: string;
  compact?: boolean;
  deviceLabel?: string;
  headline?: string;
  largeLayout?: boolean;
  onAction?: (count: i32) => void;
  presentationHz?: i32;
  runtimeLabel?: string;
  spinnerFrameStep?: i32;
}
