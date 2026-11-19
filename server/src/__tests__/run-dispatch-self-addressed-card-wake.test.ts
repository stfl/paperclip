import { randomUUID } from "node:crypto";
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

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

describeEmbeddedPostgres("a card an agent addresses to itself", () => {
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;
  let db: ReturnType<typeof createDb>;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-self-addressed-card-wake-");
    db = createDb(tempDb.connectionString);
  }, 30_000);

  afterAll(async () => {
    await tempDb.cleanup();
  });

  it("gives its author no run on an issue another agent holds", async () => {
    const companyId = randomUUID();
    const [holder, author] = [randomUUID(), randomUUID()];
    const issueId = randomUUID();
    const interactionId = randomUUID();
    await db.insert(companies).values({
      id: companyId,
      name: "Note Co",
      issuePrefix: `N${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      defaultResponsibleUserId: "responsible-user",
    });
    await db.insert(agents).values(
      [holder, author].map((id, i) => ({
        id,
        companyId,
        name: ["Holder", "Author"][i],
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
      title: "Someone else's work",
      status: "in_progress",
      priority: "medium",
      assigneeAgentId: holder,
    });
    await db.insert(issueThreadInteractions).values({
      id: interactionId,
      companyId,
      issueId,
      kind: "ask_user_questions",
      status: "pending",
      createdByAgentId: author,
      addresseeAgentId: author,
      payload: { version: 1, questions: [] },
    } as typeof issueThreadInteractions.$inferInsert);
    const [run] = await db.insert(heartbeatRuns).values({
      companyId,
      agentId: author,
      invocationSource: "automation",
      status: "queued",
      contextSnapshot: {
        issueId,
        taskId: issueId,
        interactionId,
        interactionKind: "ask_user_questions",
        sourceCommentId: null,
        wakeReason: "interaction_pending",
        source: "issue.interaction.created",
      },
    }).returning();

    const outcome = await createPostgresRunDispatchAdapter(db).cancelStaleQueuedRun({
      runId: run!.id,
      companyId,
      expectedStatus: "queued",
      now: new Date(),
    });

    expect(outcome).toMatchObject({ outcome: "cancelled", errorCode: "issue_assignee_changed" });
  });
});
