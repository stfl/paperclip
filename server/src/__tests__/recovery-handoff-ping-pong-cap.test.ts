import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import {
  agents,
  companies,
  companyMemberships,
  createDb,
  heartbeatRuns,
  issues,
} from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { recoveryService } from "../services/recovery/service.js";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

type Agent = "A" | "B" | "C";
// One run that handed the issue on. `recovery` marks a run the sweep queued
// with the lane's retry reason; any other run is an ordinary wake.
type Hop = { agent: Agent; recovery: boolean };

const LANES = {
  in_progress: { reason: "issue_continuation_needed", retryReason: "issue_continuation_needed" },
  todo: { reason: "issue_assignment_recovery", retryReason: "assignment_recovery" },
} as const;

const cont = (agent: Agent): Hop => ({ agent, recovery: true });
const wake = (agent: Agent): Hop => ({ agent, recovery: false });

describeEmbeddedPostgres("stranded sweep and hand-overs that return the issue", () => {
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;
  let db: ReturnType<typeof createDb>;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-recovery-handoff-ping-pong-");
    db = createDb(tempDb.connectionString);
  }, 30_000);

  afterAll(async () => {
    await tempDb.cleanup();
  });

  // An issue handed on from inside runs, oldest hop first; the last hop
  // handed it to `assignee`.
  async function seedHops(lane: keyof typeof LANES, hops: readonly Hop[], assignee: Agent) {
    const companyId = randomUUID();
    await db.insert(companies).values({
      id: companyId,
      name: "Ping Pong Co",
      issuePrefix: `Q${companyId.slice(0, 6)}`,
      defaultResponsibleUserId: "responsible-user",
    });
    await db.insert(companyMemberships).values({
      companyId,
      principalType: "user",
      principalId: "responsible-user",
      status: "active",
      membershipRole: "member",
    });
    const ids = { A: randomUUID(), B: randomUUID(), C: randomUUID() };
    await db.insert(agents).values(
      (["A", "B", "C"] as const).map((name) => ({
        id: ids[name],
        companyId,
        name,
        role: "engineer",
        status: "idle",
        adapterType: "codex_local",
      })),
    );
    const issueId = randomUUID();
    await db.insert(issues).values({
      id: issueId,
      companyId,
      title: "Bounce the work",
      status: lane,
      assigneeAgentId: ids[assignee],
      createdAt: new Date(Date.now() - 2 * 60 * 60 * 1000),
      updatedAt: new Date(Date.now() - 2 * 60 * 60 * 1000),
    });
    const n = hops.length;
    await db.insert(heartbeatRuns).values(
      hops.map((hop, i) => ({
        companyId,
        agentId: ids[hop.agent],
        issueId,
        status: "cancelled",
        errorCode: "issue_reassigned",
        error: "Cancelled before issue reassignment",
        resultJson: { reassignmentStopConfirmed: true },
        createdAt: new Date(Date.now() - (n - i) * 10 * 60_000),
        startedAt: new Date(Date.now() - (n - i) * 10 * 60_000),
        finishedAt: new Date(Date.now() - ((n - i) * 10 - 1) * 60_000),
        contextSnapshot: hop.recovery
          ? { issueId, wakeReason: LANES[lane].reason, retryReason: LANES[lane].retryReason }
          : { issueId, wakeReason: "issue_assigned" },
      })),
    );
    return { companyId, issueId, assigneeId: ids[assignee] };
  }

  function recordingEnqueue(companyId: string, issueId: string) {
    return vi.fn().mockImplementation(async (agentId: string) => {
      const [run] = await db.insert(heartbeatRuns).values({
        companyId,
        agentId,
        issueId,
        status: "queued",
        contextSnapshot: { issueId },
      }).returning();
      return run;
    });
  }

  it.each([
    { name: "A→B→A", lane: "in_progress", hops: [cont("A"), cont("B")], assignee: "A" },
    { name: "A→B→A→B", lane: "in_progress", hops: [cont("A"), cont("B"), cont("A")], assignee: "B" },
    { name: "A→B→C→B→A", lane: "in_progress", hops: [cont("A"), cont("B"), cont("C"), cont("B")], assignee: "A" },
    // An ordinary wake that only handed the issue back neither counts nor ends the chain.
    { name: "A→B→A, B on an ordinary wake", lane: "in_progress", hops: [cont("A"), wake("B")], assignee: "A" },
    { name: "todo A→B→A", lane: "todo", hops: [cont("A"), cont("B")], assignee: "A" },
  ] as const)("blocks an issue handed back to an agent that handed it away on a recovery run ($name)", async ({ lane, hops, assignee }) => {
    const f = await seedHops(lane, hops, assignee);
    const enqueueWakeup = recordingEnqueue(f.companyId, f.issueId);

    const result = await recoveryService(db, { enqueueWakeup }).reconcileStrandedAssignedIssues();

    expect(enqueueWakeup).not.toHaveBeenCalled();
    expect(result).toMatchObject({ escalated: 1, issueIds: [f.issueId] });
    const [issue] = await db.select().from(issues).where(eq(issues.id, f.issueId));
    expect(issue.status).toBe("blocked");
  });

  it.each([
    { name: "single hop A→B", lane: "in_progress", hops: [cont("A")], assignee: "B", requeued: "continuationRequeued" },
    { name: "A→B→C", lane: "in_progress", hops: [cont("A"), cont("B")], assignee: "C", requeued: "continuationRequeued" },
    { name: "A→B→A on ordinary wakes", lane: "in_progress", hops: [wake("A"), wake("B")], assignee: "A", requeued: "continuationRequeued" },
    { name: "todo single hop A→B", lane: "todo", hops: [cont("A")], assignee: "B", requeued: "dispatchRequeued" },
  ] as const)("requeues the new assignee ($name)", async ({ lane, hops, assignee, requeued }) => {
    const f = await seedHops(lane, hops, assignee);
    const enqueueWakeup = recordingEnqueue(f.companyId, f.issueId);

    const result = await recoveryService(db, { enqueueWakeup }).reconcileStrandedAssignedIssues();

    expect(result).toMatchObject({ escalated: 0, [requeued]: 1, issueIds: [f.issueId] });
    expect(enqueueWakeup).toHaveBeenCalledOnce();
    expect(enqueueWakeup).toHaveBeenCalledWith(f.assigneeId, expect.anything());
    const [issue] = await db.select().from(issues).where(eq(issues.id, f.issueId));
    expect(issue.status).toBe(lane);
  });
});
