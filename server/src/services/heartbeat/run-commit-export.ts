import { deleteLocalGitRef, exportLocalGitHead } from "@paperclipai/adapter-utils/git-workspace-sync";
import type { WorkspaceGitHeadExport } from "@paperclipai/adapter-utils/sandbox-managed-runtime";
import type { AdapterExecutionTarget } from "@paperclipai/adapter-utils/execution-target";
import type { PreparedNativeWorkspaceSync } from "../native-runtime/native-workspace-sync.js";

export interface RunCommitExporter {
  exportCommits(localRef: string): Promise<WorkspaceGitHeadExport>;
  /** Settles in-flight exports and removes whatever ref the exporter still owns. */
  release(): Promise<void>;
}

export type RunCommitExportFailureCode =
  | "workspace_not_exportable"
  | "no_git_workspace"
  | "export_failed";

export class RunCommitExportError extends Error {
  constructor(readonly code: RunCommitExportFailureCode, message: string) {
    super(message);
  }
}

export interface RunCommitExportResult extends WorkspaceGitHeadExport {
  ref: string;
}

// Process-local: the runtime that reaches a run's target lives in the process
// executing that run, and so does the route that serves it.
const liveExporters = new Map<string, RunCommitExporter>();

export function runCommitExportRef(runId: string): string {
  return `refs/paperclip/runs/${runId}/head`;
}

function hostWorkspaceExporter(localDir: string): RunCommitExporter {
  let queue: Promise<unknown> = Promise.resolve();
  let exportedRef: string | null = null;
  return {
    exportCommits(localRef) {
      const exported = queue.then(() => {
        exportedRef = localRef;
        return exportLocalGitHead({ localDir, localRef });
      });
      queue = exported.catch(() => undefined);
      return exported;
    },
    async release() {
      await queue;
      if (exportedRef) await deleteLocalGitRef({ localDir, ref: exportedRef });
      exportedRef = null;
    },
  };
}

/**
 * The exporter for a run, or `null` when its workspace lives on a target this
 * process cannot reach.
 */
export function runCommitExporterFor(input: {
  executionTarget: AdapterExecutionTarget | null | undefined;
  nativeWorkspaceSync: PreparedNativeWorkspaceSync | null | undefined;
  hostWorkspaceDir: string | null | undefined;
}): RunCommitExporter | null {
  if (input.nativeWorkspaceSync) {
    const sync = input.nativeWorkspaceSync;
    return { exportCommits: (localRef) => sync.exportCommits(localRef), release: () => sync.releaseCommitExport() };
  }
  if ((!input.executionTarget || input.executionTarget.kind === "local") && input.hostWorkspaceDir) {
    return hostWorkspaceExporter(input.hostWorkspaceDir);
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
    throw new RunCommitExportError("export_failed", message);
  }
}
