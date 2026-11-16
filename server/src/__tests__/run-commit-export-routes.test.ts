import express from "express";
import request from "supertest";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mockLogActivity = vi.hoisted(() => vi.fn(async () => undefined));
vi.mock("../services/index.js", () => ({ logActivity: mockLogActivity }));

import { errorHandler } from "../middleware/index.js";
import { runCommitExportRoutes } from "../routes/run-commit-export.js";
import {
  registerRunCommitExport,
  runCommitExportRef,
  type RunCommitExporter,
} from "../services/heartbeat/run-commit-export.js";

const runId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const runAgentId = "11111111-1111-4111-8111-111111111111";
const otherAgentId = "22222222-2222-4222-8222-222222222222";
const commitSha = "c".repeat(40);
const path = `/api/heartbeat-runs/${runId}/workspace/export-commits`;

function createApp(run: Record<string, unknown> | null, actor: Record<string, unknown>) {
  const db = {
    select: () => {
      const query = { from: () => query, where: () => query, limit: async () => (run ? [run] : []) };
      return query;
    },
  };
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    (req as unknown as { actor: unknown }).actor = actor;
    next();
  });
  app.use("/api", runCommitExportRoutes(db as never));
  app.use(errorHandler);
  return app;
}

const liveRun = { id: runId, companyId: "company-1", agentId: runAgentId, status: "running" };
const runAgent = { type: "agent", agentId: runAgentId, companyId: "company-1", source: "agent_key" };
const boardMember = {
  type: "board", userId: "user-1", source: "session", isInstanceAdmin: false,
  companyIds: ["company-1"], memberships: [{ companyId: "company-1", status: "active", membershipRole: "member" }],
};

describe("POST /heartbeat-runs/:runId/workspace/export-commits", () => {
  let release: (() => Promise<void>) | null = null;
  let exporter: RunCommitExporter;
  beforeEach(() => {
    mockLogActivity.mockClear();
    exporter = { exportCommits: vi.fn(async () => ({ commitSha, branch: "work" })), release: vi.fn(async () => {}) };
    release = registerRunCommitExport(runId, exporter);
  });
  afterEach(async () => { await release?.(); });

  it.each([["the run's agent", runAgent], ["a board member of the run's company", boardMember]])("exports for %s", async (_label, actor) => {
    const res = await request(createApp(liveRun, actor)).post(path);
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ commitSha, branch: "work", ref: runCommitExportRef(runId) });
    expect(exporter.exportCommits).toHaveBeenCalledWith(`refs/paperclip/runs/${runId}/head`);
    expect(mockLogActivity).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
      action: "heartbeat.workspace_commits_exported", entityId: runId, companyId: "company-1",
    }));
  });

  it.each([
    ["another agent of the company", { ...runAgent, agentId: otherAgentId }, "not_run_agent"],
    ["a board viewer", { ...boardMember, memberships: [{ companyId: "company-1", status: "active", membershipRole: "viewer" }] }, "no_company_access"],
  ])("refuses %s with 403", async (_label, actor, code) => {
    const res = await request(createApp(liveRun, actor)).post(path);
    expect(res.status).toBe(403);
    expect(res.body.code).toBe(code);
    expect(exporter.exportCommits).not.toHaveBeenCalled();
  });

  it("answers 404 for a run of another company", async () => {
    const res = await request(createApp(liveRun, { ...runAgent, companyId: "company-2" })).post(path);
    expect(res.status).toBe(404);
  });

  it("refuses a run that is not running with 409", async () => {
    const res = await request(createApp({ ...liveRun, status: "succeeded" }, runAgent)).post(path);
    expect(res.status).toBe(409);
    expect(res.body.code).toBe("run_not_running");
    expect(exporter.exportCommits).not.toHaveBeenCalled();
  });

  it.each([
    [() => { throw new Error("workspace_git_unavailable"); }, 409, "no_git_workspace"],
    [() => { throw new Error("fatal: bundle create failed"); }, 502, "export_failed"],
  ])("maps an exporter failure to its status and reason", async (failure, status, code) => {
    vi.mocked(exporter.exportCommits).mockImplementationOnce(async () => failure());
    const res = await request(createApp(liveRun, runAgent)).post(path);
    expect(res.status).toBe(status);
    expect(res.body.code).toBe(code);
    if (code === "export_failed") expect(res.body.error).toBe("fatal: bundle create failed");
    expect(mockLogActivity).not.toHaveBeenCalled();
  });

  it("refuses a running run whose workspace this process cannot reach with 409", async () => {
    await release?.();
    release = null;
    const res = await request(createApp(liveRun, runAgent)).post(path);
    expect(res.status).toBe(409);
    expect(res.body.code).toBe("workspace_not_exportable");
  });
});
