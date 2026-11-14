import { describe, expect, it, vi } from "vitest";
import { createLifecycleWorker } from "../application/worker.js";
import type { LifecycleAgent, LifecycleDriver, LifecycleHostResult, LifecycleStore } from "../application/ports.js";
import { lifecycleWaitMessage } from "../application/failure.js";
import { isLifecycleWaitOverdue } from "../domain/policy.js";

function pausing(attempts: number): LifecycleAgent {
  return { id: "agent", companyId: "company", lifecycleState: "pausing", lifecycleVersion: 7,
    lifecycleRequiredPluginIds: [], lifecycleError: null,
    lifecycleOperation: { id: "operation", hostComplete: false, completedPluginIds: [], attempts } };
}

function fixture(agent: LifecycleAgent, host: LifecycleHostResult) {
  const store = { get: vi.fn(), claim: vi.fn().mockResolvedValue(agent), renew: vi.fn().mockResolvedValue(true),
    setRequiredPlugins: vi.fn().mockResolvedValue(true), completeHost: vi.fn().mockResolvedValue(true),
    completePlugin: vi.fn().mockResolvedValue(true), defer: vi.fn().mockResolvedValue(true),
    change: vi.fn().mockResolvedValue({ ...agent, lifecycleState: "paused", lifecycleOperation: null }),
    pending: vi.fn().mockResolvedValue([agent.id]) } satisfies LifecycleStore;
  const driver = { requiredPluginIds: vi.fn().mockResolvedValue([]), runHost: vi.fn().mockResolvedValue(host),
    runPlugin: vi.fn().mockResolvedValue("complete") } satisfies LifecycleDriver;
  return { store, driver, worker: createLifecycleWorker(store, driver, vi.fn()) };
}

const firstOverdue = (() => { let attempts = 1; while (!isLifecycleWaitOverdue(attempts)) attempts++; return attempts; })();

describe("a lifecycle host step that keeps waiting", () => {
  it("retries a young wait without a report", async () => {
    const { store, worker } = fixture(pausing(firstOverdue - 1), { pending: "process_alive" });
    await worker.process("agent");
    expect(store.defer).toHaveBeenCalledWith(expect.anything(), expect.any(String), null, expect.any(Date));
    expect(store.completeHost).not.toHaveBeenCalled();
    await worker.stop();
  });

  it("reports an overdue wait with the key of what it waits for, and keeps the step pending", async () => {
    const { store, worker } = fixture(pausing(firstOverdue), { pending: "process_alive" });
    await worker.process("agent");
    const report = store.defer.mock.calls[0]![2] as { wait: string };
    // A wait is reported apart from a failure, which is a plain message.
    expect(report).toEqual({ wait: lifecycleWaitMessage({ stage: "host", phase: "pausing" }, "process_alive") });
    const message = report.wait;
    expect(message).toContain("Stopping agent execution is still waiting");
    expect(message).toContain("(process_alive)");
    expect(store.completeHost).not.toHaveBeenCalled();
    expect(store.change).not.toHaveBeenCalled();
    await worker.stop();
  });

  it("stays silent when the step names nothing it waits for", async () => {
    const { store, worker } = fixture(pausing(firstOverdue * 10), "pending");
    await worker.process("agent");
    expect(store.defer).toHaveBeenCalledWith(expect.anything(), expect.any(String), null, expect.any(Date));
    await worker.stop();
  });

  it("completes the operation once the step no longer waits", async () => {
    const { store, worker } = fixture(pausing(firstOverdue * 10), "complete");
    await worker.process("agent");
    expect(store.defer).not.toHaveBeenCalled();
    expect(store.completeHost).toHaveBeenCalledOnce();
    expect(store.change).toHaveBeenCalledWith("agent", "complete", expect.objectContaining({ version: 7 }));
    await worker.stop();
  });

  it("does not echo a key outside the known vocabulary", () => {
    const message = lifecycleWaitMessage({ stage: "host", phase: "pausing" }, "token=secret");
    expect(message).not.toContain("secret");
    expect(message).toContain("still waiting");
  });
});
