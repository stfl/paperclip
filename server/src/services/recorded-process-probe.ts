/**
 * Stop proof for a process identifier this server recorded for a finished
 * execution on its own host. The server starts those processes as its own user,
 * so it may always signal them. EPERM therefore means the number now belongs to
 * another user's process: the recorded process is gone and the identifier was
 * reused. Any other failure stays unknown and holds.
 *
 * Windows also answers EPERM for a process of the same user that the caller may
 * not open, so there it proves nothing.
 *
 * Do not use this for an execution still recorded as running: there a wrong
 * "gone" would admit a second executor.
 */
export function signalProbeProvesGone(error: unknown): boolean {
  const code = (error as NodeJS.ErrnoException | null)?.code;
  return code === "ESRCH" || (code === "EPERM" && process.platform !== "win32");
}

/** Signal 0 only probes. A negative identifier probes a process group. */
export function recordedProcessIsGone(pid: number): boolean {
  try { process.kill(pid, 0); return false; }
  catch (error) { return signalProbeProvesGone(error); }
}
