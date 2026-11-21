import { Show } from "solid-js";
import { View, Text, ActionHandler } from "@pocketjs/framework/solid/components";
import { onMount, onCleanup } from "@pocketjs/framework/solid/lifecycle";
import { BTN } from "@pocketjs/framework/input";
import { mid,end,double,recorded,startup,open,press,record,toggle,load,release } from "./App";
import Row from "./Row.tsx";
export default function App(){
  onMount(()=>load());onCleanup(()=>release());
  return <View><Text>{mid()}:{end()}:{double()}:{recorded()}:{startup()}</Text>
    <ActionHandler button={BTN.CROSS} onPress={press}/>
    <ActionHandler button={BTN.CROSS} active={double()>0} onPress={()=>record(double())}/>
    <ActionHandler button={BTN.SELECT} onPress={toggle}/>
    <Show when={mid()!==end()}><Row label="transient"/></Show>
    <Show when={open()}><Row label="stable"/></Show>
  </View>;
}
