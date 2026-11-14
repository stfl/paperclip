import { spawn } from "node:child_process";
import { once } from "node:events";
import net from "node:net";
import { describe, expect, it, vi } from "vitest";

import {
  ListenPortBusyError,
  isListenStrict,
  resolveListenTarget,
  takeSystemdListenFd,
} from "../listen-target.ts";

describe("takeSystemdListenFd", () => {
  it("returns fd 3 when the activation variables name this process", () => {
    const env: NodeJS.ProcessEnv = { LISTEN_PID: "4242", LISTEN_FDS: "1", LISTEN_FDNAMES: "http" };
    expect(takeSystemdListenFd(env, 4242)).toBe(3);
  });

  it("ignores activation variables meant for another process", () => {
    expect(takeSystemdListenFd({ LISTEN_PID: "4241", LISTEN_FDS: "1" }, 4242)).toBeNull();
  });

  it("ignores an activation without file descriptors", () => {
    expect(takeSystemdListenFd({ LISTEN_PID: "4242", LISTEN_FDS: "0" }, 4242)).toBeNull();
    expect(takeSystemdListenFd({ LISTEN_PID: "4242" }, 4242)).toBeNull();
    expect(takeSystemdListenFd({ LISTEN_PID: "4242", LISTEN_FDS: "one" }, 4242)).toBeNull();
  });

  it("removes the activation variables whether or not they apply", () => {
    for (const pid of [4242, 1]) {
      const env: NodeJS.ProcessEnv = {
        LISTEN_PID: "4242",
        LISTEN_FDS: "1",
        LISTEN_FDNAMES: "http",
        PAPERCLIP_HOME: "/srv/paperclip",
      };
      takeSystemdListenFd(env, pid);
      expect(env).toEqual({ PAPERCLIP_HOME: "/srv/paperclip" });
    }
  });
});

describe("isListenStrict", () => {
  it("reads PAPERCLIP_LISTEN_STRICT as a boolean flag", () => {
    expect(isListenStrict({ PAPERCLIP_LISTEN_STRICT: "1" })).toBe(true);
    expect(isListenStrict({ PAPERCLIP_LISTEN_STRICT: "true" })).toBe(true);
    expect(isListenStrict({ PAPERCLIP_LISTEN_STRICT: "0" })).toBe(false);
    expect(isListenStrict({})).toBe(false);
  });
});

describe("resolveListenTarget", () => {
  it("listens on the inherited fd and keeps the configured port without probing it", async () => {
    const detectPort = vi.fn(async () => 3101);
    const target = await resolveListenTarget({
      host: "127.0.0.1",
      port: 3100,
      inheritedFd: 3,
      strict: false,
      detectPort,
    });
    expect(target).toEqual({ kind: "inherited-fd", fd: 3, port: 3100 });
    expect(detectPort).not.toHaveBeenCalled();
  });

  it("falls back to the next free port when the configured port is busy", async () => {
    const target = await resolveListenTarget({
      host: "127.0.0.1",
      port: 3100,
      inheritedFd: null,
      strict: false,
      detectPort: async () => 3101,
    });
    expect(target).toEqual({ kind: "host-port", host: "127.0.0.1", port: 3101 });
  });

  it("refuses the fallback when strict", async () => {
    await expect(
      resolveListenTarget({
        host: "127.0.0.1",
        port: 3100,
        inheritedFd: null,
        strict: true,
        detectPort: async () => 3101,
      }),
    ).rejects.toBeInstanceOf(ListenPortBusyError);
  });

  it("listens on a free configured port when strict", async () => {
    const target = await resolveListenTarget({
      host: "127.0.0.1",
      port: 3100,
      inheritedFd: null,
      strict: true,
      detectPort: async () => 3100,
    });
    expect(target).toEqual({ kind: "host-port", host: "127.0.0.1", port: 3100 });
  });
});

// The parent passes a listening socket as fd 3 without close-on-exec, as
// systemd does. The child adopts it with `listen({ fd: 3 })`, answers one
// connection, and reports whether a process it spawns holds the same socket.
const ADOPTING_CHILD = `
const { spawnSync } = require("node:child_process");
const fs = require("node:fs");
const net = require("node:net");
const socket = fs.readlinkSync("/proc/self/fd/3");
const server = net.createServer((conn) => conn.end("adopted"));
server.listen({ fd: 3 }, () => {
  const probe = spawnSync(process.execPath, ["-e", \`
    const fs = require("node:fs");
    const held = fs.readdirSync("/proc/self/fd").some((fd) => {
      try { return fs.readlinkSync("/proc/self/fd/" + fd) === process.argv[1]; } catch { return false; }
    });
    process.stdout.write(String(held));
  \`, socket], { encoding: "utf8" });
  process.send({ grandchildHoldsSocket: probe.stdout === "true" });
});
`;

describe.skipIf(process.platform !== "linux")("a socket adopted from fd 3", () => {
  it("serves connections and is not inherited by the server's children", async () => {
    const parentServer = net.createServer();
    parentServer.listen(0, "127.0.0.1");
    await once(parentServer, "listening");
    const { port } = parentServer.address() as net.AddressInfo;

    const listeningFd = (parentServer as unknown as { _handle: { fd: number } })._handle.fd;
    const child = spawn(process.execPath, ["-e", ADOPTING_CHILD], {
      stdio: ["ignore", "inherit", "inherit", listeningFd, "ipc"],
    });
    try {
      const [report] = (await once(child, "message")) as [{ grandchildHoldsSocket: boolean }];
      expect(report.grandchildHoldsSocket).toBe(false);

      // Stop accepting in the parent so the connection reaches the child.
      parentServer.close();
      const reply = await new Promise<string>((resolve, reject) => {
        const conn = net.connect(port, "127.0.0.1");
        let data = "";
        conn.on("data", (chunk) => (data += chunk));
        conn.on("end", () => resolve(data));
        conn.on("error", reject);
      });
      expect(reply).toBe("adopted");
    } finally {
      child.kill();
      parentServer.close();
    }
  });
});
