import { createSignal } from "solid-js";
import type { i32 } from "@pocketjs/framework/solid/std";
export function createRow(label:string){
  const [presses,setPresses]=createSignal<i32>(0);
  function press():void {setPresses(value=>value+1);console.log(label+":"+presses());}
  function load():void {console.log("mount:"+label);}
  function release():void {console.log("unmount:"+label);}
  return {presses,press,load,release};
}
