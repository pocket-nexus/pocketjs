import { createSignal } from "solid-js";
import { createMemo, createEffect, on } from "@pocketjs/framework/solid/reactive";
import { frames, after, type i32 } from "@pocketjs/framework/solid/std";
export const [trigger,setTrigger]=createSignal<i32>(0);
export const [mid,setMid]=createSignal<i32>(0);
export const [end,setEnd]=createSignal<i32>(0);
export const [count,setCount]=createSignal<i32>(0);
export const [recorded,setRecorded]=createSignal<i32>(0);
export const [open,setOpen]=createSignal(true);
export const double=createMemo<i32>(()=>count()*2);
createEffect(on([trigger],()=>setMid(1),{defer:true}));
createEffect(on([mid],()=>setEnd(mid()),{defer:true}));
export function press():void {setTrigger(v=>v+1);setCount(v=>v+1);console.log("root:"+count());}
export function record(value:i32):void {setRecorded(value);console.log("record:"+value);}
export function toggle():void {setOpen(value=>!value);}
export function load():void {console.log("root-mount");}
export function release():void {console.log("root-unmount");}

export const[startup,setStartup]=createSignal<i32>(0);
async function boot():Promise<void>{await frames(1);setStartup(1);await after(16);setStartup(2);}
createEffect(()=>boot());
