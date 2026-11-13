import type { AcpRuntimeStatus } from "acpx/runtime";

/** Use provider-selected IDs, including its default. A mid-turn model change
 * cannot be priced as a single-model receipt; never guess from a display name.
 *
 * `preferRequested` names the model the run asked for instead: a bridge that
 * maps the request onto a fixed picker reports that picker's alias as its
 * current model, not the id the endpoint received. With no requested model
 * there is nothing true to name, so the result is null; the runtime status
 * carries no other model field. */
export function acpxAccountingModel(
  requested: string,
  before: AcpRuntimeStatus | null,
  after: AcpRuntimeStatus | null,
  options: { preferRequested?: boolean } = {},
): string | null {
  if (options.preferRequested) return requested.trim() || null;
  const pre = before?.models?.currentModelId?.trim();
  const post = after?.models?.currentModelId?.trim();
  if (pre && post && pre !== post) return null;
  return post || pre || requested.trim() || null;
}
