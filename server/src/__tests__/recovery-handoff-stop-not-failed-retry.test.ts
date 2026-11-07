import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import {
  agents,
  companies,
  companyMemberships,
  createDb,
  heartbeatRuns,
  issueRecoveryActions,
  issues,
} from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { recoveryService } from "../services/recovery/service.js";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

describeEmbeddedPostgres("stranded sweep and in-run hand-overs", () => {
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;
  let db: ReturnType<typeof createDb>;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-recovery-handoff-stop-");
    db = createDb(tempDb.connectionString);
  }, 30_000);

  afterAll(async () => {
    await tempDb.cleanup();
  });

  const handover = {
    status: "cancelled",
    errorCode: "issue_reassigned",
    error: "Cancelled before issue reassignment",
    resultJson: { reassignmentStopConfirmed: true },
  } as const;
  // A failed run that a fresh conversation turn may retry, so the sweep
  // counts it rather than holding it for reconciliation.
  const failure = {
    status: "failed",
    errorCode: "adapter_failed",
    error: "The adapter exited 1",
    resultJson: { conversationContinuation: "continue_conversation_v1" },
  } as const;

  async function seedCompany(names: string[]) {
    const companyId = randomUUID();
    await db.insert(companies).values({
      id: companyId,
      name: "Hop Co",
      issuePrefix: `P${companyId.slice(0, 6)}`,
      defaultResponsibleUserId: "responsible-user",
    });
    await db.insert(companyMemberships).values({
      companyId,
      principalType: "user",
      principalId: "responsible-user",
      status: "active",
      membershipRole: "member",
    });
    const ids = names.map(() => randomUUID());
    await db.insert(agents).values(
      names.map((name, i) => ({
        id: ids[i],
        companyId,
        name,
        role: "engineer",
        status: "idle",
        adapterType: "codex_local",
      })),
    );
    return { companyId, ids };
  }

  // A hands the issue to B and B to C, each from inside its run. B's run was
  // the sweep's assignment recovery, so it carries `assignment_recovery`.
  async function seedTodoHops(last: "handover" | "failure") {
    const { companyId, ids: [a, b, c] } = await seedCompany(["A", "B", "C"]);
    const issueId = randomUUID();
    const assignee = last === "handover" ? c : b;
    await db.insert(issues).values({
      id: issueId,
      companyId,
      title: "Hand the work on",
      status: "todo",
      assigneeAgentId: assignee,
      createdAt: new Date(Date.now() - 60 * 60 * 1000),
      updatedAt: new Date(Date.now() - 60 * 60 * 1000),
    });
    await db.insert(heartbeatRuns).values({
      companyId,
      agentId: a,
      issueId,
      ...handover,
      createdAt: new Date(Date.now() - 6 * 60_000),
      startedAt: new Date(Date.now() - 6 * 60_000),
      finishedAt: new Date(Date.now() - 5 * 60_000),
      contextSnapshot: { issueId, wakeReason: "issue_assigned" },
    });
    await db.insert(heartbeatRuns).values({
      companyId,
      agentId: b,
      issueId,
      ...(last === "handover"
        ? handover
        : failure),
      createdAt: new Date(Date.now() - 4 * 60_000),
      startedAt: new Date(Date.now() - 4 * 60_000),
      finishedAt: new Date(Date.now() - 3 * 60_000),
      contextSnapshot: {
        issueId,
        wakeReason: "issue_assignment_recovery",
        retryReason: "assignment_recovery",
      },
    });
    return { companyId, issueId, assignee };
  }

  function recordingEnqueue(companyId: string, issueId: string) {
    return vi.fn().mockImplementation(async (agentId: string) => {
      const [run] = await db.insert(heartbeatRuns).values({
        companyId,
        agentId,
        issueId,
        status: "queued",
        contextSnapshot: { issueId, wakeReason: "issue_assignment_recovery" },
      }).returning();
      return run;
    });
  }

  async function recoveryActionsOf(issueId: string) {
    return db
      .select()
      .from(issueRecoveryActions)
      .where(eq(issueRecoveryActions.sourceIssueId, issueId));
  }

  it("dispatches the new assignee of a todo issue after hand-overs and opens no recovery action", async () => {
    const f = await seedTodoHops("handover");
    const enqueueWakeup = recordingEnqueue(f.companyId, f.issueId);

    const result = await recoveryService(db, { enqueueWakeup }).reconcileStrandedAssignedIssues();

    expect(result).toMatchObject({ escalated: 0, dispatchRequeued: 1, issueIds: [f.issueId] });
    expect(enqueueWakeup).toHaveBeenCalledOnce();
    expect(enqueueWakeup).toHaveBeenCalledWith(
      f.assignee,
      expect.objectContaining({ reason: "issue_assignment_recovery" }),
    );
    const [issue] = await db.select().from(issues).where(eq(issues.id, f.issueId));
    expect(issue).toMatchObject({ status: "todo", assigneeAgentId: f.assignee });
    expect(await recoveryActionsOf(f.issueId)).toHaveLength(0);
  });

  it("still escalates a todo issue whose assignment recovery failed", async () => {
    const f = await seedTodoHops("failure");
    const enqueueWakeup = vi.fn();

    const result = await recoveryService(db, { enqueueWakeup }).reconcileStrandedAssignedIssues();

    expect(enqueueWakeup).not.toHaveBeenCalled();
    expect(result).toMatchObject({ escalated: 1, issueIds: [f.issueId] });
    const [issue] = await db.select().from(issues).where(eq(issues.id, f.issueId));
    expect(issue).toMatchObject({ status: "blocked", assigneeAgentId: f.assignee });
  });

  // An in_progress issue handed on from inside continuation runs. Each
  // entry is the agent of one run, oldest first; the issue ends with B.
  async function seedContinuations(runs: Array<{ agent: "A" | "B" }>) {
    const { companyId, ids: [a, b] } = await seedCompany(["A", "B"]);
    const issueId = randomUUID();
    await db.insert(issues).values({
      id: issueId,
      companyId,
      title: "Continue the work",
      status: "in_progress",
      assigneeAgentId: b,
      createdAt: new Date(Date.now() - 60 * 60 * 1000),
      updatedAt: new Date(Date.now() - 60 * 60 * 1000),
    });
    await db.insert(heartbeatRuns).values(
      runs.map((run, i) => ({
        companyId,
        agentId: run.agent === "A" ? a : b,
        issueId,
        ...handover,
        createdAt: new Date(Date.now() - (40 - i * 10) * 60_000),
        startedAt: new Date(Date.now() - (40 - i * 10) * 60_000),
        finishedAt: new Date(Date.now() - (39 - i * 10) * 60_000),
        contextSnapshot: {
          issueId,
          wakeReason: "issue_continuation_needed",
          retryReason: "issue_continuation_needed",
        },
      })),
    );
    return { companyId, issueId, assignee: b };
  }

  it("does not count hand-overs as an in_progress issue's failed continuation retries", async () => {
    const f = await seedContinuations([
      { agent: "A" },
      { agent: "B" },
      { agent: "A" },
    ]);
    const enqueueWakeup = vi.fn().mockImplementation(async (agentId: string) => {
      const [run] = await db.insert(heartbeatRuns).values({
        companyId: f.companyId,
        agentId,
        issueId: f.issueId,
        status: "queued",
        contextSnapshot: { issueId: f.issueId, wakeReason: "issue_continuation_needed" },
      }).returning();
      return run;
    });

    const result = await recoveryService(db, { enqueueWakeup }).reconcileStrandedAssignedIssues();

    expect(result).toMatchObject({ escalated: 0, continuationRequeued: 1, issueIds: [f.issueId] });
    expect(enqueueWakeup).toHaveBeenCalledOnce();
    expect(enqueueWakeup).toHaveBeenCalledWith(f.assignee, expect.anything());
    const [issue] = await db.select().from(issues).where(eq(issues.id, f.issueId));
    expect(issue.status).toBe("in_progress");
    expect(await recoveryActionsOf(f.issueId)).toHaveLength(0);
  });
});
