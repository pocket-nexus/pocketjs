import { guardDeviceCommand, withDeviceLease } from "../../tools/device-lease";
const [directory, device, mode] = process.argv.slice(2);
if (mode === "guard") {
  await guardDeviceCommand(device);
  console.log("guarded");
  setInterval(() => {}, 1000);
  await new Promise(() => {});
}
await withDeviceLease(device, async lease => {
  lease.assertHeld();
  console.log("held");
  if (mode === "hold") await new Promise(() => {});
}, { directory });
