# pocket_guest_quickjs

This component owns a QuickJS realm and attaches the generated
`engine/guest-quickjs` binding through `pocket_guest_idf_vtable`. Platform code
provides PSRAM allocation with internal-memory fallback, heap/stack limits,
promise rejection reporting and cancellation. UI operations, asset mounting
and frame argument packing come from the generated guest.

**The guest borrows package bytes in place until shutdown, so the
immutable-buffer checks must reject JS writes before they reach flash.**
`prepare_quickjs.py` checks the official
espressif/quickjs-ng 0.14.0 source digest and patches reverse/species write
checks into a build-directory copy. An unknown source digest fails the build.

The guest evaluates a package's bytecode section when its envelope names
`esp-idf-quickjs-ng-0.14.0`, the engine ABI of the component this guest
links (`contracts/generated/pocket_quickjs_abi.h`; a static assertion ties
the constant to the QuickJS-NG version). Another build's bytecode is
UNSUPPORTED and the runtime evaluates the source section.

`pocket_guest_idf_interrupt` is safe from a stopping task. Other calls execute
on the runtime owner task. Join that task and destroy the runtime before
`pocket_guest_idf_destroy` releases the realm.
