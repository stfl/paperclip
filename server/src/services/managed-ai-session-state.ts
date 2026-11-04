import { createHash } from "node:crypto";
import { mkdir, symlink } from "node:fs/promises";
import path from "node:path";
import { resolvePaperclipInstanceRoot } from "../home-paths.js";

/** Link only harness transcript directories; auth/config files stay per-run. */
export async function linkManagedAiSessionState(input: {
  home: string;
  companyId: string;
  agentId: string;
  grantId: string;
  responsibleUserId: string | null;
  harness: string;
}): Promise<void> {
  const directories = input.harness === "claude_local" ? ["projects"]
    : input.harness === "codex_local" ? ["sessions", "archived_sessions"] : [];
  // Only the companies this instance names keep sessions; every other
  // company's runs keep per-run homes that the run's end deletes. The
  // test-environment probe of an agent not yet created passes agentId "";
  // every such probe would otherwise share one scope.
  const keptCompanies = (process.env.PAPERCLIP_KEPT_AI_SESSION_COMPANIES ?? "")
    .split(",").map((id) => id.trim()).filter(Boolean);
  if (!input.agentId || !directories.length || !keptCompanies.includes(input.companyId)) return;
  // Hash a tuple rather than interpolate IDs into paths. Include the responsible
  // user even for shared grants so another user's run cannot load these sessions.
  const scope = createHash("sha256").update(JSON.stringify([
    input.companyId, input.agentId, input.grantId, input.responsibleUserId, input.harness,
  ])).digest("hex");
  const root = path.join(resolvePaperclipInstanceRoot(), "managed-ai-sessions", input.companyId, scope);
  for (const directory of directories) {
    const target = path.join(root, directory);
    await mkdir(target, { recursive: true, mode: 0o700 });
    await symlink(target, path.join(input.home, "provider", directory), "dir");
  }
}
