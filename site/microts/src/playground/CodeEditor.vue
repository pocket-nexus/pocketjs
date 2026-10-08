<script setup lang="ts">
// CodeMirror 6 editor: one EditorState per file, so each tab keeps its own undo history and cursor across switches.
import { onBeforeUnmount, onMounted, ref, watch } from "vue";
import { EditorState, type Extension } from "@codemirror/state";
import { EditorView, keymap } from "@codemirror/view";
import { basicSetup } from "codemirror";
import { indentWithTab } from "@codemirror/commands";
import { javascript } from "@codemirror/lang-javascript";
import { vue } from "@codemirror/lang-vue";
import { oneDark } from "@codemirror/theme-one-dark";
import { setDiagnostics, type Diagnostic } from "@codemirror/lint";

export interface EditorDiagnostic {
  file?: string;
  line?: number;
  column?: number;
  message: string;
}

const props = defineProps<{
  files: Record<string, string>;
  active: string;
  diagnostic?: EditorDiagnostic | null;
}>();
const emit = defineEmits<{ change: [file: string, source: string]; run: [] }>();

const root = ref<HTMLElement | null>(null);
let view: EditorView | null = null;
const states = new Map<string, EditorState>();

const pocketTheme = EditorView.theme(
  {
    "&": { backgroundColor: "#120c21", color: "#e8e0f5", height: "100%", fontSize: "13px" },
    ".cm-scroller": { fontFamily: "var(--font-mono)", lineHeight: "1.65" },
    ".cm-content": { padding: "12px 0", caretColor: "#ffd23f" },
    ".cm-gutters": { backgroundColor: "#120c21", color: "#5d5279", border: "none", paddingLeft: "6px" },
    ".cm-activeLineGutter": { backgroundColor: "transparent", color: "#cbbde2" },
    ".cm-activeLine": { backgroundColor: "rgba(169,139,255,0.07)" },
    "&.cm-focused .cm-cursor": { borderLeftColor: "#ffd23f", borderLeftWidth: "2px" },
    "&.cm-focused .cm-selectionBackground, .cm-selectionBackground, .cm-content ::selection": {
      backgroundColor: "rgba(255,210,63,0.22) !important",
    },
    ".cm-matchingBracket": { backgroundColor: "rgba(63,208,232,0.18)", outline: "1px solid rgba(63,208,232,0.5)" },
    ".cm-tooltip": { backgroundColor: "#231b3b", border: "2px solid #a98bff", borderRadius: "10px" },
    ".cm-diagnostic-error": { borderLeft: "3px solid #ff5f9e" },
    ".cm-panels": { backgroundColor: "#1c1630", color: "#cbbde2" },
    ".cm-foldPlaceholder": { backgroundColor: "#2b2148", border: "none", color: "#cbbde2" },
  },
  { dark: true },
);

function language(file: string): Extension {
  if (file.endsWith(".vue")) return vue();
  return javascript({ typescript: true, jsx: file.endsWith(".tsx") });
}

function createState(file: string, doc: string): EditorState {
  return EditorState.create({
    doc,
    extensions: [
      basicSetup,
      keymap.of([
        indentWithTab,
        { key: "Mod-Enter", run: () => (emit("run"), true) },
        { key: "Mod-s", run: () => (emit("run"), true), preventDefault: true },
      ]),
      language(file),
      oneDark,
      pocketTheme,
      EditorState.tabSize.of(2),
      EditorView.updateListener.of((u) => {
        if (u.docChanged) emit("change", file, u.state.doc.toString());
      }),
    ],
  });
}

function stateFor(file: string): EditorState {
  let s = states.get(file);
  const doc = props.files[file] ?? "";
  if (!s || s.doc.toString() !== doc) {
    s = createState(file, doc);
    states.set(file, s);
  }
  return s;
}

function show(file: string) {
  if (!view) return;
  states.set(currentFile, view.state);
  currentFile = file;
  view.setState(stateFor(file));
  applyDiagnostic();
}

let currentFile = props.active;

function applyDiagnostic() {
  if (!view) return;
  const d = props.diagnostic;
  const list: Diagnostic[] = [];
  if (d && d.file === currentFile && d.line) {
    const doc = view.state.doc;
    const line = doc.line(Math.min(Math.max(1, d.line), doc.lines));
    const from = Math.min(line.to, line.from + Math.max(0, (d.column ?? 1) - 1));
    list.push({ from, to: Math.max(from + 1, line.to), severity: "error", message: d.message.split("\n")[0]! });
  }
  view.dispatch(setDiagnostics(view.state, list));
}

/** Move the cursor to a line and focus the editor */
function reveal(line: number, column = 1) {
  if (!view) return;
  const doc = view.state.doc;
  const l = doc.line(Math.min(Math.max(1, line), doc.lines));
  const pos = Math.min(l.to, l.from + Math.max(0, column - 1));
  view.dispatch({ selection: { anchor: pos }, effects: EditorView.scrollIntoView(pos, { y: "center" }) });
  view.focus();
}
defineExpose({ reveal });

onMounted(() => {
  view = new EditorView({ state: stateFor(props.active), parent: root.value! });
  currentFile = props.active;
  applyDiagnostic();
});
onBeforeUnmount(() => view?.destroy());

watch(
  () => props.active,
  (file) => show(file),
);
// Rebuild the matching state when file contents are replaced externally (preset switch, reset)
watch(
  () => props.files,
  (files) => {
    for (const key of [...states.keys()]) if (!(key in files)) states.delete(key);
    if (view && view.state.doc.toString() !== (files[currentFile] ?? "")) {
      states.delete(currentFile);
      view.setState(stateFor(currentFile));
      applyDiagnostic();
    }
  },
);
watch(() => props.diagnostic, applyDiagnostic);
</script>

<template>
  <div ref="root" class="h-full min-h-0 overflow-hidden" />
</template>
