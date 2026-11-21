/** Root application lifecycle expressed as Rust AST, with no source fragments. */
import { checkAotVersion, type AotHandler } from "./aot-ir.ts";
import type { AotComponent, AotProgram } from "./aot-ir.ts";
import type { RustExpr, RustFunction, RustGeneric, RustItem, RustParam, RustStatement, RustType } from "./rust-ast.ts";
import { rb, rc, re, ref, rf, rm, rn, rp, rr, rt } from "./rust-ast.ts";
import { MOTION_LEVELS, MOTION_VALUES } from "../../contracts/spec/motion.ts";

/** Distinct fusion levels required by the subscribed motion values, ascending. */
const motionLevels = (values: number[]) => [...new Set(values.map(id => MOTION_LEVELS[Object.values(MOTION_VALUES).find(spec => spec.id === id)!.level]))].sort((a, b) => a - b);

const self = rp("self");
const field = (name: string): RustExpr => rf(self, name);
const parameter = (name: string, type: RustType, mutable = false): RustParam => ({ pattern: rn(name, mutable), type });
const receiver = (): RustParam => parameter("self", rr(rt("Self"), true));

/**
 * `propsType` is the same borrowed props type used by the generated view's
 * update method. Its anonymous lifetime becomes the application's lifetime:
 * stored props borrow application-owned data without copying strings or lists.
 */
export function generateAotApp(root: AotComponent, propsType: RustType, demands?: AotProgram["demands"], stateful = false, lifecycle = false, version: AotProgram["version"] = 1, modelProtocol = false, asyncDispatch = false): RustItem[] {
  checkAotVersion({ version });
  let borrowsProps = false;
  function storedType(type: RustType): RustType {
    switch (type.kind) {
      case "lifetime":
        if (type.name === "static") return type;
        borrowsProps = true;
        return { kind: "lifetime", name: "a" };
      case "path": return { ...type, ...(type.args ? { args: type.args.map(storedType) } : {}) };
      case "ref": {
        const borrowed = storedType(type.type);
        if (type.lifetime === "static") return { ...type, type: borrowed };
        borrowsProps = true;
        return { ...type, type: borrowed, lifetime: "a" };
      }
      case "tuple": return { ...type, elements: type.elements.map(storedType) };
      case "array": case "slice": return { ...type, element: storedType(type.element) };
      case "infer": return type;
      case "const": return type;
      case "dyn": return { ...type, bounds: type.bounds.map(storedType) };
      case "fnTrait": return { ...type, params: type.params.map(storedType), ...(type.returns ? { returns: storedType(type.returns) } : {}) };
      case "binding": return { ...type, type: storedType(type.type) };
    }
  }
  const props = storedType(propsType);
  const name = `${root.name}App`;
  const view = `${root.name}View`;
  const viewType = rt(view, ...(stateful ? [rt("M")] : []));
  const event = rt(`${root.name}Event`);
  const ui = rt("microts::Ui");
  const input = rt("microts::Input");
  const invalidation = rt("microts::Invalidation");
  const slotNames = root.slots.map(slot => `slot_${slot}`);
  const slotType = rt("Option", rt("microts::SlotHandle"));
  const slots = slotNames.map(name => rm(field(name), "as_ref"));
  const hostBounds = [rt("microts::Host"), ...(demands?.buttons ?? []).map(mask => rt("microts::HasButton", { kind: "const", value: mask })), ...(demands?.axes ?? []).map(axis => rt("microts::HasRelativeAxis", { kind: "const", value: axis })), ...motionLevels(demands?.motion ?? []).map(level => rt("microts::HasMotion", { kind: "const", value: level })), ...(demands?.capabilities.includes("touch") ? [rt("microts::HasTouch")] : [])];
  const generics: RustGeneric[] = [
    ...(borrowsProps ? [{ name: "a", lifetime: true }] : []),
    { name: "M", bounds: [rt(`${root.name}ViewModel`)] },
    { name: "H", bounds: hostBounds, ...(!demands?.axes.length && !demands?.motion?.length && !demands?.capabilities.includes("touch") ? { default: rt("microts::CoreHost") } : {}) },
  ];
  const type = rt(name, ...(borrowsProps ? [{ kind: "lifetime", name: "a" } as RustType] : []), rt("M"), rt("H"));
  const updateView = () => re(rm(field("view"), "update", rm(field("host"), "ui_mut"), ref(field("props")), ref(field("model")), ...slots,
    ...(root.slotProps?.some(slot => slot.parameters.length) ? [ref({ kind: "closure", params: [rn("_ui"), rn("_id"), rn("_arguments")], body: { kind: "tuple", elements: [] } }, true)] : []),
    ...(lifecycle ? [ref(field("lifecycle"))] : []),
  ));
  const modelRegions = rf(field("lifecycle"), "models");
  const phase = (name: string): RustExpr => rm(modelRegions, "run", rp("microts", "ModelPhase", name), ref(rp("ready")), ref(field("commands"), true));
  const reaction = () => modelProtocol ? [
    re(rm(field("model"), "react", { kind: "literal" as const, value: false }, ref(field("commands"), true))),
    re(phase("React")), re(rm(field("model"), "settle")), re(phase("Settle")),
  ] : [];
  const methods: RustFunction[] = [
    {
      kind: "fn", name: "new", public: true,
      params: [parameter("host", rt("H"), true), parameter("props", props), parameter("model", rt("M"), modelProtocol), ...slotNames.map(name => parameter(name, slotType))],
      returns: rt("Self"),
      body: rb([
        ...(lifecycle ? [{ kind: "let" as const, pattern: rn("lifecycle"), value: rc(rp("AotLifecycle", "new")) }] : []),
        ...(modelProtocol ? [re(rm(rp("model"), "bind_commands", rm(rf(rf(rp("lifecycle"), "models"), "commands"), "clone")))] : []),
        {
          kind: "let", pattern: rn("view"),
          value: rc({ kind: "qualifiedPath", type: viewType, member: "mount" }, rm(rp("host"), "ui_mut"), rp("microts", "NodeId", "ROOT"), rp("microts", "NodeId", "NONE"), ...slotNames.map(name => rm(rp(name), "as_ref")), ...(lifecycle ? [ref(rp("lifecycle"))] : [])),
        },
      ], {
        kind: "struct", path: ["Self"], fields: [
          { name: "host" }, { name: "model" }, { name: "props" }, { name: "view" },
          ...(lifecycle ? [{ name: "lifecycle" }, { name: "mount_pending", value: { kind: "literal" as const, value: modelProtocol || !!root.hooks?.mount } }] : []),
          ...(modelProtocol ? [{ name: "commands", value: rc(rp("Vec", "new")) }] : []),
          ...slotNames.map(name => ({ name })),
          { name: "invalidation", value: rc(rp("microts", "Invalidation", "default")) },
          { name: "events", value: rc(rp("alloc", "vec", "Vec", "new")) },
        ],
      }),
    },
    {
      kind: "fn", name: "frame", public: true,
      params: [receiver(), parameter("input", rr(input))],
      returns: rr({ kind: "slice", element: event }),
      body: rb([
        re(rm(field("events"), "clear")),
        { kind: "let", pattern: rn("input"), value: rm(rm(field("host"), "ui_mut"), "resolve_input", rp("input")) },
        ...(modelProtocol ? [
          { kind: "let" as const, pattern: rn("ready"), value: rm(field("host"), "model_ready") },
          re(rm(field("model"), "prepare_resume", ref(rp("ready")))), re(phase("Prepare")),
          re(rm(field("model"), "resume", ref(rp("ready")), ref(field("commands"), true))),
          { kind: "let" as const, pattern: rn("resumed"), value: phase("Resume") },
          re({ kind: "if", condition: { kind: "binary", operator: "||", left: rp("resumed"), right: rm(field("model"), "model_changed") }, then: rb([re(rm(field("invalidation"), "invalidate"))]) }),
        ] as ReturnType<typeof rb>["statements"] : []),
        {
          kind: "let", pattern: rn("handled"),
          value: rm(field("view"), "dispatch", ref(rp("input")), ref(field("props")), ref(field("model"), true), ...slots, ref(field("events"), true), ...(asyncDispatch?[ref(rf(modelRegions,"commands"))]:[])),
        },
        re({
          kind: "if", condition: rp("handled"),
          then: rb([re(rm(field("invalidation"), "invalidate"))]),
        }),
        re({
          kind: "if", condition: rm(field("invalidation"), "take"),
          then: rb([...reaction(), updateView()]),
        }),
        re(rm(rm(field("host"), "ui_mut"), "tick")),
      ], rm(field("events"), "as_slice")),
    },
    {
      kind: "fn", name: "invalidate", public: true, params: [receiver()],
      body: rb([re(rm(field("invalidation"), "invalidate"))]),
    },
    {
      kind: "fn", name: "set_props", public: true, params: [receiver(), parameter("props", props)],
      body: rb([
        { kind: "assign", target: field("props"), value: rp("props") },
        re(rm(field("invalidation"), "invalidate")),
      ]),
    },
    {
      kind: "fn", name: "unmount", public: true, params: [{ pattern: rn("self", true) }], returns: ui,
      body: rb([re(rm(field("view"), "unmount", rm(field("host"), "ui_mut")))], rm(field("host"), "into_ui")),
    },
    { kind: "fn", name: "ui", public: true, params: [parameter("self", rr(rt("Self")))], returns: rr(ui), body: rb([], rm(field("host"), "ui")) },
    { kind: "fn", name: "ui_mut", public: true, params: [receiver()], returns: rr(ui, true), body: rb([], rm(field("host"), "ui_mut")) },
  ];
  let bootHooks: RustStatement[] = [];
  if (lifecycle) {
    const hookStatements = (handler: AotHandler | undefined): ReturnType<typeof rb>["statements"] => {
      if (!handler) return [];
      if (handler.kind === "sequence") return handler.steps.flatMap(hookStatements);
      if (handler.kind !== "call" || handler.expression.kind !== "call" || handler.expression.arguments.length) throw new Error("Lifecycle hooks require zero-argument model calls");
      const method=handler.expression.name;
      if(root.functions.find(fn=>fn.name===method)?.async)return [
        {kind:"let",pattern:rn("hook_commands",true),value:rc(rp("Vec","new"))},
        re(rm(field("model"),method,ref(rp("hook_commands"),true))),
        re(rm(rf(modelRegions,"commands"),"extend",rp("hook_commands"))),
      ];
      return [re(rm(field("model"), handler.expression.name))];
    };
    const frame = methods.find(method => method.name === "frame")!;
    const literal = (value: number | boolean): RustExpr => ({ kind: "literal", value });
    const bin = (operator: string, left: RustExpr, right: RustExpr): RustExpr => ({ kind: "binary", operator, left, right });
    const hookRounds = (initial: boolean): RustStatement[] => [
      { kind: "let", pattern: rn("hook_rounds", true), value: literal(0) },
      { kind: "loop", body: rb([
        { kind: "let", pattern: rn("ran_hooks", true), value: rm(field("lifecycle"), "run_unmounts") },
        re({ kind: "if", condition: field("mount_pending"), then: rb([
          { kind: "assign", target: field("mount_pending"), value: literal(false) },
          ...(modelProtocol && !initial ? [re(rm(field("model"), "react", literal(true), ref(field("commands"), true))), re(rm(field("model"), "settle"))] : []),
          ...hookStatements(root.hooks?.mount),
          { kind: "assign", target: rp("ran_hooks"), value: literal(true) },
        ]) }),
        { kind: "assign", target: rp("ran_hooks"), value: bin("|", rm(field("lifecycle"), "run_mounts"), rp("ran_hooks")) },
        { kind: "let", pattern: rn("invalidated"), value: rm(field("invalidation"), "take") },
        re({ kind: "if", condition: { kind: "unary", operator: "!", expr: bin("||", rp("ran_hooks"), rp("invalidated")) }, then: rb([{ kind: "break" }]) }),
        { kind: "assign", target: rp("hook_rounds"), value: bin("+", rp("hook_rounds"), literal(1)) },
        re({ kind: "macro", name: ["debug_assert"], args: [bin("<=", rp("hook_rounds"), literal(8)), { kind: "literal", value: "AOT lifecycle exceeded eight hook rounds" }] }),
        ...reaction(), updateView(),
      ]) },
    ];
    frame.body!.statements.splice(frame.body!.statements.length - 1, 0, ...hookRounds(false));
    bootHooks = hookRounds(true);
    const unmount = methods.find(method => method.name === "unmount")!;
    unmount.body!.statements.push(re(rm(field("lifecycle"), "discard_mounts")), re(rm(field("lifecycle"), "run_unmounts")), ...hookStatements(root.hooks?.unmount));
  }
  if (modelProtocol) {
    const frame = methods.find(method => method.name === "frame")!;
    frame.body!.statements.splice(frame.body!.statements.length - 1, 0,
      re(rm(rf(modelRegions, "commands"), "drain_to", ref(field("commands"), true))),
      { kind: "for", pattern: rn("command"), iterable: rc(rp("core", "mem", "take"), ref(field("commands"), true)), body: rb([re(rm(field("host"), "model_command", rp("command")))]) },
    );
    const unmount = methods.find(method => method.name === "unmount")!;
    unmount.body!.statements.push(re(rm(field("model"), "cancel_tasks", ref(field("commands"), true))), re(rm(rf(modelRegions, "commands"), "drain_to", ref(field("commands"), true))),
      { kind: "for", pattern: rn("command"), iterable: rc(rp("core", "mem", "take"), ref(field("commands"), true)), body: rb([re(rm(field("host"), "model_command", rp("command")))]) });
    methods.push({ kind: "fn", name: "initialize_model", params: [receiver()], body: rb([
      { kind: "let", pattern: rn("ready"), value: rm(field("host"), "model_initial_ready") },
      re(rm(field("model"), "prepare_resume", ref(rp("ready")))), re(phase("Prepare")),
      updateView(),
      re(rm(field("model"), "react", { kind: "literal", value: true }, ref(field("commands"), true))),
      re(rm(field("model"), "settle")), ...bootHooks,
      re(rm(rf(modelRegions, "commands"), "drain_to", ref(field("commands"), true))),
      { kind: "for", pattern: rn("command"), iterable: rc(rp("core", "mem", "take"), ref(field("commands"), true)), body: rb([re(rm(field("host"), "model_command", rp("command")))]) },
    ]) });
    const constructor = methods.find(method => method.name === "new")!.body!;
    constructor.statements.push({ kind: "let", pattern: rn("app", true), value: constructor.result! }, re(rm(rp("app"), "initialize_model")));
    constructor.result = rp("app");
  }
  return [
    {
      kind: "struct", name, public: true, generics,
      fields: [
        ...(lifecycle ? [{ name: "lifecycle", type: rt("AotLifecycle") }, { name: "mount_pending", type: rt("bool") }] : []),
        ...(modelProtocol ? [{ name: "commands", type: rt("Vec", rt("microts::Cmd")) }] : []),
        { name: "host", type: rt("H"), public: true },
        { name: "model", type: rt("M"), public: true },
        { name: "props", type: props },
        { name: "view", type: viewType },
        { name: "invalidation", type: invalidation },
        { name: "events", type: rt("alloc::vec::Vec", event) },
        ...slotNames.map(name => ({ name, type: slotType })),
      ],
    },
    { kind: "impl", type, generics: generics.map(({ default: _default, ...generic }) => generic), methods },
  ];
}

/** Runtime-neutral hook queues. Blocks retain the scheduler through Rc, so the
 * existing consuming Block::unmount contract can defer model cleanup. */
export function generateAotLifecycle(modelProtocol = false): RustItem[] {
  const seq = rt("usize"), hook = rt("alloc::boxed::Box", { kind: "dyn", bounds: [{ kind: "fnTrait", name: "FnMut", params: [] }] });
  const entry: RustType = { kind: "tuple", elements: [seq, hook] };
  const dropped: RustType = { kind: "tuple", elements: [seq, rt("Unmounted")] };
  const shared = (type: RustType): RustType => rt("alloc::rc::Rc", rt("core::cell::RefCell", type));
  const sharedNew = (value: RustExpr): RustExpr => rc(rp("alloc", "rc", "Rc", "new"), rc(rp("core", "cell", "RefCell", "new"), value));
  const number = (value: number): RustExpr => ({ kind: "literal", value, suffix: "usize" });
  const bin = (operator: string, left: RustExpr, right: RustExpr): RustExpr => ({ kind: "binary", operator, left, right });
  const makeMethod = (name: string, params: RustParam[], body: ReturnType<typeof rb>, returns?: RustType): RustFunction => ({ kind: "fn", name, params, body, returns });
  const recv = parameter("self", rr(rt("Self")));
  const methods: RustFunction[] = [
    makeMethod("new", [], rb([], { kind: "struct", path: ["Self"], fields: [
      { name: "next", value: sharedNew(number(1)) },
      { name: "mounted", value: sharedNew(rc(rp("Vec", "new"))) },
      { name: "unmounted", value: sharedNew(rc(rp("Vec", "new"))) },
      ...(modelProtocol ? [{ name: "models", value: rc(rp("microts", "ModelRegions", "default")) }] : []),
    ] }), rt("Self")),
    makeMethod("next_sequence", [recv], rb([
      { kind: "let", pattern: rn("next", true), value: rm(field("next"), "borrow_mut") },
      { kind: "let", pattern: rn("sequence"), value: { kind: "unary", operator: "*", expr: rp("next") } },
      { kind: "assign", target: { kind: "unary", operator: "*", expr: rp("next") }, value: bin("+", rp("sequence"), number(1)) },
    ], rp("sequence")), seq),
    makeMethod("enqueue_mount", [recv, parameter("sequence", seq), parameter("hook", hook)], rb([re(rm(rm(field("mounted"), "borrow_mut"), "push", { kind: "tuple", elements: [rp("sequence"), rp("hook")] }))])),
    makeMethod("enqueue_unmount", [recv, parameter("sequence", seq), parameter("hook", hook)], rb([
      re(rm(rm(field("mounted"), "borrow_mut"), "retain", { kind: "closure", params: [rn("entry")], body: bin("!=", rf(rp("entry"), 0), rp("sequence")) })),
      re(rm(rm(field("unmounted"), "borrow_mut"), "push", { kind: "tuple", elements: [rp("sequence"), rc(rp("Unmounted", "Hook"), rp("hook"))] })),
    ])),
    makeMethod("cancel_mount", [recv, parameter("sequence", seq)], rb([re(rm(rm(field("mounted"), "borrow_mut"), "retain", { kind: "closure", params: [rn("entry")], body: bin("!=", rf(rp("entry"), 0), rp("sequence")) }))])),
    makeMethod("discard_mounts", [recv], rb([re(rm(rm(field("mounted"), "borrow_mut"), "clear"))])),
  ];
  for (const [queue, method, descending] of [["unmounted", "run_unmounts", true], ["mounted", "run_mounts", false]] as const) {
    methods.push(makeMethod(method, [recv], rb([
      { kind: "let", pattern: rn("pending", true), value: rc(rp("core", "mem", "take"), ref({ kind: "unary", operator: "*", expr: rm(field(queue), "borrow_mut") }, true)) },
      { kind: "let", pattern: rn("ran"), value: { kind: "unary", operator: "!", expr: rm(rp("pending"), "is_empty") } },
      re(rm(rp("pending"), "sort_by_key", { kind: "closure", params: [rn("entry")], body: descending ? rc(rp("core", "cmp", "Reverse"), rf(rp("entry"), 0)) : rf(rp("entry"), 0) })),
      { kind: "for", pattern: { kind: "tuple", elements: [{ kind: "wildcard" }, descending ? { kind: "variant", path: ["Unmounted", "Hook"], tuple: [rn("hook", true)] } : rn("hook", true)] }, iterable: rp("pending"), body: rb([re(rc(rp("hook")))]) },
    ], rp("ran")), rt("bool")));
  }
  return [
    { kind: "enum", name: "Unmounted", variants: [{ name: "Hook", tuple: [hook] }] },
    { kind: "struct", name: "AotLifecycle", public: true, derives: ["Clone"], fields: [
      { name: "next", type: shared(seq) }, { name: "mounted", type: shared(rt("Vec", entry)) }, { name: "unmounted", type: shared(rt("Vec", dropped)) },
      ...(modelProtocol ? [{ name: "models", type: rt("microts::ModelRegions") }] : []),
    ] },
    { kind: "impl", type: rt("AotLifecycle"), methods },
  ];
}

/** Source-order reconciliation ensures creation sequence follows document order,
 * including components that first appear inside a reused keyed row. */
export function generateAotReconcile(): RustItem {
  const literal = (value: number | boolean | string): RustExpr => ({ kind: "literal", value });
  const row = rt("microts::KeyedRow", rt("K"), rt("B"));
  const makeFn = (params: RustType[], returns?: RustType): RustType => ({ kind: "fnTrait", name: "FnMut", params, returns });
  const node = rt("NodeId"), ui = rr(rt("Ui"), true), item = rr(rt("T")), index = rt("i32");
  const mutableRow = rf(rp("row"), "block");
  const oldItem: RustExpr = { kind: "index", object: rp("old"), index: rp("index") };
  return {
    kind: "fn", name: "aot_reconcile",
    generics: [
      { name: "K", bounds: [rt("Ord"), rt("Clone")] }, { name: "B", bounds: [rt("Block")] }, { name: "T" },
      { name: "FKey", bounds: [makeFn([item, index], rt("K"))] },
      { name: "FMount", bounds: [makeFn([ui, node, node, item, index], rt("B"))] },
      { name: "FUpdate", bounds: [makeFn([rr(rt("B"), true), ui, item, index, node])] },
    ],
    params: [parameter("list", rr(rt("KeyedList", rt("K"), rt("B")), true)), parameter("ui", ui), parameter("parent", node), parameter("anchor", node), parameter("items", rr({ kind: "slice", element: rt("T") })), parameter("key", rt("FKey"), true), parameter("mount", rt("FMount"), true), parameter("update", rt("FUpdate"), true)],
    body: rb([
      { kind: "let", pattern: rn("old", true), type: rt("Vec", rt("Option", row)), value: rm(rm(rm(rc(rp("core", "mem", "take"), ref(rf(rp("list"), "rows"), true)), "into_iter"), "map", rp("Some")), "collect") },
      { kind: "let", pattern: rn("rows", true), type: rt("Vec", row), value: rc(rp("Vec", "with_capacity"), rm(rp("items"), "len")) },
      { kind: "let", pattern: rn("by_key", true), value: rc(rp("alloc", "collections", "BTreeMap", "new")) },
      { kind: "for", pattern: { kind: "tuple", elements: [rn("index"), rn("row")] }, iterable: rm(rm(rp("old"), "iter"), "enumerate"), body: rb([
        re(rm(rp("by_key"), "insert", rm(rf(rm(rm(rp("row"), "as_ref"), "unwrap"), "key"), "clone"), rp("index"))),
      ]) },
      { kind: "let", pattern: rn("seen", true), value: rc(rp("alloc", "collections", "BTreeSet", "new")) },
      { kind: "for", pattern: { kind: "tuple", elements: [rn("position"), rn("item")] }, iterable: rm(rm(rp("items"), "iter"), "enumerate"), body: rb([
        { kind: "let", pattern: rn("position"), value: { kind: "cast", expr: rp("position"), type: index } },
        { kind: "let", pattern: rn("row_key"), value: rc(rp("key"), rp("item"), rp("position")) },
        re({ kind: "macro", name: ["debug_assert"], args: [rm(rp("seen"), "insert", rm(rp("row_key"), "clone")), literal("duplicate AOT list key")] }),
        { kind: "let", pattern: rn("index"), value: rm(rp("by_key"), "remove", ref(rp("row_key"))) },
        { kind: "let", pattern: rn("row", true), value: { kind: "match", value: rp("index"), arms: [
          { pattern: { kind: "variant", path: ["Some"], tuple: [rn("index")] }, body: rm(rm(oldItem, "take"), "unwrap") },
          { pattern: { kind: "variant", path: ["None"] }, body: { kind: "struct", path: ["microts", "KeyedRow"], fields: [{ name: "key", value: rp("row_key") }, { name: "block", value: rc(rp("mount"), rp("ui"), rp("parent"), rp("anchor"), rp("item"), rp("position")) }] } },
        ] } },
        re(rc(rp("update"), ref(mutableRow, true), rp("ui"), rp("item"), rp("position"), rp("anchor"))),
        re(rm(rp("rows"), "push", rp("row"))),
      ]) },
      { kind: "for", pattern: rn("row"), iterable: rm(rm(rp("old"), "into_iter"), "flatten"), body: rb([re(rm(mutableRow, "unmount", rp("ui")))]) },
      { kind: "assign", target: rf(rp("list"), "rows"), value: rp("rows") },
      { kind: "for", pattern: rn("row"), iterable: ref(rf(rp("list"), "rows"), true), body: rb([re(rm(mutableRow, "move_before", rp("ui"), rp("parent"), rp("anchor")))]) },
    ]),
  };
}
