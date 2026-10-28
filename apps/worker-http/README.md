# Worker HTTP on Nintendo 3DS

Build with `bun tools/3ds.ts worker-http`. Pair the system Pocket Link with a
companion that advertises `net.stream`, then open this app and press B. The
worker requests `https://example.com/`; it publishes byte counts and terminal
status through the `progress` snapshot. The UI sends explicit requests through
the `request` ring. Failed requests are not replayed; press B to start another.

The example holds no complete response body. Status `-3` means the result is
unknown, including a connection loss after the request may have reached its
server. The native host's receive window is 8 KiB and the request limit is
256 KiB. The UI displays the most recent snapshot once per frame, so it may
skip intermediate progress states.
