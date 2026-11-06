import type { Role } from "../../shared/api";
import type { ProjectAction, WorkspaceAction } from "./permissions";
import { TenancyUnavailableError } from "../tenancy/port";

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
    try {
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
      if (!res.ok) throw new TenancyUnavailableError(`Cerbos check failed: ${res.status}`);
      return effectOf(await res.json(), req.action) === "EFFECT_ALLOW";
    } catch (cause) {
      if (cause instanceof TenancyUnavailableError) throw cause;
      throw new TenancyUnavailableError("Cerbos did not answer a decision", { cause });
    }
  }
}

type CheckResponse = { results?: Array<{ actions?: Record<string, unknown> } | null> };

function effectOf(body: unknown, action: string): string {
  const effect = (body as CheckResponse | null)?.results?.[0]?.actions?.[action];
  if (typeof effect !== "string") throw new TenancyUnavailableError("Cerbos answered a malformed decision");
  return effect;
}

if (import.meta.vitest) {
  const { test, expect, describe, afterEach, vi } = import.meta.vitest;
  const { createServer } = await import("node:http");

  const req: AuthzRequest = {
    principal: { id: "u1", role: "editor" },
    workspaceId: "ws1",
    resource: { kind: "project", projectId: "p1" },
    action: "read",
  };

  describe("CerbosAuthorizer", () => {
    afterEach(() => vi.unstubAllGlobals());

    test("a body that stalls past the timeout makes the decision unavailable", async () => {
      const server = createServer((_, res) => {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.write('{"results":');
      });
      await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
      const { port } = server.address() as { port: number };
      try {
        await expect(new CerbosAuthorizer(`http://127.0.0.1:${port}`, 50).check(req))
          .rejects.toBeInstanceOf(TenancyUnavailableError);
      } finally {
        server.closeAllConnections();
        await new Promise((resolve) => server.close(resolve));
      }
    });

    test.each([
      ["a truncated body", '{"results":[{"actions":'],
      ["a non-JSON body", "<html>proxy error</html>"],
      ["a JSON null", "null"],
      ["no results", "{}"],
      ["no effect for the action", '{"results":[{"actions":{}}]}'],
      ["a non-string effect", '{"results":[{"actions":{"read":true}}]}'],
    ])("a 200 with %s makes the decision unavailable instead of denied", async (_, body) => {
      vi.stubGlobal("fetch", vi.fn(async () => new Response(body, { status: 200 })));
      await expect(new CerbosAuthorizer("http://pdp").check(req)).rejects.toBeInstanceOf(TenancyUnavailableError);
    });

    test.each([
      ["EFFECT_ALLOW", true],
      ["EFFECT_DENY", false],
    ])("a well-formed %s decides %s", async (effect, allowed) => {
      vi.stubGlobal("fetch", vi.fn(async () => Response.json({ results: [{ actions: { read: effect } }] })));
      expect(await new CerbosAuthorizer("http://pdp").check(req)).toBe(allowed);
    });
  });
}
