import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { resolvePaperclipInstanceRootForAdapter } from "../server-utils.js";

// acpx's file session store keeps a persistent session's record in
// `<stateDir>/sessions/<encodeURIComponent(recordId)>.json`, and a persistent
// record's id is its session key. acpx offers no call that deletes a record.

export function defaultPaperclipInstanceDir(): string {
  const home = process.env.PAPERCLIP_HOME?.trim() || path.join(os.homedir(), ".paperclip");
  const instanceId = process.env.PAPERCLIP_INSTANCE_ID?.trim() || "default";
  return resolvePaperclipInstanceRootForAdapter({
    homeDir: home,
    instanceId,
  });
}

/** The ACP engine's state directory for an agent, as the engine resolves it. */
export function acpxEngineStateDir(companyId: string, agentId: string, configuredStateDir?: string): string {
  const configured = configuredStateDir?.trim();
  return path.resolve(configured || path.join(defaultPaperclipInstanceDir(), "companies", companyId, "acp-engine", "agents", agentId));
}

function recordFile(stateDir: string, sessionKey: string): string {
  return path.join(stateDir, "sessions", `${encodeURIComponent(sessionKey)}.json`);
}

/** Remove the persistent record under one session key, if there is one. */
export async function removeAcpxSessionRecord(stateDir: string, sessionKey: string): Promise<void> {
  await fs.rm(recordFile(stateDir, sessionKey), { force: true });
}

/**
 * Remove an agent's persistent records, for one task key or for all of them,
 * whatever configuration fingerprint closes the key. Resolves the session
 * keys it removed.
 */
export async function removeAcpxSessionRecords(input: {
  stateDir: string;
  companyId: string;
  agentId: string;
  taskKey?: string | null;
}): Promise<string[]> {
  const prefix = `paperclip:${input.companyId}:${input.agentId}:${input.taskKey ? `${input.taskKey}:` : ""}`;
  let files: string[];
  try {
    files = await fs.readdir(path.join(input.stateDir, "sessions"));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
  const removed: string[] = [];
  for (const file of files) {
    if (!file.endsWith(".json")) continue;
    let sessionKey: string;
    try {
      sessionKey = decodeURIComponent(file.slice(0, -".json".length));
    } catch {
      continue;
    }
    if (!sessionKey.startsWith(prefix)) continue;
    // With a task key the rest is the fingerprint alone, so task key `a`
    // never matches the records of task key `a:b`.
    if (input.taskKey && sessionKey.slice(prefix.length).includes(":")) continue;
    await removeAcpxSessionRecord(input.stateDir, sessionKey);
    removed.push(sessionKey);
  }
  return removed;
}
