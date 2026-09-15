/** Root application lifecycle expressed as Rust AST, with no source fragments. */
import type { AotComponent, AotProgram } from "./aot-ir.ts";
import type { RustExpr, RustFunction, RustGeneric, RustItem, RustParam, RustType } from "./rust-ast.ts";
import { rb, rc, re, ref, rf, rm, rn, rp, rr, rt } from "./rust-ast.ts";

const self = rp("self");
const field = (name: string): RustExpr => rf(self, name);
const parameter = (name: string, type: RustType, mutable = false): RustParam => ({ pattern: rn(name, mutable), type });
const receiver = (): RustParam => parameter("self", rr(rt("Self"), true));

/**
 * `propsType` is the same borrowed props type used by the generated view's
 * update method. Its anonymous lifetime becomes the application's lifetime:
 * stored props borrow application-owned data without copying strings or lists.
 */
export function generateVueAotApp(root: AotComponent, propsType: RustType, demands?: AotProgram["demands"], stateful = false): RustItem[] {
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
      case "binding": return { ...type, type: storedType(type.type) };
    }
  }
  const props = storedType(propsType);
  const name = `${root.name}App`;
  const view = `${root.name}View`;
  const viewType = rt(view, ...(stateful ? [rt("M")] : []));
  const event = rt(`${root.name}Event`);
  const ui = rt("pocket_vapor::Ui");
  const input = rt("pocket_vapor::Input");
  const invalidation = rt("pocket_vapor::Invalidation");
  const slotNames = root.slots.map(slot => `slot_${slot}`);
  const slotType = rt("Option", rt("pocket_vapor::SlotHandle"));
  const slots = slotNames.map(name => rm(field(name), "as_ref"));
  const hostBounds = [rt("pocket_vapor::Host"), ...(demands?.buttons ?? []).map(mask => rt("pocket_vapor::HasButton", { kind: "const", value: mask })), ...(demands?.axes ?? []).map(axis => rt("pocket_vapor::HasRelativeAxis", { kind: "const", value: axis })), ...(demands?.capabilities.includes("touch") ? [rt("pocket_vapor::HasTouch")] : [])];
  const generics: RustGeneric[] = [
    ...(borrowsProps ? [{ name: "a", lifetime: true }] : []),
    { name: "M", bounds: [rt(`${root.name}ViewModel`)] },
    { name: "H", bounds: hostBounds, ...(!demands?.axes.length && !demands?.capabilities.includes("touch") ? { default: rt("pocket_vapor::CoreHost") } : {}) },
  ];
  const type = rt(name, ...(borrowsProps ? [{ kind: "lifetime", name: "a" } as RustType] : []), rt("M"), rt("H"));
  const methods: RustFunction[] = [
    {
      kind: "fn", name: "new", public: true,
      params: [parameter("host", rt("H"), true), parameter("props", props), parameter("model", rt("M")), ...slotNames.map(name => parameter(name, slotType))],
      returns: rt("Self"),
      body: rb([
        {
          kind: "let", pattern: rn("view"),
          value: rc({ kind: "qualifiedPath", type: viewType, member: "mount" }, rm(rp("host"), "ui_mut"), rp("pocket_vapor", "NodeId", "ROOT"), rp("pocket_vapor", "NodeId", "NONE"), ...slotNames.map(name => rm(rp(name), "as_ref"))),
        },
      ], {
        kind: "struct", path: ["Self"], fields: [
          { name: "host" }, { name: "model" }, { name: "props" }, { name: "view" },
          ...slotNames.map(name => ({ name })),
          { name: "invalidation", value: rc(rp("pocket_vapor", "Invalidation", "default")) },
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
        {
          kind: "let", pattern: rn("handled"),
          value: rm(field("view"), "dispatch", ref(rp("input")), ref(field("props")), ref(field("model"), true), ...slots, ref(field("events"), true)),
        },
        re({
          kind: "if", condition: rp("handled"),
          then: rb([re(rm(field("invalidation"), "invalidate"))]),
        }),
        re({
          kind: "if", condition: rm(field("invalidation"), "take"),
          then: rb([re(rm(field("view"), "update", rm(field("host"), "ui_mut"), ref(field("props")), ref(field("model")), ...slots))]),
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
  return [
    {
      kind: "struct", name, public: true, generics,
      fields: [
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
