import { and, eq, isNull } from "drizzle-orm";
import { heartbeatRuns, type Db } from "@paperclipai/db";
import { pendingCaseHandoffForRun } from "./case-handoff-lifecycle.js";

type LocalProcessIdentity = {
  processPid: number | null;
  processGroupId: number | null;
  processStartedAt: Date | null;
};

/** The HTTP adapter awaits a remote response and never creates a host process. */
export function legacyAdapterNeedsLocalProcessSettlement(input: {
  adapterType: string;
  executionTargetKind?: "local" | "remote";
}): boolean {
  return input.adapterType !== "http" && input.executionTargetKind !== "remote";
}

/**
 * The adapter's main process closing does not prove its descendants stopped.
 * This is absence evidence only: persisted identifiers never authorize signals.
 * Call only for a known local target and its host-recorded process generation.
 */
export function hasStoppedLocalProcessTree(
  identity: LocalProcessIdentity,
  probe: (pid: number) => unknown = pid => process.kill(pid, 0),
): boolean {
  if (process.platform === "win32" ||
      !Number.isSafeInteger(identity.processPid) || (identity.processPid ?? 0) <= 1 ||
      !Number.isSafeInteger(identity.processGroupId) || (identity.processGroupId ?? 0) <= 1 ||
      !identity.processStartedAt || !Number.isFinite(identity.processStartedAt.getTime())) return false;
  const absent = (pid: number) => {
    try { probe(pid); return false; }
    catch (error) { return (error as NodeJS.ErrnoException | null)?.code === "ESRCH"; }
  };
  return absent(identity.processPid!) && absent(-identity.processGroupId!);
}

type RecordedProcessIdentity = Pick<typeof heartbeatRuns.$inferSelect,
  "id" | "companyId" | "status" | "runtimeMode" | "processPid" | "processGroupId" | "processStartedAt">;

/**
 * The OS hands a finished process's identifiers to unrelated processes, so a
 * run gives them up once its process tree is proven gone. The caller owns that
 * proof; the write applies only to the identity the caller read.
 *
 * Only a succeeded legacy run gives them up. After a failure, timeout,
 * interruption or Stop, continuation and pause checks read a missing identity
 * as "no verified stop". A native run retires its identity together with a
 * stop record. A pending case handoff binds its cleanup receipt to them.
 */
export async function retireStoppedProcessIdentity(db: Db, run: RecordedProcessIdentity): Promise<boolean> {
  if (run.runtimeMode !== "legacy" || run.status !== "succeeded" ||
      (run.processPid === null && run.processGroupId === null && run.processStartedAt === null)) return false;
  if (await pendingCaseHandoffForRun(db, run.id, run.companyId)) return false;
  const retired = await db.update(heartbeatRuns)
    .set({ processPid: null, processGroupId: null, processStartedAt: null })
    .where(and(eq(heartbeatRuns.id, run.id), eq(heartbeatRuns.status, "succeeded"), eq(heartbeatRuns.runtimeMode, "legacy"),
      run.processPid === null ? isNull(heartbeatRuns.processPid) : eq(heartbeatRuns.processPid, run.processPid),
      run.processGroupId === null ? isNull(heartbeatRuns.processGroupId) : eq(heartbeatRuns.processGroupId, run.processGroupId),
      run.processStartedAt === null ? isNull(heartbeatRuns.processStartedAt) : eq(heartbeatRuns.processStartedAt, run.processStartedAt)))
    .returning({ id: heartbeatRuns.id });
  return retired.length > 0;
}
