import { afterEach, describe, expect, it, vi } from "vitest";
import { recordedProcessIsGone, signalProbeProvesGone } from "./recorded-process-probe.js";

afterEach(() => vi.restoreAllMocks());

describe("stop proof for a recorded process identifier", () => {
  const denied = Object.assign(new Error("denied"), { code: "EPERM" });

  it.skipIf(process.platform === "win32")("takes a missing process and another user's process as gone, and holds on anything else", () => {
    expect(signalProbeProvesGone(Object.assign(new Error("missing"), { code: "ESRCH" }))).toBe(true);
    expect(signalProbeProvesGone(denied)).toBe(true);
    for (const error of [Object.assign(new Error("invalid"), { code: "EINVAL" }), new Error("unknown"), null, undefined]) {
      expect(signalProbeProvesGone(error)).toBe(false);
    }
  });

  it("holds on a denied probe where the same user's process can deny it", () => {
    const platform = Object.getOwnPropertyDescriptor(process, "platform")!;
    Object.defineProperty(process, "platform", { ...platform, value: "win32" });
    try {
      expect(signalProbeProvesGone(denied)).toBe(false);
      expect(signalProbeProvesGone(Object.assign(new Error("missing"), { code: "ESRCH" }))).toBe(true);
    } finally { Object.defineProperty(process, "platform", platform); }
  });

  it.skipIf(process.platform === "win32")("probes with signal 0 and never reports a process it can signal as gone", () => {
    const kill = vi.spyOn(process, "kill").mockImplementation(() => true);
    expect(recordedProcessIsGone(4242)).toBe(false);
    expect(recordedProcessIsGone(-4242)).toBe(false);
    expect(kill.mock.calls).toEqual([[4242, 0], [-4242, 0]]);
    kill.mockImplementation(() => { throw Object.assign(new Error("denied"), { code: "EPERM" }); });
    expect(recordedProcessIsGone(4242)).toBe(true);
    expect(recordedProcessIsGone(process.pid)).toBe(true);
    kill.mockRestore();
    expect(recordedProcessIsGone(process.pid)).toBe(false);
  });
});
