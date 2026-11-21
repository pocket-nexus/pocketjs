// Uses the repository's isolated headless browser. No user browser profile.
import { mkdirSync } from "node:fs";
const url = process.argv[2] ?? "http://127.0.0.1:4173/";
const out = new URL("../dist/handheld-models/", import.meta.url).pathname;
mkdirSync(out, { recursive: true });
const probe = `(async () => {
  const sleep = ms => new Promise(r => setTimeout(r,ms));
  const roots = [...document.querySelectorAll('[data-handheld]')];
  document.querySelector('.handheld-grid').scrollIntoView({block:'center',behavior:'instant'});
  for(let i=0;i<180 && roots.some(r=>r.dataset.ready!=='true');i++) await sleep(100);
  if(roots.some(r=>r.dataset.ready!=='true')) throw Error('Handheld startup failed: '+roots.map(r=>r.querySelector('[data-stage-status]').textContent).join('; '));
  // Let the initial hero camera settle before projecting input points.
  await sleep(900);
  const receipt = id => globalThis['__'+id.replaceAll('-','_')+'Receipt']();
  const hash = (root,selector='[data-stage-screen]') => {
    const c=root.querySelector(selector), d=c.getContext('2d').getImageData(0,0,c.width,c.height).data;
    let h=2166136261; for(let i=0;i<d.length;i++){h=Math.imul(h^d[i],16777619);} return h>>>0;
  };
  const contacts=roots[0], vita=roots[1];
  const profiles=await Promise.all(roots.map(r=>fetch('/stage/'+r.dataset.handheld+'/profile.json').then(x=>x.json())));
  function project(root,p,world) {
    const c=root.querySelector('[data-stage-canvas]'),r=c.getBoundingClientRect();
    const target=p.view.desk_target_mm, distance=p.view.distance_mm;
    const eye=root.closest('.hero')
      ? target.map((v,i)=>v+[distance*.35,-distance*.4,distance*.8][i]) : p.view.desk_position_mm;
    const unit=v=>{const n=Math.hypot(...v);return v.map(x=>x/n)};
    const cross=(a,b)=>[a[1]*b[2]-a[2]*b[1],a[2]*b[0]-a[0]*b[2],a[0]*b[1]-a[1]*b[0]];
    const dot=(a,b)=>a.reduce((n,v,i)=>n+v*b[i],0);
    const f=unit(target.map((v,i)=>v-eye[i])),right=unit(cross(f,[0,1,0])),up=cross(right,f);
    const zoom=p.view.fit_aspect?Math.min(1,r.width/r.height/p.view.fit_aspect):1;
    const d=world.map((v,i)=>v-eye[i]),z=dot(d,f),t=Math.tan(p.view.fov_y_degrees*Math.PI/360)/zoom;
    return [r.left+(dot(d,right)/(z*t*r.width/r.height)+1)*r.width/2,r.top+(1-dot(d,up)/(z*t))*r.height/2];
  }
  const pointer=(root,type,xy)=>{
    const c=root.querySelector('[data-stage-canvas]');c.setPointerCapture=()=>{};c.releasePointerCapture=()=>{};
    if(type==='pointerdown' && document.elementFromPoint(...xy)!==c) throw Error('Another element covers the '+root.dataset.handheld+' input point: '+document.elementFromPoint(...xy)?.outerHTML.slice(0,160));
    c.dispatchEvent(new PointerEvent(type,{clientX:xy[0],clientY:xy[1],pointerId:1,pointerType:'mouse',button:0,buttons:type==='pointerup'?0:1,bubbles:true,cancelable:true}));
  };
  const layoutWidth=document.documentElement.clientWidth;
  roots.forEach((root,i)=>{
    const r=root.querySelector('[data-stage-canvas]').getBoundingClientRect();
    if(r.left<0 || r.right>layoutWidth+1) throw Error('Handheld overflows the page');
    for(const x of [-profiles[i].target_width_mm/2,profiles[i].target_width_mm/2]) {
      const p=project(root,profiles[i],[x,0,8]);
      if(p[0]<r.left+2 || p[0]>r.right-2) throw Error('Device ends are cropped');
    }
  });
  contacts.scrollIntoView({block:'center',behavior:'instant'});
  await sleep(500);
  const originalCard=hash(contacts);
  const tap=project(contacts,profiles[0],[-12,-43,12.31]);
  pointer(contacts,'pointerdown',tap);await sleep(350);pointer(contacts,'pointerup',tap);await sleep(650);
  const selectedCard=hash(contacts);
  if(originalCard===selectedCard) throw Error('Lower-screen contact tap did not change upper-screen detail');
  const listBefore=hash(contacts,'[data-stage-auxiliary]');
  const from=project(contacts,profiles[0],[-10,-55,12.31]),to=project(contacts,profiles[0],[-10,-24,12.31]);
  pointer(contacts,'pointerdown',from);await sleep(100);
  for(let i=1;i<=12;i++){pointer(contacts,'pointermove',from.map((v,j)=>v+(to[j]-v)*i/12));await sleep(40);}
  pointer(contacts,'pointerup',to);await sleep(750);
  if(listBefore===hash(contacts,'[data-stage-auxiliary]')) throw Error('Contacts drag did not scroll');
  vita.scrollIntoView({block:'center',behavior:'instant'});await sleep(300);
  for(const name of ['dpad_left','shoulder_l','shoulder_r']) {
    const part=profiles[1].parts.find(p=>p.name===name);
    const button=project(vita,profiles[1],part.center_mm);
    pointer(vita,'pointerdown',button);await sleep(350);pointer(vita,'pointerup',button);await sleep(500);
    if(receipt(vita.dataset.handheld).lastPressedPart!==name) throw Error('Vita '+name+' raycast missed');
    if(receipt(vita.dataset.handheld).pressedPart) throw Error('Vita '+name+' remained held');
  }
  const r=roots.map(x=>receipt(x.dataset.handheld));
  document.querySelector('.handheld-grid').scrollIntoView({block:'center',behavior:'instant'});await sleep(300);
  const loadedModels=performance.getEntriesByType('resource').filter(e=>e.decodedBodySize>0 && new URL(e.name).pathname.endsWith('.glb')).map(e=>e.name);
  return {viewport:[layoutWidth,document.documentElement.clientHeight],loadedModels,checks:['dual display boot','uncropped device framing','auxiliary contact selects primary card','auxiliary drag scrolls','Vita d-pad and L/R raycast and release'],receipts:r};
})()`;
const child = Bun.spawn(["bun", new URL("./verify.ts", import.meta.url).pathname, url, "1500", probe], {
  env: { ...process.env, SHOT: process.env.SHOT ?? out + "homepage-handhelds.png", POCKETJS_VERIFY_SELECTOR: ".handheld-grid", POCKETJS_VERIFY_CDP_TIMEOUT: "60000" },
  stdout: "pipe", stderr: "inherit",
});
const result = await new Response(child.stdout).text();
if (await child.exited !== 0) throw Error("Handheld browser verifier failed");
const report = JSON.parse(result);
await Bun.write(out + (process.env.MOBILE ? "browser-mobile-receipt.json" : "browser-receipt.json"), JSON.stringify(report,null,2)+"\n");
if(process.env.WIDTH && report.probe.viewport[0] !== Number(process.env.WIDTH)) throw Error('Requested viewport width was not applied');
console.log(result);
const completedModelCancellations = new Set(report.probe.loadedModels.map((url: string) =>
  `net::ERR_ABORTED: ${url} (type=Fetch, canceled=true)`));
if (report.pageErrors.length || report.consoleErrors.length || report.networkErrors.some((e: string)=>!completedModelCancellations.has(e))) {
  throw Error("Handheld page reported errors");
}
