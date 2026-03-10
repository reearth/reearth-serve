import { readFileSync, statSync } from "node:fs";
import { basename } from "node:path";
import { lookup } from "./mime";

const DEFAULT_ENDPOINT = "http://localhost:8787";

async function main() {
  const args = process.argv.slice(2);

  if (args.length === 0 || args.includes("--help") || args.includes("-h")) {
    console.log(`Usage: reearth-serve <file> [--endpoint <url>]

Upload a file and get a public URL.

Options:
  --endpoint <url>  Server endpoint (default: ${DEFAULT_ENDPOINT})
  --json            Output JSON instead of just the URL
  --help, -h        Show this help`);
    process.exit(args.includes("--help") || args.includes("-h") ? 0 : 1);
  }

  let endpoint = DEFAULT_ENDPOINT;
  let jsonOutput = false;
  let filePath: string | undefined;

  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--endpoint" && args[i + 1]) {
      endpoint = args[++i];
    } else if (args[i] === "--json") {
      jsonOutput = true;
    } else if (!args[i].startsWith("-")) {
      filePath = args[i];
    }
  }

  if (!filePath) {
    console.error("Error: No file specified.");
    console.error("Hint:  Run `reearth-serve --help` for usage.");
    process.exit(1);
  }

  try {
    statSync(filePath);
  } catch {
    console.error(`Error: File not found: ${filePath}`);
    process.exit(1);
  }

  const fileName = basename(filePath);
  const fileData = readFileSync(filePath);
  const contentType = lookup(fileName);

  const form = new FormData();
  form.append("file", new Blob([fileData], { type: contentType }), fileName);

  const res = await fetch(`${endpoint}/assets`, { method: "POST", body: form });

  if (!res.ok) {
    const body = await res.text();
    console.error(`Error: Upload failed (${res.status}): ${body}`);
    process.exit(1);
  }

  const data = await res.json() as { asset: { id: string }; url: string };

  if (jsonOutput) {
    console.log(JSON.stringify(data, null, 2));
  } else {
    console.log(data.url);
  }
}

main();
