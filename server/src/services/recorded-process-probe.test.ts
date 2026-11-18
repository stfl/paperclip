import { afterEach, describe, expect, it, vi } from "vitest";
import { recordedProcessIsGone, recordedProcessTreeIsGone, signalProbeProvesGone } from "./recorded-process-probe.js";

afterEach(() => vi.restoreAllMocks());

const failure = (code: string) => Object.assign(new Error(code), { code });
const recorded = new Date("2026-01-01T00:00:00.000Z");
const other = new Date("2026-01-01T00:00:01.000Z");
const reads = (startedAt: Date | null) => vi.fn(async () => {
  if (!startedAt) throw new Error("hidden");
  return startedAt.toISOString();
});

describe("stop proof for a recorded process identifier", () => {
  it("takes a missing process as gone and holds on a failure that proves nothing", async () => {
    const read = reads(recorded);
    expect(await signalProbeProvesGone(failure("ESRCH"), 4242, recorded, read)).toBe(true);
    for (const error of [failure("EINVAL"), new Error("unknown"), null, undefined]) {
      expect(await signalProbeProvesGone(error, 4242, other, read)).toBe(false);
    }
    expect(read).not.toHaveBeenCalled();
  });

  it.skipIf(process.platform === "win32").each([
    { case: "the recorded process under another user", observed: recorded, known: recorded, gone: false },
    { case: "the recorded process after a small clock adjustment", observed: new Date(recorded.getTime() + 400), known: recorded, gone: false },
    { case: "a reused identifier", observed: other, known: recorded, gone: true },
    { case: "a visible process with no recorded start time", observed: recorded, known: null, gone: false },
    { case: "a process the server cannot see", observed: null, known: recorded, gone: true },
    { case: "a process the server cannot see and never timed", observed: null, known: null, gone: true },
  ])("decides a denied probe by the start time: $case", async ({ observed, known, gone }) => {
    const read = reads(observed);
    expect(await signalProbeProvesGone(failure("EPERM"), 4242, known, read)).toBe(gone);
    expect(read).toHaveBeenCalledWith(4242);
  });

  it.skipIf(process.platform === "win32")("reads the group leader for a denied group probe", async () => {
    const read = reads(recorded);
    expect(await signalProbeProvesGone(failure("EPERM"), -4242, recorded, read)).toBe(false);
    expect(read).toHaveBeenCalledWith(4242);
  });

  it("holds on a denied probe where the same user's process can deny it", async () => {
    const platform = Object.getOwnPropertyDescriptor(process, "platform")!;
    Object.defineProperty(process, "platform", { ...platform, value: "win32" });
    try {
      const read = reads(null);
      expect(await signalProbeProvesGone(failure("EPERM"), 4242, recorded, read)).toBe(false);
      expect(await signalProbeProvesGone(failure("ESRCH"), 4242, recorded, read)).toBe(true);
      expect(read).not.toHaveBeenCalled();
    } finally { Object.defineProperty(process, "platform", platform); }
  });

  it.skipIf(process.platform === "win32")("probes with signal 0 and never reports a process it can signal as gone", async () => {
    const read = reads(other);
    const kill = vi.spyOn(process, "kill").mockImplementation(() => true);
    expect(await recordedProcessIsGone(4242, recorded, read)).toBe(false);
    expect(await recordedProcessIsGone(-4242, recorded, read)).toBe(false);
    expect(kill.mock.calls).toEqual([[4242, 0], [-4242, 0]]);
    expect(read).not.toHaveBeenCalled();
    kill.mockImplementation(() => { throw failure("EPERM"); });
    expect(await recordedProcessIsGone(4242, recorded, read)).toBe(true);
    expect(await recordedProcessIsGone(4242, other, read)).toBe(false);
  });

  it.skipIf(process.platform !== "linux")("reads this host's process table by default", async () => {
    vi.spyOn(process, "kill").mockImplementation(() => { throw failure("EPERM"); });
    // The test process is visible to itself; the second number is above any the kernel hands out.
    expect(await recordedProcessIsGone(process.pid, null)).toBe(false);
    expect(await recordedProcessIsGone(process.pid, new Date(0))).toBe(true);
    expect(await recordedProcessIsGone(2_000_000_101, recorded)).toBe(true);
  });

  it.skipIf(process.platform !== "linux")("identifies a group by the recorded start time only when the process leads it", async () => {
    vi.spyOn(process, "kill").mockImplementation(((pid: number) => {
      if (pid > 0) throw failure("ESRCH");
      throw failure("EPERM");
    }) as typeof process.kill);
    // The group probe is denied and its leader, this test process, is visible.
    const led = { processPid: process.pid, processGroupId: process.pid, processStartedAt: new Date(0) };
    expect(await recordedProcessTreeIsGone(led)).toBe(true);
    expect(await recordedProcessTreeIsGone({ ...led, processPid: process.pid + 1 })).toBe(false);
    expect(await recordedProcessTreeIsGone({ processPid: null, processGroupId: null, processStartedAt: null })).toBe(true);
  });
});
