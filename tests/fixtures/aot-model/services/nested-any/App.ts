import { createSignal } from "solid-js";
import { all, any, frames } from "@pocketjs/framework/solid/std";
import { net } from "@pocketjs/framework/net/model";
export const [result,setResult]=createSignal("idle");
export async function press():Promise<void>{await all([any([net.get("/winner"),net.get("/loser")]),frames(4)]);setResult("done");}
