# pocket_runner

**The optional runner creates one FreeRTOS owner task.** Its deadlines and
skipped-tick policy come from `pocket_tick_schedule`, backed by runtime timing.
Each due tick invokes `pocket_runtime_tick` once. The runtime samples registered
inputs and completes presentation before returning.

Configure `interrupt` with `pocket_guest_idf_interrupt` when the guest is
QuickJS. `pocket_runner_stop` requests interruption and waits for task exit.
A timeout leaves the handle and registered contexts live; retry the join before
destroying them. The caller destroys the runtime and drivers after a successful
stop.
