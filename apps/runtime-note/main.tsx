// @title Runtime font editor
import { onCleanup } from "solid-js";
import { mount } from "@pocketjs/framework";
import { openRuntimeFont } from "@pocketjs/framework/fonts";
import Note from "../note/app.tsx";

function RuntimeNote() {
  const font = openRuntimeFont({ family: "Pocket Ligature Test", size: 18, fallback: ["Pocket CJK Test"],
    provider: "local", bitmapBytes: 128 * 1024, gpuBytes: 512 * 1024 });
  onCleanup(() => font.dispose());
  return <Note font={font} initialEditing={true} initialDocument={
    "PSP local TTF\nAV office e\u0301\n你好世界 - 字体测试\nNo companion: worker shaping + FreeType."
  } />;
}
mount(() => <RuntimeNote />);
