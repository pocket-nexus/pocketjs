// Pocket Clear's data model: plain values mutated through the functions
// below. Rendering pulls from this module after every mutation (app.tsx
// layout()), so nothing here is reactive — the row pool owns the refs.

export interface Todo {
  id: number;
  text: string;
  done: boolean;
}

export interface TodoList {
  id: number;
  title: string;
  todos: Todo[];
}

export const MAX_TODOS = 20;

let nextId = 1;

export function makeTodo(text: string, done = false): Todo {
  return { id: nextId++, text, done };
}

export function makeList(title: string, texts: readonly string[]): TodoList {
  return { id: nextId++, title, todos: texts.map((text) => makeTodo(text)) };
}

/** Display order: the pending stack, then the done pile in completion order. */
export function ordered(list: TodoList): Todo[] {
  const pending: Todo[] = [];
  const done: Todo[] = [];
  for (const todo of list.todos) (todo.done ? done : pending).push(todo);
  return pending.concat(done);
}

export function pendingCount(list: TodoList): number {
  let count = 0;
  for (const todo of list.todos) if (!todo.done) count += 1;
  return count;
}

/** Insert a new todo at `index` within the PENDING stack. Returns null at
 *  the pool cap so every create affordance degrades to a no-op together. */
export function insertTodo(list: TodoList, index: number, text: string): Todo | null {
  if (list.todos.length >= MAX_TODOS) return null;
  const todo = makeTodo(text);
  let seen = 0;
  for (let i = 0; i < list.todos.length; i += 1) {
    if (list.todos[i].done) continue;
    if (seen === index) {
      list.todos.splice(i, 0, todo);
      return todo;
    }
    seen += 1;
  }
  list.todos.push(todo);
  return todo;
}

export function removeTodo(list: TodoList, todo: Todo): void {
  const i = list.todos.indexOf(todo);
  if (i >= 0) list.todos.splice(i, 1);
}

/** Completing moves the todo to the end of the done pile (ordered() shows it
 *  under the pending stack); un-completing appends to the pending stack. */
export function setDone(list: TodoList, todo: Todo, done: boolean): void {
  removeTodo(list, todo);
  todo.done = done;
  list.todos.push(todo);
}

/** Move a pending todo between positions in the pending stack. */
export function movePending(list: TodoList, from: number, to: number): void {
  const pending = ordered(list).filter((todo) => !todo.done);
  if (from < 0 || from >= pending.length || to < 0 || to >= pending.length || from === to) return;
  const todo = pending[from];
  removeTodo(list, todo);
  pending.splice(from, 1);
  pending.splice(to, 0, todo);
  // Rebuild: reordered pending stack, then the untouched done pile.
  const done = list.todos.filter((t) => t.done);
  list.todos = pending.concat(done);
}

export function clearDone(list: TodoList): number {
  const before = list.todos.length;
  list.todos = list.todos.filter((todo) => !todo.done);
  return before - list.todos.length;
}

/** The seed data doubles as the gesture manual. Lists and items match the
 *  reference demo's defaults, with two changes: the pinch row documents the
 *  working gesture (the reference shipped "Pinch is still WIP."), and the
 *  credit list points back at the original and its author. */
export function seedLists(): TodoList[] {
  return [
    makeList("How to Use", [
      "Swipe right to complete",
      "Swipe left to delete",
      "Tap to edit",
      "Long tap to reorder",
      "Pull down to create new item",
      "Or tap in empty space below",
      "Pull down more to go back",
      "Pull up to clear",
      "Pinch two rows apart to insert",
    ]),
    makeList("This is a demo", [
      "About HTML5",
      "Walk the dog",
      "Read Node.js book",
      "Make a game",
      "Make a CMS",
      "Wanna fork?",
      "Fork me yo",
      "Yeah",
      "I've run out of stuff",
      "OK Test",
      "Moar test",
      "Moar test",
      "Moar test",
      "Moar test",
    ]),
    makeList("PocketJS + Vue Vapor", [
      "Tribute to @evanyou",
      "clear.evanyou.me",
    ]),
    makeList("Test", ["Test"]),
    makeList("Test", ["Test"]),
    makeList("Test", []),
    makeList("Test", []),
    makeList("Test", []),
    makeList("Test", []),
    makeList("Test", []),
    makeList("Test", ["Test"]),
  ];
}
