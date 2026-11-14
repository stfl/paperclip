import { randomUUID } from "node:crypto";
import express from "express";
import request from "supertest";
import { and, eq, inArray, sql } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import {
  agentWakeupRequests,
  agents,
  companies,
  companyMemberships,
  createDb,
  executionWorkspaces,
  heartbeatRuns,
  issueRecoveryActions,
  issueRelations,
  issues,
  nativeRunFinalizations,
  projects,
  workspaceOperations,
} from "@paperclipai/db";
import { errorHandler } from "../middleware/index.js";
import { issueRoutes } from "../routes/issues.js";
import { getExecutionBlocker } from "../services/execution-blocker.js";
import { executionWorkspaceService } from "../services/execution-workspaces.js";
import { instanceSettingsService } from "../services/instance-settings.js";
import { issueService } from "../services/issues.js";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";

// The runs here have no provider process. A Stop of a live native session is
// dispatched to that session and its receipt says so; without a session the
// receipt reads `dispatched: false` and the Stop counts as unverified. This
// wrapper stands in for the live session: it marks the receipt dispatched.
const liveSessionDb = vi.hoisted(() => ({ current: null as unknown }));
vi.mock("../services/native-runtime/native-session-executor.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../services/native-runtime/native-session-executor.js")>();
  const { heartbeatRuns: runs } = await import("@paperclipai/db");
  const { eq: equals, sql: raw } = await import("drizzle-orm");
  return {
    ...actual,
    cancelNativeSession: async (...args: Parameters<typeof actual.cancelNativeSession>) => {
      const result = await actual.cancelNativeSession(...args);
      const db = liveSessionDb.current as ReturnType<typeof createDb> | null;
      if (db && args[2]) {
        await db.update(runs).set({
          resultJson: raw`jsonb_set(${runs.resultJson}, '{nativeCancellation,dispatched}', 'true'::jsonb)`,
        }).where(equals(runs.id, args[0]));
      }
      return result && typeof result === "object" ? { ...result, dispatched: true } : result;
    },
  };
});

const support = await getEmbeddedPostgresTestSupport();
const nextSettings = { mode: "isolated_workspace" as const,
  workspaceStrategy: { type: "git_worktree" as const, baseRef: "origin/feature/x" } };

describe.skipIf(!support.supported)("a native run hands its own task over and gets it back", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;
  let isolatedWorkspacesEnabled = false;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-own-run-handover-");
    db = createDb(tempDb.connectionString);
    liveSessionDb.current = db;
    isolatedWorkspacesEnabled = (await instanceSettingsService(db).getExperimental()).enableIsolatedWorkspaces;
    await instanceSettingsService(db).updateExperimental({ enableIsolatedWorkspaces: true });
  }, 30_000);

  afterEach(async () => {
    await db.execute(sql`TRUNCATE TABLE companies CASCADE`);
  });

  afterAll(async () => {
    await instanceSettingsService(db).updateExperimental({ enableIsolatedWorkspaces: isolatedWorkspacesEnabled });
    await tempDb?.cleanup();
  });

  function appFor(companyId: string, agentId: string, runId: string) {
    const testApp = express();
    testApp.use(express.json());
    testApp.use((req, _res, next) => {
      (req as any).actor = { type: "agent", agentId, companyId, runId, source: "agent_jwt" };
      next();
    });
    testApp.use("/api", issueRoutes(db, {} as any, {}));
    testApp.use(errorHandler);
    return testApp;
  }

  /** The row shape a dispatched native run has while its provider turn runs. */
  async function runningNativeRun(input: { companyId: string; agentId: string; issueId: string; runId?: string }) {
    const runId = input.runId ?? randomUUID();
    const values = { companyId: input.companyId, agentId: input.agentId, status: "running", runtimeMode: "native",
      nativeIssueId: input.issueId, invocationSource: "assignment" as const, startedAt: new Date(),
      contextSnapshot: { issueId: input.issueId } };
    if (input.runId) await db.update(heartbeatRuns).set(values).where(eq(heartbeatRuns.id, runId));
    else await db.insert(heartbeatRuns).values({ id: runId, ...values });
    await db.insert(nativeRunFinalizations).values({ runId, companyId: input.companyId, issueId: input.issueId, phase: "observed" });
    await db.update(issues).set({ status: "in_progress", executionRunId: runId, checkoutRunId: runId })
      .where(eq(issues.id, input.issueId));
    return runId;
  }

  /** What the stopped run's executor and finalizer leave behind: a cancelled
   * coordinator, a failed finalize, and the saved-work recovery of the run. */
  async function settleStoppedRun(input: { companyId: string; issueId: string; workspaceId: string; runId: string }) {
    await db.update(nativeRunFinalizations).set({ phase: "terminal_failure", failureCode: "native_retry_cancelled",
      leaseOwner: null, leaseExpiresAt: null, nextAttemptAt: null }).where(eq(nativeRunFinalizations.runId, input.runId));
    const operation = { companyId: input.companyId, issueId: input.issueId, heartbeatRunId: input.runId };
    await db.insert(workspaceOperations).values({ ...operation, executionWorkspaceId: input.workspaceId,
      phase: "workspace_finalize", status: "failed", finishedAt: new Date() });
    await db.insert(workspaceOperations).values({ ...operation, executionWorkspaceId: input.workspaceId,
      phase: "workspace_recovery", status: "succeeded", finishedAt: new Date() });
    await db.insert(workspaceOperations).values({ ...operation, phase: "workspace_finalize", status: "succeeded",
      finishedAt: new Date(), metadata: { owningService: "workspace_recovery" } });
  }

  async function seed() {
    const companyId = randomUUID(), taskId = randomUUID(), dependentId = randomUUID(), workspaceId = randomUUID();
    await db.insert(companies).values({ id: companyId, name: "Hand-over", issuePrefix: `H${companyId.slice(0, 6)}`,
      requireBoardApprovalForNewAgents: false });
    const [project] = await db.insert(projects).values({ companyId, name: "Repository" }).returning();
    const agent = (name: string) => ({ companyId, name, role: "engineer", status: "idle", adapterType: "paperclip_runner",
      adapterConfig: {}, runtimeConfig: { heartbeat: { maxConcurrentRuns: 1 } }, permissions: { canAssignTasks: true } });
    const [a, b, c] = await db.insert(agents).values([agent("Agent A"), agent("Agent B"), agent("Agent C")]).returning();
    await db.insert(companyMemberships).values([a, b, c].map(row => ({ companyId, principalType: "agent" as const,
      principalId: row.id, status: "active" as const, membershipRole: "member" as const })));
    await db.insert(companyMemberships).values({ companyId, principalType: "user", principalId: "owner", status: "active", membershipRole: "owner" });
    await db.insert(issues).values([
      { id: taskId, companyId, projectId: project.id, title: "Handed-over task", status: "in_progress", priority: "medium", assigneeAgentId: a.id, createdByUserId: "owner", responsibleUserId: "owner" },
      { id: dependentId, companyId, projectId: project.id, title: "Dependent task", status: "blocked", priority: "medium", assigneeAgentId: c.id, createdByUserId: "owner", responsibleUserId: "owner" },
    ]);
    await db.insert(issueRelations).values({ companyId, issueId: taskId, relatedIssueId: dependentId, type: "blocks" });
    await db.insert(executionWorkspaces).values({ id: workspaceId, companyId, projectId: null, sourceIssueId: taskId,
      mode: "shared_workspace", strategyType: "project_primary", name: "Task files", cwd: `/tmp/task-${taskId}` });
    await executionWorkspaceService(db).bindTaskWorkspace(companyId, taskId, workspaceId);
    // Each agent already runs another task, so a wake for the handed-over task
    // is admitted as a queued run and no provider is started for it.
    for (const row of [a, b, c]) {
      const [other] = await db.insert(issues).values({ companyId, title: `Other work of ${row.name}`, status: "in_progress",
        priority: "medium", assigneeAgentId: row.id }).returning();
      await db.insert(heartbeatRuns).values({ companyId, agentId: row.id, status: "running", runtimeMode: "native",
        nativeIssueId: other.id, invocationSource: "assignment", startedAt: new Date(), contextSnapshot: { issueId: other.id } });
    }
    return { companyId, taskId, dependentId, workspaceId, a, b, c };
  }

  const runOf = async (runId: string) => (await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, runId)))[0]!;
  const taskOf = async (issueId: string) => (await db.select().from(issues).where(eq(issues.id, issueId)))[0]!;
  const wakesFor = (companyId: string, agentId: string, issueId: string) => db.select().from(agentWakeupRequests).where(and(
    eq(agentWakeupRequests.companyId, companyId), eq(agentWakeupRequests.agentId, agentId),
    sql`${agentWakeupRequests.payload}->>'issueId' = ${issueId}`));

  async function expectHandedOver(f: Awaited<ReturnType<typeof seed>>, stoppedRunId: string, to: { id: string }) {
    expect(await runOf(stoppedRunId)).toMatchObject({ status: "cancelled", errorCode: "issue_reassigned" });
    expect(await taskOf(f.taskId)).toMatchObject({ assigneeAgentId: to.id, executionRunId: null });
    expect(await db.select().from(issueRecoveryActions).where(eq(issueRecoveryActions.companyId, f.companyId))).toEqual([]);
    // The route sends the new assignee's wake after it answers.
    const wake = await vi.waitFor(async () => {
      const wakes = await wakesFor(f.companyId, to.id, f.taskId);
      expect(wakes.map(row => row.status)).toEqual(["queued"]);
      return wakes[0]!;
    }, { timeout: 10_000, interval: 100 });
    expect(wake.runId).toBeTruthy();
    expect(await runOf(wake.runId!)).toMatchObject({ status: "queued", agentId: to.id });
    expect(await db.select().from(agentWakeupRequests).where(and(eq(agentWakeupRequests.companyId, f.companyId),
      eq(agentWakeupRequests.status, "deferred_issue_execution")))).toEqual([]);
    return wake.runId!;
  }

  it("ends both runs cancelled, holds no wake, and starts the next assignee and the dependent", async () => {
    const f = await seed();

    // A hands the task to B from its own run, with workspace settings for B.
    const firstRunId = await runningNativeRun({ companyId: f.companyId, agentId: f.a.id, issueId: f.taskId });
    const handOver = await request(appFor(f.companyId, f.a.id, firstRunId)).patch(`/api/issues/${f.taskId}`)
      .send({ assigneeAgentId: f.b.id, executionWorkspaceSettings: nextSettings });
    expect(handOver.status, JSON.stringify(handOver.body)).toBe(200);
    expect(await taskOf(f.taskId)).toMatchObject({ executionWorkspaceSettings: nextSettings, executionWorkspaceId: f.workspaceId });
    const secondRunId = await expectHandedOver(f, firstRunId, f.b);
    await settleStoppedRun({ ...f, issueId: f.taskId, runId: firstRunId });

    // B's run starts and hands the task back to A, again with settings.
    await runningNativeRun({ companyId: f.companyId, agentId: f.b.id, issueId: f.taskId, runId: secondRunId });
    const handBack = await request(appFor(f.companyId, f.b.id, secondRunId)).patch(`/api/issues/${f.taskId}`)
      .send({ assigneeAgentId: f.a.id, executionWorkspaceSettings: { ...nextSettings,
        workspaceStrategy: { ...nextSettings.workspaceStrategy, baseRef: "origin/feature/y" } } });
    expect(handBack.status, JSON.stringify(handBack.body)).toBe(200);
    const thirdRunId = await expectHandedOver(f, secondRunId, f.a);
    await settleStoppedRun({ ...f, issueId: f.taskId, runId: secondRunId });
    expect(await getExecutionBlocker(db, f.companyId, f.taskId)).toBeNull();

    // A's next run closes the task. Its dependent is ready and its assignee is woken.
    await runningNativeRun({ companyId: f.companyId, agentId: f.a.id, issueId: f.taskId, runId: thirdRunId });
    const done = await request(appFor(f.companyId, f.a.id, thirdRunId)).patch(`/api/issues/${f.taskId}`).send({ status: "done" });
    expect(done.status, JSON.stringify(done.body)).toBe(200);
    await expect(issueService(db).getDependencyReadiness(f.dependentId)).resolves.toMatchObject({
      isDependencyReady: true, pendingFinalizeBlockerIssueIds: [], unresolvedBlockerIssueIds: [] });
    await vi.waitFor(async () => {
      const wakes = await wakesFor(f.companyId, f.c.id, f.dependentId);
      expect(wakes.map(row => row.status)).toEqual(["queued"]);
    }, { timeout: 10_000, interval: 100 });
    expect(await db.select().from(issueRecoveryActions).where(eq(issueRecoveryActions.companyId, f.companyId))).toEqual([]);
    expect(await db.select({ status: heartbeatRuns.status, errorCode: heartbeatRuns.errorCode }).from(heartbeatRuns)
      .where(inArray(heartbeatRuns.id, [firstRunId, secondRunId]))).toEqual([
      { status: "cancelled", errorCode: "issue_reassigned" }, { status: "cancelled", errorCode: "issue_reassigned" }]);
  }, 120_000);
});
