import type { Db } from "@paperclipai/db";
import { describe, expect, it, vi } from "vitest";

const stop = vi.hoisted(() => vi.fn<() => Promise<{ clause: string } | null>>(async () => null));
vi.mock("../../../services/heartbeat.js", () => ({ heartbeatService: () => ({ stopHoldForAgents: stop }) }));
vi.mock("../../../services/agent-harness-verification.js", () => ({ agentHarnessVerificationService: () => ({ verify: vi.fn() }) }));
import { createLifecycleDriver } from "../../../services/agent-lifecycle-driver.js";

describe("lifecycle host stop scope", () => {
  it("pauses only the requested agent without loading its company peers", async () => {
    const db = { select: vi.fn(() => { throw new Error("No peer lookup expected"); }) } as unknown as Db;
    const driver = createLifecycleDriver(db, {} as never);
    expect(await driver.runHost({ id: "target", companyId: "company", lifecycleState: "pausing",
      lifecycleVersion: 2, lifecycleRequiredPluginIds: [], lifecycleError: null, lifecycleOperation: null })).toBe("complete");
    expect(stop).toHaveBeenCalledWith(["target"], "Agent lifecycle stop requested");
    expect(db.select).not.toHaveBeenCalled();
  });

  it("names what a stop still waits for", async () => {
    stop.mockResolvedValueOnce({ clause: "process_alive" });
    const driver = createLifecycleDriver({} as Db, {} as never);
    expect(await driver.runHost({ id: "target", companyId: "company", lifecycleState: "pausing",
      lifecycleVersion: 2, lifecycleRequiredPluginIds: [], lifecycleError: null, lifecycleOperation: null }))
      .toEqual({ pending: "process_alive" });
  });
});
