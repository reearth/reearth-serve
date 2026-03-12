import type { Command } from "commander";
import { PATHS } from "../shared/paths";
import type { Workspace, Member, Role } from "../shared/api";
import { apiGet, apiPost, apiDelete, apiPatch, output } from "./helpers";
import { loadConfig, saveConfig } from "./config";

interface MeResponse {
  user: { sub: string; email?: string; name?: string };
  workspaces: (Workspace & { role: string })[];
}

function formatWorkspace(ws: Workspace & { role?: string }): string {
  const lines = [
    `ID:      ${ws.id}`,
    `Name:    ${ws.name}`,
    `Created: ${new Date(ws.createdAt).toISOString()}`,
    `Updated: ${new Date(ws.updatedAt).toISOString()}`,
  ];
  if (ws.role) lines.push(`Role:    ${ws.role}`);
  return lines.join("\n");
}

function formatMember(m: Member): string {
  return `${m.userId}  ${m.role}  (joined ${new Date(m.createdAt).toISOString()})`;
}

export function registerWorkspaceCommands(
  program: Command,
  workspaceCmd: Command,
): void {
  workspaceCmd
    .command("list")
    .description("List your workspaces")
    .action(async () => {
      const opts = program.opts<{ endpoint: string; json: boolean }>();
      const data = await apiGet<MeResponse>(opts.endpoint, PATHS.me);
      if (opts.json) {
        output({ workspaces: data.workspaces }, true);
      } else {
        if (data.workspaces.length === 0) {
          console.log("No workspaces. Create one with: reearth-serve workspace create <name>");
          return;
        }
        const config = loadConfig();
        for (const ws of data.workspaces) {
          const marker = ws.id === config.defaultWorkspace ? " (default)" : "";
          console.log(`${ws.id}  ${ws.name}  [${ws.role}]${marker}`);
        }
      }
    });

  workspaceCmd
    .command("show")
    .description("Show workspace details")
    .argument("[id]", "Workspace ID (defaults to current workspace)")
    .action(async (id?: string) => {
      const opts = program.opts<{ endpoint: string; json: boolean }>();
      const workspaceId = id ?? loadConfig().defaultWorkspace;
      if (!workspaceId) {
        console.error("No workspace specified. Pass an ID or run: reearth-serve workspace use <id>");
        process.exitCode = 1;
        return;
      }
      const data = await apiGet<{ workspace: Workspace }>(opts.endpoint, PATHS.workspace(workspaceId));
      if (opts.json) {
        output(data, true);
      } else {
        console.log(formatWorkspace(data.workspace));
      }
    });

  workspaceCmd
    .command("create")
    .description("Create a new workspace")
    .argument("<name>", "Workspace name")
    .action(async (name: string) => {
      const opts = program.opts<{ endpoint: string; json: boolean }>();
      const data = await apiPost<{ workspace: Workspace }>(opts.endpoint, PATHS.workspaces, { name });
      if (opts.json) {
        output(data, true);
      } else {
        console.log(formatWorkspace(data.workspace));
      }
    });

  workspaceCmd
    .command("delete")
    .description("Delete a workspace")
    .argument("<id>", "Workspace ID")
    .action(async (id: string) => {
      const opts = program.opts<{ endpoint: string; json: boolean }>();
      await apiDelete(opts.endpoint, PATHS.workspace(id));
      if (opts.json) {
        output({ ok: true }, true);
      } else {
        console.log(`Deleted: ${id}`);
      }
    });

  workspaceCmd
    .command("use")
    .description("Set default workspace")
    .argument("<id>", "Workspace ID")
    .action(async (id: string) => {
      const opts = program.opts<{ endpoint: string; json: boolean }>();
      // Verify workspace exists
      const data = await apiGet<{ workspace: Workspace }>(opts.endpoint, PATHS.workspace(id));
      const config = loadConfig();
      config.defaultWorkspace = id;
      saveConfig(config);
      if (opts.json) {
        output({ defaultWorkspace: id }, true);
      } else {
        console.log(`Default workspace set: ${data.workspace.name} (${id})`);
      }
    });

  // Member sub-commands
  const member = workspaceCmd
    .command("member")
    .description("Manage workspace members");

  member
    .command("list")
    .description("List workspace members")
    .action(async () => {
      const opts = program.opts<{ endpoint: string; json: boolean }>();
      const config = loadConfig();
      const wsId = config.defaultWorkspace;
      if (!wsId) {
        console.error("No default workspace. Run: reearth-serve workspace use <id>");
        process.exitCode = 1;
        return;
      }
      const data = await apiGet<{ members: Member[] }>(opts.endpoint, PATHS.workspaceMembers(wsId));
      if (opts.json) {
        output(data, true);
      } else {
        if (data.members.length === 0) {
          console.log("No members.");
          return;
        }
        for (const m of data.members) {
          console.log(formatMember(m));
        }
      }
    });

  member
    .command("add")
    .description("Add a member to the workspace")
    .argument("<userId>", "User ID to add")
    .requiredOption("--role <role>", "Role (owner, admin, editor, viewer)")
    .action(async (userId: string, cmdOpts: { role: string }) => {
      const opts = program.opts<{ endpoint: string; json: boolean }>();
      const config = loadConfig();
      const wsId = config.defaultWorkspace;
      if (!wsId) {
        console.error("No default workspace. Run: reearth-serve workspace use <id>");
        process.exitCode = 1;
        return;
      }
      const data = await apiPost<{ member: Member }>(
        opts.endpoint,
        PATHS.workspaceMembers(wsId),
        { userId, role: cmdOpts.role as Role },
      );
      if (opts.json) {
        output(data, true);
      } else {
        console.log(`Added member: ${formatMember(data.member)}`);
      }
    });

  member
    .command("remove")
    .description("Remove a member from the workspace")
    .argument("<userId>", "User ID to remove")
    .action(async (userId: string) => {
      const opts = program.opts<{ endpoint: string; json: boolean }>();
      const config = loadConfig();
      const wsId = config.defaultWorkspace;
      if (!wsId) {
        console.error("No default workspace. Run: reearth-serve workspace use <id>");
        process.exitCode = 1;
        return;
      }
      await apiDelete(opts.endpoint, PATHS.workspaceMember(wsId, userId));
      if (opts.json) {
        output({ ok: true }, true);
      } else {
        console.log(`Removed member: ${userId}`);
      }
    });

  member
    .command("update")
    .description("Update a member's role")
    .argument("<userId>", "User ID")
    .requiredOption("--role <role>", "New role (owner, admin, editor, viewer)")
    .action(async (userId: string, cmdOpts: { role: string }) => {
      const opts = program.opts<{ endpoint: string; json: boolean }>();
      const config = loadConfig();
      const wsId = config.defaultWorkspace;
      if (!wsId) {
        console.error("No default workspace. Run: reearth-serve workspace use <id>");
        process.exitCode = 1;
        return;
      }
      const data = await apiPatch<{ member: Member }>(
        opts.endpoint,
        PATHS.workspaceMember(wsId, userId),
        { role: cmdOpts.role as Role },
      );
      if (opts.json) {
        output(data, true);
      } else {
        console.log(`Updated member: ${formatMember(data.member)}`);
      }
    });
}
