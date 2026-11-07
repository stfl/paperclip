import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import {
  agents,
  agentWakeupRequests,
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

const CANCEL_EVENT = "run cancelled before issue reassignment";

vi.mock("../services/heartbeat-run-events.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../services/heartbeat-run-events.js")>();
  return {
    ...actual,
    appendHeartbeatRunEvent: async (...args: Parameters<typeof actual.appendHeartbeatRunEvent>) => {
      if (args[1].message === CANCEL_EVENT) throw new Error("deadlock detected");
      return actual.appendHeartbeatRunEvent(...args);
    },
  };
});

const { heartbeatService } = await import("../services/heartbeat.ts");

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

describeEmbeddedPostgres("cancel whose run event append fails", () => {
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;
  let db: ReturnType<typeof createDb>;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-cancel-event-failure-");
    db = createDb(tempDb.connectionString);
  }, 30_000);

  afterAll(async () => {
    await tempDb.cleanup();
  });

  it("still cancels the run and its wakeup and releases the issue", async () => {
    const companyId = randomUUID();
    const agentId = randomUUID();
    const issueId = randomUUID();
    const runId = randomUUID();
    const wakeupRequestId = randomUUID();
    await db.insert(companies).values({
      id: companyId, name: "Cancel event", issuePrefix: `C${companyId.slice(0, 6)}`,
      requireBoardApprovalForNewAgents: false, defaultResponsibleUserId: "responsible-user",
    });
    await db.insert(companyMemberships).values({
      companyId, principalType: "user", principalId: "responsible-user", status: "active", membershipRole: "member",
    });
    await db.insert(agents).values({
      id: agentId, companyId, name: "Reviewer", role: "engineer", status: "running",
      adapterType: "codex_local", adapterConfig: {}, runtimeConfig: {}, permissions: {},
    });
    await db.insert(issues).values({
      id: issueId, companyId, title: "Review", status: "in_progress", priority: "medium",
      assigneeAgentId: agentId,
    });
    await db.insert(agentWakeupRequests).values({
      id: wakeupRequestId, companyId, agentId, source: "assignment", reason: "issue_assigned",
      status: "claimed", payload: { issueId },
    });
    await db.insert(heartbeatRuns).values({
      id: runId, companyId, agentId, invocationSource: "assignment", status: "queued",
      wakeupRequestId, responsibleUserId: "responsible-user", contextSnapshot: { issueId },
    });
    await db.update(issues).set({
      executionRunId: runId, executionAgentNameKey: "reviewer", executionLockedAt: new Date(),
    }).where(eq(issues.id, issueId));

    const cancelled = await heartbeatService(db).cancelRun(runId, "Cancelled before issue reassignment", {
      errorCode: "issue_reassigned",
      resultJson: { reassignmentStopConfirmed: true, issueMutationStopId: randomUUID() },
      eventMessage: CANCEL_EVENT,
      eventPayload: { issueId },
    });

    expect(cancelled?.status).toBe("cancelled");
    const [wakeup] = await db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.id, wakeupRequestId));
    expect(wakeup?.status).toBe("cancelled");
    const [issue] = await db.select().from(issues).where(eq(issues.id, issueId));
    expect(issue?.executionRunId).not.toBe(runId);
  }, 30_000);
});
