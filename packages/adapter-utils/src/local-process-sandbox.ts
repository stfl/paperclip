import fs from "node:fs/promises";
import http from "node:http";
import net from "node:net";
import os from "node:os";
import path from "node:path";

export type LocalProcessSandboxAccess = "ro" | "rw";
export type LocalProcessNetworkScope = "deny" | "allowlist";

export interface LocalProcessSandboxPath {
  path: string;
  access: LocalProcessSandboxAccess;
}

export interface LocalProcessSandboxPathAlias {
  path: string;
  target: string;
}

export interface LocalProcessSandboxOptions {
  workspaceDir: string;
  filesystemScope?: "workspace" | null;
  managedPaths?: LocalProcessSandboxPath[];
  extraPaths?: LocalProcessSandboxPath[];
  pathAliases?: LocalProcessSandboxPathAlias[];
  outboundRestorePaths?: string[];
  homeDir?: string | null;
  networkScope?: LocalProcessNetworkScope | null;
  networkAllowlist?: string[];
  networkTrustedUrls?: string[];
  command?: string;
  /** Company and agent of the run; select the host's per-company and per-agent sandbox paths. */
  companyId?: string | null;
  agentId?: string | null;
  /** Read-write directories of the run itself, such as the agent home and the scratch directory. */
  runPaths?: string[];
  /** Working directories of the run's project workspaces, which name the repositories its worktrees belong to. */
  repoRoots?: string[];
}

export interface LocalProcessSandboxSpawnTarget {
  command: string;
  args: string[];
  cwd: string;
  env?: Record<string, string | undefined>;
  cleanup?: () => Promise<void>;
}

interface NetworkAllowlistRule {
  hostname: string;
  port: string | null;
}

interface NetworkAllowlistProxy {
  close: () => Promise<void>;
}

const SYSTEM_READ_PATHS = [
  "/bin",
  "/sbin",
  "/usr",
  "/lib",
  "/lib64",
  "/etc/ca-certificates",
  "/etc/ssl",
  "/etc/resolv.conf",
  "/etc/hosts",
  "/etc/nsswitch.conf",
  "/etc/passwd",
  "/etc/group",
  "/etc/localtime",
  "/etc/timezone",
  "/etc/gitconfig",
] as const;

const PROXY_ENV_KEYS = ["HTTP_PROXY", "HTTPS_PROXY", "ALL_PROXY", "http_proxy", "https_proxy", "all_proxy"] as const;
const SANDBOX_PROXY_PORT = 31_337;
const UNIX_SOCKET_PATH_MAX_BYTES = 107;
const NETWORK_PROXY_TEMP_PREFIX = "paperclip-network-sandbox-";

function normalizeAbsolutePath(candidate: string, label: string): string {
  const trimmed = candidate.trim();
  if (!trimmed || !path.isAbsolute(trimmed)) {
    throw new Error(`${label} must be an absolute path.`);
  }
  return path.resolve(trimmed);
}

async function pathExists(candidate: string): Promise<boolean> {
  return fs.lstat(candidate).then(() => true).catch(() => false);
}

function parentDirectories(candidate: string): string[] {
  const directories: string[] = [];
  let current = path.dirname(candidate);
  while (current !== path.dirname(current)) {
    directories.push(current);
    current = path.dirname(current);
  }
  return directories.reverse();
}

function addParentDirectories(args: string[], created: Set<string>, candidate: string): void {
  for (const directory of parentDirectories(candidate)) {
    if (created.has(directory)) continue;
    args.push("--dir", directory);
    created.add(directory);
  }
}

async function nearestPackageRoot(candidate: string): Promise<string> {
  let current = path.dirname(candidate);
  while (current !== path.dirname(current)) {
    if (await pathExists(path.join(current, "package.json"))) return current;
    current = path.dirname(current);
  }
  return path.dirname(candidate);
}

async function executableReadPaths(command: string): Promise<string[]> {
  const paths = new Set<string>();
  paths.add(path.dirname(command));
  const realCommand = await fs.realpath(command).catch(() => command);
  paths.add(await nearestPackageRoot(realCommand));
  return Array.from(paths);
}

function parseNetworkAllowlistEntry(entry: string, index: number): NetworkAllowlistRule {
  const trimmed = entry.trim();
  if (!trimmed) throw new Error(`networkAllowlist[${index}] must not be empty.`);
  let hostname: string;
  let port: string | null;
  try {
    const parsed = new URL(trimmed.includes("://") ? trimmed : `https://${trimmed}`);
    if (parsed.username || parsed.password || parsed.pathname !== "/" || parsed.search || parsed.hash) {
      throw new Error("path");
    }
    hostname = parsed.hostname.toLowerCase();
    port = parsed.port || null;
  } catch {
    throw new Error(`networkAllowlist[${index}] must be a hostname, hostname:port, or origin URL.`);
  }
  if (!hostname || hostname === "*" || hostname.startsWith("*.")) {
    throw new Error(`networkAllowlist[${index}] must use an exact hostname; wildcards are not supported.`);
  }
  return { hostname, port };
}

export function parseLocalProcessNetworkAllowlist(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.map((entry, index) => {
    if (typeof entry !== "string") throw new Error(`networkAllowlist[${index}] must be a string.`);
    const rule = parseNetworkAllowlistEntry(entry, index);
    return rule.port ? `${rule.hostname}:${rule.port}` : rule.hostname;
  });
}

export function parseLocalProcessNetworkScope(value: unknown): LocalProcessNetworkScope | null {
  if (value == null || value === "") return null;
  if (value === "deny" || value === "allowlist") return value;
  throw new Error('networkScope must be "deny" or "allowlist".');
}

export function parseLocalProcessFilesystemScope(value: unknown): "workspace" | null {
  if (value == null || value === "") return null;
  if (value === "workspace") return value;
  throw new Error('filesystemScope must be "workspace".');
}

function isNetworkTargetAllowed(hostname: string, port: string, rules: NetworkAllowlistRule[]): boolean {
  const normalizedHostname = hostname.toLowerCase().replace(/^\[|\]$/g, "");
  return rules.some((rule) => rule.hostname === normalizedHostname && (rule.port === null || rule.port === port));
}

function assertUnixSocketPathLength(socketPath: string): void {
  const pathBytes = Buffer.byteLength(socketPath);
  if (pathBytes > UNIX_SOCKET_PATH_MAX_BYTES) {
    throw new Error(
      `Paperclip sandbox proxy socket path is ${pathBytes} bytes, exceeding the Linux limit of ${UNIX_SOCKET_PATH_MAX_BYTES}: ${socketPath}`,
    );
  }
}

async function createNetworkProxyTempDir(): Promise<string> {
  const candidates = Array.from(new Set(["/tmp", os.tmpdir()]));
  let lastError: unknown;
  for (const baseDir of candidates) {
    try {
      const tempDir = await fs.mkdtemp(path.join(baseDir, NETWORK_PROXY_TEMP_PREFIX));
      try {
        assertUnixSocketPathLength(path.join(tempDir, "proxy.sock"));
        return tempDir;
      } catch (error) {
        await fs.rm(tempDir, { recursive: true, force: true });
        lastError = error;
      }
    } catch (error) {
      lastError = error;
    }
  }
  throw new Error("Unable to create a Linux-safe Paperclip sandbox proxy socket directory.", { cause: lastError });
}

function parseTrustedNetworkUrl(value: string): NetworkAllowlistRule | null {
  try {
    const parsed = new URL(value);
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return null;
    return {
      hostname: parsed.hostname.toLowerCase(),
      port: parsed.port || (parsed.protocol === "https:" ? "443" : "80"),
    };
  } catch {
    return null;
  }
}

function writeProxyError(response: http.ServerResponse, status: number, code: string, message: string): void {
  const body = `${JSON.stringify({ error: { code, message } })}\n`;
  response.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": Buffer.byteLength(body),
  }).end(body);
}

function connectProxyError(code: string, message: string): string {
  const body = `${JSON.stringify({ error: { code, message } })}\n`;
  return [
    "HTTP/1.1 403 Forbidden",
    "Connection: close",
    "Content-Type: application/json; charset=utf-8",
    `Content-Length: ${Buffer.byteLength(body)}`,
    "",
    body,
  ].join("\r\n");
}

async function startNetworkAllowlistProxy(
  allowlist: string[],
  trustedUrls: string[],
  socketPath: string,
): Promise<NetworkAllowlistProxy> {
  assertUnixSocketPathLength(socketPath);
  const rules = [
    ...allowlist.map(parseNetworkAllowlistEntry),
    ...trustedUrls.map(parseTrustedNetworkUrl).filter((rule): rule is NetworkAllowlistRule => rule !== null),
  ];
  if (rules.length === 0) {
    throw new Error(
      'networkScope="allowlist" requires at least one valid networkAllowlist hostname or HTTP(S) networkTrustedUrl.',
    );
  }
  const server = http.createServer((request, response) => {
    let target: URL;
    try {
      target = new URL(request.url ?? "");
    } catch {
      writeProxyError(response, 400, "invalid_request_url", "Paperclip sandbox proxy requires an absolute request URL.");
      return;
    }
    const port = target.port || (target.protocol === "https:" ? "443" : "80");
    if (target.protocol !== "http:") {
      writeProxyError(response, 400, "https_requires_connect", "HTTPS targets must use CONNECT through the Paperclip sandbox proxy.");
      return;
    }
    if (!isNetworkTargetAllowed(target.hostname, port, rules)) {
      writeProxyError(response, 403, "network_target_denied", "Network target denied by Paperclip sandbox policy.");
      return;
    }
    const upstream = http.request(target, {
      method: request.method,
      headers: { ...request.headers, host: target.host },
    }, (upstreamResponse) => {
      response.writeHead(upstreamResponse.statusCode ?? 502, upstreamResponse.headers);
      upstreamResponse.pipe(response);
    });
    upstream.on("error", (error) => response.destroy(error));
    request.pipe(upstream);
  });
  server.on("connect", (request, clientSocket, head) => {
    const separator = request.url?.lastIndexOf(":") ?? -1;
    const hostname = separator > 0 ? request.url!.slice(0, separator).replace(/^\[|\]$/g, "") : "";
    const port = separator > 0 ? request.url!.slice(separator + 1) : "443";
    if (!hostname || !/^\d+$/.test(port) || !isNetworkTargetAllowed(hostname, port, rules)) {
      clientSocket.end(connectProxyError(
        "network_target_denied",
        "Network target denied by Paperclip sandbox policy.",
      ));
      return;
    }
    const upstream = net.connect(Number(port), hostname, () => {
      clientSocket.write("HTTP/1.1 200 Connection Established\r\n\r\n");
      if (head.length > 0) upstream.write(head);
      upstream.pipe(clientSocket);
      clientSocket.pipe(upstream);
    });
    upstream.on("error", () => clientSocket.destroy());
    clientSocket.on("close", () => upstream.destroy());
  });
  const sockets = new Set<net.Socket>();
  server.on("connection", (socket) => {
    sockets.add(socket);
    socket.on("close", () => sockets.delete(socket));
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(socketPath, () => {
      server.off("error", reject);
      resolve();
    });
  });
  return {
    close: async () => {
      for (const socket of sockets) socket.destroy();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}

async function createNetworkProxyBridge(): Promise<string> {
  const source = `
const net = require("node:net");
const { spawn } = require("node:child_process");
const socketPath = process.argv[2];
const executable = process.argv[3];
const args = process.argv.slice(4);
const server = net.createServer((client) => {
  const upstream = net.connect(socketPath);
  client.pipe(upstream);
  upstream.pipe(client);
  const close = () => { client.destroy(); upstream.destroy(); };
  client.on("error", close);
  upstream.on("error", close);
});
server.listen(${SANDBOX_PROXY_PORT}, "127.0.0.1", () => {
  const child = spawn(executable, args, { stdio: "inherit", env: process.env });
  const forward = (signal) => { if (!child.killed) child.kill(signal); };
  process.on("SIGTERM", () => forward("SIGTERM"));
  process.on("SIGINT", () => forward("SIGINT"));
  child.on("exit", (code, signal) => server.close(() => {
    if (signal) process.kill(process.pid, signal);
    else process.exit(code == null ? 1 : code);
  }));
});
`;
  return source.trimStart();
}

type HostSandboxScope = Partial<Record<"read" | "write" | "workspaceRoots" | "gitRoots", unknown>>;

function ownEntry(group: unknown, key: string | null): HostSandboxScope | null {
  if (!key || !group || typeof group !== "object" || !Object.hasOwn(group, key)) return null;
  const entry = (group as Record<string, unknown>)[key];
  return entry && typeof entry === "object" ? (entry as HostSandboxScope) : null;
}

/**
 * The sandbox paths the host hands to every confined run, from the JSON in
 * PAPERCLIP_SANDBOX_PATHS: `read`, `write`, `workspaceRoots` and `gitRoots`
 * lists at the top level, per company under `companies` and per agent under
 * `agents`, with `{company}` standing for the run's company; `projects` and
 * `workspaces` name the directories holding the company projects and the
 * agent workspaces.
 */
function hostSandboxPaths(options: LocalProcessSandboxOptions) {
  let parsed: Record<string, unknown> = {};
  try {
    const value: unknown = JSON.parse(process.env.PAPERCLIP_SANDBOX_PATHS ?? "{}");
    if (value && typeof value === "object" && !Array.isArray(value)) parsed = value as Record<string, unknown>;
  } catch {
    parsed = {};
  }
  const company =
    typeof options.companyId === "string" && /^[0-9a-z-]+$/.test(options.companyId) ? options.companyId : null;
  const scopes = [
    parsed as HostSandboxScope,
    ownEntry(parsed.companies, company),
    ownEntry(parsed.agents, typeof options.agentId === "string" ? options.agentId : null),
  ];
  const paths = (key: keyof HostSandboxScope): string[] =>
    scopes
      .flatMap((scope) => {
        const list = scope?.[key];
        return Array.isArray(list) ? list : [];
      })
      .filter((entry): entry is string => typeof entry === "string" && (company !== null || !entry.includes("{company}")))
      .map((entry) => entry.replaceAll("{company}", company ?? ""));
  const directory = (value: unknown) => (typeof value === "string" && path.isAbsolute(value) ? value : null);
  return {
    read: paths("read"),
    write: paths("write"),
    workspaceRoots: paths("workspaceRoots"),
    gitRoots: paths("gitRoots"),
    projects: directory(parsed.projects),
    workspaces: directory(parsed.workspaces),
    company,
  };
}

/**
 * The common git directory of a worktree workspace. The run writes its `.git`
 * link, so the directory counts only when it lies under one of the run's own
 * roots, is the `.git` of a repository the server's workspace record names
 * (when the record names any), and its `worktrees/<name>/gitdir` points back at
 * this workspace's `.git`.
 */
async function sandboxGitCommonDir(workspaceDir: string, roots: string[], repoRoots: string[]): Promise<string | null> {
  const dotGit = path.join(workspaceDir, ".git");
  const link = await fs.readFile(dotGit, "utf8").catch(() => null);
  const gitDir = link?.match(/^gitdir: (.+)$/m)?.[1]?.trim();
  if (!gitDir) return null;
  const worktreeGitDir = await fs.realpath(path.resolve(workspaceDir, gitDir)).catch(() => null);
  const common = worktreeGitDir && (await fs.readFile(path.join(worktreeGitDir, "commondir"), "utf8").catch(() => null));
  const commonDir = common && worktreeGitDir
    ? await fs.realpath(path.resolve(worktreeGitDir, common.trim())).catch(() => null)
    : null;
  if (!commonDir || !worktreeGitDir || path.dirname(worktreeGitDir) !== path.join(commonDir, "worktrees")) return null;
  const back = await fs.readFile(path.join(worktreeGitDir, "gitdir"), "utf8").catch(() => null);
  const [backReal, ownReal] = await Promise.all([
    back ? fs.realpath(back.trim()).catch(() => null) : null,
    fs.realpath(dotGit).catch(() => null),
  ]);
  if (!backReal || backReal !== ownReal) return null;
  const realRoots = await Promise.all(roots.map((root) => fs.realpath(root).catch(() => path.resolve(root))));
  if (!realRoots.some((root) => commonDir.startsWith(`${root}/`))) return null;
  const recorded = await Promise.all(repoRoots.map((root) => fs.realpath(path.join(root, ".git")).catch(() => null)));
  if (repoRoots.length > 0 && !recorded.includes(commonDir)) return null;
  return commonDir;
}

/**
 * What git reads to decide what runs, in each repository at `root`, up to two
 * levels under it, or in the project repositories Paperclip keeps inside any
 * directory visited (`.paperclip-repositories/*`, where the server runs git,
 * and `.paperclip-runtime/detached-repositories/*`): a repository's `config`,
 * `config.worktree`, `hooks`, `info` and `commondir` (a missing `commondir`
 * is written as ".", which names the repository itself; git dies on an empty
 * one), its worktrees' pointers, and a worktree's `.git` link.
 */
async function gitMetadataUnder(root: string): Promise<string[]> {
  const found: string[] = [];
  const repository = async (dir: string) => {
    for (const name of ["hooks", "info"]) await fs.mkdir(path.join(dir, name), { recursive: true }).catch(() => undefined);
    await fs.writeFile(path.join(dir, "commondir"), ".\n", { flag: "wx", mode: 0o644 }).catch(() => undefined);
    found.push(...["config", "config.worktree", "hooks", "info", "commondir"].map((name) => path.join(dir, name)));
    for (const worktree of await fs.readdir(path.join(dir, "worktrees")).catch(() => [] as string[])) {
      found.push(...["config.worktree", "commondir", "gitdir"].map((name) => path.join(dir, "worktrees", worktree, name)));
    }
  };
  const visit = async (dir: string, level: number): Promise<void> => {
    if (!(await fs.lstat(dir).catch(() => null))?.isDirectory()) return;
    const dotGit = await fs.lstat(path.join(dir, ".git")).catch(() => null);
    if (dotGit?.isDirectory()) await repository(path.join(dir, ".git"));
    else if (dotGit?.isFile()) found.push(path.join(dir, ".git"));
    else if ((await pathExists(path.join(dir, "HEAD"))) && (await pathExists(path.join(dir, "objects")))) {
      await repository(dir);
      return;
    }
    if (level < 2) {
      for (const entry of await fs.readdir(dir, { withFileTypes: true }).catch(() => [])) {
        if (entry.isDirectory() && entry.name !== ".git") await visit(path.join(dir, entry.name), level + 1);
      }
    }
    for (const kept of [".paperclip-repositories", path.join(".paperclip-runtime", "detached-repositories")]) {
      for (const entry of await fs.readdir(path.join(dir, kept), { withFileTypes: true }).catch(() => [])) {
        if (entry.isDirectory()) await visit(path.join(dir, kept, entry.name), 2);
      }
    }
  };
  await visit(root, 0);
  return found;
}

export async function buildLocalProcessSandboxSpawnTarget(input: {
  executable: string;
  args: string[];
  cwd: string;
  options: LocalProcessSandboxOptions;
}): Promise<LocalProcessSandboxSpawnTarget> {
  if (process.platform !== "linux") {
    throw new Error("Local process filesystem and network scopes are currently supported only on Linux.");
  }
  const filesystemScope = input.options.filesystemScope ?? null;
  const networkScope = input.options.networkScope ?? null;
  if (!filesystemScope && !networkScope) throw new Error("Local process sandbox requires a filesystem or network scope.");

  const workspaceDir = normalizeAbsolutePath(input.options.workspaceDir, "Sandbox workspaceDir");
  const cwd = normalizeAbsolutePath(input.cwd, "Sandbox cwd");
  if (filesystemScope === "workspace") {
    const relativeCwd = path.relative(workspaceDir, cwd);
    if (relativeCwd.startsWith("..") || path.isAbsolute(relativeCwd)) {
      throw new Error(`Sandbox cwd "${cwd}" must be inside workspaceDir "${workspaceDir}".`);
    }
    const outboundRestorePaths = (input.options.outboundRestorePaths ?? []).map((candidate, index) =>
      normalizeAbsolutePath(candidate, `Sandbox outboundRestorePaths[${index}]`));
    for (const [index, extraPath] of (input.options.extraPaths ?? []).entries()) {
      if (extraPath.access !== "rw") continue;
      const normalizedExtraPath = normalizeAbsolutePath(extraPath.path, `Sandbox extraPaths[${index}].path`);
      const relativeToWorkspace = path.relative(workspaceDir, normalizedExtraPath);
      const synchronized = !relativeToWorkspace.startsWith("..") && !path.isAbsolute(relativeToWorkspace);
      const restored = outboundRestorePaths.some((restorePath) => {
        const relative = path.relative(restorePath, normalizedExtraPath);
        return !relative.startsWith("..") && !path.isAbsolute(relative);
      });
      if (!synchronized && !restored) {
        throw new Error(
          `Writable sandbox path "${normalizedExtraPath}" is outside synchronized workspace "${workspaceDir}" and has no outbound restore mapping.`,
        );
      }
    }
  }

  const bwrapCommand = input.options.command?.trim() || "bwrap";
  const args = ["--die-with-parent", "--new-session", "--unshare-pid", "--unshare-ipc", "--unshare-uts"];
  const env: Record<string, string | undefined> = {};
  let cleanup: (() => Promise<void>) | undefined;
  let executable = input.executable;
  let executableArgs = input.args;

  if (filesystemScope === "workspace") {
    args.push("--tmpfs", "/", "--proc", "/proc", "--dev", "/dev", "--tmpfs", "/tmp");
    // The links exist only where the host has them: NixOS keeps /bin a
    // directory of its own, with /bin/sh in it.
    for (const [target, link] of [["usr/bin", "/bin"], ["usr/sbin", "/sbin"], ["usr/lib", "/lib"], ["usr/lib64", "/lib64"]]) {
      if ((await fs.lstat(link).catch(() => null))?.isSymbolicLink()) args.push("--symlink", target, link);
    }
    const created = new Set<string>(["/", "/proc", "/dev", "/tmp"]);
    const mounted = new Set<string>();
    const mount = async (source: string, access: LocalProcessSandboxAccess) => {
      const normalized = normalizeAbsolutePath(source, "Sandbox path");
      if (mounted.has(normalized) || !(await pathExists(normalized))) return;
      addParentDirectories(args, created, normalized);
      // The source is the realpath: the host checks a run-controlled path by its
      // realpath, and binding that same path leaves no window for a symlink swap
      // between the check and bwrap's open.
      args.push(
        access === "rw" ? "--bind" : "--ro-bind",
        await fs.realpath(normalized).catch(() => normalized),
        normalized,
      );
      mounted.add(normalized);
      created.add(normalized);
    };
    for (const systemPath of SYSTEM_READ_PATHS) await mount(systemPath, "ro");
    const host = hostSandboxPaths(input.options);
    // The workspace and every extra path lie under the company's projects/
    // directory, the agent's workspaces/ directory or a root the host names for
    // the company, and the command in the Nix store, whatever the agent's
    // configuration says.
    const ownRoots = await Promise.all(
      [
        host.projects && host.company ? path.join(host.projects, host.company) : null,
        host.workspaces && typeof input.options.agentId === "string"
          ? path.join(host.workspaces, input.options.agentId)
          : null,
        ...host.workspaceRoots,
      ]
        .filter((root): root is string => Boolean(root))
        .map((root) => fs.realpath(root).catch(() => path.resolve(root))),
    );
    const owned = async (candidate: string) => {
      const real = await fs.realpath(candidate).catch(() => null);
      return real !== null && ownRoots.some((root) => real === root || real.startsWith(`${root}/`));
    };
    const refuse = (what: string): never => {
      throw new Error(`Paperclip host refuses the confined run: ${what}.`);
    };
    if (!(await owned(workspaceDir))) refuse(`its workspace "${workspaceDir}" is none of its company's`);
    for (const extraPath of input.options.extraPaths ?? []) {
      if (!(await owned(extraPath.path))) refuse(`its extra path "${extraPath.path}" is none of its company's`);
    }
    if (!(await fs.realpath(input.executable).catch(() => "")).startsWith("/nix/store/")) {
      refuse(`its command "${input.executable}" is not in the Nix store`);
    }
    // Of two nested host paths the deeper one's access wins: bwrap applies
    // binds in order, so shallower ones go first.
    for (const hostPath of host.write) await fs.mkdir(hostPath, { recursive: true, mode: 0o700 }).catch(() => undefined);
    const bindDepth = (entry: { path: string }) => path.resolve(entry.path).split("/").length;
    const hostBinds: LocalProcessSandboxPath[] = [
      ...host.read.map((hostPath): LocalProcessSandboxPath => ({ path: hostPath, access: "ro" })),
      ...host.write.map((hostPath): LocalProcessSandboxPath => ({ path: hostPath, access: "rw" })),
    ];
    for (const entry of hostBinds.sort((a, b) => bindDepth(a) - bindDepth(b))) await mount(entry.path, entry.access);
    const mountedCovers = (candidate: string) =>
      Array.from(mounted).some((mountedPath) => candidate === mountedPath || candidate.startsWith(`${mountedPath}/`));
    // A link directly in a writable managed directory (a kept session in the
    // provider home) keeps that access; a deeper one (a skill in the prompt
    // bundle or CODEX_HOME) is read-only.
    const mountLinkTargets = async (directory: string, access: LocalProcessSandboxAccess, depth: number): Promise<void> => {
      const entries = await fs.readdir(directory, { withFileTypes: true }).catch(() => []);
      for (const entry of entries) {
        const candidate = path.join(directory, entry.name);
        if (entry.isSymbolicLink()) {
          const target = await fs.realpath(candidate).catch(() => null);
          if (target && (access === "rw" || !mountedCovers(target))) await mount(target, access);
        } else if (entry.isDirectory() && depth > 1) {
          await mountLinkTargets(candidate, "ro", depth - 1);
        }
      }
    };
    // Only the command's own Nix store paths: the host has refused any other command.
    for (const executablePath of await executableReadPaths(input.executable)) {
      if (executablePath.startsWith("/nix/store/")) await mount(executablePath, "ro");
    }
    if (networkScope === "allowlist") {
      for (const nodePath of await executableReadPaths(process.execPath)) await mount(nodePath, "ro");
    }
    for (const managedPath of input.options.managedPaths ?? []) {
      await mount(managedPath.path, managedPath.access);
      await mountLinkTargets(managedPath.path, managedPath.access, 3);
    }
    for (const extraPath of input.options.extraPaths ?? []) await mount(extraPath.path, extraPath.access);
    await mount(workspaceDir, "rw");
    for (const runPath of input.options.runPaths ?? []) await mount(runPath, "rw");
    const commonDir = await sandboxGitCommonDir(
      workspaceDir,
      ownRoots,
      (input.options.repoRoots ?? []).filter((root) => typeof root === "string" && path.isAbsolute(root)),
    );
    if (commonDir && !mountedCovers(commonDir)) await mount(commonDir, "rw");
    // The server runs git in this workspace unconfined, so the run gets
    // read-only every file git reads to decide whether a config command runs or
    // where the repository is: the `.git` link, each repository's `config`,
    // `config.worktree`, `hooks` and `info`, and a linked worktree's
    // `commondir`/`gitdir` pointers, which a run could otherwise rewrite to
    // steer the server's git at a repository it built. Together with the
    // server's GIT_CONFIG_PARAMETERS this closes the command-running config keys
    // for worktree workspaces; a plain clone's config stays the repository's own,
    // bound here.
    const dotGit = path.join(workspaceDir, ".git");
    const dotGitStat = await fs.lstat(dotGit).catch(() => null);
    const readOnlyTargets = new Set<string>();
    if (dotGitStat?.isFile()) readOnlyTargets.add(dotGit);
    for (const repository of [dotGitStat?.isDirectory() ? dotGit : null, commonDir]) {
      if (!repository) continue;
      for (const name of ["hooks", "info"]) await fs.mkdir(path.join(repository, name), { recursive: true }).catch(() => undefined);
      // git follows a main repository's own `commondir` too, and dies on an
      // empty one, so a missing one is written as `.`, which names the
      // repository itself, and bound read-only with the rest.
      await fs.writeFile(path.join(repository, "commondir"), ".\n", { flag: "wx", mode: 0o644 }).catch(() => undefined);
      for (const name of ["config", "config.worktree", "hooks", "info", "commondir"]) {
        readOnlyTargets.add(path.join(repository, name));
      }
    }
    // Only for the worktree whose common directory validated: a rejected
    // redirect's gitdir points into another workspace, which stays unbound.
    const worktreeGitDir = commonDir && dotGitStat?.isFile()
      ? await fs
          .realpath(
            path.resolve(
              workspaceDir,
              (await fs.readFile(dotGit, "utf8").catch(() => ""))?.match(/^gitdir: (.+)$/m)?.[1]?.trim() ?? "/nonexistent",
            ),
          )
          .catch(() => null)
      : null;
    if (worktreeGitDir) {
      for (const name of ["config.worktree", "commondir", "gitdir"]) readOnlyTargets.add(path.join(worktreeGitDir, name));
    }
    for (const target of readOnlyTargets) await mount(target, "ro");
    // Last, so no read-write bind above covers them: the host's read paths under
    // the run's own read-write paths, and the git metadata of every repository in
    // the workspace (Paperclip's project repositories among them) or under a
    // gitRoots directory the run sees, which the server's unconfined git reads
    // when it runs there.
    const laterWritable = [workspaceDir, ...(input.options.runPaths ?? []), commonDir]
      .filter((root): root is string => Boolean(root))
      .map((root) => path.resolve(root));
    const rebindReadOnly = async (target: string) => {
      mounted.delete(path.resolve(target));
      await mount(target, "ro");
    };
    for (const hostPath of host.read) {
      if (laterWritable.some((root) => path.resolve(hostPath).startsWith(`${root}/`))) await rebindReadOnly(hostPath);
    }
    for (const root of [workspaceDir, ...host.gitRoots]) {
      if (!mountedCovers(path.resolve(root))) continue;
      for (const target of await gitMetadataUnder(root)) await rebindReadOnly(target);
    }
    // The agents' rootless docker daemon, when the host hands it to confined
    // runs. The daemon runs as the server's user and bind-mounts any path it
    // can read, so a run with it reaches every company's files.
    const dockerSocket = process.env.PAPERCLIP_SANDBOX_DOCKER_SOCKET;
    if (dockerSocket && path.isAbsolute(dockerSocket) && (await pathExists(dockerSocket))) {
      await mount(dockerSocket, "rw");
      env.DOCKER_HOST = `unix://${dockerSocket}`;
      env.TESTCONTAINERS_DOCKER_SOCKET_OVERRIDE = dockerSocket;
    }
    for (const [index, alias] of (input.options.pathAliases ?? []).entries()) {
      const aliasPath = normalizeAbsolutePath(alias.path, `Sandbox pathAliases[${index}].path`);
      const aliasTarget = normalizeAbsolutePath(alias.target, `Sandbox pathAliases[${index}].target`);
      const relativeTarget = path.relative(workspaceDir, aliasTarget);
      if (relativeTarget.startsWith("..") || path.isAbsolute(relativeTarget)) {
        throw new Error(
          `Sandbox path alias "${aliasPath}" must target the synchronized workspace "${workspaceDir}".`,
        );
      }
      if (!(await pathExists(aliasTarget))) {
        throw new Error(`Sandbox path alias target "${aliasTarget}" does not exist.`);
      }
      addParentDirectories(args, created, aliasPath);
      args.push("--bind", aliasTarget, aliasPath);
      created.add(aliasPath);
    }

    if (networkScope === "allowlist") {
      const tempDir = await createNetworkProxyTempDir();
      const socketPath = path.join(tempDir, "proxy.sock");
      const bridgePath = path.join(tempDir, "bridge.cjs");
      await fs.writeFile(bridgePath, await createNetworkProxyBridge(), { mode: 0o500 });
      const proxy = await startNetworkAllowlistProxy(
        input.options.networkAllowlist ?? [],
        input.options.networkTrustedUrls ?? [],
        socketPath,
      ).catch(async (error) => {
        await fs.rm(tempDir, { recursive: true, force: true });
        throw error;
      });
      await mount(tempDir, "rw");
      executable = process.execPath;
      executableArgs = [bridgePath, socketPath, input.executable, ...input.args];
      cleanup = async () => {
        await proxy.close();
        await fs.rm(tempDir, { recursive: true, force: true });
      };
    }
  } else {
    args.push("--bind", "/", "/");
    if (networkScope === "allowlist") {
      const tempDir = await createNetworkProxyTempDir();
      const socketPath = path.join(tempDir, "proxy.sock");
      const bridgePath = path.join(tempDir, "bridge.cjs");
      await fs.writeFile(bridgePath, await createNetworkProxyBridge(), { mode: 0o500 });
      const proxy = await startNetworkAllowlistProxy(
        input.options.networkAllowlist ?? [],
        input.options.networkTrustedUrls ?? [],
        socketPath,
      ).catch(async (error) => {
        await fs.rm(tempDir, { recursive: true, force: true });
        throw error;
      });
      executable = process.execPath;
      executableArgs = [bridgePath, socketPath, input.executable, ...input.args];
      cleanup = async () => {
        await proxy.close();
        await fs.rm(tempDir, { recursive: true, force: true });
      };
    }
  }

  if (networkScope) {
    args.push("--unshare-net");
    for (const key of PROXY_ENV_KEYS) env[key] = undefined;
    env.NO_PROXY = "";
    env.no_proxy = "";
  }
  if (networkScope === "allowlist") {
    const proxyUrl = `http://127.0.0.1:${SANDBOX_PROXY_PORT}`;
    env.HTTP_PROXY = proxyUrl;
    env.HTTPS_PROXY = proxyUrl;
    env.http_proxy = proxyUrl;
    env.https_proxy = proxyUrl;
  }

  args.push("--chdir", cwd, "--", executable, ...executableArgs);
  return { command: bwrapCommand, args, cwd: "/", env, cleanup };
}

export function parseLocalProcessSandboxExtraPaths(value: unknown): LocalProcessSandboxPath[] {
  if (!Array.isArray(value)) return [];
  return value.map((entry, index) => {
    if (typeof entry === "string") {
      return { path: normalizeAbsolutePath(entry, `filesystemExtraPaths[${index}]`), access: "ro" };
    }
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
      throw new Error(`filesystemExtraPaths[${index}] must be an absolute path or { path, access } object.`);
    }
    const raw = entry as Record<string, unknown>;
    const access = raw.access === "rw" ? "rw" : raw.access === "ro" || raw.access == null ? "ro" : null;
    if (!access || typeof raw.path !== "string") {
      throw new Error(`filesystemExtraPaths[${index}] must use access "ro" or "rw" and an absolute path.`);
    }
    return { path: normalizeAbsolutePath(raw.path, `filesystemExtraPaths[${index}].path`), access };
  });
}
