import { readProcessStartedAt } from "./hot-restart.js";
import { runUsedConversationAdapter } from "./conversation-continuation.js";
import { and, asc, eq, inArray, isNull, or, sql } from "drizzle-orm";
import { environmentLeases, heartbeatRuns, nativeRunFinalizations, type Db } from "@paperclipai/db";
import { hasNativeLocalProcessStop } from "./native-local-process-stop.js";
import { hasRemoteTerminationReceipt } from "./remote-execution-termination.js";
import { isCancelledNativeStartup } from "./cancelled-native-startup.js";
import { recordedGroupStartedAt, recordedProcessIsGone } from "./recorded-process-probe.js";
import { retireStoppedProcessIdentity } from "./heartbeat/run-lifecycle.js";
import { logger } from "../middleware/logger.js";

/** Each key names one check that an agent's executions have stopped. It is a
 * stable key: operators read it in the log and on the waiting agent. */
export const AGENT_EXECUTION_STOP_HOLD_CLAUSES = [
  "run_active", "controller_lease_active", "lease_unreleased", "remote_stop_unconfirmed",
  "process_alive", "native_stop_unrecorded", "legacy_stop_unrecorded",
  "finalization_owner_active", "finalization_controller_alive", "finalization_owner_changed",
] as const;

/** Why an agent's executions do not count as stopped yet. */
export type AgentExecutionStopHold = {
  clause: typeof AGENT_EXECUTION_STOP_HOLD_CLAUSES[number];
  agentId?: string;
  runId?: string;
  leaseId?: string;
};

const HOLD_LOG_INTERVAL_MS = 60_000;
const HOLD_FORGET_AFTER_MS = 5 * HOLD_LOG_INTERVAL_MS;
const loggedHolds = new Map<string, { subject: string; loggedAt: number; seenAt: number }>();

/** A waiting stop is rechecked every few seconds. Log a hold when it starts,
 * when its cause changes, and at a slow interval while it lasts. A stop that
 * is no longer checked never reports its end, so its entry expires. */
export function noteAgentExecutionStopHold(agentIds: string[], hold: AgentExecutionStopHold | null) {
  const scope = agentIds.join(",");
  const now = Date.now();
  for (const [key, entry] of loggedHolds) {
    if (now - entry.seenAt >= HOLD_FORGET_AFTER_MS) loggedHolds.delete(key);
  }
  if (!hold) { loggedHolds.delete(scope); return hold; }
  const subject = `${hold.clause}:${hold.runId ?? ""}:${hold.leaseId ?? ""}`;
  const previous = loggedHolds.get(scope);
  const logged = previous?.subject !== subject || now - previous.loggedAt >= HOLD_LOG_INTERVAL_MS;
  loggedHolds.set(scope, { subject, loggedAt: logged ? now : previous!.loggedAt, seenAt: now });
  if (logged) logger.info({ agentIds, ...hold }, "Agent execution stop is waiting");
  return hold;
}

export function rememberedAgentExecutionStopHolds() {
  return loggedHolds.size;
}

/** Cancellation changes admission. Process and lease evidence controls cleanup. */
export async function agentExecutionsHaveStopped(db: Db, agentIds: string[]) {
  return !await agentExecutionStopHold(db, agentIds);
}

export async function agentExecutionStopHold(db: Db, agentIds: string[]): Promise<AgentExecutionStopHold | null> {
  if (!agentIds.length) return null;
  return noteAgentExecutionStopHold(agentIds, await findStopHold(db, agentIds));
}

async function findStopHold(db: Db, agentIds: string[]): Promise<AgentExecutionStopHold | null> {
  // A stable order names the same hold on every check while several last.
  const runs = await db.select().from(heartbeatRuns).where(inArray(heartbeatRuns.agentId, agentIds))
    .orderBy(asc(heartbeatRuns.createdAt), asc(heartbeatRuns.id));
  const runIds = db.select({ id: heartbeatRuns.id }).from(heartbeatRuns).where(inArray(heartbeatRuns.agentId, agentIds));
  const leases = await db.select().from(environmentLeases).where(or(
    inArray(environmentLeases.heartbeatRunId, runIds),
    inArray(sql`${environmentLeases.metadata}->>'agentId'`, agentIds),
  )).orderBy(asc(environmentLeases.createdAt), asc(environmentLeases.id));
  const runAgent = (runId: string | null | undefined) => runs.find(run => run.id === runId)?.agentId;
  const heldLease = leases.find(lease => (!lease.releasedAt && !(lease.status === "retained" && lease.cleanupStatus === "success")) || lease.status === "pending_cleanup" || lease.cleanupStatus === "failed");
  if (heldLease) return { clause: "lease_unreleased", leaseId: heldLease.id, runId: heldLease.heartbeatRunId ?? undefined,
    agentId: runAgent(heldLease.heartbeatRunId) };
  const coordinators = await db.select().from(nativeRunFinalizations)
    .where(inArray(nativeRunFinalizations.runId, runIds)).orderBy(asc(nativeRunFinalizations.runId));
  const now = new Date();
  const abandoned = coordinators.filter(row => row.leaseOwner);
  const ownedFinalization = abandoned.find(row => !row.leaseExpiresAt || row.leaseExpiresAt > now || row.resultId ||
      runs.find(run => run.id === row.runId)?.status !== "cancelled");
  if (ownedFinalization) return { clause: "finalization_owner_active", runId: ownedFinalization.runId, agentId: runAgent(ownedFinalization.runId) };
  for (const coordinator of abandoned) {
    if (!coordinator.controllerPid ||
        await recordedProcessIsGone(coordinator.controllerPid, coordinator.controllerProcessStartedAt)) continue;
    const observed = await readProcessStartedAt(coordinator.controllerPid).catch(() => null);
    if (!observed || !coordinator.controllerProcessStartedAt ||
        new Date(observed).getTime() === coordinator.controllerProcessStartedAt.getTime()) {
      return { clause: "finalization_controller_alive", runId: coordinator.runId, agentId: runAgent(coordinator.runId) };
    }
  }
  for (const run of runs) {
    const hold = (clause: AgentExecutionStopHold["clause"]): AgentExecutionStopHold => ({ clause, runId: run.id, agentId: run.agentId });
    if (!["succeeded", "failed", "cancelled", "timed_out", "interrupted"].includes(run.status)) return hold("run_active");
    if (run.controllerLeaseExpiresAt && run.controllerLeaseExpiresAt > new Date()) return hold("controller_lease_active");
    const runLeases = leases.filter(lease => lease.heartbeatRunId === run.id);
    if (runLeases.some(lease => lease.provider && lease.provider !== "local")) {
      if (run.status === "cancelled" && !runLeases.every(hasRemoteTerminationReceipt)) return hold("remote_stop_unconfirmed");
      continue;
    }
    let processAlive = Boolean(run.processPid && !await recordedProcessIsGone(run.processPid, run.processStartedAt));
    let groupAlive = Boolean(run.processGroupId &&
      !await recordedProcessIsGone(-run.processGroupId, recordedGroupStartedAt(run)));
    if (processAlive && run.processStartedAt) {
      const observed = await readProcessStartedAt(run.processPid!).catch(() => null);
      if (observed && new Date(observed).getTime() !== run.processStartedAt.getTime()) {
        processAlive = false;
        if (run.processGroupId === run.processPid) groupAlive = false;
      }
    }
    if (processAlive || groupAlive) return hold("process_alive");
    // Otherwise the next process to reuse either number would hold this agent.
    if (run.processPid || run.processGroupId) {
      await retireStoppedProcessIdentity(db, run).catch(error =>
        logger.warn({ err: error, runId: run.id }, "Could not retire a finished run's process identity"));
    }
    if (run.status !== "cancelled" || !run.startedAt) continue;
    if (run.runtimeMode === "native" && !run.processPid && !run.processGroupId &&
        !await hasNativeLocalProcessStop(db, run.companyId, run.id) &&
        !await isCancelledNativeStartup(db, run, coordinators.find(row => row.runId === run.id))) return hold("native_stop_unrecorded");
    if (run.runtimeMode === "legacy" && !run.processPid && !run.processGroupId &&
        (run.resultJson?.executionCancellation as Record<string, unknown> | undefined)?.state !== "acknowledged" &&
        !(run.executionStage === "settled" && !await runUsedConversationAdapter(db, run)) &&
        !await isCancelledNativeStartup(db, run, coordinators.find(row => row.runId === run.id))) return hold("legacy_stop_unrecorded");
  }
  // Release an expired owner only after its cancelled execution has stop proof.
  for (const coordinator of abandoned) {
    const [cleared] = await db.update(nativeRunFinalizations).set({ leaseOwner: null, leaseExpiresAt: null, updatedAt: now })
      .where(and(eq(nativeRunFinalizations.runId, coordinator.runId),
        eq(nativeRunFinalizations.leaseOwner, coordinator.leaseOwner!),
        eq(nativeRunFinalizations.leaseExpiresAt, coordinator.leaseExpiresAt!),
        eq(nativeRunFinalizations.controllerGeneration, coordinator.controllerGeneration),
        eq(nativeRunFinalizations.phase, coordinator.phase), isNull(nativeRunFinalizations.resultId)))
      .returning({ runId: nativeRunFinalizations.runId });
    if (!cleared) return { clause: "finalization_owner_changed", runId: coordinator.runId, agentId: runAgent(coordinator.runId) };
  }
  return null;
}
