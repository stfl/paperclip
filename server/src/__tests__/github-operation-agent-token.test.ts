import { execFile } from "node:child_process";
import { createServer } from "node:http";
import { promisify } from "node:util";
import { chmodSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import {
  agents,
  companies,
  companySecrets,
  connectionGrants,
  createDb,
  heartbeatRuns,
  issues,
  runIdentityContexts,
  toolApplications,
  toolConnectionInstalls,
  toolConnections,
} from "@paperclipai/db";
import { LOW_TRUST_REVIEW_PRESET } from "@paperclipai/shared";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { initializeRunIdentity } from "../services/run-identity.js";
import {
  resolveBrokerGitHubCredentials,
  resolveGitHubOperationCredentials,
} from "../services/github-operation-credentials.js";
import { githubLauncherSource } from "@paperclipai/adapter-utils/github-launcher";
import {
  agentGitHubTokenBinding,
  withAgentGitHubTokenSelection,
} from "../services/git-credentials.js";

const vault = vi.hoisted(() => ({
  token: "installation-token-1",
  boundSecret: "",
  resolveSecretValue: vi.fn(
    async (_company: string, secret: string, _version: unknown, options?: { bindingContext?: unknown }) => {
      if (secret === vault.boundSecret && !options?.bindingContext) throw new Error("binding context required");
      return vault.token;
    },
  ),
}));
vi.mock("../services/secrets.js", () => ({ secretService: () => vault }));
const auth = vi.hoisted(() => ({ deny: false }));
vi.mock("../services/authorization.js", async (importOriginal) => {
  const original = await importOriginal<typeof import("../services/authorization.js")>();
  return {
    ...original,
    authorizationService: (db: never) => {
      const real = original.authorizationService(db);
      return {
        ...real,
        decide: (input: never) =>
          auth.deny ? Promise.resolve({ allowed: false, explanation: "denied" }) : real.decide(input),
      };
    },
  };
});

const ref = { type: "secret_ref", secretId: "s1", version: "latest" };

describe("agentGitHubTokenBinding", () => {
  it("reads the secret reference at the top-level key access.GH_TOKEN", () => {
    expect(agentGitHubTokenBinding({ "access.GH_TOKEN": ref })).toEqual({
      secretId: "s1",
      version: "latest",
    });
    expect(agentGitHubTokenBinding({ "access.GH_TOKEN": { ...ref, version: 3 } })).toEqual({
      secretId: "s1",
      version: 3,
    });
  });

  it("ignores a nested access object, a plain value, another alias and an env binding", () => {
    expect(agentGitHubTokenBinding({ access: { GH_TOKEN: ref } })).toBeNull();
    expect(agentGitHubTokenBinding({ "access.GH_TOKEN": "ghp_plain" })).toBeNull();
    expect(agentGitHubTokenBinding({ "access.OTHER": ref })).toBeNull();
    expect(agentGitHubTokenBinding({ env: { GH_TOKEN: ref } })).toBeNull();
    expect(agentGitHubTokenBinding(null)).toBeNull();
  });
});

describe("withAgentGitHubTokenSelection", () => {
  const bound = { "access.GH_TOKEN": ref };
  it("configures a sandbox run of an agent that binds the token", () => {
    expect(withAgentGitHubTokenSelection({ configured: false }, { driver: "sandbox", adapterConfig: bound }))
      .toEqual({ configured: true });
  });
  it("leaves local and ssh runs, unbound agents and connections as they are", () => {
    const none = { configured: false };
    expect(withAgentGitHubTokenSelection(none, { driver: "local", adapterConfig: bound })).toBe(none);
    expect(withAgentGitHubTokenSelection(none, { driver: "ssh", adapterConfig: bound })).toBe(none);
    expect(withAgentGitHubTokenSelection(none, { driver: undefined, adapterConfig: bound })).toBe(none);
    expect(withAgentGitHubTokenSelection(none, { driver: "sandbox", adapterConfig: {} })).toBe(none);
    expect(withAgentGitHubTokenSelection(none, { driver: "sandbox", adapterConfig: { access: { GH_TOKEN: ref } } })).toBe(none);
    const connection = { configured: true, identitySource: "dedicated" as const };
    expect(withAgentGitHubTokenSelection(connection, { driver: "sandbox", adapterConfig: bound })).toBe(connection);
  });
});

const support = await getEmbeddedPostgresTestSupport();
(support.supported ? describe : describe.skip)(
  "GitHub operation credentials from the agent's access.GH_TOKEN",
  () => {
    let database: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>,
      db: ReturnType<typeof createDb>;
    beforeAll(async () => {
      vi.stubEnv("PAPERCLIP_AGENT_JWT_SECRET", "test-github-broker-signing-secret");
      database = await startEmbeddedPostgresTestDatabase("paperclip-github-agent-token-");
      db = createDb(database.connectionString);
    }, 30_000);
    afterAll(async () => {
      await database?.cleanup();
      vi.unstubAllEnvs();
    }, 60_000);
    beforeEach(() => {
      vault.token = "installation-token-1";
      vault.resolveSecretValue.mockClear();
      vi.stubEnv("PAPERCLIP_GITHUB_INSTALLATION_AUTHOR_NAME", "");
      vi.stubEnv("PAPERCLIP_GITHUB_INSTALLATION_AUTHOR_EMAIL", "");
      vi.stubEnv("PAPERCLIP_GITHUB_INSTALLATION_AUTHOR_INCLUDES", "");
    });

    async function seed(bound = true) {
      const companyId = randomUUID(),
        agentId = randomUUID(),
        runId = randomUUID(),
        issueId = randomUUID(),
        secretId = randomUUID();
      await db.insert(companies).values({
        id: companyId,
        name: companyId,
        issuePrefix: companyId.slice(0, 8),
      });
      await db.insert(agents).values({
        id: agentId,
        companyId,
        name: "Runner",
        role: "engineer",
        adapterType: "paperclip_runner",
        adapterConfig: bound
          ? { "access.GH_TOKEN": { type: "secret_ref", secretId, version: "latest" } }
          : {},
      });
      vault.boundSecret = secretId;
      await db.insert(issues).values({ id: issueId, companyId, title: "Token test" });
      await db.insert(heartbeatRuns).values({
        id: runId,
        companyId,
        agentId,
        status: "running",
        contextSnapshot: { issueId },
      });
      await initializeRunIdentity(db, {
        companyId,
        runId,
        responsibleUserId: null,
        cause: "company_default",
      });
      return { companyId, agentId, runId, issueId, secretId };
    }
    const resolve = (input: Awaited<ReturnType<typeof seed>>, agentToken = true) => {
      const binding = { companyId: input.companyId, agentId: input.agentId, runId: input.runId };
      return agentToken
        ? resolveBrokerGitHubCredentials(db, binding)
        : resolveGitHubOperationCredentials(db, binding);
    };

    it("answers with the bound secret in the credential-helper shape and no GitHub user", async () => {
      const run = await seed();
      const result = await resolve(run);
      expect(result).toMatchObject({ status: "available", authenticationMode: "managed" });
      expect(result).not.toHaveProperty("login");
      expect(result.env).toMatchObject({
        GH_TOKEN: "installation-token-1",
        GITHUB_TOKEN: "installation-token-1",
        PAPERCLIP_GIT_TOKEN: "installation-token-1",
        GIT_TERMINAL_PROMPT: "0",
        GIT_CONFIG_KEY_1: "credential.https://github.com.helper",
      });
      expect(result.env).not.toHaveProperty("GIT_AUTHOR_NAME");
      expect(result.env).not.toHaveProperty("GIT_COMMITTER_EMAIL");
      expect(Object.values(result.env)).not.toContain("user.name");
      expect(vault.resolveSecretValue).toHaveBeenCalledWith(
        run.companyId,
        run.secretId,
        "latest",
        expect.anything(),
      );
      const [{ github }] = await db
        .select({ github: runIdentityContexts.github })
        .from(runIdentityContexts)
        .where(eq(runIdentityContexts.runId, run.runId));
      expect(JSON.stringify(github)).not.toContain("installation-token");
    });

    it("reads the secret at every operation, so a rotation reaches the next one", async () => {
      const run = await seed();
      expect((await resolve(run)).env.GH_TOKEN).toBe("installation-token-1");
      vault.token = "installation-token-2";
      const rotated = await resolve(run);
      expect(rotated.env.GH_TOKEN).toBe("installation-token-2");
      expect(rotated.env.PAPERCLIP_GIT_TOKEN).toBe("installation-token-2");
    });

    it("hands Git the configured author as config entries, never as an environment author", async () => {
      vi.stubEnv("PAPERCLIP_GITHUB_INSTALLATION_AUTHOR_NAME", "installation-bot");
      vi.stubEnv("PAPERCLIP_GITHUB_INSTALLATION_AUTHOR_EMAIL", "bot@users.noreply.github.com");
      const { env } = await resolve(await seed());
      const entries = Object.keys(env)
        .filter((key) => key.startsWith("GIT_CONFIG_KEY_"))
        .map((key) => [env[key], env[key.replace("KEY", "VALUE")]]);
      expect(entries).toContainEqual(["user.name", "installation-bot"]);
      expect(entries).toContainEqual(["user.email", "bot@users.noreply.github.com"]);
      expect(Number(env.GIT_CONFIG_COUNT)).toBe(entries.length);
      for (const key of ["GIT_AUTHOR_NAME", "GIT_AUTHOR_EMAIL", "GIT_COMMITTER_NAME", "GIT_COMMITTER_EMAIL"]) {
        expect(env).not.toHaveProperty(key);
      }
    });

    it("gives a clone of a matching remote the included identity and any other the default author, through the launcher", async () => {
      const dir = mkdtempSync(join(tmpdir(), "installation-author-"));
      const mirrorIdentity = join(dir, "mirror-identity");
      writeFileSync(mirrorIdentity, "[user]\n\tname = Mirror Author\n\temail = author@mirror.example\n");
      vi.stubEnv("PAPERCLIP_GITHUB_INSTALLATION_AUTHOR_NAME", "installation-bot");
      vi.stubEnv("PAPERCLIP_GITHUB_INSTALLATION_AUTHOR_EMAIL", "bot@users.noreply.github.com");
      vi.stubEnv(
        "PAPERCLIP_GITHUB_INSTALLATION_AUTHOR_INCLUDES",
        JSON.stringify([
          { pattern: "**/mirrors/product.git", path: mirrorIdentity },
          { pattern: "git://*/product.git", path: mirrorIdentity },
        ]),
      );
      const run = await seed();
      const broker = createServer(async (req, res) => {
        req.resume();
        res.setHeader("content-type", "application/json");
        res.end(JSON.stringify(await resolve(run)));
      });
      await new Promise<void>((done) => broker.listen(0, "127.0.0.1", done));
      try {
        const launcher = join(dir, "bin", "git");
        mkdirSync(join(dir, "bin"));
        writeFileSync(launcher, githubLauncherSource());
        chmodSync(launcher, 0o755);
        const url = `http://127.0.0.1:${(broker.address() as { port: number }).port}`;
        const launcherEnv: Record<string, string> = {
          PATH: process.env.PATH ?? "",
          HOME: dir,
          GH_CONFIG_DIR: dir,
          PAPERCLIP_GITHUB_BROKER_URL: url,
          PAPERCLIP_GITHUB_BROKER_TOKEN: "capability",
        };
        const exec = promisify(execFile);
        const ident = async (remote: string, local?: string) => {
          const repo = mkdtempSync(join(dir, "repo-"));
          const real = (...args: string[]) =>
            exec("git", args, { cwd: repo, env: { PATH: process.env.PATH ?? "", HOME: dir } });
          await real("init", "-q");
          await real("remote", "add", "origin", remote);
          if (local) await real("config", "user.name", local);
          const { stdout } = await exec(process.execPath, [launcher, "var", "GIT_AUTHOR_IDENT"], {
            cwd: repo,
            env: launcherEnv,
          });
          return stdout.replace(/ \d+ [+-]\d{4}\n$/, "");
        };
        expect(await ident("git://192.0.2.1/product.git")).toBe("Mirror Author <author@mirror.example>");
        expect(await ident("file:///var/lib/mirrors/product.git")).toBe("Mirror Author <author@mirror.example>");
        expect(await ident("git://192.0.2.1/product.git", "Local")).toBe("Mirror Author <author@mirror.example>");
        expect(await ident("https://github.com/example/other.git")).toBe("installation-bot <bot@users.noreply.github.com>");
      } finally {
        broker.close();
      }
    });

    it("registers the token for redaction in the run's output", async () => {
      const run = await seed();
      await resolve(run);
      const [{ snapshot }] = await db
        .select({ snapshot: heartbeatRuns.contextSnapshot })
        .from(heartbeatRuns)
        .where(eq(heartbeatRuns.id, run.runId));
      expect(JSON.stringify(snapshot)).toContain("fingerprintSha256");
      expect(JSON.stringify(snapshot)).not.toContain("installation-token-1");
    });

    it("asks the secret store with the agent's binding context", async () => {
      const run = await seed();
      await resolve(run);
      expect(vault.resolveSecretValue).toHaveBeenCalledWith(
        run.companyId,
        run.secretId,
        "latest",
        expect.objectContaining({
          bindingContext: expect.objectContaining({
            consumerType: "agent",
            consumerId: run.agentId,
            configPath: "access.GH_TOKEN",
            heartbeatRunId: run.runId,
          }),
        }),
      );
    });

    it("refuses an agent whose secrets:read the authorization denies", async () => {
      const run = await seed();
      auth.deny = true;
      try {
        expect(await resolve(run)).toMatchObject({ status: "unavailable", env: {} });
        expect(vault.resolveSecretValue).not.toHaveBeenCalled();
      } finally {
        auth.deny = false;
      }
    });

    it("refuses a skill-test run, whose agent token may not read secrets", async () => {
      const bySetting = await seed();
      await db.update(issues).set({ workMode: "skill_test" }).where(eq(issues.id, bySetting.issueId));
      expect(await resolve(bySetting)).toMatchObject({ status: "unavailable", env: {} });

      const byScope = await seed();
      await db
        .update(heartbeatRuns)
        .set({ contextSnapshot: { issueId: byScope.issueId, paperclipAgentJwtScope: { kind: "skill_test", issueId: byScope.issueId } } })
        .where(eq(heartbeatRuns.id, byScope.runId));
      expect(await resolve(byScope)).toMatchObject({ status: "unavailable", env: {} });
      expect(vault.resolveSecretValue).not.toHaveBeenCalled();
    });

    it("gets nothing for the nested access object, which has no binding row", async () => {
      const run = await seed(false);
      await db
        .update(agents)
        .set({ adapterConfig: { access: { GH_TOKEN: { type: "secret_ref", secretId: run.secretId } } } })
        .where(eq(agents.id, run.agentId));
      expect(await resolve(run)).toMatchObject({ status: "absent", env: {} });
      expect(vault.resolveSecretValue).not.toHaveBeenCalled();
    });

    it("answers absent for an agent without the binding, or a caller that does not ask for it", async () => {
      expect(await resolve(await seed(false))).toMatchObject({ status: "absent", env: {} });
      expect(await resolve(await seed(true), false)).toMatchObject({ status: "absent", env: {} });
      expect(vault.resolveSecretValue).not.toHaveBeenCalled();
    });

    it("keeps refusing a run that is not active, another company and a low-trust task", async () => {
      const ended = await seed();
      await db.update(heartbeatRuns).set({ status: "succeeded" }).where(eq(heartbeatRuns.id, ended.runId));
      await expect(resolve(ended)).rejects.toThrow(/active run/);

      const run = await seed();
      await expect(
        resolveGitHubOperationCredentials(
          db,
          { companyId: randomUUID(), agentId: run.agentId, runId: run.runId },
          { agentToken: true },
        ),
      ).rejects.toThrow(/active run/);

      const lowTrust = await seed();
      await db
        .update(issues)
        .set({
          sourceTrust: {
            preset: LOW_TRUST_REVIEW_PRESET,
            disposition: "quarantined",
            sourceIssueId: lowTrust.issueId,
          },
        })
        .where(eq(issues.id, lowTrust.issueId));
      const refused = await resolve(lowTrust);
      expect(vault.resolveSecretValue).not.toHaveBeenCalled();
      expect(refused).toMatchObject({ status: "unavailable", env: {} });
    });

    it("lets a GitHub connection of the company win over the binding", async () => {
      const run = await seed();
      const applicationId = randomUUID(),
        connectionId = randomUUID(),
        oauthSecretId = randomUUID();
      await db.insert(toolApplications).values({
        id: applicationId,
        companyId: run.companyId,
        name: applicationId,
        type: "mcp_http",
      });
      await db.insert(toolConnections).values({
        id: connectionId,
        companyId: run.companyId,
        applicationId,
        name: connectionId,
        uid: connectionId,
        transport: "mcp_remote",
        status: "active",
        enabled: true,
        credentialPolicy: "per_agent",
        config: { sourceTemplateKey: "github" },
      });
      await db.insert(toolConnectionInstalls).values({
        companyId: run.companyId,
        connectionId,
        targetType: "agent",
        targetId: run.agentId,
      });
      await db.insert(companySecrets).values({
        id: oauthSecretId,
        companyId: run.companyId,
        key: oauthSecretId,
        name: `OAuth ${oauthSecretId}`,
        scope: "company",
      });
      await db.insert(connectionGrants).values({
        id: randomUUID(),
        companyId: run.companyId,
        connectionId,
        kind: "agent",
        subjectAgentId: run.agentId,
        status: "active",
        credentialSecretRefs: [
          { secretId: oauthSecretId, configPath: "oauth.access_token", versionSelector: "latest" },
        ],
        providerTenant: {
          github: {
            userId: "42",
            login: "octo",
            installationCount: 1,
            repositoryCount: 1,
            repositorySelection: "selected",
            installationIds: ["1"],
            installationOwnerLogins: ["octo"],
          },
        },
      });
      const result = await resolve(run);
      expect(result).toMatchObject({ status: "available", source: "dedicated", login: "octo" });
      expect(result.env.GIT_AUTHOR_NAME).toBe("octo");
      expect(vault.resolveSecretValue).toHaveBeenCalledWith(
        run.companyId,
        oauthSecretId,
        "latest",
        expect.anything(),
      );
      expect(vault.resolveSecretValue).not.toHaveBeenCalledWith(
        run.companyId,
        run.secretId,
        expect.anything(),
        expect.anything(),
      );
    });
  },
);
