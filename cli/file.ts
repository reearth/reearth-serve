import { existsSync, rmSync, statSync } from "node:fs";
import { join } from "node:path";
import type { Command } from "commander";
import { PATHS } from "../shared/paths";
import type { AssetMetadata } from "../shared/api";
import {
  apiGet,
  collectFiles,
  downloadFile,
  formatBytes,
  listLocalFiles,
  localMd5,
  output,
  parseSrc,
  streamNdjson,
} from "./helpers";

export function registerFileCommands(program: Command, file: Command) {
  file
    .command("ls")
    .description("List files in an asset")
    .argument("<asset-id>", "Asset ID")
    .argument("[prefix]", "Filter by path prefix")
    .option("-l, --long", "Show detailed output")
    .action(async (assetId: string, prefix: string | undefined, cmdOpts: { long?: boolean }) => {
      const opts = program.opts<{ endpoint: string; json: boolean }>();
      let count = 0;

      if (opts.json) {
        for await (const entry of streamNdjson(opts.endpoint, PATHS.assetFiles(assetId, prefix))) {
          console.log(JSON.stringify(entry));
          count++;
        }
      } else {
        if (cmdOpts.long) {
          const files = await collectFiles(opts.endpoint, PATHS.assetFiles(assetId, prefix));
          if (files.length === 0) {
            console.log("No files (extraction may be in progress)");
            return;
          }
          const maxSize = Math.max(...files.map((f) => formatBytes(f.size).length));
          for (const f of files) {
            const size = formatBytes(f.size).padStart(maxSize);
            console.log(`${size}  ${f.contentType.padEnd(30)}  ${f.path}`);
          }
          const totalSize = files.reduce((s, f) => s + f.size, 0);
          console.log(`\n${files.length} file(s), ${formatBytes(totalSize)} total`);
          return;
        }
        for await (const entry of streamNdjson(opts.endpoint, PATHS.assetFiles(assetId, prefix))) {
          console.log(entry.path);
          count++;
        }
        if (count === 0) {
          console.log("No files (extraction may be in progress)");
        }
      }
    });

  file
    .command("cp")
    .description("Download file(s) from an asset")
    .argument("<src>", "Source: <asset-id>:<path> or <asset-id>")
    .argument("<dest>", "Local destination path or directory (with -r)")
    .option("-r, --recursive", "Recursively download all files under the given prefix")
    .option("-f, --force", "Overwrite existing local files")
    .option("-c, --concurrency <n>", "Max concurrent downloads (with -r)", "4")
    .action(async (src: string, dest: string, cmdOpts: { recursive?: boolean; force?: boolean; concurrency: string }) => {
      const opts = program.opts<{ endpoint: string; json: boolean }>();
      const { assetId, filePath } = parseSrc(src);
      const force = !!cmdOpts.force;

      if (cmdOpts.recursive) {
        const prefix = filePath || undefined;
        const files = await collectFiles(opts.endpoint, PATHS.assetFiles(assetId, prefix));
        if (files.length === 0) {
          if (opts.json) {
            output({ ok: true, count: 0, skipped: 0 }, true);
          } else {
            console.log("No files to download");
          }
          return;
        }

        let downloaded = 0;
        let skipped = 0;
        const queue = [...files];

        async function worker() {
          while (queue.length > 0) {
            const entry = queue.shift()!;
            const relativePath = prefix ? entry.path.slice(prefix.length).replace(/^\//, "") || entry.path.split("/").pop()! : entry.path;
            const localPath = join(dest, relativePath);
            const url = `${opts.endpoint}${PATHS.file(assetId, entry.path)}`;
            const ok = await downloadFile(url, localPath, force);
            if (ok) {
              downloaded++;
            } else {
              skipped++;
            }
            if (!opts.json) {
              process.stdout.write(`\r  ${downloaded + skipped}/${files.length}`);
            }
          }
        }

        const concurrency = parseInt(cmdOpts.concurrency, 10) || 4;
        const workers = Array.from({ length: Math.min(concurrency, files.length) }, () => worker());
        await Promise.all(workers);

        if (opts.json) {
          output({ ok: true, count: downloaded, skipped, dest }, true);
        } else {
          const msg = skipped > 0 ? ` (${skipped} skipped, use -f to overwrite)` : "";
          console.log(`\nDone: ${downloaded} file(s) downloaded to ${dest}${msg}`);
        }
        return;
      }

      // Single file download
      let downloadPath = filePath;
      if (!downloadPath) {
        const data = await apiGet<{ asset: AssetMetadata }>(opts.endpoint, PATHS.asset(assetId));
        downloadPath = data.asset.filename;
      }

      if (!force && existsSync(dest)) {
        if (opts.json) {
          output({ ok: false, error: "File exists (use -f to overwrite)" }, true);
        } else {
          console.error(`Error: ${dest} already exists (use -f to overwrite)`);
        }
        process.exit(1);
      }

      const url = `${opts.endpoint}${PATHS.file(assetId, downloadPath)}`;
      await downloadFile(url, dest, true);

      if (opts.json) {
        output({ ok: true, src, dest }, true);
      } else {
        console.log(`Downloaded: ${dest}`);
      }
    });

  file
    .command("thumb")
    .description("Fetch a thumbnail for an image asset")
    .argument("<asset-id>", "Asset ID (or version ID)")
    .option("-s, --size <size>", "Thumbnail size: xs | sm | md | lg", "md")
    .option("-o, --output <path>", "Write to this local path (default: <id>_<size>.webp)")
    .option("-u, --url", "Print the thumbnail URL instead of downloading")
    .option("-f, --force", "Overwrite existing local file")
    .action(async (assetId: string, cmdOpts: { size: string; output?: string; url?: boolean; force?: boolean }) => {
      const opts = program.opts<{ endpoint: string; json: boolean }>();
      const validSizes = ["xs", "sm", "md", "lg"];
      if (!validSizes.includes(cmdOpts.size)) {
        const msg = `Invalid size: ${cmdOpts.size}. Use one of: ${validSizes.join(", ")}`;
        if (opts.json) output({ ok: false, error: msg }, true);
        else console.error(`Error: ${msg}`);
        process.exit(1);
      }

      const url = `${opts.endpoint}/files/${encodeURIComponent(assetId)}/_thumbs/${cmdOpts.size}.webp`;

      if (cmdOpts.url) {
        if (opts.json) output({ ok: true, url }, true);
        else console.log(url);
        return;
      }

      const dest = cmdOpts.output ?? `${assetId}_${cmdOpts.size}.webp`;
      if (!cmdOpts.force && existsSync(dest)) {
        const msg = `${dest} already exists (use -f to overwrite)`;
        if (opts.json) output({ ok: false, error: msg }, true);
        else console.error(`Error: ${msg}`);
        process.exit(1);
      }

      try {
        await downloadFile(url, dest, true);
      } catch (e) {
        const message = e instanceof Error ? e.message : String(e);
        const isNotFound = message.includes("(404)");
        const msg = isNotFound
          ? `Thumbnail not available (generation may still be in progress, source may be smaller than ${cmdOpts.size}, or asset is not an image)`
          : message;
        if (opts.json) output({ ok: false, error: msg, url }, true);
        else console.error(`Error: ${msg}\n  ${url}`);
        process.exit(1);
      }

      if (opts.json) output({ ok: true, url, dest, size: cmdOpts.size }, true);
      else console.log(`Downloaded ${cmdOpts.size} thumbnail to ${dest}`);
    });

  file
    .command("sync")
    .description("Sync asset files to a local directory (hash-based diff)")
    .argument("<asset-id>", "Asset ID")
    .argument("<dest-dir>", "Local destination directory")
    .option("--delete", "Remove local files not present in the remote asset")
    .option("-c, --concurrency <n>", "Max concurrent downloads", "4")
    .action(async (assetId: string, destDir: string, cmdOpts: { delete?: boolean; concurrency: string }) => {
      const opts = program.opts<{ endpoint: string; json: boolean }>();
      const concurrency = parseInt(cmdOpts.concurrency, 10) || 4;

      const remoteFiles = await collectFiles(opts.endpoint, PATHS.assetFiles(assetId));
      if (remoteFiles.length === 0) {
        if (opts.json) {
          output({ ok: true, downloaded: 0, skipped: 0, deleted: 0 }, true);
        } else {
          console.log("No files to sync (extraction may be in progress)");
        }
        return;
      }

      const totalSize = remoteFiles.reduce((s, f) => s + f.size, 0);
      if (!opts.json) {
        console.log(`Syncing ${remoteFiles.length} file(s) (${formatBytes(totalSize)}) ...`);
      }

      const remotePaths = new Set<string>();
      const toDownload: typeof remoteFiles = [];
      let skipped = 0;

      for (const entry of remoteFiles) {
        remotePaths.add(entry.path);
        const localPath = join(destDir, entry.path);

        if (existsSync(localPath)) {
          if (entry.hash) {
            const localHash = localMd5(localPath);
            if (localHash === entry.hash) {
              skipped++;
              continue;
            }
          } else {
            const localSize = statSync(localPath).size;
            if (localSize === entry.size) {
              skipped++;
              continue;
            }
          }
        }

        toDownload.push(entry);
      }

      let downloaded = 0;
      const queue = [...toDownload];

      async function worker() {
        while (queue.length > 0) {
          const entry = queue.shift()!;
          const localPath = join(destDir, entry.path);
          const url = `${opts.endpoint}${PATHS.file(assetId, entry.path)}`;
          await downloadFile(url, localPath, true);
          downloaded++;
          if (!opts.json) {
            process.stdout.write(`\r  ${downloaded + skipped}/${remoteFiles.length}`);
          }
        }
      }

      if (toDownload.length > 0) {
        const workers = Array.from({ length: Math.min(concurrency, toDownload.length) }, () => worker());
        await Promise.all(workers);
      }

      let deleted = 0;
      if (cmdOpts.delete) {
        const localFiles = listLocalFiles(destDir);
        for (const localRel of localFiles) {
          const normalized = localRel.split("\\").join("/");
          if (!remotePaths.has(normalized)) {
            rmSync(join(destDir, localRel));
            deleted++;
          }
        }
      }

      if (opts.json) {
        output({ ok: true, downloaded, skipped, deleted, totalSize, dest: destDir }, true);
      } else {
        const parts: string[] = [];
        if (downloaded > 0) parts.push(`${downloaded} downloaded`);
        if (skipped > 0) parts.push(`${skipped} unchanged`);
        if (deleted > 0) parts.push(`${deleted} deleted`);
        console.log(`\nDone: ${parts.join(", ")}`);
      }
    });
}
