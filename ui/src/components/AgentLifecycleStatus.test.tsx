// @vitest-environment jsdom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { renderToStaticMarkup } from "react-dom/server";
import type { AgentLifecycleState } from "@paperclipai/shared";
import { expect, it, vi } from "vitest";
import { AgentLifecycleStatus, agentLifecycleRefetchInterval } from "./AgentLifecycleStatus";

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

it.each([
  ["preparing", "Preparing agent"], ["verifying", "Verifying agent"],
  ["pausing", "Pausing agent"], ["resuming", "Resuming agent"],
  ["terminating", "Terminating agent"], ["cleaning_up", "Cleaning up agent"],
] as const)("shows and refreshes %s, including incomplete termination", (lifecycleState, label) => {
  const html = renderToStaticMarkup(<AgentLifecycleStatus agent={{ lifecycleState, lifecycleError: null }} onRetry={() => {}} retryPending={false} />);
  expect(html).toContain(label);
  expect(html).toContain('role="status"');
  expect(html).toContain('aria-hidden="true"');
  expect(html).not.toContain("Retry");
  expect(agentLifecycleRefetchInterval(lifecycleState)).toBe(2_000);
});

it.each([undefined, "ready", "paused", "pending_approval", "terminated", "rejected"] as const)("removes progress for %s while still checking for external changes", lifecycleState => {
  expect(renderToStaticMarkup(<AgentLifecycleStatus agent={{ lifecycleState, lifecycleError: null }} onRetry={() => {}} retryPending={false} />)).toBe("");
  expect(agentLifecycleRefetchInterval(lifecycleState)).toBe(30_000);
});

it("retries a failed step once while pending and removes the failure after recovery", async () => {
  const container = document.createElement("div");
  const root = createRoot(container);
  const retry = vi.fn();
  const agent = { lifecycleState: "cleaning_up" as AgentLifecycleState, lifecycleError: "The lifecycle step failed. Retry the operation." };
  try {
    await act(async () => root.render(<AgentLifecycleStatus agent={agent} onRetry={retry} retryPending={false} />));
    expect(container.textContent).toContain(agent.lifecycleError);
    expect(container.textContent).toContain("Agent cleanup failed");
    expect(container.textContent).toContain("Paperclip retries automatically");
    expect(container.textContent).not.toContain("Required resources are being removed");
    await act(async () => container.querySelector("button")!.click());
    expect(retry).toHaveBeenCalledOnce();
    await act(async () => root.render(<AgentLifecycleStatus agent={agent} onRetry={retry} retryPending />));
    expect(container.querySelector("button")!.disabled).toBe(true);
    await act(async () => container.querySelector("button")!.click());
    expect(retry).toHaveBeenCalledOnce();
    await act(async () => root.render(<AgentLifecycleStatus agent={{ lifecycleState: "terminated", lifecycleError: null }} onRetry={retry} retryPending={false} />));
    expect(container.textContent).toBe("");
  } finally { await act(async () => root.unmount()); }
});

it("shows a long wait as progress, not as a failure, and offers an immediate check", async () => {
  const container = document.createElement("div");
  const root = createRoot(container);
  const retry = vi.fn();
  const lifecycleWait = "Stopping agent execution is still waiting: a run is still executing (run_active). Paperclip keeps retrying.";
  try {
    await act(async () => root.render(<AgentLifecycleStatus agent={{ lifecycleState: "pausing", lifecycleError: null, lifecycleWait }} onRetry={retry} retryPending={false} />));
    expect(container.textContent).toContain("Pausing agent");
    expect(container.textContent).toContain(lifecycleWait);
    expect(container.textContent).not.toContain("Agent pause failed");
    expect(container.querySelector(".text-destructive")).toBeNull();
    expect(container.querySelector('[aria-hidden="true"]')).not.toBeNull();
    await act(async () => container.querySelector("button")!.click());
    expect(retry).toHaveBeenCalledOnce();
    // A failed step takes precedence over an earlier wait.
    await act(async () => root.render(<AgentLifecycleStatus agent={{ lifecycleState: "pausing", lifecycleError: "The lifecycle step failed.", lifecycleWait }} onRetry={retry} retryPending={false} />));
    expect(container.textContent).toContain("Agent pause failed");
    expect(container.textContent).not.toContain(lifecycleWait);
  } finally { await act(async () => root.unmount()); }
});
