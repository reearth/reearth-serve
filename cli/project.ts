import type { Command } from "commander";
import { PATHS } from "../shared/paths";
import { apiGet, apiPost, apiDelete, output } from "./helpers";
import { loadConfig, saveConfig } from "./config";

interface Project {
  id: string;
  name: string;
  ownerId: string;
  createdAt: number;
  updatedAt: number;
}

export function formatProject(p: Project): string {
  const lines = [
    `ID:      ${p.id}`,
    `Name:    ${p.name}`,
    `Owner:   ${p.ownerId}`,
    `Created: ${new Date(p.createdAt).toISOString()}`,
    `Updated: ${new Date(p.updatedAt).toISOString()}`,
  ];
  return lines.join("\n");
}

export function registerProjectCommands(
  program: Command,
  projectCmd: Command,
): void {
  projectCmd
    .command("list")
    .description("List your projects")
    .action(async () => {
      const opts = program.opts<{ endpoint: string; json: boolean }>();
      const data = await apiGet<{ projects: Project[] }>(opts.endpoint, PATHS.projects);
      if (opts.json) {
        output(data, true);
      } else {
        if (data.projects.length === 0) {
          console.log("No projects. Create one with: reearth-serve project create <name>");
          return;
        }
        const config = loadConfig();
        for (const p of data.projects) {
          const marker = p.id === config.defaultProject ? " (default)" : "";
          console.log(`${p.id}  ${p.name}${marker}`);
        }
      }
    });

  projectCmd
    .command("show")
    .description("Show project details")
    .argument("[id]", "Project ID (defaults to current project)")
    .action(async (id?: string) => {
      const opts = program.opts<{ endpoint: string; json: boolean }>();
      const projectId = id ?? loadConfig().defaultProject;
      if (!projectId) {
        console.error("No project specified. Pass an ID or run: reearth-serve project use <id>");
        process.exitCode = 1;
        return;
      }
      const data = await apiGet<{ project: Project }>(opts.endpoint, PATHS.project(projectId));
      if (opts.json) {
        output(data, true);
      } else {
        console.log(formatProject(data.project));
      }
    });

  projectCmd
    .command("create")
    .description("Create a new project")
    .argument("<name>", "Project name")
    .action(async (name: string) => {
      const opts = program.opts<{ endpoint: string; json: boolean }>();
      const data = await apiPost<{ project: Project }>(opts.endpoint, PATHS.projects, { name });
      if (opts.json) {
        output(data, true);
      } else {
        console.log(formatProject(data.project));
      }
    });

  projectCmd
    .command("delete")
    .description("Delete a project")
    .argument("<id>", "Project ID")
    .action(async (id: string) => {
      const opts = program.opts<{ endpoint: string; json: boolean }>();
      await apiDelete(opts.endpoint, PATHS.project(id));
      if (opts.json) {
        output({ ok: true }, true);
      } else {
        console.log(`Deleted: ${id}`);
      }
    });

  projectCmd
    .command("use")
    .description("Set default project")
    .argument("<id>", "Project ID")
    .action(async (id: string) => {
      const opts = program.opts<{ endpoint: string; json: boolean }>();
      // Verify project exists
      const data = await apiGet<{ project: Project }>(opts.endpoint, PATHS.project(id));
      const config = loadConfig();
      config.defaultProject = id;
      saveConfig(config);
      if (opts.json) {
        output({ defaultProject: id }, true);
      } else {
        console.log(`Default project set: ${data.project.name} (${id})`);
      }
    });
}
