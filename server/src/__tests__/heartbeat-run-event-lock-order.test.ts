import { randomUUID } from "node:crypto";
import { eq, sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  activityLog,
  agents,
  companies,
  createDb,
  heartbeatRunEvents,
  heartbeatRuns,
} from "@paperclipai/db";
import { appendHeartbeatRunEvent } from "../services/heartbeat-run-events.js";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

describeEmbeddedPostgres("run event append beside an agent row writer", () => {
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;
  let db: ReturnType<typeof createDb>;
  let saverDb: ReturnType<typeof createDb>;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-run-event-lock-order-");
    db = createDb(tempDb.connectionString);
    saverDb = createDb(tempDb.connectionString);
  }, 30_000);

  afterAll(async () => {
    await tempDb.cleanup();
  });

  async function lockWaiters() {
    const result = await db.execute(sql`
      select count(*)::int as waiting from pg_stat_activity
      where datname = current_database() and wait_event_type = 'Lock'
    `);
    const rows = (result as unknown as { rows?: Array<{ waiting: number }> }).rows ??
      (result as unknown as Array<{ waiting: number }>);
    return Number(rows[0]?.waiting ?? 0);
  }

  it("commits both when an agent file save holds the agent row and then writes against the run", async () => {
    const companyId = randomUUID();
    const agentId = randomUUID();
    const runId = randomUUID();
    await db.insert(companies).values({ id: companyId, name: "Lock order", issuePrefix: `L${companyId.slice(0, 6)}` });
    await db.insert(agents).values({ id: agentId, companyId, name: "Reviewer" });
    await db.insert(heartbeatRuns).values({ id: runId, companyId, agentId, status: "cancelled" });

    let agentLocked!: () => void;
    const agentLockedSignal = new Promise<void>((resolve) => { agentLocked = resolve; });
    let saveMayWrite!: () => void;
    const saveWriteSignal = new Promise<void>((resolve) => { saveMayWrite = resolve; });

    // The shape of agentFileStore's locked write: the agent row FOR UPDATE,
    // then an activity row whose run_id references the run.
    const save = saverDb.transaction(async (tx) => {
      await tx.select({ id: agents.id }).from(agents).where(eq(agents.id, agentId)).for("update");
      agentLocked();
      await saveWriteSignal;
      await tx.insert(activityLog).values({
        companyId, actorType: "agent", actorId: agentId, agentId, runId,
        action: "agent.files_updated", entityType: "agent", entityId: agentId,
      });
    });
    await agentLockedSignal;

    const append = appendHeartbeatRunEvent(db, {
      companyId, agentId, runId, eventType: "lifecycle", stream: "system", level: "warn",
      message: "run cancelled before issue reassignment",
    });
    const deadline = Date.now() + 10_000;
    while ((await lockWaiters()) < 1) {
      if (Date.now() > deadline) throw new Error("the event append never waited on the agent row");
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    saveMayWrite();

    const outcomes = await Promise.allSettled([save, append]);
    expect(outcomes.map((outcome) =>
      outcome.status === "rejected" ? String((outcome.reason as Error)?.message ?? outcome.reason) : "fulfilled"))
      .toEqual(["fulfilled", "fulfilled"]);
    expect(await db.select().from(heartbeatRunEvents).where(eq(heartbeatRunEvents.runId, runId)))
      .toHaveLength(1);
    expect(await db.select().from(activityLog).where(eq(activityLog.runId, runId)))
      .toHaveLength(1);
  }, 30_000);
});
