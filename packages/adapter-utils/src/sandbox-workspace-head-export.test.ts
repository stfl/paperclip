import { execFile as execFileCallback } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";
import {
  mirrorDirectory,
  prepareSandboxManagedRuntime,
  type SandboxManagedRuntimeClient,
  type SandboxSyncOperation,
  type SandboxSyncResult,
  WORKSPACE_GIT_BUNDLE_TOO_LARGE,
} from "./sandbox-managed-runtime.js";

const execFile = promisify(execFileCallback);
const FIXED_DATE = "2026-01-01T00:00:00Z";
const EXPORT_REF = "refs/paperclip/runs/00000000-0000-4000-8000-000000000001/head";

async function git(cwd: string, args: string[]): Promise<string> {
  const { stdout } = await execFile("git", ["-C", cwd, ...args], {
    maxBuffer: 32 * 1024 * 1024,
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: "Paperclip Test",
      GIT_AUTHOR_EMAIL: "test@paperclip.dev",
      GIT_COMMITTER_NAME: "Paperclip Test",
      GIT_COMMITTER_EMAIL: "test@paperclip.dev",
      GIT_AUTHOR_DATE: FIXED_DATE,
      GIT_COMMITTER_DATE: FIXED_DATE,
    },
  });
  return stdout.trim();
}

function syncResult(operations: SandboxSyncOperation[]): SandboxSyncResult {
  return {
    operations: operations.map((operation) => ({
      operationId: operation.operationId,
      filesTransferred: operation.files.length,
      bytesTransferred: 0,
    })),
  };
}

// The host filesystem stands in for the sandbox filesystem.
function filesystemClient(native: boolean): SandboxManagedRuntimeClient {
  const client: SandboxManagedRuntimeClient = {
    makeDir: async (remotePath) => { await mkdir(remotePath, { recursive: true }); },
    writeFile: async (remotePath, bytes) => {
      await mkdir(path.dirname(remotePath), { recursive: true });
      await writeFile(remotePath, Buffer.from(bytes));
    },
    readFile: async (remotePath) => await readFile(remotePath),
    listFiles: async (remotePath) => {
      const entries = await readdir(remotePath, { withFileTypes: true }).catch(() => []);
      return entries.filter((entry) => entry.isFile()).map((entry) => entry.name).sort();
    },
    remove: async (remotePath) => { await rm(remotePath, { recursive: true, force: true }); },
    run: async (command) => { await execFile("sh", ["-c", command], { maxBuffer: 32 * 1024 * 1024 }); },
    syncIn: async (operations) => {
      for (const operation of operations) {
        for (const mapping of operation.files) {
          await mkdir(path.dirname(mapping.targetPath), { recursive: true });
          await writeFile(mapping.targetPath, await readFile(mapping.sourcePath));
        }
        for (const command of operation.postUploadCommands ?? []) {
          await execFile("sh", ["-c", command.command], { maxBuffer: 32 * 1024 * 1024 });
        }
      }
      return syncResult(operations);
    },
  };
  if (native) {
    client.syncOut = async (operations) => {
      for (const operation of operations) {
        for (const mapping of operation.files) {
          if (mapping.kind === "directory") await mirrorDirectory(mapping.sourcePath, mapping.targetPath);
          else {
            await mkdir(path.dirname(mapping.targetPath), { recursive: true });
            await writeFile(mapping.targetPath, await readFile(mapping.sourcePath));
          }
        }
      }
      return syncResult(operations);
    };
  }
  return client;
}

// A target that rewrites every bundle it produces to also carry
// `refs/tags/injected`, pointing into the exported history.
function taggingClient(remote: string): SandboxManagedRuntimeClient {
  const client = filesystemClient(true);
  const run = client.run;
  client.run = async (command, options) => {
    await run(command, options);
    const runtimeDir = path.join(remote, ".paperclip-runtime", "test");
    for (const name of await readdir(runtimeDir).catch(() => [])) {
      const bundle = path.join(runtimeDir, name);
      if (!name.endsWith(".bundle") || (await readFile(bundle)).byteLength === 0) continue;
      const [sha, ref] = (await git(remote, ["bundle", "list-heads", bundle])).split(" ");
      await git(remote, ["update-ref", ref!, sha!]);
      await git(remote, ["tag", "-f", "injected", sha!]);
      await git(remote, ["bundle", "create", `${bundle}.tagged`, ref!, "refs/tags/injected"]);
      await git(remote, ["update-ref", "-d", ref!]);
      await git(remote, ["tag", "-d", "injected"]);
      await writeFile(bundle, await readFile(`${bundle}.tagged`));
      await rm(`${bundle}.tagged`);
    }
  };
  return client;
}

describe("sandbox workspace HEAD export", () => {
  const cleanupDirs: string[] = [];
  afterEach(async () => {
    for (const dir of cleanupDirs.splice(0)) await rm(dir, { recursive: true, force: true });
  });

  async function setup(native = true, makeClient?: (remote: string) => SandboxManagedRuntimeClient) {
    const root = await mkdtemp(path.join(os.tmpdir(), "paperclip-head-export-"));
    cleanupDirs.push(root);
    const host = path.join(root, "host");
    const remote = path.join(root, "remote");
    await mkdir(host);
    await git(host, ["init", "-q", "-b", "work"]);
    await writeFile(path.join(host, "app.txt"), "base\n");
    await git(host, ["add", "."]);
    await git(host, ["commit", "-qm", "base"]);
    const base = await git(host, ["rev-parse", "HEAD"]);
    const prepared = await prepareSandboxManagedRuntime({
      spec: { transport: "sandbox", provider: "test", sandboxId: "head-export", remoteCwd: remote, timeoutMs: 30_000, apiKey: null },
      adapterKey: "test",
      client: makeClient ? makeClient(remote) : filesystemClient(native),
      workspaceLocalDir: host,
    });
    return { host, remote, base, prepared };
  }

  async function commitInRemote(remote: string, file: string, contents: string, message: string): Promise<string> {
    await writeFile(path.join(remote, file), contents);
    await git(remote, ["add", file]);
    await git(remote, ["commit", "-qm", message]);
    return git(remote, ["rev-parse", "HEAD"]);
  }

  async function hostState(host: string) {
    return {
      head: await git(host, ["rev-parse", "HEAD"]),
      branch: await git(host, ["symbolic-ref", "--short", "HEAD"]),
      status: await git(host, ["status", "--porcelain=v1", "--untracked-files=all"]),
      index: await git(host, ["ls-files", "--stage"]),
      app: await readFile(path.join(host, "app.txt"), "utf8"),
    };
  }

  it.each([true, false])("exports committed history into the ref without touching the host worktree (native sync out: %s)", async (native) => {
    const { host, remote, prepared } = await setup(native);
    await commitInRemote(remote, "app.txt", "first\n", "first");
    const second = await commitInRemote(remote, "feature.txt", "feature\n", "second");
    await writeFile(path.join(remote, "app.txt"), "uncommitted\n");
    await writeFile(path.join(host, "host-edit.txt"), "host work in progress\n");
    const before = await hostState(host);

    const exported = await prepared.exportWorkspaceGitHead({ localRef: EXPORT_REF });

    expect(exported).toEqual({ commitSha: second, branch: "work" });
    expect(await git(host, ["rev-parse", EXPORT_REF])).toBe(second);
    expect(await git(host, ["log", "--format=%s", EXPORT_REF])).toBe("second\nfirst\nbase");
    expect(await git(host, ["show", `${EXPORT_REF}:app.txt`])).toBe("first");
    expect(await hostState(host)).toEqual(before);
    expect(await git(remote, ["for-each-ref", "--format=%(refname)", "refs/paperclip/"])).toBe("");
    expect(await readdir(path.join(remote, ".paperclip-runtime", "test")).catch(() => [])).toEqual([]);
  });

  it("points the ref at the unchanged base when the target has no new commits", async () => {
    const { host, base, prepared } = await setup();
    expect(await prepared.exportWorkspaceGitHead({ localRef: EXPORT_REF })).toEqual({ commitSha: base, branch: "work" });
    expect(await git(host, ["rev-parse", EXPORT_REF])).toBe(base);
  });

  it("moves the ref to the later HEAD on a repeated export and reports a detached HEAD", async () => {
    const { host, remote, prepared } = await setup();
    await commitInRemote(remote, "app.txt", "first\n", "first");
    await prepared.exportWorkspaceGitHead({ localRef: EXPORT_REF });
    const second = await commitInRemote(remote, "app.txt", "second\n", "second");
    await git(remote, ["checkout", "-q", "--detach"]);
    expect(await prepared.exportWorkspaceGitHead({ localRef: EXPORT_REF })).toEqual({ commitSha: second, branch: null });
    expect(await git(host, ["rev-parse", EXPORT_REF])).toBe(second);
  });

  it("leaves the final restore's result identical to a run without an export", async () => {
    const restored = [];
    for (const exportFirst of [false, true]) {
      const { host, remote, prepared } = await setup();
      await commitInRemote(remote, "app.txt", "first\n", "first");
      if (exportFirst) await prepared.exportWorkspaceGitHead({ localRef: EXPORT_REF });
      await commitInRemote(remote, "app.txt", "second\n", "second");
      await writeFile(path.join(remote, "notes.txt"), "uncommitted output\n");
      await prepared.restoreWorkspace();
      restored.push({
        log: await git(host, ["log", "--format=%H %s"]),
        branch: await git(host, ["symbolic-ref", "--short", "HEAD"]),
        status: await git(host, ["status", "--porcelain=v1", "--untracked-files=all"]),
        app: await readFile(path.join(host, "app.txt"), "utf8"),
        notes: await readFile(path.join(host, "notes.txt"), "utf8"),
      });
    }
    expect(restored[1]).toEqual(restored[0]);
    expect(restored[0]!.log.split("\n").map((line) => line.split(" ")[1])).toEqual(["second", "first", "base"]);
  });

  it("imports no tag and writes no FETCH_HEAD from a bundle the target added a tag to, at export and final restore", async () => {
    const { host, remote, prepared } = await setup(true, taggingClient);
    const gitDir = await git(host, ["rev-parse", "--absolute-git-dir"]);
    await commitInRemote(remote, "app.txt", "first\n", "first");

    await prepared.exportWorkspaceGitHead({ localRef: EXPORT_REF });
    expect(await git(host, ["tag", "--list"])).toBe("");
    await expect(stat(path.join(gitDir, "FETCH_HEAD"))).rejects.toMatchObject({ code: "ENOENT" });

    const head = await commitInRemote(remote, "app.txt", "second\n", "second");
    await prepared.restoreWorkspace();
    expect(await git(host, ["rev-parse", "HEAD"])).toBe(head);
    expect(await git(host, ["tag", "--list"])).toBe("");
    await expect(stat(path.join(gitDir, "FETCH_HEAD"))).rejects.toMatchObject({ code: "ENOENT" });
  });

  it.each([true, false])("refuses a bundle over the size limit and keeps the previous ref (native sync out: %s)", async (native) => {
    const { host, remote, prepared } = await setup(native);
    const first = await commitInRemote(remote, "app.txt", "first\n", "first");
    await prepared.exportWorkspaceGitHead({ localRef: EXPORT_REF });
    await commitInRemote(remote, "big.txt", randomBytes(64 * 1024).toString("hex"), "big");

    await expect(prepared.exportWorkspaceGitHead({ localRef: EXPORT_REF, maxBundleBytes: 32 * 1024 }))
      .rejects.toThrow(WORKSPACE_GIT_BUNDLE_TOO_LARGE);
    expect(await git(host, ["rev-parse", EXPORT_REF])).toBe(first);
  });

  it("keeps the previous ref when the bundle names another commit than the target reported", async () => {
    let tamper = false;
    const { host, remote, base, prepared } = await setup(true, () => {
      const client = filesystemClient(true);
      const readRemote = client.readFile;
      client.readFile = async (remotePath, options) => {
        const bytes = await readRemote(remotePath, options);
        if (!tamper || !remotePath.endsWith(".txt")) return bytes;
        const [, ...rest] = Buffer.from(bytes as Buffer).toString("utf8").split("\n");
        return Buffer.from([base, ...rest].join("\n"));
      };
      return client;
    });
    const first = await commitInRemote(remote, "app.txt", "first\n", "first");
    await prepared.exportWorkspaceGitHead({ localRef: EXPORT_REF });
    await commitInRemote(remote, "app.txt", "second\n", "second");
    tamper = true;

    await expect(prepared.exportWorkspaceGitHead({ localRef: EXPORT_REF })).rejects.toThrow("workspace_git_head_import_mismatch");
    expect(await git(host, ["rev-parse", EXPORT_REF])).toBe(first);
    expect(await git(host, ["for-each-ref", "--format=%(refname)", "refs/paperclip/git-sync/"])).toBe("");
  });

  it("exports from a shallow sandbox clone, including a rewritten boundary commit", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "paperclip-head-export-shallow-"));
    cleanupDirs.push(root);
    const host = path.join(root, "host");
    const remote = path.join(root, "remote");
    await mkdir(host);
    await git(host, ["init", "-q", "-b", "work"]);
    for (const step of ["one", "two", "base"]) {
      await writeFile(path.join(host, "app.txt"), `${step}\n`);
      await git(host, ["add", "."]);
      await git(host, ["commit", "-qm", step]);
    }
    const base = await git(host, ["rev-parse", "HEAD"]);
    const prepared = await prepareSandboxManagedRuntime({
      spec: { transport: "sandbox", provider: "test", sandboxId: "head-export-shallow", remoteCwd: remote, timeoutMs: 30_000, apiKey: null },
      adapterKey: "test",
      client: filesystemClient(true),
      workspaceLocalDir: host,
    });
    expect(await readFile(path.join(remote, ".git", "shallow"), "utf8")).toContain(base);

    const first = await commitInRemote(remote, "app.txt", "first\n", "first");
    expect(await prepared.exportWorkspaceGitHead({ localRef: EXPORT_REF })).toEqual({ commitSha: first, branch: "work" });
    expect(await git(host, ["log", "--format=%s", EXPORT_REF])).toBe("first\nbase\ntwo\none");

    await git(remote, ["reset", "-q", "--soft", base]);
    await git(remote, ["commit", "-q", "--amend", "-m", "rewritten base"]);
    const rewritten = await git(remote, ["rev-parse", "HEAD"]);
    expect(await prepared.exportWorkspaceGitHead({ localRef: EXPORT_REF })).toEqual({ commitSha: rewritten, branch: "work" });
    expect(await git(host, ["rev-parse", EXPORT_REF])).toBe(rewritten);
    expect(await git(host, ["rev-parse", "HEAD"])).toBe(base);
  });

  it("refuses a workspace without git", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "paperclip-head-export-plain-"));
    cleanupDirs.push(root);
    const host = path.join(root, "host");
    await mkdir(host);
    await writeFile(path.join(host, "file.txt"), "plain\n");
    const prepared = await prepareSandboxManagedRuntime({
      spec: { transport: "sandbox", provider: "test", sandboxId: "plain", remoteCwd: path.join(root, "remote"), timeoutMs: 30_000, apiKey: null },
      adapterKey: "test",
      client: filesystemClient(true),
      workspaceLocalDir: host,
    });
    await expect(prepared.exportWorkspaceGitHead({ localRef: EXPORT_REF })).rejects.toThrow("workspace_git_unavailable");
  });
});
