import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import {
  agents,
  companies,
  companyMemberships,
  createDb,
  heartbeatRuns,
  issues,
} from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import {
  RECOVERY_HANDOVER_CHAIN_WINDOW,
  recoveryService,
} from "../services/recovery/service.js";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

type Agent = "A" | "B" | "C";
type Lane = keyof typeof LANES;
// One run, oldest first. A run that handed the issue on carries the recovery
// lane whose retry reason it ran with, or none for an ordinary wake; an `end`
// run ended any other way; a `refused` run is a queued recovery wake that
// dispatch cancelled because the assignee changed before it started.
type Hop = { agent: Agent; recovery: Lane | null; end?: true; refused?: true };

const LANES = {
  in_progress: {
    reason: "issue_continuation_needed",
    retryReason: "issue_continuation_needed",
    requeued: "continuationRequeued",
  },
  todo: {
    reason: "issue_assignment_recovery",
    retryReason: "assignment_recovery",
    requeued: "dispatchRequeued",
  },
  in_review: {
    reason: "execution_review_participant_recovery",
    retryReason: "execution_review_participant_recovery",
    requeued: "reviewParticipantRequeued",
  },
} as const;

// A hand-over from a recovery run of `lane`; with no lane, of the issue's own.
const cont = (agent: Agent, lane?: Lane) => ({ agent, recovery: lane ?? "own" }) as const;
const wake = (agent: Agent): Hop => ({ agent, recovery: null });
const ended = (agent: Agent): Hop => ({ agent, recovery: null, end: true });
const refused = (agent: Agent, lane: Lane): Hop => ({ agent, recovery: lane, refused: true });
type HopSpec = Hop | ReturnType<typeof cont>;

describeEmbeddedPostgres("stranded sweep and hand-overs that return the issue", () => {
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;
  let db: ReturnType<typeof createDb>;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-recovery-handoff-ping-pong-");
    db = createDb(tempDb.connectionString);
  }, 30_000);

  afterAll(async () => {
    await tempDb.cleanup();
  });

  // An issue handed on from inside runs, oldest hop first; the last hop
  // handed it to `assignee`. In `in_review`, `assignee` is also the pending
  // stage's participant.
  async function seedHops(lane: Lane, specs: readonly HopSpec[], assignee: Agent) {
    const hops: Hop[] = specs.map((h) =>
      h.recovery === "own" ? { agent: h.agent, recovery: lane } : (h as Hop),
    );
    const companyId = randomUUID();
    await db.insert(companies).values({
      id: companyId,
      name: "Ping Pong Co",
      issuePrefix: `Q${companyId.slice(0, 6)}`,
      defaultResponsibleUserId: "responsible-user",
    });
    await db.insert(companyMemberships).values({
      companyId,
      principalType: "user",
      principalId: "responsible-user",
      status: "active",
      membershipRole: "member",
    });
    const ids = { A: randomUUID(), B: randomUUID(), C: randomUUID() };
    await db.insert(agents).values(
      (["A", "B", "C"] as const).map((name) => ({
        id: ids[name],
        companyId,
        name,
        role: "engineer",
        status: "idle",
        adapterType: "codex_local",
      })),
    );
    const issueId = randomUUID();
    const participant = { type: "agent", agentId: ids[assignee], userId: null } as const;
    await db.insert(issues).values({
      id: issueId,
      companyId,
      title: "Bounce the work",
      status: lane,
      assigneeAgentId: ids[assignee],
      createdAt: new Date(Date.now() - 2 * 60 * 60 * 1000),
      updatedAt: new Date(Date.now() - 2 * 60 * 60 * 1000),
      ...(lane === "in_review"
        ? {
            executionState: {
              status: "pending",
              currentStageId: randomUUID(),
              currentStageIndex: 0,
              currentStageType: "review",
              currentParticipant: participant,
              returnAssignee: participant,
              reviewRequest: null,
              completedStageIds: [],
              lastDecisionId: null,
              lastDecisionOutcome: null,
            },
          }
        : {}),
    });
    const n = hops.length;
    await db.insert(heartbeatRuns).values(
      hops.map((hop, i) => ({
        companyId,
        agentId: ids[hop.agent],
        issueId,
        ...(hop.end
          ? { status: "succeeded" }
          : hop.refused
          ? {
              status: "cancelled",
              errorCode: "issue_assignee_changed",
              error: "Cancelled because issue assignee changed before the queued run could start",
              resultJson: { stopReason: "issue_assignee_changed" },
            }
          : {
              status: "cancelled",
              errorCode: "issue_reassigned",
              error: "Cancelled before issue reassignment",
              resultJson: { reassignmentStopConfirmed: true },
            }),
        createdAt: new Date(Date.now() - (n - i) * 10 * 60_000),
        startedAt: hop.refused ? null : new Date(Date.now() - (n - i) * 10 * 60_000),
        finishedAt: new Date(Date.now() - ((n - i) * 10 - 1) * 60_000),
        contextSnapshot: hop.recovery
          ? {
              issueId,
              wakeReason: LANES[hop.recovery].reason,
              retryReason: LANES[hop.recovery].retryReason,
            }
          : { issueId, wakeReason: "issue_assigned" },
      })),
    );
    return { companyId, issueId, assigneeId: ids[assignee] };
  }

  function recordingEnqueue(companyId: string, issueId: string) {
    return vi.fn().mockImplementation(async (agentId: string) => {
      const [run] = await db.insert(heartbeatRuns).values({
        companyId,
        agentId,
        issueId,
        status: "queued",
        contextSnapshot: { issueId },
      }).returning();
      return run;
    });
  }

  async function expectBlocked(lane: Lane, hops: readonly HopSpec[], assignee: Agent) {
    const f = await seedHops(lane, hops, assignee);
    const enqueueWakeup = recordingEnqueue(f.companyId, f.issueId);

    const result = await recoveryService(db, { enqueueWakeup }).reconcileStrandedAssignedIssues();

    expect(enqueueWakeup).not.toHaveBeenCalled();
    expect(result).toMatchObject({ escalated: 1, issueIds: [f.issueId] });
    const [issue] = await db.select().from(issues).where(eq(issues.id, f.issueId));
    expect(issue.status).toBe("blocked");
  }

  async function expectRequeued(lane: Lane, hops: readonly HopSpec[], assignee: Agent) {
    const f = await seedHops(lane, hops, assignee);
    const enqueueWakeup = recordingEnqueue(f.companyId, f.issueId);

    const result = await recoveryService(db, { enqueueWakeup }).reconcileStrandedAssignedIssues();

    expect(result).toMatchObject({ escalated: 0, [LANES[lane].requeued]: 1, issueIds: [f.issueId] });
    expect(enqueueWakeup).toHaveBeenCalledOnce();
    expect(enqueueWakeup).toHaveBeenCalledWith(f.assigneeId, expect.anything());
    const [issue] = await db.select().from(issues).where(eq(issues.id, f.issueId));
    expect(issue.status).toBe(lane);
  }

  // Wakes by C that hand the issue on: they count as no return and keep the
  // chain whole, so they only push older runs out of the window.
  const wakes = (n: number) => Array.from({ length: n }, () => wake("C"));
  // A→B→A→B, then wakes up to the window's edge: the two oldest recovery
  // hand-overs return the issue, and `n` decides how many of them it reads.
  const pastWindow = (n: number) => [cont("A"), cont("B"), cont("A"), cont("B"), ...wakes(n)];

  it.each([
    { name: "A→B→A→B", lane: "in_progress", hops: [cont("A"), cont("B"), cont("A")], assignee: "B" },
    { name: "A→B→C→B→A", lane: "in_progress", hops: [cont("A"), cont("B"), cont("C"), cont("B")], assignee: "A" },
    // An ordinary wake that only handed the issue back neither counts nor ends the chain.
    {
      name: "A→B→A→B→A, one B hop on an ordinary wake",
      lane: "in_progress",
      hops: [cont("A"), wake("B"), cont("A"), cont("B")],
      assignee: "A",
    },
    { name: "todo A→B→A→B", lane: "todo", hops: [cont("A"), cont("B"), cont("A")], assignee: "B" },
    // The reviewer's hand-over returns twice: past one honest review round.
    {
      name: "in_review P→A→P→A→P",
      lane: "in_review",
      hops: [cont("B"), wake("A"), cont("B"), wake("A")],
      assignee: "B",
    },
    // Recovery hand-overs of another lane count: a reassignment that resets
    // the issue to todo does not hide the loop.
    {
      name: "todo A→B→A after in_progress hand-overs",
      lane: "todo",
      hops: [cont("A", "in_progress"), cont("B", "in_progress"), cont("A")],
      assignee: "B",
    },
    // Dispatch refused each stopped agent's immediate recovery wake once the
    // issue moved on; those runs never started and hide nothing.
    {
      name: "todo A→B→A→B with refused immediate recoveries",
      lane: "todo",
      hops: [cont("A"), refused("A", "todo"), cont("B"), refused("B", "todo"), cont("A"), refused("A", "todo")],
      assignee: "B",
    },
    {
      name: "two returns inside the window",
      lane: "in_progress",
      hops: pastWindow(RECOVERY_HANDOVER_CHAIN_WINDOW - 3),
      assignee: "A",
    },
  ] as const)("blocks an issue handed back past the tolerated return ($name)", async ({ lane, hops, assignee }) => {
    await expectBlocked(lane, hops, assignee);
  });

  it.each([
    { name: "single hop A→B", lane: "in_progress", hops: [cont("A")], assignee: "B" },
    { name: "A→B→C", lane: "in_progress", hops: [cont("A"), cont("B")], assignee: "C" },
    // One return is tolerated.
    { name: "A→B→A", lane: "in_progress", hops: [cont("A"), cont("B")], assignee: "A" },
    { name: "A→B→A, B on an ordinary wake", lane: "in_progress", hops: [cont("A"), wake("B")], assignee: "A" },
    { name: "A→B→A→B→A on ordinary wakes", lane: "in_progress", hops: [wake("A"), wake("B"), wake("A"), wake("B")], assignee: "A" },
    { name: "todo single hop A→B", lane: "todo", hops: [cont("A")], assignee: "B" },
    { name: "todo A→B→A", lane: "todo", hops: [cont("A"), cont("B")], assignee: "A" },
    {
      name: "todo A→B→A with refused immediate recoveries",
      lane: "todo",
      hops: [cont("A"), refused("A", "todo"), cont("B"), refused("B", "todo")],
      assignee: "A",
    },
    // The reviewer requests changes and hands the issue to the author, who
    // fixes it and hands it back; the reviewer's wake was lost.
    { name: "in_review P→A→P, one review round", lane: "in_review", hops: [cont("B"), wake("A")], assignee: "B" },
    // A run that ended any other way ends the chain: the returns before it
    // no longer count.
    {
      name: "A→B→A→B, then a run that ended, then A→B→A",
      lane: "in_progress",
      hops: [cont("A"), cont("B"), cont("A"), ended("B"), cont("A"), cont("B")],
      assignee: "A",
    },
    {
      name: "the second return just outside the window",
      lane: "in_progress",
      hops: pastWindow(RECOVERY_HANDOVER_CHAIN_WINDOW - 2),
      assignee: "A",
    },
  ] as const)("requeues the issue's next agent ($name)", async ({ lane, hops, assignee }) => {
    await expectRequeued(lane, hops, assignee);
  });
});
