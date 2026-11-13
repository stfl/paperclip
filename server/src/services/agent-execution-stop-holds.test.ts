import { randomUUID } from "node:crypto";
import { eq, sql } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { agents, caseHandoffs, cases, companies, createDb, heartbeatRuns, issues, nativeRunFinalizations, type Db } from "@paperclipai/db";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "../__tests__/helpers/embedded-postgres.js";
import { logger } from "../middleware/logger.js";
import { agentExecutionStopHold, agentExecutionsHaveStopped } from "./agent-execution-stop.js";
import { configureAgentLifecycle, createAgentLifecycle } from "./agent-lifecycle.js";
import { retireStoppedProcessIdentity } from "./heartbeat/process-settlement.js";
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
  afterAll(async () => { for (const worker of workers) await worker.stop(); await database?.cleanup(); });
  beforeEach(async () => {
    for (const worker of workers) await worker.stop();
    companyId = randomUUID();
    await db.insert(companies).values({ id: companyId, name: "Stop holds", issuePrefix: `S${companyId.slice(0, 7)}` });
  });
  afterEach(() => vi.restoreAllMocks());

  async function hire() { return createAgentLifecycle(db).requestHire(companyId, { name: "Agent", status: "idle", adapterType: "process" }); }
  async function current(id: string) { return (await db.select().from(agents).where(eq(agents.id, id)))[0]!; }
  async function runRow(id: string) { return (await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, id)))[0]!; }
  async function finishedRun(agentId: string, values: Partial<typeof heartbeatRuns.$inferInsert> = {}) {
    const at = new Date("2026-01-01T00:00:00.000Z");
    const [run] = await db.insert(heartbeatRuns).values({ companyId, agentId, status: "failed", invocationSource: "on_demand",
      runtimeMode: "legacy", startedAt: at, finishedAt: at, processPid: RECORDED_PID, processGroupId: RECORDED_PID,
      processStartedAt: at, ...values }).returning();
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

  it("does not hold on a finished run whose pid and group now belong to another user's process", async () => {
    const agent = await hire();
    const run = await finishedRun(agent.id);
    const kill = probe({ [RECORDED_PID]: "EPERM", [-RECORDED_PID]: "EPERM" });
    expect(await agentExecutionsHaveStopped(db, [agent.id])).toBe(true);
    expect(kill).toHaveBeenCalledWith(RECORDED_PID, 0);
    expect(kill).toHaveBeenCalledWith(-RECORDED_PID, 0);
    // A failed run keeps its identity: continuation reads a missing one as an unverified stop.
    expect(await runRow(run.id)).toMatchObject({ processPid: RECORDED_PID, processGroupId: RECORDED_PID });
  });

  it("does not hold on a finished run whose process no longer exists", async () => {
    const agent = await hire();
    await finishedRun(agent.id);
    probe({ [RECORDED_PID]: "ESRCH", [-RECORDED_PID]: "ESRCH" });
    expect(await agentExecutionsHaveStopped(db, [agent.id])).toBe(true);
  });

  it("holds while the server can signal the recorded process or its group", async () => {
    const agent = await hire();
    const run = await finishedRun(agent.id, { processPid: process.pid, processGroupId: null, processStartedAt: null });
    expect(await agentExecutionsHaveStopped(db, [agent.id])).toBe(false);
    expect(await agentExecutionStopHold(db, [agent.id])).toEqual({ clause: "process_alive", runId: run.id, agentId: agent.id });
    await db.update(heartbeatRuns).set({ processPid: RECORDED_PID, processGroupId: RECORDED_PID }).where(eq(heartbeatRuns.id, run.id));
    probe({ [RECORDED_PID]: "EPERM", [-RECORDED_PID]: "alive" });
    expect(await agentExecutionStopHold(db, [agent.id])).toMatchObject({ clause: "process_alive", runId: run.id });
  });

  it("holds on a probe failure that proves nothing", async () => {
    const agent = await hire();
    await finishedRun(agent.id);
    probe({ [RECORDED_PID]: "EINVAL", [-RECORDED_PID]: "ESRCH" });
    expect(await agentExecutionsHaveStopped(db, [agent.id])).toBe(false);
  });

  it("releases an expired finalization owner whose controller pid belongs to another user's process", async () => {
    const agent = await hire();
    const [issue] = await db.insert(issues).values({ companyId, title: "Cancelled native run" }).returning();
    const run = await finishedRun(agent.id, { status: "cancelled", runtimeMode: "native", nativeIssueId: issue!.id,
      processGroupId: null, processStartedAt: null });
    await db.insert(nativeRunFinalizations).values({ companyId, issueId: issue!.id, runId: run.id,
      phase: "executing", leaseOwner: "stopped-server", leaseExpiresAt: new Date(0), controllerPid: CONTROLLER_PID });
    const kill = probe({ [RECORDED_PID]: "ESRCH", [CONTROLLER_PID]: "alive" });
    expect(await agentExecutionStopHold(db, [agent.id])).toMatchObject({ clause: "finalization_controller_alive", runId: run.id });
    kill.mockRestore();
    probe({ [RECORDED_PID]: "ESRCH", [CONTROLLER_PID]: "EPERM" });
    expect(await agentExecutionsHaveStopped(db, [agent.id])).toBe(true);
    expect((await db.select().from(nativeRunFinalizations).where(eq(nativeRunFinalizations.runId, run.id)))[0])
      .toMatchObject({ leaseOwner: null, leaseExpiresAt: null });
  });

  it("retires the process identity of a succeeded legacy run once it is proven gone, and of no other run", async () => {
    const agent = await hire();
    const succeeded = await finishedRun(agent.id, { status: "succeeded" });
    const failed = await finishedRun(agent.id, { status: "failed" });
    const cancelled = await finishedRun(agent.id, { status: "cancelled" });
    const native = await finishedRun(agent.id, { status: "succeeded", runtimeMode: "native" });
    probe({ [RECORDED_PID]: "EPERM", [-RECORDED_PID]: "ESRCH" });
    expect(await agentExecutionsHaveStopped(db, [agent.id])).toBe(true);
    expect(await runRow(succeeded.id)).toMatchObject({ processPid: null, processGroupId: null, processStartedAt: null,
      updatedAt: succeeded.updatedAt });
    for (const kept of [failed, cancelled, native]) {
      expect(await runRow(kept.id)).toMatchObject({ processPid: RECORDED_PID, processGroupId: RECORDED_PID,
        processStartedAt: kept.processStartedAt });
    }
    // With the number gone from the row, a later process that reuses it cannot hold the agent.
    probe({ [RECORDED_PID]: "alive", [-RECORDED_PID]: "alive" });
    await db.delete(heartbeatRuns).where(sql`${heartbeatRuns.id} in (${failed.id}, ${cancelled.id}, ${native.id})`);
    expect(await agentExecutionsHaveStopped(db, [agent.id])).toBe(true);
  });

  it("keeps the identity of a succeeded run that may still be running", async () => {
    const agent = await hire();
    const run = await finishedRun(agent.id, { status: "succeeded" });
    probe({ [RECORDED_PID]: "ESRCH", [-RECORDED_PID]: "alive" });
    expect(await agentExecutionsHaveStopped(db, [agent.id])).toBe(false);
    expect(await runRow(run.id)).toMatchObject({ processPid: RECORDED_PID, processGroupId: RECORDED_PID });
  });

  it("retires only the identity the caller read, and none that a pending case handoff still binds", async () => {
    const agent = await hire();
    const run = await finishedRun(agent.id, { status: "succeeded" });
    expect(await retireStoppedProcessIdentity(db, { ...run, processPid: RECORDED_PID + 1 })).toBe(false);
    expect(await runRow(run.id)).toMatchObject({ processPid: RECORDED_PID });

    const [issue] = await db.insert(issues).values({ companyId, title: "Handed off" }).returning();
    const [workflow] = await db.insert(cases).values({ companyId, caseNumber: 1, identifier: `C-${companyId.slice(0, 8)}`,
      caseType: "work", title: "Handed off" }).returning();
    const [handoff] = await db.insert(caseHandoffs).values({ companyId, caseId: workflow!.id, issueId: issue!.id, version: 1,
      fromAgentId: agent.id, toAgentId: agent.id, phase: "implementation", instructions: "Continue", actorType: "agent",
      actorId: agent.id, sourceRunId: run.id, wakeupRequestId: randomUUID(), idempotencyKey: randomUUID(),
      inputFingerprint: "fixture", state: "awaiting_release" }).returning();
    expect(await retireStoppedProcessIdentity(db, run)).toBe(false);
    expect(await runRow(run.id)).toMatchObject({ processPid: RECORDED_PID, processGroupId: RECORDED_PID });

    await db.update(caseHandoffs).set({ state: "cancelled" }).where(eq(caseHandoffs.id, handoff!.id));
    expect(await retireStoppedProcessIdentity(db, run)).toBe(true);
    expect(await runRow(run.id)).toMatchObject({ processPid: null, processGroupId: null, processStartedAt: null });
    expect(await retireStoppedProcessIdentity(db, await runRow(run.id))).toBe(false);
  });

  it("logs a hold when it starts, when its cause changes, and then only at a slow interval", async () => {
    const agent = await hire();
    const run = await finishedRun(agent.id, { processPid: process.pid, processGroupId: null, processStartedAt: null });
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

  it("shows why a pause keeps waiting, retries at the slower pace, and clears the error once it completes", async () => {
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
    expect(overdue.lifecycleState).toBe("pausing");
    expect(overdue.lifecycleError).toContain("Stopping agent execution is still waiting");
    expect(overdue.lifecycleError).toContain("(process_alive)");
    expect(overdue.lifecycleOperation).toMatchObject({ hostComplete: false });
    expect(Date.parse(overdue.lifecycleOperation!.retryAt!) - Date.now()).toBeGreaterThan(30_000);

    host = "complete";
    await due();
    await worker.process(agent.id);
    expect(await current(agent.id)).toMatchObject({ lifecycleState: "paused", lifecycleError: null });
  });
});
