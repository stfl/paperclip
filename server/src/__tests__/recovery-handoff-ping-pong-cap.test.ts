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

describeEmbeddedPostgres("stranded sweep and hand-overs between the same two agents", () => {
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;
  let db: ReturnType<typeof createDb>;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-recovery-handoff-ping-pong-");
    db = createDb(tempDb.connectionString);
  }, 30_000);

  afterAll(async () => {
    await tempDb.cleanup();
  });

  // An in_progress issue handed on from inside continuation runs. Each entry
  // is the agent of one run, oldest first; the last run handed the issue to
  // `assignee`.
  async function seedContinuations(runs: Array<"A" | "B">, assignee: "A" | "B") {
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
    const ids = { A: randomUUID(), B: randomUUID() };
    await db.insert(agents).values(
      (["A", "B"] as const).map((name) => ({
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
      status: "in_progress",
      assigneeAgentId: ids[assignee],
      createdAt: new Date(Date.now() - 60 * 60 * 1000),
      updatedAt: new Date(Date.now() - 60 * 60 * 1000),
    });
    await db.insert(heartbeatRuns).values(
      runs.map((agent, i) => ({
        companyId,
        agentId: ids[agent],
        issueId,
        status: "cancelled",
        errorCode: "issue_reassigned",
        error: "Cancelled before issue reassignment",
        resultJson: { reassignmentStopConfirmed: true },
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
    return { issueId };
  }

  it.each([
    { runs: ["A", "B"] as Array<"A" | "B">, assignee: "A" as const },
    { runs: ["A", "B", "A"] as Array<"A" | "B">, assignee: "B" as const },
  ])("blocks an issue its continuations hand back and forth ($runs)", async ({ runs, assignee }) => {
    const f = await seedContinuations(runs, assignee);
    const enqueueWakeup = vi.fn();

    const result = await recoveryService(db, { enqueueWakeup }).reconcileStrandedAssignedIssues();

    expect(enqueueWakeup).not.toHaveBeenCalled();
    expect(result).toMatchObject({ escalated: 1, issueIds: [f.issueId] });
    const [issue] = await db.select().from(issues).where(eq(issues.id, f.issueId));
    expect(issue.status).toBe("blocked");
  });
});
