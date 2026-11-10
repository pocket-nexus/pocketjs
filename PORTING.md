# Porting Applets to iPad 2

## What works

- HTTP GET/POST via globalThis.net (synchronous, 2 slots, 256KB max)
- TLS 1.2 (tlsfix.dylib)
- SolidJS reactivity, Taffy flexbox, GL ES 2.0
- 768x1024 @2x (384x512 logical)

## What does NOT work

- WebSocket (no CFSocket implementation yet)
- Streaming / chunked responses
- Audio/video playback
- Apps needing >256KB response body
- Apps needing 3+ concurrent connections

## Steps to port an applet

1. Clone applets repo:
   git clone https://github.com/pocket-nexus/applets /tmp/applets

2. Pick an applet that only uses HTTP (check for fetch() or net.start(),
   NO WebSocket, NO streaming, NO audio).

3. Copy the TSX into apps/<name>/

4. Adjust layout:
   - 3DS is 400x240, M5Stack is 800x480, iPad 2 is 768x1024 (landscape)
   - Change any hardcoded dimensions
   - Test with: bun tools/ipad2.ts build

5. Replace fetch() with net.start/take/poll pattern:

   const h = (globalThis as any).net.start(JSON.stringify({url: "https://api.example.com"}));
   const buf = new ArrayBuffer(262144);
   const n = (globalThis as any).net.take(h, buf);
   const body = new TextDecoder().decode(new Uint8Array(buf, 0, n));
   const data = JSON.parse(body);

6. Build and install:

   bun tools/ipad2.ts build
   python3 -c "
   import struct
   path = 'dist/ipad2/PocketJSiPad2.app/PocketJSiPad2'
   data = bytearray(open(path, 'rb').read())
   ncmds = struct.unpack_from('<I', data, 16)[0]
   offset = 28
   for i in range(ncmds):
       cmd, cmdsize = struct.unpack_from('<II', data, offset)
       if cmd == 0xC:
           struct.pack_into('<I', data, offset + 20, 0x00010000)
           struct.pack_into('<I', data, offset + 16, 0x00010000)
       offset += cmdsize
   open(path, 'wb').write(data)
   "
   ldid -S dist/ipad2/PocketJSiPad2.app/PocketJSiPad2
   ideviceinstaller install dist/ipad2/PocketJSiPad2.app

## Revert if something breaks

   git checkout engine/quickjs-c/pocket_runtime.c
