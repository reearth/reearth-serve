export interface AuthzRequest {
  principal: { id: string; roles: string[] };
  resource: { kind: string; id: string; attr?: Record<string, unknown> };
  action: string;
}

export interface Authorizer {
  check(req: AuthzRequest): Promise<boolean>;
}

// Cerbos PDP runs in the request hot path. A short timeout makes us fail fast
// when the PDP is degraded instead of stalling every authenticated request to
// the 30s Worker subrequest cap.
const CERBOS_TIMEOUT_MS = 3000;

/**
 * CerbosAuthorizer sends authorization requests to an external Cerbos PDP.
 */
export class CerbosAuthorizer implements Authorizer {
  constructor(private endpoint: string, private timeoutMs: number = CERBOS_TIMEOUT_MS) {}

  async check(req: AuthzRequest): Promise<boolean> {
    const body = {
      principal: {
        id: req.principal.id,
        roles: req.principal.roles,
      },
      resource: {
        kind: req.resource.kind,
        id: req.resource.id,
        attr: req.resource.attr ?? {},
      },
      actions: [req.action],
    };

    const res = await fetch(`${this.endpoint}/api/check/resources`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        principal: body.principal,
        resources: [
          {
            resource: { kind: body.resource.kind, id: body.resource.id, attr: body.resource.attr },
            actions: body.actions,
          },
        ],
      }),
      signal: AbortSignal.timeout(this.timeoutMs),
    });

    if (!res.ok) {
      throw new Error(`Cerbos check failed: ${res.status}`);
    }

    const data = await res.json() as {
      results?: Array<{
        actions?: Record<string, string>;
      }>;
    };

    const result = data.results?.[0]?.actions?.[req.action];
    return result === "EFFECT_ALLOW";
  }
}
