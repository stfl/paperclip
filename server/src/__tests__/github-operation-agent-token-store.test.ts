import { randomUUID } from "node:crypto";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import {
  agents,
  companies,
  companySecretBindings,
  createDb,
  heartbeatRuns,
  issues,
} from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { initializeRunIdentity } from "../services/run-identity.js";
import { resolveBrokerGitHubCredentials } from "../services/github-operation-credentials.js";
import { secretService } from "../services/secrets.js";

const support = await getEmbeddedPostgresTestSupport();
(support.supported ? describe : describe.skip)(
  "GitHub operation credentials against the real secret store",
  () => {
    let database: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>,
      db: ReturnType<typeof createDb>;
    const previousKeyFile = process.env.PAPERCLIP_SECRETS_MASTER_KEY_FILE;
    beforeAll(async () => {
      process.env.PAPERCLIP_SECRETS_MASTER_KEY_FILE = join(
        mkdtempSync(join(tmpdir(), "agent-token-store-")),
        "master.key",
      );
      vi.stubEnv("PAPERCLIP_AGENT_JWT_SECRET", "test-github-broker-signing-secret");
      database = await startEmbeddedPostgresTestDatabase("paperclip-github-agent-token-store-");
      db = createDb(database.connectionString);
    }, 30_000);
    afterAll(async () => {
      await database?.cleanup();
      vi.unstubAllEnvs();
      if (previousKeyFile === undefined) delete process.env.PAPERCLIP_SECRETS_MASTER_KEY_FILE;
      else process.env.PAPERCLIP_SECRETS_MASTER_KEY_FILE = previousKeyFile;
    }, 60_000);

    it("hands out the token only once the agent's binding row exists", async () => {
      const companyId = randomUUID(),
        agentId = randomUUID(),
        runId = randomUUID(),
        issueId = randomUUID();
      await db.insert(companies).values({ id: companyId, name: companyId, issuePrefix: companyId.slice(0, 8) });
      const secret = await secretService(db).create(companyId, {
        name: "company-app-token",
        provider: "local_encrypted",
        value: "ghs_real_installation_token",
      });
      await db.insert(agents).values({
        id: agentId,
        companyId,
        name: "Runner",
        role: "engineer",
        adapterType: "paperclip_runner",
        adapterConfig: { "access.GH_TOKEN": { type: "secret_ref", secretId: secret.id, version: "latest" } },
      });
      await db.insert(issues).values({ id: issueId, companyId, title: "Store test" });
      await db.insert(heartbeatRuns).values({
        id: runId,
        companyId,
        agentId,
        status: "running",
        contextSnapshot: { issueId },
      });
      await initializeRunIdentity(db, { companyId, runId, responsibleUserId: null, cause: "company_default" });
      const binding = { companyId, agentId, runId };

      const unbound = await resolveBrokerGitHubCredentials(db, binding);
      expect(unbound).toMatchObject({ status: "unavailable", env: {} });
      expect(JSON.stringify(unbound)).not.toContain("ghs_real_installation_token");

      await db.insert(companySecretBindings).values({
        companyId,
        secretId: secret.id,
        targetType: "agent",
        targetId: agentId,
        configPath: "access.GH_TOKEN",
      });
      const bound = await resolveBrokerGitHubCredentials(db, binding);
      expect(bound).toMatchObject({ status: "available" });
      expect(bound.env.GH_TOKEN).toBe("ghs_real_installation_token");
    });
  },
);
