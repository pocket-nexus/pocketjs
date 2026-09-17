// @title Runtime font editor
import { onCleanup } from "solid-js";
import { mount } from "@pocketjs/framework";
import { openRuntimeFont } from "@pocketjs/framework/fonts";
import { platform } from "@pocketjs/framework/platform";
import Note from "../note/app.tsx";

function RuntimeNote() {
  const font = openRuntimeFont({ family: "Inter", size: 18, fallback: [],
    provider: platform.target === "psp" ? "companion" : "local" });
  onCleanup(() => font.dispose());
  return <Note font={font} initialEditing={true} />;
}
mount(() => <RuntimeNote />);
