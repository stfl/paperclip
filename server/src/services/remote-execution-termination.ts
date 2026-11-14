import { and, desc, eq, isNull } from "drizzle-orm";
import { environmentLeases, heartbeatRunEvents, type Db } from "@paperclipai/db";
import { PROCESS_IDENTITY_RECORDED } from "./native-local-process-stop.js";

type LeaseIdentity = {
  id: string; companyId: string; heartbeatRunId: string | null;
  provider: string | null; providerLeaseId: string | null;
};

/** Bind a provider receipt to the exact host-owned lease and run. Old plugins
 * return void; that remains supported but grants no continuation authority. */
export function remoteTerminationReceipt(lease: LeaseIdentity, value: unknown) {
  const receipt = value as { providerLeaseId?: unknown; state?: unknown } | null;
  if (!lease.heartbeatRunId || !lease.provider || lease.provider === "local" ||
      !lease.providerLeaseId || receipt?.providerLeaseId !== lease.providerLeaseId ||
      !["stopped", "destroyed"].includes(String(receipt?.state))) return undefined;
  return {
    schema: "paperclip.remote-termination.v1", companyId: lease.companyId,
    runId: lease.heartbeatRunId, leaseId: lease.id, provider: lease.provider,
    providerLeaseId: lease.providerLeaseId, state: receipt!.state,
    confirmedAt: new Date().toISOString(),
  };
}

export function hasRemoteTerminationReceipt(lease: LeaseIdentity & {
  releasedAt: unknown; cleanupStatus: string | null; status: string;
  metadata: Record<string, unknown> | null;
}): boolean {
  const receipt = lease.metadata?.remoteExecutionTermination as Record<string, unknown> | undefined;
  return Boolean(lease.releasedAt && lease.cleanupStatus === "success" &&
    ["released", "expired", "failed"].includes(lease.status) && receipt &&
    receipt.schema === "paperclip.remote-termination.v1" &&
    receipt.companyId === lease.companyId && receipt.runId === lease.heartbeatRunId &&
    receipt.leaseId === lease.id && receipt.provider === lease.provider &&
    remoteTerminationReceipt(lease, receipt));
}

export function remoteLeaseCleanupScope(lease: Pick<LeaseIdentity, "provider" | "providerLeaseId">) {
  return lease.provider && lease.provider !== "local" && lease.providerLeaseId
    ? JSON.stringify([lease.provider, lease.providerLeaseId]) : undefined;
}

export async function stoppedRemoteCleanupScopes(db: Db, companyId: string, runId: string) {
  const leases = await db.select().from(environmentLeases).where(and(
    eq(environmentLeases.companyId, companyId), eq(environmentLeases.heartbeatRunId, runId),
  ));
  if (leases.length === 0 || !leases.every(hasRemoteTerminationReceipt)) return null;
  return [...new Set(leases.map(lease => remoteLeaseCleanupScope(lease)!))];
}

export async function remoteExecutionHasStopped(db: Db, companyId: string, runId: string) {
  return await stoppedRemoteCleanupScopes(db, companyId, runId) !== null;
}

type RunLease = typeof environmentLeases.$inferSelect;

/**
 * Says where the stop of a finished run's recorded process can be proven. A run
 * in a provider environment records that environment's process identifiers.
 * They name nothing in this host's process table, so only the provider's
 * termination receipts prove that such a run stopped.
 *
 * `host` means the identifiers were recorded on this host and every provider
 * lease beside them has its receipt: probe the host's process table.
 */
export async function recordedProcessStopAuthority(
  db: Db,
  run: { id: string; companyId: string },
  knownLeases?: RunLease[],
): Promise<"host" | "provider_stopped" | "provider_unconfirmed"> {
  const leases = knownLeases ?? await db.select().from(environmentLeases).where(and(
    eq(environmentLeases.companyId, run.companyId), eq(environmentLeases.heartbeatRunId, run.id),
  ));
  const providerLeases = leases.filter(lease => lease.provider !== "local");
  if (!providerLeases.every(hasRemoteTerminationReceipt)) return "provider_unconfirmed";
  if (providerLeases.length > 0 && providerLeases.length === leases.length) return "provider_stopped";
  // With no provider lease, or a local lease beside the provider's, the
  // recorded launch says which process table the identifiers belong to.
  const [identity] = await db.select({ payload: heartbeatRunEvents.payload }).from(heartbeatRunEvents).where(and(
    eq(heartbeatRunEvents.companyId, run.companyId), eq(heartbeatRunEvents.runId, run.id),
    eq(heartbeatRunEvents.eventType, PROCESS_IDENTITY_RECORDED), isNull(heartbeatRunEvents.sourceEventId),
  )).orderBy(desc(heartbeatRunEvents.seq)).limit(1);
  const targetKind = identity?.payload?.targetKind;
  if (targetKind === undefined || targetKind === "local") return "host";
  return providerLeases.length > 0 ? "provider_stopped" : "provider_unconfirmed";
}
