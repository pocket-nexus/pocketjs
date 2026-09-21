/** Executable JS lowering of the Model IR. No interpreter or Promise runs in this class. */
import type { ModelAwaitable, ModelBlock, ModelExpr, ModelFunction, ModelModule, ModelProgram, ModelStmt } from "./aot-model-ir.ts";
import { checkModelVersion } from "./aot-model-ir.ts";
import { assertModelProgram } from "./aot-model-tasks.ts";

export interface ModelJsOptions { vue?: boolean; development?: boolean; runtimeImport?: string; stdImport?: string; tasksImport?: string; reservedNames?: string[] }
export function generateModelJavaScript(program: ModelProgram, module: ModelModule = program.modules[0]!, options: ModelJsOptions = {}): string {
  checkModelVersion(program); assertModelProgram(program);
  const q = JSON.stringify;
  const scalar = (type: ModelExpr["type"]): boolean => {
    if (["number", "boolean", "string", "style", "undefined", "void"].includes(type.kind)) return true;
    const declaration = type.kind === "named" && program.types.find(d => d.name === type.name);
    return !!declaration && (declaration.kind === "enum" || declaration.kind === "newtype" && scalar(declaration.base));
  };
  const baseType = (type: ModelExpr["type"]): ModelExpr["type"] => {
    const declaration = type.kind === "named" && program.types.find(d => d.name === type.name);
    return declaration && declaration.kind === "newtype" ? baseType(declaration.base) : type;
  };
  const colorType = (type: ModelExpr["type"]): boolean => type.kind === "named" && program.types.some(d => d.name === type.name && d.kind === "newtype" && d.unit === "Color");
  const publicNames = new Set([...(options.reservedNames ?? []), module.factory, ...module.signals.flatMap(s => [s.name, s.setter]), ...module.memos.map(m => m.name), ...module.functions.map(f => f.name), ...(module.constants ?? []).map(c => c.name), ...module.refs.map(r => r.name), ...program.types.map(t => t.name)]);
  let prefix = "__pocketModel"; while ([...publicNames].some(name => name?.startsWith(prefix))) prefix += "_";
  const stdAlias = `${prefix}Std`, regionAlias = `${prefix}Region`, tasksAlias = `${prefix}Tasks`, refAlias = `${prefix}Ref`;

  let temporary = 0;
  let taskBody = false;
  let lambdaDepth = 0;
  let lambdaLocals = new Set<number>();
  const local = (id: number) => taskBody && !lambdaLocals.has(id) ? `__locals[${id}]` : `v${id}`;
  let capacityContext = "value";
  const expr = (e: ModelExpr, context?: string): string => {
    const before = capacityContext; if (context) capacityContext = context;
    try {
      let value = rawExpr(e); const cap = "capacity" in e.type ? e.type.capacity : undefined;
      if (e.kind === "lambda") return value;
      if (colorType(e.type)) value = `${stdAlias}.__colorText(${value})`;
      else if (e.type.kind === "named" && baseType(e.type).kind === "number") value = numeric(value, baseType(e.type));
      return cap === undefined || ["signal", "memo", "local", "field"].includes(e.kind) ? value : `${stdAlias}.__capacity(${value},${cap},${q(capacityContext)},${options.development !== false})`;
    } finally { capacityContext = before; }
  };
  const rawExpr = (e: ModelExpr): string => {
    switch (e.kind) {
      case "literal": { const value = typeof e.value === "number" && Object.is(e.value, -0) ? "-0" : q(e.value); return e.type.kind === "number" && e.type.name === "f32" ? `Math.fround(${value})` : value; }
      case "undefined": return "undefined";
      case "local": return local(e.id);
      case "field": return `__r.field(__fields[${e.id}])`;
      case "signal": case "memo": return `__r.read(${e.id})`;
      case "member": return `(${expr(e.object)})${e.optional ? "?." : ""}[${q(e.name)}]`;
      case "index": return `((a,i)=>Number.isInteger(i)&&i>=0&&i<a.length?a[i]:${defaultValue(e.type)})(${expr(e.object)},${expr(e.index)})`;
      case "copy": return `${stdAlias}.copy(${expr(e.value)})`;
      case "cast": return numeric(expr(e.value), e.type);
      case "unary": return numeric(`(${e.operator}${expr(e.operand)})`, e.type);
      case "binary": {
        if (e.operator === "*" && e.type.kind === "number" && e.type.name === "i32") return `Math.imul(${expr(e.left)}, ${expr(e.right)})`;
        return numeric(`(${expr(e.left)} ${e.operator} ${expr(e.right)})`, e.type);
      }
      case "conditional": return `(${expr(e.condition)} ? ${expr(e.consequent)} : ${expr(e.alternate)})`;
      case "template": return `(${e.parts.map(part => typeof part === "string" ? q(part) : `String(${expr(part)})`).join(" + ") || '""'})`;
      case "struct": return `({${e.fields.map(field => `${q(field.name)}: ${expr(field.value)}`).join(", ")}})`;
      case "array": return `[${e.items.map(value => expr(value)).join(", ")}]`;
      case "invoke": return `f${e.callee}(${e.args.map(arg => `${stdAlias}.copy(${expr(arg)})`).join(", ")})`;
      case "builtin": return numeric(`${["String", "Number", "Boolean"].includes(e.name) ? e.name : `${stdAlias}.${e.name}`}(${e.args.map(value => expr(value)).join(", ")})`, e.type);
      case "lambda": {
        const outer = lambdaLocals; lambdaLocals = new Set([...outer, ...e.params.map(p => p.id)]);
        const collect = (value: any): void => { if (!value || typeof value !== "object") return; if (value.binder) lambdaLocals.add(value.binder.id); for (const [key, child] of Object.entries(value)) if (!["loc", "type", "ledger"].includes(key)) { if (Array.isArray(child)) child.forEach(collect); else collect(child); } };
        collect(e.body); lambdaDepth++;
        const value = `(${e.params.map(p => `v${p.id}`).join(", ")}) => {${block(e.body)}}`;
        lambdaDepth--; lambdaLocals = outer; return value;
      }
      case "sequence": return `(() => {${block(e.body)}return ${expr(e.value)};})()`;
    }
  };
  function defaultValue(type: ModelExpr["type"]): string {
    switch (type.kind) {
      case "number": return "0";
      case "boolean": return "false";
      case "string": case "style": return '""';
      case "array": return "[]";
      case "tuple": return `[${type.elements.map(defaultValue).join(",")}]`;
      case "option": case "undefined": case "void": return "undefined";
      case "named": {
        const declaration = program.types.find(d => d.name === type.name)!;
        if (declaration.kind === "enum") return q(declaration.variants[0]);
        if (declaration.kind === "newtype") return declaration.unit === "Color" ? q("#00000000") : defaultValue(declaration.base);
        const fields = declaration.kind === "struct" ? declaration.fields : declaration.variants[0]!.fields;
        return `({${declaration.kind === "union" ? `${q(declaration.discriminant)}:${q(declaration.variants[0]!.name)},` : ""}${fields.map(f => `${q(f.name)}:${defaultValue(f.type)}`).join(",")}})`;
      }
    }
  }
  function numeric(value: string, type: ModelExpr["type"]): string {
    if (colorType(type)) return value;
    type = baseType(type);
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
      case "join": return `{kind:"join",start:()=>f${source.task}(${(source.args ?? []).map(value => expr(value)).join(",")}),wrapped:${source.wrapped}}`;
      case "service": return `{kind:"service",service:${q(source.module)},call:${q(source.call)},args:[${source.args.map(value => expr(value)).join(",")}]}`;
      case "animate": return `{kind:"animate",args:[${source.args.map(value => expr(value)).join(",")}]}`;
      case "all": case "any": return `{kind:${q(source.kind)},members:[${source.members.map(member => `()=>(${wait(member)})`).join(",")}]}`;
    }
  }
  function statement(s: ModelStmt): string {
    switch (s.kind) {
      case "let": return `${taskBody && !lambdaLocals.has(s.binder.id) ? "" : "let "}${local(s.binder.id)} = ${s.binder.owned ? `${stdAlias}.copy(${expr(s.init, s.binder.name)})` : expr(s.init, s.binder.name)};`;
      case "assign": {
        const target = s.target;
        if (target.kind === "field") return `__fields[${target.id}] = ${stdAlias}.copy(${expr(s.value)});__r.fieldChanged();`;
        if (target.kind === "element") return `{const __index=${expr(target.index)};const __value=${stdAlias}.copy(${expr(s.value)});if(Number.isInteger(__index)&&__index>=0&&__index<${local(target.owner)}.length)${local(target.owner)}[__index]=__value;}`;
        return `${"id" in target ? target.kind === "local" ? local(target.id) : `__fields[${target.id}]` : `${local(target.owner)}[${q(target.name)}]`} = ${stdAlias}.copy(${expr(s.value)});`;
      }
      case "set": return `{${s.pre ? `${taskBody ? "" : "const "}${local(s.pre.id)} = __r.read(${s.signal});` : ""}__r.write(${s.signal}, ${expr(s.value, module.signals.find(signal => signal.id === s.signal)?.name)}, ${!!s.writeBack});}`;
      case "if": return `if (${expr(s.condition)}) {${block(s.then)}}${s.else ? ` else {${block(s.else)}}` : ""}`;
      case "for": { const n = `__bound${temporary++}`, start = `__start${temporary++}`; return `{const ${start} = ${s.start ? expr(s.start) : 0};const ${n} = ${expr(s.bound)};for (${taskBody ? "" : "let "}${local(s.binder.id)} = ${start}; ${local(s.binder.id)} ${s.inclusive ? "<=" : "<"} ${n}; ${local(s.binder.id)}++) {${block(s.body)}}}`; }
      case "forOf": return `for (${taskBody ? "" : "const "}${local(s.binder.id)} of ${expr(s.source)}) {${block(s.body)}}`;
      case "switch": return `switch (${expr(s.value)}) {${s.cases.map(c => `${c.value ? `case ${expr(c.value)}` : "default"}: {${block(c.body)}break;}`).join("\n")}}`;
      case "return": return taskBody && !lambdaDepth ? `return {done:true,result:${s.value ? expr(s.value) : "undefined"}};` : `return ${s.value ? `${stdAlias}.copy(${expr(s.value)})` : ""};`;
      case "call": case "start": return `f${s.kind === "call" ? s.callee : s.task}(${s.args.map(arg => `${stdAlias}.copy(${expr(arg)})`).join(",")});`;
      case "expr": return `${expr(s.value)};`;
      case "untrack": case "batch": return `{${block(s.body)}}`;
      case "external": return s.op === "cancel" ? `__tasks.cancel(${s.args.map(value => expr(value)).join(",")});` : `__tasks.command(${q(s.op)},[${s.args.map(value => expr(value)).join(",") }]);`;
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
    `import {createModelRegion as ${regionAlias}} from ${q(options.runtimeImport ?? `@pocketjs/framework/${options.vue ? "vue-vapor" : "solid"}/reactive`)};`,
    `import * as ${stdAlias} from ${q(options.stdImport ?? "@pocketjs/framework/solid/std")};`,
    `import {ModelTasks as ${tasksAlias}} from ${q(options.tasksImport ?? "@pocketjs/framework/model/tasks")};`,
    ...(module.refs.length ? [`import {createNodeRef as ${refAlias}} from "@pocketjs/framework/model/animation";`] : []),
  ];
  const setup = [
    `const __r = ${regionAlias}(${options.development !== false}, ${program.recursionLimit ?? 256});`,
    `const __tasks = new ${tasksAlias}(__r); const __fields = {};`,
    ...module.fields.map(field => `__fields[${field.id}] = ${expr(field.seed, field.name)};__r.fields.set(${q(field.name)},()=>__fields[${field.id}]);`),
    ...module.refs.map(ref => `__r.refs.set(${q(ref.name)},${refAlias}());`),
    ...module.signals.map(signal => `__r.signal(${signal.id},${q(signal.name)},${expr(signal.seed, signal.name)},${signal.capacity ?? ("capacity" in signal.type ? signal.type.capacity : undefined) ?? "undefined"},${scalar(signal.type)});`),
    ...module.memos.map(memo => `__r.memo(${memo.id},${q(memo.name)},${q(memo.inputs)},()=>${expr(memo.body)},${scalar(memo.type)});`),
    ...[...program.modules.filter(m => m.kind === "pure").flatMap(m => m.functions), ...module.functions].map(fn),
    ...module.effects.map(effect => `__r.effect(${effect.id},${q(effect.subscriptions)},()=>{${effect.watch ? `${effect.watch.value ? `const v${effect.watch.value.id} = ${effect.watch.sources.length === 1 ? `__r.read(${effect.watch.sources[0]})` : `[${effect.watch.sources.map(id => `__r.read(${id})`).join(",")}]`};` : ""}${effect.watch.previous ? `const v${effect.watch.previous.id} = __watch${effect.id};` : ""}__watch${effect.id} = ${stdAlias}.copy(${effect.watch.sources.length === 1 ? `__r.read(${effect.watch.sources[0]})` : `[${effect.watch.sources.map(id => `__r.read(${id})`).join(",")}]`});` : ""}${block(effect.body)}},${effect.defer});`),
    `__r.finish(${q(module.schedule)});`,
    ...module.effects.filter(effect => effect.watch && effect.defer).map(effect => `__watch${effect.id} = ${stdAlias}.copy(${effect.watch!.sources.length === 1 ? `__r.read(${effect.watch!.sources[0]})` : `[${effect.watch!.sources.map(id => `__r.read(${id})`).join(",")}]`});`),
  ];
  for (const effect of module.effects) if (effect.watch) setup.unshift(`let __watch${effect.id};`);
  const exposed: [string, string][] = [];
  for (const constant of module.constants ?? []) if (constant.exported) exposed.push([constant.name, expr(constant.value)]);
  for (const ref of module.refs) exposed.push([ref.name, `__r.refs.get(${q(ref.name)})`]);
  for (const signal of module.signals.filter(s => s.exported)) {
    exposed.push([signal.name, options.vue ? `{__v_isRef:true,get value(){return __r.read(${signal.id})},set value(v){__r.write(${signal.id},v)}}` : `()=>__r.read(${signal.id})`]);
    if (signal.setter && !options.vue && module.kind !== "factory") exposed.push([signal.setter, `(v)=>{const next=typeof v === "function" ? v(__r.read(${signal.id})) : v;__r.write(${signal.id},next);return next;}`]);
  }
  for (const memo of module.memos.filter(m => m.exported)) exposed.push([memo.name, options.vue ? `{__v_isRef:true,__v_isReadonly:true,get value(){return __r.read(${memo.id})}}` : `()=>__r.read(${memo.id})`]);
  for (const f of module.functions.filter(f => f.exported)) exposed.push([f.name, `f${f.id}`]);
  if (module.kind === "factory") return [...imports, `export function ${module.factory ?? `create${module.name}`}(${module.params.map(p => `v${p.id}`).join(",")}) {`, ...setup, `return {${exposed.map(([name, value]) => `${q(name)}:${value}`).join(",")}};`, "}"].join("\n");
  return [...imports, `const ${prefix} = (()=>{`, ...setup, `return {${exposed.map(([name,value])=>`${q(name)}:${value}`).join(",")}${exposed.length ? "," : ""}${q(prefix)}:__r};`, "})();",
    ...(!publicNames.has("__modelRegion") ? [`export const __modelRegion = ${prefix}[${q(prefix)}];`] : []),
    ...exposed.map(([name]) => `export const ${name} = ${prefix}[${q(name)}];`)].join("\n") + "\n";
}
