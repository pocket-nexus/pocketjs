# pocket-guest-jsc

A PocketJS guest on JavaScriptCore for Apple platforms. `JscGuest` implements
`pocket_runtime::Guest`: it mounts the generated `ui` namespace into a
JavaScriptCore global context, evaluates the package script and calls
`globalThis.frame` once per runtime turn.

- **The binding follows `pocket-guest-rquickjs`'s canonical profile**:
  required arguments, ECMAScript ToInt32 for integers, non-negative clamping,
  scalars coerced before strings and byte views borrowed last, unpaired
  surrogates as three U+FFFD (the lossy decoding of QuickJS's WTF-8), and the
  same eleven `frame` arguments.
- **Microtasks drain when the outermost API call returns**, so each
  `evaluate` and `frame` ends with its jobs run; `collect` has nothing to do.
- **Hosts mount their own namespaces** with `JscGuest::with_setup`, which runs
  on every new realm after `ui` and before the package evaluates, and reach
  the realm afterwards through `Realm::ctx`.
- **The JIT needs the `com.apple.security.cs.allow-jit` entitlement** on
  macOS; an unsigned process runs the interpreter.
- The engine has no heap limit; `GuestEnvironment::heap_limit` is not applied.

The crate is empty on targets other than Apple's.
