import fs from "node:fs/promises";
import path from "node:path";
import { deleteLocalGitRef, exportLocalGitHead } from "@paperclipai/adapter-utils/git-workspace-sync";
import {
  WORKSPACE_GIT_BUNDLE_TOO_LARGE,
  type WorkspaceGitHeadExport,
} from "@paperclipai/adapter-utils/sandbox-managed-runtime";
import type { AdapterExecutionTarget } from "@paperclipai/adapter-utils/execution-target";
import { resolvePaperclipInstanceRoot } from "../../home-paths.js";
import { COMMIT_EXPORT_CLOSED, type PreparedNativeWorkspaceSync } from "../native-runtime/native-workspace-sync.js";

export interface RunCommitExporter {
  exportCommits(localRef: string): Promise<WorkspaceGitHeadExport>;
  /** Settles in-flight exports and refuses later ones. */
  release(): Promise<void>;
}

export type RunCommitExportFailureCode =
  | "workspace_not_exportable"
  | "no_git_workspace"
  | "bundle_too_large"
  | "export_failed";

export class RunCommitExportError extends Error {
  constructor(readonly code: RunCommitExportFailureCode, message: string) {
    super(message);
  }
}

export interface RunCommitExportResult extends WorkspaceGitHeadExport {
  ref: string;
}

const RUN_ID_RE = /^[0-9a-f-]{36}$/i;
const REF_PREFIX = "refs/paperclip/runs/";

// Process-local: the runtime that reaches a run's target lives in the process
// executing that run, and so does the route that serves it.
const liveExporters = new Map<string, RunCommitExporter>();

export function runCommitExportRef(runId: string): string {
  return `${REF_PREFIX}${runId}/head`;
}

// Markers of host-worktree exports. A native sync keeps its own beside its
// descriptor, which its cleanup and the finalization reconciler remove.
function hostMarkerDirectory(): string {
  return path.join(resolvePaperclipInstanceRoot(), "run-commit-exports");
}

function hostMarkerPath(runId: string): string {
  if (!RUN_ID_RE.test(runId)) throw new Error("run_commit_export_invalid_run_id");
  return path.join(hostMarkerDirectory(), `${runId}.json`);
}

async function deleteHostExport(runId: string): Promise<void> {
  const markerPath = hostMarkerPath(runId);
  const marker = await fs.readFile(markerPath, "utf8").then((text) => JSON.parse(text) as Record<string, unknown>, () => null);
  if (marker && typeof marker.localDir === "string" && typeof marker.ref === "string" && marker.ref.startsWith(REF_PREFIX)) {
    await deleteLocalGitRef({ localDir: marker.localDir, ref: marker.ref });
  }
  await fs.rm(markerPath, { force: true });
}

/** Removes the refs of host-worktree exports whose run no longer executes here, as after a crash. */
function sweepLeftoverHostExports(): Promise<void> {
  return fs.readdir(hostMarkerDirectory()).then(
    async (names) => {
      for (const name of names) {
        const runId = name.replace(/\.json$/, "");
        if (name.endsWith(".json") && RUN_ID_RE.test(runId) && !liveExporters.has(runId)) {
          await deleteHostExport(runId).catch(() => undefined);
        }
      }
    },
    () => undefined,
  );
}

function hostWorkspaceExporter(runId: string, localDir: string): RunCommitExporter {
  let queue: Promise<unknown> = sweepLeftoverHostExports();
  return {
    exportCommits(localRef) {
      const exported = queue.then(async () => {
        await fs.mkdir(hostMarkerDirectory(), { recursive: true, mode: 0o700 });
        await fs.writeFile(hostMarkerPath(runId), JSON.stringify({ localDir, ref: localRef }), { mode: 0o600 });
        return exportLocalGitHead({ localDir, localRef });
      });
      queue = exported.catch(() => undefined);
      return exported;
    },
    async release() {
      await queue;
      await deleteHostExport(runId);
    },
  };
}

/**
 * The exporter for a run, or `null` when its workspace lives on a target this
 * process cannot reach.
 */
export function runCommitExporterFor(input: {
  runId: string;
  executionTarget: AdapterExecutionTarget | null | undefined;
  nativeWorkspaceSync: PreparedNativeWorkspaceSync | null | undefined;
  hostWorkspaceDir: string | null | undefined;
}): RunCommitExporter | null {
  if (input.nativeWorkspaceSync) {
    const sync = input.nativeWorkspaceSync;
    return { exportCommits: (localRef) => sync.exportCommits(localRef), release: () => sync.releaseCommitExport() };
  }
  if ((!input.executionTarget || input.executionTarget.kind === "local") && input.hostWorkspaceDir) {
    return hostWorkspaceExporter(input.runId, input.hostWorkspaceDir);
  }
  return null;
}

/** Returns the release to run once the run's execution ends. */
export function registerRunCommitExport(runId: string, exporter: RunCommitExporter | null): () => Promise<void> {
  if (!exporter) return async () => {};
  liveExporters.set(runId, exporter);
  return async () => {
    if (liveExporters.get(runId) === exporter) liveExporters.delete(runId);
    await exporter.release();
  };
}

export async function exportRunCommits(runId: string): Promise<RunCommitExportResult> {
  const exporter = liveExporters.get(runId);
  if (!exporter) {
    throw new RunCommitExportError("workspace_not_exportable", "The run's workspace is not reachable for export");
  }
  const ref = runCommitExportRef(runId);
  try {
    return { ...(await exporter.exportCommits(ref)), ref };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (message === "workspace_git_unavailable") {
      throw new RunCommitExportError("no_git_workspace", "The run has no git execution workspace");
    }
    if (message === COMMIT_EXPORT_CLOSED) {
      throw new RunCommitExportError("workspace_not_exportable", "The run's workspace is being finalized");
    }
    if (message === WORKSPACE_GIT_BUNDLE_TOO_LARGE) {
      throw new RunCommitExportError("bundle_too_large", "The run's commits exceed the export size limit");
    }
    throw new RunCommitExportError("export_failed", message);
  }
}
