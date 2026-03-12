import { Command } from "commander";
import { PATHS } from "../shared/paths";
import type { AssetMetadata, Job } from "../shared/api";
import { apiGet, apiPost, apiDelete, output, formatAsset, formatJob } from "./helpers";
import { doUpload } from "./upload";
import { registerFileCommands } from "./file";
import { login, logout, whoami } from "./auth";
import { registerProjectCommands } from "./project";
import { registerWorkspaceCommands } from "./workspace";

const DEFAULT_ENDPOINT = "http://localhost:8787";

// --- Program ---

const program = new Command()
  .name("reearth-serve")
  .description("Re:Earth Serve CLI — spatial data delivery")
  .version("0.1.0")
  .option("--endpoint <url>", "Server endpoint", DEFAULT_ENDPOINT)
  .option("--json", "Output JSON", false);

// upload (shortcut)
program
  .command("upload")
  .description("Upload a file and get a public URL")
  .argument("<file>", "File to upload")
  .option("--direct", "Force direct upload (skip presigned URL)")
  .action(async (file: string, cmdOpts: { direct?: boolean }) => {
    const globalOpts = program.opts<{ endpoint: string; json: boolean }>();
    await doUpload(file, { endpoint: globalOpts.endpoint, direct: !!cmdOpts.direct, json: globalOpts.json });
  });

// asset
const asset = program
  .command("asset")
  .description("Manage assets");

asset
  .command("create")
  .description("Upload a file (alias for upload)")
  .argument("<file>", "File to upload")
  .option("--direct", "Force direct upload (skip presigned URL)")
  .action(async (file: string, cmdOpts: { direct?: boolean }) => {
    const globalOpts = program.opts<{ endpoint: string; json: boolean }>();
    await doUpload(file, { endpoint: globalOpts.endpoint, direct: !!cmdOpts.direct, json: globalOpts.json });
  });

asset
  .command("show")
  .description("Show asset metadata")
  .argument("<id>", "Asset ID")
  .action(async (id: string) => {
    const opts = program.opts<{ endpoint: string; json: boolean }>();
    const data = await apiGet<{ asset: AssetMetadata }>(opts.endpoint, PATHS.asset(id));
    if (opts.json) {
      output(data, true);
    } else {
      console.log(formatAsset(data.asset));
    }
  });

asset
  .command("delete")
  .description("Delete an asset")
  .argument("<id>", "Asset ID")
  .action(async (id: string) => {
    const opts = program.opts<{ endpoint: string; json: boolean }>();
    await apiDelete(opts.endpoint, PATHS.asset(id));
    if (opts.json) {
      output({ ok: true }, true);
    } else {
      console.log(`Deleted: ${id}`);
    }
  });

// job
const job = program
  .command("job")
  .description("Manage jobs");

job
  .command("show")
  .description("Show job status")
  .argument("<id>", "Job ID")
  .action(async (id: string) => {
    const opts = program.opts<{ endpoint: string; json: boolean }>();
    const data = await apiGet<Job>(opts.endpoint, PATHS.job(id));
    if (opts.json) {
      output(data, true);
    } else {
      console.log(formatJob(data));
    }
  });

job
  .command("retry")
  .description("Retry a failed job")
  .argument("<id>", "Job ID")
  .action(async (id: string) => {
    const opts = program.opts<{ endpoint: string; json: boolean }>();
    const data = await apiPost<Job>(opts.endpoint, PATHS.jobRetry(id));
    if (opts.json) {
      output(data, true);
    } else {
      console.log(formatJob(data));
    }
  });

// file
const file = program
  .command("file")
  .description("Manage asset files");

registerFileCommands(program, file);

// project
const project = program
  .command("project")
  .description("Manage projects");

registerProjectCommands(program, project);

// workspace
const workspace = program
  .command("workspace")
  .description("Manage workspaces");

registerWorkspaceCommands(program, workspace);

// login
program
  .command("login")
  .description("Log in via OAuth2 (opens browser)")
  .option("--issuer <url>", "OIDC issuer URL")
  .option("--client-id <id>", "OAuth2 client ID")
  .action(async (cmdOpts: { issuer?: string; clientId?: string }) => {
    await login(cmdOpts);
  });

// logout
program
  .command("logout")
  .description("Clear stored credentials")
  .action(() => {
    logout();
  });

// whoami
program
  .command("whoami")
  .description("Show current user info")
  .action(() => {
    const opts = program.opts<{ json: boolean }>();
    whoami(opts.json);
  });

// health
program
  .command("health")
  .description("Check server health")
  .action(async () => {
    const opts = program.opts<{ endpoint: string; json: boolean }>();
    const data = await apiGet<{ ok: boolean }>(opts.endpoint, PATHS.health);
    if (opts.json) {
      output(data, true);
    } else {
      console.log(data.ok ? "OK" : "UNHEALTHY");
    }
  });

program.parse();
