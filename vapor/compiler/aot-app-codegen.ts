/** Root application lifecycle expressed as Rust AST, with no source fragments. */
import type { AotComponent } from "./aot-ir.ts";
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
export function generateVueAotApp(root: AotComponent, propsType: RustType): RustItem[] {
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
    }
  }
  const props = storedType(propsType);
  const name = `${root.name}App`;
  const view = `${root.name}View`;
  const event = rt(`${root.name}Event`);
  const ui = rt("pocket_vapor::Ui");
  const input = rt("pocket_vapor::Input");
  const invalidation = rt("pocket_vapor::Invalidation");
  const slotNames = root.slots.map(slot => `slot_${slot}`);
  const slotType = rt("Option", rt("pocket_vapor::SlotHandle"));
  const slots = slotNames.map(name => rm(field(name), "as_ref"));
  const generics: RustGeneric[] = [
    ...(borrowsProps ? [{ name: "a", lifetime: true }] : []),
    { name: "M", bounds: [rt(`${root.name}ViewModel`)] },
  ];
  const type = rt(name, ...(borrowsProps ? [{ kind: "lifetime", name: "a" } as RustType] : []), rt("M"));
  const methods: RustFunction[] = [
    {
      kind: "fn", name: "new", public: true,
      params: [parameter("ui", ui, true), parameter("props", props), parameter("model", rt("M")), ...slotNames.map(name => parameter(name, slotType))],
      returns: rt("Self"),
      body: rb([
        {
          kind: "let", pattern: rn("view"),
          value: rc(rp(view, "mount"), ref(rp("ui"), true), rp("pocket_vapor", "NodeId", "ROOT"), rp("pocket_vapor", "NodeId", "NONE"), ...slotNames.map(name => rm(rp(name), "as_ref"))),
        },
      ], {
        kind: "struct", path: ["Self"], fields: [
          { name: "ui" }, { name: "model" }, { name: "props" }, { name: "view" },
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
        { kind: "let", pattern: rn("input"), value: rm(field("ui"), "resolve_input", rp("input")) },
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
          then: rb([re(rm(field("view"), "update", ref(field("ui"), true), ref(field("props")), ref(field("model")), ...slots))]),
        }),
        re(rm(field("ui"), "tick")),
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
      body: rb([re(rm(field("view"), "unmount", ref(field("ui"), true)))], field("ui")),
    },
  ];
  return [
    {
      kind: "struct", name, public: true, generics,
      fields: [
        { name: "ui", type: ui, public: true },
        { name: "model", type: rt("M"), public: true },
        { name: "props", type: props },
        { name: "view", type: rt(view) },
        { name: "invalidation", type: invalidation },
        { name: "events", type: rt("alloc::vec::Vec", event) },
        ...slotNames.map(name => ({ name, type: slotType })),
      ],
    },
    { kind: "impl", type, generics, methods },
  ];
}
