import { realpathSync } from "node:fs";
import fs from "node:fs/promises";
import http from "node:http";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  buildLocalProcessSandboxSpawnTarget,
  parseLocalProcessFilesystemScope,
  parseLocalProcessNetworkAllowlist,
  parseLocalProcessNetworkScope,
  parseLocalProcessSandboxExtraPaths,
  type LocalProcessSandboxOptions,
} from "./local-process-sandbox.js";
import { runChildProcess } from "./server-utils.js";

const cleanup: string[] = [];

// A confined run is refused unless its command lies in the Nix store, so the
// tests that build one need a Node from there.
const commandInNixStore = realpathSync(process.execPath).startsWith("/nix/store/");
const confinable = process.platform === "linux" && commandInNixStore;

async function withTmpDir<T>(tmpDir: string, run: () => Promise<T>): Promise<T> {
  const previousTmpDir = process.env.TMPDIR;
  process.env.TMPDIR = tmpDir;
  try {
    return await run();
  } finally {
    if (previousTmpDir === undefined) delete process.env.TMPDIR;
    else process.env.TMPDIR = previousTmpDir;
  }
}

beforeEach(() => {
  process.env.PAPERCLIP_SANDBOX_PATHS = JSON.stringify({ read: ["/nix/store"], workspaceRoots: [os.tmpdir()] });
});

afterEach(async () => {
  delete process.env.PAPERCLIP_SANDBOX_PATHS;
  await Promise.all(cleanup.splice(0).map((candidate) => fs.rm(candidate, { recursive: true, force: true })));
});

describe("local process sandbox", () => {
  it.runIf(process.platform !== "linux")("rejects sandbox scopes on unsupported hosts", async () => {
    await expect(buildLocalProcessSandboxSpawnTarget({
      executable: process.execPath, args: ["-e", "process.exit(0)"], cwd: process.cwd(),
      options: { workspaceDir: process.cwd(), networkScope: "deny" },
    })).rejects.toThrow("supported only on Linux");
  });

  it("parses read-only and writable extra paths", () => {
    expect(parseLocalProcessSandboxExtraPaths(["/opt/cache", { path: "/var/lib/tool", access: "rw" }])).toEqual([
      { path: "/opt/cache", access: "ro" },
      { path: "/var/lib/tool", access: "rw" },
    ]);
    expect(() => parseLocalProcessSandboxExtraPaths(["relative"])).toThrow("must be an absolute path");
  });

  it("parses network scopes and exact-host allowlists", () => {
    expect(parseLocalProcessFilesystemScope("workspace")).toBe("workspace");
    expect(parseLocalProcessFilesystemScope(undefined)).toBeNull();
    expect(() => parseLocalProcessFilesystemScope("workpace")).toThrow('filesystemScope must be "workspace"');
    expect(parseLocalProcessNetworkScope("deny")).toBe("deny");
    expect(parseLocalProcessNetworkScope("allowlist")).toBe("allowlist");
    expect(parseLocalProcessNetworkScope(undefined)).toBeNull();
    expect(parseLocalProcessNetworkAllowlist(["api.openai.com", "https://api.anthropic.com", "gateway.test:8443"]))
      .toEqual(["api.openai.com", "api.anthropic.com", "gateway.test:8443"]);
    expect(() => parseLocalProcessNetworkAllowlist(["*.example.com"])).toThrow("exact hostname");
    expect(() => parseLocalProcessNetworkScope("public")).toThrow('"deny" or "allowlist"');
  });

  it.runIf(process.platform === "linux")("describes every valid allowlist input when no proxy rules remain", async () => {
    const workspace = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-network-rules-"));
    cleanup.push(workspace);

    await expect(buildLocalProcessSandboxSpawnTarget({
      executable: process.execPath,
      args: ["-e", "process.exit(0)"],
      cwd: workspace,
      options: {
        workspaceDir: workspace,
        networkScope: "allowlist",
        networkAllowlist: [],
        networkTrustedUrls: ["file:///not-a-network-target"],
      },
    })).rejects.toThrow("valid networkAllowlist hostname or HTTP(S) networkTrustedUrl");
  });

  it.runIf(confinable)("builds a fresh-root bubblewrap command with workspace access", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-fs-sandbox-"));
    cleanup.push(root);
    const workspace = path.join(root, "workspace");
    const managedHome = path.join(root, "managed-home");
    await fs.mkdir(workspace);
    await fs.mkdir(managedHome);

    const target = await buildLocalProcessSandboxSpawnTarget({
      executable: process.execPath,
      args: ["-e", "console.log('ok')"],
      cwd: workspace,
      options: {
        workspaceDir: workspace,
        filesystemScope: "workspace",
        managedPaths: [{ path: managedHome, access: "rw" }],
        homeDir: managedHome,
      },
    });

    expect(target.command).toBe("bwrap");
    expect(target.args).toContain("--tmpfs");
    expect(target.args).toContain(workspace);
    expect(target.args).toContain(managedHome);
    expect(target.args.slice(-3)).toEqual([process.execPath, "-e", "console.log('ok')"]);
  });

  it.runIf(confinable)("binds a confined absolute alias to the synchronized workspace", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-fs-alias-"));
    cleanup.push(root);
    const workspace = path.join(root, "workspace");
    await fs.mkdir(workspace);

    const target = await buildLocalProcessSandboxSpawnTarget({
      executable: process.execPath,
      args: ["-e", "process.exit(0)"],
      cwd: workspace,
      options: {
        workspaceDir: workspace,
        filesystemScope: "workspace",
        pathAliases: [{ path: "/app", target: workspace }],
      },
    });

    expect(target.args).toEqual(expect.arrayContaining(["--bind", workspace, "/app"]));
  });

  it.runIf(process.platform === "linux")("rejects writable out-of-tree paths without an outbound restore mapping", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-fs-outbound-"));
    cleanup.push(root);
    const workspace = path.join(root, "workspace");
    const outside = path.join(root, "outside");
    await fs.mkdir(workspace);
    await fs.mkdir(outside);

    await expect(buildLocalProcessSandboxSpawnTarget({
      executable: process.execPath,
      args: ["-e", "process.exit(0)"],
      cwd: workspace,
      options: {
        workspaceDir: workspace,
        filesystemScope: "workspace",
        extraPaths: [{ path: outside, access: "rw" }],
      },
    })).rejects.toThrow("has no outbound restore mapping");
  });

  it.runIf(process.platform === "linux")("builds a network-only namespace without changing filesystem visibility", async () => {
    const workspace = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-network-sandbox-"));
    cleanup.push(workspace);
    const target = await buildLocalProcessSandboxSpawnTarget({
      executable: process.execPath,
      args: ["-e", "console.log('ok')"],
      cwd: workspace,
      options: { workspaceDir: workspace, networkScope: "deny" },
    });

    expect(target.args).toContain("--unshare-net");
    expect(target.args).toContain("--bind");
    expect(target.args).not.toContain("--tmpfs");
    expect(target.env?.HTTP_PROXY).toBeUndefined();
  });

  it.runIf(confinable)("forwards allowed proxy targets with a deep TMPDIR and rejects other hosts", async () => {
    const workspace = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-network-proxy-"));
    cleanup.push(workspace);
    const deepTmpDir = path.join(workspace, ...Array.from({ length: 6 }, () => "deep-temporary-directory-segment"));
    await fs.mkdir(deepTmpDir, { recursive: true });
    const server = http.createServer((_request, response) => response.end("allowed-response"));
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("Expected TCP test server address.");
    const target = await withTmpDir(deepTmpDir, () =>
      buildLocalProcessSandboxSpawnTarget({
        executable: process.execPath,
        args: ["-e", "process.exit(0)"],
        cwd: workspace,
        options: {
          workspaceDir: workspace,
          filesystemScope: "workspace",
          networkScope: "allowlist",
          networkAllowlist: [`127.0.0.1:${address.port}`],
        },
      }),
    );
    const delimiterIndex = target.args.indexOf("--");
    const socketPath = target.args[delimiterIndex + 3];
    expect(Buffer.byteLength(path.join(deepTmpDir, "paperclip-network-sandbox-XXXXXX", "proxy.sock"))).toBeGreaterThan(107);
    expect(Buffer.byteLength(socketPath)).toBeLessThanOrEqual(107);
    expect(socketPath).toMatch(/^\/tmp\/paperclip-network-sandbox-/);
    expect(target.args).toContain(path.dirname(socketPath));
    const request = (url: string) => new Promise<{ status: number; contentType: string | null; body: string }>((resolve, reject) => {
      const outgoing = http.request({ socketPath, path: url, headers: { host: new URL(url).host } }, (response) => {
        let body = "";
        response.on("data", (chunk) => {
          body += chunk;
        });
        response.on("end", () => resolve({
          status: response.statusCode ?? 0,
          contentType: typeof response.headers["content-type"] === "string" ? response.headers["content-type"] : null,
          body,
        }));
      });
      outgoing.on("error", reject);
      outgoing.end();
    });

    try {
      await expect(request(`http://127.0.0.1:${address.port}/canary`)).resolves.toEqual({
        status: 200,
        contentType: null,
        body: "allowed-response",
      });
      await expect(request("http://example.com/")).resolves.toEqual({
        status: 403,
        contentType: "application/json; charset=utf-8",
        body: '{"error":{"code":"network_target_denied","message":"Network target denied by Paperclip sandbox policy."}}\n',
      });
      const connectResponse = await new Promise<string>((resolve, reject) => {
        const socket = net.createConnection(socketPath, () => {
          socket.end("CONNECT example.com:443 HTTP/1.1\r\nHost: example.com:443\r\n\r\n");
        });
        let response = "";
        socket.setEncoding("utf8");
        socket.on("data", (chunk) => { response += chunk; });
        socket.on("end", () => resolve(response));
        socket.on("error", reject);
      });
      expect(connectResponse).toContain("HTTP/1.1 403 Forbidden\r\n");
      expect(connectResponse).toContain("Content-Type: application/json; charset=utf-8\r\n");
      expect(connectResponse).toContain(
        '{"error":{"code":"network_target_denied","message":"Network target denied by Paperclip sandbox policy."}}\n',
      );
    } finally {
      await target.cleanup?.();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  it.runIf(process.platform === "linux")("always permits trusted Paperclip control-plane URLs", async () => {
    const workspace = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-network-trusted-"));
    cleanup.push(workspace);
    const server = http.createServer((_request, response) => response.end("control-plane-response"));
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("Expected TCP test server address.");
    const target = await buildLocalProcessSandboxSpawnTarget({
      executable: process.execPath,
      args: ["-e", "process.exit(0)"],
      cwd: workspace,
      options: {
        workspaceDir: workspace,
        networkScope: "allowlist",
        networkAllowlist: ["api.openai.com"],
        networkTrustedUrls: [`http://127.0.0.1:${address.port}/api/issues/issue-1`],
      },
    });
    const delimiterIndex = target.args.indexOf("--");
    const socketPath = target.args[delimiterIndex + 3];

    try {
      const response = await new Promise<{ status: number; body: string }>((resolve, reject) => {
        const outgoing = http.request({
          socketPath,
          path: `http://127.0.0.1:${address.port}/api/issues/issue-1`,
          headers: { host: `127.0.0.1:${address.port}` },
        }, (incoming) => {
          let body = "";
          incoming.on("data", (chunk) => { body += chunk; });
          incoming.on("end", () => resolve({ status: incoming.statusCode ?? 0, body }));
        });
        outgoing.on("error", reject);
        outgoing.end();
      });
      expect(response).toEqual({ status: 200, body: "control-plane-response" });
    } finally {
      await target.cleanup?.();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  it("fails clearly when Bubblewrap is unavailable", async () => {
    const workspace = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-fs-sandbox-missing-"));
    cleanup.push(workspace);
    await expect(
      runChildProcess("filesystem-sandbox-missing", process.execPath, ["-e", "process.exit(0)"], {
        cwd: workspace,
        env: {},
        timeoutSec: 10,
        graceSec: 1,
        onLog: async () => {},
        localProcessSandbox: {
          workspaceDir: workspace,
          filesystemScope: "workspace",
          command: path.join(workspace, "missing-bwrap"),
        },
      }),
    ).rejects.toThrow("requires Bubblewrap");
  });

  it("refuses a sandbox command other than the one the host names", async () => {
    const workspace = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-fs-sandbox-host-command-"));
    cleanup.push(workspace);
    process.env.PAPERCLIP_SANDBOX_BWRAP = path.join(workspace, "host-bwrap");
    try {
      await expect(
        runChildProcess("filesystem-sandbox-host-command", process.execPath, ["-e", "process.exit(0)"], {
          cwd: workspace,
          env: {},
          timeoutSec: 10,
          graceSec: 1,
          onLog: async () => {},
          localProcessSandbox: {
            workspaceDir: workspace,
            filesystemScope: "workspace",
            command: path.join(workspace, "agent-chosen-bwrap"),
          },
        }),
      ).rejects.toThrow("is not the host bubblewrap");
    } finally {
      delete process.env.PAPERCLIP_SANDBOX_BWRAP;
    }
  });

  it.runIf(Boolean(process.env.PAPERCLIP_TEST_BWRAP))(
    "prevents reads outside the workspace while allowing workspace writes",
    async () => {
      const root = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-fs-sandbox-integration-"));
      cleanup.push(root);
      const workspace = path.join(root, "workspace");
      const outside = path.join(root, "canary.txt");
      const allowed = path.join(root, "allowed.txt");
      await fs.mkdir(workspace);
      await fs.writeFile(outside, "host-secret", "utf8");
      await fs.writeFile(allowed, "allowed-value", "utf8");

      const script = [
        "const fs = require('node:fs');",
        `try { fs.readFileSync(${JSON.stringify(outside)}, 'utf8'); process.exit(9); } catch (error) {`,
        "  if (!['ENOENT', 'EACCES'].includes(error.code)) throw error;",
        "}",
        `if (fs.readFileSync(${JSON.stringify(allowed)}, 'utf8') !== 'allowed-value') process.exit(8);`,
        "fs.writeFileSync('workspace-ok.txt', 'ok');",
      ].join("\n");
      const result = await runChildProcess("filesystem-sandbox-test", process.execPath, ["-e", script], {
        cwd: workspace,
        env: {},
        timeoutSec: 10,
        graceSec: 1,
        onLog: async () => {},
        localProcessSandbox: {
          workspaceDir: workspace,
          filesystemScope: "workspace",
          extraPaths: [{ path: allowed, access: "ro" }],
          command: process.env.PAPERCLIP_TEST_BWRAP,
        },
      });

      expect(result.exitCode, result.stderr).toBe(0);
      await expect(fs.readFile(path.join(workspace, "workspace-ok.txt"), "utf8")).resolves.toBe("ok");
    },
  );

  it.runIf(Boolean(process.env.PAPERCLIP_TEST_BWRAP && process.env.PAPERCLIP_TEST_SANDBOX_BUILD))(
    "runs the adapter-utils TypeScript build inside the confined workspace",
    async () => {
      const workspace = process.cwd();
      const result = await runChildProcess(
        "filesystem-sandbox-build-test",
        path.join(workspace, "node_modules", ".bin", "tsc"),
        ["--noEmit", "-p", "packages/adapter-utils/tsconfig.json"],
        {
          cwd: workspace,
          env: {},
          timeoutSec: 60,
          graceSec: 2,
          onLog: async () => {},
          localProcessSandbox: {
            workspaceDir: workspace,
            filesystemScope: "workspace",
            command: process.env.PAPERCLIP_TEST_BWRAP,
          },
        },
      );

      expect(result.exitCode, result.stderr).toBe(0);
    },
  );

  it.runIf(Boolean(process.env.PAPERCLIP_TEST_BWRAP))(
    "denies direct network egress",
    async () => {
      const workspace = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-network-deny-"));
      cleanup.push(workspace);
      const server = http.createServer((_request, response) => response.end("host-network"));
      await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
      const address = server.address();
      if (!address || typeof address === "string") throw new Error("Expected TCP test server address.");
      const script = `require("node:http").get("http://127.0.0.1:${address.port}", () => process.exit(9)).on("error", () => process.exit(0));`;
      try {
        const result = await runChildProcess("network-sandbox-deny-test", process.execPath, ["-e", script], {
          cwd: workspace,
          env: {},
          timeoutSec: 10,
          graceSec: 1,
          onLog: async () => {},
          localProcessSandbox: {
            workspaceDir: workspace,
            networkScope: "deny",
            command: process.env.PAPERCLIP_TEST_BWRAP,
          },
        });
        expect(result.exitCode, result.stderr).toBe(0);
      } finally {
        await new Promise<void>((resolve) => server.close(() => resolve()));
      }
    },
  );

  it.runIf(Boolean(process.env.PAPERCLIP_TEST_BWRAP))(
    "allows only configured network targets through the proxy bridge",
    async () => {
      const workspace = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-network-allowlist-"));
      cleanup.push(workspace);
      const server = http.createServer((_request, response) => response.end("allowed-response"));
      await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
      const address = server.address();
      if (!address || typeof address === "string") throw new Error("Expected TCP test server address.");
      const targetUrl = `http://127.0.0.1:${address.port}/canary`;
      const deniedUrl = "http://example.com/";
      const script = `
const http = require("node:http");
const proxy = new URL(process.env.HTTP_PROXY);
function request(url) {
  return new Promise((resolve, reject) => {
    http.get({ hostname: proxy.hostname, port: proxy.port, path: url }, (response) => {
      let body = "";
      response.on("data", (chunk) => body += chunk);
      response.on("end", () => resolve({ status: response.statusCode, body }));
    }).on("error", reject);
  });
}
(async () => {
  const allowed = await request(${JSON.stringify(targetUrl)});
  const denied = await request(${JSON.stringify(deniedUrl)});
  if (allowed.status !== 200 || allowed.body !== "allowed-response" || denied.status !== 403) process.exit(8);
})().catch((error) => { console.error(error); process.exit(7); });
`;
      try {
        const deepTmpDir = path.join(workspace, ...Array.from({ length: 6 }, () => "deep-temporary-directory-segment"));
        await fs.mkdir(deepTmpDir, { recursive: true });
        const result = await withTmpDir(deepTmpDir, () =>
          runChildProcess(
            "network-sandbox-allowlist-test",
            process.execPath,
            ["-e", script],
            {
              cwd: workspace,
              env: {},
              timeoutSec: 10,
              graceSec: 1,
              onLog: async () => {},
              localProcessSandbox: {
                workspaceDir: workspace,
                filesystemScope: "workspace",
                networkScope: "allowlist",
                networkAllowlist: [`127.0.0.1:${address.port}`],
                command: process.env.PAPERCLIP_TEST_BWRAP,
              },
            },
          ),
        );
        expect(result.exitCode, result.stderr).toBe(0);
      } finally {
        await new Promise<void>((resolve) => server.close(() => resolve()));
      }
    },
  );
});

describe.runIf(confinable)("local process sandbox on a host with its own sandbox paths", () => {
  async function hostTree() {
    const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-host-sandbox-")));
    cleanup.push(root);
    const dirs = [
      "proj/c1/p/repo/.git/worktrees/wt", "proj/c1/p/wt", "proj/c2/p/repo/.git/worktrees/wt", "proj/c2/p/wt",
      "ws/a1", "home", "provider", "kept",
    ];
    for (const dir of dirs) await fs.mkdir(path.join(root, dir), { recursive: true });
    for (const company of ["c1", "c2"]) {
      const repo = path.join(root, "proj", company, "p", "repo", ".git");
      await fs.writeFile(path.join(repo, "config"), "[core]\n");
      await fs.writeFile(path.join(root, "proj", company, "p", "wt", ".git"), `gitdir: ${repo}/worktrees/wt\n`);
      await fs.writeFile(path.join(repo, "worktrees", "wt", "commondir"), "../..\n");
      await fs.writeFile(path.join(repo, "worktrees", "wt", "gitdir"), `${root}/proj/${company}/p/wt/.git\n`);
    }
    await fs.symlink(path.join(root, "kept"), path.join(root, "provider", "projects"));
    // A bare mirror the company writes, its ADO refs read-only inside it.
    await fs.mkdir(path.join(root, "mirror.git", "objects"), { recursive: true });
    await fs.mkdir(path.join(root, "mirror.git", "refs", "ado"), { recursive: true });
    await fs.writeFile(path.join(root, "mirror.git", "HEAD"), "ref: refs/heads/main\n");
    await fs.writeFile(path.join(root, "mirror.git", "config"), "[core]\n");
    // A detached project repository four levels down in the workspace.
    const detached = path.join(root, "proj/c1/p/wt/.paperclip-runtime/detached-repositories/d1/.git");
    await fs.mkdir(detached, { recursive: true });
    await fs.writeFile(path.join(detached, "config"), "[core]\n");
    process.env.PAPERCLIP_SANDBOX_PATHS = JSON.stringify({
      read: ["/nix/store"],
      write: [],
      projects: path.join(root, "proj"),
      workspaces: path.join(root, "ws"),
      companies: {
        c1: {
          write: [path.join(root, "mirror.git")],
          read: [path.join(root, "mirror.git/refs/ado")],
          gitRoots: [path.join(root, "mirror.git")],
        },
      },
    });
    return { root, detached };
  }

  const input = (root: string, workspaceDir: string, extra: Partial<LocalProcessSandboxOptions> = {}) => ({
    executable: process.execPath,
    args: [],
    cwd: workspaceDir,
    options: {
      filesystemScope: "workspace" as const,
      workspaceDir,
      companyId: "c1",
      agentId: "a1",
      runPaths: [path.join(root, "home")],
      repoRoots: [path.join(root, "proj/c1/p/repo")],
      managedPaths: [{ path: path.join(root, "provider"), access: "rw" as const }],
      ...extra,
    },
  });

  async function binds(root: string, workspaceDir: string, extra?: Partial<LocalProcessSandboxOptions>) {
    const { args } = await buildLocalProcessSandboxSpawnTarget(input(root, workspaceDir, extra));
    const pairs: string[] = [];
    args.forEach((arg, index) => {
      if (arg === "--bind" || arg === "--ro-bind") pairs.push(`${arg} ${args[index + 1]}`);
    });
    return pairs;
  }

  it("binds a worktree's run paths, linked targets, common directory and read-only git metadata", async () => {
    const { root, detached } = await hostTree();
    const worktree = await binds(root, path.join(root, "proj/c1/p/wt"));
    const repo = path.join(root, "proj/c1/p/repo/.git");
    expect(worktree).toEqual(expect.arrayContaining([
      `--bind ${root}/proj/c1/p/wt`,
      `--bind ${repo}`,
      `--bind ${root}/kept`,
      `--bind ${root}/home`,
      `--ro-bind ${root}/proj/c1/p/wt/.git`,
      `--ro-bind ${repo}/config`,
      `--ro-bind ${repo}/hooks`,
      `--ro-bind ${repo}/info`,
      `--ro-bind ${repo}/worktrees/wt/commondir`,
      `--ro-bind ${repo}/worktrees/wt/gitdir`,
    ]));
    // Of nested host paths the deeper one's access wins, and a gitRoots
    // repository's metadata is read-only, bound after every read-write bind.
    const at = (bind: string) => worktree.lastIndexOf(bind);
    expect(at(`--bind ${root}/mirror.git`)).toBeGreaterThanOrEqual(0);
    expect(at(`--bind ${root}/mirror.git`)).toBeLessThan(at(`--ro-bind ${root}/mirror.git/refs/ado`));
    for (const name of ["config", "hooks", "info", "commondir"]) {
      for (const repository of [`${root}/mirror.git`, detached]) {
        expect(at(`--ro-bind ${repository}/${name}`)).toBeGreaterThan(at(`--bind ${root}/proj/c1/p/wt`));
      }
    }
  });

  it("binds no common directory for a .git link that points at another workspace's worktree", async () => {
    const { root } = await hostTree();
    await fs.writeFile(path.join(root, "ws/a1/.git"), `gitdir: ${root}/proj/c1/p/repo/.git/worktrees/wt\n`);
    expect(await binds(root, path.join(root, "ws/a1"))).not.toContain(`--bind ${root}/proj/c1/p/repo/.git`);
  });

  it("refuses a workspace, an extra path or a command outside the company's roots and the Nix store", async () => {
    const { root } = await hostTree();
    await expect(buildLocalProcessSandboxSpawnTarget(input(root, path.join(root, "proj/c2/p/wt"))))
      .rejects.toThrow("Paperclip host refuses the confined run");
    await expect(buildLocalProcessSandboxSpawnTarget(input(root, path.join(root, "ws/a1"), {
      extraPaths: [{ path: path.join(root, "proj/c2/p/wt"), access: "ro" }],
    }))).rejects.toThrow("Paperclip host refuses the confined run");
    await expect(buildLocalProcessSandboxSpawnTarget({
      ...input(root, path.join(root, "ws/a1")),
      executable: path.join(root, "home"),
    })).rejects.toThrow("not in the Nix store");
  });

  it("refuses every confined run on a host that names no sandbox paths", async () => {
    const { root } = await hostTree();
    delete process.env.PAPERCLIP_SANDBOX_PATHS;
    await expect(buildLocalProcessSandboxSpawnTarget(input(root, path.join(root, "ws/a1"))))
      .rejects.toThrow("Paperclip host refuses the confined run");
  });

  it("binds the sources' realpaths", async () => {
    const { root } = await hostTree();
    await fs.mkdir(path.join(root, "ws/a1/real"));
    await fs.symlink(path.join(root, "ws/a1/real"), path.join(root, "ws/a1/link"));
    const target = await buildLocalProcessSandboxSpawnTarget(
      input(root, path.join(root, "ws/a1"), { extraPaths: [{ path: path.join(root, "ws/a1/link"), access: "ro" }] }),
    );
    const index = target.args.lastIndexOf(path.join(root, "ws/a1/link"));
    expect(target.args.slice(index - 2, index + 1)).toEqual(["--ro-bind", path.join(root, "ws/a1/real"), path.join(root, "ws/a1/link")]);
  });
});
