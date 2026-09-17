// vapor/compiler/compile.ts — the Pocket Vapor compiler.
//
// Input: one component module in the strict Vue Vapor TS subset (see
// vapor/DESIGN.md §4) — the same file the oracle runs on real vue 3.6.
// Output: one C translation unit (gen_app.c) against the runtime contract
// in vapor/runtime/gba/vapor.h, plus the memory plan and reactive graph.
//
// The pipeline mirrors what @vue/reactivity + vapor do at runtime, moved to
// build time:
//   refs      -> state slots (globals; lists -> fixed-capacity pools)
//   computeds -> cached recompute functions with validity bits
//   bindings  -> paint effects with compile-time dependency bitmasks
//   template  -> static rows painted once + effects merged by row span
//
// Dependency tracking is static and over-approximating: an effect
// subscribes to every ref it MAY read (conditional reads subscribe both
// arms), which can only cause redundant repaints, never a missed one.

import ts from "typescript";
import { BTN as FRAMEWORK_BTN } from "../../contracts/spec/spec.ts";
import { FONT8 } from "./font.gen.ts";
import { sccpRefConstants } from "./sccp.ts";
import { rgb555, rgb565, StyleTable, type StyleIssue } from "./styles.ts";
import { BACKDROP } from "./styles.ts";

// ---------------------------------------------------------------------------
// Public result
// ---------------------------------------------------------------------------

export interface DebugSlot {
  name: string;
  offset: number;
  size: number;
  kind: "num" | "bool" | "str" | "listLen";
}

export type VaporTargetName = "gba" | "gb" | "nes" | "esp32" | "playdate";

export interface VaporTarget {
  name: VaporTargetName;
  width: number;
  height: number;
  poolCap: number;
  strCap: number;
}

/** Per-device geometry + memory budgets. NES is bounded by 2 KB of CPU RAM
 * (shadow grid + debug block + pool must all fit), GB by DMG tile-id space
 * (2 glyph styles x 95 glyphs). ESP32's 20x18 logical grid fits readable
 * 8x7 cells on its 160x128 display. */
export const VAPOR_TARGETS: Record<VaporTargetName, VaporTarget> = {
  gba: { name: "gba", width: 30, height: 20, poolCap: 32, strCap: 24 },
  gb: { name: "gb", width: 20, height: 18, poolCap: 32, strCap: 24 },
  nes: { name: "nes", width: 22, height: 18, poolCap: 8, strCap: 20 },
  esp32: { name: "esp32", width: 20, height: 18, poolCap: 32, strCap: 24 },
  playdate: { name: "playdate", width: 50, height: 30, poolCap: 32, strCap: 24 },
};

const BUTTON_NAMES = ["A", "B", "Select", "Start", "Right", "Left", "Up", "Down", "R", "L"] as const;
const FRAMEWORK_BUTTON_TO_VAPOR: Readonly<Record<string, number>> = {
  CROSS: 0,
  CIRCLE: 1,
  SELECT: 2,
  START: 3,
  RIGHT: 4,
  LEFT: 5,
  UP: 6,
  DOWN: 7,
  RTRIGGER: 8,
  LTRIGGER: 9,
};
const PLAYDATE_BUTTONS = new Set([0, 1, 4, 5, 6, 7]);
const RELATIVE_AXIS_NAMES = ["Primary", "Secondary"] as const;
const TARGET_RELATIVE_AXES: Record<VaporTargetName, readonly number[]> = {
  gba: [],
  gb: [],
  nes: [],
  esp32: [],
  playdate: [0],
};

export interface CompiledApp {
  c: string;
  title: string;
  /** GBA-only pixel RPG host/runtime is required by this app. */
  rpgEnabled: boolean;
  graph: string;
  plan: string;
  debugSlots: DebugSlot[];
  /** class DSL result: pair table + class manifest + per-target lowering */
  styles: StyleTable;
  /** style diagnostics (errors already thrown; warnings informational) */
  diagnostics: string[];
  /** Button ids the compiled source statically references (keymap keys and
   * folded Button.X reads) — the input half of the app's derived demands.
   * Per target: code behind a false SCREEN fold is never compiled. */
  buttonsUsed: number[];
  /** Relative axes statically registered through onAxisDelta(). */
  relativeAxesUsed: number[];
}

export class VaporCompileError extends Error {
  constructor(sf: ts.SourceFile, node: ts.Node, message: string) {
    const { line, character } = sf.getLineAndCharacterOfPosition(node.getStart(sf));
    super(`${sf.fileName}:${line + 1}:${character + 1} — ${message}`);
  }
}

// ---------------------------------------------------------------------------
// Types and bindings
// ---------------------------------------------------------------------------

type Ty =
  | { k: "num" }
  | { k: "bool" }
  | { k: "char" }
  | { k: "strlit" } // C `const char *`
  | { k: "sb" } // C `const vp_sb *`
  | { k: "obj"; iface: string; listRef: string } // nullable record pointer
  | { k: "view"; iface: string; listRef: string; maxLen: number }
  | { k: "void" };

const NUM: Ty = { k: "num" };
const BOOL: Ty = { k: "bool" };

interface IfaceShape {
  name: string;
  fields: { name: string; ty: "str" | "bool" | "num" }[];
}

interface RefBinding {
  kind: "ref";
  name: string;
  index: number; // dirty bit
  refTy: "num" | "bool" | "str" | "list";
  iface?: string;
  seed: ts.Expression;
}

interface ComputedBinding {
  kind: "computed";
  name: string;
  index: number; // validity bit + emit order
  valTy: Ty; // num | view
  deps: Set<string>; // transitive ref names
  maxLen: number; // for views
}

interface FnBinding {
  kind: "fn";
  name: string;
  decl: ts.FunctionDeclaration;
  emitted: boolean;
  deps: Set<string>;
  params: string[]; // s32 params, annotated `: number` in source
}

interface ConstBinding {
  kind: "const";
  name: string;
  value: number | string | string[] | Record<string, number>;
}

interface KeymapBinding {
  kind: "keymap";
  name: string;
  /** button id -> C function name (10-entry fnptr table in ROM) */
  entries: Map<number, string>;
}

interface ComponentBinding {
  kind: "component";
  name: string;
  propsParam: string;
  props: Map<string, string>; // prop name -> declared type text
  body: ts.JsxElement | ts.JsxSelfClosingElement; // the root <row>
}

interface RpgEventSrc {
  tile: number;
  event: number;
}

interface RpgDialogSrc {
  speaker: string;
  line1: string;
  line2: string;
  choice0: string;
  choice1: string;
}

interface RpgMapBinding {
  kind: "rpgMap";
  name: string;
  width: number;
  height: number;
  rows: string[];
  solid: string;
  events: RpgEventSrc[];
  dialogs: RpgDialogSrc[];
}

/** Active props substitution while inlining one component use. */
interface PropsCtx {
  param: string;
  exprs: Map<string, ts.Expression>;
  component: string;
}

/** A paintable row source: an intrinsic <row> or an inlined component body. */
interface RowSrc {
  tag: string;
  attrs: ts.JsxAttributes;
  children: readonly ts.JsxChild[];
  node: ts.Node;
}

interface LocalBinding {
  kind: "local";
  cName: string;
  ty: Ty;
}

type Binding =
  | RefBinding
  | ComputedBinding
  | FnBinding
  | ConstBinding
  | LocalBinding
  | KeymapBinding
  | ComponentBinding
  | RpgMapBinding;

// ---------------------------------------------------------------------------
// Compiler
// ---------------------------------------------------------------------------

export interface CompileOptions {
  /** escalate lossy style lowering (e.g. pair collapse on 2-style targets) to errors */
  strict?: boolean;
}

export function compileVaporApp(
  fileName: string,
  source: string,
  title = "VAPOR",
  targetName: VaporTargetName = "gba",
  options: CompileOptions = {},
): CompiledApp {
  const sf = ts.createSourceFile(fileName, source, ts.ScriptTarget.ESNext, true, ts.ScriptKind.TSX);
  const app = new AppCompiler(sf, title, VAPOR_TARGETS[targetName], options).compile();
  if (targetName === "playdate") {
    const unsupported = app.buttonsUsed.filter((button) => !PLAYDATE_BUTTONS.has(button));
    if (unsupported.length > 0) {
      throw new Error(
        `${fileName} — VT101: playdate has no physical input for ${unsupported
          .map((button) => BUTTON_NAMES[button] ?? `button ${button}`)
          .join(", ")}; supported buttons are A, B, Right, Left, Up, Down`,
      );
    }
  }
  const supportedAxes = new Set(TARGET_RELATIVE_AXES[targetName]);
  const unsupportedAxes = app.relativeAxesUsed.filter((axis) => !supportedAxes.has(axis));
  if (unsupportedAxes.length > 0) {
    throw new Error(
      `${fileName} — VT102: ${targetName} has no adapter for relative axis ${unsupportedAxes
        .map((axis) => RELATIVE_AXIS_NAMES[axis] ?? String(axis))
        .join(", ")}; supported relative axes are ${
        [...supportedAxes].map((axis) => RELATIVE_AXIS_NAMES[axis] ?? String(axis)).join(", ") || "none"
      }`,
    );
  }
  return app;
}

class AppCompiler {
  private ifaces = new Map<string, IfaceShape>();
  private scope = new Map<string, Binding>();
  private refs: RefBinding[] = [];
  private computeds: ComputedBinding[] = [];
  private fns: FnBinding[] = [];
  private handler: ts.ArrowFunction | null = null;
  private repeatHandler: ts.ArrowFunction | null = null;
  private frameHandler: ts.ArrowFunction | null = null;
  private axisHandlers = new Map<number, ts.ArrowFunction>();
  private template: ts.JsxFragment | null = null;

  private vueRef = "";
  private vueComputed = "";
  private hostOnButton = "";
  private hostOnButtonRepeat = "";
  private hostButton = "";
  private hostOnAxisDelta = "";
  private frameworkOnFrame = "";
  private frameworkButton = "";
  private hostDefineRpgMap = "";
  private hostRpgBlocked = "";
  private hostRpgEventAt = "";
  private hostRpgScreen = "";

  private rpgMaps: RpgMapBinding[] = [];
  private rpgScreenCount = 0;

  // emission
  private decls: string[] = [];
  private bodies: string[] = [];
  private tmpCounter = 0;
  private curDeps: Set<string> | null = null;
  private strLits = new Map<string, string>(); // literal -> C name
  private strArrays = new Map<string, string>();

  private styleTable = new StyleTable();
  private styleErrors: string[] = [];
  private styleWarnings: string[] = [];

  /** SCCP result: refs proven constant (name -> value). Reads of these fold
   * through constNum, so they never register dependencies and decidable
   * ternary/if branches drop their dead arm from masks and ROM alike. */
  private sccpFolded: Map<string, number> | null = null;

  // ---- overlay allocation of frame-local temporaries -----------------------
  // Materialized view chains and string scratch used to be either permanent
  // statics (a `vt` lives forever for one call's worth of work) or C-stack
  // locals (21-33 B frames on the cc65/sdcc software stack). Both are wrong
  // for the 8-bit targets: statics never share, stack frames cost code and
  // cycles on every access. Instead every temporary is tagged with the
  // generated function that owns it; two temporaries may share one static
  // slot unless their owners can be live at the same time — same owner, or
  // one owner reachable from the other in the static call graph (helpers,
  // computed accessors, keymap actions). The subset forbids recursion and
  // nothing runs from interrupts, so reachability is the whole story.
  // Placeholders are substituted with colored slot names at emit time.
  private ovlTemps: { id: number; kind: "view" | "sb"; owner: string }[] = [];
  private ovlEdges = new Map<string, Set<string>>(); // caller -> callees
  private ovlOwnerStack: string[] = [];
  private unitCounter = 0;

  private ovlOwner(): string {
    return this.ovlOwnerStack[this.ovlOwnerStack.length - 1] ?? "app_init";
  }

  private withOwner<T>(owner: string, build: () => T): T {
    this.ovlOwnerStack.push(owner);
    try {
      return build();
    } finally {
      this.ovlOwnerStack.pop();
    }
  }

  private allocTemp(kind: "view" | "sb"): string {
    const id = this.ovlTemps.length;
    this.ovlTemps.push({ id, kind, owner: this.ovlOwner() });
    return `@OVL${id}@`;
  }

  private ovlCall(callee: string): void {
    const caller = this.ovlOwner();
    if (caller === callee) return;
    let set = this.ovlEdges.get(caller);
    if (!set) this.ovlEdges.set(caller, (set = new Set()));
    set.add(callee);
  }

  /** Color temporaries into shared static slots; returns decls + name map. */
  private ovlAssign(): { decls: string[]; names: Map<number, string>; slotBytes: number } {
    // transitive reachability over owners
    const reach = new Map<string, Set<string>>();
    const reaches = (from: string, to: string): boolean => {
      let r = reach.get(from);
      if (!r) {
        r = new Set();
        reach.set(from, r);
        const walk = (o: string) => {
          for (const callee of this.ovlEdges.get(o) ?? []) {
            if (!r!.has(callee)) {
              r!.add(callee);
              walk(callee);
            }
          }
        };
        walk(from);
      }
      return r.has(to);
    };
    const interferes = (a: { owner: string }, b: { owner: string }): boolean =>
      a.owner === b.owner || reaches(a.owner, b.owner) || reaches(b.owner, a.owner);

    const names = new Map<number, string>();
    const decls: string[] = [];
    let slotBytes = 0;
    for (const kind of ["view", "sb"] as const) {
      const temps = this.ovlTemps.filter((t) => t.kind === kind);
      const slots: { name: string; members: { owner: string }[] }[] = [];
      for (const t of temps) {
        let slot = slots.find((s) => s.members.every((m) => !interferes(t, m)));
        if (!slot) {
          slot = { name: `ovl_${kind}${slots.length}`, members: [] };
          slots.push(slot);
          decls.push(`static ${kind === "view" ? "vp_view" : "vp_sb"} ${slot.name};`);
          slotBytes += kind === "view" ? 1 + this.target.poolCap : 1 + this.target.strCap;
        }
        slot.members.push(t);
        names.set(t.id, slot.name);
      }
    }
    return { decls, names, slotBytes };
  }

  constructor(
    private sf: ts.SourceFile,
    private title: string,
    private target: VaporTarget,
    private options: CompileOptions = {},
  ) {}

  private styleIssue(node: ts.Node, issue: StyleIssue): void {
    const { line, character } = this.sf.getLineAndCharacterOfPosition(node.getStart(this.sf));
    const text = `${this.sf.fileName}:${line + 1}:${character + 1} — ${issue.code}: ${issue.message}`;
    if (issue.severity === "error" || (this.options.strict && issue.severity === "warn")) {
      this.styleErrors.push(text);
    } else {
      this.styleWarnings.push(text);
    }
  }

  private err(node: ts.Node, message: string): never {
    throw new VaporCompileError(this.sf, node, message);
  }

  // ---- module scan ---------------------------------------------------------

  compile(): CompiledApp {
    let component: ts.ArrowFunction | null = null;
    for (const stmt of this.sf.statements) {
      if (ts.isImportDeclaration(stmt)) this.scanImport(stmt);
      else if (ts.isInterfaceDeclaration(stmt)) this.scanInterface(stmt);
      else if (ts.isTypeAliasDeclaration(stmt)) continue; // types are erased
      else if (ts.isFunctionDeclaration(stmt)) this.scanComponent(stmt);
      else if (ts.isVariableStatement(stmt)) this.scanModuleConst(stmt, true);
      else if (ts.isExportAssignment(stmt)) {
        if (!ts.isArrowFunction(stmt.expression)) this.err(stmt, "export default must be an arrow component");
        component = stmt.expression;
      } else this.err(stmt, `unsupported module statement: ${ts.SyntaxKind[stmt.kind]}`);
    }
    if (!component) this.err(this.sf, "missing `export default () => ...` component");
    if (!this.vueRef || !this.vueComputed) this.err(this.sf, 'component must import { ref, computed } from "vue"');
    // SCCP runs before setup analysis so computed/effect dep collection sees
    // folded ref reads. foldConst here is module-level only: sccpFolded is
    // still null, so constNum cannot consult the result being computed.
    this.sccpFolded = sccpRefConstants({
      component,
      refLocalName: this.vueRef,
      foldConst: (e) => this.constNum(e) ?? this.constBool(e),
    });
    this.scanSetup(component);
    return this.emit();
  }

  private scanImport(stmt: ts.ImportDeclaration): void {
    const from = (stmt.moduleSpecifier as ts.StringLiteral).text;
    const bindings = stmt.importClause?.namedBindings;
    if (!bindings || !ts.isNamedImports(bindings)) this.err(stmt, "only named imports are supported");
    for (const spec of bindings.elements) {
      const imported = (spec.propertyName ?? spec.name).text;
      const local = spec.name.text;
      if (from === "vue") {
        if (imported === "ref") this.vueRef = local;
        else if (imported === "computed") this.vueComputed = local;
        else this.err(spec, `unsupported vue import: ${imported} (subset allows ref, computed)`);
      } else if (/\/host\/input(\.ts)?$/.test(from)) {
        if (imported === "onButton") this.hostOnButton = local;
        else if (imported === "onButtonRepeat") this.hostOnButtonRepeat = local;
        else if (imported === "Button") this.hostButton = local;
        else if (imported === "onAxisDelta") this.hostOnAxisDelta = local;
        else if (imported === "RelativeAxis")
          this.scope.set(local, {
            kind: "const",
            name: local,
            value: { Primary: 0, Secondary: 1 },
          });
        else if (imported === "RelativeAxisUnits")
          this.scope.set(local, {
            kind: "const",
            name: local,
            value: { PerDegree: 1000, PerTurn: 360000 },
          });
        else this.err(spec, `unsupported host import: ${imported}`);
      } else if (/\/host\/screen(\.ts)?$/.test(from)) {
        if (imported !== "SCREEN") this.err(spec, `unsupported host import: ${imported}`);
        this.scope.set(local, {
          kind: "const",
          name: local,
          value: { width: this.target.width, height: this.target.height },
        });
      } else if (/\/host\/rpg(\.ts)?$/.test(from)) {
        if (this.target.name !== "gba")
          this.err(spec, "Pocket Vapor RPG is currently supported only on the gba target");
        if (imported === "defineRpgMap") this.hostDefineRpgMap = local;
        else if (imported === "rpgBlocked") this.hostRpgBlocked = local;
        else if (imported === "rpgEventAt") this.hostRpgEventAt = local;
        else if (imported === "RpgScreen") this.hostRpgScreen = local;
        else this.err(spec, `unsupported RPG host import: ${imported}`);
      } else if (from === "@pocketjs/framework/vue-vapor/lifecycle") {
        if (imported === "onFrame") this.frameworkOnFrame = local;
        else this.err(spec, `unsupported framework lifecycle import: ${imported}`);
      } else if (from === "@pocketjs/framework/vue-vapor/input") {
        if (imported === "BTN") {
          this.frameworkButton = local;
          this.scope.set(local, { kind: "const", name: local, value: FRAMEWORK_BTN });
        } else this.err(spec, `unsupported framework input import: ${imported}`);
      } else this.err(stmt, `unsupported import source: ${from}`);
    }
  }

  private scanInterface(decl: ts.InterfaceDeclaration): void {
    const fields: IfaceShape["fields"] = [];
    for (const member of decl.members) {
      if (!ts.isPropertySignature(member) || !member.type || !ts.isIdentifier(member.name))
        this.err(member, "interface members must be `name: type`");
      const tyText = member.type.getText(this.sf);
      if (tyText !== "string" && tyText !== "boolean" && tyText !== "number")
        this.err(member.type, `interface field type must be string | boolean | number, got ${tyText}`);
      fields.push({
        name: member.name.text,
        ty: tyText === "string" ? "str" : tyText === "boolean" ? "bool" : "num",
      });
    }
    this.ifaces.set(decl.name.text, { name: decl.name.text, fields });
  }

  private scanModuleConst(stmt: ts.VariableStatement, allowRpg: boolean): void {
    if (!(stmt.declarationList.flags & ts.NodeFlags.Const)) this.err(stmt, "module variables must be const");
    for (const decl of stmt.declarationList.declarations) {
      if (!ts.isIdentifier(decl.name) || !decl.initializer) this.err(decl, "const needs a simple name + initializer");
      const name = decl.name.text;
      const init = decl.initializer;
      if (
        ts.isCallExpression(init) &&
        ts.isIdentifier(init.expression) &&
        init.expression.text === this.hostDefineRpgMap
      ) {
        if (!allowRpg) this.err(init, "defineRpgMap() must initialize a module-level const");
        this.scanRpgMap(name, init);
        continue;
      }
      const folded = this.constNum(init) ?? this.constBool(init);
      if (folded !== null) this.scope.set(name, { kind: "const", name, value: folded });
      else if (ts.isStringLiteral(init)) this.scope.set(name, { kind: "const", name, value: init.text });
      else if (ts.isArrayLiteralExpression(init)) {
        const items = init.elements.map((el) => {
          if (!ts.isStringLiteral(el)) this.err(el, "const arrays must contain string literals");
          return el.text;
        });
        this.scope.set(name, { kind: "const", name, value: items });
      } else if (ts.isObjectLiteralExpression(init)) {
        const record: Record<string, number> = {};
        for (const prop of init.properties) {
          if (!ts.isPropertyAssignment(prop) || !ts.isIdentifier(prop.name))
            this.err(prop, "const objects must use `name: number` members");
          const v = this.constNum(prop.initializer);
          if (v === null) this.err(prop.initializer, "const object members must be compile-time numbers");
          record[prop.name.text] = v;
        }
        this.scope.set(name, { kind: "const", name, value: record });
      } else this.err(init, "module consts must be number, string, string[], or {name: number} literals");
    }
  }

  // ---- RPG static assets ----------------------------------------------------

  private rpgPropertyName(prop: ts.PropertyAssignment, context: string): string {
    if (ts.isIdentifier(prop.name) || ts.isStringLiteral(prop.name)) return prop.name.text;
    this.err(prop.name, `${context} keys must be identifiers or string literals`);
  }

  private rpgObjectFields(
    obj: ts.ObjectLiteralExpression,
    context: string,
    allowed: readonly string[],
    required: readonly string[],
  ): Map<string, ts.Expression> {
    const fields = new Map<string, ts.Expression>();
    for (const prop of obj.properties) {
      if (!ts.isPropertyAssignment(prop))
        this.err(prop, `${context} must use explicit \`name: value\` properties (no shorthand or spreads)`);
      const name = this.rpgPropertyName(prop, context);
      if (!allowed.includes(name))
        this.err(prop.name, `unknown ${context} property ${JSON.stringify(name)}; expected ${allowed.join(", ")}`);
      if (fields.has(name)) this.err(prop.name, `duplicate ${context} property ${JSON.stringify(name)}`);
      fields.set(name, prop.initializer);
    }
    for (const name of required)
      if (!fields.has(name)) this.err(obj, `${context} is missing required property ${JSON.stringify(name)}`);
    return fields;
  }

  private rpgString(e: ts.Expression, context: string): string {
    if (!ts.isStringLiteral(e)) this.err(e, `${context} must be a string literal`);
    return e.text;
  }

  /** RPG tile keys and dialogue text are byte-oriented in the GBA POC. */
  private assertRpgAscii(node: ts.Node, text: string, context: string): void {
    for (let i = 0; i < text.length; i++) {
      const code = text.charCodeAt(i);
      if (code < 0x20 || code > 0x7e)
        this.err(node, `${context} must contain printable single-byte ASCII characters`);
    }
  }

  private scanRpgMap(name: string, call: ts.CallExpression): void {
    if (this.target.name !== "gba") this.err(call, "Pocket Vapor RPG is currently supported only on the gba target");
    if (call.arguments.length !== 1 || !ts.isObjectLiteralExpression(call.arguments[0]))
      this.err(call, "defineRpgMap() takes exactly one object literal");
    if (this.scope.has(name)) this.err(call, `duplicate binding ${name}`);

    const spec = this.rpgObjectFields(
      call.arguments[0],
      "RPG map",
      ["rows", "solid", "events", "dialogs"],
      ["rows", "solid", "events", "dialogs"],
    );

    const rowsExpr = spec.get("rows")!;
    if (!ts.isArrayLiteralExpression(rowsExpr)) this.err(rowsExpr, "RPG map rows must be a string-literal array");
    if (rowsExpr.elements.length === 0) this.err(rowsExpr, "RPG map rows cannot be empty");
    if (rowsExpr.elements.length > 20) this.err(rowsExpr, "RPG map height exceeds the GBA limit of 20 rows");
    const rows = rowsExpr.elements.map((row, i) => {
      if (!ts.isStringLiteral(row)) this.err(row, `RPG map row ${i} must be a string literal`);
      this.assertRpgAscii(row, row.text, `RPG map row ${i}`);
      return row.text;
    });
    const width = rows[0].length;
    if (width === 0) this.err(rowsExpr.elements[0], "RPG map rows cannot be empty strings");
    if (width > 30) this.err(rowsExpr.elements[0], "RPG map width exceeds the GBA limit of 30 columns");
    for (let i = 1; i < rows.length; i++)
      if (rows[i].length !== width)
        this.err(
          rowsExpr.elements[i],
          `RPG map rows must be equal width: row 0 is ${width}, row ${i} is ${rows[i].length}`,
        );

    const solidExpr = spec.get("solid")!;
    const solid = this.rpgString(solidExpr, "RPG map solid");
    this.assertRpgAscii(solidExpr, solid, "RPG map solid");
    const seenSolid = new Set<string>();
    for (const ch of solid) {
      if (seenSolid.has(ch)) this.err(solidExpr, `RPG map solid contains duplicate tile ${JSON.stringify(ch)}`);
      seenSolid.add(ch);
    }

    const eventsExpr = spec.get("events")!;
    if (!ts.isObjectLiteralExpression(eventsExpr))
      this.err(eventsExpr, "RPG map events must be an object of single-character keys to event ids");
    if (eventsExpr.properties.length > 255) this.err(eventsExpr, "RPG map supports at most 255 event tile keys");
    const events: RpgEventSrc[] = [];
    const seenEventKeys = new Set<string>();
    const flatRows = rows.join("");
    for (const prop of eventsExpr.properties) {
      if (!ts.isPropertyAssignment(prop)) this.err(prop, "RPG event entries must use \`\"X\": id\`");
      const key = this.rpgPropertyName(prop, "RPG event");
      if (key.length !== 1) this.err(prop.name, "RPG event keys must be exactly one character");
      this.assertRpgAscii(prop.name, key, "RPG event key");
      if (seenEventKeys.has(key)) this.err(prop.name, `duplicate RPG event key ${JSON.stringify(key)}`);
      seenEventKeys.add(key);
      if (!flatRows.includes(key))
        this.err(prop.name, `RPG event key ${JSON.stringify(key)} does not occur in any map row`);
      const event = this.constNum(prop.initializer);
      if (event === null || !Number.isInteger(event) || event < 1 || event > 255)
        this.err(prop.initializer, "RPG event ids must be compile-time integers in 1..255 (0 means no event)");
      events.push({ tile: key.charCodeAt(0), event });
    }

    const dialogsExpr = spec.get("dialogs")!;
    if (!ts.isArrayLiteralExpression(dialogsExpr)) this.err(dialogsExpr, "RPG dialogs must be an object-literal array");
    if (dialogsExpr.elements.length > 255) this.err(dialogsExpr, "RPG maps support at most 255 dialogs");
    const dialogs = dialogsExpr.elements.map((dialog, i): RpgDialogSrc => {
      if (!ts.isObjectLiteralExpression(dialog)) this.err(dialog, `RPG dialog ${i} must be an object literal`);
      const fields = this.rpgObjectFields(
        dialog,
        `RPG dialog ${i}`,
        ["speaker", "line1", "line2", "choice0", "choice1"],
        ["speaker", "line1"],
      );
      const read = (field: "speaker" | "line1" | "line2" | "choice0" | "choice1"): string => {
        const value = fields.get(field);
        if (!value) return "";
        const text = this.rpgString(value, `RPG dialog ${i}.${field}`);
        this.assertRpgAscii(value, text, `RPG dialog ${i}.${field}`);
        return text;
      };
      return {
        speaker: read("speaker"),
        line1: read("line1"),
        line2: read("line2"),
        choice0: read("choice0"),
        choice1: read("choice1"),
      };
    });

    const binding: RpgMapBinding = {
      kind: "rpgMap",
      name,
      width,
      height: rows.length,
      rows,
      solid,
      events,
      dialogs,
    };
    this.rpgMaps.push(binding);
    this.scope.set(name, binding);
  }

  // ---- setup scan ----------------------------------------------------------

  private scanSetup(component: ts.ArrowFunction): void {
    if (!ts.isBlock(component.body)) this.err(component, "component body must be a block");
    for (const stmt of component.body.statements) {
      if (ts.isVariableStatement(stmt)) this.scanSetupConst(stmt);
      else if (ts.isFunctionDeclaration(stmt)) {
        if (!stmt.name || !stmt.body) this.err(stmt, "setup functions need a name and body");
        const params = stmt.parameters.map((p) => {
          if (!ts.isIdentifier(p.name)) this.err(p, "helper params must be simple names");
          if (!p.type || p.type.getText(this.sf) !== "number")
            this.err(p, "helper params must be annotated `: number`");
          return p.name.text;
        });
        const binding: FnBinding = {
          kind: "fn",
          name: stmt.name.text,
          decl: stmt,
          emitted: false,
          deps: new Set(),
          params,
        };
        this.scope.set(stmt.name.text, binding);
        this.fns.push(binding);
      } else if (ts.isExpressionStatement(stmt)) {
        const call = stmt.expression;
        if (
          ts.isCallExpression(call) &&
          ts.isIdentifier(call.expression) &&
          call.expression.text === this.hostOnButton
        ) {
          if (this.handler) this.err(call, "only one onButton handler is supported");
          const arg = call.arguments[0];
          if (!arg || !ts.isArrowFunction(arg)) this.err(call, "onButton takes an arrow");
          this.handler = arg;
        } else if (
          ts.isCallExpression(call) &&
          ts.isIdentifier(call.expression) &&
          call.expression.text === this.hostOnButtonRepeat
        ) {
          if (this.target.name !== "gba")
            this.err(call, "onButtonRepeat is currently supported only on the gba target");
          if (this.repeatHandler) this.err(call, "only one onButtonRepeat handler is supported");
          const arg = call.arguments[0];
          if (!arg || !ts.isArrowFunction(arg)) this.err(call, "onButtonRepeat takes an arrow");
          this.repeatHandler = arg;
        } else if (
          ts.isCallExpression(call) &&
          ts.isIdentifier(call.expression) &&
          call.expression.text === this.frameworkOnFrame
        ) {
          if (this.target.name !== "gba")
            this.err(call, "onFrame is currently supported only on the gba target");
          if (this.frameHandler) this.err(call, "only one onFrame handler is supported");
          const arg = call.arguments[0];
          if (!arg || !ts.isArrowFunction(arg)) this.err(call, "onFrame takes an arrow");
          if (arg.parameters.length > 1 || (arg.parameters[0] && !ts.isIdentifier(arg.parameters[0].name)))
            this.err(arg, "onFrame arrow takes zero args or one simple buttons parameter");
          this.frameHandler = arg;
        } else if (
          ts.isCallExpression(call) &&
          ts.isIdentifier(call.expression) &&
          call.expression.text === this.hostOnAxisDelta
        ) {
          const axisNode = call.arguments[0];
          const handler = call.arguments[1];
          if (!axisNode) this.err(call, "onAxisDelta requires a relative axis");
          const axis = this.constNum(axisNode);
          if (axis === null || axis < 0 || axis >= RELATIVE_AXIS_NAMES.length)
            this.err(axisNode, "onAxisDelta axis must be a compile-time RelativeAxis constant");
          if (!handler || !ts.isArrowFunction(handler))
            this.err(call, "onAxisDelta takes an axis and an arrow");
          if (handler.parameters.length !== 1)
            this.err(handler, "onAxisDelta arrow needs exactly one delta parameter");
          if (this.axisHandlers.has(axis))
            this.err(axisNode, `only one onAxisDelta handler is supported for ${RELATIVE_AXIS_NAMES[axis]}`);
          this.axisHandlers.set(axis, handler);
        } else this.err(stmt, "unsupported setup statement");
      } else if (ts.isReturnStatement(stmt)) {
        if (!stmt.expression) this.err(stmt, "component must return JSX");
        const expr = ts.isParenthesizedExpression(stmt.expression) ? stmt.expression.expression : stmt.expression;
        if (!ts.isJsxFragment(expr)) this.err(stmt, "component must return a JSX fragment (<>...</>)");
        this.template = expr;
      } else this.err(stmt, `unsupported setup statement: ${ts.SyntaxKind[stmt.kind]}`);
    }
    if (!this.template) this.err(component, "component never returned JSX");
  }

  private scanSetupConst(stmt: ts.VariableStatement): void {
    for (const decl of stmt.declarationList.declarations) {
      if (!ts.isIdentifier(decl.name) || !decl.initializer) this.err(decl, "setup const needs name + initializer");
      const name = decl.name.text;
      const init = decl.initializer;
      if (ts.isCallExpression(init) && ts.isIdentifier(init.expression) && init.expression.text === this.vueRef) {
        const seed = init.arguments[0];
        if (!seed) this.err(init, "ref() needs an initial value");
        const binding: RefBinding = {
          kind: "ref",
          name,
          index: this.refs.length,
          refTy: this.classifyRefSeed(init, seed),
          seed,
        };
        if (binding.refTy === "list") binding.iface = this.listIfaceOf(init, seed);
        if (this.refs.length >= 16) this.err(init, "subset budget: at most 16 refs");
        this.refs.push(binding);
        this.scope.set(name, binding);
      } else if (
        ts.isCallExpression(init) &&
        ts.isIdentifier(init.expression) &&
        init.expression.text === this.vueComputed
      ) {
        const arrow = init.arguments[0];
        if (!arrow || !ts.isArrowFunction(arrow)) this.err(init, "computed() takes an arrow");
        this.compileComputed(name, arrow);
      } else if (
        ts.isObjectLiteralExpression(init) &&
        init.properties.length > 0 &&
        init.properties.every((p) => ts.isPropertyAssignment(p) && ts.isComputedPropertyName(p.name))
      ) {
        this.scanKeymap(name, init);
      } else {
        this.scanModuleConst(stmt, false);
        return;
      }
    }
  }

  private classifyRefSeed(at: ts.Node, seed: ts.Expression): RefBinding["refTy"] {
    if (ts.isNumericLiteral(seed) || ts.isPrefixUnaryExpression(seed)) return "num";
    if (seed.kind === ts.SyntaxKind.TrueKeyword || seed.kind === ts.SyntaxKind.FalseKeyword) return "bool";
    if (ts.isStringLiteral(seed)) return "str";
    if (ts.isArrayLiteralExpression(seed)) return "list";
    this.err(at, "ref() seed must be a number, boolean, string, or object-literal array");
  }

  private listIfaceOf(call: ts.CallExpression, seed: ts.Expression): string {
    const typeArg = call.typeArguments?.[0];
    if (typeArg && ts.isArrayTypeNode(typeArg) && ts.isTypeReferenceNode(typeArg.elementType)) {
      const name = typeArg.elementType.typeName.getText(this.sf);
      if (this.ifaces.has(name)) return name;
    }
    this.err(seed, "list refs need an explicit ref<T[]>(...) annotation with a declared interface T");
  }

  // ---- components ------------------------------------------------------------
  // Module-level `function Name(props: {...}) { return <row .../> }` — real
  // vapor functional components under the oracle, inlined to zero-cost paint
  // code by the compiler: at each use site the body <row> compiles with
  // `props.<name>` substituted (at the AST level) by the use-site expression,
  // so dependency masks, const folding and span analysis all see through.

  private propsCtx: PropsCtx | null = null;

  // cc65 is C89: block-scope declarations must lead their block, so every
  // generated function collects pointer/local declarations here and emits
  // them at the top ("hoisting"), with assignments left in place.
  private hoist: string[] | null = null;

  private declare(decl: string): void {
    if (!this.hoist) throw new Error("declaration emitted outside a function context");
    this.hoist.push(decl);
  }

  private withHoist(build: (body: string[]) => void): { decls: string[]; body: string[] } {
    const prev = this.hoist;
    this.hoist = [];
    const body: string[] = [];
    build(body);
    const decls = this.hoist.map((d) => `  ${d}`);
    this.hoist = prev;
    return { decls, body };
  }

  private scanComponent(decl: ts.FunctionDeclaration): void {
    if (!decl.name || !/^[A-Z]/.test(decl.name.text))
      this.err(decl, "module functions must be UI components (Capitalized name)");
    const param = decl.parameters[0];
    if (
      decl.parameters.length !== 1 ||
      !param ||
      !ts.isIdentifier(param.name) ||
      !param.type ||
      !ts.isTypeLiteralNode(param.type)
    )
      this.err(decl, "components take a single `props: { ... }` parameter with an inline type literal");
    const props = new Map<string, string>();
    for (const member of param.type.members) {
      if (!ts.isPropertySignature(member) || !member.type || !ts.isIdentifier(member.name))
        this.err(member, "component props must be `name: type`");
      const propName = member.name.text;
      if (propName === "y" || propName === "x" || propName === "pal")
        this.err(
          member,
          `prop name "${propName}" collides with a <row> attribute: on a functional component, ` +
            "vue's fallthrough suppresses the template's own root-element binding of a same-named " +
            "key while forwarding only class/style/on* — the attribute would be written by nobody. " +
            'Name it differently (e.g. "line" for the row position).',
        );
      props.set(propName, member.type.getText(this.sf));
    }
    if (!decl.body || decl.body.statements.length !== 1) this.err(decl, "component body must be a single return");
    const ret = decl.body.statements[0];
    if (!ts.isReturnStatement(ret) || !ret.expression) this.err(ret, "component must return JSX");
    let expr: ts.Expression = ret.expression;
    while (ts.isParenthesizedExpression(expr)) expr = expr.expression;
    if (!ts.isJsxElement(expr) && !ts.isJsxSelfClosingElement(expr))
      this.err(ret, "component must return a single <row>");
    const tag = ts.isJsxElement(expr)
      ? expr.openingElement.tagName.getText(this.sf)
      : expr.tagName.getText(this.sf);
    if (tag !== "row") this.err(expr, "component root must be a <row> (components cannot nest, v1)");
    this.scope.set(decl.name.text, {
      kind: "component",
      name: decl.name.text,
      propsParam: param.name.text,
      props,
      body: expr,
    });
  }

  /** If e is `props.<name>` under an active inline, the use-site expression. */
  private substProp(e: ts.Expression): ts.Expression | null {
    if (!this.propsCtx) return null;
    if (
      ts.isPropertyAccessExpression(e) &&
      ts.isIdentifier(e.expression) &&
      e.expression.text === this.propsCtx.param
    ) {
      const sub = this.propsCtx.exprs.get(e.name.text);
      if (!sub) this.err(e, `<${this.propsCtx.component}> read prop ${e.name.text}, which was not passed`);
      return this.unparen(sub);
    }
    return null;
  }

  // ---- keymaps --------------------------------------------------------------
  // `const listKeys: Keymap = { [Button.Up]: () => ..., [Button.A]: action }`
  // Each value becomes a C function; the map becomes a 10-entry function-
  // pointer table in ROM, indexed by the GBA key bit. Dispatch is
  // `(cond ? mapA : mapB)[b]?.()` — undefined entries are null pointers.

  private keymaps: KeymapBinding[] = [];
  private buttonsUsed = new Set<number>();

  private scanKeymap(name: string, init: ts.ObjectLiteralExpression): void {
    const entries = new Map<number, string>();
    for (const prop of init.properties) {
      const pa = prop as ts.PropertyAssignment;
      const keyExpr = (pa.name as ts.ComputedPropertyName).expression;
      const key = this.constNum(keyExpr);
      if (key === null || key < 0 || key > 9)
        this.err(keyExpr, "keymap keys must be compile-time Button constants (0..9)");
      if (entries.has(key)) this.err(keyExpr, "duplicate keymap key");
      const value = this.unparen(pa.initializer);
      if (ts.isArrowFunction(value)) {
        if (value.parameters.length !== 0) this.err(value, "keymap actions take no arguments");
        const cName = `km_${name}_${key}`;
        this.compileActionArrow(cName, value);
        entries.set(key, cName);
      } else if (ts.isIdentifier(value)) {
        const b = this.scope.get(value.text);
        if (b?.kind !== "fn") this.err(value, "keymap values must be arrows or setup functions");
        if (b.params.length !== 0) this.err(value, `${b.name} takes arguments; wrap it in an arrow`);
        this.emitFn(b);
        entries.set(key, `fn_${b.name}`);
      } else this.err(pa.initializer, "keymap values must be arrows or setup functions");
    }
    const binding: KeymapBinding = { kind: "keymap", name, entries };
    this.keymaps.push(binding);
    this.scope.set(name, binding);
  }

  private compileActionArrow(cName: string, arrow: ts.ArrowFunction): void {
    const saved = new Map(this.scope);
    const { decls, body } = this.withOwner(cName, () => this.withHoist((out) => {
      if (ts.isBlock(arrow.body)) {
        for (const stmt of arrow.body.statements) this.compileStmt(stmt, out, "  ");
      } else {
        this.compileExprStmt(arrow.body, out, "  ");
      }
    }));
    this.scope = saved;
    this.bodies.push(`static void ${cName}(void) {\n${[...decls, ...body].join("\n")}\n}\n`);
  }

  /** Resolve a keymap-typed expression to a C fnptr-table expression. */
  private compileKeymapExpr(e: ts.Expression, out: string[], ind: string): string | null {
    e = this.unparen(e);
    if (ts.isIdentifier(e)) {
      const b = this.scope.get(e.text);
      if (b?.kind !== "keymap") return null;
      // indirect dispatch: the caller may enter any action in this table
      for (const cName of b.entries.values()) this.ovlCall(cName);
      return `KM_${b.name}`;
    }
    if (ts.isConditionalExpression(e)) {
      const a = this.compileKeymapExpr(e.whenTrue, out, ind);
      const bTab = this.compileKeymapExpr(e.whenFalse, out, ind);
      if (!a || !bTab) return null;
      const cond = this.compileExpr(e.condition, out, ind);
      return `(${this.truthy(cond)} ? ${a} : ${bTab})`;
    }
    return null;
  }

  // ---- shared emission helpers --------------------------------------------

  private tmp(prefix: string): string {
    return `${prefix}${this.tmpCounter++}`;
  }

  private cStrLit(text: string): string {
    let name = this.strLits.get(text);
    if (!name) {
      name = `S${this.strLits.size}`;
      this.strLits.set(text, name);
    }
    return name;
  }

  private escC(text: string): string {
    return text.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
  }

  private depRef(name: string): void {
    this.curDeps?.add(name);
  }

  private refBit(name: string): number {
    const b = this.scope.get(name);
    if (!b || b.kind !== "ref") throw new Error(`not a ref: ${name}`);
    return 1 << b.index;
  }

  private maskOf(deps: Set<string>): number {
    let mask = 0;
    for (const d of deps) mask |= this.refBit(d);
    return mask;
  }

  // ---- computed compilation -------------------------------------------------

  private compileComputed(name: string, arrow: ts.ArrowFunction): void {
    if (this.computeds.length >= 16) this.err(arrow, "subset budget: at most 16 computeds");
    const body = arrow.body;
    if (ts.isBlock(body)) this.err(body, "computed bodies must be single expressions");

    const deps = new Set<string>();
    const prevDeps = this.curDeps;
    this.curDeps = deps;

    const index = this.computeds.length;
    let binding!: ComputedBinding;
    const hoisted = this.withOwner(`c_${name}_update`, () => this.withHoist((lines) => {
    if (this.isViewExpr(body)) {
      const maxLen = this.viewMaxLen(body);
      binding = { kind: "computed", name, index, valTy: this.viewTyOf(body), deps, maxLen };
      this.compileViewInto(body, `c_${name}_v`, lines, "  ");
    } else {
      const val = this.compileExpr(body, lines, "  ");
      if (val.ty.k !== "num" && val.ty.k !== "bool" && val.ty.k !== "obj")
        this.err(body, "computed must yield a number, a record, or a list view");
      binding = {
        kind: "computed",
        name,
        index,
        valTy: val.ty.k === "obj" ? val.ty : NUM,
        deps,
        maxLen: 0,
      };
      lines.push(`  c_${name}_v = ${val.c};`);
    }
    }));
    const lines = [...hoisted.decls, ...hoisted.body];
    this.curDeps = prevDeps;

    const cTy =
      binding.valTy.k === "view"
        ? { store: "static vp_view", accessor: "static const vp_view *", result: `&c_${name}_v` }
        : binding.valTy.k === "obj"
          ? {
              store: `static rec_${binding.valTy.iface.toLowerCase()} *`,
              accessor: `static rec_${binding.valTy.iface.toLowerCase()} *`,
              result: `c_${name}_v`,
            }
          : { store: "static s32", accessor: "static s32 ", result: `c_${name}_v` };
    this.decls.push(`${cTy.store} c_${name}_v;`);
    this.bodies.push(
      `static void c_${name}_update(void) {\n${lines.join("\n")}\n}\n` +
        `${cTy.accessor}c_${name}(void) {\n` +
        `  if (!(c_valid & ${1 << index}u)) { c_${name}_update(); c_valid |= ${1 << index}u; }\n` +
        `  return ${cTy.result};\n}\n`,
    );
    this.computeds.push(binding);
    this.scope.set(name, binding);
  }

  // A view expression: list-typed — todos.value, computed-view reads,
  // .filter(...), .slice(...), or a ternary of views.
  private isViewExpr(e: ts.Expression): boolean {
    e = this.unparen(e);
    if (ts.isConditionalExpression(e)) return this.isViewExpr(e.whenTrue) && this.isViewExpr(e.whenFalse);
    if (ts.isCallExpression(e) && ts.isPropertyAccessExpression(e.expression)) {
      const method = e.expression.name.text;
      if (method === "filter" || method === "slice") return this.isViewExpr(e.expression.expression);
      return false;
    }
    const base = this.valueBase(e);
    if (!base) return false;
    const b = this.scope.get(base);
    return (b?.kind === "ref" && b.refTy === "list") || (b?.kind === "computed" && b.valTy.k === "view");
  }

  /** `name.value` -> name, for ref/computed reads. */
  private valueBase(e: ts.Expression): string | null {
    e = this.unparen(e);
    if (
      ts.isPropertyAccessExpression(e) &&
      e.name.text === "value" &&
      ts.isIdentifier(e.expression)
    )
      return e.expression.text;
    return null;
  }

  private unparen(e: ts.Expression): ts.Expression {
    while (ts.isParenthesizedExpression(e)) e = e.expression;
    return e;
  }

  private viewTyOf(e: ts.Expression): Ty {
    const iface = this.viewIface(e);
    return { k: "view", iface, listRef: this.viewListRef(e), maxLen: this.viewMaxLen(e) };
  }

  private viewIface(e: ts.Expression): string {
    return this.ifaceOfListRef(this.viewListRef(e));
  }

  private ifaceOfListRef(refName: string): string {
    const b = this.scope.get(refName);
    if (b?.kind === "ref" && b.iface) return b.iface;
    throw new Error(`no iface for list ref ${refName}`);
  }

  private viewListRef(e: ts.Expression): string {
    e = this.unparen(e);
    if (ts.isConditionalExpression(e)) return this.viewListRef(e.whenTrue);
    if (ts.isCallExpression(e) && ts.isPropertyAccessExpression(e.expression))
      return this.viewListRef(e.expression.expression);
    const base = this.valueBase(e);
    if (base) {
      const b = this.scope.get(base);
      if (b?.kind === "ref") return b.name;
      if (b?.kind === "computed" && b.valTy.k === "view") return b.valTy.listRef;
    }
    this.err(e, "cannot resolve the list this view reads");
  }

  private viewMaxLen(e: ts.Expression): number {
    e = this.unparen(e);
    if (ts.isConditionalExpression(e)) {
      const cf = this.constNum(e.condition) ?? this.constBool(e.condition);
      if (cf !== null) return this.viewMaxLen(cf ? e.whenTrue : e.whenFalse);
      return Math.max(this.viewMaxLen(e.whenTrue), this.viewMaxLen(e.whenFalse));
    }
    if (ts.isCallExpression(e) && ts.isPropertyAccessExpression(e.expression)) {
      const inner = this.viewMaxLen(e.expression.expression);
      if (e.expression.name.text === "filter") return inner;
      // slice(a, a + K) or slice(a, b): bound by constant difference if provable
      const [a, b] = e.arguments;
      const win = this.sliceWindow(a, b);
      return win === null ? inner : Math.min(inner, win);
    }
    const base = this.valueBase(e);
    if (base) {
      const b = this.scope.get(base);
      if (b?.kind === "ref") return this.target.poolCap;
      if (b?.kind === "computed") return b.maxLen;
    }
    return this.target.poolCap;
  }

  /** Comparisons over compile-time numbers fold to 0/1 (SCREEN.width < 30),
   * plus !x and short-circuit &&/|| over foldable operands — SCCP-folded
   * ref reads arrive through constNum, so `!locked.value` folds too. */
  private constBool(e: ts.Expression): number | null {
    e = this.unparen(e);
    const K = ts.SyntaxKind;
    if (ts.isPrefixUnaryExpression(e) && e.operator === K.ExclamationToken) {
      const v = this.constNum(e.operand) ?? this.constBool(e.operand);
      return v === null ? null : v ? 0 : 1;
    }
    if (!ts.isBinaryExpression(e)) return null;
    const op = e.operatorToken.kind;
    if (op === K.AmpersandAmpersandToken || op === K.BarBarToken) {
      const l = this.constNum(e.left) ?? this.constBool(e.left);
      if (l === null) return null; // short-circuit needs a decided left
      if (op === K.AmpersandAmpersandToken && !l) return 0;
      if (op === K.BarBarToken && l) return 1;
      const r = this.constNum(e.right) ?? this.constBool(e.right);
      return r === null ? null : r ? 1 : 0;
    }
    const l = this.constNum(e.left);
    const r = this.constNum(e.right);
    if (l === null || r === null) return null;
    switch (op) {
      case K.LessThanToken: return l < r ? 1 : 0;
      case K.GreaterThanToken: return l > r ? 1 : 0;
      case K.LessThanEqualsToken: return l <= r ? 1 : 0;
      case K.GreaterThanEqualsToken: return l >= r ? 1 : 0;
      case K.EqualsEqualsEqualsToken: return l === r ? 1 : 0;
      case K.ExclamationEqualsEqualsToken: return l !== r ? 1 : 0;
      default: return null;
    }
  }

  /** slice(x, x + K) with syntactically-identical x -> K. */
  private sliceWindow(a: ts.Expression | undefined, b: ts.Expression | undefined): number | null {
    if (!a || !b) return null;
    const bx = this.unparen(b);
    if (ts.isBinaryExpression(bx) && bx.operatorToken.kind === ts.SyntaxKind.PlusToken) {
      const k = this.constNum(bx.right);
      if (k !== null && bx.left.getText(this.sf) === a.getText(this.sf)) return k;
    }
    return null;
  }

  private constNum(e: ts.Expression): number | null {
    e = this.unparen(e);
    const sub = this.substProp(e);
    if (sub) return this.constNum(sub);
    if (ts.isNumericLiteral(e)) return Number(e.text);
    if (ts.isPrefixUnaryExpression(e) && e.operator === ts.SyntaxKind.MinusToken) {
      const operand = this.constNum(e.operand);
      return operand === null ? null : -operand;
    }
    // SCCP-folded ref reads: `flag.value` where flag is proven constant.
    // Scope check keeps shadowing locals (map/filter params) out.
    {
      const base = this.valueBase(e);
      if (base !== null && this.sccpFolded?.has(base)) {
        const b = this.scope.get(base);
        if (!b || b.kind === "ref") return this.sccpFolded.get(base)!;
      }
    }
    if (ts.isIdentifier(e)) {
      const b = this.scope.get(e.text);
      if (b?.kind === "const" && typeof b.value === "number") return b.value;
    }
    if (ts.isPropertyAccessExpression(e)) {
      // GLYPHS.length, FILTERS.length, PAL.title, Button.X
      if (ts.isIdentifier(e.expression)) {
        const b = this.scope.get(e.expression.text);
        if (b?.kind === "const" && typeof b.value === "string" && e.name.text === "length") return b.value.length;
        if (b?.kind === "const" && Array.isArray(b.value) && e.name.text === "length") return b.value.length;
        if (b?.kind === "const" && typeof b.value === "object" && !Array.isArray(b.value)) {
          const record = b.value as Record<string, number>;
          if (e.name.text in record) {
            if (e.expression.text === this.frameworkButton) {
              const button = FRAMEWORK_BUTTON_TO_VAPOR[e.name.text];
              if (button === undefined)
                this.err(e, `BTN.${e.name.text} has no Pocket Vapor button mapping`);
              this.buttonsUsed.add(button);
            }
            return record[e.name.text];
          }
        }
        if (e.expression.text === this.hostButton) {
          const buttons: Record<string, number> = {
            A: 0, B: 1, Select: 2, Start: 3, Right: 4, Left: 5, Up: 6, Down: 7, R: 8, L: 9,
          };
          if (e.name.text in buttons) {
            this.buttonsUsed.add(buttons[e.name.text]);
            return buttons[e.name.text];
          }
        }
      }
    }
    if (ts.isBinaryExpression(e)) {
      const l = this.constNum(e.left);
      const r = this.constNum(e.right);
      if (l !== null && r !== null) {
        switch (e.operatorToken.kind) {
          case ts.SyntaxKind.PlusToken: return l + r;
          case ts.SyntaxKind.MinusToken: return l - r;
          case ts.SyntaxKind.AsteriskToken: return l * r;
        }
      }
    }
    return null;
  }

  /** Emit statements filling `target` (a vp_view lvalue) from a view expr. */
  private compileViewInto(e: ts.Expression, target: string, out: string[], ind: string): void {
    e = this.unparen(e);
    if (ts.isConditionalExpression(e)) {
      const cf = this.constNum(e.condition) ?? this.constBool(e.condition);
      if (cf !== null) {
        this.compileViewInto(cf ? e.whenTrue : e.whenFalse, target, out, ind);
        return;
      }
      const cond = this.compileExpr(e.condition, out, ind);
      out.push(`${ind}if (${this.condition(cond)}) {`);
      this.compileViewInto(e.whenTrue, target, out, ind + "  ");
      out.push(`${ind}} else {`);
      this.compileViewInto(e.whenFalse, target, out, ind + "  ");
      out.push(`${ind}}`);
      return;
    }
    if (ts.isCallExpression(e) && ts.isPropertyAccessExpression(e.expression)) {
      const method = e.expression.name.text;
      const srcExpr = e.expression.expression;
      if (method === "filter") {
        const src = this.viewSource(srcExpr, out, ind);
        const arrow = e.arguments[0];
        if (!arrow || !ts.isArrowFunction(arrow) || ts.isBlock(arrow.body) || arrow.parameters.length !== 1)
          this.err(e, "filter takes a single-param expression arrow");
        const param = arrow.parameters[0].name.getText(this.sf);
        const iface = this.viewIface(srcExpr);
        const listRef = this.viewListRef(srcExpr);
        const i = this.tmp("i");
        const p = this.tmp("p");
        out.push(`${ind}{ u8 ${i}; ${target}.len = 0;`);
        out.push(`${ind}  for (${i} = 0; ${i} < ${src.len}; ${i}++) {`);
        out.push(`${ind}    rec_${iface.toLowerCase()} *${p} = g_${listRef} + (u16)(${src.at(i)});`);
        const saved = new Map(this.scope);
        this.scope.set(param, { kind: "local", cName: p, ty: { k: "obj", iface, listRef } });
        const pred = this.compileExpr(arrow.body, out, ind + "    ");
        this.scope = saved;
        out.push(`${ind}    if (${this.condition(pred)}) ${target}.idx[${target}.len++] = ${src.at(i)};`);
        out.push(`${ind}  }`);
        out.push(`${ind}}`);
        return;
      }
      if (method === "slice") {
        const src = this.viewSource(srcExpr, out, ind);
        const a = e.arguments[0] ? this.compileExpr(e.arguments[0], out, ind) : { c: "0", ty: NUM };
        const b = e.arguments[1] ? this.compileExpr(e.arguments[1], out, ind) : { c: src.len, ty: NUM };
        const s = this.tmp("s");
        const t = this.tmp("t");
        const i = this.tmp("i");
        out.push(`${ind}{ s32 ${s} = ${a.c}, ${t} = ${b.c}; u8 ${i};`);
        out.push(`${ind}  if (${s} < 0) ${s} = 0;`);
        out.push(`${ind}  if (${t} > (s32)${src.len}) ${t} = (s32)${src.len};`);
        out.push(`${ind}  ${target}.len = 0;`);
        out.push(`${ind}  for (${i} = (u8)${s}; (s32)${i} < ${t}; ${i}++) ${target}.idx[${target}.len++] = ${src.at(i)};`);
        out.push(`${ind}}`);
        return;
      }
      this.err(e, `unsupported view method: ${method}`);
    }
    // base case: identity over a list ref or copy of a computed view
    const src = this.viewSource(e, out, ind);
    const i = this.tmp("i");
    out.push(`${ind}{ u8 ${i}; ${target}.len = 0;`);
    out.push(`${ind}  for (${i} = 0; ${i} < ${src.len}; ${i}++) ${target}.idx[${target}.len++] = ${src.at(i)};`);
    out.push(`${ind}}`);
  }

  /** Resolve a view source to (len, at(i)) C fragments without materializing. */
  private viewSource(
    e: ts.Expression,
    out: string[],
    ind: string,
  ): { len: string; at: (i: string) => string } {
    e = this.unparen(e);
    const base = this.valueBase(e);
    if (base) {
      const b = this.scope.get(base);
      if (b?.kind === "ref" && b.refTy === "list") {
        this.depRef(b.name);
        return { len: `g_${b.name}_len`, at: (i) => i };
      }
      if (b?.kind === "computed" && b.valTy.k === "view") {
        for (const d of b.deps) this.depRef(d);
        this.ovlCall(`c_${b.name}_update`);
        const v = this.tmp("v");
        this.declare(`const vp_view *${v};`);
        out.push(`${ind}${v} = c_${b.name}();`);
        return { len: `${v}->len`, at: (i) => `${v}->idx[${i}]` };
      }
    }
    // nested filter/slice chain: materialize into an overlay temp view
    if (ts.isCallExpression(e)) {
      const v = this.allocTemp("view");
      this.compileViewInto(e, v, out, ind);
      return { len: `${v}.len`, at: (i) => `${v}.idx[${i}]` };
    }
    this.err(e, "unsupported view source");
  }

  private truthy(v: { c: string; ty: Ty }): string {
    if (v.ty.k === "obj") return `(${v.c} != 0)`;
    return v.c;
  }

  /** C control-flow syntax already supplies the outer parentheses. */
  private condition(v: { c: string; ty: Ty }): string {
    const c = this.truthy(v);
    return v.ty.k === "bool" && c.startsWith("(") && c.endsWith(")")
      ? c.slice(1, -1)
      : c;
  }

  // ---- scalar expression compilation ---------------------------------------

  private compileExpr(e: ts.Expression, out: string[], ind: string): { c: string; ty: Ty } {
    e = this.unparen(e);
    const sub = this.substProp(e);
    if (sub) return this.compileExpr(sub, out, ind);
    const folded = this.constNum(e);
    if (folded !== null) return { c: String(folded), ty: NUM };

    if (ts.isNumericLiteral(e)) return { c: e.text, ty: NUM };
    if (e.kind === ts.SyntaxKind.TrueKeyword) return { c: "1", ty: BOOL };
    if (e.kind === ts.SyntaxKind.FalseKeyword) return { c: "0", ty: BOOL };
    if (ts.isStringLiteral(e)) return { c: this.cStrLit(e.text), ty: { k: "strlit" } };

    if (ts.isIdentifier(e)) {
      const b = this.scope.get(e.text);
      if (!b) this.err(e, `unknown identifier: ${e.text}`);
      if (b.kind === "const") {
        if (typeof b.value === "number") return { c: String(b.value), ty: NUM };
        if (typeof b.value === "string") return { c: this.cStrLit(b.value), ty: { k: "strlit" } };
        this.err(e, "string arrays can only be indexed");
      }
      if (b.kind === "local") return { c: b.cName, ty: b.ty };
      this.err(e, `identifier ${e.text} cannot be used as a value here`);
    }

    // name.value reads
    const base = this.valueBase(e);
    if (base) {
      const b = this.scope.get(base);
      if (b?.kind === "ref") {
        this.depRef(b.name);
        if (b.refTy === "num") return { c: `g_${b.name}`, ty: NUM };
        if (b.refTy === "bool") return { c: `g_${b.name}`, ty: BOOL };
        if (b.refTy === "str") return { c: `&g_${b.name}`, ty: { k: "sb" } };
        this.err(e, "list refs can only be used through list operations");
      }
      if (b?.kind === "computed") {
        for (const d of b.deps) this.depRef(d);
        this.ovlCall(`c_${base}_update`);
        if (b.valTy.k === "num") return { c: `c_${base}()`, ty: NUM };
        if (b.valTy.k === "obj") return { c: `c_${base}()`, ty: b.valTy };
        this.err(e, "view computeds can only be used through list operations");
      }
      this.err(e, `.value on non-reactive: ${base}`);
    }

    if (ts.isPropertyAccessExpression(e)) return this.compileMember(e, out, ind);
    if (ts.isElementAccessExpression(e)) return this.compileIndex(e, out, ind);
    if (ts.isCallExpression(e)) return this.compileCall(e, out, ind);

    if (ts.isPrefixUnaryExpression(e)) {
      const v = this.compileExpr(e.operand, out, ind);
      if (e.operator === ts.SyntaxKind.ExclamationToken) return { c: `!${this.truthy(v)}`, ty: BOOL };
      if (e.operator === ts.SyntaxKind.MinusToken) return { c: `(-${v.c})`, ty: NUM };
      this.err(e, "unsupported unary operator");
    }

    if (ts.isBinaryExpression(e)) return this.compileBinary(e, out, ind);

    if (ts.isConditionalExpression(e)) {
      // compile-time condition (SCREEN geometry): pick the branch, drop the
      // other from ROM entirely — the responsive-layout dead branch
      const cf = this.constNum(e.condition) ?? this.constBool(e.condition);
      if (cf !== null) return this.compileExpr(cf ? e.whenTrue : e.whenFalse, out, ind);
      const c = this.compileExpr(e.condition, out, ind);
      const a = this.compileExpr(e.whenTrue, out, ind);
      const b = this.compileExpr(e.whenFalse, out, ind);
      if (a.ty.k !== b.ty.k) this.err(e, `ternary arms differ: ${a.ty.k} vs ${b.ty.k}`);
      return { c: `(${this.truthy(c)} ? ${a.c} : ${b.c})`, ty: a.ty };
    }

    this.err(e, `unsupported expression: ${ts.SyntaxKind[e.kind]}`);
  }

  private compileMember(e: ts.PropertyAccessExpression, out: string[], ind: string): { c: string; ty: Ty } {
    const prop = e.name.text;
    const objExpr = this.unparen(e.expression);

    // <view or list>.length
    if (prop === "length") {
      if (this.isViewExpr(objExpr)) {
        const src = this.viewSource(objExpr, out, ind);
        return { c: `(s32)${src.len}`, ty: NUM };
      }
      const v = this.compileExpr(objExpr, out, ind);
      if (v.ty.k === "sb") return { c: `(s32)(${v.c})->len`, ty: NUM };
      this.err(e, ".length on unsupported value");
    }

    // record field access t.done / t.text
    const v = this.compileExpr(objExpr, out, ind);
    if (v.ty.k === "obj") {
      const iface = this.ifaces.get(v.ty.iface)!;
      const field = iface.fields.find((f) => f.name === prop);
      if (!field) this.err(e, `no field ${prop} on ${v.ty.iface}`);
      this.depRef(v.ty.listRef);
      if (field.ty === "num") return { c: `${v.c}->${prop}`, ty: NUM };
      if (field.ty === "bool") return { c: `${v.c}->${prop}`, ty: BOOL };
      return { c: `&${v.c}->${prop}`, ty: { k: "sb" } };
    }
    this.err(e, `unsupported member access .${prop}`);
  }

  private compileIndex(e: ts.ElementAccessExpression, out: string[], ind: string): { c: string; ty: Ty } {
    const objExpr = this.unparen(e.expression);
    const idx = this.compileExpr(e.argumentExpression, out, ind);

    // const string array / const string indexing
    if (ts.isIdentifier(objExpr)) {
      const b = this.scope.get(objExpr.text);
      if (b?.kind === "const" && Array.isArray(b.value)) {
        return { c: `vp_cstr_at(${this.cStrArray(b.name, b.value)}, ${b.value.length}, ${idx.c})`, ty: { k: "strlit" } };
      }
      if (b?.kind === "const" && typeof b.value === "string") {
        return { c: `vp_char_at(${this.cStrLit(b.value)}, ${b.value.length}, ${idx.c})`, ty: { k: "char" } };
      }
    }

    // view / list indexing -> nullable record pointer
    if (this.isViewExpr(objExpr)) {
      const src = this.viewSource(objExpr, out, ind);
      const listRef = this.viewListRef(objExpr);
      const iface = this.viewIface(objExpr);
      this.depRef(listRef);
      const p = this.tmp("e");
      this.declare(`rec_${iface.toLowerCase()} *${p};`);
      out.push(
        `${ind}${p} = (${idx.c} >= 0 && ${idx.c} < (s32)${src.len}) ? g_${listRef} + (u16)(${src.at(`(u8)(${idx.c})`)}) : 0;`,
      );
      return { c: p, ty: { k: "obj", iface, listRef } };
    }
    this.err(e, "unsupported indexing");
  }

  private cStrArray(name: string, values: string[]): string {
    let cName = this.strArrays.get(name);
    if (!cName) {
      cName = `A_${name}`;
      this.strArrays.set(name, cName);
      const parts = values.map((v) => `"${this.escC(v)}"`).join(", ");
      this.decls.push(`static const char *const ${cName}[${values.length}] = { ${parts} };`);
    }
    return cName;
  }

  private rpgMapArg(e: ts.Expression, callName: string): RpgMapBinding {
    e = this.unparen(e);
    if (!ts.isIdentifier(e)) this.err(e, `${callName} map must be a defineRpgMap module const`);
    const binding = this.scope.get(e.text);
    if (binding?.kind !== "rpgMap") this.err(e, `${callName} map must be a defineRpgMap module const`);
    return binding;
  }

  private compileRpgQuery(
    e: ts.CallExpression,
    out: string[],
    ind: string,
    callName: "rpgBlocked" | "rpgEventAt",
  ): { c: string; ty: Ty } {
    if (this.target.name !== "gba") this.err(e, `${callName} is currently supported only on the gba target`);
    if (e.arguments.length !== 3) this.err(e, `${callName}() takes (map, x, y)`);
    const map = this.rpgMapArg(e.arguments[0], callName);
    const x = this.compileExpr(e.arguments[1], out, ind);
    const y = this.compileExpr(e.arguments[2], out, ind);
    if (x.ty.k !== "num" || y.ty.k !== "num") this.err(e, `${callName} x and y must be numbers`);
    const cName = callName === "rpgBlocked" ? "vp_rpg_blocked" : "vp_rpg_event_at";
    return {
      c: `${cName}(&RPG_${map.name}, ${x.c}, ${y.c})`,
      ty: callName === "rpgBlocked" ? BOOL : NUM,
    };
  }

  private compileCall(e: ts.CallExpression, out: string[], ind: string): { c: string; ty: Ty } {
    const callee = this.unparen(e.expression);
    if (ts.isIdentifier(callee) && callee.text === this.hostRpgBlocked)
      return this.compileRpgQuery(e, out, ind, "rpgBlocked");
    if (ts.isIdentifier(callee) && callee.text === this.hostRpgEventAt)
      return this.compileRpgQuery(e, out, ind, "rpgEventAt");
    // Integer-safe Math subset. Every compiled NUM is s32, so Math.trunc is
    // an identity after C integer division while preserving Vue-oracle parity.
    if (
      ts.isPropertyAccessExpression(callee) &&
      ts.isIdentifier(callee.expression) &&
      callee.expression.text === "Math"
    ) {
      const args = e.arguments.map((a) => this.compileExpr(a, out, ind).c);
      if (callee.name.text === "max") return { c: `vp_max(${args.join(", ")})`, ty: NUM };
      if (callee.name.text === "min") return { c: `vp_min(${args.join(", ")})`, ty: NUM };
      if (callee.name.text === "trunc") {
        if (args.length !== 1) this.err(e, "Math.trunc takes exactly one argument");
        return { c: `(${args[0]})`, ty: NUM };
      }
      this.err(e, `unsupported Math.${callee.name.text}`);
    }
    // list.indexOf(ptr)
    if (ts.isPropertyAccessExpression(callee) && callee.name.text === "indexOf") {
      const listRef = this.viewListRef(callee.expression);
      const arg = this.compileExpr(e.arguments[0], out, ind);
      if (arg.ty.k !== "obj") this.err(e, "indexOf takes a record from the same list");
      this.depRef(listRef);
      return { c: `(s32)(${arg.c} - g_${listRef})`, ty: NUM };
    }
    // setup helper call (statement position handles void fns)
    if (ts.isIdentifier(callee)) {
      const b = this.scope.get(callee.text);
      if (b?.kind === "fn") {
        if (e.arguments.length !== b.params.length)
          this.err(e, `${b.name} takes ${b.params.length} argument(s)`);
        const args = e.arguments.map((a) => {
          const v = this.compileExpr(a, out, ind);
          if (v.ty.k !== "num" && v.ty.k !== "bool") this.err(a, "helper arguments must be numbers");
          return v.c;
        });
        this.emitFn(b);
        for (const d of b.deps) this.depRef(d);
        this.ovlCall(`fn_${b.name}`);
        return { c: `fn_${b.name}(${args.join(", ")})`, ty: { k: "void" } };
      }
    }
    this.err(e, "unsupported call");
  }

  private compileBinary(e: ts.BinaryExpression, out: string[], ind: string): { c: string; ty: Ty } {
    const op = e.operatorToken.kind;
    const K = ts.SyntaxKind;
    if (op === K.AmpersandAmpersandToken || op === K.BarBarToken) {
      const l = this.compileExpr(e.left, out, ind);
      const r = this.compileExpr(e.right, out, ind);
      const cop = op === K.AmpersandAmpersandToken ? "&&" : "||";
      return { c: `(${this.truthy(l)} ${cop} ${this.truthy(r)})`, ty: BOOL };
    }
    const l = this.compileExpr(e.left, out, ind);
    const r = this.compileExpr(e.right, out, ind);
    const table: Partial<Record<ts.SyntaxKind, string>> = {
      [K.PlusToken]: "+",
      [K.MinusToken]: "-",
      [K.AsteriskToken]: "*",
      [K.SlashToken]: "/",
      [K.PercentToken]: "%",
      [K.AmpersandToken]: "&",
      [K.BarToken]: "|",
      [K.LessThanToken]: "<",
      [K.GreaterThanToken]: ">",
      [K.LessThanEqualsToken]: "<=",
      [K.GreaterThanEqualsToken]: ">=",
      [K.EqualsEqualsEqualsToken]: "==",
      [K.ExclamationEqualsEqualsToken]: "!=",
    };
    const cop = table[op];
    if (!cop) this.err(e, `unsupported operator (note: use === / !==)`);
    if (op === K.PlusToken && (l.ty.k === "sb" || l.ty.k === "strlit" || l.ty.k === "char"))
      this.err(e, "string concatenation is only supported as the right side of a string ref assignment");
    const isCmp = [K.LessThanToken, K.GreaterThanToken, K.LessThanEqualsToken, K.GreaterThanEqualsToken, K.EqualsEqualsEqualsToken, K.ExclamationEqualsEqualsToken].includes(op);
    if (isCmp && l.ty.k === "obj" && r.ty.k === "obj") return { c: `(${l.c} ${cop} ${r.c})`, ty: BOOL };
    return { c: `(${l.c} ${cop} ${r.c})`, ty: isCmp ? BOOL : NUM };
  }

  // ---- string-building (str ref assignment RHS) ----------------------------

  private compileStringInto(e: ts.Expression, sb: string, out: string[], ind: string): void {
    e = this.unparen(e);
    if (ts.isBinaryExpression(e) && e.operatorToken.kind === ts.SyntaxKind.PlusToken) {
      this.compileStringInto(e.left, sb, out, ind);
      this.compileStringInto(e.right, sb, out, ind);
      return;
    }
    if (ts.isStringLiteral(e)) {
      if (e.text.length > 0) out.push(`${ind}vp_sb_str(&${sb}, ${this.cStrLit(e.text)});`);
      return;
    }
    if (ts.isCallExpression(e) && ts.isPropertyAccessExpression(e.expression) && e.expression.name.text === "slice") {
      const srcV = this.compileExpr(e.expression.expression, out, ind);
      if (srcV.ty.k !== "sb") this.err(e, ".slice source must be a string ref");
      const a = e.arguments[0] ? this.compileExpr(e.arguments[0], out, ind) : { c: "0", ty: NUM };
      const b = e.arguments[1]
        ? this.compileExpr(e.arguments[1], out, ind)
        : { c: `(s32)(${srcV.c})->len`, ty: NUM };
      const sl = this.allocTemp("sb");
      out.push(`${ind}{ vp_sb_slice(&${sl}, ${srcV.c}, ${a.c}, ${b.c}); vp_sb_sb(&${sb}, &${sl}); }`);
      return;
    }
    const v = this.compileExpr(e, out, ind);
    if (v.ty.k === "sb") out.push(`${ind}vp_sb_sb(&${sb}, ${v.c});`);
    else if (v.ty.k === "strlit") out.push(`${ind}vp_sb_str(&${sb}, ${v.c});`);
    else if (v.ty.k === "char") out.push(`${ind}vp_sb_ch(&${sb}, ${v.c});`);
    else this.err(e, "unsupported piece in string expression");
  }

  // ---- statements (handlers + setup fns) -----------------------------------

  private compileStmt(stmt: ts.Statement, out: string[], ind: string): void {
    if (ts.isReturnStatement(stmt)) {
      if (stmt.expression) this.err(stmt, "handlers cannot return values");
      out.push(`${ind}return;`);
      return;
    }
    if (ts.isIfStatement(stmt)) {
      // decidable condition (SCCP-folded refs, SCREEN geometry): emit only
      // the taken branch — the dead arm leaves ROM and the dep set entirely
      const cf = this.constNum(stmt.expression) ?? this.constBool(stmt.expression);
      if (cf !== null) {
        if (cf) this.compileStmt(stmt.thenStatement, out, ind);
        else if (stmt.elseStatement) this.compileStmt(stmt.elseStatement, out, ind);
        return;
      }
      const cond = this.compileExpr(stmt.expression, out, ind);
      out.push(`${ind}if (${this.condition(cond)}) {`);
      this.compileStmt(stmt.thenStatement, out, ind + "  ");
      if (stmt.elseStatement) {
        out.push(`${ind}} else {`);
        this.compileStmt(stmt.elseStatement, out, ind + "  ");
      }
      out.push(`${ind}}`);
      return;
    }
    if (ts.isBlock(stmt)) {
      const saved = new Map(this.scope);
      for (const s of stmt.statements) this.compileStmt(s, out, ind);
      this.scope = saved;
      return;
    }
    if (ts.isVariableStatement(stmt)) {
      for (const decl of stmt.declarationList.declarations) {
        if (!ts.isIdentifier(decl.name) || !decl.initializer) this.err(decl, "locals need name + initializer");
        const name = decl.name.text;
        const init = decl.initializer;
        const inner: string[] = [];
        const v = this.compileExpr(init, inner, ind);
        out.push(...inner);
        const cName = this.tmp(`l_${name}_`);
        if (v.ty.k === "num") this.declare(`s32 ${cName};`);
        else if (v.ty.k === "bool") this.declare(`u8 ${cName};`);
        else if (v.ty.k === "obj") this.declare(`rec_${v.ty.iface.toLowerCase()} *${cName};`);
        else this.err(decl, `unsupported local type: ${v.ty.k}`);
        out.push(`${ind}${cName} = ${v.c};`);
        this.scope.set(name, { kind: "local", cName, ty: v.ty });
      }
      return;
    }
    if (ts.isForStatement(stmt)) {
      const initDecl = stmt.initializer;
      if (!initDecl || !ts.isVariableDeclarationList(initDecl) || initDecl.declarations.length !== 1)
        this.err(stmt, "for loops need `let i = ...`");
      const d = initDecl.declarations[0];
      if (!ts.isIdentifier(d.name) || !d.initializer) this.err(stmt, "for loops need `let i = <expr>`");
      const cName = this.tmp(`l_${d.name.text}_`);
      const init = this.compileExpr(d.initializer, out, ind);
      const saved = new Map(this.scope);
      this.scope.set(d.name.text, { kind: "local", cName, ty: NUM });
      const cond = stmt.condition ? this.compileExpr(stmt.condition, out, ind) : { c: "1", ty: BOOL };
      const incr = stmt.incrementor ? this.compileIncrement(stmt.incrementor) : "";
      out.push(`${ind}{ s32 ${cName};`);
      out.push(`${ind}for (${cName} = ${init.c}; ${this.condition(cond)}; ${incr}) {`);
      this.compileStmt(stmt.statement, out, ind + "  ");
      out.push(`${ind}} }`);
      this.scope = saved;
      return;
    }
    if (ts.isExpressionStatement(stmt)) {
      this.compileExprStmt(stmt.expression, out, ind);
      return;
    }
    this.err(stmt, `unsupported statement: ${ts.SyntaxKind[stmt.kind]}`);
  }

  private compileIncrement(e: ts.Expression): string {
    e = this.unparen(e);
    if (ts.isPostfixUnaryExpression(e) || ts.isPrefixUnaryExpression(e)) {
      const operand = (e as ts.PostfixUnaryExpression).operand;
      if (ts.isIdentifier(operand)) {
        const b = this.scope.get(operand.text);
        if (b?.kind === "local") {
          const op = e.operator === ts.SyntaxKind.PlusPlusToken ? "++" : "--";
          return `${b.cName}${op}`;
        }
      }
    }
    this.err(e, "for-loop increment must be i++ or i--");
  }

  private compileExprStmt(e: ts.Expression, out: string[], ind: string): void {
    e = this.unparen(e);
    // assignments
    if (ts.isBinaryExpression(e) && e.operatorToken.kind === ts.SyntaxKind.EqualsToken) {
      this.compileAssign(e.left, e.right, out, ind);
      return;
    }
    // push / splice / helper calls
    if (ts.isCallExpression(e)) {
      const callee = this.unparen(e.expression);
      if (ts.isPropertyAccessExpression(callee)) {
        const method = callee.name.text;
        if (method === "push") {
          this.compilePush(callee.expression, e, out, ind);
          return;
        }
        if (method === "splice") {
          this.compileSplice(callee.expression, e, out, ind);
          return;
        }
      }
      if (ts.isIdentifier(callee)) {
        const b = this.scope.get(callee.text);
        if (b?.kind === "fn") {
          const v = this.compileCall(e, out, ind);
          out.push(`${ind}${v.c};`);
          return;
        }
      }
      // keymap dispatch: (cond ? mapA : mapB)[b]?.() or map[b]?.()
      if (ts.isElementAccessExpression(callee)) {
        const table = this.compileKeymapExpr(callee.expression, out, ind);
        if (table) {
          const idx = this.compileExpr(callee.argumentExpression, out, ind);
          const km = this.tmp("km");
          const bi = this.tmp("bi");
          out.push(`${ind}{ void (*const *${km})(void) = ${table}; s32 ${bi} = ${idx.c};`);
          out.push(`${ind}  if (${bi} >= 0 && ${bi} < 10 && ${km}[${bi}]) ${km}[${bi}](); }`);
          return;
        }
      }
    }
    // compound assignment sugar: x.value += e, x.value -= e, ...
    if (ts.isBinaryExpression(e)) {
      const K = ts.SyntaxKind;
      const sugar: Partial<Record<ts.SyntaxKind, ts.BinaryOperator>> = {
        [K.PlusEqualsToken]: K.PlusToken,
        [K.MinusEqualsToken]: K.MinusToken,
        [K.AsteriskEqualsToken]: K.AsteriskToken,
        [K.PercentEqualsToken]: K.PercentToken,
      };
      const op = sugar[e.operatorToken.kind];
      if (op) {
        const rhs = ts.factory.createBinaryExpression(e.left, op, ts.isParenthesizedExpression(e.right) ? e.right : ts.factory.createParenthesizedExpression(e.right));
        this.compileAssign(e.left, rhs, out, ind);
        return;
      }
    }
    // ++ / -- statement sugar
    if (ts.isPostfixUnaryExpression(e) || ts.isPrefixUnaryExpression(e)) {
      const op = e.operator;
      if (op === ts.SyntaxKind.PlusPlusToken || op === ts.SyntaxKind.MinusMinusToken) {
        const one = ts.factory.createNumericLiteral("1");
        const rhs = ts.factory.createBinaryExpression(
          e.operand,
          op === ts.SyntaxKind.PlusPlusToken ? ts.SyntaxKind.PlusToken : ts.SyntaxKind.MinusToken,
          one,
        );
        this.compileAssign(e.operand, rhs, out, ind);
        return;
      }
    }
    this.err(e, "unsupported expression statement");
  }

  private markCode(refName: string): string {
    const b = this.scope.get(refName);
    if (!b || b.kind !== "ref") throw new Error(`mark on non-ref ${refName}`);
    return `vp_mark(${b.index})`;
  }

  private compileAssign(lhs: ts.Expression, rhs: ts.Expression, out: string[], ind: string): void {
    lhs = this.unparen(lhs);
    // ref.value = ...
    const base = this.valueBase(lhs);
    if (base) {
      const b = this.scope.get(base);
      if (b?.kind !== "ref") this.err(lhs, `.value assignment on non-ref ${base}`);
      if (b.refTy === "num" || b.refTy === "bool") {
        const v = this.compileExpr(rhs, out, ind);
        const tmp = this.tmp("nv");
        out.push(`${ind}{ s32 ${tmp} = ${v.c}; if (g_${b.name} != ${tmp}) { g_${b.name} = ${tmp}; ${this.markCode(b.name)}; } }`);
        return;
      }
      if (b.refTy === "str") {
        const tmp = this.allocTemp("sb");
        out.push(`${ind}{ vp_sb_reset(&${tmp});`);
        this.compileStringInto(rhs, tmp, out, ind + "  ");
        out.push(`${ind}  if (vp_sb_assign(&g_${b.name}, &${tmp})) ${this.markCode(b.name)};`);
        out.push(`${ind}}`);
        return;
      }
      // whole-list assignment: todos.value = todos.value.filter(...)
      // Views over one list always carry increasing pool indices (identity
      // -> filter -> slice preserve order), so in-place compaction is safe.
      if (b.refTy === "list") {
        if (!this.isViewExpr(this.unparen(rhs)))
          this.err(rhs, "list refs can only be assigned a filter/slice view");
        if (this.viewListRef(this.unparen(rhs)) !== b.name)
          this.err(rhs, "list assignment must derive from the same list");
        const nv = this.allocTemp("view");
        const k = this.tmp("k");
        out.push(`${ind}{ u8 ${k};`);
        this.compileViewInto(this.unparen(rhs), nv, out, ind + "  ");
        out.push(`${ind}  for (${k} = 0; ${k} < ${nv}.len; ${k}++) *(g_${b.name} + (u16)${k}) = *(g_${b.name} + (u16)(${nv}.idx[${k}]));`);
        out.push(`${ind}  g_${b.name}_len = ${nv}.len;`);
        out.push(`${ind}  ${this.markCode(b.name)}; /* new array identity always triggers */`);
        out.push(`${ind}}`);
        return;
      }
      this.err(lhs, "unsupported ref assignment");
    }
    // t.done = ... (record field write)
    if (ts.isPropertyAccessExpression(lhs)) {
      const obj = this.compileExpr(lhs.expression, out, ind);
      if (obj.ty.k !== "obj") this.err(lhs, "field assignment target must be a record");
      const iface = this.ifaces.get(obj.ty.iface)!;
      const field = iface.fields.find((f) => f.name === lhs.name.text);
      if (!field) this.err(lhs, `no field ${lhs.name.text} on ${obj.ty.iface}`);
      if (field.ty === "str") this.err(lhs, "string field writes only via push");
      const v = this.compileExpr(rhs, out, ind);
      const tmp = this.tmp("fv");
      const cast = field.ty === "bool" ? "(u8)" : "(s32)";
      out.push(
        `${ind}{ ${field.ty === "bool" ? "u8" : "s32"} ${tmp} = ${cast}(${this.truthy(v)}); if (${obj.c}->${lhs.name.text} != ${tmp}) { ${obj.c}->${lhs.name.text} = ${tmp}; ${this.markCode(obj.ty.listRef)}; } }`,
      );
      return;
    }
    this.err(lhs, "unsupported assignment target");
  }

  private compilePush(listExpr: ts.Expression, call: ts.CallExpression, out: string[], ind: string): void {
    const listRef = this.viewListRef(listExpr);
    const b = this.scope.get(listRef);
    if (b?.kind !== "ref" || b.refTy !== "list") this.err(call, "push only on list refs");
    const arg = call.arguments[0];
    if (!arg || !ts.isObjectLiteralExpression(arg)) this.err(call, "push takes an object literal");
    const iface = this.ifaces.get(b.iface!)!;
    out.push(`${ind}if (g_${listRef}_len < ${this.target.poolCap}) {`);
    out.push(`${ind}  rec_${iface.name.toLowerCase()} *np = g_${listRef} + (u16)(g_${listRef}_len++);`);
    for (const propNode of arg.properties) {
      if (!ts.isPropertyAssignment(propNode) || !ts.isIdentifier(propNode.name))
        this.err(propNode, "push object must use `field: value`");
      const field = iface.fields.find((f) => f.name === (propNode.name as ts.Identifier).text);
      if (!field) this.err(propNode, `no field ${propNode.name.getText(this.sf)} on ${iface.name}`);
      if (field.ty === "str") {
        const tmp = this.allocTemp("sb");
        out.push(`${ind}  { vp_sb_reset(&${tmp});`);
        this.compileStringInto(propNode.initializer, tmp, out, ind + "    ");
        out.push(`${ind}    vp_sb_assign(&np->${field.name}, &${tmp}); }`);
      } else {
        const v = this.compileExpr(propNode.initializer, out, ind);
        out.push(`${ind}  np->${field.name} = ${field.ty === "bool" ? this.truthy(v) : v.c};`);
      }
    }
    out.push(`${ind}} else { vp_tripwires |= VP_TRIP_POOL_FULL; }`);
    out.push(`${ind}${this.markCode(listRef)};`);
  }

  private compileSplice(listExpr: ts.Expression, call: ts.CallExpression, out: string[], ind: string): void {
    const listRef = this.viewListRef(listExpr);
    const b = this.scope.get(listRef);
    if (b?.kind !== "ref" || b.refTy !== "list") this.err(call, "splice only on list refs");
    const count = call.arguments[1];
    if (!count || this.constNum(count) !== 1) this.err(call, "only splice(i, 1) is supported");
    const idx = this.compileExpr(call.arguments[0], out, ind);
    const i = this.tmp("i");
    const at = this.tmp("at");
    out.push(`${ind}{ s32 ${at} = ${idx.c}; u8 ${i};`);
    out.push(`${ind}  if (${at} >= 0 && ${at} < (s32)g_${listRef}_len) {`);
    out.push(`${ind}    for (${i} = (u8)${at}; ${i} + 1 < g_${listRef}_len; ${i}++) *(g_${listRef} + (u16)${i}) = *(g_${listRef} + (u16)${i} + 1);`);
    out.push(`${ind}    g_${listRef}_len--;`);
    out.push(`${ind}  }`);
    out.push(`${ind}  ${this.markCode(listRef)};`);
    out.push(`${ind}}`);
  }

  private emitFn(b: FnBinding): void {
    if (b.emitted) return;
    b.emitted = true; // set first: recursion guard
    const prevDeps = this.curDeps;
    this.curDeps = b.deps;
    const saved = new Map(this.scope);
    const { decls, body } = this.withOwner(`fn_${b.name}`, () => this.withHoist((out) => {
      for (const p of b.params) this.scope.set(p, { kind: "local", cName: `p_${p}`, ty: NUM });
      for (const stmt of b.decl.body!.statements) this.compileStmt(stmt, out, "  ");
    }));
    this.scope = saved;
    this.curDeps = prevDeps;
    const sig = b.params.length ? b.params.map((p) => `s32 p_${p}`).join(", ") : "void";
    this.bodies.push(`static void fn_${b.name}(${sig}) {\n${[...decls, ...body].join("\n")}\n}\n`);
  }

  // ---- JSX -> effects -------------------------------------------------------

  private emitTemplate(): {
    inits: string[];
    effects: { name: string; mask: number; span: [number, number] }[];
  } {
    interface Unit {
      span: [number, number];
      deps: Set<string>;
      decls: string[];
      body: string[];
      isStatic: boolean;
      /** The native host owns this unit's backing rows and redraw policy. */
      skipRowClear?: boolean;
    }
    const units: Unit[] = [];

    for (const rawChild of this.template!.children) {
      if (ts.isJsxText(rawChild)) {
        if (rawChild.text.trim() !== "") this.err(rawChild, "stray text at fragment root");
        continue;
      }
      if (ts.isJsxElement(rawChild) || ts.isJsxSelfClosingElement(rawChild)) {
        const tag = ts.isJsxElement(rawChild)
          ? rawChild.openingElement.tagName.getText(this.sf)
          : rawChild.tagName.getText(this.sf);
        if (this.hostRpgScreen && tag === this.hostRpgScreen) units.push(this.compileRpgScreenUnit(rawChild));
        else units.push(this.compileRowUnit(rawChild));
        continue;
      }
      if (ts.isJsxExpression(rawChild)) {
        const expr = rawChild.expression;
        if (!expr) continue;
        const inner = this.unparen(expr);
        if (ts.isConditionalExpression(inner)) {
          units.push(this.compileConditionalUnit(inner));
          continue;
        }
        if (
          ts.isCallExpression(inner) &&
          ts.isPropertyAccessExpression(inner.expression) &&
          inner.expression.name.text === "map"
        ) {
          units.push(this.compileMapUnit(inner));
          continue;
        }
        this.err(rawChild, "fragment children must be <row>, {cond ? <row/> : null}, or {view.map(...)}");
      }
    }

    if (this.rpgScreenCount > 0 && units.length !== 1) {
      this.err(this.template!, "RpgScreen owns the full native display and must be the only root render unit");
    }

    // static rows paint once; overlap with a dynamic span demotes to dynamic
    const dynamic = units.filter((u) => !u.isStatic);
    const overlap = (a: [number, number], b: [number, number]) => a[0] < b[1] && b[0] < a[1];
    for (const u of units) {
      if (u.isStatic && dynamic.some((d) => overlap(d.span, u.span))) u.isStatic = false;
    }

    // merge overlapping dynamic units (document order preserved)
    const merged: Unit[] = [];
    for (const u of units.filter((x) => !x.isStatic)) {
      const hit = merged.find((m) => overlap(m.span, u.span));
      if (hit) {
        hit.span = [Math.min(hit.span[0], u.span[0]), Math.max(hit.span[1], u.span[1])];
        hit.skipRowClear = !!hit.skipRowClear && !!u.skipRowClear;
        for (const d of u.deps) hit.deps.add(d);
        hit.decls.push(...u.decls);
        hit.body.push(...u.body);
      } else {
        merged.push({
          ...u,
          deps: new Set(u.deps),
          decls: [...u.decls],
          body: [...u.body],
          span: [...u.span] as [number, number],
        });
      }
    }
    // re-merge until fixpoint (span growth can create new overlaps)
    let changed = true;
    while (changed) {
      changed = false;
      for (let i = 0; i < merged.length && !changed; i++) {
        for (let j = i + 1; j < merged.length && !changed; j++) {
          if (overlap(merged[i].span, merged[j].span)) {
            merged[i].span = [
              Math.min(merged[i].span[0], merged[j].span[0]),
              Math.max(merged[i].span[1], merged[j].span[1]),
            ];
            merged[i].skipRowClear = !!merged[i].skipRowClear && !!merged[j].skipRowClear;
            for (const d of merged[j].deps) merged[i].deps.add(d);
            merged[i].decls.push(...merged[j].decls);
            merged[i].body.push(...merged[j].body);
            merged.splice(j, 1);
            changed = true;
          }
        }
      }
    }

    const inits: string[] = [];
    for (const u of units.filter((x) => x.isStatic)) inits.push(...u.body);

    const effects: { name: string; mask: number; span: [number, number] }[] = [];
    merged.forEach((u, i) => {
      const name = `eff_${i}`;
      const body = [
        ...u.decls,
        ...(u.skipRowClear ? [] : [`  vp_row_clear(${u.span[0]}, ${u.span[1]});`]),
        ...u.body,
      ];
      this.bodies.push(`static void ${name}(void) {\n${body.join("\n")}\n}\n`);
      effects.push({ name, mask: this.maskOf(u.deps), span: u.span });
    });
    return { inits, effects };
  }

  private rowSrc(el: ts.JsxElement | ts.JsxSelfClosingElement): RowSrc {
    if (ts.isJsxElement(el))
      return {
        tag: el.openingElement.tagName.getText(this.sf),
        attrs: el.openingElement.attributes,
        children: el.children,
        node: el,
      };
    return { tag: el.tagName.getText(this.sf), attrs: el.attributes, children: [], node: el };
  }

  private attrExpr(attr: ts.JsxAttribute): ts.Expression {
    if (attr.initializer && ts.isStringLiteral(attr.initializer)) return attr.initializer;
    if (attr.initializer && ts.isJsxExpression(attr.initializer) && attr.initializer.expression)
      return attr.initializer.expression;
    this.err(attr, `attribute ${attr.name.getText(this.sf)} must be {expr} or "string"`);
  }

  /**
   * Resolve a renderable JSX element: an intrinsic <row>, or a component
   * use inlined — props collected here, the returned ctx made active while
   * the component's body <row> compiles.
   */
  private resolveRenderable(el: ts.JsxElement | ts.JsxSelfClosingElement): {
    src: RowSrc;
    ctx: PropsCtx | null;
  } {
    const use = this.rowSrc(el);
    if (use.tag === "row") return { src: use, ctx: null };
    const b = this.scope.get(use.tag);
    if (b?.kind !== "component")
      this.err(el, `unknown element <${use.tag}> (only <row> and declared components)`);
    if (this.propsCtx) this.err(el, "components cannot render other components (v1)");
    const exprs = new Map<string, ts.Expression>();
    for (const attr of use.attrs.properties) {
      if (!ts.isJsxAttribute(attr)) this.err(attr, "spread props are not supported");
      const name = attr.name.getText(this.sf);
      if (!b.props.has(name)) this.err(attr, `unknown prop ${name} on <${b.name}>`);
      exprs.set(name, this.attrExpr(attr));
    }
    for (const p of b.props.keys())
      if (!exprs.has(p)) this.err(el, `missing prop ${p} on <${b.name}>`);
    return {
      src: this.rowSrc(b.body),
      ctx: { param: b.propsParam, exprs, component: b.name },
    };
  }

  private jsxAttr(src: RowSrc, name: string): ts.Expression | undefined {
    for (const attr of src.attrs.properties) {
      if (ts.isJsxAttribute(attr) && attr.name.getText(this.sf) === name) return this.attrExpr(attr);
    }
    return undefined;
  }

  /** Compile one <row> paint (dynamic y allowed for map rows). */
  /** Resolve a row's class attribute to C expressions for (pair id, align).
   *  Literals resolve through the style table; conditionals must be
   *  ternaries of literals (the same constitution the big framework's
   *  tailwind pipeline enforces), so every look is compile-time data. */
  private resolveClassExpr(
    e: ts.Expression | undefined,
    out: string[],
    ind: string,
    at: ts.Node,
  ): { palC: string; alignC: string } {
    if (!e) return { palC: "0", alignC: "0" };
    let expr = this.unparen(e);
    const sub = this.substProp(expr);
    if (sub) expr = this.unparen(sub);
    if (ts.isStringLiteral(expr)) {
      const { id, align, issues } = this.styleTable.resolveClass(expr.text);
      for (const issue of issues) this.styleIssue(expr, issue);
      return { palC: String(id), alignC: String(align) };
    }
    if (ts.isConditionalExpression(expr)) {
      const cf = this.constNum(expr.condition) ?? this.constBool(expr.condition);
      if (cf !== null) return this.resolveClassExpr(cf ? expr.whenTrue : expr.whenFalse, out, ind, at);
      const cond = this.compileExpr(expr.condition, out, ind);
      const a = this.resolveClassExpr(expr.whenTrue, out, ind, at);
      const b = this.resolveClassExpr(expr.whenFalse, out, ind, at);
      return {
        palC: `(${this.truthy(cond)} ? ${a.palC} : ${b.palC})`,
        alignC: a.alignC === b.alignC ? a.alignC : `(${this.truthy(cond)} ? ${a.alignC} : ${b.alignC})`,
      };
    }
    this.err(at, 'VS105: dynamic class must be a string literal or a ternary of full literals');
  }

  private compileRowPaint(
    el: RowSrc,
    yC: string,
    out: string[],
    ind: string,
  ): void {
    const xExpr = this.jsxAttr(el, "x");
    if (this.jsxAttr(el, "pal") !== undefined)
      this.err(el.node, 'the pal attribute is gone — declare the look with class="bg-* text-* align-*"');
    const x = xExpr ? this.constNum(xExpr) : 0;
    if (x === null) this.err(el.node, "row x must be compile-time constant");
    const cls = this.resolveClassExpr(this.jsxAttr(el, "class"), out, ind, el.node);
    out.push(`${ind}vp_ln_reset();`);
    for (const child of el.children) {
      if (ts.isJsxText(child)) {
        const text = child.text.replace(/\s*\n\s*/g, "");
        if (text) out.push(`${ind}vp_ln_str(${this.cStrLit(text)});`);
        continue;
      }
      if (ts.isJsxExpression(child)) {
        if (!child.expression) continue;
        const v = this.compileExpr(child.expression, out, ind);
        if (v.ty.k === "strlit") out.push(`${ind}vp_ln_str(${v.c});`);
        else if (v.ty.k === "sb") out.push(`${ind}vp_ln_sb(${v.c});`);
        else if (v.ty.k === "char") out.push(`${ind}vp_ln_ch(${v.c});`);
        else if (v.ty.k === "num") out.push(`${ind}vp_ln_int(${v.c});`);
        else this.err(child, `cannot interpolate a ${v.ty.k} into a row`);
        continue;
      }
      this.err(child, "rows may contain only text and {expr} interpolations");
    }
    out.push(`${ind}vp_ln_commit(${yC}, ${x}, (u8)(${cls.palC}), (u8)(${cls.alignC}));`);
  }

  private rowConstY(src: RowSrc): number {
    const yExpr = this.jsxAttr(src, "y");
    if (!yExpr) this.err(src.node, "row needs a y attribute");
    const y = this.constNum(yExpr);
    if (y === null) this.err(src.node, "row y must be compile-time constant here");
    if (y < 0 || y >= this.target.height) this.err(src.node, `row y out of range: ${y}`);
    return y;
  }

  private compileRowUnit(el: ts.JsxElement | ts.JsxSelfClosingElement): {
    span: [number, number];
    deps: Set<string>;
    decls: string[];
    body: string[];
    isStatic: boolean;
  } {
    const { src, ctx } = this.resolveRenderable(el);
    const prevCtx = this.propsCtx;
    this.propsCtx = ctx ?? prevCtx;
    const y = this.rowConstY(src);
    const deps = new Set<string>();
    const prev = this.curDeps;
    this.curDeps = deps;
    // each unit is its own overlay owner: merged units run sequentially
    // inside one effect, so their temps may share slots
    const { decls, body } = this.withOwner(`unit${this.unitCounter++}`, () =>
      this.withHoist((out) => {
        this.compileRowPaint(src, String(y), out, "  ");
      }),
    );
    this.curDeps = prev;
    this.propsCtx = prevCtx;
    return { span: [y, y + 1], deps, decls, body, isStatic: deps.size === 0 };
  }

  private compileConditionalUnit(e: ts.ConditionalExpression): {
    span: [number, number];
    deps: Set<string>;
    decls: string[];
    body: string[];
    isStatic: boolean;
  } {
    const whenTrue = this.unparen(e.whenTrue);
    if (
      (!ts.isJsxElement(whenTrue) && !ts.isJsxSelfClosingElement(whenTrue)) ||
      e.whenFalse.kind !== ts.SyntaxKind.NullKeyword
    )
      this.err(e, "conditional children must be {cond ? <row/> : null}");
    // decidable condition: the row is unconditionally present (a plain row
    // unit, static if its paint has no deps) or not present at all
    const cf = this.constNum(e.condition) ?? this.constBool(e.condition);
    if (cf !== null) {
      if (cf) return this.compileRowUnit(whenTrue);
      return { span: [0, 0], deps: new Set(), decls: [], body: [], isStatic: true };
    }
    const deps = new Set<string>();
    const prev = this.curDeps;
    this.curDeps = deps;
    let y = 0;
    const { decls, body } = this.withOwner(`unit${this.unitCounter++}`, () => this.withHoist((out) => {
      const cond = this.compileExpr(e.condition, out, "  ");
      const { src, ctx } = this.resolveRenderable(whenTrue);
      const prevCtx = this.propsCtx;
      this.propsCtx = ctx ?? prevCtx;
      y = this.rowConstY(src);
      out.push(`  if (${this.condition(cond)}) {`);
      this.compileRowPaint(src, String(y), out, "    ");
      out.push(`  }`);
      this.propsCtx = prevCtx;
    }));
    this.curDeps = prev;
    return { span: [y, y + 1], deps, decls, body, isStatic: false };
  }

  private compileRpgScreenUnit(el: ts.JsxElement | ts.JsxSelfClosingElement): {
    span: [number, number];
    deps: Set<string>;
    decls: string[];
    body: string[];
    isStatic: boolean;
    skipRowClear: boolean;
  } {
    if (this.target.name !== "gba") this.err(el, "RpgScreen is currently supported only on the gba target");
    if (!ts.isJsxSelfClosingElement(el)) this.err(el, "RpgScreen must be a self-closing element");
    if (this.rpgScreenCount > 0) this.err(el, "only one RpgScreen is supported per component");
    this.rpgScreenCount++;

    const required = [
      "map",
      "mode",
      "playerX",
      "playerY",
      "playerOffsetX",
      "playerOffsetY",
      "facing",
      "playerFrame",
      "quest",
      "dialog",
      "choice",
      "heroHp",
      "enemyHp",
      "battleCursor",
    ] as const;
    type RpgScreenProp = (typeof required)[number];
    const attrs = new Map<RpgScreenProp, ts.Expression>();
    for (const prop of el.attributes.properties) {
      if (!ts.isJsxAttribute(prop)) this.err(prop, "RpgScreen does not support spread props");
      const name = prop.name.getText(this.sf);
      if (!(required as readonly string[]).includes(name))
        this.err(prop, `unknown RpgScreen prop ${JSON.stringify(name)}; expected exactly ${required.join(", ")}`);
      const typedName = name as RpgScreenProp;
      if (attrs.has(typedName)) this.err(prop, `duplicate RpgScreen prop ${JSON.stringify(name)}`);
      attrs.set(typedName, this.attrExpr(prop));
    }
    for (const name of required)
      if (!attrs.has(name)) this.err(el, `RpgScreen is missing required prop ${JSON.stringify(name)}`);

    const map = this.rpgMapArg(attrs.get("map")!, "RpgScreen");
    const deps = new Set<string>();
    const prev = this.curDeps;
    this.curDeps = deps;
    const { decls, body } = this.withOwner(`unit${this.unitCounter++}`, () => this.withHoist((out) => {
      const readNumber = (name: Exclude<RpgScreenProp, "map">): { c: string; ty: Ty } => {
        const value = this.compileExpr(attrs.get(name)!, out, "  ");
        if (value.ty.k !== "num") this.err(attrs.get(name)!, `RpgScreen ${name} must be a number`);
        return value;
      };
      const mode = readNumber("mode");
      const playerX = readNumber("playerX");
      const playerY = readNumber("playerY");
      const playerOffsetX = readNumber("playerOffsetX");
      const playerOffsetY = readNumber("playerOffsetY");
      const facing = readNumber("facing");
      const playerFrame = readNumber("playerFrame");
      const quest = readNumber("quest");
      const dialog = readNumber("dialog");
      const choice = readNumber("choice");
      const heroHp = readNumber("heroHp");
      const enemyHp = readNumber("enemyHp");
      const battleCursor = readNumber("battleCursor");
      out.push(
        `  vp_rpg_render(&RPG_${map.name}, (u8)(${mode.c}), ${playerX.c}, ${playerY.c}, ` +
          `${playerOffsetX.c}, ${playerOffsetY.c}, (u8)(${facing.c}), (u8)(${playerFrame.c}), ` +
          `${quest.c}, ${dialog.c}, ${choice.c}, ${heroHp.c}, ${enemyHp.c}, ${battleCursor.c});`,
      );
    }));
    this.curDeps = prev;
    /* The RPG host maintains BG0 UI incrementally. Clearing the full character
     * grid before every movement effect would erase the cached fixed HUD. */
    return {
      span: [0, this.target.height],
      deps,
      decls,
      body,
      isStatic: false,
      skipRowClear: true,
    };
  }

  private compileMapUnit(call: ts.CallExpression): {
    span: [number, number];
    deps: Set<string>;
    decls: string[];
    body: string[];
    isStatic: boolean;
  } {
    const viewExpr = (call.expression as ts.PropertyAccessExpression).expression;
    if (!this.isViewExpr(viewExpr)) this.err(call, ".map is only supported on list views");
    const arrow = call.arguments[0];
    if (!arrow || !ts.isArrowFunction(arrow)) this.err(call, ".map takes an arrow");
    const rowJsx = this.unparen(arrow.body as ts.Expression);
    if (!ts.isJsxElement(rowJsx) && !ts.isJsxSelfClosingElement(rowJsx))
      this.err(call, ".map arrow must return a <row> or a component");
    const [itemParam, indexParam] = arrow.parameters.map((p) => p.name.getText(this.sf));
    if (!itemParam || !indexParam) this.err(arrow, ".map arrow needs (item, index) params");

    const deps = new Set<string>();
    const prev = this.curDeps;
    this.curDeps = deps;
    let yBase = 0;
    let maxLenOut = 0;
    const { decls, body } = this.withOwner(`unit${this.unitCounter++}`, () => this.withHoist((body) => {
    const src = this.viewSource(viewExpr, body, "  ");
    const listRef = this.viewListRef(viewExpr);
    const iface = this.viewIface(viewExpr);
    const maxLen = this.viewMaxLen(viewExpr);
    const iV = this.tmp("i");
    const pV = this.tmp("t");
    body.push(`  { u8 ${iV};`);
    body.push(`  for (${iV} = 0; ${iV} < ${src.len}; ${iV}++) {`);
    body.push(`    rec_${iface.toLowerCase()} *${pV} = g_${listRef} + (u16)(${src.at(iV)});`);

    const saved = new Map(this.scope);
    this.scope.set(itemParam, { kind: "local", cName: pV, ty: { k: "obj", iface, listRef } });
    this.scope.set(indexParam, { kind: "local", cName: `(s32)${iV}`, ty: NUM });
    const { src: rowSrc, ctx } = this.resolveRenderable(rowJsx);
    const prevCtx = this.propsCtx;
    this.propsCtx = ctx ?? prevCtx;
    const yExpr = this.jsxAttr(rowSrc, "y");
    if (!yExpr) this.err(rowSrc.node, "row needs y");
    // span: y = base + i requires resolving the base constant (through props)
    const yBaseInner = this.mapYBase(yExpr, indexParam);
    const yV = this.compileExpr(yExpr, body, "    ");
    const yTmp = this.tmp("y");
    body.push(`    { u8 ${yTmp} = (u8)(${yV.c});`);
    body.push(`    if (${yTmp} < ${this.target.height}) {`);
    this.compileRowPaint(rowSrc, yTmp, body, "      ");
    body.push(`    } }`);
    this.propsCtx = prevCtx;
    this.scope = saved;
    body.push(`  } }`);
    yBase = yBaseInner;
    maxLenOut = maxLen;
    }));
    this.curDeps = prev;

    const span: [number, number] = [yBase, Math.min(this.target.height, yBase + maxLenOut)];
    return { span, deps, decls, body, isStatic: false };
  }

  /** y must be `i` or `CONST + i` / `i + CONST` inside a map row. */
  private mapYBase(yExpr: ts.Expression, indexParam: string): number {
    let e = this.unparen(yExpr);
    const sub = this.substProp(e);
    if (sub) e = this.unparen(sub);
    if (ts.isIdentifier(e) && e.text === indexParam) return 0;
    if (ts.isBinaryExpression(e) && e.operatorToken.kind === ts.SyntaxKind.PlusToken) {
      const l = this.constNum(e.left);
      const r = this.constNum(e.right);
      if (l !== null && ts.isIdentifier(e.right) && e.right.text === indexParam) return l;
      if (r !== null && ts.isIdentifier(e.left) && e.left.text === indexParam) return r;
    }
    this.err(yExpr, "map row y must be `i` or `CONST + i`");
  }

  private emitRpgData(): string {
    const out: string[] = [];
    for (const map of this.rpgMaps) {
      const prefix = `RPG_${map.name}`;
      const tiles = map.rows.join("");
      const solidSet = new Set(map.solid.split(""));
      const solidMask = tiles.split("").map((tile) => (solidSet.has(tile) ? 1 : 0));
      out.push(`static const u8 ${prefix}_tiles[] = "${this.escC(tiles)}";`);
      out.push(`static const u8 ${prefix}_solid[${solidMask.length}] = { ${solidMask.join(", ")} };`);

      if (map.events.length > 0) {
        out.push(
          `static const vp_rpg_event ${prefix}_events[${map.events.length}] = { ${map.events
            .map((event) => `{ ${event.tile}, ${event.event} }`)
            .join(", ")} };`,
        );
      } else {
        out.push(`static const vp_rpg_event ${prefix}_events[1] = { { 0, 0 } };`);
      }

      if (map.dialogs.length > 0) {
        out.push(
          `static const vp_rpg_dialog ${prefix}_dialogs[${map.dialogs.length}] = { ${map.dialogs
            .map(
              (dialog) =>
                `{ ${this.cStrLit(dialog.speaker)}, ${this.cStrLit(dialog.line1)}, ${this.cStrLit(dialog.line2)}, ` +
                `${this.cStrLit(dialog.choice0)}, ${this.cStrLit(dialog.choice1)} }`,
            )
            .join(", ")} };`,
        );
      } else {
        out.push(`static const vp_rpg_dialog ${prefix}_dialogs[1] = { { 0, 0, 0, 0, 0 } };`);
      }

      out.push(
        `static const vp_rpg_map ${prefix} = { ${map.width}, ${map.height}, ${prefix}_tiles, ${prefix}_solid, ` +
          `${prefix}_events, ${map.events.length}, ${prefix}_dialogs, ${map.dialogs.length} };`,
      );
    }
    return out.join("\n");
  }

  // ---- final emission -------------------------------------------------------

  private emit(): CompiledApp {
    // handler
    if (!this.handler) this.err(this.sf, "component must register onButton");
    let handlerOut: string[] = [];
    {
      const saved = new Map(this.scope);
      const param = this.handler.parameters[0]?.name.getText(this.sf);
      if (!param) this.err(this.handler, "onButton arrow needs a (b) param");
      this.scope.set(param, { kind: "local", cName: "b_arg", ty: NUM });
      const handlerArrow = this.handler;
      const { decls, body } = this.withOwner("app_on_button", () => this.withHoist((out) => {
        if (ts.isBlock(handlerArrow.body)) {
          for (const stmt of handlerArrow.body.statements) this.compileStmt(stmt, out, "  ");
        } else {
          this.compileExprStmt(handlerArrow.body, out, "  ");
        }
      }));
      handlerOut = [...decls, ...body];
      this.scope = saved;
    }

    let repeatHandlerOut: string[] = [];
    if (this.repeatHandler) {
      const saved = new Map(this.scope);
      const param = this.repeatHandler.parameters[0]?.name.getText(this.sf);
      if (!param) this.err(this.repeatHandler, "onButtonRepeat arrow needs a (b) param");
      this.scope.set(param, { kind: "local", cName: "b_arg", ty: NUM });
      const repeatHandlerArrow = this.repeatHandler;
      const { decls, body } = this.withOwner("app_on_button_repeat", () => this.withHoist((out) => {
        if (ts.isBlock(repeatHandlerArrow.body)) {
          for (const stmt of repeatHandlerArrow.body.statements) this.compileStmt(stmt, out, "  ");
        } else {
          this.compileExprStmt(repeatHandlerArrow.body, out, "  ");
        }
      }));
      repeatHandlerOut = [...decls, ...body];
      this.scope = saved;
    }

    let frameHandlerOut: string[] = [];
    if (this.frameHandler) {
      const saved = new Map(this.scope);
      const parameter = this.frameHandler.parameters[0];
      if (parameter) {
        if (!ts.isIdentifier(parameter.name))
          this.err(this.frameHandler, "onFrame arrow needs a simple buttons parameter");
        this.scope.set(parameter.name.text, {
          kind: "local",
          cName: "buttons_arg",
          ty: NUM,
        });
      }
      const frameHandlerArrow = this.frameHandler;
      const { decls, body } = this.withOwner("app_on_frame", () => this.withHoist((out) => {
        if (ts.isBlock(frameHandlerArrow.body)) {
          for (const stmt of frameHandlerArrow.body.statements) this.compileStmt(stmt, out, "  ");
        } else {
          this.compileExprStmt(frameHandlerArrow.body, out, "  ");
        }
      }));
      frameHandlerOut = [...decls, ...body];
      this.scope = saved;
    }

    const axisHandlerFns: string[] = [];
    const axisHandlerCases: string[] = [];
    for (const [axis, handler] of [...this.axisHandlers].sort(([a], [b]) => a - b)) {
      const saved = new Map(this.scope);
      const parameter = handler.parameters[0];
      if (!parameter || !ts.isIdentifier(parameter.name))
        this.err(handler, "onAxisDelta arrow needs a simple delta parameter");
      this.scope.set(parameter.name.text, {
        kind: "local",
        cName: "axis_delta_arg",
        ty: NUM,
      });
      const { decls, body } = this.withOwner(`vp_axis_handler_${axis}`, () => this.withHoist((out) => {
        if (ts.isBlock(handler.body)) {
          for (const stmt of handler.body.statements) this.compileStmt(stmt, out, "  ");
        } else {
          this.compileExprStmt(handler.body, out, "  ");
        }
      }));
      axisHandlerFns.push(
        `static void vp_axis_handler_${axis}(s32 axis_delta_arg) {\n${[...decls, ...body].join("\n")}\n}`,
      );
      axisHandlerCases.push(`    case ${axis}: vp_axis_handler_${axis}(delta); break;`);
      this.scope = saved;
    }

    const { inits, effects } = this.emitTemplate();
    // Collect RPG dialogue literals before the shared string table is emitted.
    const rpgData = this.emitRpgData();

    // seed + init
    const initOut: string[] = [];
    for (const ref of this.refs) {
      if (ref.refTy === "num") initOut.push(`  g_${ref.name} = ${this.constNum(ref.seed) ?? 0};`);
      else if (ref.refTy === "bool")
        initOut.push(`  g_${ref.name} = ${ref.seed.kind === ts.SyntaxKind.TrueKeyword ? 1 : 0};`);
      else if (ref.refTy === "str") {
        const text = (ref.seed as ts.StringLiteral).text;
        initOut.push(`  vp_sb_reset(&g_${ref.name});`);
        if (text) initOut.push(`  vp_sb_str(&g_${ref.name}, ${this.cStrLit(text)});`);
      } else {
        const arr = ref.seed as ts.ArrayLiteralExpression;
        const iface = this.ifaces.get(ref.iface!)!;
        if (arr.elements.length > this.target.poolCap) this.err(arr, `seed exceeds pool capacity ${this.target.poolCap}`);
        initOut.push(`  g_${ref.name}_len = ${arr.elements.length};`);
        arr.elements.forEach((el, i) => {
          if (!ts.isObjectLiteralExpression(el)) this.err(el, "list seeds are object literals");
          for (const propNode of el.properties) {
            if (!ts.isPropertyAssignment(propNode) || !ts.isIdentifier(propNode.name))
              this.err(propNode, "seed fields are `name: literal`");
            const field = iface.fields.find((f) => f.name === (propNode.name as ts.Identifier).text)!;
            if (field.ty === "str") {
              const text = (propNode.initializer as ts.StringLiteral).text;
              initOut.push(`  vp_sb_reset(&g_${ref.name}[${i}].${field.name});`);
              if (text) initOut.push(`  vp_sb_str(&g_${ref.name}[${i}].${field.name}, ${this.cStrLit(text)});`);
            } else {
              const v =
                propNode.initializer.kind === ts.SyntaxKind.TrueKeyword
                  ? 1
                  : propNode.initializer.kind === ts.SyntaxKind.FalseKeyword
                    ? 0
                    : (this.constNum(propNode.initializer) ?? 0);
              initOut.push(`  g_${ref.name}[${i}].${field.name} = ${v};`);
            }
          }
        });
      }
    }

    // per-ref computed invalidation masks
    const cInval = this.refs.map((r) => {
      let mask = 0;
      for (const c of this.computeds) if (c.deps.has(r.name)) mask |= 1 << c.index;
      return mask;
    });

    // debug layout
    const debugSlots: DebugSlot[] = [];
    let dbgOff = 0;
    const dbgOut: string[] = [];
    for (const ref of this.refs) {
      if (ref.refTy === "num" || ref.refTy === "bool") {
        dbgOut.push(`  *(volatile s32 *)(out + ${dbgOff}) = (s32)g_${ref.name};`);
        debugSlots.push({ name: ref.name, offset: dbgOff, size: 4, kind: ref.refTy === "num" ? "num" : "bool" });
        dbgOff += 4;
      } else if (ref.refTy === "str") {
        dbgOut.push(`  out[${dbgOff}] = g_${ref.name}.len;`);
        dbgOut.push(`  { u8 i; for (i = 0; i < VP_STR_CAP; i++) out[${dbgOff} + 1 + i] = (u8)g_${ref.name}.b[i]; }`);
        debugSlots.push({ name: ref.name, offset: dbgOff, size: 1 + this.target.strCap, kind: "str" });
        dbgOff += 1 + this.target.strCap;
        dbgOff = (dbgOff + 3) & ~3;
      } else {
        dbgOut.push(`  *(volatile s32 *)(out + ${dbgOff}) = (s32)g_${ref.name}_len;`);
        debugSlots.push({ name: ref.name, offset: dbgOff, size: 4, kind: "listLen" });
        dbgOff += 4;
      }
    }

    // ---- overlay slot coloring (all bodies are emitted by now) ----
    const ovl = this.ovlAssign();
    if (ovl.decls.length) this.decls.push(...ovl.decls);

    // ---- assemble C ----
    const c: string[] = [];
    c.push("/* gen_app.c — GENERATED by vapor/compiler/compile.ts. DO NOT EDIT. */");
    c.push(`/* target: ${this.target.name} (${this.target.width}x${this.target.height}) */`);
    c.push(`#define VP_GRID_W ${this.target.width}`);
    c.push(`#define VP_GRID_H ${this.target.height}`);
    c.push(`#define VP_STR_CAP ${this.target.strCap}`);
    c.push(`#define VP_VIEW_CAP ${this.target.poolCap}`);
    c.push('#include "vapor.h"');
    c.push("");
    c.push("#if defined(__GNUC__)");
    c.push("#define VP_UNUSED_FN __attribute__((unused))");
    c.push("#else");
    c.push("#define VP_UNUSED_FN");
    c.push("#endif");
    c.push("static inline s32 VP_UNUSED_FN vp_max(s32 a, s32 b) { return a > b ? a : b; }");
    c.push("static inline s32 VP_UNUSED_FN vp_min(s32 a, s32 b) { return a < b ? a : b; }");
    c.push(
      "static inline const char *VP_UNUSED_FN vp_cstr_at(const char *const *arr, s32 n, s32 i) { return (i >= 0 && i < n) ? arr[i] : (const char *)\"\"; }",
    );
    c.push("static inline char VP_UNUSED_FN vp_char_at(const char *s, s32 n, s32 i) { return (i >= 0 && i < n) ? s[i] : ' '; }");
    c.push(`const u8 vp_rpg_enabled = ${this.rpgMaps.length > 0 ? 1 : 0};`);
    c.push("");

    // record structs
    for (const iface of this.ifaces.values()) {
      const fields = iface.fields
        .map((f) => (f.ty === "str" ? `vp_sb ${f.name};` : f.ty === "bool" ? `u8 ${f.name};` : `s32 ${f.name};`))
        .join(" ");
      c.push(`typedef struct { ${fields} } rec_${iface.name.toLowerCase()};`);
    }
    c.push("");

    // state
    for (const ref of this.refs) {
      if (ref.refTy === "num") c.push(`static s32 g_${ref.name};`);
      else if (ref.refTy === "bool") c.push(`static s32 g_${ref.name};`);
      else if (ref.refTy === "str") c.push(`static vp_sb g_${ref.name};`);
      else c.push(`static rec_${ref.iface!.toLowerCase()} g_${ref.name}[${this.target.poolCap}]; static u8 g_${ref.name}_len;`);
    }
    c.push("static u32 vp_dirty; static u32 c_valid;");
    c.push(`static const u32 C_INVAL[${Math.max(1, cInval.length)}] = { ${cInval.map((m) => `0x${m.toString(16)}u`).join(", ") || "0"} };`);
    c.push("static void vp_mark(u8 refIdx) { vp_dirty |= vp_bit32[refIdx]; c_valid &= ~C_INVAL[refIdx]; }");
    c.push("");

    // string literals
    for (const [text, name] of this.strLits) c.push(`static const char ${name}[] = "${this.escC(text)}";`);
    c.push("");
    if (rpgData) {
      c.push(rpgData);
      c.push("");
    }
    c.push(this.decls.join("\n"));
    c.push("");
    c.push(this.bodies.join("\n"));

    // keymap fnptr tables (ROM), indexed by GBA key bit
    for (const km of this.keymaps) {
      const slots = Array.from({ length: 10 }, (_, i) => km.entries.get(i) ?? "0");
      c.push(`static void (*const KM_${km.name}[10])(void) = { ${slots.join(", ")} };`);
    }
    c.push("");

    // handler
    c.push(`void app_on_button(u8 b) {\n  s32 b_arg = (s32)b;\n${handlerOut.join("\n")}\n}\n`);
    if (this.frameHandler) {
      c.push(
        `void app_on_frame(u32 buttons) {\n  s32 buttons_arg = (s32)buttons;\n${frameHandlerOut.join("\n")}\n}\n`,
      );
    } else {
      c.push("void app_on_frame(u32 buttons) {\n  (void)buttons;\n}\n");
    }
    if (this.target.name === "gba") {
      if (this.repeatHandler) {
        c.push(
          `void app_on_button_repeat(u8 b) {\n  s32 b_arg = (s32)b;\n${repeatHandlerOut.join("\n")}\n}\n`,
        );
      } else {
        c.push("void app_on_button_repeat(u8 b) {\n  (void)b;\n}\n");
      }
    }
    c.push(axisHandlerFns.join("\n\n"));
    if (axisHandlerCases.length > 0) {
      c.push(
        `void app_on_axis_delta(u8 axis, s32 delta) {\n  switch (axis) {\n${axisHandlerCases.join(
          "\n",
        )}\n    default: break;\n  }\n}\n`,
      );
    } else {
      c.push(
        "void app_on_axis_delta(u8 axis, s32 delta) {\n  (void)axis;\n  (void)delta;\n}\n",
      );
    }

    // flush
    const flush: string[] = [];
    flush.push("u8 app_flush(void) {");
    flush.push("  if (!vp_dirty) return 0;");
    for (const eff of effects) flush.push(`  if (vp_dirty & 0x${eff.mask.toString(16)}u) ${eff.name}();`);
    flush.push("  vp_dirty = 0;");
    flush.push("  return 1;");
    flush.push("}");
    c.push(flush.join("\n"));
    c.push("");

    // init
    const init: string[] = [];
    init.push("void app_init(void) {");
    init.push(...initOut);
    init.push("  vp_dirty = 0; c_valid = 0;");
    init.push(...inits.map((line) => line));
    for (const eff of effects) init.push(`  ${eff.name}();`);
    init.push("}");
    c.push(init.join("\n"));
    c.push("");

    // debug
    c.push(`u16 app_debug_state(volatile u8 *out) {\n${dbgOut.join("\n")}\n  return ${dbgOff};\n}`);
    c.push("");

    // generated data: font, palettes, title
    {
      const lowered = this.styleTable.lower(this.target.name, this.options.strict);
      for (const issue of lowered.issues) {
        const text = `${this.sf.fileName} — ${issue.code}: ${issue.message}`;
        if (issue.severity === "error" || (this.options.strict && issue.severity === "warn"))
          this.styleErrors.push(text);
        else this.styleWarnings.push(text);
      }
    }
    if (this.styleErrors.length > 0) {
      throw new Error(this.styleErrors.join("\n"));
    }
    c.push(emitTargetData(this.target, this.styleTable));
    c.push(`const char vp_app_title[] = "${this.escC(this.title)}";`);
    c.push("");

    // ---- reports ----
    const graphLines: string[] = [];
    if (this.rpgMaps.length > 0) {
      graphLines.push("rpg maps:");
      for (const map of this.rpgMaps)
        graphLines.push(
          `  ${map.name}: ${map.width}x${map.height}, ${map.events.length} event keys, ${map.dialogs.length} dialogs`,
        );
      graphLines.push(`rpg screen effects: ${this.rpgScreenCount} full-screen runtime effect(s)`);
    }
    graphLines.push("refs:");
    for (const r of this.refs) {
      const folded = this.sccpFolded?.has(r.name)
        ? ` = const ${this.sccpFolded.get(r.name)} (sccp: reads folded, never dirty)`
        : "";
      graphLines.push(`  bit ${r.index}: ${r.name} (${r.refTy})${folded}`);
    }
    graphLines.push("computeds:");
    for (const comp of this.computeds)
      graphLines.push(
        `  ${comp.name}: ${comp.valTy.k}${comp.valTy.k === "view" ? `(maxLen ${comp.maxLen})` : ""} <- {${[...comp.deps].join(", ")}}`,
      );
    graphLines.push("effects:");
    effects.forEach((eff) =>
      graphLines.push(
        `  ${eff.name}: rows [${eff.span[0]}, ${eff.span[1]}) mask 0x${eff.mask.toString(16)} {${this.refs
          .filter((r) => eff.mask & (1 << r.index))
          .map((r) => r.name)
          .join(", ")}}`,
      ),
    );
    graphLines.push("inputs:");
    graphLines.push(
      `  buttons: ${
        [...this.buttonsUsed]
          .sort((a, b) => a - b)
          .map((button) => BUTTON_NAMES[button] ?? String(button))
          .join(", ") || "none"
      }`,
    );
    graphLines.push(`  frame hook: ${this.frameHandler ? "fixed (gba)" : "none"}`);
    graphLines.push(`  button repeats: ${this.repeatHandler ? "directional (gba)" : "none"}`);
    graphLines.push(
      `  relative axes: ${
        [...this.axisHandlers.keys()]
          .sort((a, b) => a - b)
          .map((axis) => RELATIVE_AXIS_NAMES[axis] ?? String(axis))
          .join(", ") || "none"
      }`,
    );

    const pools = this.refs.filter((r) => r.refTy === "list");
    const poolBytes = pools.reduce((acc, p) => {
      const iface = this.ifaces.get(p.iface!)!;
      const rec = iface.fields.reduce((a, f) => a + (f.ty === "str" ? this.target.strCap + 1 : f.ty === "bool" ? 1 : 4), 0);
      return acc + rec * this.target.poolCap + 1;
    }, 0);
    const viewBytes =
      this.computeds.filter((comp) => comp.valTy.k === "view").length * (this.target.poolCap + 1);
    const scalarBytes = this.refs
      .filter((r) => r.refTy !== "list")
      .reduce((a, r) => a + (r.refTy === "str" ? this.target.strCap + 1 : 4), 0);
    const romStrings =
      [...this.strLits.keys()].reduce((a, s) => a + s.length + 1, 0) + this.title.length + 1;
    const pairCount = this.styleTable.pairs.length;
    const fontBytes =
      this.target.name === "esp32" || this.target.name === "playdate" ? 95 * 8 : 95 * 32;
    const styleBytes =
      this.target.name === "gba"
        ? pairCount * 16 * 2 + pairCount + 3
        : this.target.name === "esp32"
          ? pairCount * 2 * 2 + pairCount + 2
          : pairCount;
    const planLines = [
      `state RAM: ${scalarBytes} B scalars/strings + ${poolBytes} B pools + ${viewBytes} B computed views`,
      `overlay RAM: ${ovl.slotBytes} B in ${ovl.decls.length} shared slots (${this.ovlTemps.length} frame-local temps off the C stack)`,
      `reactive tables: ${this.refs.length} dirty bits, ${this.computeds.length} validity bits, ${effects.length} effects`,
      `ROM data: ${romStrings} B strings + ${fontBytes} B font + ${styleBytes} B style data`,
    ];
    if (this.rpgMaps.length > 0) {
      const tileCount = this.rpgMaps.reduce((sum, map) => sum + map.width * map.height, 0);
      const eventCount = this.rpgMaps.reduce((sum, map) => sum + map.events.length, 0);
      const dialogCount = this.rpgMaps.reduce((sum, map) => sum + map.dialogs.length, 0);
      planLines.push(
        `RPG assets: ${this.rpgMaps.length} map(s), ${tileCount} tiles + collision bytes, ${eventCount} events, ${dialogCount} dialogs; ${this.rpgScreenCount} full-screen effect(s)`,
      );
      planLines.push("RPG art: 54 BG tiles + 6 static and 16 walking 32x32 world frames + 2 64x64 battle OBJ frames, 4 palette banks; 17216 B ROM copied to VRAM");
      planLines.push("RPG host RAM: 3136 B fixed BG1 tilemap + OAM/UI/cache/register shadow state");
    }

    return {
      c: c.join("\n").replace(/@OVL(\d+)@/g, (_m, id) => ovl.names.get(Number(id))!),
      title: this.title,
      rpgEnabled: this.rpgMaps.length > 0,
      graph: graphLines.join("\n"),
      plan: planLines.join("\n"),
      debugSlots,
      styles: this.styleTable,
      diagnostics: this.styleWarnings,
      buttonsUsed: [...this.buttonsUsed].sort((a, b) => a - b),
      relativeAxesUsed: [...this.axisHandlers.keys()].sort((a, b) => a - b),
    };
  }
}

// ---------------------------------------------------------------------------
// Generated data: fonts + palettes, per-target encodings
// ---------------------------------------------------------------------------

const INK = 1;
const PAPER = 2;

/** GBA: 95 glyphs, 4bpp, pixel 1 = ink / 2 = paper (real palette banks). */
function emitFontGba(): string {
  const bytes: number[] = [];
  for (let g = 0; g < 95; g++) {
    const bitmap = FONT8[g];
    for (let y = 0; y < 8; y++) {
      for (let x = 0; x < 8; x += 2) {
        const left = bitmap[y] & (0x80 >> x) ? INK : PAPER;
        const right = bitmap[y] & (0x80 >> (x + 1)) ? INK : PAPER;
        bytes.push(left | (right << 4));
      }
    }
  }
  return `const u8 vp_font_tiles[] = { ${bytes.join(",")} };`;
}

/** Direct 1bpp targets: one byte per 8-pixel row, MSB = leftmost pixel. */
function emitFont1bpp(): string {
  const bytes: number[] = [];
  for (let g = 0; g < 95; g++) bytes.push(...FONT8[g]);
  return `const u8 vp_font_tiles[] = { ${bytes.join(",")} };`;
}

/** DMG can't do per-tile palettes: styles are baked as glyph copies.
 * Style 0 = ink shade 3 on paper 0, style 1 = inverse. 2bpp interleaved. */
function emitFontGb(): string {
  const bytes: number[] = [];
  for (const [ink, paper] of [
    [3, 0],
    [0, 3],
  ]) {
    for (let g = 0; g < 95; g++) {
      const bitmap = FONT8[g];
      for (let y = 0; y < 8; y++) {
        let lo = 0;
        let hi = 0;
        for (let x = 0; x < 8; x++) {
          const v = bitmap[y] & (0x80 >> x) ? ink : paper;
          if (v & 1) lo |= 0x80 >> x;
          if (v & 2) hi |= 0x80 >> x;
        }
        bytes.push(lo, hi);
      }
    }
  }
  return `const u8 vp_font_tiles[] = { ${bytes.join(",")} };`;
}

/** NES: same two styles, 2bpp planar (8 bytes plane 0, then plane 1).
 * Subpal color 1 = paper, 3 = ink. Exported: rom.ts bakes these into
 * CHR-ROM (tile 0 blank, then the 190 glyphs). */
export function nesFontBytes(): number[] {
  const bytes: number[] = [];
  for (const [ink, paper] of [
    [3, 1],
    [1, 3],
  ]) {
    for (let g = 0; g < 95; g++) {
      const bitmap = FONT8[g];
      const p0: number[] = [];
      const p1: number[] = [];
      for (let y = 0; y < 8; y++) {
        let lo = 0;
        let hi = 0;
        for (let x = 0; x < 8; x++) {
          const v = bitmap[y] & (0x80 >> x) ? ink : paper;
          if (v & 1) lo |= 0x80 >> x;
          if (v & 2) hi |= 0x80 >> x;
        }
        p0.push(lo);
        p1.push(hi);
      }
      bytes.push(...p0, ...p1);
    }
  }
  return bytes;
}

function emitTargetData(target: VaporTarget, styles: StyleTable): string {
  const lowered = styles.lower(target.name);
  const styleTable = `const u8 vp_pal_style[${styles.pairs.length}] = { ${lowered.styleMap.join(",")} };`;

  switch (target.name) {
    case "gba": {
      const banks: number[] = [];
      for (const pair of styles.pairs) {
        const bank = new Array<number>(16).fill(0);
        bank[INK] = rgb555(pair.ink);
        bank[PAPER] = rgb555(pair.paper);
        banks.push(...bank);
      }
      return (
        `${emitFontGba()}\n` +
        `const u16 vp_palettes[] = { ${banks.join(",")} };\n` +
        `const u8 vp_palette_count = ${styles.pairs.length};\n` +
        `const u16 vp_backdrop = ${rgb555(BACKDROP)};\n` +
        styleTable
      );
    }
    case "esp32": {
      const ink = styles.pairs.map((pair) => rgb565(pair.ink));
      const paper = styles.pairs.map((pair) => rgb565(pair.paper));
      return (
        `${emitFont1bpp()}\n` +
        `const u16 vp_ink565[] = { ${ink.join(",")} };\n` +
        `const u16 vp_paper565[] = { ${paper.join(",")} };\n` +
        `const u16 vp_backdrop = ${rgb565(BACKDROP)};\n` +
        styleTable
      );
    }
    case "gb":
      return `${emitFontGb()}\n${styleTable}`;
    case "nes":
      /* NES font ships as CHR-ROM (rom.ts); only the style map is C data. */
      return styleTable;
    case "playdate":
      return (
        `${emitFont1bpp()}\n` +
        `const u8 vp_palette_count = ${styles.pairs.length};\n` +
        styleTable
      );
  }
}
