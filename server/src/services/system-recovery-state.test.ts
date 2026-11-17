import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { createSystemRecovery, failSystemRecovery, readSystemRecovery, reserveSystemRecoveryAttempt, SYSTEM_RECOVERY_WINDOW_MS, SystemRecoveryFailure } from "./system-recovery-state.js";

describe("durable system recovery budget", () => {
  it("makes six attempts with exponential delays that survive serialization and exhaustion", () => {
    let state = createSystemRecovery(randomUUID());
    let now = 1_000;
    for (let attempt = 0; attempt < 6; attempt++) {
      state = reserveSystemRecoveryAttempt(state, now)!;
      expect(state.attempts).toBe(attempt + 1);
      state = failSystemRecovery(state, new SystemRecoveryFailure("export_interrupted", "retry_transient"), { now });
      state = readSystemRecovery(JSON.parse(JSON.stringify({ systemRecovery: state })))!;
      if (attempt < 5) {
        const base = 30_000 * 2 ** attempt;
        expect(state.nextAttemptAt! - now).toBeGreaterThanOrEqual(base * 0.8);
        expect(state.nextAttemptAt! - now).toBeLessThanOrEqual(base * 1.2);
        expect(reserveSystemRecoveryAttempt(state, state.nextAttemptAt! - 1)).toBeNull();
        now = state.nextAttemptAt!;
      }
    }
    expect(state.state).toBe("exhausted");
    expect(state.retriesUsed).toBe(5);
    expect(reserveSystemRecoveryAttempt(state, now + 1_000_000)).toBeNull();
  });
  it("never retries ahead of a provider cooldown or after the generation deadline", () => {
    const state = reserveSystemRecoveryAttempt(createSystemRecovery(randomUUID()), 0)!;
    const later = failSystemRecovery(state, new SystemRecoveryFailure("provider_unavailable", "retry_transient"),
      { now: 0, retryAfterAt: 120_000 });
    expect(later.nextAttemptAt).toBe(120_000);
    expect(reserveSystemRecoveryAttempt(later, 30 * 60_000)).toBeNull();
    expect(failSystemRecovery(state, new SystemRecoveryFailure("provider_unavailable", "retry_transient"),
      { now: 0, retryAfterAt: 31 * 60_000 }).state).toBe("exhausted");
  });
  it("reconciles a recorded attempt after restart without spending another retry", () => {
    const running = reserveSystemRecoveryAttempt(createSystemRecovery(randomUUID()), 0)!;
    const restarted = readSystemRecovery(JSON.parse(JSON.stringify({ systemRecovery: running })))!;
    expect(reserveSystemRecoveryAttempt(restarted, 60_000)).toMatchObject({
      attemptId: running.attemptId, attempts: 1, retriesUsed: 0,
    });
  });
  it("keeps an invalid ownership binding out of the physical retry loop", () => {
    const state = failSystemRecovery(createSystemRecovery(randomUUID()),
      new SystemRecoveryFailure("source_binding_invalid", "service_required"));
    expect(state).toMatchObject({ state: "exhausted", nextAttemptAt: null,
      failure: { code: "source_binding_invalid", retryClass: "service_required" } });
  });
  it("waits for another run on the task past the retry window without spending a retry", () => {
    const writer = new SystemRecoveryFailure("workspace_writer_active", "recheck_evidence");
    let state = createSystemRecovery(randomUUID());
    let now = 0;
    state = reserveSystemRecoveryAttempt(state, now)!;
    state = failSystemRecovery(state, new SystemRecoveryFailure("provider_unavailable", "retry_transient"), { now });
    for (let attempt = 0; attempt < 12; attempt++) {
      now = Math.max(now + 5 * 60_000, state.nextAttemptAt!);
      state = reserveSystemRecoveryAttempt(state, now)!;
      expect(state).not.toBeNull();
      state = failSystemRecovery(state, writer, { now });
      state = readSystemRecovery(JSON.parse(JSON.stringify({ systemRecovery: state })))!;
      expect(state).toMatchObject({ state: "awaiting_evidence", retriesUsed: 1, deadlineAt: null,
        failure: { code: "workspace_writer_active" } });
      expect(state.nextAttemptAt! - now).toBeLessThanOrEqual(30_000);
    }
    expect(now).toBeGreaterThan(SYSTEM_RECOVERY_WINDOW_MS);
    // A real failure once the other run has ended still has the rest of its budget.
    state = reserveSystemRecoveryAttempt(state, state.nextAttemptAt!)!;
    expect(state.retriesUsed).toBe(1);
    state = failSystemRecovery(state, new SystemRecoveryFailure("provider_unavailable", "retry_transient"), { now: state.nextAttemptAt ?? now });
    expect(state.state).toBe("scheduled");
  });
  it("reads prior incident metadata without losing the local recovery budget or failure", () => {
    const state = failSystemRecovery(createSystemRecovery(randomUUID()),
      new SystemRecoveryFailure("source_unavailable", "service_required"), { now: 1_000 });
    const restored = readSystemRecovery({ systemRecovery: { ...state,
      incident: { status: "pending", id: null, attempts: 2, nextDeliveryAt: 60_000 },
    }, recoveryIncidentDelivery: { attempts: 2, nextAttemptAt: 60_000 } });
    expect(restored).toEqual(state);
    expect(reserveSystemRecoveryAttempt(restored!, 61_000)).toBeNull();
  });

});
