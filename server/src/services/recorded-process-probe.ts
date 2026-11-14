import { readProcessStartedAt } from "./hot-restart.js";

export type RecordedProcessIdentity = {
  processPid: number | null;
  processGroupId: number | null;
  processStartedAt: Date | null;
};

type StartTimeReader = (pid: number) => Promise<string | null>;

// A start time read twice differs by less than this when the wall clock was
// adjusted in between, or when one reading has only whole-second precision.
// A reused identifier belongs to a process born much later.
const SAME_START_TOLERANCE_MS = 1_000;

/**
 * Stop proof for a process identifier this server recorded for a finished
 * execution on its own host. Pass a negative identifier for a process group.
 *
 * The server starts those processes as its own user, so a refused signal
 * (EPERM) says the number belongs to another user's process. That is still the
 * recorded process when a privilege wrapper started it, so the start time
 * decides:
 * - it is the recorded start time: the recorded process is alive;
 * - it differs: the identifier was reused and the recorded process is gone;
 * - it is readable but nothing was recorded to compare it with: unknown, holds;
 * - it is unreadable: gone. A host that hides other users' processes from the
 *   server leaves nothing to tell a reused identifier from a process started
 *   under another user, and there an unrelated process would hold forever. On
 *   such a host a process started under another user is therefore taken as gone.
 * Any other failure stays unknown and holds.
 *
 * Windows also answers EPERM for a process of the same user that the caller may
 * not open, so there it proves nothing.
 *
 * Do not use this for an execution still recorded as running: there a wrong
 * "gone" would admit a second executor. Do not use it for identifiers recorded
 * in a provider environment: they name nothing in this host's process table.
 */
export async function signalProbeProvesGone(
  error: unknown,
  pid: number,
  recordedStartedAt: Date | null | undefined,
  readStartedAt: StartTimeReader = readProcessStartedAt,
): Promise<boolean> {
  const code = (error as NodeJS.ErrnoException | null)?.code;
  if (code === "ESRCH") return true;
  if (code !== "EPERM" || process.platform === "win32") return false;
  const observed = await readStartedAt(Math.abs(pid)).catch(() => null);
  const observedAt = observed ? new Date(observed).getTime() : Number.NaN;
  if (Number.isNaN(observedAt)) return true;
  return Boolean(recordedStartedAt) &&
    Math.abs(observedAt - recordedStartedAt!.getTime()) >= SAME_START_TOLERANCE_MS;
}

/** Signal 0 only probes. */
export async function recordedProcessIsGone(
  pid: number,
  recordedStartedAt: Date | null | undefined,
  readStartedAt?: StartTimeReader,
): Promise<boolean> {
  try { process.kill(pid, 0); return false; }
  catch (error) { return signalProbeProvesGone(error, pid, recordedStartedAt, readStartedAt); }
}

/** A run records the start time of its process. That time identifies the
 * process group as well only when the process leads the group. */
export function recordedGroupStartedAt(identity: RecordedProcessIdentity): Date | null {
  return identity.processGroupId === identity.processPid ? identity.processStartedAt : null;
}

export async function recordedProcessTreeIsGone(identity: RecordedProcessIdentity): Promise<boolean> {
  return (!identity.processPid || await recordedProcessIsGone(identity.processPid, identity.processStartedAt)) &&
    (!identity.processGroupId || await recordedProcessIsGone(-identity.processGroupId, recordedGroupStartedAt(identity)));
}
