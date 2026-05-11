import { Command } from "commander";
import { PATHS } from "../shared/paths";
import type { AssetMetadata, AssetVersion, Job } from "../shared/api";
import { apiGet, apiPost, apiPatch, apiPut, apiDelete, output, formatAsset, formatJob, formatVersion, formatBytes } from "./helpers";
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

asset
  .command("upload")
  .description("Upload a new version to an existing asset")
  .argument("<id>", "Asset ID")
  .argument("<file>", "File to upload")
  .option("--no-extract", "Skip automatic archive extraction")
  .action(async (id: string, file: string, cmdOpts: { extract?: boolean }) => {
    const { readFileSync, statSync } = await import("node:fs");
    const { basename } = await import("node:path");
    const { gzipSync } = await import("node:zlib");
    const { lookup } = await import("./mime");
    const { commonHeaders } = await import("./helpers");
    const { COMPRESSIBLE_EXTENSIONS } = await import("../shared/compressible-extensions.generated");

    const opts = program.opts<{ endpoint: string; json: boolean }>();

    try { statSync(file); } catch { console.error(`Error: File not found: ${file}`); process.exit(1); }

    const fileName = basename(file);
    const fileData = new Uint8Array(readFileSync(file));
    const contentType = lookup(fileName);

    const ext = fileName.split(".").pop()?.toLowerCase() ?? "";
    const compress = fileData.byteLength >= 1024 && COMPRESSIBLE_EXTENSIONS.has(ext);
    const uploadData = compress ? new Uint8Array(gzipSync(fileData)) : fileData;

    const headers: Record<string, string> = {
      "Content-Type": contentType,
      "Content-Length": String(uploadData.byteLength),
      "X-Filename": fileName,
      ...(await commonHeaders()),
    };
    if (compress) {
      headers["Content-Encoding"] = "gzip";
      headers["X-Original-Size"] = String(fileData.byteLength);
    }
    if (cmdOpts.extract === false) {
      headers["X-Skip-Extraction"] = "true";
    }

    const res = await fetch(`${opts.endpoint}${PATHS.assetUpload(id)}`, {
      method: "POST",
      headers,
      body: uploadData as BodyInit,
    });

    if (!res.ok) {
      const body = await res.text();
      throw new Error(`Upload failed (${res.status}): ${body}`);
    }
    const data = await res.json() as { version: AssetVersion; url: string };

    if (opts.json) {
      output(data, true);
    } else {
      console.log(`Version ${data.version.version} created: ${data.version.id}`);
      console.log(data.url);
    }
  });

asset
  .command("update")
  .description("Update asset metadata")
  .argument("<id>", "Asset ID")
  .option("--description <text>", "Description")
  .option("--user-meta <json>", "User metadata (JSON)")
  .action(async (id: string, cmdOpts: { description?: string; userMeta?: string }) => {
    const opts = program.opts<{ endpoint: string; json: boolean }>();
    const body: Record<string, unknown> = {};
    if (cmdOpts.description !== undefined) body.description = cmdOpts.description;
    if (cmdOpts.userMeta !== undefined) body.userMeta = JSON.parse(cmdOpts.userMeta);
    const data = await apiPatch<{ asset: AssetMetadata }>(opts.endpoint, PATHS.asset(id), body);
    if (opts.json) {
      output(data, true);
    } else {
      console.log(formatAsset(data.asset));
    }
  });

asset
  .command("versions")
  .description("List versions of an asset")
  .argument("<id>", "Asset ID")
  .option("--limit <n>", "Max items per page", "20")
  .option("--cursor <cursor>", "Pagination cursor")
  .action(async (id: string, cmdOpts: { limit: string; cursor?: string }) => {
    const opts = program.opts<{ endpoint: string; json: boolean }>();
    const params = new URLSearchParams();
    params.set("limit", cmdOpts.limit);
    if (cmdOpts.cursor) params.set("cursor", cmdOpts.cursor);
    const data = await apiGet<{ versions: AssetVersion[]; cursor?: string }>(opts.endpoint, `${PATHS.assetVersions(id)}?${params}`);
    if (opts.json) {
      output(data, true);
    } else {
      if (data.versions.length === 0) {
        console.log("No versions");
        return;
      }
      for (const v of data.versions) {
        const status = v.status ? ` [${v.status}]` : "";
        console.log(`v${v.version}  ${v.id}  ${v.filename}  ${formatBytes(v.size)}${status}`);
      }
      if (data.cursor) {
        console.log(`\nNext page: --cursor ${data.cursor}`);
      }
    }
  });

// version subcommand
const version = asset
  .command("version")
  .description("Manage asset versions");

version
  .command("list")
  .description("List versions of an asset")
  .argument("<assetId>", "Asset ID")
  .option("--limit <n>", "Max items per page", "20")
  .option("--cursor <cursor>", "Pagination cursor")
  .action(async (assetId: string, cmdOpts: { limit: string; cursor?: string }) => {
    const opts = program.opts<{ endpoint: string; json: boolean }>();
    const params = new URLSearchParams();
    params.set("limit", cmdOpts.limit);
    if (cmdOpts.cursor) params.set("cursor", cmdOpts.cursor);
    const data = await apiGet<{ versions: AssetVersion[]; cursor?: string }>(opts.endpoint, `${PATHS.assetVersions(assetId)}?${params}`);
    if (opts.json) {
      output(data, true);
    } else {
      if (data.versions.length === 0) {
        console.log("No versions");
        return;
      }
      for (const v of data.versions) {
        const status = v.status ? ` [${v.status}]` : "";
        console.log(`v${v.version}  ${v.id}  ${v.filename}  ${formatBytes(v.size)}${status}`);
      }
      if (data.cursor) {
        console.log(`\nNext page: --cursor ${data.cursor}`);
      }
    }
  });

version
  .command("show")
  .description("Show version details")
  .argument("<assetId>", "Asset ID")
  .argument("<versionId>", "Version ID")
  .action(async (assetId: string, versionId: string) => {
    const opts = program.opts<{ endpoint: string; json: boolean }>();
    const data = await apiGet<{ version: AssetVersion }>(opts.endpoint, PATHS.assetVersion(assetId, versionId));
    if (opts.json) {
      output(data, true);
    } else {
      console.log(formatVersion(data.version));
    }
  });

version
  .command("delete")
  .description("Delete a specific version")
  .argument("<assetId>", "Asset ID")
  .argument("<versionId>", "Version ID")
  .action(async (assetId: string, versionId: string) => {
    const opts = program.opts<{ endpoint: string; json: boolean }>();
    await apiDelete(opts.endpoint, PATHS.assetVersion(assetId, versionId));
    if (opts.json) {
      output({ ok: true }, true);
    } else {
      console.log(`Deleted version: ${versionId}`);
    }
  });

version
  .command("update")
  .description("Update version metadata")
  .argument("<assetId>", "Asset ID")
  .argument("<versionId>", "Version ID")
  .option("--user-meta <json>", "User metadata (JSON)")
  .action(async (assetId: string, versionId: string, cmdOpts: { userMeta?: string }) => {
    const opts = program.opts<{ endpoint: string; json: boolean }>();
    const body: Record<string, unknown> = {};
    if (cmdOpts.userMeta !== undefined) body.userMeta = JSON.parse(cmdOpts.userMeta);
    const data = await apiPatch<{ version: AssetVersion }>(opts.endpoint, PATHS.assetVersion(assetId, versionId), body);
    if (opts.json) {
      output(data, true);
    } else {
      console.log(formatVersion(data.version));
    }
  });

asset
  .command("set-version")
  .description("Set active version for an asset")
  .argument("<id>", "Asset ID")
  .option("--vid <versionId>", "Version ID to set as active")
  .option("--latest", "Reset to latest version")
  .action(async (id: string, cmdOpts: { vid?: string; latest?: boolean }) => {
    const opts = program.opts<{ endpoint: string; json: boolean }>();
    const versionId = cmdOpts.latest ? null : (cmdOpts.vid ?? null);
    const data = await apiPut<{ asset: AssetMetadata }>(opts.endpoint, PATHS.assetActiveVersion(id), { versionId });
    if (opts.json) {
      output(data, true);
    } else {
      const active = data.asset.activeVersionId ?? "latest";
      console.log(`Active version: ${active}`);
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
