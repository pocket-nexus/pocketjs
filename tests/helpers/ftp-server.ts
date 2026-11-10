// A small FTP server over a folder, for tests that reach a device's storage
// the way a setup does over ftpd (tools/pocket-link/v2/ftp-storage.ts). It
// speaks the commands curl sends: passive transfers only, one folder as the
// root, any user. `breakNext` cuts the data connection of the next matching
// transfer, which is how a test makes a read or a write fail midway.

import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { type Server, type Socket, createServer } from "node:net";
import { dirname, join, posix } from "node:path";

export interface FtpServer {
  port: number;
  /** Every command line received, in order, without the password. */
  commands: string[];
  /** Cuts the data connection of the next `command` (RETR, STOR, NLST) on `path` (an absolute FTP path). */
  breakNext(command: string, path: string): void;
  close(): Promise<void>;
}

export async function startFtpServer(root: string): Promise<FtpServer> {
  const commands: string[] = [];
  const broken: { command: string; path: string }[] = [];
  const sockets = new Set<Socket>();
  const servers = new Set<Server>();

  const takeBreak = (command: string, path: string) => {
    const index = broken.findIndex((entry) => entry.command === command && entry.path === path);
    if (index < 0) return false;
    broken.splice(index, 1);
    return true;
  };

  const control = createServer((socket) => {
    sockets.add(socket);
    socket.on("close", () => sockets.delete(socket));
    socket.on("error", () => {});
    let cwd = "/";
    let renameFrom: string | null = null;
    let passive: { server: Server; data: Promise<Socket> } | null = null;
    let buffer = "";
    let busy = Promise.resolve();
    const reply = (line: string) => {
      if (!socket.destroyed) socket.write(`${line}\r\n`);
    };
    const absolute = (argument: string) => posix.normalize(argument.startsWith("/") ? argument : posix.join(cwd, argument));
    const local = (path: string) => join(root, path);
    const isDir = (path: string) => existsSync(local(path)) && statSync(local(path)).isDirectory();
    const isFile = (path: string) => existsSync(local(path)) && statSync(local(path)).isFile();

    const openPassive = (): Promise<number> =>
      new Promise((done) => {
        passive?.server.close();
        let give!: (data: Socket) => void;
        const data = new Promise<Socket>((resolve) => (give = resolve));
        const server = createServer((connection) => {
          sockets.add(connection);
          connection.on("close", () => sockets.delete(connection));
          connection.on("error", () => {});
          give(connection);
        });
        servers.add(server);
        server.on("close", () => servers.delete(server));
        server.listen(0, "127.0.0.1", () => {
          passive = { server, data };
          done((server.address() as { port: number }).port);
        });
      });
    const transfer = async (work: (data: Socket) => Promise<boolean>) => {
      if (passive === null) return reply("425 Use PASV or EPSV first.");
      const { server, data } = passive;
      passive = null;
      reply("150 Opening the data connection.");
      const connection = await data;
      const whole = await work(connection);
      server.close();
      reply(whole ? "226 Transfer complete." : "426 Connection closed; transfer aborted.");
    };
    const send = (connection: Socket, bytes: Uint8Array) =>
      new Promise<boolean>((done) => {
        connection.end(bytes, () => done(true));
        connection.on("error", () => done(false));
      });

    const handle = async (line: string) => {
      const space = line.indexOf(" ");
      const name = (space < 0 ? line : line.slice(0, space)).toUpperCase();
      const argument = space < 0 ? "" : line.slice(space + 1);
      commands.push(name === "PASS" ? "PASS" : line);
      switch (name) {
        case "USER":
          return reply("331 Any password.");
        case "PASS":
          return reply("230 Logged in.");
        case "SYST":
          return reply("215 UNIX Type: L8");
        case "FEAT":
          return reply("211 No features.");
        case "PWD":
          return reply(`257 "${cwd}" is the current folder.`);
        case "TYPE":
        case "MODE":
        case "STRU":
        case "NOOP":
          return reply("200 Done.");
        case "CWD": {
          const path = absolute(argument);
          if (!isDir(path)) return reply("550 No such folder.");
          cwd = path;
          return reply("250 Done.");
        }
        case "CDUP":
          cwd = posix.dirname(cwd);
          return reply("250 Done.");
        case "MKD": {
          const path = absolute(argument);
          if (existsSync(local(path))) return reply("550 It exists.");
          mkdirSync(local(path), { recursive: true });
          return reply(`257 "${path}" created.`);
        }
        case "EPSV":
          return reply(`229 Entering Extended Passive Mode (|||${await openPassive()}|)`);
        case "PASV": {
          const port = await openPassive();
          return reply(`227 Entering Passive Mode (127,0,0,1,${port >> 8},${port & 255})`);
        }
        case "SIZE": {
          const path = absolute(argument);
          return reply(isFile(path) ? `213 ${statSync(local(path)).size}` : "550 No such file.");
        }
        case "MDTM":
          return reply("550 Not kept.");
        case "REST":
          return reply("350 Restarting at 0.");
        case "RETR": {
          const path = absolute(argument);
          if (!isFile(path)) return reply("550 No such file.");
          return transfer(async (data) => {
            if (takeBreak("RETR", path)) {
              data.destroy();
              return false;
            }
            return send(data, readFileSync(local(path)));
          });
        }
        case "NLST":
        case "LIST": {
          const path = absolute(argument.startsWith("-") ? "" : argument);
          if (!isDir(path)) return reply("550 No such folder.");
          return transfer(async (data) => {
            if (takeBreak("NLST", path)) {
              data.destroy();
              return false;
            }
            return send(data, new TextEncoder().encode(readdirSync(local(path)).map((entry) => `${entry}\r\n`).join("")));
          });
        }
        case "STOR": {
          const path = absolute(argument);
          if (!isDir(posix.dirname(path))) return reply("550 No such folder.");
          return transfer(
            (data) =>
              new Promise<boolean>((done) => {
                const chunks: Buffer[] = [];
                const cut = takeBreak("STOR", path);
                data.on("data", (chunk: Buffer) => {
                  chunks.push(chunk);
                  if (cut) {
                    // Half of what arrived reaches the card, then the connection goes.
                    const got = Buffer.concat(chunks);
                    writeFileSync(local(path), got.subarray(0, got.length >> 1));
                    data.destroy();
                    done(false);
                  }
                });
                data.on("end", () => {
                  if (cut) return;
                  mkdirSync(dirname(local(path)), { recursive: true });
                  writeFileSync(local(path), Buffer.concat(chunks));
                  done(true);
                });
                data.on("error", () => done(false));
              }),
          );
        }
        case "DELE": {
          const path = absolute(argument);
          if (!isFile(path)) return reply("550 No such file.");
          rmSync(local(path));
          return reply("250 Deleted.");
        }
        case "RNFR": {
          const path = absolute(argument);
          if (!existsSync(local(path))) return reply("550 No such file.");
          renameFrom = path;
          return reply("350 Ready for the new name.");
        }
        case "RNTO": {
          if (renameFrom === null) return reply("503 RNFR first.");
          renameSync(local(renameFrom), local(absolute(argument)));
          renameFrom = null;
          return reply("250 Renamed.");
        }
        case "QUIT":
          reply("221 Bye.");
          return void socket.end();
        default:
          return reply("502 Not here.");
      }
    };

    socket.on("data", (chunk) => {
      buffer += chunk.toString("utf8");
      for (let end = buffer.indexOf("\n"); end >= 0; end = buffer.indexOf("\n")) {
        const line = buffer.slice(0, end).replace(/\r$/, "");
        buffer = buffer.slice(end + 1);
        busy = busy.then(() => handle(line)).catch(() => reply("451 The server failed."));
      }
    });
    reply("220 A test FTP server.");
  });

  await new Promise<void>((done) => control.listen(0, "127.0.0.1", () => done()));
  return {
    port: (control.address() as { port: number }).port,
    commands,
    breakNext(command, path) {
      broken.push({ command, path });
    },
    close() {
      for (const server of servers) server.close();
      for (const socket of sockets) socket.destroy();
      return new Promise((done) => control.close(() => done()));
    },
  };
}
