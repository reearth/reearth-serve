import type { Role } from "../../shared/api";
import type { ProjectAction, WorkspaceAction } from "./permissions";

type Principal = {
  id: string;
  role: Role;
};

export type AuthzRequest =
  | {
      principal: Principal;
      workspaceId: string;
      resource: { kind: "workspace" };
      action: WorkspaceAction;
    }
  | {
      principal: Principal;
      workspaceId: string;
      resource: { kind: "project"; projectId: string };
      action: ProjectAction;
    };

export function isWorkspaceRequest(req: AuthzRequest): req is Extract<AuthzRequest, { resource: { kind: "workspace" } }> {
  return req.resource.kind === "workspace";
}

export interface Authorizer {
  check(req: AuthzRequest): Promise<boolean>;
}

const CERBOS_TIMEOUT_MS = 3000;

export class CerbosAuthorizer implements Authorizer {
  constructor(private endpoint: string, private timeoutMs: number = CERBOS_TIMEOUT_MS) {}

  async check(req: AuthzRequest): Promise<boolean> {
    const id = req.resource.kind === "workspace" ? req.workspaceId : req.resource.projectId;
    const res = await fetch(`${this.endpoint}/api/check/resources`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        principal: { id: req.principal.id, roles: [req.principal.role] },
        resources: [
          {
            resource: { kind: req.resource.kind, id, attr: { workspaceId: req.workspaceId } },
            actions: [req.action],
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

    return data.results?.[0]?.actions?.[req.action] === "EFFECT_ALLOW";
  }
}
