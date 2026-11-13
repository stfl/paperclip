import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import express from "express";
import request from "supertest";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { companies, companyMemberships, createDb, issues, principalPermissionGrants } from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { errorHandler } from "../middleware/index.js";
import {
  __clearIssueListResponseCacheForTests,
  ISSUE_LIST_QUERY_PARAMETERS,
  issueRoutes,
} from "../routes/issues.js";
import { ensureHumanRoleDefaultGrants } from "../services/principal-access-compatibility.js";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping embedded Postgres issue list query parameter tests on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

describeEmbeddedPostgres("issue list rejects unsupported query parameters", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-issue-list-query-params-");
    db = createDb(tempDb.connectionString);
  }, 20_000);

  afterEach(async () => {
    __clearIssueListResponseCacheForTests();
    await db.delete(issues);
    await db.delete(principalPermissionGrants);
    await db.delete(companyMemberships);
    await db.delete(companies);
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  async function seedCompanyWithIssues() {
    const companyId = randomUUID();
    const userId = "cloud-user-1";
    const issuePrefix = `P${randomUUID().replace(/-/g, "").slice(0, 4).toUpperCase()}`;
    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip",
      issuePrefix,
      requireBoardApprovalForNewAgents: false,
    });
    await db.insert(companyMemberships).values({
      companyId,
      principalType: "user",
      principalId: userId,
      status: "active",
      membershipRole: "owner",
      updatedAt: new Date(),
    });
    await ensureHumanRoleDefaultGrants(db, { companyId, principalId: userId, membershipRole: "owner", grantedByUserId: null });
    const todoIssueId = randomUUID();
    const doneIssueId = randomUUID();
    await db.insert(issues).values([
      { id: todoIssueId, companyId, title: "Open task", status: "todo", priority: "medium", identifier: `${issuePrefix}-1` },
      { id: doneIssueId, companyId, title: "Finished task", status: "done", priority: "medium", identifier: `${issuePrefix}-2` },
    ]);

    const app = express();
    app.use(express.json());
    app.use((req, _res, next) => {
      (req as any).actor = {
        type: "board",
        userId,
        companyIds: [companyId],
        memberships: [{ companyId, membershipRole: "owner", status: "active", principalId: userId }],
        source: "cloud_tenant",
        isInstanceAdmin: false,
      };
      next();
    });
    app.use("/api", issueRoutes(db, {} as any));
    app.use(errorHandler);
    return { app, companyId, issuePrefix, todoIssueId };
  }

  it("answers 400 naming a parameter the list does not read instead of returning the unfiltered list", async () => {
    const { app, companyId, issuePrefix } = await seedCompanyWithIssues();

    const res = await request(app)
      .get(`/api/companies/${companyId}/issues`)
      .query({ identifier: `${issuePrefix}-2` });

    expect(res.status, JSON.stringify(res.body)).toBe(400);
    expect(res.body).toEqual({
      error: "Unsupported query parameter: identifier",
      details: { unsupportedParameters: ["identifier"] },
    });
  });

  it("names every unsupported parameter alongside supported ones", async () => {
    const { app, companyId } = await seedCompanyWithIssues();

    const res = await request(app)
      .get(`/api/companies/${companyId}/issues`)
      .query({ status: "todo", search: "task", page: "2", limit: "5" });

    expect(res.status, JSON.stringify(res.body)).toBe(400);
    expect(res.body).toEqual({
      error: "Unsupported query parameters: page, search",
      details: { unsupportedParameters: ["page", "search"] },
    });
  });

  it("still applies the parameters the list reads", async () => {
    const { app, companyId, todoIssueId } = await seedCompanyWithIssues();

    const res = await request(app)
      .get(`/api/companies/${companyId}/issues`)
      .query({ status: "todo", q: "task", limit: "20", sortField: "id", sortDir: "asc", includeRoutineExecutions: "true" });

    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body.map((issue: { id: string }) => issue.id)).toEqual([todoIssueId]);
  });
});

describe("issue list query parameter allow-list", () => {
  it("equals the set of query parameters the list handler reads", () => {
    const source = readFileSync(new URL("../routes/issues.ts", import.meta.url), "utf8");
    const start = source.indexOf('router.get("/companies/:companyId/issues",');
    const handler = source.slice(start, source.indexOf("\n  router.", start + 1));
    const uuidListStart = source.indexOf("const ISSUE_LIST_UUID_QUERY_PARAMS = [");
    const uuidList = source.slice(uuidListStart, source.indexOf("] as const;", uuidListStart));

    const bareQueryUses = [...handler.matchAll(/req\.query(?!\.[A-Za-z_])[^\n]{0,1}/g)].map((match) => match[0]);
    expect(bareQueryUses).toEqual(["req.query)"]);
    expect(handler).toContain("parseIssueListUuidQueryParams(req.query)");

    const reads = new Set([
      ...[...handler.matchAll(/req\.query\.([A-Za-z_]+)/g)].map((match) => match[1]),
      ...[...uuidList.matchAll(/"([A-Za-z_]+)"/g)].map((match) => match[1]),
    ]);
    expect([...ISSUE_LIST_QUERY_PARAMETERS].sort()).toEqual([...reads].sort());
  });
});
