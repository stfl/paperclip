import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  agents,
  companies,
  createDb,
  heartbeatRuns,
  issueThreadInteractions,
  issues,
} from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { createPostgresRunDispatchAdapter } from "../modules/run-dispatch/adapters/postgres.js";
import { observeCrossIssueInfluence } from "../services/cross-issue-influence-limit.js";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

describeEmbeddedPostgres("a card's wake for its addressee agent", () => {
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;
  let db: ReturnType<typeof createDb>;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-addressee-interaction-wake-");
    db = createDb(tempDb.connectionString);
  }, 30_000);

  afterAll(async () => {
    await tempDb.cleanup();
  });

  // The assignee asks the addressee a question on its own issue; a third
  // agent of the company is neither.
  async function seedCard() {
    const companyId = randomUUID();
    const [assignee, addressee, bystander] = [randomUUID(), randomUUID(), randomUUID()];
    const issueId = randomUUID();
    const interactionId = randomUUID();
    await db.insert(companies).values({
      id: companyId,
      name: "Card Co",
      issuePrefix: `C${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      defaultResponsibleUserId: "responsible-user",
    });
    await db.insert(agents).values(
      [assignee, addressee, bystander].map((id, i) => ({
        id,
        companyId,
        name: ["Asker", "Addressee", "Bystander"][i],
        role: "engineer",
        status: "active",
        adapterType: "codex_local",
        adapterConfig: {},
        runtimeConfig: { heartbeat: { wakeOnDemand: true, maxConcurrentRuns: 1 } },
        permissions: {},
      })),
    );
    await db.insert(issues).values({
      id: issueId,
      companyId,
      title: "Ask another agent",
      status: "in_progress",
      priority: "medium",
      assigneeAgentId: assignee,
    });
    await db.insert(issueThreadInteractions).values({
      id: interactionId,
      companyId,
      issueId,
      kind: "ask_user_questions",
      status: "pending",
      createdByAgentId: assignee,
      addresseeAgentId: addressee,
      payload: { version: 1, questions: [] },
    } as typeof issueThreadInteractions.$inferInsert);
    return { companyId, assignee, addressee, bystander, issueId, interactionId };
  }

  async function queueCardWake(f: Awaited<ReturnType<typeof seedCard>>, agentId: string) {
    const [run] = await db.insert(heartbeatRuns).values({
      companyId: f.companyId,
      agentId,
      invocationSource: "automation",
      status: "queued",
      contextSnapshot: {
        issueId: f.issueId,
        taskId: f.issueId,
        interactionId: f.interactionId,
        interactionKind: "ask_user_questions",
        sourceCommentId: null,
        wakeReason: "interaction_pending",
        source: "issue.interaction.created",
      },
    }).returning();
    return run!.id;
  }

  function staleness(f: { companyId: string }, runId: string) {
    return createPostgresRunDispatchAdapter(db).cancelStaleQueuedRun({
      runId,
      companyId: f.companyId,
      expectedStatus: "queued",
      now: new Date(),
    });
  }

  it("admits the addressee's run on an issue another agent holds, as a same-issue writer", async () => {
    const f = await seedCard();
    const runId = await queueCardWake(f, f.addressee);

    expect(await staleness(f, runId)).toMatchObject({ outcome: "not_stale" });

    await db.update(heartbeatRuns).set({ status: "running" }).where(eq(heartbeatRuns.id, runId));
    for (const kind of ["comment", "interaction_resolution"] as const) {
      expect(
        await observeCrossIssueInfluence(db, {
          companyId: f.companyId,
          runId,
          agentId: f.addressee,
          targetIssueId: f.issueId,
          kind,
        }),
      ).toBeNull();
    }
    const [issue] = await db.select().from(issues).where(eq(issues.id, f.issueId));
    expect(issue).toMatchObject({ status: "in_progress", assigneeAgentId: f.assignee });
  });

  it("still cancels the same wake for an agent the card does not address", async () => {
    const f = await seedCard();
    const runId = await queueCardWake(f, f.bystander);

    expect(await staleness(f, runId)).toMatchObject({
      outcome: "cancelled",
      errorCode: "issue_assignee_changed",
    });
  });

  it("cancels the addressee's run once the card is no longer pending", async () => {
    const f = await seedCard();
    await db
      .update(issueThreadInteractions)
      .set({ status: "accepted", resolvedAt: new Date() })
      .where(eq(issueThreadInteractions.id, f.interactionId));
    const runId = await queueCardWake(f, f.addressee);

    expect(await staleness(f, runId)).toMatchObject({
      outcome: "cancelled",
      errorCode: "issue_assignee_changed",
    });
  });
});
