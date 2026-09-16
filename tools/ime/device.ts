/** Paired USB supervisor. Keys stay in private device storage and ignored
 * local files. launchd can own its lifetime across terminal exits and logins. */
import { randomBytes, createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync, chmodSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { createServer } from "node:net";
import { homedir } from "node:os";
import { shellQuote } from "../ipodtouch4-installation.ts";
import { superviseCompanion, childRunning } from "./supervisor.ts";
const target = Bun.argv[2];
if (!["ipodtouch4", "moto-g-play"].includes(target)) throw new Error("Usage: bun clear:companion <ipodtouch4|moto-g-play> --id=<USB device ID> [--service]");
const option = (key: string) => Bun.argv.find(a => a.startsWith(`--${key}=`))?.slice(key.length + 3);
const id = option("id");
if (!id || !/^[A-Za-z0-9-]+$/.test(id)) throw new Error("Select the exact device with --id");
const keyPath = resolve(option("key") ?? `.pocket/clear-${target}.key`);
mkdirSync(dirname(keyPath), { recursive: true });
if (!existsSync(keyPath)) writeFileSync(keyPath, randomBytes(32).toString("hex"), { mode: 0o600, flag: "wx" });
chmodSync(keyPath, 0o600);
const key = readFileSync(keyPath, "utf8").trim();
if (!/^[0-9a-f]{64}$/.test(key)) throw new Error("Invalid pairing key");
let command: ReturnType<typeof Bun.spawn> | undefined;
async function run(args: string[], stdin?: string) {
  const child = Bun.spawn(args, { stdin: stdin === undefined ? "ignore" : Buffer.from(stdin), stdout: "pipe", stderr: "pipe" });
  command = child;
  const timer = setTimeout(() => child.kill(), 6000);
  try {
    const [code, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
    if (code) throw new Error(`${args[0]} failed: ${stderr.trim().slice(0, 240)}`);
    return stdout.trim();
  } finally { clearTimeout(timer); if (command === child) command = undefined; }
}
if (Bun.argv.includes("--service")) {
  if (process.platform !== "darwin") throw new Error("--service requires macOS launchd");
  const label = `dev.pocket-stack.clear-companion.${target}`;
  const logDir = resolve(".pocket/ime/services"); mkdirSync(logDir, { recursive: true });
  const agents = resolve(homedir(), "Library/LaunchAgents"); mkdirSync(agents, { recursive: true });
  const path = resolve(agents, `${label}.plist`);
  const xml = (value: string) => value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;");
  const args = [process.execPath, import.meta.path, target, `--id=${id}`, `--key=${keyPath}`];
  writeFileSync(path, `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
<key>Label</key><string>${label}</string>
<key>ProgramArguments</key><array>${args.map(a => `<string>${xml(a)}</string>`).join("")}</array>
<key>WorkingDirectory</key><string>${xml(resolve("."))}</string>
<key>EnvironmentVariables</key><dict><key>PATH</key><string>${xml(process.env.PATH ?? "/usr/bin:/bin")}</string></dict>
<key>RunAtLoad</key><true/><key>KeepAlive</key><true/><key>ThrottleInterval</key><integer>5</integer>
<key>StandardOutPath</key><string>${xml(resolve(logDir, `${target}.log`))}</string>
<key>StandardErrorPath</key><string>${xml(resolve(logDir, `${target}.log`))}</string>
</dict></plist>\n`, { mode: 0o600 });
  const domain = `gui/${process.getuid!()}`;
  try { await run(["launchctl", "bootout", `${domain}/${label}`]); } catch { /* First installation has no job. */ }
  // bootout can return before launchd has released the old job registration.
  for (let attempt = 0; ; attempt++) {
    try { await run(["launchctl", "bootstrap", domain, path]); break; }
    catch (error) {
      if (attempt >= 9 || !(error instanceof Error) || !error.message.includes("Bootstrap failed: 5:")) throw error;
      await Bun.sleep(500);
    }
  }
  console.log(`Installed ${label}; logs: ${logDir}/${target}.log`);
  process.exit(0);
}
let tunnel: ReturnType<typeof Bun.spawn> | undefined, companion: ReturnType<typeof Bun.spawn> | undefined;
let stopped = false, paired = false, checkedAt = 0;
const port = target === "ipodtouch4" ? 18741 : 28741;
// A process-owned lease prevents two providers from evicting each other's
// authenticated socket. The OS releases it on exit, including a crash.
const lease = createServer(socket => socket.destroy());
await new Promise<void>((resolve, reject) => {
  lease.once("error", () => reject(new Error(`A ${target} companion is already running (lease port ${port + 1})`)));
  lease.listen(port + 1, "127.0.0.1", resolve);
});
const cache = resolve(homedir(), ".cache/pocket-stack/ipodtouch4/ssh");
const ssh = ["ssh", "-p", "19224", "-i", resolve(cache, "id_rsa"), "-o", `UserKnownHostsFile=${resolve(cache, "known_hosts")}`,
  "-o", "HostKeyAlias=[127.0.0.1]:2224", "-o", "StrictHostKeyChecking=yes", "-o", "ConnectTimeout=3",
  "-o", "HostKeyAlgorithms=+ssh-rsa", "-o", "PubkeyAcceptedAlgorithms=+ssh-rsa", "-o", "BatchMode=yes", "root@127.0.0.1"];
const adb = ["adb", "-s", id];
const stop = () => { if (stopped) return; stopped = true; lease.close(); command?.kill(); companion?.kill(); tunnel?.kill(); };
process.on("SIGINT", stop); process.on("SIGTERM", stop); process.on("exit", stop);
await superviseCompanion({ stopped: () => stopped, wait: () => Bun.sleep(2000), status: console.log,
  async reconcile() {
    try {
      if (target === "ipodtouch4") {
        if (!(await run(["idevice_id", "-l"])).split(/\s+/).includes(id)) throw new Error("Selected iPod is disconnected");
        if (!paired && await run(["ideviceinfo", "-u", id, "-k", "ProductType"]) !== "iPod4,1") throw new Error("Expected iPod touch 4");
        if (!childRunning(tunnel)) {
          paired = false;
          tunnel = Bun.spawn(["iproxy", "-u", id, "19224:22", `${port}:8741`], { stdout: "ignore", stderr: "ignore" });
          await Bun.sleep(500);
          if (!childRunning(tunnel)) throw new Error("iPod USB ports are already in use");
        }
      } else {
        if (await run([...adb, "get-state"]) !== "device") throw new Error("Selected Moto is disconnected");
        if (!paired && await run([...adb, "shell", "getprop", "ro.product.device"]) !== "fogona") throw new Error("Expected Moto G Play 2024 (fogona)");
        const forwards = (await run([...adb, "forward", "--list"])).split("\n").map(line => line.trim().split(/\s+/));
        const binding = forwards.find(row => row[1] === `tcp:${port}`);
        if (binding && (binding[0] !== id || binding[2] !== "tcp:8741")) throw new Error("Moto companion port belongs to another forward");
        if (!binding) {
          paired = false;
          await run([...adb, "forward", "--no-rebind", `tcp:${port}`, "tcp:8741"]);
        }
      }
      if (!paired || Date.now() - checkedAt > 30000) {
        if (target === "ipodtouch4") {
          if (await run(["ideviceinfo", "-u", id, "-k", "ProductType"]) !== "iPod4,1") throw new Error("Expected iPod touch 4");
          const bundle = await run([...ssh, "/var/root/Library/PocketJS/ipodtouch4-installer user-path dev.pocket-stack.clear"]);
          if (!/^\/private\/var\/mobile\/Applications\/[A-Fa-f0-9-]+\/PocketJSiPodTouch4.app$/.test(bundle)) throw new Error("Unexpected Clear installation path");
          const path = shellQuote(`${dirname(bundle)}/Documents/offload.key`);
          const read = () => run([...ssh, `cat ${path}`]);
          if (await read().catch(() => "") !== key) {
            await run([...ssh, `umask 077; cat > ${path}; chown mobile:mobile ${path}`], key);
            if (await read() !== key) throw new Error("Pairing readback mismatch");
          }
        } else {
          if (await run([...adb, "shell", "getprop", "ro.product.device"]) !== "fogona") throw new Error("Expected Moto G Play 2024 (fogona)");
          const read = () => run([...adb, "shell", "run-as", "dev.pocket_stack.clear", "cat", "files/offload.key"]);
          if (await read().catch(() => "") !== key) {
            await run([...adb, "shell", "run-as", "dev.pocket_stack.clear", "mkdir", "-p", "files"]);
            await run([...adb, "shell", "run-as", "dev.pocket_stack.clear", "sh", "-c", "'umask 077; cat > files/offload.key'"], key);
            if (await read() !== key) throw new Error("Pairing readback mismatch");
          }
        }
        writeFileSync(resolve(dirname(keyPath), `clear-${target}-pairing.json`), JSON.stringify({ target, id, port,
          keyFingerprint: createHash("sha256").update(key).digest("hex"), readback: true }, null, 2));
        paired = true; checkedAt = Date.now();
      }
      if (stopped) return;
      if (!childRunning(companion)) companion = Bun.spawn([process.execPath, resolve(import.meta.dir, "serve.ts"),
        `--port=${port}`, `--key=${keyPath}`], { stdout: "inherit", stderr: "inherit" });
    } catch (error) { paired = false; throw error; }
  },
});
stop();
await Promise.all([companion?.exited, tunnel?.exited]);
