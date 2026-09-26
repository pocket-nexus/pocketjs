// Run through site/verify.ts so browser launch, errors, and cleanup share one owner.
import { strict as assert } from "node:assert";
import { mkdirSync } from "node:fs";
import { createCanvas, loadImage } from "@napi-rs/canvas";
import { DESK_APPS } from "./desk-apps";
import { contentRect } from "./desk/geometry";

export async function run({ send }: { send: (method: string, params?: any) => Promise<any> }) {
  const out = process.env.DESK_RECEIPTS ?? ".pocket-build/validation/desk-scene/interactive";
  mkdirSync(out, { recursive: true });
  const evaluate = async (expression: string) => {
    const r = await send("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true });
    if (r.exceptionDetails) throw Error(r.exceptionDetails.exception?.description ?? r.exceptionDetails.text);
    return r.result.value;
  };
  const receipt = () => evaluate("__deskReceipt()");
  const initial = await receipt();
  assert.equal(initial.hosts.length, 6);
  assert(initial.hosts.every((h: any) => h.state === "ready" && h.ticks > 0));
  assert.equal(initial.hosts.flatMap((h: any) => h.outputs).length, 7);
  const projection = await evaluate('fetch("./web.json").then(r=>r.json())');
  const bounds = () => evaluate('(() => {const r=document.querySelector("#scene").getBoundingClientRect();return {x:r.x,y:r.y,width:r.width,height:r.height,scale:1}})()');
  const hash = (device: string, surface = "primary") => evaluate(`(() => {const c=document.querySelector('canvas[data-framebuffer="Screen__${device}__${surface}"]');let h=2166136261;for(const b of c.getContext('2d').getImageData(0,0,c.width,c.height).data) h=Math.imul(h^b,16777619);return h>>>0})()`);
  async function point(device: string, x: number, y: number, surface = "primary") {
    const s = projection.screens.find((s: any) => s.device === device && s.surface === surface);
    const c = DESK_APPS.find(c => c.device === device)!;
    const size = surface === "auxiliary" && "auxiliary" in c ? c.auxiliary : c.viewport;
    const r = contentRect(s.framebuffer_size, size);
    const u = r[0] + x / size[0] * r[2], v = r[1] + (1 - y / size[1]) * r[3];
    for (let i = 0; i < s.vertices.length; i += 3) {
      const [a,b,c] = s.vertices.slice(i,i+3);
      const det = (b[4]-c[4])*(a[3]-c[3])+(c[3]-b[3])*(a[4]-c[4]);
      if (Math.abs(det)<1e-12) continue;
      const p = ((b[4]-c[4])*(u-c[3])+(c[3]-b[3])*(v-c[4]))/det;
      const q = ((c[4]-a[4])*(u-c[3])+(a[3]-c[3])*(v-c[4]))/det;
      if (Math.min(p,q,1-p-q)<-1e-6) continue;
      const w = [p*a[2],q*b[2],(1-p-q)*c[2]], sum=w.reduce((a,b)=>a+b);
      const xy=[0,1].map(k=>w.reduce((n,t,j)=>n+t*[a,b,c][j][k],0)/sum), box=await bounds();
      return {x:box.x+xy[0]*box.width,y:box.y+(1-xy[1])*box.height};
    }
    throw Error(`No screen triangle for ${device}`);
  }
  const mouse = (type: string, p: any, pressed = false) => send("Input.dispatchMouseEvent", {type,...p,button:"left",buttons:pressed?1:0,clickCount:1});
  async function click(p: any) { await mouse("mouseMoved",p); await mouse("mousePressed",p,true); await mouse("mouseReleased",p); await Bun.sleep(180); }
  async function control(id: string) { await click(await evaluate(`(() => {const r=document.querySelector('#${id}').getBoundingClientRect();return {x:r.x+r.width/2,y:r.y+r.height/2}})()`)); }
  async function key(key: string, code = key) { await send("Input.dispatchKeyEvent",{type:"keyDown",key,code}); await send("Input.dispatchKeyEvent",{type:"keyUp",key,code}); await Bun.sleep(250); }
  const glassBuild = await Bun.build({ entrypoints: [new URL("./verify-desk-glass.ts", import.meta.url).pathname], target: "browser", write: false });
  assert(glassBuild.success);
  const glassModule = `data:text/javascript;base64,${Buffer.from(await glassBuild.outputs[0].text()).toString("base64")}`;
  const glass = await evaluate(`import(${JSON.stringify(glassModule)}).then(async m=>m.checkGlass(await (await fetch('./web.json')).json(),document.querySelector('#plate')))`);
  const checks: string[] = ["six isolated apps / seven framebuffers ready", "white framebuffers retain reflection contrast on all seven screens"];
  await click(await point("desktop-monitor",230,130));
  const monitor = await hash("desktop-monitor"); await key("ArrowRight");
  assert.notEqual(await hash("desktop-monitor"), monitor); checks.push("monitor keyboard changes panel");
  await click(await point("psp",230,130)); const motions=await hash("psp"); await key("ArrowRight");
  assert.notEqual(await hash("psp"),motions); checks.push("PSP Motion Lab keyboard focus");
  const contacts = await hash("3ds"); await click(await point("3ds",140,145,"auxiliary"));
  assert.notEqual(await hash("3ds"), contacts); checks.push("3DS lower screen touch updates upper screen");
  const clear = await hash("ipod-touch-4"); await click(await point("ipod-touch-4",150,30)); await Bun.sleep(400);
  assert.notEqual(await hash("ipod-touch-4"),clear);
  const start=await point("ipod-touch-4",50,95), end=await point("ipod-touch-4",260,95);
  const beforeSwipe=await hash("ipod-touch-4"); await mouse("mousePressed",start,true);
  for(let i=1;i<=8;i++){await mouse("mouseMoved",{x:start.x+(end.x-start.x)*i/8,y:start.y+(end.y-start.y)*i/8},true);await Bun.sleep(30);}
  await mouse("mouseReleased",end); await Bun.sleep(500);
  assert.notEqual(await hash("ipod-touch-4"),beforeSwipe); checks.push("iPod list open and task swipe");
  await click(await point("android-budget",140,250)); const note=await hash("android-budget");
  await key("ArrowDown"); assert.notEqual(await hash("android-budget"),note); checks.push("portrait Note scroll");
  await click(await point("vita",230,130)); const music=await hash("vita"); await key("e","KeyE");
  assert.notEqual(await hash("vita"),music); checks.push("Vita next-track input");
  await control("pause"); const stopped=await receipt(); await Bun.sleep(200);
  assert.deepEqual((await receipt()).hosts.map((h:any)=>h.ticks),stopped.hosts.map((h:any)=>h.ticks));
  assert(stopped.hosts.every((h:any)=>!h.held&&!h.pending&&!h.contact&&!h.queued)); checks.push("pause freezes all clocks and clears input");
  await mouse("mouseMoved",{x:0,y:0});
  const clip=await bounds();
  const capture=async(name:string)=>{const r=await send("Page.captureScreenshot",{format:"png",clip});await Bun.write(`${out}/${name}.png`,Buffer.from(r.data,"base64"));};
  await capture("interactive"); await control("original"); await capture("original");
  const [live, plate] = await Promise.all([loadImage(`${out}/interactive.png`), loadImage(`${out}/original.png`)]);
  assert.equal(live.width, plate.width); assert.equal(live.height, plate.height);
  const pixels = (image: any) => { const c=createCanvas(image.width,image.height),ctx=c.getContext("2d");ctx.drawImage(image,0,0);return ctx.getImageData(0,0,image.width,image.height).data; };
  const a=pixels(live), b=pixels(plate), mask=createCanvas(live.width,live.height), ctx=mask.getContext("2d");
  ctx.fillStyle="#fff"; ctx.strokeStyle="#fff"; ctx.lineWidth=8;
  for(const screen of projection.screens) for(let i=0;i<screen.vertices.length;i+=3){
    ctx.beginPath(); screen.vertices.slice(i,i+3).forEach((v:any,j:number)=>{const x=v[0]*live.width,y=(1-v[1])*live.height;j?ctx.lineTo(x,y):ctx.moveTo(x,y)});ctx.closePath();ctx.fill();ctx.stroke();
  }
  const m=ctx.getImageData(0,0,live.width,live.height).data;
  let lightingPixels=0, changedOutsideScreens=0, changedScreenPixels=0, maxOutsideChannelDelta=0;
  // Chrome may re-rasterize the image layer when the WebGL layer is hidden.
  // Allow one 8-bit level for that rounding, not spatial or lighting changes.
  for(let i=0;i<a.length;i+=4){const delta=Math.max(...[0,1,2].map(k=>Math.abs(a[i+k]-b[i+k])));if(m[i+3]){if(delta)changedScreenPixels++}else{lightingPixels++;maxOutsideChannelDelta=Math.max(delta,maxOutsideChannelDelta);if(delta>1)changedOutsideScreens++}}
  assert.equal(changedOutsideScreens,0,"Environment lighting changed outside screen edges (tolerance: 1/255)");
  assert(changedScreenPixels>10000); checks.push("baked environment retained outside 4px screen-edge margin (1/255 rounding tolerance)");
  await control("original"); await control("pause"); await Bun.sleep(200);
  assert((await receipt()).hosts[0].ticks>stopped.hosts[0].ticks); checks.push("original plate toggle and resume");
  await send("Emulation.setDeviceMetricsOverride",{width:390,height:844,deviceScaleFactor:1,mobile:false}); await Bun.sleep(200);
  await click(await point("desktop-monitor",230,130)); assert.equal((await receipt()).selected,"desktop-monitor");
  assert(await evaluate("document.documentElement.scrollWidth <= innerWidth")); checks.push("390px viewport projection and no horizontal overflow");
  await send("Emulation.setDeviceMetricsOverride",{width:1440,height:1140,deviceScaleFactor:1,mobile:false});
  return {checks, glass, lighting:{lightingPixels,changedOutsideScreens,maxOutsideChannelDelta,changedScreenPixels}, final:await receipt(), captures:[`${out}/interactive.png`,`${out}/original.png`]};
}
