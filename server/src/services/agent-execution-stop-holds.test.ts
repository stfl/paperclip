import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { companies, createDb, heartbeatRuns, issues, nativeRunFinalizations, type Db } from "@paperclipai/db";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "../__tests__/helpers/embedded-postgres.js";
import { agentExecutionsHaveStopped } from "./agent-execution-stop.js";
import { readProcessStartedAt } from "./hot-restart.js";
import { createAgentLifecycle } from "./agent-lifecycle.js";

// Above any pid the kernel hands out, so only the probe below answers for them.
const RECORDED_PID = 2_000_000_101;
const CONTROLLER_PID = 2_000_000_102;

const support = await getEmbeddedPostgresTestSupport();
(support.supported ? describe : describe.skip)("agent execution stop holds", () => {
  let database: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;
  let db: Db;
  let companyId: string;
  beforeAll(async () => { database = await startEmbeddedPostgresTestDatabase("paperclip-agent-stop-holds-"); db = createDb(database.connectionString); }, 90_000);
  afterAll(async () => { await db?.$client.end({ timeout: 0 }); await database?.cleanup(); });
  beforeEach(async () => {
    companyId = randomUUID();
    await db.insert(companies).values({ id: companyId, name: "Stop holds", issuePrefix: `S${companyId.slice(0, 7)}` });
  });
  afterEach(() => vi.restoreAllMocks());

  async function hire() { return createAgentLifecycle(db).requestHire(companyId, { name: "Agent", status: "idle", adapterType: "process" }); }
  /** A cancelled native run whose expired finalization owner recorded `controller` as its pid. */
  async function abandonedFinalization(agentId: string, controller: Partial<typeof nativeRunFinalizations.$inferInsert>) {
    const at = new Date("2026-01-01T00:00:00.000Z");
    const [issue] = await db.insert(issues).values({ companyId, title: "Cancelled native run" }).returning();
    const [run] = await db.insert(heartbeatRuns).values({ companyId, agentId, status: "cancelled", invocationSource: "on_demand",
      runtimeMode: "native", nativeIssueId: issue!.id, startedAt: at, finishedAt: at, processPid: RECORDED_PID }).returning();
    await db.insert(nativeRunFinalizations).values({ companyId, issueId: issue!.id, runId: run!.id,
      phase: "executing", leaseOwner: "stopped-server", leaseExpiresAt: new Date(0), ...controller });
    return run!;
  }
  /** Answers signal-0 probes for the listed identifiers; every other call reaches the OS. */
  function probe(answers: Record<number, "ESRCH" | "EPERM" | "alive">) {
    const kill = process.kill.bind(process);
    return vi.spyOn(process, "kill").mockImplementation(((pid: number, signal?: string | number) => {
      const answer = signal === 0 ? answers[pid] : undefined;
      if (!answer) return kill(pid, signal);
      if (answer === "alive") return true;
      throw Object.assign(new Error(answer), { code: answer });
    }) as typeof process.kill);
  }

  it("releases an expired finalization owner whose controller pid belongs to another user's process", async () => {
    const agent = await hire();
    const run = await abandonedFinalization(agent.id, { controllerPid: CONTROLLER_PID });
    const kill = probe({ [RECORDED_PID]: "ESRCH", [CONTROLLER_PID]: "alive" });
    expect(await agentExecutionsHaveStopped(db, [agent.id])).toBe(false);
    kill.mockRestore();
    probe({ [RECORDED_PID]: "ESRCH", [CONTROLLER_PID]: "EPERM" });
    expect(await agentExecutionsHaveStopped(db, [agent.id])).toBe(true);
    expect((await db.select().from(nativeRunFinalizations).where(eq(nativeRunFinalizations.runId, run.id)))[0])
      .toMatchObject({ leaseOwner: null, leaseExpiresAt: null });
  });

  it.skipIf(process.platform !== "linux")("holds on a finalization controller the server may not signal while it has the recorded start time", async () => {
    const agent = await hire();
    const run = await abandonedFinalization(agent.id, { controllerPid: process.pid,
      controllerProcessStartedAt: new Date((await readProcessStartedAt(process.pid))!) });
    probe({ [RECORDED_PID]: "ESRCH", [process.pid]: "EPERM" });
    expect(await agentExecutionsHaveStopped(db, [agent.id])).toBe(false);
    await db.update(nativeRunFinalizations).set({ controllerProcessStartedAt: new Date(0) }).where(eq(nativeRunFinalizations.runId, run.id));
    expect(await agentExecutionsHaveStopped(db, [agent.id])).toBe(true);
  });
});
