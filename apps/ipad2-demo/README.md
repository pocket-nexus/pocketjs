# iPad 2 (A1396) - PocketJS Target

## Status: WORKING

- ARMv7, iOS 6.1.3, GL ES 2.0, 512 MB RAM
- 60 fps, 42 flexbox nodes, 9 GL draws/frame
- globalThis.net - HTTP GET/POST via NSURLConnection (synchronous)

## Network (globalThis.net)

First native implementation of the v0.10.0 net spec on any PocketJS target.

- 2 concurrent slots, 256 KB max response body
- TLS 1.2 via tlsfix.dylib (MobileSubstrate)
- Synchronous - blocks the game loop until response arrives

### API

    let h = net.start(JSON.stringify({url: "https://example.com"}));
    let buf = new ArrayBuffer(262144);
    let n = net.take(h, buf);
    let events = net.poll();

## What's next (NOT implemented)

- WebSocket (RFC 6455) - needs CFSocket + frame reader/writer + thread
- Streaming / chunked responses
- 3+ concurrent connections
- Response bodies > 256 KB

## Build

    bun tools/ipad2.ts build
    ldid -S dist/ipad2/PocketJSiPad2.app/PocketJSiPad2
    ideviceinstaller install dist/ipad2/PocketJSiPad2.app
