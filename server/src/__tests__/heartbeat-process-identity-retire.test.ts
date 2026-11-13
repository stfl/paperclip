import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { agents, authUsers, companies, companyMemberships, createDb, heartbeatRunEvents, heartbeatRuns } from "@paperclipai/db";
import { heartbeatService } from "../services/heartbeat.js";
import { agentExecutionsHaveStopped } from "../services/agent-execution-stop.js";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";

const support = await getEmbeddedPostgresTestSupport();
const describePostgres = support.supported && process.platform !== "win32" ? describe : describe.skip;

describePostgres("process identity of a finished local run", () => {
  const userId = `identity-user-${randomUUID()}`;
  let temporary: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;
  let db: ReturnType<typeof createDb>;
  let heartbeat: ReturnType<typeof heartbeatService>;

  beforeAll(async () => {
    temporary = await startEmbeddedPostgresTestDatabase("heartbeat-process-identity-");
    db = createDb(temporary.connectionString);
    await db.insert(authUsers).values({ id: userId, name: "Identity fixture sponsor", email: `${userId}@example.test`,
      createdAt: new Date(), updatedAt: new Date() });
    heartbeat = heartbeatService(db);
  }, 90_000);
  afterAll(async () => {
    await heartbeat?.drainActiveRunExecutions();
    await db?.$client.end({ timeout: 0 });
    await temporary?.cleanup();
  });

  async function runToEnd(script: string) {
    const companyId = randomUUID(), agentId = randomUUID();
    await db.insert(companies).values({ id: companyId, name: "Identity fixture", issuePrefix: `I${companyId.slice(0, 6)}`,
      defaultResponsibleUserId: userId });
    await db.insert(companyMemberships).values({ companyId, principalType: "user", principalId: userId,
      membershipRole: "operator", status: "active" });
    await db.insert(agents).values({ id: agentId, companyId, name: "Local process", adapterType: "process", status: "idle",
      adapterConfig: { command: process.execPath, args: ["-e", script], timeoutSec: 20, graceSec: 1 } });
    const run = await heartbeat.wakeup(agentId, { source: "on_demand", triggerDetail: "manual", reason: "manual" });
    expect(run).not.toBeNull();
    await heartbeat.drainActiveRunExecutions();
    const [finished] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, run!.id));
    const [identity] = await db.select().from(heartbeatRunEvents).where(eq(heartbeatRunEvents.runId, run!.id))
      .then(events => events.filter(event => event.eventType === "native.process_identity_recorded"));
    return { agentId, finished: finished!, identity };
  }

  it("gives up the pid of a run whose process the server saw exit, so a reused number cannot hold a pause", async () => {
    const { agentId, finished, identity } = await runToEnd("console.log('done')");
    expect(finished.status, finished.error ?? undefined).toBe("succeeded");
    // The server did record the process; the launch event keeps that history.
    expect(identity?.payload).toMatchObject({ processPid: expect.any(Number) });
    expect(finished).toMatchObject({ processPid: null, processGroupId: null, processStartedAt: null });
    expect(await agentExecutionsHaveStopped(db, [agentId])).toBe(true);
  });

  it("keeps the pid of a failed run as its stop evidence", async () => {
    const { finished, identity } = await runToEnd("process.exit(3)");
    expect(finished.status).toBe("failed");
    expect(finished.processPid).toBe((identity?.payload as { processPid: number }).processPid);
    expect(finished.processStartedAt).not.toBeNull();
  });
});
