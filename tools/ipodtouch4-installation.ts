/** iOS owns the User container and its install/update/uninstall transaction.
 * This layer only migrates the former /Applications bundle and checks bytes. */
export const IPOD_INSTALLER = "/var/root/Library/PocketJS/ipodtouch4-installer";
export interface InstalledIPodApp {
  readonly CFBundleIdentifier: string;
  readonly ApplicationType: "User";
  readonly Path: string;
  readonly Container: string;
}
export function shellQuote(value: string): string {
  return "'" + value.replaceAll("'", "'\\''") + "'";
}
export function validateIPodIdentity(bundleId: string, bundleName: string): void {
  if (!/^[A-Za-z0-9][A-Za-z0-9.-]{0,199}$/.test(bundleId) || !bundleId.includes(".") || bundleId.includes("..") ||
      !/^[A-Za-z0-9][A-Za-z0-9_-]*\.app$/.test(bundleName)) {
    throw new Error("pocket ipodtouch4: invalid application identity");
  }
}
export function parseInstalledIPodApp(raw: string, bundleId: string, bundleName: string): InstalledIPodApp {
  validateIPodIdentity(bundleId, bundleName);
  const value = JSON.parse(raw);
  if (!value) throw new Error(`pocket ipodtouch4: ${bundleId} is not installed; run deploy`);
  if (value.ApplicationType !== "User") {
    throw new Error(`pocket ipodtouch4: ${bundleId} is a legacy System app; run deploy to migrate it`);
  }
  if (value.CFBundleIdentifier !== bundleId || typeof value.Container !== "string" ||
      !/^(?:\/private)?\/var\/mobile\/Applications\/[0-9A-Fa-f]{8}(?:-[0-9A-Fa-f]{4}){3}-[0-9A-Fa-f]{12}$/.test(value.Container) ||
      value.Path !== `${value.Container}/${bundleName}`) {
    throw new Error("pocket ipodtouch4: invalid User application container");
  }
  return value;
}
export function ipodAppReceiptPaths(app: InstalledIPodApp) {
  const prefix = `${app.Container}/tmp/pocketjs`;
  return { status: `${prefix}.status`, frame: `${prefix}.frame.rgba`, capture: `${prefix}.capture` };
}
export interface UserDeployment {
  readonly bundleId: string;
  readonly bundleName: string;
  readonly executable?: string;
  readonly archive: string;
  readonly archiveHash: string;
  readonly files: Readonly<Record<string, string>>;
}
export function userDeploymentScript(deployment: UserDeployment): string {
  const { bundleId, bundleName, archive, archiveHash, files } = deployment;
  validateIPodIdentity(bundleId, bundleName);
  const executable = deployment.executable ?? bundleName.slice(0, -4);
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(executable)) throw new Error("pocket ipodtouch4: invalid executable");
  if (!/^[0-9a-f]{64}$/.test(archiveHash) || !Object.keys(files).length ||
      Object.entries(files).some(([name, hash]) => name.split("/").some(part => !/^[A-Za-z0-9@._-]+$/.test(part) || part === "." || part === "..") || !/^[0-9a-f]{64}$/.test(hash))) {
    throw new Error("pocket ipodtouch4: invalid deployment hashes");
  }
  return `set -eu
installer=${shellQuote(IPOD_INSTALLER)}
id=${shellQuote(bundleId)}
archive=${shellQuote(archive)}
legacy=${shellQuote(`/Applications/${bundleName}`)}
journal=${shellQuote(`/var/root/Library/PocketJS/${bundleId}.migration`)}
# iOS 6 installd retains the System map in memory after uicache writes it.
# Restart that service to reload the map before User installation (no respring).
refresh() {
  /bin/su mobile -c /usr/bin/uicache
  killall -KILL installd 2>/dev/null || true
  # The old IPC endpoint can still exist while SIGKILL is being delivered.
  sleep 1
  attempt=0
  until "$installer" ready service; do
    attempt=$((attempt + 1))
    if [ "$attempt" -ge 10 ]; then echo 'installation service did not become ready' >&2; return 1; fi
    sleep 1
  done
}
# Reconcile an interrupted migration before starting another installation.
restore_legacy() {
  if [ -d "$journal/legacy.app" ] && ! "$installer" user-path "$id" >/dev/null 2>&1; then
    if [ -e "$legacy" ]; then echo 'migration recovery found two legacy bundles' >&2; return 1; fi
    mv "$journal/legacy.app" "$legacy"
    refresh
  fi
}
restore_legacy
rollback() {
  result=$?
  trap - EXIT HUP INT TERM
  set +e
  restore_legacy
  exit "$result"
}
trap rollback EXIT
trap 'exit 1' HUP INT TERM
# Check bytes before moving the existing app. POSIX sh reports the status of the
# last command in a pipeline, so openssl must not feed a pipe: capture its exit
# status with the output, then match the complete line. OpenSSL 3 prints
# SHA2-256(file)=; OpenSSL 0.9/1.0 and LibreSSL print SHA256(file)=.
verify_digest() {
  expected=$1
  target=$2
  if ! digest=$(/usr/bin/openssl dgst -sha256 "$target"); then
    echo "digest command failed: $target" >&2
    return 1
  fi
  if test "$digest" != "SHA2-256($target)= $expected" &&
     test "$digest" != "SHA256($target)= $expected"; then
    echo "digest verification failed: $target" >&2
    return 1
  fi
}
verify_digest ${shellQuote(archiveHash)} "$archive"
if [ -e "$legacy" ]; then
  test "$("$installer" bundle-id "$legacy")" = "$id"
  test ! -e "$journal/legacy.app"
  killall ${shellQuote(executable)} 2>/dev/null || true
  mkdir -p "$journal"
  preference=/var/mobile/Library/Preferences/$id.plist
  if [ -f "$preference" ]; then cp -p "$preference" "$journal/preferences.plist"; fi
  mv "$legacy" "$journal/legacy.app"
  refresh
fi
# MobileInstallation updates in place, preserving Documents and Library.
"$installer" install "$archive"
dest=$("$installer" user-path "$id")
test "\${dest##*/}" = ${shellQuote(bundleName)}
cd "$dest"
${Object.entries(files).map(([name, hash]) => `verify_digest ${shellQuote(hash)} ${shellQuote(name)}`).join("\n")}
container=\${dest%/*}
if [ -f "$journal/preferences.plist" ]; then
  mkdir -p "$container/Library/Preferences"
  chown mobile:mobile "$container/Library/Preferences"
  if [ ! -e "$container/Library/Preferences/$id.plist" ]; then
    cp -p "$journal/preferences.plist" "$container/Library/Preferences/$id.plist"
    chown mobile:mobile "$container/Library/Preferences/$id.plist"
  fi
fi
# Keep the migration backup until registration and every installed byte pass.
rm -rf "$journal"
trap - EXIT HUP INT TERM
printf 'User application installed: %s\\n' "$dest"
`;
}
