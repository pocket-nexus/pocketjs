import { View, Text, ActionHandler } from "@pocketjs/framework/solid/components";
import { onMount, onCleanup } from "@pocketjs/framework/solid/lifecycle";
import { BTN } from "@pocketjs/framework/input";
import { createRow } from "./Row";
export default function Row(props:{label:string}){
  const {presses,press,load,release}=createRow(props.label);
  onMount(()=>load());onCleanup(()=>release());
  return <View><Text>{props.label}:{presses()}</Text><ActionHandler button={BTN.CROSS} onPress={press}/></View>;
}
