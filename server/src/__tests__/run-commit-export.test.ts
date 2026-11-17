import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { heartbeatRuns, type Db } from "@paperclipai/db";
import type { EnvironmentLease } from "@paperclipai/shared";
import type { AdapterSandboxExecutionTarget } from "@paperclipai/adapter-utils/execution-target";
import type { CommandManagedRuntimeRunner } from "@paperclipai/adapter-utils/command-managed-runtime";
import * as gitWorkspaceSync from "@paperclipai/adapter-utils/git-workspace-sync";
import { runLocalGit } from "@paperclipai/adapter-utils/git-workspace-sync";
import {
  cleanupNativeWorkspaceSync,
  prepareNativeWorkspaceSync,
} from "../services/native-runtime/native-workspace-sync.js";
import {
  exportRunCommits,
  registerRunCommitExport,
  runCommitExportRef,
  runCommitExporterFor,
} from "../services/heartbeat/run-commit-export.js";

const runner: CommandManagedRuntimeRunner = {
  execute: (input) => new Promise((resolve, reject) => {
    const child = execFile(input.command, input.args ?? [], {
      cwd: input.cwd, env: { ...process.env, ...input.env },
      timeout: input.timeoutMs, maxBuffer: 16 * 1024 * 1024,
    }, (error, stdout, stderr) => resolve({
      exitCode: error ? (typeof error.code === "number" ? error.code : 1) : 0,
      signal: error?.signal ?? null, timedOut: error?.killed ?? false, stdout, stderr,
    }));
    child.stdin?.on("error", (error: NodeJS.ErrnoException) => {
      if (error.code !== "EPIPE") reject(error);
    });
    child.stdin?.end(input.stdin ?? "");
  }),
};

async function git(cwd: string, ...args: string[]) {
  return (await runLocalGit(cwd, ["-c", "user.name=Test", "-c", "user.email=test@paperclip.dev", ...args])).stdout.trim();
}

async function refExists(cwd: string, ref: string) {
  return runLocalGit(cwd, ["rev-parse", "--verify", "--quiet", ref]).then(() => true, () => false);
}

describe("run commit export", () => {
  const oldHome = process.env.PAPERCLIP_HOME;
  const oldInstance = process.env.PAPERCLIP_INSTANCE_ID;
  const roots: string[] = [];
  const releases: Array<() => Promise<void>> = [];
  afterEach(async () => {
    vi.restoreAllMocks();
    for (const release of releases.splice(0)) await release();
    if (oldHome === undefined) delete process.env.PAPERCLIP_HOME;
    else process.env.PAPERCLIP_HOME = oldHome;
    if (oldInstance === undefined) delete process.env.PAPERCLIP_INSTANCE_ID;
    else process.env.PAPERCLIP_INSTANCE_ID = oldInstance;
    await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })));
  });

  async function hostRepository() {
    const root = await mkdtemp(path.join(os.tmpdir(), "paperclip-run-commit-export-"));
    roots.push(root);
    process.env.PAPERCLIP_HOME = path.join(root, "home");
    process.env.PAPERCLIP_INSTANCE_ID = "test";
    const host = path.join(root, "host");
    await mkdir(host, { recursive: true });
    await git(host, "init", "-b", "work");
    await writeFile(path.join(host, "file.txt"), "base\n");
    await git(host, "add", ".");
    await git(host, "commit", "-m", "base");
    return { root, host };
  }

  async function sandboxRun(root: string, host: string, options: { commitExportCloseTimeoutMs?: number } = {}) {
    const runId = randomUUID();
    const remote = path.join(root, `remote-${runId}`);
    const lease = { id: "lease", providerLeaseId: "sandbox", metadata: {} } as EnvironmentLease;
    let runnerProfileJson: Record<string, unknown> = {};
    const db = {
      select: () => {
        const query = {
          from: () => query, where: () => query, for: () => query,
          limit: async () => [{ runnerProfileJson, metadata: lease.metadata }],
        };
        return query;
      },
      update: (table: unknown) => ({
        set: (value: { runnerProfileJson?: Record<string, unknown>; metadata?: Record<string, unknown> }) => ({
          where: async () => {
            if (table === heartbeatRuns) runnerProfileJson = value.runnerProfileJson!;
            else lease.metadata = value.metadata!;
          },
        }),
      }),
      transaction: async (fn: (tx: unknown) => Promise<unknown>) => fn(db),
    };
    const target: AdapterSandboxExecutionTarget = {
      kind: "remote", transport: "sandbox", providerKey: "test", leaseId: lease.id,
      remoteCwd: remote, runner, timeoutMs: 30_000,
      sandboxLeaseAcquisition: { outcome: "created", providerLeaseId: "sandbox" },
    };
    const sync = (await prepareNativeWorkspaceSync({
      db: db as unknown as Db, runId, companyId: "company", workspaceId: "workspace",
      workspaceLocalDir: host, lease, target, ...options,
    }))!;
    const release = registerRunCommitExport(runId, runCommitExporterFor({
      runId, executionTarget: target, nativeWorkspaceSync: sync, hostWorkspaceDir: host,
    }));
    releases.push(release);
    return { runId, remote, sync, release, ref: runCommitExportRef(runId) };
  }

  async function hostState(host: string) {
    return {
      head: await git(host, "rev-parse", "HEAD"),
      branch: await git(host, "symbolic-ref", "--short", "HEAD"),
      status: await git(host, "status", "--porcelain=v1", "--untracked-files=all"),
      index: await git(host, "ls-files", "--stage"),
      file: await readFile(path.join(host, "file.txt"), "utf8"),
    };
  }

  it("exports a live sandboxed run's commits under the run's ref and leaves the host worktree alone", async () => {
    const { root, host } = await hostRepository();
    const { runId, remote, ref } = await sandboxRun(root, host);
    await writeFile(path.join(remote, "file.txt"), "sandbox\n");
    await git(remote, "commit", "-am", "sandbox change");
    const sandboxHead = await git(remote, "rev-parse", "HEAD");
    await writeFile(path.join(remote, "draft.txt"), "uncommitted\n");
    await writeFile(path.join(host, "host-draft.txt"), "host work\n");
    const before = await hostState(host);

    expect(await exportRunCommits(runId)).toEqual({ commitSha: sandboxHead, branch: "work", ref });

    expect(await git(host, "rev-parse", ref)).toBe(sandboxHead);
    expect(await git(host, "ls-tree", "--name-only", ref)).toBe("file.txt");
    expect(await hostState(host)).toEqual(before);
  }, 30_000);

  it("serializes concurrent exports and ends the ref at the later HEAD", async () => {
    const { root, host } = await hostRepository();
    const { runId, remote, ref } = await sandboxRun(root, host);
    let inFlight = 0;
    let maxInFlight = 0;
    const fetchBundle = gitWorkspaceSync.fetchGitBundleIntoLocalRef;
    vi.spyOn(gitWorkspaceSync, "fetchGitBundleIntoLocalRef").mockImplementation(async (input) => {
      maxInFlight = Math.max(maxInFlight, ++inFlight);
      try { return await fetchBundle(input); } finally { inFlight -= 1; }
    });
    await git(remote, "commit", "--allow-empty", "-m", "first");
    const first = exportRunCommits(runId);
    await git(remote, "commit", "--allow-empty", "-m", "second");
    const later = await git(remote, "rev-parse", "HEAD");
    const second = exportRunCommits(runId);

    const results = await Promise.all([first, second]);

    expect(results[1].commitSha).toBe(later);
    expect(await git(host, "rev-parse", ref)).toBe(later);
    expect(maxInFlight).toBe(1);
  }, 30_000);

  it("integrates the same commits at the final restore and deletes the ref once it succeeds", async () => {
    const { root, host } = await hostRepository();
    const { runId, remote, sync, ref } = await sandboxRun(root, host);
    await writeFile(path.join(remote, "file.txt"), "first\n");
    await git(remote, "commit", "-am", "first");
    await exportRunCommits(runId);
    await writeFile(path.join(remote, "file.txt"), "second\n");
    await git(remote, "commit", "-am", "second");
    const sandboxHead = await git(remote, "rev-parse", "HEAD");

    await sync.restoreWorkspace();

    expect(await git(host, "rev-parse", "HEAD")).toBe(sandboxHead);
    expect(await git(host, "symbolic-ref", "--short", "HEAD")).toBe("work");
    expect(await readFile(path.join(host, "file.txt"), "utf8")).toBe("second\n");
    expect(await refExists(host, ref)).toBe(false);

    await expect(exportRunCommits(runId)).rejects.toMatchObject({ code: "workspace_not_exportable" });
    expect(await refExists(host, ref)).toBe(false);
  }, 30_000);

  it.each(["restore", "cleanup"] as const)("leaves no ref when an export is in flight during %s", async (step) => {
    const { root, host } = await hostRepository();
    const { runId, remote, sync, ref } = await sandboxRun(root, host);
    await git(remote, "commit", "--allow-empty", "-m", "sandbox commit");

    const exported = exportRunCommits(runId);
    await (step === "restore" ? sync.restoreWorkspace() : sync.cleanup());

    await expect(exported).resolves.toMatchObject({ ref });
    expect(await refExists(host, ref)).toBe(false);
    await expect(exportRunCommits(runId)).rejects.toMatchObject({ code: "workspace_not_exportable" });
  }, 30_000);

  it("finalizes past a hung export and deletes its ref once it settles", async () => {
    const { root, host } = await hostRepository();
    const { runId, remote, sync, ref } = await sandboxRun(root, host, { commitExportCloseTimeoutMs: 50 });
    let releaseExport!: () => void;
    const exportHeld = new Promise<void>((resolve) => { releaseExport = resolve; });
    const fetchBundle = gitWorkspaceSync.fetchGitBundleIntoLocalRef;
    vi.spyOn(gitWorkspaceSync, "fetchGitBundleIntoLocalRef").mockImplementation(async (input) => {
      if (input.importedRef.includes("sandbox-head")) await exportHeld;
      return fetchBundle(input);
    });
    await git(remote, "commit", "--allow-empty", "-m", "sandbox commit");
    const sandboxHead = await git(remote, "rev-parse", "HEAD");

    const exported = exportRunCommits(runId);
    await sync.restoreWorkspace();
    expect(await git(host, "rev-parse", "HEAD")).toBe(sandboxHead);

    releaseExport();
    await exported;
    await vi.waitFor(async () => expect(await refExists(host, ref)).toBe(false));
  }, 30_000);

  it("keeps the previous ref when an export fails and moves it on the next good one", async () => {
    const { root, host } = await hostRepository();
    const { runId, remote, ref } = await sandboxRun(root, host);
    await git(remote, "commit", "--allow-empty", "-m", "first");
    const first = await git(remote, "rev-parse", "HEAD");
    await exportRunCommits(runId);
    await git(remote, "commit", "--allow-empty", "-m", "second");
    const second = await git(remote, "rev-parse", "HEAD");
    vi.spyOn(gitWorkspaceSync, "fetchGitBundleIntoLocalRef").mockRejectedValueOnce(new Error("fatal: corrupt bundle"));

    await expect(exportRunCommits(runId)).rejects.toMatchObject({ code: "export_failed", message: "fatal: corrupt bundle" });
    expect(await git(host, "rev-parse", ref)).toBe(first);

    expect(await exportRunCommits(runId)).toMatchObject({ commitSha: second });
    expect(await git(host, "rev-parse", ref)).toBe(second);
  }, 30_000);

  it("deletes the ref with the run's sync state when no restore succeeded", async () => {
    const { root, host } = await hostRepository();
    const { runId, remote, ref } = await sandboxRun(root, host);
    await git(remote, "commit", "--allow-empty", "-m", "sandbox only");
    await exportRunCommits(runId);
    expect(await refExists(host, ref)).toBe(true);

    await cleanupNativeWorkspaceSync(runId);

    expect(await refExists(host, ref)).toBe(false);
  }, 30_000);

  it("keeps a leftover ref from breaking the next run's sync in and final restore", async () => {
    const { root, host } = await hostRepository();
    const abandoned = await sandboxRun(root, host);
    await git(abandoned.remote, "commit", "--allow-empty", "-m", "abandoned");
    await exportRunCommits(abandoned.runId);

    const next = await sandboxRun(root, host);
    expect(await git(next.remote, "rev-parse", "HEAD")).toBe(await git(host, "rev-parse", "HEAD"));
    await writeFile(path.join(next.remote, "file.txt"), "next run\n");
    await git(next.remote, "commit", "-am", "next run");
    const nextHead = await git(next.remote, "rev-parse", "HEAD");
    await next.sync.restoreWorkspace();

    expect(await git(host, "rev-parse", "HEAD")).toBe(nextHead);
    expect(await refExists(host, abandoned.ref)).toBe(true);
  }, 30_000);

  it("exports the host worktree's HEAD for a run without sandbox sync and deletes the ref on release", async () => {
    const { host } = await hostRepository();
    await git(host, "commit", "--allow-empty", "-m", "host commit");
    const head = await git(host, "rev-parse", "HEAD");
    const runId = randomUUID();
    const release = registerRunCommitExport(runId, runCommitExporterFor({
      runId, executionTarget: null, nativeWorkspaceSync: null, hostWorkspaceDir: host,
    }));
    const ref = runCommitExportRef(runId);

    expect(await exportRunCommits(runId)).toEqual({ commitSha: head, branch: "work", ref });
    expect(await git(host, "rev-parse", ref)).toBe(head);

    await release();
    expect(await refExists(host, ref)).toBe(false);
    await expect(exportRunCommits(runId)).rejects.toMatchObject({ code: "workspace_not_exportable" });
  });

  it("removes a host-worktree ref a crashed process left behind when the next host exporter starts", async () => {
    const { host } = await hostRepository();
    const crashedRun = randomUUID();
    // What a crashed process leaves: the ref and its marker, with no live exporter.
    await git(host, "update-ref", runCommitExportRef(crashedRun), "HEAD");
    const markers = path.join(process.env.PAPERCLIP_HOME!, "instances", "test", "run-commit-exports");
    await mkdir(markers, { recursive: true });
    await writeFile(path.join(markers, `${crashedRun}.json`), JSON.stringify({ localDir: host, ref: runCommitExportRef(crashedRun) }));

    const nextRun = randomUUID();
    releases.push(registerRunCommitExport(nextRun, runCommitExporterFor({
      runId: nextRun, executionTarget: null, nativeWorkspaceSync: null, hostWorkspaceDir: host,
    })));
    await exportRunCommits(nextRun);

    expect(await refExists(host, runCommitExportRef(crashedRun))).toBe(false);
    await expect(stat(path.join(markers, `${crashedRun}.json`))).rejects.toMatchObject({ code: "ENOENT" });
    expect(await refExists(host, runCommitExportRef(nextRun))).toBe(true);
  });

  it("refuses with a reason code", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "paperclip-run-commit-export-plain-"));
    roots.push(root);
    const plainRun = randomUUID();
    releases.push(registerRunCommitExport(plainRun, runCommitExporterFor({
      runId: plainRun, executionTarget: { kind: "local" }, nativeWorkspaceSync: null, hostWorkspaceDir: root,
    })));
    await expect(exportRunCommits(plainRun)).rejects.toMatchObject({ code: "no_git_workspace" });

    const failingRun = randomUUID();
    releases.push(registerRunCommitExport(failingRun, {
      exportCommits: async () => { throw new Error("sandbox unreachable"); },
      release: async () => {},
    }));
    await expect(exportRunCommits(failingRun)).rejects.toMatchObject({ code: "export_failed", message: "sandbox unreachable" });

    expect(runCommitExporterFor({
      runId: randomUUID(), executionTarget: { kind: "remote", transport: "ssh" } as never, nativeWorkspaceSync: null, hostWorkspaceDir: root,
    })).toBeNull();
    await expect(exportRunCommits(randomUUID())).rejects.toMatchObject({ code: "workspace_not_exportable" });
    await expect(stat(path.join(root, ".git"))).rejects.toMatchObject({ code: "ENOENT" });
  });
});
