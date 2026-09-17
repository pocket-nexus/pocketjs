/** Four independent ledgers and the stable causality schedule (MODEL_AOT §3). */
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
      case "builtin": result = combineModelLedgers(...e.args.map(expr)); break;
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
}
