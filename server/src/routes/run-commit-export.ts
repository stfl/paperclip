import { Router } from "express";
import { eq } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { heartbeatRuns } from "@paperclipai/db";
import { isUuidLike } from "@paperclipai/shared";
import { assertCompanyAccess, getActorInfo, hasCompanyAccess } from "./authz.js";
import { badRequest, HttpError } from "../errors.js";
import { logActivity } from "../services/index.js";
import { exportRunCommits, RunCommitExportError } from "../services/heartbeat/run-commit-export.js";

const FAILURE_STATUS: Record<RunCommitExportError["code"], number> = {
  workspace_not_exportable: 409,
  no_git_workspace: 409,
  bundle_too_large: 413,
  export_failed: 502,
};

export function runCommitExportRoutes(db: Db) {
  const router = Router();

  router.post("/heartbeat-runs/:runId/workspace/export-commits", async (req, res) => {
    const runId = req.params.runId as string;
    if (runId !== runId.trim() || !isUuidLike(runId)) throw badRequest("Invalid heartbeat run ID");
    const run = await db
      .select({ id: heartbeatRuns.id, companyId: heartbeatRuns.companyId, agentId: heartbeatRuns.agentId, status: heartbeatRuns.status })
      .from(heartbeatRuns)
      .where(eq(heartbeatRuns.id, runId))
      .limit(1)
      .then((rows) => rows[0] ?? null);
    if (!run || !hasCompanyAccess(req, run.companyId)) {
      res.status(404).json({ error: "Heartbeat run not found", code: "run_not_found" });
      return;
    }
    if (req.actor.type === "agent" ? req.actor.agentId !== run.agentId : req.actor.type !== "board") {
      res.status(403).json({ error: "Only the run's own agent or a board user may export its commits", code: "not_run_agent" });
      return;
    }
    // Write-path membership, including a responsible user an agent acts for.
    try {
      assertCompanyAccess(req, run.companyId);
    } catch (error) {
      if (!(error instanceof HttpError) || error.status !== 403) throw error;
      res.status(403).json({ error: error.message, code: "no_company_access" });
      return;
    }
    if (run.status !== "running") {
      res.status(409).json({ error: "The run is not running", code: "run_not_running" });
      return;
    }

    let exported;
    try {
      exported = await exportRunCommits(run.id);
    } catch (error) {
      if (!(error instanceof RunCommitExportError)) throw error;
      res.status(FAILURE_STATUS[error.code]).json({ error: error.message, code: error.code });
      return;
    }
    const actor = getActorInfo(req);
    await logActivity(db, {
      companyId: run.companyId,
      actorType: actor.actorType,
      actorId: actor.actorId,
      agentId: actor.agentId,
      action: "heartbeat.workspace_commits_exported",
      entityType: "heartbeat_run",
      entityId: run.id,
      details: { commitSha: exported.commitSha, ref: exported.ref },
    });
    res.json(exported);
  });

  return router;
}
