/**
 * The `CustomHostnameProvisioner` port (ADR-013 B5, ADR-012 §2).
 *
 * A customer's own hostname needs a certificate, and issuing one is the most
 * platform-specific thing in Part B: Cloudflare for SaaS on Cloudflare
 * (`adapters/cloudflare/custom-hostnames.ts`), ACM or a Let's Encrypt
 * companion elsewhere, and nothing at all when the operator terminates TLS
 * themselves ({@link NoopProvisioner}). Core only ever asks three questions —
 * start it, how is it going, tear it down — so the platform stays behind the
 * port.
 *
 * `instructions` is prose shown to the customer: what to point where. It is
 * the one place a provider is allowed to speak to the end user, because only
 * the provider knows whether the CNAME target is the apex, a fallback origin
 * or something else again.
 */

/** Whether the hostname is serving TLS yet. Nothing else is modelled. */
export type CertificateStatus = "pending" | "active";

export interface CustomHostnameState {
  status: CertificateStatus;
  /** What the customer must do, when anything is still outstanding. */
  instructions?: string;
}

export interface CustomHostnameProvisioner {
  /** Start issuance. Called once, when the TXT check passes. */
  provision(hostname: string): Promise<CustomHostnameState>;
  /** Where issuance got to. Called from the single-row GET while pending. */
  status(hostname: string): Promise<CustomHostnameState>;
  /** Give the certificate up. Best effort: release must not fail on it. */
  deprovision(hostname: string): Promise<void>;
}

/**
 * The provisioner for a deployment that has no certificate API: the operator
 * terminates TLS themselves (a load balancer, a reverse proxy, the Node
 * runtime behind either). Nothing is issued, so the hostname is "active" the
 * moment it is verified, and the only outstanding step is the customer's
 * CNAME.
 */
export class NoopProvisioner implements CustomHostnameProvisioner {
  /** The CNAME target quoted in the instructions — the apex or a fallback origin. */
  constructor(private target: string) {}

  async provision(hostname: string): Promise<CustomHostnameState> {
    return this.status(hostname);
  }

  async status(hostname: string): Promise<CustomHostnameState> {
    return {
      status: "active",
      instructions:
        `Point a CNAME record for ${hostname} at ${this.target}. ` +
        "This deployment does not issue certificates; TLS for the hostname is " +
        "terminated by the operator.",
    };
  }

  async deprovision(): Promise<void> {}
}
