import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { agents, companies, createDb, heartbeatRunEvents, heartbeatRuns, issues } from "@paperclipai/db";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "../../__tests__/helpers/embedded-postgres.js";
import { recordProcessIdentityWithLegacyCleanupIntent } from "./case-handoff-lifecycle.js";
import { persistHeartbeatRunProcessMetadata } from "./run-lifecycle.js";

const support = await getEmbeddedPostgresTestSupport();
const companyId = "31000000-0000-4000-8000-000000000001";
const agentId = "31000000-0000-4000-8000-000000000002";
const issueId = "31000000-0000-4000-8000-000000000003";
const runId = "31000000-0000-4000-8000-000000000004";
const controllerBootId = "31000000-0000-4000-8000-000000000005";
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

describe.skipIf(!support.supported)("spawn process identity and a reassignment Stop", () => {
  let temporary: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;
  let db: ReturnType<typeof createDb>;
  let other: ReturnType<typeof createDb>;

  beforeAll(async () => {
    temporary = await startEmbeddedPostgresTestDatabase("paperclip-process-identity-lock-order-");
    db = createDb(temporary.connectionString);
    other = createDb(temporary.connectionString);
    await db.insert(companies).values({ id: companyId, name: "Identity", issuePrefix: "PLO" });
    await db.insert(agents).values({ id: agentId, companyId, name: "Identity agent" });
    await db.insert(issues).values({ id: issueId, companyId, title: "Hand me over" });
    await db.insert(heartbeatRuns).values({ id: runId, companyId, agentId, issueId, scopeKind: "issue",
      status: "running", runtimeMode: "legacy", controllerBootId });
  });

  afterAll(async () => {
    await temporary?.cleanup();
  });

  // A reassignment Stop locks the issue and then the run. The spawn write
  // holds the run row when its second event re-checks the issue foreign key.
  it("does not deadlock with a transaction that locks the issue and then the run", async () => {
    let release!: () => void;
    const released = new Promise<void>((resolve) => { release = resolve; });
    let issueLocked!: () => void;
    const holdingIssue = new Promise<void>((resolve) => { issueLocked = resolve; });
    let lockRun!: () => void;
    const runLockRequested = new Promise<void>((resolve) => { lockRun = resolve; });
    const stop = other.transaction(async (tx) => {
      await tx.select({ id: issues.id }).from(issues).where(eq(issues.id, issueId)).for("update");
      issueLocked();
      await runLockRequested;
      await tx.select({ id: heartbeatRuns.id }).from(heartbeatRuns).where(eq(heartbeatRuns.id, runId)).for("update");
      await released;
    }).then(() => "committed" as const, (error: unknown) => ({ error }));
    await holdingIssue;
    const pid = 41_000 + Math.floor(Math.random() * 1000);
    const spawn = recordProcessIdentityWithLegacyCleanupIntent(db,
      { runId, issueId, controllerBootId, scratch: null },
      tx => persistHeartbeatRunProcessMetadata(tx, runId, {
        pid, processGroupId: null, startedAt: new Date().toISOString(), targetKind: "remote" }),
    ).then((run) => ({ run }), (error: unknown) => ({ error }));
    // Let the spawn write reach the lock it waits on before the Stop goes on.
    await sleep(300);
    lockRun();
    // PostgreSQL reports a deadlock after deadlock_timeout (one second).
    await sleep(1_500);
    release();
    expect(await stop).toBe("committed");
    const outcome = await spawn;
    expect(outcome).not.toHaveProperty("error");
    expect((outcome as { run: typeof heartbeatRuns.$inferSelect | null }).run).toMatchObject({ id: runId, processPid: pid });
    const events = await db.select({ eventType: heartbeatRunEvents.eventType }).from(heartbeatRunEvents)
      .where(eq(heartbeatRunEvents.runId, runId));
    expect(events.map(event => event.eventType)).toEqual(expect.arrayContaining([
      "native.process_identity_recorded", "legacy.case_handoff_cleanup_intent"]));
  }, 30_000);
});
