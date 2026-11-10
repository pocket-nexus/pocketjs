// @title PocketJS: iPad 2
import { mount } from "@pocketjs/framework/solid";
import IPad2Hero from "./app.tsx";

mount(() => <IPad2Hero />);
try {
  var h = (globalThis as any).net.start(JSON.stringify({url:'https://httpbin.org/get'}));
  if (h > 0) {
    var buf = new ArrayBuffer(262144);
    var n = (globalThis as any).net.take(h, buf);
    var ev = (globalThis as any).net.poll();
  } else {
    var ev = (globalThis as any).net.lastError();
  }
} catch(e: any) { var ev = 'EXC:' + e.message; }
