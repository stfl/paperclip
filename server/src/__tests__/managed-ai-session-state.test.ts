import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtemp, mkdir, readFile, writeFile, rm, readdir, realpath } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { linkManagedAiSessionState } from "../services/managed-ai-session-state.js";

let root: string;
afterEach(async () => {
  vi.unstubAllEnvs();
  if (root) await rm(root, { recursive: true, force: true });
});

describe("managed AI transcript storage", () => {
  it.each([["claude_local", "projects"], ["codex_local", "sessions"], ["codex_local", "archived_sessions"]])(
    "retains %s %s across cleanup without retaining credentials", async (harness, directory) => {
      root = await mkdtemp(path.join(os.tmpdir(), "managed-ai-state-test-"));
      vi.stubEnv("PAPERCLIP_HOME", root);
      vi.stubEnv("PAPERCLIP_KEPT_AI_SESSION_COMPANIES", "company, other");
      const linked = new Map<string, boolean>();
      const scope = { companyId: "company", agentId: "agent", grantId: "grant", responsibleUserId: "user", harness };
      async function prepare(overrides = {}) {
        const home = await mkdtemp(path.join(root, "run-"));
        await mkdir(path.join(home, "provider"));
        await writeFile(path.join(home, "provider", "auth.json"), "secret");
        linked.set(home, await linkManagedAiSessionState({ ...scope, ...overrides, home }));
        return home;
      }
      const first = await prepare();
      expect(linked.get(first)).toBe(true);
      const state = path.join(first, "provider", directory);
      const persistent = await realpath(state);
      await writeFile(path.join(state, "session.jsonl"), "conversation");
      await rm(first, { recursive: true, force: true });
      await expect(readFile(path.join(first, "provider", "auth.json"))).rejects.toMatchObject({ code: "ENOENT" });
      const second = await prepare();
      expect(await readFile(path.join(second, "provider", directory, "session.jsonl"), "utf8")).toBe("conversation");
      expect(await readdir(path.dirname(persistent))).not.toContain("auth.json");
      for (const overrides of [
        { companyId: "other" }, { agentId: "other" }, { grantId: "other" }, { responsibleUserId: "other" },
      ]) {
        const other = await prepare(overrides);
        expect(await readdir(path.join(other, "provider", directory))).toEqual([]);
      }
      const unlisted = await prepare({ companyId: "unlisted" });
      await expect(readdir(path.join(unlisted, "provider", directory))).rejects.toMatchObject({ code: "ENOENT" });
      expect(linked.get(unlisted)).toBe(false);
      // A probe for an agent that does not exist yet has no scope of its own.
      const probe = await prepare({ agentId: "" });
      await expect(readdir(path.join(probe, "provider", directory))).rejects.toMatchObject({ code: "ENOENT" });
      expect(linked.get(probe)).toBe(false);
      // Concurrent runs share transcripts but never the credential home.
      const concurrent = await prepare();
      expect(concurrent).not.toBe(second);
      expect(await realpath(path.join(concurrent, "provider", directory))).toBe(persistent);
    },
  );
});
