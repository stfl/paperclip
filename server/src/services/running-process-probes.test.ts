import { afterEach, describe, expect, it, vi } from "vitest";
import { localProcessAbsent } from "./heartbeat/case-handoff-lifecycle.js";
import { hasStoppedLocalProcessTree } from "./heartbeat/process-settlement.js";
import { isProcessAlive } from "./heartbeat/recovery.js";
import { evaluateNativeControllerTakeover } from "./native-runtime/native-restart-recovery.js";

afterEach(() => vi.restoreAllMocks());

const PID = 2_000_000_103;
const denied = () => { throw Object.assign(new Error("EPERM"), { code: "EPERM" }); };

// These probes decide whether an execution still recorded as running, or a
// process whose scratch is about to be removed, is alive. A wrong "gone" there
// admits a second executor, so a signal the server may not send means alive.
describe.skipIf(process.platform === "win32")("probes that keep a denied signal as alive", () => {
  const sites: Record<string, () => boolean | Promise<boolean>> = {
    "restart recovery of a running run": () => isProcessAlive(PID),
    "settlement of a legacy process tree": () => !hasStoppedLocalProcessTree(
      { processPid: PID, processGroupId: PID, processStartedAt: new Date(0) }, denied),
    "case handoff scratch cleanup": () => !localProcessAbsent(PID) && !localProcessAbsent(-PID),
    "takeover from a native controller": async () => !(await evaluateNativeControllerTakeover({
      owner: { leaseOwner: "previous-server", leaseExpiresAt: new Date(0), controllerPid: PID, controllerProcessStartedAt: null },
      now: new Date(), readProcessStartedAt: async () => null,
    })).allowed,
  };

  it.each(Object.keys(sites))("%s", async site => {
    const kill = vi.spyOn(process, "kill").mockImplementation(denied as typeof process.kill);
    expect(await sites[site]!()).toBe(true);
    if (!site.startsWith("settlement")) expect(kill).toHaveBeenCalledWith(expect.any(Number), 0);
  });
});
