import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { agents, companies, createDb, heartbeatRuns, type Db } from "@paperclipai/db";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "../__tests__/helpers/embedded-postgres.js";
import { appendHeartbeatRunEvent } from "./heartbeat-run-events.js";
import { readProcessStartedAt } from "./hot-restart.js";
import { readNativeLocalProcessStop, recordNativeLocalProcessStop } from "./native-local-process-stop.js";

const support = await getEmbeddedPostgresTestSupport();
(support.supported && process.platform === "linux" ? describe : describe.skip)("native local process stop receipt", () => {
  let database: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;
  let db: Db;
  beforeAll(async () => { database = await startEmbeddedPostgresTestDatabase("paperclip-native-local-stop-"); db = createDb(database.connectionString); }, 90_000);
  afterAll(async () => { await db?.$client.end({ timeout: 0 }); await database?.cleanup(); });
  afterEach(() => vi.restoreAllMocks());

  const answer = (code: "ESRCH" | "EPERM") =>
    vi.spyOn(process, "kill").mockImplementation(() => { throw Object.assign(new Error(code), { code }); });

  /** A native run that recorded this test process's number for a process born at `startedAt`. */
  async function nativeRun(startedAt: Date) {
    const companyId = randomUUID(), agentId = randomUUID();
    await db.insert(companies).values({ id: companyId, name: "Receipt", issuePrefix: `N${companyId.slice(0, 7)}` });
    await db.insert(agents).values({ id: agentId, companyId, name: "Agent", adapterType: "process" });
    const [run] = await db.insert(heartbeatRuns).values({ companyId, agentId, status: "failed", runtimeMode: "native",
      processPid: process.pid, processGroupId: process.pid, processStartedAt: startedAt }).returning();
    return run!;
  }

  it("keeps the start time, so a visible process that reused the number does not hold the receipt", async () => {
    const run = await nativeRun(new Date(0));
    const kill = answer("ESRCH");
    expect(await recordNativeLocalProcessStop(db, run)).toBe(true);
    kill.mockRestore();
    // The number now names this test process, which the probe may not signal.
    answer("EPERM");
    expect(await readNativeLocalProcessStop(db, run.companyId, run.id))
      .toEqual({ processPid: process.pid, processGroupId: process.pid });
  });

  it("holds on a visible process when the receipt has no start time to compare", async () => {
    const run = await nativeRun(new Date(0));
    await appendHeartbeatRunEvent(db, { companyId: run.companyId, runId: run.id, agentId: run.agentId,
      eventType: "native.local_process_stopped", stream: "system", level: "info",
      payload: { processPid: process.pid, processGroupId: process.pid } });
    answer("EPERM");
    expect(await readNativeLocalProcessStop(db, run.companyId, run.id)).toBeNull();
  });

  it("does not record a stop while the recorded process is alive under another user", async () => {
    const run = await nativeRun(new Date((await readProcessStartedAt(process.pid))!));
    answer("EPERM");
    expect(await recordNativeLocalProcessStop(db, run)).toBe(false);
    expect(await readNativeLocalProcessStop(db, run.companyId, run.id)).toBeNull();
  });
});
