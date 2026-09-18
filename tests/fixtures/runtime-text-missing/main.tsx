import { getOps } from "@pocketjs/framework";
import { Text } from "@pocketjs/framework/components";
import { mount } from "@pocketjs/framework/solid";

const poll = (getOps() as { svcPoll?: () => string | undefined }).svcPoll;
const hostText = poll ? poll() ?? "" : "";

mount(() => <Text class="text-base">{hostText}</Text>);
