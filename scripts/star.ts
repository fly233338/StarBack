import { fileURLToPath } from "node:url";
import { resolve } from "node:path";
import { GitHubClient } from "../src/github.ts";
import { runStar, type StarEvent } from "../src/star.ts";
import { readEventFile, requiredEnvironment } from "../src/runtime.ts";

export async function main(): Promise<void> {
  const event = await readEventFile();
  const token = requiredEnvironment("GITHUB_TOKEN");
  const repository = requiredEnvironment("GITHUB_REPOSITORY");
  requiredEnvironment("GITHUB_RUN_ID");
  const starToken = process.env.STARBACK_TOKEN || undefined;
  await runStar({
    client: new GitHubClient(token),
    starClient: starToken === undefined ? undefined : new GitHubClient(starToken),
    repository,
    event: event as StarEvent,
    starToken,
  });
}

if (process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  });
}
