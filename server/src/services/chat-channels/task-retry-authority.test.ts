import { randomUUID } from "node:crypto";
import os from "node:os";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { agents, companies, createDb, environmentLeases, heartbeatRuns, type Db } from "@paperclipai/db";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "../../__tests__/helpers/embedded-postgres.js";
import { appendHeartbeatRunEvent } from "../heartbeat-run-events.js";
import { readProcessStartedAt } from "../hot-restart.js";
import { PROCESS_IDENTITY_RECORDED } from "../native-local-process-stop.js";
import { taskChatRetryExecutionStopped } from "./task-retry-authority.js";

// Above any pid the kernel hands out, so the server can neither signal nor see it.
const UNSEEN_PID = 2_000_000_106;

const support = await getEmbeddedPostgresTestSupport();
(support.supported ? describe : describe.skip)("stop proof for a task retry from chat", () => {
  let database: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;
  let db: Db;
  beforeAll(async () => { database = await startEmbeddedPostgresTestDatabase("paperclip-task-retry-authority-"); db = createDb(database.connectionString); }, 90_000);
  afterAll(async () => { await db?.$client.end({ timeout: 0 }); await database?.cleanup(); });
  afterEach(() => vi.restoreAllMocks());

  /** A failed run with the launch the host recorded for it. */
  async function failedRun(pid: number, startedAt: Date) {
    const companyId = randomUUID(), agentId = randomUUID();
    await db.insert(companies).values({ id: companyId, name: "Retry", issuePrefix: `T${companyId.slice(0, 7)}` });
    await db.insert(agents).values({ id: agentId, companyId, name: "Agent", adapterType: "process" });
    const [run] = await db.insert(heartbeatRuns).values({ companyId, agentId, status: "failed", runtimeMode: "legacy",
      processPid: pid, processGroupId: pid, processStartedAt: startedAt }).returning();
    await appendHeartbeatRunEvent(db, { companyId, runId: run!.id, agentId, eventType: PROCESS_IDENTITY_RECORDED,
      stream: "system", level: "info", payload: { targetKind: "local", hostname: os.hostname(), processPid: pid,
        processGroupId: pid, processStartedAt: startedAt.toISOString() } });
    return run!;
  }
  const answer = (code: "EPERM" | "EINVAL") =>
    vi.spyOn(process, "kill").mockImplementation(() => { throw Object.assign(new Error(code), { code }); });

  it.skipIf(process.platform === "win32")("takes a recorded process the server may neither signal nor see as stopped", async () => {
    const run = await failedRun(UNSEEN_PID, new Date("2026-01-01T00:00:00.000Z"));
    const kill = answer("EPERM");
    expect(await taskChatRetryExecutionStopped(db, run)).toBe(true);
    expect(kill).toHaveBeenCalledWith(UNSEEN_PID, 0);
    expect(kill).toHaveBeenCalledWith(-UNSEEN_PID, 0);
    kill.mockRestore();
    answer("EINVAL");
    expect(await taskChatRetryExecutionStopped(db, run)).toBe(false);
  });

  it.skipIf(process.platform !== "linux")("holds on a denied probe while the process still has the recorded start time", async () => {
    const run = await failedRun(process.pid, new Date((await readProcessStartedAt(process.pid))!));
    answer("EPERM");
    expect(await taskChatRetryExecutionStopped(db, run)).toBe(false);
  });

  it("leaves a run in a provider environment to the provider's receipt", async () => {
    const run = await failedRun(UNSEEN_PID, new Date("2026-01-01T00:00:00.000Z"));
    await db.insert(environmentLeases).values({ companyId: run.companyId, heartbeatRunId: run.id, provider: "fixture-sandbox",
      providerLeaseId: randomUUID(), status: "released", releasedAt: new Date(), cleanupStatus: "success" });
    const kill = answer("EPERM");
    expect(await taskChatRetryExecutionStopped(db, run)).toBe(false);
    expect(kill).not.toHaveBeenCalled();
  });
});
