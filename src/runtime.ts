import { readFile } from "node:fs/promises";

export function requiredEnvironment(name: string): string {
  const value = process.env[name];
  if (value === undefined || value.length === 0) {
    throw new Error(`Missing required environment variable: ${name}`);
  }
  return value;
}

export async function readEventFile(): Promise<Record<string, unknown>> {
  const eventPath = requiredEnvironment("GITHUB_EVENT_PATH");
  const event = JSON.parse(await readFile(eventPath, "utf8")) as unknown;
  if (typeof event !== "object" || event === null || Array.isArray(event)) {
    throw new Error("GitHub event payload must be a JSON object");
  }
  return event as Record<string, unknown>;
}
