import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { companies, createDb, environmentLeases, heartbeatRuns, issues, nativeRunFinalizations, type Db } from "@paperclipai/db";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "../__tests__/helpers/embedded-postgres.js";
import { logger } from "../middleware/logger.js";
import { agentExecutionStopHold, agentExecutionsHaveStopped, noteAgentExecutionStopHold,
  rememberedAgentExecutionStopHolds } from "./agent-execution-stop.js";
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

  async function finishedRun(agentId: string, values: Partial<typeof heartbeatRuns.$inferInsert> = {}) {
    const at = new Date("2026-01-01T00:00:00.000Z");
    const [run] = await db.insert(heartbeatRuns).values({ companyId, agentId, status: "failed", invocationSource: "on_demand",
      runtimeMode: "legacy", startedAt: at, finishedAt: at, processPid: process.pid, ...values }).returning();
    return run!;
  }

  it("logs a hold when it starts, when its cause changes, and then only at a slow interval", async () => {
    const agent = await hire();
    const run = await finishedRun(agent.id);
    const info = vi.spyOn(logger, "info").mockImplementation(() => undefined);
    const waits = () => info.mock.calls.filter(call => call[1] === "Agent execution stop is waiting").map(call => call[0]);
    for (let check = 0; check < 5; check++) await agentExecutionStopHold(db, [agent.id]);
    expect(waits()).toEqual([{ agentIds: [agent.id], clause: "process_alive", runId: run.id, agentId: agent.id }]);

    await db.update(heartbeatRuns).set({ status: "running" }).where(eq(heartbeatRuns.id, run.id));
    for (let check = 0; check < 5; check++) await agentExecutionStopHold(db, [agent.id]);
    expect(waits().map(entry => (entry as { clause: string }).clause)).toEqual(["process_alive", "run_active"]);

    const later = Date.now() + 61_000;
    vi.spyOn(Date, "now").mockReturnValue(later);
    for (let check = 0; check < 5; check++) await agentExecutionStopHold(db, [agent.id]);
    expect(waits().map(entry => (entry as { clause: string }).clause)).toEqual(["process_alive", "run_active", "run_active"]);
  });

  it("names the same hold on every check while several runs hold", async () => {
    const agent = await hire();
    const at = (second: number) => new Date(Date.UTC(2026, 0, 1, 0, 0, second));
    const runs = [];
    for (const second of [3, 1, 2]) {
      runs.push(await finishedRun(agent.id, { status: "running", processPid: null, createdAt: at(second) }));
    }
    const info = vi.spyOn(logger, "info").mockImplementation(() => undefined);
    for (let check = 0; check < 8; check++) {
      expect(await agentExecutionStopHold(db, [agent.id])).toMatchObject({ clause: "run_active", runId: runs[1]!.id });
    }
    expect(info.mock.calls.filter(call => call[1] === "Agent execution stop is waiting")).toHaveLength(1);
  });

  it("names an unreleased lease and an unconfirmed provider stop", async () => {
    const agent = await hire();
    const run = await finishedRun(agent.id, { status: "cancelled", runtimeMode: "native", processPid: null });
    const [lease] = await db.insert(environmentLeases).values({ companyId, heartbeatRunId: run.id, provider: "fixture-sandbox",
      providerLeaseId: randomUUID(), status: "active" }).returning();
    expect(await agentExecutionStopHold(db, [agent.id])).toEqual({ clause: "lease_unreleased", leaseId: lease!.id,
      runId: run.id, agentId: agent.id });
    await db.update(environmentLeases).set({ status: "released", releasedAt: new Date(), cleanupStatus: "success" })
      .where(eq(environmentLeases.id, lease!.id));
    expect(await agentExecutionStopHold(db, [agent.id])).toEqual({ clause: "remote_stop_unconfirmed", runId: run.id, agentId: agent.id });
  });

  it("forgets the hold of a stop that is no longer checked", () => {
    vi.spyOn(logger, "info").mockImplementation(() => undefined);
    const now = Date.now();
    const clock = vi.spyOn(Date, "now").mockReturnValue(now + 60 * 60_000);
    const abandoned = [randomUUID()], checked = [randomUUID()];
    noteAgentExecutionStopHold(abandoned, { clause: "run_active" });
    noteAgentExecutionStopHold(checked, { clause: "run_active" });
    expect(rememberedAgentExecutionStopHolds()).toBe(2);
    clock.mockReturnValue(now + 64 * 60_000);
    noteAgentExecutionStopHold(checked, { clause: "run_active" });
    expect(rememberedAgentExecutionStopHolds()).toBe(2);
    clock.mockReturnValue(now + 68 * 60_000);
    noteAgentExecutionStopHold(checked, { clause: "run_active" });
    expect(rememberedAgentExecutionStopHolds()).toBe(1);
    noteAgentExecutionStopHold(checked, null);
    expect(rememberedAgentExecutionStopHolds()).toBe(0);
  });

  it("releases an expired finalization owner whose controller pid belongs to another user's process", async () => {
    const agent = await hire();
    const run = await abandonedFinalization(agent.id, { controllerPid: CONTROLLER_PID });
    const kill = probe({ [RECORDED_PID]: "ESRCH", [CONTROLLER_PID]: "alive" });
    expect(await agentExecutionStopHold(db, [agent.id])).toMatchObject({ clause: "finalization_controller_alive", runId: run.id });
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
    expect(await agentExecutionStopHold(db, [agent.id])).toMatchObject({ clause: "finalization_controller_alive", runId: run.id });
    await db.update(nativeRunFinalizations).set({ controllerProcessStartedAt: new Date(0) }).where(eq(nativeRunFinalizations.runId, run.id));
    expect(await agentExecutionsHaveStopped(db, [agent.id])).toBe(true);
  });
});
