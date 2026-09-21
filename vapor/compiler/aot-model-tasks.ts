/** Lower async bodies into states and retain locals needed by later states or waits. */
import { checkModelVersion, emptyLedger, type ModelAwaitable, type ModelBinder, type ModelBlock, type ModelExpr, type ModelProgram, type ModelStmt, type ModelTaskState } from "./aot-model-ir.ts";
import { AotCompileError, I32 } from "./aot-ir.ts";

function objects(value: unknown, visit: (node: any) => void): void {
  if (!value || typeof value !== "object") return;
  if (Array.isArray(value)) { value.forEach(v => objects(v, visit)); return; }
  visit(value);
  for (const [key, child] of Object.entries(value)) if (!["loc", "ledger", "type"].includes(key)) objects(child, visit);
}

export function lowerModelTasks(program: ModelProgram): ModelProgram {
  checkModelVersion(program);
  let generated = 1;
  objects(program, n => { if (typeof n.id === "number") generated = Math.max(generated, n.id + 1); });
  for (const module of program.modules) {
    module.tasks = [];
    for (const fn of module.functions.filter(f => f.async)) {
      const states: ModelTaskState[] = [];
      const binders = new Map<number, ModelBinder>(fn.params.map(b => [b.id, b]));
      objects(fn.body, n => { if (n.binder) binders.set(n.binder.id, n.binder); });
      const state = (body: ModelBlock = { stmts: [] }, rest: Partial<ModelTaskState> = {}) => {
        const id = states.length; states.push({ id, body, ...rest }); return id;
      };
      const makeExpr = (node: object, type: any = I32): ModelExpr => ({ ...node, type, loc: fn.loc ?? { file: module.file, line: 1, column: 1, offset: 0 }, ledger: emptyLedger() }) as ModelExpr;
      const local = (b: ModelBinder) => makeExpr({ kind: "local", id: b.id }, b.type);
      const hidden = (name: string, type: any = I32) => { const b = { id: generated++, name, type, owned: true }; binders.set(b.id, b); return b; };
      const compile = (block: ModelBlock, continuation: number): number => {
        let next = continuation;
        for (let i = block.stmts.length - 1; i >= 0; i--) {
          const stmt = block.stmts[i]!;
          switch (stmt.kind) {
            case "await": next = state(undefined, { suspend: stmt.source, resume: stmt.binder, next }); break;
            case "if": next = state(undefined, { branch: { condition: stmt.condition, then: compile(stmt.then, next), else: stmt.else ? compile(stmt.else, next) : next } }); break;
            case "batch": case "untrack": next = compile(stmt.body, next); break;
            case "for": {
              const limit = hidden(`__bound_${stmt.binder.id}`);
              const check = state();
              const increment = state({ stmts: [{ kind: "assign", target: { kind: "local", id: stmt.binder.id }, value: makeExpr({ kind: "binary", operator: "+", left: local(stmt.binder), right: makeExpr({ kind: "literal", value: 1 }) }) }] }, { next: check });
              const advance = stmt.inclusive ? state(undefined, { branch: { condition: makeExpr({ kind: "binary", operator: "===", left: local(stmt.binder), right: local(limit) }, { kind: "boolean" }), then: next, else: increment } }) : increment;
              const body = compile(stmt.body, advance); states[body]!.loop = true;
              states[check]!.branch = { condition: makeExpr({ kind: "binary", operator: stmt.inclusive ? "<=" : "<", left: local(stmt.binder), right: local(limit) }, { kind: "boolean" }), then: body, else: next };
              next = state({ stmts: [{ kind: "let", binder: limit, init: stmt.bound }, { kind: "let", binder: stmt.binder, init: stmt.start ?? makeExpr({ kind: "literal", value: 0 }) }] }, { next: check });
              break;
            }
            case "forOf": {
              const collection = hidden(`__items_${stmt.binder.id}`, stmt.source.type), index = hidden(`__index_${stmt.binder.id}`), limit = hidden(`__length_${stmt.binder.id}`);
              const check = state();
              const increment = state({ stmts: [{ kind: "assign", target: { kind: "local", id: index.id }, value: makeExpr({ kind: "binary", operator: "+", left: local(index), right: makeExpr({ kind: "literal", value: 1 }) }) }] }, { next: check });
              const body = compile({ stmts: [{ kind: "let", binder: stmt.binder, init: makeExpr({ kind: "index", object: local(collection), index: local(index) }, stmt.binder.type) }, ...stmt.body.stmts] }, increment);
              states[body]!.loop = true;
              states[check]!.branch = { condition: makeExpr({ kind: "binary", operator: "<", left: local(index), right: local(limit) }, { kind: "boolean" }), then: body, else: next };
              next = state({ stmts: [{ kind: "let", binder: collection, init: stmt.source }, { kind: "let", binder: index, init: makeExpr({ kind: "literal", value: 0 }) }, { kind: "let", binder: limit, init: makeExpr({ kind: "builtin", name: "len", args: [local(collection)] }) }] }, { next: check });
              break;
            }
            case "switch": {
              const value = hidden(`__switch_${generated}`, stmt.value.type);
              let branch = stmt.cases.find(c => !c.value); let target = branch ? compile(branch.body, next) : next;
              for (const arm of [...stmt.cases].reverse()) if (arm.value) target = state(undefined, { branch: { condition: makeExpr({ kind: "binary", operator: "===", left: local(value), right: arm.value }, { kind: "boolean" }), then: compile(arm.body, next), else: target } });
              next = state({ stmts: [{ kind: "let", binder: value, init: stmt.value }] }, { next: target }); break;
            }
            case "return": next = state({ stmts: [stmt] }); break;
            default: {
              // A straight-line run shares one state, preserving the number of suspension segments.
              const following = states[next];
              if (following && !following.branch && next !== continuation) { following.body.stmts.unshift(stmt); }
              else next = state({ stmts: [stmt] }, { next });
            }
          }
        }
        return next;
      };
      const end = state();
      const entry = compile(fn.body, end);
      // Remove unreachable states and assign entry zero, then successor order.
      const order: number[] = [], seen = new Set<number>();
      const walk = (id: number) => { if (seen.has(id)) return; seen.add(id); order.push(id); const s = states[id]!; if (s.next !== undefined) walk(s.next); if (s.branch) { walk(s.branch.then); walk(s.branch.else); } };
      walk(entry);
      const ids = new Map(order.map((id, n) => [id, n]));
      const lowered = order.map(id => { const s = states[id]!; return { ...s, id: ids.get(id)!, next: s.next === undefined ? undefined : ids.get(s.next), branch: s.branch ? { ...s.branch, then: ids.get(s.branch.then)!, else: ids.get(s.branch.else)! } : undefined }; });
      const uses: Set<number>[] = [], defs: Set<number>[] = [];
      for (const s of lowered) {
        const use = new Set<number>(), def = new Set<number>();
        const exprUses = (value: unknown) => objects(value, n => { if (n.kind === "local" && !def.has(n.id)) use.add(n.id); });
        for (const stmt of s.body.stmts) {
          if (stmt.kind === "let") { exprUses(stmt.init); def.add(stmt.binder.id); }
          else if (stmt.kind === "assign" && stmt.target.kind === "local") { exprUses(stmt.value); def.add(stmt.target.id); }
          else exprUses(stmt);
        }
        exprUses(s.suspend); exprUses(s.branch?.condition);
        uses.push(use); defs.push(def);
      }
      const live = lowered.map(() => new Set<number>());
      let changed: boolean;
      do {
        changed = false;
        for (let i = lowered.length - 1; i >= 0; i--) {
          const s = lowered[i]!, next = s.branch ? [s.branch.then, s.branch.else] : s.next === undefined ? [] : [s.next];
          const incoming = new Set(uses[i]);
          for (const id of next) for (const b of live[id]!) if (!defs[i]!.has(b) && s.resume?.id !== b) incoming.add(b);
          if (incoming.size !== live[i]!.size || [...incoming].some(b => !live[i]!.has(b))) { live[i] = incoming; changed = true; }
        }
      } while (changed);
      const fields = new Set<number>();
      // Match arms have separate lexical scopes even when a transition does not suspend.
      for (const s of lowered) for (const next of s.branch ? [s.branch.then, s.branch.else] : s.next === undefined ? [] : [s.next]) for (const b of live[next]!) fields.add(b);
      // until reads its captured environment while suspended, before the successor runs.
      const retainWaitCaptures = (wait: ModelAwaitable): void => {
        if (wait.kind === "until") {
          const captured = new Set<number>(), local = new Set<number>();
          objects(wait.predicate, node => {
            if (node.kind === "local") captured.add(node.id);
            if (node.binder) local.add(node.binder.id);
            if (node.kind === "lambda") for (const parameter of node.params) local.add(parameter.id);
          });
          for (const id of captured) if (!local.has(id)) fields.add(id);
        } else if (wait.kind === "all" || wait.kind === "any") wait.members.forEach(retainWaitCaptures);
      };
      for (const state of lowered) if (state.suspend) retainWaitCaptures(state.suspend);
      module.tasks.push({ id: fn.id, fn: fn.id, fields: [...fields].sort((a, b) => a - b).filter(id => binders.has(id)).map(id => ({ ...binders.get(id)!, owned: true, viewOf: undefined })), states: lowered });
    }
    const edges = new Map<number, Set<number>>();
    for (const fn of module.functions) {
      const calls = new Set<number>();
      objects(fn.body, n => { if (n.kind === "start" || n.kind === "join") calls.add(n.task); if (n.kind === "call" || n.kind === "invoke") calls.add(n.callee); });
      edges.set(fn.id, calls);
    }
    for (const task of module.tasks) {
      const path: number[] = [];
      const visit = (id: number): void => {
        if (path.includes(id)) {
          if (id !== task.fn) return;
          const names = [...path.slice(path.indexOf(id)), id].map(n => module.functions.find(f => f.id === n)?.name ?? String(n));
          const fn = module.functions.find(f => f.id === id)!;
          throw new AotCompileError([{ ...(fn.loc ?? { file: module.file, line: 1, column: 1, offset: 0 }), severity: "error", message: `cycle of task starts: ${names.join(" → ")}` }]);
        }
        path.push(id); for (const to of edges.get(id) ?? []) visit(to); path.pop();
      };
      visit(task.fn);
    }
  }
  return program;
}

/** Validate all ten Model IR invariants before an executable consumer loads it. */
export function assertModelProgram(program: ModelProgram): void {
  checkModelVersion(program);
  const fail = (message: string): never => { throw new Error(`Invalid Model IR: ${message}`); };
  const pureFunctions = program.modules.filter(m => m.kind === "pure").flatMap(m => m.functions);
  const atomic = (e: ModelExpr) => e.kind === "literal" || e.kind === "undefined" || e.kind === "local";
  for (const m of program.modules) {
    if (m.kind === "pure" && (m.signals.length || m.fields.length || m.memos.length || m.effects.length || m.tasks.length)) fail(`pure module ${m.name} contains state`);
    const declared = [...m.signals, ...m.fields, ...m.memos, ...m.effects, ...m.functions, ...m.params, ...m.refs];
    if (new Set(declared.map(d => d.id)).size !== declared.length) fail(`duplicate declaration id in ${m.name}`);
    const signals = new Set(m.signals.map(s => s.id)), memos = new Set(m.memos.map(s => s.id)), fields = new Set(m.fields.map(s => s.id));
    const functions = new Map([...pureFunctions, ...m.functions].map(f => [f.id, f]));
    const nodeIds = [...m.memos.map(x => x.id), ...m.effects.map(x => x.id)];
    if (m.schedule.length !== nodeIds.length || new Set(m.schedule).size !== nodeIds.length || nodeIds.some(id => !m.schedule.includes(id))) fail(`schedule of ${m.name} does not visit every node once`);
    const origins = new Map<number, { signal: number; generation: number }>();
    const generations = new Map(m.signals.map(s => [s.id, 0]));
    const owned = new Map<number, boolean>();
    let declaredLocals = new Set<number>();
    const typeCheck = (type: any): boolean => !!type && (type.kind === "number" ? ["i8", "i16", "i32", "i64", "u8", "u16", "u32", "u64", "usize", "f32", "f64"].includes(type.name) : ["string", "boolean", "void", "undefined", "style", "named"].includes(type.kind) || type.kind === "array" && typeCheck(type.element) || type.kind === "option" && typeCheck(type.value) || type.kind === "tuple" && type.elements.every(typeCheck));
    const bind = (b: ModelBinder, scope: Set<number>) => { if (declaredLocals.has(b.id) || declared.some(d => d.id === b.id)) fail(`duplicate binder ${b.id}`); if (!typeCheck(b.type)) fail(`invalid type of ${b.name}`); declaredLocals.add(b.id); scope.add(b.id); owned.set(b.id, b.owned); };
    const checkCall = (callee: number, args: ModelExpr[], scope: Set<number>) => { if (!functions.has(callee)) fail(`undeclared function ${callee}`); for (const arg of args) { if (!atomic(arg)) fail(`call ${callee} has a non-atomic argument`); checkExpr(arg, scope); } };
    const checkExpr = (expr: ModelExpr | undefined, scope: Set<number>): void => {
      if (!expr) return;
      if (!typeCheck(expr.type)) fail(`expression ${expr.kind} has no admissible type`);
      if (!expr.ledger) fail(`expression ${expr.kind} has no ledger`);
      switch (expr.kind) {
        case "local": if (!scope.has(expr.id)) fail(`undeclared local ${expr.id}`); break;
        case "signal": if (!signals.has(expr.id)) fail(`undeclared signal ${expr.id}`); break;
        case "memo": if (!memos.has(expr.id)) fail(`undeclared memo ${expr.id}`); break;
        case "field": if (!fields.has(expr.id)) fail(`undeclared field ${expr.id}`); break;
        case "invoke": checkCall(expr.callee, expr.args, scope); break;
        case "lambda": { const inner = new Set(scope); for (const param of expr.params) bind(param, inner); checkBlock(expr.body, inner, true, false); break; }
        case "sequence": { const inner = new Set(scope); checkBlock(expr.body, inner, true, false); checkExpr(expr.value, inner); break; }
        case "member": checkExpr(expr.object, scope); break;
        case "index": checkExpr(expr.object, scope); checkExpr(expr.index, scope); break;
        case "binary": checkExpr(expr.left, scope); checkExpr(expr.right, scope); break;
        case "unary": checkExpr(expr.operand, scope); break;
        case "conditional": checkExpr(expr.condition, scope); checkExpr(expr.consequent, scope); checkExpr(expr.alternate, scope); break;
        case "copy": case "cast": checkExpr(expr.value, scope); break;
        case "struct": for (const f of expr.fields) checkExpr(f.value, scope); break;
        case "array": for (const e of expr.items) checkExpr(e, scope); break;
        case "template": for (const part of expr.parts) if (typeof part !== "string") checkExpr(part, scope); break;
        case "builtin": for (const arg of expr.args) checkExpr(arg, scope); break;
        case "literal": case "undefined": break;
        default: fail(`unknown expression ${(expr as any).kind}`);
      }
    };
    const checkAwait = (source: ModelAwaitable, scope: Set<number>): void => {
      switch (source.kind) {
        case "all": case "any": for (const child of source.members) checkAwait(child, scope); break;
        case "frames": checkExpr(source.count, scope); break;
        case "after": checkExpr(source.ms, scope); break;
        case "until": checkExpr(source.predicate, scope); if (source.predicate.ledger.writes.length || source.predicate.ledger.external || source.predicate.ledger.reads.some(id => !signals.has(id))) fail("until predicate must be pure over signals"); break;
        case "service": case "animate": for (const arg of source.args) checkExpr(arg, scope); break;
        case "join": if (!functions.get(source.task)?.async) fail(`join target ${source.task} is not async`); for (const arg of source.args ?? []) checkExpr(arg, scope); break;
        default: fail(`unknown awaitable ${(source as any).kind}`);
      }
    };
    const checkBlock = (block: ModelBlock, scope: Set<number>, inFunction: boolean, async: boolean): void => {
      for (const s of block.stmts) {
        switch (s.kind) {
          case "let": {
            checkExpr(s.init, scope); bind(s.binder, scope);
            const source = s.init.kind === "signal" ? { signal: s.init.id, generation: generations.get(s.init.id)! } : s.init.kind === "local" ? origins.get(s.init.id) : undefined;
            if (source && !s.binder.owned) origins.set(s.binder.id, source);
            break;
          }
          case "set": {
            const p = new Set(scope); if (s.pre) { bind(s.pre, p); origins.set(s.pre.id, { signal: s.signal, generation: generations.get(s.signal)! }); }
            if (!signals.has(s.signal)) fail(`undeclared signal ${s.signal}`); checkExpr(s.value, p);
            if (s.writeBack) {
              const source = s.value.kind === "signal" ? { signal: s.value.id, generation: generations.get(s.value.id)! } : s.value.kind === "local" ? origins.get(s.value.id) : undefined;
              if (!source || source.signal !== s.signal || source.generation !== generations.get(s.signal)) fail(`invalid write-back of signal ${s.signal}`);
            } else generations.set(s.signal, generations.get(s.signal)! + 1);
            break;
          }
          case "if": checkExpr(s.condition, scope); checkBlock(s.then, new Set(scope), inFunction, async); if (s.else) checkBlock(s.else, new Set(scope), inFunction, async); break;
          case "for": case "forOf": { checkExpr(s.kind === "for" ? s.bound : s.source, scope); if (s.kind === "for") checkExpr(s.start, scope); const inner = new Set(scope); bind(s.binder, inner); checkBlock(s.body, inner, inFunction, async); break; }
          case "switch": checkExpr(s.value, scope); for (const c of s.cases) { checkExpr(c.value, scope); checkBlock(c.body, new Set(scope), inFunction, async); } break;
          case "batch": case "untrack": checkBlock(s.body, new Set(scope), inFunction, async); break;
          case "return": if (!inFunction) fail("return outside a function"); checkExpr(s.value, scope); break;
          case "await": if (!async) fail("await outside an async function"); checkAwait(s.source, scope); if (s.binder) bind(s.binder, scope); break;
          case "assign": {
            if (s.target.kind === "element" || s.target.kind === "member") { if (!scope.has(s.target.owner)) fail(`undeclared local ${s.target.owner}`); if (!owned.get(s.target.owner)) fail(`write through a view ${s.target.owner}`); origins.delete(s.target.owner); if (s.target.kind === "element") checkExpr(s.target.index, scope); }
            else if (s.target.kind === "local") { if (!scope.has(s.target.id)) fail(`undeclared local ${s.target.id}`); origins.delete(s.target.id); }
            else if (!fields.has(s.target.id)) fail(`undeclared field ${s.target.id}`);
            checkExpr(s.value, scope); break;
          }
          case "call": checkCall(s.callee, s.args, scope); break;
          case "start": if (!functions.get(s.task)?.async) fail(`start target ${s.task} is not async`); for (const arg of s.args) checkExpr(arg, scope); break;
          case "expr": checkExpr(s.value, scope); break;
          case "external": for (const arg of s.args) checkExpr(arg, scope); break;
          default: fail(`unknown statement ${(s as any).kind}`);
        }
      }
    };
    const base = new Set(m.params.map(p => p.id));
    for (const s of [...m.signals, ...m.fields]) checkExpr(s.seed, base);
    for (const memo of m.memos) {
      checkExpr(memo.body, base);
      if (memo.body.ledger.external || memo.body.ledger.writes.length || memo.body.ledger.reads.some(id => fields.has(id))) fail(`memo ${memo.name} is impure`);
      objects(memo.body, n => { if (n.kind === "field") fail(`memo ${memo.name} is impure`); });
      if (memo.inputs.some(id => !signals.has(id) && !memos.has(id))) fail(`memo ${memo.name} has an undeclared input`);
    }
    const writes = (body: ModelBlock, seen = new Set<number>()): Set<number> => {
      const result = new Set<number>();
      objects(body, n => {
        if (n.kind === "set") result.add(n.signal);
        if (n.kind === "assign" && n.target.kind === "field") result.add(n.target.id);
        if ((n.kind === "call" || n.kind === "invoke" || n.kind === "start") && !seen.has(n.callee ?? n.task)) { const id = n.callee ?? n.task; seen.add(id); const f = functions.get(id); if (f) for (const w of writes(f.body, seen)) result.add(w); }
      }); return result;
    };
    for (const f of m.functions) {
      declaredLocals = new Set(); origins.clear(); owned.clear(); const scope = new Set(base); for (const param of f.params) bind(param, scope);
      checkBlock(f.body, scope, true, f.async);
      if (m.kind === "pure" && (f.ledger.external || f.ledger.reads.length || f.ledger.writes.length)) fail(`pure function ${f.name} has model or host effects`);
    }
    for (const ef of m.effects) {
      declaredLocals = new Set(); origins.clear(); owned.clear(); const scope = new Set(base);
      for (const b of [ef.watch?.value, ef.watch?.previous]) if (b) bind(b, scope);
      checkBlock(ef.body, scope, true, false);
      if (ef.subscriptions.some(id => !signals.has(id) && !memos.has(id))) fail(`effect ${ef.id} has an undeclared subscription`);
      if (!ef.declared) {
        const must = ef.ledger.mustSubscribe ?? ef.ledger.subscriptions, may = ef.ledger.maySubscribe ?? ef.ledger.subscriptions;
        if (new Set(must).size !== new Set(may).size || must.some(id => !may.includes(id)) || new Set(must).size !== new Set(ef.subscriptions).size || must.some(id => !ef.subscriptions.includes(id))) fail(`effect ${ef.id} subscriptions differ from must-subscribe`);
      }
    }
    const producers = new Map<number, number[]>();
    for (const memo of m.memos) producers.set(memo.id, [memo.id]);
    for (const effect of m.effects) for (const id of writes(effect.body)) producers.set(id, [...(producers.get(id) ?? []), effect.id]);
    for (const node of [...m.memos.map(x => ({ id: x.id, inputs: x.inputs })), ...m.effects.map(x => ({ id: x.id, inputs: x.subscriptions }))]) for (const input of node.inputs) for (const from of producers.get(input) ?? []) if (m.schedule.indexOf(from) >= m.schedule.indexOf(node.id)) fail(`schedule edge ${from} → ${node.id} is reversed or cyclic`);
    const asyncIds = m.functions.filter(f => f.async).map(f => f.id);
    if (m.tasks.length !== asyncIds.length || new Set(m.tasks.map(t => t.fn)).size !== asyncIds.length || asyncIds.some(id => !m.tasks.some(t => t.fn === id))) fail(`coroutine table of ${m.name} does not cover async functions`);
    for (const task of m.tasks) {
      const stateIds = new Set(task.states.map(s => s.id));
      if (!stateIds.has(0) || stateIds.size !== task.states.length) fail(`invalid state ids in task ${task.id}`);
      const fieldIds = new Set<number>();
      for (const field of task.fields) { if (!field.owned || field.viewOf !== undefined) fail(`task field ${field.name} is a view`); if (fieldIds.has(field.id)) fail(`duplicate task field ${field.id}`); fieldIds.add(field.id); }
      for (const s of task.states) {
        objects(s.body, n => { if (n.kind === "await") fail(`await remains in task ${task.id} state ${s.id}`); });
        if (s.next !== undefined && !stateIds.has(s.next) || s.branch && (!stateIds.has(s.branch.then) || !stateIds.has(s.branch.else))) fail(`task ${task.id} has an undeclared successor`);
        if (s.suspend && s.branch || s.resume && !s.suspend) fail(`invalid suspension in task ${task.id}`);
      }
    }
  }
  // Recompute liveness and the start graph from function bodies instead of trusting metadata.
  const rebuilt = lowerModelTasks(structuredClone(program));
  for (let i = 0; i < program.modules.length; i++) for (const task of program.modules[i]!.tasks) {
    const expected = rebuilt.modules[i]!.tasks.find(t => t.fn === task.fn)!;
    const names = task.fields.map(f => f.name).sort(), wanted = expected.fields.map(f => f.name).sort();
    if (JSON.stringify(names) !== JSON.stringify(wanted)) fail(`task ${task.id} fields differ from suspension liveness`);
  }
}
