import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { execute } from "./execute.js";

// Stands in for the server's managed AI runtime: each run gets a fresh
// provider home, and a company that keeps sessions has its transcript
// directories linked to one durable per-scope directory.
const FAKE_CODEX = `#!/usr/bin/env node
const fs = require("node:fs");
const path = require("node:path");
const home = process.env.CODEX_HOME;
const sessions = path.join(home, "sessions");
const resumed = process.argv.includes("resume");
const found = fs.existsSync(sessions) ? fs.readdirSync(sessions) : [];
fs.writeFileSync(process.env.PAPERCLIP_TEST_CAPTURE_PATH, JSON.stringify({ codexHome: home, resumed, found }));
fs.mkdirSync(sessions, { recursive: true });
fs.writeFileSync(path.join(sessions, "rollout-" + process.env.PAPERCLIP_TEST_RUN + ".jsonl"), "{}\\n");
console.log(JSON.stringify({ type: "thread.started", thread_id: "kept-thread-1" }));
console.log(JSON.stringify({ type: "item.completed", item: { type: "agent_message", text: "ok" } }));
console.log(JSON.stringify({ type: "turn.completed", usage: { input_tokens: 1, cached_input_tokens: 0, output_tokens: 1 } }));
`;

type Capture = { codexHome: string; resumed: boolean; found: string[] };

const ENV_KEYS = ["PAPERCLIP_HOME", "PAPERCLIP_INSTANCE_ID", "CODEX_HOME"] as const;
const savedEnv = Object.fromEntries(ENV_KEYS.map((key) => [key, process.env[key]]));
const roots: string[] = [];

afterEach(async () => {
  for (const key of ENV_KEYS) {
    if (savedEnv[key] === undefined) delete process.env[key];
    else process.env[key] = savedEnv[key];
  }
  await Promise.all(roots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })));
});

async function setup() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-codex-kept-sessions-"));
  roots.push(root);
  const workspace = path.join(root, "workspace");
  const command = path.join(root, "codex");
  const skillSource = path.join(root, "skill");
  const paperclipHome = path.join(root, "paperclip");
  await fs.mkdir(workspace, { recursive: true });
  await fs.mkdir(skillSource, { recursive: true });
  await fs.writeFile(path.join(skillSource, "SKILL.md"), "# Fixture skill\n");
  await fs.writeFile(command, FAKE_CODEX, { mode: 0o755 });
  process.env.PAPERCLIP_HOME = paperclipHome;
  process.env.PAPERCLIP_INSTANCE_ID = "kept";
  const keptRoot = path.join(paperclipHome, "instances", "kept", "managed-ai-sessions", "company-1", "scope-a");
  return { root, workspace, command, skillSource, keptRoot };
}

async function run(
  env: Awaited<ReturnType<typeof setup>>,
  runId: string,
  options: { keep: boolean; sessionId?: string },
): Promise<Capture> {
  const providerHome = path.join(env.root, runId, "provider");
  await fs.mkdir(providerHome, { recursive: true });
  await fs.writeFile(path.join(providerHome, "auth.json"), JSON.stringify({ OPENAI_API_KEY: "sk-test-kept" }));
  if (options.keep) {
    for (const directory of ["sessions", "archived_sessions"]) {
      await fs.mkdir(path.join(env.keptRoot, directory), { recursive: true });
      await fs.symlink(path.join(env.keptRoot, directory), path.join(providerHome, directory), "dir");
    }
  }
  process.env.CODEX_HOME = providerHome;
  const capture = path.join(env.root, `${runId}.json`);
  const config = {
    engine: "cli", command: env.command, cwd: env.workspace,
    env: { CODEX_HOME: providerHome, PAPERCLIP_TEST_CAPTURE_PATH: capture, PAPERCLIP_TEST_RUN: runId },
    paperclipSkillSync: { desiredSkills: ["fixture/skill"] },
    paperclipRuntimeSkills: [{ key: "fixture/skill", runtimeName: "fixture-skill", source: env.skillSource }],
  };
  const sessionId = options.sessionId ?? null;
  const result = await execute({
    runId,
    agent: { id: "agent-1", companyId: "company-1", name: "Kept agent", adapterType: "codex_local", adapterConfig: config },
    runtime: {
      sessionId, sessionParams: sessionId ? { sessionId, cwd: env.workspace } : null, sessionDisplayId: sessionId, taskKey: null,
    },
    config, context: {}, authToken: "test-token", onLog: async () => {},
  });
  expect(result.errorMessage).toBeNull();
  expect(result.exitCode).toBe(0);
  return JSON.parse(await fs.readFile(capture, "utf8")) as Capture;
}

describe("codex execute with runtime skills and a per-run provider home", () => {
  it("resumes from the kept session directory when the provider home links it", async () => {
    const env = await setup();
    const first = await run(env, "run-1", { keep: true });
    expect(first.codexHome).toContain(path.join("skill-runtimes", "agent-1"));
    const second = await run(env, "run-2", { keep: true, sessionId: "kept-thread-1" });
    expect(second.resumed).toBe(true);
    expect(second.found).toContain("rollout-run-1.jsonl");
    for (const directory of ["sessions", "archived_sessions"]) {
      expect(await fs.realpath(path.join(second.codexHome, directory)))
        .toBe(await fs.realpath(path.join(env.keptRoot, directory)));
    }
  });

  it("keeps each run's transcripts in its own home when the provider home links nothing", async () => {
    const env = await setup();
    const first = await run(env, "run-1", { keep: false });
    const second = await run(env, "run-2", { keep: false, sessionId: "kept-thread-1" });
    expect(second.codexHome).not.toBe(first.codexHome);
    expect(second.found).toEqual([]);
    for (const directory of ["sessions", "archived_sessions"]) {
      const entry = await fs.lstat(path.join(second.codexHome, directory)).catch(() => null);
      expect(entry?.isSymbolicLink() ?? false).toBe(false);
    }
  });

  it("ignores provider-home links that point outside this company's kept sessions", async () => {
    const env = await setup();
    env.keptRoot = path.join(env.root, "elsewhere");
    await run(env, "run-1", { keep: true });
    const second = await run(env, "run-2", { keep: true, sessionId: "kept-thread-1" });
    expect(second.found).toEqual([]);
    const entry = await fs.lstat(path.join(second.codexHome, "sessions"));
    expect(entry.isSymbolicLink()).toBe(false);
  });
});
