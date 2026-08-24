import { findCheckboxTransitions } from "./checkbox.ts";
import { parseRepositoryPath } from "./identifiers.ts";
import { GitHubClient, type GitHubIssue } from "./github.ts";
import { getCheckboxRows, hasInboxLabel, restoreFailedRepositories } from "./inbox.ts";

export interface StarEvent {
  action?: string;
  repository?: {
    full_name?: string;
    owner?: { login?: string; type?: string };
  };
  sender?: { login?: string; type?: string };
  issue?: GitHubIssue;
  changes?: {
    body?: { from?: string | null };
  };
}

export interface StarOptions {
  client: GitHubClient;
  starClient?: GitHubClient;
  createStarClient?: () => GitHubClient;
  repository: string;
  event: StarEvent;
  log?: (message: string) => void;
}

export async function runStar(options: StarOptions): Promise<void> {
  const log = options.log ?? console.log;
  const issue = validateStarEvent(options.event, options.repository);
  const oldBody = options.event.changes?.body?.from;
  if (oldBody === undefined || oldBody === null || issue.body === null) {
    return;
  }

  const transitions = findCheckboxTransitions(oldBody, issue.body);
  if (transitions.length === 0) {
    return;
  }

  const currentIssue = await options.client.getIssue(options.repository, issue.number);
  validateCurrentIssue(currentIssue);
  const currentBody = currentIssue.body ?? "";
  const selected = transitions.filter((transition) =>
    getCheckboxRows(currentBody).some(
      (row) => row.checked && row.repository.key === transition.repository.key,
    ),
  );
  if (selected.length === 0) {
    log("All changed projects were unchecked again before processing.");
    return;
  }

  let starClient = options.starClient;
  let starClientError: unknown;
  if (starClient === undefined && options.createStarClient !== undefined) {
    try {
      starClient = options.createStarClient();
    } catch (error) {
      starClientError = error;
    }
  }
  if (starClient === undefined && starClientError === undefined) {
    starClientError = new Error("Missing required environment variable: STARBACK_TOKEN");
  }

  const failures: Array<{ repository: string; error: unknown }> = [];
  for (const transition of selected) {
    const target = transition.repository.fullName;
    try {
      if (starClientError !== undefined) {
        throw starClientError;
      }
      if (starClient === undefined) {
        throw new Error("Missing required environment variable: STARBACK_TOKEN");
      }
      const targetRepository = await options.client.getRepository(target);
      if (
        targetRepository.private === true ||
        targetRepository.visibility === "private" ||
        targetRepository.visibility === "internal"
      ) {
        throw new Error(`Target repository is not public: ${target}`);
      }
      if (await starClient.isStarred(target)) {
        log(`Already starred: ${target}`);
      } else {
        await starClient.star(target);
        log(`Starred: ${target}`);
      }
    } catch (error) {
      failures.push({ repository: target, error });
    }
  }

  if (failures.length === 0) {
    return;
  }

  const failureKeys = new Set(failures.map(({ repository }) => repository.toLowerCase()));
  const restorationErrors: unknown[] = [];
  try {
    const latestIssue = await options.client.getIssue(options.repository, issue.number);
    const latestBody = latestIssue.body ?? "";
    const restoredBody = restoreFailedRepositories(latestBody, failureKeys);
    if (restoredBody !== latestBody) {
      await options.client.updateIssue(options.repository, issue.number, { body: restoredBody });
    }
  } catch (error) {
    restorationErrors.push(error);
  }

  const details = failures.map(({ repository, error }) => `${repository}: ${formatError(error)}`);
  for (const error of restorationErrors) {
    details.push(`checkbox restoration: ${formatError(error)}`);
  }
  throw new Error(`StarBack failed to star ${failures.length} project${failures.length === 1 ? "" : "s"}: ${details.join("; ")}`);
}

export function validateStarEvent(event: StarEvent, repository: string): GitHubIssue {
  if (event.action !== "edited") {
    throw new Error(`Unsupported issue action: ${event.action ?? "missing"}`);
  }
  const expectedRepository = parseRepositoryPath(repository);
  if (expectedRepository === null || event.repository?.full_name?.toLowerCase() !== expectedRepository.key) {
    throw new Error("Issue event repository does not match GITHUB_REPOSITORY");
  }
  if (event.repository?.owner?.type !== "User") {
    throw new Error("StarBack v0.1 only supports personal repositories");
  }
  if (
    event.sender?.type !== "User" ||
    event.sender.login?.toLowerCase() !== expectedRepository.owner.toLowerCase()
  ) {
    throw new Error("Only the repository owner can edit an Inbox Issue");
  }
  const issue = event.issue;
  if (issue === undefined) {
    throw new Error("Issue event has no issue payload");
  }
  if (issue.pull_request !== undefined) {
    throw new Error("Pull requests are not Inbox issues");
  }
  if (!hasInboxLabel(issue)) {
    throw new Error("Issue is not a StarBack Inbox");
  }
  return issue;
}

function validateCurrentIssue(issue: GitHubIssue): void {
  if (issue.pull_request !== undefined) {
    throw new Error("The current Issue is no longer a valid StarBack Inbox");
  }
  if (!hasInboxLabel(issue)) {
    throw new Error("The current Issue no longer has the StarBack Inbox label");
  }
}

function formatError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
