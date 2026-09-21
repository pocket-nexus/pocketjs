/** Track reads, writes, subscriptions and host effects to derive a stable reaction schedule. */
import { emptyLedger, type Ledger, type ModelExpr, type ModelBlock, type ModelStmt, type ModelProgram, type ModelAwaitable } from "./aot-model-ir.ts";
import { fail, location } from "./aot-types.ts";
const sorted = (values: number[]) => [...new Set(values)].sort((a, b) => a - b);
export function combineModelLedgers(...values: Ledger[]): Ledger {
  return { reads: sorted(values.flatMap(x => x.reads)), writes: sorted(values.flatMap(x => x.writes)), subscriptions: sorted(values.flatMap(x => x.subscriptions)), external: values.some(x => x.external), maySubscribe: sorted(values.flatMap(x => x.maySubscribe ?? x.subscriptions)), mustSubscribe: sorted(values.flatMap(x => x.mustSubscribe ?? x.subscriptions)) };
}
function branches(test: Ledger, choices: Ledger[]): Ledger {
  const result = combineModelLedgers(test, ...choices);
  const must = choices.length ? (choices[0]!.mustSubscribe ?? choices[0]!.subscriptions).filter(id => choices.every(x => (x.mustSubscribe ?? x.subscriptions).includes(id))) : [];
  result.mustSubscribe = sorted([...(test.mustSubscribe ?? test.subscriptions), ...must]); return result;
}
export function analyzeModelLedgers(program: ModelProgram): void {
  const functions = new Map(program.modules.flatMap(m => m.functions.map(f => [f.id, f] as const)));
  const fields = new Set(program.modules.flatMap(m => m.fields.map(f => f.id)));
  const tasks = new Map(program.modules.flatMap(m => m.tasks.map(t => [t.fn, t] as const)));
  function primitive(type: ModelExpr["type"]): boolean {
    if(["number","boolean","string","undefined","void"].includes(type.kind))return true;
    const definition=type.kind==="named"?program.types.find(value=>value.name===type.name):undefined;
    return definition?.kind==="enum"||definition?.kind==="newtype"&&primitive(definition.base);
  }
  function expr(e: ModelExpr): Ledger {
    let result = emptyLedger();
    switch (e.kind) {
      case "signal": case "memo": result = { reads: [e.id], writes: [], subscriptions: [e.id], external: false }; break;
      case "field": result.reads = [e.id]; break;
      case "unary": result = expr(e.operand); break;
      case "copy": case "cast": result = expr(e.value); break;
      case "member": result = expr(e.object); break;
      case "index": result = combineModelLedgers(expr(e.object), expr(e.index)); break;
      case "binary": result = ["&&", "||", "??"].includes(e.operator) ? branches(expr(e.left), [expr(e.right), emptyLedger()]) : combineModelLedgers(expr(e.left), expr(e.right)); break;
      case "conditional": result = branches(expr(e.condition), [expr(e.consequent), expr(e.alternate)]); break;
      case "template": result = combineModelLedgers(...e.parts.filter(x => typeof x !== "string").map(x => expr(x as ModelExpr))); break;
      case "struct": result = combineModelLedgers(...e.fields.map(x => expr(x.value))); break;
      case "array": result = combineModelLedgers(...e.items.map(expr)); break;
      case "invoke": result = combineModelLedgers(...e.args.map(expr), functions.get(e.callee)?.ledger ?? emptyLedger()); break;
      case "builtin": result = combineModelLedgers(...e.args.map(value => value.kind === "lambda" ? branches(emptyLedger(), [expr(value), emptyLedger()]) : expr(value))); break;
      case "lambda": result = block(e.body); break;
      case "sequence": result = combineModelLedgers(block(e.body), expr(e.value)); break;
    }
    e.ledger = { ...result, maySubscribe: result.maySubscribe ?? result.subscriptions, mustSubscribe: result.mustSubscribe ?? result.subscriptions }; return e.ledger;
  }
  function wait(a: ModelAwaitable): Ledger {
    switch (a.kind) {
      case "frames": return expr(a.count);
      case "after": return expr(a.ms);
      case "until": return expr(a.predicate);
      case "join": return combineModelLedgers(...(a.args ?? []).map(expr), tasks.get(a.task)?.states[0]?.body.ledger ?? emptyLedger(), { ...emptyLedger(), external: true });
      case "service": case "animate": return { ...combineModelLedgers(...a.args.map(expr)), external: true };
      case "all": case "any": return combineModelLedgers(...a.members.map(wait));
    }
  }
  function stmt(s: ModelStmt): Ledger {
    let result = emptyLedger();
    switch (s.kind) {
      case "let": case "expr": result = expr(s.kind === "let" ? s.init : s.value); break;
      case "return": if (s.value) result = expr(s.value); break;
      case "assign": result = expr(s.value); if (s.target.kind === "field") result = combineModelLedgers(result, { ...emptyLedger(), writes: [s.target.id] }); if (s.target.kind === "element") result = combineModelLedgers(result, expr(s.target.index)); break;
      case "set": result = combineModelLedgers(expr(s.value), { reads: s.pre ? [s.signal] : [], writes: [s.signal], subscriptions: [], external: false }); break;
      case "if": result = branches(expr(s.condition), [block(s.then), s.else ? block(s.else) : emptyLedger()]); break;
      case "for": result = combineModelLedgers(s.start ? expr(s.start) : emptyLedger(), expr(s.bound), branches(emptyLedger(), [block(s.body), emptyLedger()])); break;
      case "forOf": result = combineModelLedgers(expr(s.source), branches(emptyLedger(), [block(s.body), emptyLedger()])); break;
      case "switch": result = branches(expr(s.value), [...s.cases.map(x => combineModelLedgers(x.value ? expr(x.value) : emptyLedger(), block(x.body))), ...(s.cases.some(x => !x.value) ? [] : [emptyLedger()])]); break;
      case "call": result = combineModelLedgers(...s.args.map(expr), functions.get(s.callee)?.ledger ?? emptyLedger()); break;
      case "start": result = combineModelLedgers(...s.args.map(expr), tasks.get(s.task)?.states[0]?.body.ledger ?? functions.get(s.task)?.ledger ?? emptyLedger(), { ...emptyLedger(), external: true }); break;
      case "external": result = { ...combineModelLedgers(...s.args.map(expr)), external: true }; break;
      case "batch": result = block(s.body); break;
      case "untrack": result = { ...block(s.body), subscriptions: [], maySubscribe: [], mustSubscribe: [] }; break;
      case "await": result = wait(s.source); break;
    }
    s.ledger = result; return result;
  }
  function returns(s: ModelStmt): boolean { return s.kind === "return" || s.kind === "if" && !!s.else && s.then.stmts.some(returns) && s.else.stmts.some(returns); }
  function block(b: ModelBlock): Ledger {
    let result = emptyLedger(), conditional = false;
    for (const s of b.stmts) {
      const current = stmt(s); result = combineModelLedgers(result, conditional ? { ...current, mustSubscribe: [] } : current);
      if (returns(s)) break;
      if (s.kind === "if" && (s.then.stmts.some(returns) || s.else?.stmts.some(returns))) conditional = true;
    }
    b.ledger = result; return result;
  }
  // Recursive calls are finite equations over finite sets, not recursive lowering.
  for (let iteration = 0; ; iteration++) {
    const before = JSON.stringify([...functions.values()].map(f => f.ledger));
    for (const f of functions.values()) f.ledger = block(f.body);
    for (const task of tasks.values()) for (const state of task.states) state.body.ledger = combineModelLedgers(block(state.body), state.suspend ? wait(state.suspend) : emptyLedger(), state.branch ? expr(state.branch.condition) : emptyLedger());
    if (before === JSON.stringify([...functions.values()].map(f => f.ledger))) break;
    if (iteration > functions.size * (program.modules.reduce((n, m) => n + m.signals.length + m.fields.length + m.memos.length, 0) + 1) + 10) throw new Error("Model ledger fixed point did not converge");
  }
  for (const m of program.modules) {
    for (const signal of m.signals) expr(signal.seed);
    for (const field of m.fields) expr(field.seed);
    for (const memo of m.memos) {
      const ledger = expr(memo.body); memo.inputs = ledger.maySubscribe ?? ledger.subscriptions;
      if (ledger.reads.some(id => fields.has(id))) fail(memo.loc ?? memo.body.loc, `memo ${memo.name} reads a private field`);
      if (ledger.writes.length || ledger.external) fail(memo.loc ?? memo.body.loc, `memo ${memo.name} must be pure`);
    }
    for (const effect of m.effects) {
      const ledger = block(effect.body), may = ledger.maySubscribe ?? ledger.subscriptions, must = ledger.mustSubscribe ?? ledger.subscriptions;
      if (!effect.declared && JSON.stringify(may) !== JSON.stringify(must)) fail(effect.loc ?? location(m.file, ""), "dependencies of this effect depend on control flow; declare them with on([...])");
      if (!effect.declared) effect.subscriptions = must;
      effect.ledger = { ...ledger, subscriptions: effect.subscriptions };
    }
    if (m.kind === "pure") for (const f of m.functions) if (f.ledger.reads.length || f.ledger.writes.length || f.ledger.external) fail(f.loc ?? location(m.file, ""), "pure module functions cannot access model state or host services");
    const nodes = [...m.memos.map(x => ({ id: x.id, name: x.name, writes: [x.id], subscriptions: x.inputs, loc: x.loc })), ...m.effects.map(x => ({ id: x.id, name: `effect:${x.id}`, writes: x.ledger.writes, subscriptions: x.subscriptions, loc: x.loc }))].sort((a, b) => a.id - b.id);
    const edges = new Map(nodes.map(n => [n.id, nodes.filter(other => n.writes.some(id => other.subscriptions.includes(id))).map(x => x.id)]));
    const pending = new Set(nodes.map(n => n.id)), schedule: number[] = [];
    while (pending.size) {
      const next = nodes.find(n => pending.has(n.id) && !nodes.some(other => pending.has(other.id) && edges.get(other.id)!.includes(n.id)));
      if (!next) {
        const chain: number[] = []; let id = pending.values().next().value!;
        while (!chain.includes(id)) { chain.push(id); id = edges.get(id)!.find(x => pending.has(x)) ?? nodes.find(n => pending.has(n.id) && edges.get(n.id)!.includes(id))!.id; }
        const cycle = [...chain.slice(chain.indexOf(id)), id].map(id => nodes.find(n => n.id === id)!.name);
        fail(nodes.find(n => n.id === id)?.loc ?? location(m.file, ""), `reactive cycle: ${cycle.join(" -> ")}`);
      }
      pending.delete(next.id); schedule.push(next.id);
    }
    m.schedule = schedule;
  }
  // A view aliases the current signal only until a write on any reachable path.
  // Callee ledgers are complete here, including recursive helpers and task starts.
  const invalidate = (aliases: Map<number, number>, writes: readonly number[]) => {
    for (const [local, signal] of aliases) if (writes.includes(signal)) aliases.delete(local);
  };
  const intersect = (target: Map<number, number>, choices: Map<number, number>[]) => {
    target.clear();
    for (const [local, signal] of choices[0] ?? []) if (choices.every(choice => choice.get(local) === signal)) target.set(local, signal);
  };
  function valueAlias(value: ModelExpr, aliases: Map<number, number>): number | undefined {
    if (value.kind === "signal") return value.id;
    if (value.kind === "local") return aliases.get(value.id);
    if (value.kind === "sequence") { markBlock(value.body, aliases); return valueAlias(value.value, aliases); }
    if (value.kind === "cast") return valueAlias(value.value, aliases);
    if (value.kind === "conditional") {
      valueAlias(value.condition, aliases);
      const a = new Map(aliases), b = new Map(aliases);
      const left = valueAlias(value.consequent, a), right = valueAlias(value.alternate, b);
      intersect(aliases, [a, b]); return left === right ? left : undefined;
    }
    invalidate(aliases, value.ledger.writes);
    return undefined;
  }
  function markBlock(body: ModelBlock, aliases = new Map<number, number>()) {
    for (const s of body.stmts) {
      if (s.kind === "let") {
        const signal = valueAlias(s.init, aliases);
        if (!s.binder.owned && signal !== undefined) aliases.set(s.binder.id, signal);
      } else if (s.kind === "set") {
        if (s.pre) aliases.set(s.pre.id, s.signal);
        const signal = valueAlias(s.value, aliases);
        delete s.writeBack;
        if (!primitive(s.value.type) && signal === s.signal) s.writeBack = true;
        else invalidate(aliases, [s.signal]);
        if (s.pre) aliases.delete(s.pre.id);
      } else if (s.kind === "if") {
        valueAlias(s.condition, aliases);
        const a = new Map(aliases), b = new Map(aliases);
        markBlock(s.then, a); if (s.else) markBlock(s.else, b);
        intersect(aliases, [a, b]);
      } else if (s.kind === "switch") {
        valueAlias(s.value, aliases);
        const paths = s.cases.map(branch => { const path = new Map(aliases); markBlock(branch.body, path); return path; });
        if (!s.cases.some(branch => !branch.value)) paths.push(new Map(aliases));
        intersect(aliases, paths);
      } else if (s.kind === "for" || s.kind === "forOf") {
        invalidate(aliases, s.ledger?.writes ?? []);
        markBlock(s.body, new Map(aliases));
      } else if (s.kind === "batch" || s.kind === "untrack") markBlock(s.body, aliases);
      else if (s.kind === "await") aliases.clear();
      else {
        if (s.kind === "assign" && s.target.kind === "local") aliases.delete(s.target.id);
        invalidate(aliases, s.ledger?.writes ?? []);
      }
    }
  }
  for (const module of program.modules) {
    for (const fn of module.functions) markBlock(fn.body);
    for (const effect of module.effects) markBlock(effect.body);
    // Lowering clones statements into task states. A resumed view is an owned snapshot.
    for (const task of module.tasks) for (const state of task.states) markBlock(state.body);
  }
}
