/**
 * Turning protection on and off (ADR-013 B7).
 *
 * Split out of `updateAsset` because it is the one field of the PATCH body
 * that is not a plain column write: it hashes, it bumps a counter, it refuses
 * demo assets, and it needs the deployment secret to exist before it can
 * promise anything. `updateAsset` keeps its shape and this runs beside it.
 */

import type { AssetMetadata } from "../model";
import type { MetadataStore } from "../repository";
import { hashPassword } from "../../access/password";

export type SetAccessResult =
  | { ok: true }
  | { ok: false; status: 400 | 503; error: string };

export interface SetAccessInput {
  access: "public" | "password";
  /** Required for `password`, rejected for `public` (the API schema enforces it). */
  password?: string;
}

/**
 * Apply an access change to `asset`.
 *
 * - **Project assets only.** A demo asset is anonymous, lives an hour and has
 *   no accountable owner to hold a password or a project to rate-limit
 *   against, so protecting one would be a promise nothing backs.
 * - **Archive assets only, for now.** B7 is the *hosting* flavour of access
 *   control — a password on a site a person opens in a browser — and the same
 *   rule already governs named sites (`names require an archive asset`,
 *   `core/site/usecase.ts`). Protecting a plain dataset is the general
 *   requirement ADR-014 exists for, and is deferred to it by decision on
 *   2026-09-11. The `access` field and the `resolveAccess` seam are already
 *   general, so lifting this restriction later is one condition, not a
 *   redesign.
 * - **`SIGNING_SECRET` must exist.** Without it the cookie cannot be minted,
 *   so the asset would be protected and unreachable — better to refuse the
 *   change than to create that state.
 * - **Every set bumps the version** (the store does the incrementing),
 *   including re-setting the same password: the point of a rotation is that
 *   outstanding cookies stop working, and comparing the new password against
 *   the old hash to decide would be both slower and a worse default.
 */
export async function setAssetAccess(
  metadata: MetadataStore,
  asset: AssetMetadata,
  input: SetAccessInput,
  opts: { signingSecret: string | undefined; iterations?: number },
): Promise<SetAccessResult> {
  if (!asset.projectId) {
    return { ok: false, status: 400, error: "protection requires a project asset" };
  }

  // Unprotecting is always allowed: a row that somehow became protected must
  // never be stuck that way because it fails a check the protect path applies.
  if (input.access === "public") {
    await metadata.setProtection(asset.id, { access: "public" });
    return { ok: true };
  }

  if (asset.type !== "archive") {
    return { ok: false, status: 400, error: "protection is available for site (archive) assets only" };
  }

  if (!opts.signingSecret) {
    return { ok: false, status: 503, error: "SIGNING_SECRET not configured" };
  }
  if (!input.password) {
    return { ok: false, status: 400, error: "access \"password\" requires a password" };
  }

  const { hash, salt } = await hashPassword(input.password, { iterations: opts.iterations });
  await metadata.setProtection(asset.id, { access: "password", hash, salt });
  return { ok: true };
}
