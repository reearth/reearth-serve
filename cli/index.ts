import { Command } from "commander";
import { PATHS } from "../shared/paths";
import type { AssetMetadata, Job } from "../shared/api";
import { apiGet, apiPost, apiDelete, output, formatAsset, formatJob, formatBytes } from "./helpers";
import { doUpload } from "./upload";
import { registerFileCommands } from "./file";
import { login, logout, whoami } from "./auth";
import { registerProjectCommands } from "./project";
import { registerWorkspaceCommands } from "./workspace";

const DEFAULT_ENDPOINT = process.env.REEARTH_SERVE_ENDPOINT || "http://localhost:8787";

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
  .option("--no-extract", "Skip automatic archive extraction")
  .action(async (file: string, cmdOpts: { direct?: boolean; extract?: boolean }) => {
    const globalOpts = program.opts<{ endpoint: string; json: boolean }>();
    await doUpload(file, { endpoint: globalOpts.endpoint, direct: !!cmdOpts.direct, json: globalOpts.json, skipExtraction: cmdOpts.extract === false });
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
  .option("--no-extract", "Skip automatic archive extraction")
  .action(async (file: string, cmdOpts: { direct?: boolean; extract?: boolean }) => {
    const globalOpts = program.opts<{ endpoint: string; json: boolean }>();
    await doUpload(file, { endpoint: globalOpts.endpoint, direct: !!cmdOpts.direct, json: globalOpts.json, skipExtraction: cmdOpts.extract === false });
  });

asset
  .command("list")
  .description("List assets")
  .option("--limit <n>", "Max items per page", "20")
  .option("--cursor <cursor>", "Pagination cursor")
  .action(async (cmdOpts: { limit: string; cursor?: string }) => {
    const opts = program.opts<{ endpoint: string; json: boolean }>();
    const params = new URLSearchParams();
    params.set("limit", cmdOpts.limit);
    if (cmdOpts.cursor) params.set("cursor", cmdOpts.cursor);
    const data = await apiGet<{ assets: AssetMetadata[]; cursor?: string }>(opts.endpoint, `${PATHS.assets}?${params}`);
    if (opts.json) {
      output(data, true);
    } else {
      if (data.assets.length === 0) {
        console.log("No assets");
        return;
      }
      for (const a of data.assets) {
        const status = a.status ? ` [${a.status}]` : "";
        console.log(`${a.id}  ${a.filename}  ${formatBytes(a.size)}${status}`);
      }
      if (data.cursor) {
        console.log(`\nNext page: --cursor ${data.cursor}`);
      }
    }
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

asset
  .command("extract")
  .description("Start archive extraction")
  .argument("<id>", "Asset ID")
  .action(async (id: string) => {
    const opts = program.opts<{ endpoint: string; json: boolean }>();
    const data = await apiPost<{ job: Job }>(opts.endpoint, PATHS.assetExtract(id));
    if (opts.json) {
      output(data, true);
    } else {
      console.log(formatJob(data.job));
    }
  });

// job
const job = program
  .command("job")
  .description("Manage jobs");

job
  .command("list")
  .description("List jobs")
  .option("--limit <n>", "Max items per page", "20")
  .option("--cursor <cursor>", "Pagination cursor")
  .action(async (cmdOpts: { limit: string; cursor?: string }) => {
    const opts = program.opts<{ endpoint: string; json: boolean }>();
    const params = new URLSearchParams();
    params.set("limit", cmdOpts.limit);
    if (cmdOpts.cursor) params.set("cursor", cmdOpts.cursor);
    const data = await apiGet<{ jobs: Job[]; cursor?: string }>(opts.endpoint, `${PATHS.jobs}?${params}`);
    if (opts.json) {
      output(data, true);
    } else {
      if (data.jobs.length === 0) {
        console.log("No jobs");
        return;
      }
      for (const j of data.jobs) {
        const updated = new Date(j.updatedAt).toISOString().replace("T", " ").slice(0, 19);
        console.log(`${j.id}  ${j.status.padEnd(10)}  ${j.type}  ${updated}`);
      }
      if (data.cursor) {
        console.log(`\nNext page: --cursor ${data.cursor}`);
      }
    }
  });

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
