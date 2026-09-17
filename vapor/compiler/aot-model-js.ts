/** Executable JS lowering of the Model IR. No interpreter or Promise runs in this class. */
import type { ModelAwaitable, ModelBlock, ModelExpr, ModelFunction, ModelModule, ModelProgram, ModelStmt } from "./aot-model-ir.ts";
import { checkModelVersion } from "./aot-model-ir.ts";
import { assertModelProgram } from "./aot-model-tasks.ts";

export interface ModelJsOptions { vue?: boolean; development?: boolean; runtimeImport?: string; stdImport?: string; tasksImport?: string }
export function generateModelJavaScript(program: ModelProgram, module: ModelModule = program.modules[0]!, options: ModelJsOptions = {}): string {
  checkModelVersion(program); assertModelProgram(program);
  const q = JSON.stringify;
  let temporary = 0;
  let taskBody = false;
  const local = (id: number) => taskBody ? `__locals[${id}]` : `v${id}`;
  const expr = (e: ModelExpr): string => {
    switch (e.kind) {
      case "literal": return typeof e.value === "number" && Object.is(e.value, -0) ? "-0" : q(e.value);
      case "undefined": return "undefined";
      case "local": return local(e.id);
      case "field": return `__fields[${e.id}]`;
      case "signal": case "memo": return `__r.read(${e.id})`;
      case "member": return `(${expr(e.object)})${e.optional ? "?." : ""}[${q(e.name)}]`;
      case "index": return `(${expr(e.object)})[${expr(e.index)}]`;
      case "copy": return `__std.copy(${expr(e.value)})`;
      case "cast": return numeric(expr(e.value), e.type);
      case "unary": return numeric(`(${e.operator}${expr(e.operand)})`, e.type);
      case "binary": {
        if (e.operator === "*" && e.type.kind === "number" && e.type.name === "i32") return `Math.imul(${expr(e.left)}, ${expr(e.right)})`;
        return numeric(`(${expr(e.left)} ${e.operator} ${expr(e.right)})`, e.type);
      }
      case "conditional": return `(${expr(e.condition)} ? ${expr(e.consequent)} : ${expr(e.alternate)})`;
      case "template": return `(${e.parts.map(part => typeof part === "string" ? q(part) : `String(${expr(part)})`).join(" + ") || '""'})`;
      case "struct": return `({${e.fields.map(field => `${q(field.name)}: ${expr(field.value)}`).join(", ")}})`;
      case "array": return `[${e.items.map(expr).join(", ")}]`;
      case "invoke": return `f${e.callee}(${e.args.map(arg => `__std.copy(${expr(arg)})`).join(", ")})`;
      case "builtin": return `${["String", "Number", "Boolean"].includes(e.name) ? e.name : `__std.${e.name}`}(${e.args.map(expr).join(", ")})`;
      case "lambda": { const outer = taskBody; taskBody = false; const value = `(${e.params.map(p => `v${p.id}`).join(", ")}) => {${block(e.body)}}`; taskBody = outer; return value; }
      case "sequence": return `(() => {${block(e.body)}return ${expr(e.value)};})()`;
    }
  };
  function numeric(value: string, type: ModelExpr["type"]): string {
    if (type.kind !== "number") return value;
    if (type.name === "i32") return `((${value}) | 0)`;
    if (type.name === "u32") return `((${value}) >>> 0)`;
    if (type.name === "i8") return `((${value}) << 24 >> 24)`;
    if (type.name === "i16") return `((${value}) << 16 >> 16)`;
    if (type.name === "u8") return `((${value}) & 255)`;
    if (type.name === "u16") return `((${value}) & 65535)`;
    if (type.name === "f32") return `Math.fround(${value})`;
    return value;
  }
  function wait(source: ModelAwaitable): string {
    switch (source.kind) {
      case "frames": return `{kind:"frames",count:${expr(source.count)}}`;
      case "after": return `{kind:"after",ms:${expr(source.ms)}}`;
      case "until": return `{kind:"until",predicate:()=>${expr(source.predicate)}}`;
      case "join": return `{kind:"join",task:f${source.task}(${(source.args ?? []).map(expr).join(",")}),wrapped:${source.wrapped}}`;
      case "service": return `{kind:"service",service:${q(source.module)},call:${q(source.call)},args:[${source.args.map(expr).join(",")}]}`;
      case "animate": return `{kind:"animate",args:[${source.args.map(expr).join(",")}]}`;
      case "all": case "any": return `{kind:${q(source.kind)},members:[${source.members.map(wait).join(",")}]}`;
    }
  }
  function statement(s: ModelStmt): string {
    switch (s.kind) {
      case "let": return `${taskBody ? "" : "let "}${local(s.binder.id)} = ${s.binder.owned ? `__std.copy(${expr(s.init)})` : expr(s.init)};`;
      case "assign": {
        const target = s.target;
        return `${target.kind === "local" ? local(target.id) : target.kind === "field" ? `__fields[${target.id}]` : target.kind === "element" ? `${local(target.owner)}[${expr(target.index)}]` : `${local(target.owner)}[${q(target.name)}]`} = __std.copy(${expr(s.value)});`;
      }
      case "set": return `{${s.pre ? `${taskBody ? "" : "const "}${local(s.pre.id)} = __r.read(${s.signal});` : ""}__r.write(${s.signal}, ${expr(s.value)}, ${!!s.writeBack});}`;
      case "if": return `if (${expr(s.condition)}) {${block(s.then)}}${s.else ? ` else {${block(s.else)}}` : ""}`;
      case "for": { const n = `__bound${temporary++}`; return `{const ${n} = ${expr(s.bound)};for (${taskBody ? "" : "let "}${local(s.binder.id)} = ${s.start ? expr(s.start) : 0}; ${local(s.binder.id)} ${s.inclusive ? "<=" : "<"} ${n}; ${local(s.binder.id)}++) {${block(s.body)}}}`; }
      case "forOf": return `for (${taskBody ? "" : "const "}${local(s.binder.id)} of ${expr(s.source)}) {${block(s.body)}}`;
      case "switch": return `switch (${expr(s.value)}) {${s.cases.map(c => `${c.value ? `case ${expr(c.value)}` : "default"}: {${block(c.body)}break;}`).join("\n")}}`;
      case "return": return taskBody ? `return {done:true,result:${s.value ? expr(s.value) : "undefined"}};` : `return ${s.value ? `__std.copy(${expr(s.value)})` : ""};`;
      case "call": case "start": return `f${s.kind === "call" ? s.callee : s.task}(${s.args.map(arg => `__std.copy(${expr(arg)})`).join(",")});`;
      case "expr": return `${expr(s.value)};`;
      case "untrack": case "batch": return `{${block(s.body)}}`;
      case "external": return s.op === "cancel" ? `__tasks.cancel(${s.args.map(expr).join(",")});` : `__r.emit("command", {op:${q(s.op)},args:[${s.args.map(expr).join(",")}]});`;
      case "await": throw new Error("Coroutine lowering left await in a state body");
    }
  }
  function block(b: ModelBlock): string { return b.stmts.map(statement).join("\n"); }
  function fn(f: ModelFunction): string {
    const task = module.tasks.find(task => task.fn === f.id);
    const params = f.params.map(p => `v${p.id}`).join(", ");
    if (f.async) {
      if (!task) throw new Error(`Missing lowered task ${f.name}`);
      taskBody = true;
      const states = task.states.map(state => `case ${state.id}: {${block(state.body)}\n${state.suspend ? `return {suspend:${wait(state.suspend)},next:${state.next},bind:${state.resume?.id ?? "undefined"}};` : state.branch ? `return {next:(${expr(state.branch.condition)}) ? ${state.branch.then} : ${state.branch.else}};` : state.next !== undefined ? `return {next:${state.next}};` : "return {done:true};"}}`).join("\n");
      taskBody = false;
      return `function f${f.id}(${params}) {return __tasks.start(${f.id},[${params}],(__state,__locals)=>{switch(__state){${states}default:throw new Error("Invalid task state");}},${q(f.params.map(p => p.id))});}`;
    }
    return `function f${f.id}(${params}) {__r.enter(${q(f.name)});try {${block(f.body)}} finally {__r.leave();}}`;
  }
  const imports = [
    `import {createModelRegion} from ${q(options.runtimeImport ?? `@pocketjs/framework/${options.vue ? "vue-vapor" : "solid"}/reactive`)};`,
    `import * as __std from ${q(options.stdImport ?? "@pocketjs/framework/solid/std")};`,
    `import {ModelTasks} from ${q(options.tasksImport ?? "@pocketjs/framework/model/tasks")};`,
  ];
  const setup = [
    `const __r = createModelRegion(${options.development !== false}, ${program.recursionLimit ?? 256});`,
    `const __tasks = new ModelTasks(__r); const __fields = {};`,
    ...module.fields.map(field => `__fields[${field.id}] = ${expr(field.seed)};`),
    ...module.signals.map(signal => `__r.signal(${signal.id},${q(signal.name)},${expr(signal.seed)},${signal.capacity ?? ("capacity" in signal.type ? signal.type.capacity : undefined) ?? "undefined"});`),
    ...module.memos.map(memo => `__r.memo(${memo.id},${q(memo.name)},${q(memo.inputs)},()=>${expr(memo.body)});`),
    ...[...program.modules.filter(m => m.kind === "pure").flatMap(m => m.functions), ...module.functions].map(fn),
    ...module.effects.map(effect => `__r.effect(${effect.id},${q(effect.subscriptions)},()=>{${effect.watch ? `${effect.watch.value ? `const v${effect.watch.value.id} = ${effect.watch.sources.length === 1 ? `__r.read(${effect.watch.sources[0]})` : `[${effect.watch.sources.map(id => `__r.read(${id})`).join(",")}]`};` : ""}${effect.watch.previous ? `const v${effect.watch.previous.id} = __watch${effect.id};` : ""}__watch${effect.id} = __std.copy(${effect.watch.sources.length === 1 ? `__r.read(${effect.watch.sources[0]})` : `[${effect.watch.sources.map(id => `__r.read(${id})`).join(",")}]`});` : ""}${block(effect.body)}},${effect.defer});`),
    `__r.finish(${q(module.schedule)});`,
  ];
  for (const effect of module.effects) if (effect.watch) setup.unshift(`let __watch${effect.id};`);
  const exposed: [string, string][] = [];
  for (const signal of module.signals.filter(s => s.exported)) {
    exposed.push([signal.name, options.vue ? `{get value(){return __r.read(${signal.id})},set value(v){__r.write(${signal.id},v)}}` : `()=>__r.read(${signal.id})`]);
    if (signal.setter && !options.vue) exposed.push([signal.setter, `(v)=>{const next=typeof v === "function" ? v(__r.read(${signal.id})) : v;__r.write(${signal.id},next);return next;}`]);
  }
  for (const memo of module.memos.filter(m => m.exported)) exposed.push([memo.name, options.vue ? `{get value(){return __r.read(${memo.id})}}` : `()=>__r.read(${memo.id})`]);
  for (const f of module.functions.filter(f => f.exported)) exposed.push([f.name, `f${f.id}`]);
  if (module.kind === "factory") return [...imports, `export function ${module.factory ?? `create${module.name}`}(${module.params.map(p => `v${p.id}`).join(",")}) {`, ...setup, `return {${exposed.map(([name, value]) => `${q(name)}:${value}`).join(",")}}`].join("\n");
  return [...imports, ...setup, `export {__r as __modelRegion};`, ...exposed.map(([name, value]) => `export const ${name} = ${value};`)].join("\n") + "\n";
}
