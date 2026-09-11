import type { Command } from "commander";
import { PATHS } from "../shared/paths";
import type { SiteHost } from "../shared/api";
import { apiGet, apiPost, apiDelete, output } from "./helpers";

/**
 * `asset host add|list|remove` (ADR-013 B6).
 *
 * Entity-verb grammar, like `asset version …`. `disable`/`enable` (B3) and
 * `update --previews` (B4) join this group when those land; `upload --site
 * --name` (C2) is a different command entirely.
 */
export function registerHostCommands(program: Command, asset: Command) {
  const host = asset
    .command("host")
    .description("Manage site hosts (named subdomains) of an asset");

  host
    .command("add")
    .description("Claim a name for an asset")
    .argument("<id>", "Asset ID")
    .argument("<name>", "Name, e.g. kawasaki-flood-map (or the full host)")
    .action(async (id: string, name: string) => {
      const opts = program.opts<{ endpoint: string; json: boolean }>();
      const data = await apiPost<{ host: SiteHost; siteUrl: string }>(
        opts.endpoint,
        PATHS.assetHosts(id),
        { hostname: name },
      );
      if (opts.json) {
        output(data, true);
      } else {
        console.log(`Claimed: ${data.host.hostname}`);
        console.log(data.siteUrl);
      }
    });

  host
    .command("list")
    .description("List the names of an asset")
    .argument("<id>", "Asset ID")
    .action(async (id: string) => {
      const opts = program.opts<{ endpoint: string; json: boolean }>();
      const data = await apiGet<{ hosts: SiteHost[] }>(opts.endpoint, PATHS.assetHosts(id));
      if (opts.json) {
        output(data, true);
      } else {
        if (data.hosts.length === 0) {
          console.log("No site hosts");
          return;
        }
        for (const h of data.hosts) {
          console.log(`${h.hostname}  ${h.url}`);
        }
      }
    });

  host
    .command("remove")
    .description("Release a name (it answers 410 and is held for 30 days)")
    .argument("<id>", "Asset ID")
    .argument("<name>", "Name or full host to release")
    .action(async (id: string, name: string) => {
      const opts = program.opts<{ endpoint: string; json: boolean }>();
      await apiDelete(opts.endpoint, PATHS.assetHost(id, name));
      if (opts.json) {
        output({ ok: true }, true);
      } else {
        console.log(`Released: ${name}`);
        console.log("The name is held for 30 days before it can be claimed again.");
      }
    });
}
