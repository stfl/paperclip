import type { LifecycleFailure } from "./ports.js";

// Only fixed text may leave this boundary. Provider errors can contain secrets.
const reasons = {
  harness_test_failed: "The execution test did not pass. Open Configuration and run the agent test to inspect the failed checks.",
  harness_auth_failed: "Authentication failed. Check the agent's AI connection or sign in to its execution tool, then retry.",
  harness_model_unavailable: "The selected model is unavailable. Choose a model supported by the agent's AI connection in Configuration, then retry.",
  harness_command_unavailable: "The execution command was not found. Check the command and its installation in the agent's environment, then retry.",
  harness_cwd_invalid: "The working directory is unavailable. Check the working directory in Configuration, then retry.",
  harness_probe_timed_out: "The execution test timed out. Paperclip will retry automatically. If this continues, run the agent test in Configuration.",
  harness_probe_unexpected_output: "The execution test did not return the expected response. Run the agent test in Configuration to inspect the failed checks.",
  test_environment_unavailable: "The test environment is unavailable. Check the agent's environment in Configuration. Paperclip will retry automatically.",
  required_plugin_unavailable: "A required plugin is unavailable. Check the plugin's status in Settings. Paperclip will retry automatically.",
  invalid_lifecycle_result: "A required plugin returned an invalid result. Check the plugin's status in Settings. Paperclip will retry automatically.",
} as const;

const transientCodes = new Set(["ECONNREFUSED", "ECONNRESET", "ETIMEDOUT", "40001", "40P01", "53300", "57P01"]);

export function lifecycleFailureCode(error: unknown): string | undefined {
  const candidate = error as { code?: unknown; cause?: { code?: unknown } } | null;
  return [candidate?.code, candidate?.cause?.code].find((code): code is string =>
    typeof code === "string" && (Object.hasOwn(reasons, code) || transientCodes.has(code)));
}

const phases = {
  preparing: "Agent preparation", verifying: "Execution configuration check", pausing: "Stopping agent execution",
  resuming: "Starting agent resources", terminating: "Stopping agent execution", cleaning_up: "Agent resource cleanup",
};

function phaseLabel(context: LifecycleFailure): string {
  return context.phase && Object.hasOwn(phases, context.phase)
    ? phases[context.phase as keyof typeof phases] : "Agent setup";
}

const waits = {
  run_active: "a run is still executing",
  controller_lease_active: "the controller of a finished run has not released it",
  lease_unreleased: "the environment of a previous run has not been released",
  remote_stop_unconfirmed: "the environment of a cancelled run has not confirmed that it stopped",
  process_alive: "a process recorded for a previous run still appears to be running",
  native_stop_unrecorded: "a cancelled run has no record that its process stopped",
  legacy_stop_unrecorded: "a cancelled run has no record that its process stopped",
  finalization_owner_active: "a previous run is still being finalized",
  finalization_controller_alive: "the controller finalizing a previous run still appears to be running",
  finalization_owner_changed: "the finalization of a previous run changed while it was checked",
} as const;

/** The key is a driver's closed vocabulary. An unknown key is not echoed. */
export function lifecycleWaitMessage(context: LifecycleFailure, wait: string): string {
  const cause = Object.hasOwn(waits, wait) ? `${waits[wait as keyof typeof waits]} (${wait})` : "an earlier step has not finished";
  return `${phaseLabel(context)} is still waiting: ${cause}. Paperclip keeps retrying. If this continues, contact your instance administrator.`;
}

export function lifecycleFailureMessage(context: LifecycleFailure, error: unknown): string {
  const phase = phaseLabel(context);
  const step = context.stage === "plugin" ? `${phase}: required plugin step`
    : context.stage === "select_plugins" ? `${phase}: finding required plugins`
    : ["save_plugins", "complete_host", "complete_plugin", "transition"].includes(context.stage)
      ? `${phase}: saving progress` : phase;
  const code = lifecycleFailureCode(error);
  const reason = code && Object.hasOwn(reasons, code) ? reasons[code as keyof typeof reasons]
    : "Paperclip could not complete this step. It will retry automatically. If this continues, contact your instance administrator.";
  return `${step} failed. ${reason}`;
}
