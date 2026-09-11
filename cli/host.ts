import type { Command } from "commander";
import { PATHS } from "../shared/paths";
import type { SiteHost } from "../shared/api";
import { apiGet, apiPost, apiPatch, apiDelete, output } from "./helpers";

/**
 * `asset host add|list|remove|disable|enable|update` (ADR-013 B6).
 *
 * Entity-verb grammar, like `asset version …`. `upload --site --name` (C2) is
 * a different command entirely.
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
          console.log(`${h.hostname}  ${hostState(h)}${h.previews ? " previews" : ""}  ${h.url}`);
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

  host
    .command("update")
    .description("Turn a name's preview hosts (v<n>--name, latest--name) on or off")
    .argument("<id>", "Asset ID")
    .argument("<name>", "Name or full host")
    .requiredOption("--previews <on|off>", "Whether preview hosts resolve")
    .action(async (id: string, name: string, cmdOpts: { previews: string }) => {
      const opts = program.opts<{ endpoint: string; json: boolean }>();
      const previews = parseSwitch(cmdOpts.previews);
      const data = await apiPatch<{ host: SiteHost }>(
        opts.endpoint,
        PATHS.assetHost(id, name),
        { previews },
      );
      if (opts.json) {
        output(data, true);
      } else {
        console.log(`Previews ${previews ? "on" : "off"}: ${data.host.hostname}`);
        if (previews) {
          console.log("Preview hosts: v<n>--<name> (pinned) and latest--<name>.");
        }
      }
    });

  registerPublishState(program, host, "disable", true);
  registerPublishState(program, host, "enable", false);
}

/** `on` / `off`, the only two spellings `--previews` takes. */
function parseSwitch(value: string): boolean {
  if (value === "on") return true;
  if (value === "off") return false;
  throw new Error("--previews takes on or off");
}

/**
 * `asset host disable|enable <id> [<name>] [--all]` (ADR-013 B3).
 *
 * `--all` is a loop over the asset's names rather than a flag on the asset:
 * the row is the single source of truth for whether a site serves, so there is
 * nothing to disagree with it.
 */
function registerPublishState(program: Command, host: Command, verb: "disable" | "enable", disabled: boolean) {
  host
    .command(verb)
    .description(
      disabled
        ? "Take a site down (the host answers 503; the name stays held)"
        : "Put a disabled site back up",
    )
    .argument("<id>", "Asset ID")
    .argument("[name]", "Name or full host (omit with --all)")
    .option("--all", "Apply to every name of the asset")
    .action(async (id: string, name: string | undefined, cmdOpts: { all?: boolean }) => {
      const opts = program.opts<{ endpoint: string; json: boolean }>();
      const names = await targetNames(opts.endpoint, id, name, cmdOpts.all);

      const updated: SiteHost[] = [];
      for (const hostname of names) {
        const data = await apiPatch<{ host: SiteHost }>(
          opts.endpoint,
          PATHS.assetHost(id, hostname),
          { disabled },
        );
        updated.push(data.host);
      }

      if (opts.json) {
        output({ hosts: updated }, true);
      } else {
        for (const h of updated) {
          console.log(`${disabled ? "Disabled" : "Enabled"}: ${h.hostname}`);
        }
      }
    });
}

/** The names one invocation acts on: the one given, or all of the asset's. */
async function targetNames(
  endpoint: string,
  id: string,
  name: string | undefined,
  all: boolean | undefined,
): Promise<string[]> {
  if (all) {
    if (name) throw new Error("Give a name or --all, not both");
    const data = await apiGet<{ hosts: SiteHost[] }>(endpoint, PATHS.assetHosts(id));
    if (data.hosts.length === 0) throw new Error("No site hosts");
    return data.hosts.map((h) => h.hostname);
  }
  if (!name) throw new Error("Give a name, or --all for every name of the asset");
  return [name];
}

/** The publish state (ADR-013 B3) as `asset host list` prints it. */
export function hostState(h: SiteHost): string {
  if (h.releasedAt) return "released";
  if (h.disabledAt) return "disabled";
  return "enabled";
}
