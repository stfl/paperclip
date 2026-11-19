import { randomUUID } from "node:crypto";
import { eq, sql } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { agents, companies, createDb, environmentLeases, heartbeatRuns, issues, nativeRunFinalizations, type Db } from "@paperclipai/db";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "../__tests__/helpers/embedded-postgres.js";
import { logger } from "../middleware/logger.js";
import { AGENT_EXECUTION_STOP_HOLD_CLAUSES, agentExecutionStopHold, agentExecutionsHaveStopped, noteAgentExecutionStopHold,
  rememberedAgentExecutionStopHolds } from "./agent-execution-stop.js";
import { agentService } from "./agents.js";
import { readProcessStartedAt } from "./hot-restart.js";
import { configureAgentLifecycle, createAgentLifecycle } from "./agent-lifecycle.js";
import { lifecycleWaitMessage } from "../modules/agent-lifecycle/application/failure.js";
import type { LifecycleHostResult } from "../modules/agent-lifecycle/application/ports.js";
import { isLifecycleWaitOverdue } from "../modules/agent-lifecycle/domain/policy.js";

// Above any pid the kernel hands out, so only the probe below answers for them.
const RECORDED_PID = 2_000_000_101;
const CONTROLLER_PID = 2_000_000_102;

const support = await getEmbeddedPostgresTestSupport();
(support.supported ? describe : describe.skip)("agent execution stop holds", () => {
  let database: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;
  let db: Db;
  let companyId: string;
  const workers: ReturnType<typeof configureAgentLifecycle>[] = [];
  beforeAll(async () => { database = await startEmbeddedPostgresTestDatabase("paperclip-agent-stop-holds-"); db = createDb(database.connectionString); }, 90_000);
  afterAll(async () => {
    for (const worker of workers) await worker.stop();
    await db?.$client.end({ timeout: 0 }); await database?.cleanup();
  });
  beforeEach(async () => {
    for (const worker of workers) await worker.stop();
    companyId = randomUUID();
    await db.insert(companies).values({ id: companyId, name: "Stop holds", issuePrefix: `S${companyId.slice(0, 7)}` });
  });
  afterEach(() => vi.restoreAllMocks());

  async function hire() { return createAgentLifecycle(db).requestHire(companyId, { name: "Agent", status: "idle", adapterType: "process" }); }
  async function current(id: string) { return (await db.select().from(agents).where(eq(agents.id, id)))[0]!; }
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
  function probe(answers: Record<number, "ESRCH" | "EPERM" | "EINVAL" | "alive">) {
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

  /** A finished legacy run of this host, as an agent keeps from before it moved to a provider environment. */
  const legacyRun = (agentId: string, values: Partial<typeof heartbeatRuns.$inferInsert> = {}) => finishedRun(agentId, {
    processPid: RECORDED_PID, processGroupId: RECORDED_PID, processStartedAt: new Date("2026-01-01T00:00:00.000Z"), ...values });

  it("does not hold on an earlier legacy run whose pid and group now belong to another user's process", async () => {
    const agent = await hire();
    const run = await legacyRun(agent.id);
    const kill = probe({ [RECORDED_PID]: "EPERM", [-RECORDED_PID]: "EPERM" });
    expect(await agentExecutionsHaveStopped(db, [agent.id])).toBe(true);
    expect(kill).toHaveBeenCalledWith(RECORDED_PID, 0);
    expect(kill).toHaveBeenCalledWith(-RECORDED_PID, 0);
    // The run keeps its identity as stop evidence.
    expect((await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, run.id)))[0])
      .toMatchObject({ processPid: RECORDED_PID, processGroupId: RECORDED_PID });
  });

  it("does not hold on an earlier legacy run whose process no longer exists", async () => {
    const agent = await hire();
    await legacyRun(agent.id);
    probe({ [RECORDED_PID]: "ESRCH", [-RECORDED_PID]: "ESRCH" });
    expect(await agentExecutionsHaveStopped(db, [agent.id])).toBe(true);
  });

  it("holds while the server can signal the recorded process or its group, and on a failure that proves nothing", async () => {
    const agent = await hire();
    const run = await legacyRun(agent.id);
    probe({ [RECORDED_PID]: "EPERM", [-RECORDED_PID]: "alive" });
    expect(await agentExecutionStopHold(db, [agent.id])).toMatchObject({ clause: "process_alive", runId: run.id });
    vi.restoreAllMocks();
    probe({ [RECORDED_PID]: "EINVAL", [-RECORDED_PID]: "ESRCH" });
    expect(await agentExecutionsHaveStopped(db, [agent.id])).toBe(false);
  });

  it.skipIf(process.platform !== "linux")("holds on a process the server may not signal while it has the recorded start time", async () => {
    const agent = await hire();
    const startedAt = new Date((await readProcessStartedAt(process.pid))!);
    const run = await legacyRun(agent.id, { processPid: process.pid, processGroupId: process.pid, processStartedAt: startedAt });
    probe({ [process.pid]: "EPERM", [-process.pid]: "EPERM" });
    expect(await agentExecutionStopHold(db, [agent.id])).toMatchObject({ clause: "process_alive", runId: run.id });
    // Another start time says the number was reused.
    await db.update(heartbeatRuns).set({ processStartedAt: new Date(0) }).where(eq(heartbeatRuns.id, run.id));
    expect(await agentExecutionsHaveStopped(db, [agent.id])).toBe(true);
    // A group that the recorded process does not lead has no recorded start time to compare.
    await db.update(heartbeatRuns).set({ processPid: RECORDED_PID }).where(eq(heartbeatRuns.id, run.id));
    probe({ [RECORDED_PID]: "ESRCH", [-process.pid]: "EPERM" });
    expect(await agentExecutionStopHold(db, [agent.id])).toMatchObject({ clause: "process_alive", runId: run.id });
  });

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

  it("shows why a pause keeps waiting, retries at the slower pace, and clears the wait once it completes", async () => {
    let host: LifecycleHostResult = { pending: "process_alive" };
    const worker = configureAgentLifecycle(db, { requiredPluginIds: async () => [], runPlugin: async () => "complete", runHost: async () => host });
    workers.push(worker);
    const agent = await hire();
    await createAgentLifecycle(db).pauseAgent(agent.id);
    await worker.process(agent.id);
    const young = await current(agent.id);
    expect(young).toMatchObject({ lifecycleState: "pausing", lifecycleError: null });
    expect(Date.parse(young.lifecycleOperation!.retryAt!) - Date.now()).toBeLessThan(10_000);

    let attempts = 1;
    while (!isLifecycleWaitOverdue(attempts + 1)) attempts++;
    const due = () => db.update(agents).set({ lifecycleOperation: sql`${agents.lifecycleOperation} - 'retryAt'
      || jsonb_build_object('attempts', ${attempts}::integer)` }).where(eq(agents.id, agent.id));
    await due();
    await worker.process(agent.id);
    const overdue = await current(agent.id);
    // A wait is not a failure: the agent carries it apart from lifecycleError.
    expect(overdue).toMatchObject({ lifecycleState: "pausing", lifecycleError: null });
    expect(overdue.lifecycleOperation!.wait).toContain("Stopping agent execution is still waiting");
    expect(overdue.lifecycleOperation!.wait).toContain("(process_alive)");
    expect(overdue.lifecycleOperation).toMatchObject({ hostComplete: false });
    expect((await agentService(db).getById(agent.id))!.lifecycleWait).toBe(overdue.lifecycleOperation!.wait);
    expect(Date.parse(overdue.lifecycleOperation!.retryAt!) - Date.now()).toBeGreaterThan(30_000);

    host = "complete";
    await due();
    await worker.process(agent.id);
    expect(await current(agent.id)).toMatchObject({ lifecycleState: "paused", lifecycleError: null });
    expect((await agentService(db).getById(agent.id))!.lifecycleWait).toBeNull();
  });

  it("has a message for every check a stop can wait on", () => {
    for (const clause of AGENT_EXECUTION_STOP_HOLD_CLAUSES) {
      expect(lifecycleWaitMessage({ stage: "host", phase: "pausing" }, clause)).toContain(`(${clause})`);
    }
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
