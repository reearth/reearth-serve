/**
 * The SPA fallback opt-in (ADR-013 C1).
 *
 * The write itself is one boolean column, so it rides along inside
 * `updateAsset`; what lives here is the rule about *which* assets may carry it,
 * which is the same rule `access` applies (B7) for the same reasons.
 */

import type { AssetMetadata } from "../model";

export type SpaCheckResult =
  | { ok: true }
  | { ok: false; status: 400; error: string };

/**
 * May `asset` have its SPA fallback turned on?
 *
 * - **Archive assets only.** The fallback serves the archive's root
 *   `index.html`; a single-file asset has no root and no index, so the flag
 *   would be a promise nothing backs. The same rule already governs named sites
 *   (B2) and protection (B7).
 * - **Project assets only**, as for protection: a demo asset is anonymous and
 *   expires in an hour, and hosting behaviour belongs to something with an
 *   owner.
 *
 * Turning it **off** is always allowed, whatever the asset is — a row that
 * somehow acquired the flag must never be stuck with it because it fails a
 * check the on-path applies.
 */
export function checkSpaChange(asset: AssetMetadata, spa: boolean): SpaCheckResult {
  if (!spa) return { ok: true };
  if (!asset.projectId) {
    return { ok: false, status: 400, error: "SPA fallback requires a project asset" };
  }
  if (asset.type !== "archive") {
    return {
      ok: false,
      status: 400,
      error: "SPA fallback is available for site (archive) assets only",
    };
  }
  return { ok: true };
}
