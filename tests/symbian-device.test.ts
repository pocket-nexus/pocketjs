import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  type CommandResult,
  deploySis,
  isExpectedMtpDevice,
  parseMtpFolders,
  parseMtpSendFileId,
  safeAtCommands,
  sanitizeDeviceOutput,
  selectMtpFolder,
} from "../tools/symbian-device.ts";

const temporary: string[] = [];
afterEach(() => {
  for (const path of temporary.splice(0)) rmSync(path, { recursive: true, force: true });
});

const FOLDERS = `Attempting to connect device(s)
Device 0 (VID=0421 and PID=0335) is a Nokia E7 (Ovi mode).
mtp-folders: Successfully connected
Friendly name: Nokia E7-00
Storage: Mass memory
1\tGames
2\tInstalls
3\tOthers
29\t  Contacts
Storage: Phone memory
14\tGames
17\tInstalls
18\tOthers
OK.
`;

function fixture(): string {
  const root = `/tmp/pocketjs-symbian-device-${process.pid}-${Math.random().toString(16).slice(2)}`;
  mkdirSync(root, { recursive: true });
  temporary.push(root);
  return root;
}

describe("Nokia E7 MTP boundary", () => {
  test("selects only the top-level Mass memory Installs folder", () => {
    const folders = parseMtpFolders(FOLDERS);
    expect(selectMtpFolder(folders, "Mass memory", "Installs")).toEqual({
      storage: "Mass memory",
      id: 2,
      name: "Installs",
      depth: 0,
    });
    expect(selectMtpFolder(folders, "Phone memory", "Installs").id).toBe(17);
    expect(() => selectMtpFolder(folders, "Mass memory", "Missing")).toThrow(
      "expected one top-level",
    );
  });

  test("matches exactly the pinned Nokia E7 USB identity", () => {
    expect(isExpectedMtpDevice(FOLDERS, {
      vendorId: "0421",
      productId: "0335",
      name: "Nokia E7",
    })).toBe(true);
    expect(isExpectedMtpDevice(FOLDERS, {
      vendorId: "0421",
      productId: "0001",
      name: "Nokia E7",
    })).toBe(false);
    expect(isExpectedMtpDevice(FOLDERS.replace("Nokia E7 (Ovi mode)", "Camera"), {
      vendorId: "0421",
      productId: "0335",
      name: "Nokia E7",
    })).toBe(false);
  });

  test("requires mtp-sendfile to report the created object id", () => {
    expect(parseMtpSendFileId("New file ID: 184549500\n")).toBe(184549500);
    expect(() => parseMtpSendFileId("Parent folder could not be found, skipping\n")).toThrow(
      "did not report a new file ID",
    );
  });

  test("redacts identifiers and exposes only read-only AT commands", () => {
    const sanitized = sanitizeDeviceOutput(
      "Serial Number: 123456789012345\nIMEI=123456789012345\n/dev/cu.usbmodem2102\n",
    );
    expect(sanitized).not.toContain("123456789012345");
    expect(sanitized).not.toContain("usbmodem2102");
    expect(safeAtCommands()).toEqual(["AT", "ATI", "AT+CGMM", "AT+CGMR"]);
    expect(safeAtCommands().join(" ")).not.toMatch(/CGSN|GSN/);
  });

  test("uploads once, reads back by object id, and verifies SHA-256", async () => {
    const root = fixture();
    const sis = join(root, "pocketjs-e7-probe.sis");
    writeFileSync(sis, "signed-sis-fixture");
    const calls: Array<[string, readonly string[]]> = [];
    const runner = async (command: string, args: readonly string[]): Promise<CommandResult> => {
      calls.push([command, args]);
      if (command === "mtp-folders") return { exitCode: 0, stdout: FOLDERS, stderr: "" };
      if (command === "mtp-sendfile") {
        expect(args).toEqual([sis, "2"]);
        return { exitCode: 0, stdout: "New file ID: 42\n", stderr: "" };
      }
      if (command === "mtp-getfile") {
        expect(args[0]).toBe("42");
        writeFileSync(args[1]!, readFileSync(sis));
        return { exitCode: 0, stdout: "", stderr: "" };
      }
      throw new Error(`unexpected command ${command}`);
    };

    const deployed = await deploySis(sis, runner, {
      storage: "Mass memory",
      folder: "Installs",
      vendorId: "0421",
      productId: "0335",
      deviceName: "Nokia E7",
    });
    expect(deployed).toMatchObject({
      localName: "pocketjs-e7-probe.sis",
      fileId: 42,
      folderId: 2,
    });
    expect(deployed.sha256).toMatch(/^[a-f0-9]{64}$/);
    expect(calls.map(([command]) => command)).toEqual([
      "mtp-folders",
      "mtp-sendfile",
      "mtp-getfile",
    ]);
  });

  test("does not claim success when readback differs", async () => {
    const root = fixture();
    const sis = join(root, "pocketjs-e7-probe.sis");
    writeFileSync(sis, "local");
    const runner = async (command: string, args: readonly string[]): Promise<CommandResult> => {
      if (command === "mtp-folders") return { exitCode: 0, stdout: FOLDERS, stderr: "" };
      if (command === "mtp-sendfile") {
        return { exitCode: 0, stdout: "New file ID: 43\n", stderr: "" };
      }
      writeFileSync(args[1]!, "different");
      return { exitCode: 0, stdout: "", stderr: "" };
    };
    await expect(deploySis(sis, runner, {
      storage: "Mass memory",
      folder: "Installs",
      vendorId: "0421",
      productId: "0335",
      deviceName: "Nokia E7",
    })).rejects.toThrow("MTP readback SHA-256 mismatch");
  });

  test("does not upload to an unpinned MTP device with the same folder names", async () => {
    const root = fixture();
    const sis = join(root, "pocketjs-e7-probe.sis");
    writeFileSync(sis, "signed-sis-fixture");
    let uploaded = false;
    const runner = async (command: string): Promise<CommandResult> => {
      if (command === "mtp-folders") {
        return {
          exitCode: 0,
          stdout: FOLDERS.replace("VID=0421 and PID=0335", "VID=18d1 and PID=4ee1"),
          stderr: "",
        };
      }
      uploaded = true;
      return { exitCode: 0, stdout: "", stderr: "" };
    };
    await expect(deploySis(sis, runner, {
      storage: "Mass memory",
      folder: "Installs",
      vendorId: "0421",
      productId: "0335",
      deviceName: "Nokia E7",
    })).rejects.toThrow("expected exactly one Nokia E7");
    expect(uploaded).toBe(false);
  });
});
