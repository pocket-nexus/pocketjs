import { Text, View, ActionHandler } from "@pocketjs/framework/solid/components";
import { BTN } from "@pocketjs/framework/input";
import { result, press } from "./App";
export default function App(){return <View><ActionHandler button={BTN.CROSS} onPress={press}/><Text>{String(result())}</Text></View>;}
