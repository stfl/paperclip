import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  agents,
  companies,
  createDb,
  heartbeatRuns,
  issueComments,
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
    // A busy AI connection retries it as it retries a non-assignee comment
    // wake, instead of handing it to the issue's holder.
    const [admitted] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, runId));
    expect(admitted?.runnerProfileJson).toMatchObject({ aiConnectionNonAssigneeCommentWake: true });

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

  async function insertCard(
    values: Partial<typeof issueThreadInteractions.$inferInsert> & {
      companyId: string;
      issueId: string;
    },
  ) {
    const id = randomUUID();
    await db.insert(issueThreadInteractions).values({
      id,
      kind: "ask_user_questions",
      status: "pending",
      payload: { version: 1, questions: [] },
      ...values,
    } as typeof issueThreadInteractions.$inferInsert);
    return id;
  }

  it("admits the addressee's run for a card the board created", async () => {
    const f = await seedCard();
    const interactionId = await insertCard({
      companyId: f.companyId,
      issueId: f.issueId,
      createdByAgentId: null,
      createdByUserId: "board-user",
      addresseeAgentId: f.addressee,
    });
    const runId = await queueCardWake({ ...f, interactionId }, f.addressee);

    expect(await staleness(f, runId)).toMatchObject({ outcome: "not_stale" });
  });

  it("cancels the addressee's run when the card it names is on another issue", async () => {
    const f = await seedCard();
    const otherIssueId = randomUUID();
    await db.insert(issues).values({
      id: otherIssueId,
      companyId: f.companyId,
      title: "Another issue",
      status: "in_progress",
      priority: "medium",
      assigneeAgentId: f.assignee,
    });
    const interactionId = await insertCard({
      companyId: f.companyId,
      issueId: otherIssueId,
      createdByAgentId: f.assignee,
      addresseeAgentId: f.addressee,
    });
    const runId = await queueCardWake({ ...f, interactionId }, f.addressee);

    expect(await staleness(f, runId)).toMatchObject({
      outcome: "cancelled",
      errorCode: "issue_assignee_changed",
    });
  });

  it("cancels the addressee's run when the card it names belongs to another company", async () => {
    const f = await seedCard();
    const other = await seedCard();
    const runId = await queueCardWake({ ...f, interactionId: other.interactionId }, f.addressee);

    expect(await staleness(f, runId)).toMatchObject({
      outcome: "cancelled",
      errorCode: "issue_assignee_changed",
    });
  });

  // The card names this issue, but belongs to another company: only the
  // company filter tells it apart.
  it("cancels the addressee's run when a card on the same issue id belongs to another company", async () => {
    const f = await seedCard();
    const other = await seedCard();
    const interactionId = await insertCard({
      companyId: other.companyId,
      issueId: f.issueId,
      createdByAgentId: other.assignee,
      addresseeAgentId: f.addressee,
    });
    const runId = await queueCardWake({ ...f, interactionId }, f.addressee);

    expect(await staleness(f, runId)).toMatchObject({
      outcome: "cancelled",
      errorCode: "issue_assignee_changed",
    });
  });

  // Agents trading cards on one issue: `earlier` agent cards before the one
  // the wake names, all later than any human turn.
  async function seedTradedCards(earlier: number) {
    const f = await seedCard();
    const base = Date.now() - 60 * 60_000;
    for (let i = 0; i < earlier; i += 1) {
      await insertCard({
        companyId: f.companyId,
        issueId: f.issueId,
        status: "answered",
        createdByAgentId: i % 2 === 0 ? f.assignee : f.addressee,
        addresseeAgentId: i % 2 === 0 ? f.addressee : f.assignee,
        createdAt: new Date(base + i * 60_000),
      });
    }
    await db
      .update(issueThreadInteractions)
      .set({ createdAt: new Date(base + earlier * 60_000 + 30_000) })
      .where(eq(issueThreadInteractions.id, f.interactionId));
    return { ...f, base };
  }

  it("cancels the addressee's run once agents have traded too many cards since the last human turn", async () => {
    const f = await seedTradedCards(10);
    const runId = await queueCardWake(f, f.addressee);

    expect(await staleness(f, runId)).toMatchObject({
      outcome: "cancelled",
      errorCode: "issue_assignee_changed",
    });
  });

  it("admits the addressee's run while the cards agents traded stay within the cap", async () => {
    const f = await seedTradedCards(9);
    const runId = await queueCardWake(f, f.addressee);

    expect(await staleness(f, runId)).toMatchObject({ outcome: "not_stale" });
  });

  // The same trade with the database's own timestamps, which keep
  // microseconds: the woken card is created last.
  async function seedTradedCardsAtDbTime(earlier: number) {
    const f = await seedCard();
    await db.delete(issueThreadInteractions).where(eq(issueThreadInteractions.id, f.interactionId));
    for (let i = 0; i < earlier; i += 1) {
      await insertCard({
        companyId: f.companyId,
        issueId: f.issueId,
        status: "answered",
        createdByAgentId: i % 2 === 0 ? f.assignee : f.addressee,
        addresseeAgentId: i % 2 === 0 ? f.addressee : f.assignee,
      });
    }
    const interactionId = await insertCard({
      companyId: f.companyId,
      issueId: f.issueId,
      createdByAgentId: f.assignee,
      addresseeAgentId: f.addressee,
    });
    return { ...f, interactionId };
  }

  it.each([
    [9, "not_stale"],
    [10, "cancelled"],
  ] as const)(
    "with database timestamps, %i earlier traded cards leave the addressee's run %s",
    async (earlier, outcome) => {
      const f = await seedTradedCardsAtDbTime(earlier);
      const runId = await queueCardWake(f, f.addressee);

      expect(await staleness(f, runId)).toMatchObject({ outcome });
    },
  );

  it("admits the addressee's run again after a human comments on the issue", async () => {
    const f = await seedTradedCards(10);
    await db.insert(issueComments).values({
      companyId: f.companyId,
      issueId: f.issueId,
      authorUserId: "board-user",
      body: "Carry on.",
      createdAt: new Date(f.base + 9 * 60_000 + 30_000),
    });
    const runId = await queueCardWake(f, f.addressee);

    expect(await staleness(f, runId)).toMatchObject({ outcome: "not_stale" });
  });
});
