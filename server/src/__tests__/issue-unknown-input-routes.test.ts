import { readFileSync } from "node:fs";
import express from "express";
import request from "supertest";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

const mockRetainBacklogAssignment = vi.hoisted(() => vi.fn(async () => undefined));
vi.mock("../services/human-directed-work.js", () => ({ retainBacklogHumanAssignment: mockRetainBacklogAssignment }));

const mockWakeup = vi.hoisted(() => vi.fn(async () => undefined));
const mockLogActivity = vi.hoisted(() => vi.fn(async () => undefined));
const mockIssueService = vi.hoisted(() => ({
  create: vi.fn(),
  createChild: vi.fn(),
  getById: vi.fn(),
  getByIdentifier: vi.fn(async () => null),
  getComment: vi.fn(),
  getCommentCursor: vi.fn(),
  getRelationSummaries: vi.fn(),
  listWakeableBlockedDependents: vi.fn(),
  getWakeableParentAfterChildCompletion: vi.fn(),
  findMentionedAgents: vi.fn(async () => []),
}));

vi.mock("../services/index.js", () => ({
  accessService: () => ({
    canUser: vi.fn(async () => true),
    decide: vi.fn(async (input: { action?: string }) => ({
      allowed: true,
      action: input.action,
      reason: "allow_explicit_grant",
      explanation: "Allowed by test grant.",
    })),
    hasPermission: vi.fn(async () => true),
  }),
  agentService: () => ({
    getById: vi.fn(async () => null),
    resolveByReference: vi.fn(async (_companyId: string, reference: string) => ({
      ambiguous: false,
      agent: {
        id: reference,
        companyId: "company-1",
        status: "active",
        orgChainHealth: { status: "healthy" },
      },
    })),
  }),
  companySkillService: () => ({
    completeTestRunForIssue: vi.fn(async () => null),
  }),
  companyService: () => ({
    getById: vi.fn(async () => ({ id: "company-1" })),
  }),
  documentAnnotationService: () => ({ remapOpenThreadsForDocument: async () => [] }),
  documentService: () => ({
    getIssueDocumentPayload: vi.fn(async () => ({})),
  }),
  executionWorkspaceService: () => ({
    getById: vi.fn(async () => null),
  }),
  feedbackService: () => ({
    listIssueVotesForUser: vi.fn(async () => []),
  }),
  goalService: () => ({
    getById: vi.fn(async () => null),
    getDefaultCompanyGoal: vi.fn(async () => null),
  }),
  heartbeatService: () => ({
    wakeup: mockWakeup,
    reportRunActivity: vi.fn(async () => undefined),
  }),
  getIssueContinuationSummaryDocument: vi.fn(async () => null),
  instanceSettingsService: () => ({
    get: vi.fn(async () => ({
      id: "instance-settings-1",
      general: {
        censorUsernameInLogs: false,
        feedbackDataSharingPreference: "prompt",
      },
    })),
    listCompanyIds: vi.fn(async () => ["company-1"]),
  }),
  issueApprovalService: () => ({}),
  issueRecoveryActionService: () => ({
    getActiveForIssue: vi.fn(async () => null),
    listActiveForIssues: vi.fn(async () => new Map()),
  }),
  issueReferenceService: () => ({
    deleteDocumentSource: async () => undefined,
    diffIssueReferenceSummary: () => ({
      addedReferencedIssues: [],
      removedReferencedIssues: [],
      currentReferencedIssues: [],
    }),
    emptySummary: () => ({ outbound: [], inbound: [] }),
    listIssueReferenceSummary: async () => ({ outbound: [], inbound: [] }),
    syncComment: async () => undefined,
    syncDocument: async () => undefined,
    syncIssue: async () => undefined,
  }),
  issueThreadInteractionService: () => ({
    listForIssue: vi.fn(async () => []),
    expireRequestConfirmationsSupersededByComment: vi.fn(async () => []),
    expireStaleRequestConfirmationsForIssueDocument: vi.fn(async () => []),
  }),
  issueService: () => mockIssueService,
  logActivity: mockLogActivity,
  projectService: () => ({
    getById: vi.fn(async () => null),
    listByIds: vi.fn(async () => []),
  }),
  routineService: () => ({
    syncRunStatusForIssue: vi.fn(async () => undefined),
  }),
  workProductService: () => ({
    listForIssue: vi.fn(async () => []),
  }),
}));

vi.mock("../services/fast-responses.js", () => ({
  enqueueFastResponse: vi.fn(async () => undefined),
}));

async function createApp() {
  const [{ issueRoutes }, { errorHandler }] = await Promise.all([
    vi.importActual<typeof import("../routes/issues.js")>("../routes/issues.js"),
    vi.importActual<typeof import("../middleware/index.js")>("../middleware/index.js"),
  ]);
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    (req as any).actor = {
      type: "board",
      userId: "local-board",
      companyIds: ["company-1"],
      source: "local_implicit",
      isInstanceAdmin: false,
    };
    next();
  });
  app.use("/api", issueRoutes({ transaction: async (effect: (tx: unknown) => unknown) => effect({}) } as any, {} as any));
  app.use(errorHandler);
  return app;
}

function issueListHandlerSource() {
  const source = readFileSync(new URL("../routes/issues.ts", import.meta.url), "utf8");
  const start = source.indexOf('router.get("/companies/:companyId/issues"');
  const end = source.indexOf("\n  router.", start);
  return source.slice(start, end);
}

describe("issue routes refuse what they would drop", () => {
  beforeAll(async () => {
    await createApp();
  });

  beforeEach(() => {
    vi.clearAllMocks();
    mockIssueService.getById.mockResolvedValue({
      id: "parent-1",
      companyId: "company-1",
      identifier: "PAP-1",
      title: "Parent issue",
      status: "todo",
    });
  });

  it("names the unknown field of an issue create", async () => {
    const res = await request(await createApp())
      .post("/api/companies/company-1/issues")
      .send({ title: "Dropped", status: "backlog", body: "lost" });

    expect(res.status).toBe(422);
    expect(res.body.error).toBe("Unknown field: body");
    expect(res.body.details).toEqual({ unknownFields: ["body"] });
    expect(mockIssueService.create).not.toHaveBeenCalled();
  });

  it("names every unknown field of a child create", async () => {
    const res = await request(await createApp())
      .post("/api/issues/parent-1/children")
      .send({ title: "Dropped", status: "backlog", body: "lost", note: "lost" });

    expect(res.status).toBe(422);
    expect(res.body.error).toBe("Unknown fields: body, note");
    expect(mockIssueService.createChild).not.toHaveBeenCalled();
  });

  it("names the unknown top-level field of a plan decomposition", async () => {
    const res = await request(await createApp())
      .post("/api/issues/parent-1/accepted-plan-decompositions")
      .send({
        acceptedPlanRevisionId: "33333333-3333-4333-8333-333333333333",
        children: [{ title: "Child", status: "backlog" }],
        body: "lost",
      });

    expect(res.status).toBe(422);
    expect(res.body.details).toEqual({ unknownFields: ["body"] });
  });

  it("names the unknown field of an issue update", async () => {
    const res = await request(await createApp())
      .patch("/api/issues/parent-1")
      .send({ body: "lost" });

    expect(res.status).toBe(422);
    expect(res.body.details).toEqual({ unknownFields: ["body"] });
  });

  it("still takes the fields an update has always dropped", async () => {
    const res = await request(await createApp())
      .patch("/api/issues/parent-1")
      .send({ originKind: "github_issue", originId: "o/r#1", executionState: null, body: "lost" });

    expect(res.status).toBe(422);
    expect(res.body.details).toEqual({ unknownFields: ["body"] });
  });

  it("accepts known fields on create and child create", async () => {
    mockIssueService.create.mockImplementation(async (_companyId: string, data: Record<string, unknown>) => ({
      ...data,
      id: "issue-1",
      companyId: "company-1",
      identifier: "PAP-2",
    }));
    mockIssueService.createChild.mockImplementation(async (_parentId: string, data: Record<string, unknown>) => ({
      issue: { ...data, id: "child-1", companyId: "company-1", identifier: "PAP-3", parentId: "parent-1" },
      parentBlockerAdded: false,
    }));
    mockIssueService.getRelationSummaries.mockResolvedValue({ blockedBy: [], blocks: [] });
    const app = await createApp();

    const created = await request(app)
      .post("/api/companies/company-1/issues")
      .send({ title: "Known", status: "backlog", description: "text" });
    const child = await request(app)
      .post("/api/issues/parent-1/children")
      .send({ title: "Known child", status: "backlog", description: "text" });

    expect(created.status, JSON.stringify(created.body)).toBe(201);
    expect(child.status, JSON.stringify(child.body)).toBe(201);
  });

  it("names the unknown parameter of the issue list", async () => {
    const res = await request(await createApp())
      .get("/api/companies/company-1/issues")
      .query({ identifier: "PAP-1", limit: "5", foo: "1" });

    expect(res.status).toBe(422);
    expect(res.body.error).toBe("Unknown query parameters: identifier, foo");
    expect(res.body.details).toEqual({ unknownParameters: ["identifier", "foo"] });
  });

  it("passes the parameters the issue list reads on to its handler", async () => {
    // The handler needs a database the stubbed app does not have, so only the
    // parameter check is observable here.
    const res = await request(await createApp())
      .get("/api/companies/company-1/issues")
      .query({ status: "todo", limit: "5", q: "text", sortField: "updated" });

    expect(res.status).not.toBe(422);
  });

  it("lists exactly the query parameters the issue list handler reads", async () => {
    const { ISSUE_LIST_QUERY_PARAMETERS } = await vi.importActual<typeof import("../routes/issues.js")>("../routes/issues.js");
    const handler = issueListHandlerSource();
    expect(handler).not.toMatch(/req\.query\[|\.\.\.req\.query|= req\.query[;,]/);
    const reads = [...new Set([...handler.matchAll(/req\.query\.([A-Za-z_]+)/g)].map((match) => match[1]))].sort();
    expect([...ISSUE_LIST_QUERY_PARAMETERS].sort()).toEqual(reads);
  });
});
