import { fileURLToPath } from "node:url";
import { resolve } from "node:path";
import { GitHubClient } from "../src/github.ts";
import { runDiscover, type DiscoverEvent } from "../src/discover.ts";
import { readEventFile, requiredEnvironment } from "../src/runtime.ts";

export async function main(): Promise<void> {
  const event = await readEventFile();
  const token = requiredEnvironment("GITHUB_TOKEN");
  const repository = requiredEnvironment("GITHUB_REPOSITORY");
  const runId = requiredEnvironment("GITHUB_RUN_ID");
  const eventName = requiredEnvironment("GITHUB_EVENT_NAME");
  await runDiscover({
    client: new GitHubClient(token),
    repository,
    runId,
    eventName,
    event: event as DiscoverEvent,
  });
}

if (process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  });
}
