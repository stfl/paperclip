import { randomUUID } from "node:crypto";
import { agents, companies, createDb, heartbeatRuns, issueRecoveryActions, issues } from "@paperclipai/db";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "../__tests__/helpers/embedded-postgres.js";
import { getExecutionBlocker } from "./execution-blocker.js";
import { EXECUTION_FINALIZATION_DEADLINE_MESSAGE } from "./execution-control-deadline.js";

const support = await getEmbeddedPostgresTestSupport();
describe.skipIf(!support.supported)("execution blocker PostgreSQL read projection", () => {
  let database: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;
  let db: ReturnType<typeof createDb>;
  beforeAll(async () => {
    database = await startEmbeddedPostgresTestDatabase("execution-blocker-read-");
    db = createDb(database.connectionString);
  }, 60_000);
  afterAll(async () => { await db?.$client.end(); await database?.cleanup(); });

  it("shows plain wording for a finalization deadline saved by the previous release", async () => {
    const previousReleaseText = "Inspect the failed run and verify its provider has stopped. Reconcile any uncertain external action before explicitly continuing this task.";
    const companyId = randomUUID(), agentId = randomUUID(), issueId = randomUUID();
    await db.insert(companies).values({ id: companyId, name: "Blocker fixture", issuePrefix: companyId.slice(0, 8) });
    await db.insert(agents).values({ id: agentId, companyId, name: "Blocker agent", adapterType: "process", status: "active" });
    await db.insert(issues).values({ id: issueId, companyId, title: "Blocker task", status: "blocked", assigneeAgentId: agentId });
    const [run] = await db.insert(heartbeatRuns).values({ companyId, agentId, status: "failed", runtimeMode: "native",
      startedAt: new Date("2020-01-01T00:00:00Z"), finishedAt: new Date("2020-01-01T00:01:00Z"),
      errorCode: "execution_finalization_deadline_exceeded", error: previousReleaseText, nextAction: previousReleaseText,
      contextSnapshot: { issueId },
    }).returning();
    await db.insert(issueRecoveryActions).values({ companyId, sourceIssueId: issueId, kind: "active_run_watchdog",
      cause: "execution_finalization_deadline_exceeded", ownerType: "board", fingerprint: run.id, status: "active",
      nextAction: previousReleaseText, evidence: { runId: run.id } });

    const blocker = await getExecutionBlocker(db, companyId, issueId);

    expect(blocker?.runError).toBe(EXECUTION_FINALIZATION_DEADLINE_MESSAGE);
    expect(blocker?.nextAction.startsWith(EXECUTION_FINALIZATION_DEADLINE_MESSAGE)).toBe(true);
    expect(JSON.stringify(blocker)).not.toMatch(/Inspect the failed run|verify its provider|Reconcile any uncertain/);
  });
});
