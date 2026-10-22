/**
 * In-memory `CustomHostnameProvisioner` (ADR-013 B5).
 *
 * Records what it was asked to do so a test can assert that verification
 * provisions and release deprovisions, and lets a test choose the status so
 * the "still pending" path is reachable without a real certificate authority.
 */
import type {
  CertificateStatus, CustomHostnameProvisioner, CustomHostnameState,
} from "../../core/site/provisioner";

export class MemoryCustomHostnames implements CustomHostnameProvisioner {
  readonly provisioned: string[] = [];
  readonly deprovisioned: string[] = [];
  /** Per-hostname status; anything absent answers {@link defaultStatus}. */
  readonly statuses = new Map<string, CertificateStatus>();
  /** When set, every call rejects — the "the API is down" path. */
  failure: Error | null = null;

  constructor(private defaultStatus: CertificateStatus = "active") {}

  async provision(hostname: string): Promise<CustomHostnameState> {
    if (this.failure) throw this.failure;
    this.provisioned.push(hostname);
    return this.state(hostname);
  }

  async status(hostname: string): Promise<CustomHostnameState> {
    if (this.failure) throw this.failure;
    return this.state(hostname);
  }

  async deprovision(hostname: string): Promise<void> {
    if (this.failure) throw this.failure;
    this.deprovisioned.push(hostname);
    this.statuses.delete(hostname);
  }

  private state(hostname: string): CustomHostnameState {
    const status = this.statuses.get(hostname) ?? this.defaultStatus;
    return {
      status,
      instructions: status === "active" ? undefined : `${hostname} is still being issued`,
    };
  }
}
