import { parseRepositoryPath } from "./identifiers.ts";
import {
  GitHubApiError,
  GitHubClient,
  type GitHubIssue,
  type GitHubLabel,
  type GitHubRepository,
} from "./github.ts";
import {
  appendRecommendations,
  countGeneratedRecommendations,
  formatInboxTitle,
  formatRecommendation,
  hasInboxLabel,
  INBOX_LABEL,
  INBOX_LABEL_COLOR,
  INBOX_LABEL_DESCRIPTION,
  isBeforeMonth,
  parseInboxTitle,
  extractRepositoryKeys,
  type InboxTitle,
} from "./inbox.ts";
import { rankRepositories, type RankedRepository } from "./rank.ts";

export interface DiscoverEvent {
  action?: string;
  repository?: {
    full_name?: string;
    owner?: { login?: string; type?: string };
  };
  sender?: { login?: string; type?: string };
}

export interface DiscoverOptions {
  client: GitHubClient;
  repository: string;
  runId: string;
  eventName: string;
  event: DiscoverEvent;
  now?: Date;
  log?: (message: string) => void;
}

export async function runDiscover(options: DiscoverOptions): Promise<void> {
  const now = options.now ?? new Date();
  const log = options.log ?? console.log;

  if (options.eventName === "schedule") {
    await closeOldInboxes(options.client, options.repository, now, log);
    return;
  }

  if (options.eventName !== "watch") {
    throw new Error(`Unsupported discover event: ${options.eventName}`);
  }

  const stargazer = validateWatchEvent(options.event, options.repository);
  await ensureInboxLabel(options.client, options.repository);
  await closeOldInboxes(options.client, options.repository, now, log);

  const inboxIssues = await options.client.listInboxIssues(options.repository, "all");
  if (inboxIssues.some((issue) => issue.body?.includes(`<!-- starback-run:${options.runId} -->`))) {
    log(`Run ${options.runId} already exists in the Inbox; nothing to do.`);
    return;
  }

  const repositories = await options.client.listUserRepositories(stargazer);
  const ranked = rankRepositories(repositories, now);
  const currentMonth = getCurrentMonthPages(inboxIssues, now);
  const existingKeys = new Set<string>();
  for (const page of currentMonth) {
    for (const key of extractRepositoryKeys(page.issue.body ?? "")) {
      existingKeys.add(key);
    }
  }

  const candidates = ranked.filter(({ repository }) => !existingKeys.has(repository.full_name.toLowerCase()));
  if (candidates.length === 0) {
    log("No eligible repository remains after filtering and current-month deduplication.");
    return;
  }

  await writeRecommendations(options.client, options.repository, options.runId, candidates, currentMonth, now, log);
}

export function validateWatchEvent(event: DiscoverEvent, repository: string): string {
  if (event.action !== "started") {
    throw new Error(`Unsupported watch action: ${event.action ?? "missing"}`);
  }
  const expectedRepository = parseRepositoryPath(repository);
  if (expectedRepository === null || event.repository?.full_name?.toLowerCase() !== expectedRepository.key) {
    throw new Error("Watch event repository does not match GITHUB_REPOSITORY");
  }
  if (event.repository?.owner?.type !== "User") {
    throw new Error("StarBack v0.1 only supports personal repositories");
  }
  if (event.sender?.type !== undefined && event.sender.type !== "User") {
    throw new Error("The stargazer must be a personal account");
  }
  const login = event.sender?.login;
  if (login === undefined || login.length === 0) {
    throw new Error("Watch event has no stargazer login");
  }
  return login;
}

export async function ensureInboxLabel(client: GitHubClient, repository: string): Promise<GitHubLabel> {
  try {
    return await client.getLabel(repository, INBOX_LABEL);
  } catch (error) {
    if (!(error instanceof GitHubApiError) || error.status !== 404) {
      throw error;
    }
  }

  return client.createLabel(repository, {
    name: INBOX_LABEL,
    color: INBOX_LABEL_COLOR,
    description: INBOX_LABEL_DESCRIPTION,
  });
}

export async function closeOldInboxes(
  client: GitHubClient,
  repository: string,
  now: Date,
  log: (message: string) => void = console.log,
): Promise<number> {
  const issues = await client.listInboxIssues(repository);
  let closed = 0;
  for (const issue of issues) {
    const title = parseInboxTitle(issue.title);
    if (issue.state !== "open" || issue.pull_request !== undefined || !hasInboxLabel(issue) || title === null) {
      continue;
    }
    if (isBeforeMonth(title, now)) {
      await client.updateIssue(repository, issue.number, { state: "closed" });
      closed += 1;
    }
  }
  if (closed > 0) {
    log(`Closed ${closed} old Inbox issue${closed === 1 ? "" : "s"}.`);
  }
  return closed;
}

interface InboxPage {
  issue: GitHubIssue;
  title: InboxTitle;
}

function getCurrentMonthPages(issues: readonly GitHubIssue[], now: Date): InboxPage[] {
  const year = now.getUTCFullYear();
  const month = now.getUTCMonth() + 1;
  return issues
    .flatMap((issue) => {
      const title = parseInboxTitle(issue.title);
      if (
        title === null ||
        title.year !== year ||
        title.month !== month ||
        issue.pull_request !== undefined ||
        !hasInboxLabel(issue)
      ) {
        return [];
      }
      return [{ issue, title }];
    })
    .sort((left, right) => left.title.page - right.title.page || left.issue.number - right.issue.number);
}

async function writeRecommendations(
  client: GitHubClient,
  repository: string,
  runId: string,
  candidates: readonly RankedRepository[],
  currentMonth: readonly InboxPage[],
  now: Date,
  log: (message: string) => void,
): Promise<void> {
  let remaining = [...candidates];
  let lastPage = currentMonth.filter(({ issue }) => issue.state === "open").at(-1);
  let nextPage = Math.max(0, ...currentMonth.map(({ title }) => title.page));
  if (lastPage === undefined) {
    nextPage += 1;
  }

  while (remaining.length > 0) {
    let pageIsFull = false;
    if (lastPage !== undefined) {
      const latestIssue = await client.getIssue(repository, lastPage.issue.number);
      const latestTitle = validateWritableInboxPage(latestIssue, lastPage.title, now);
      lastPage = { issue: latestIssue, title: latestTitle };
      pageIsFull = countGeneratedRecommendations(latestIssue.body ?? "") >= 100;
    }

    if (lastPage === undefined || pageIsFull) {
      if (lastPage !== undefined) {
        nextPage += 1;
      }
      const pageRecommendations = remaining.slice(0, 100).map(({ repository: item }) => formatRecommendation(item, runId));
      const issue = await client.createIssue(repository, {
        title: formatInboxTitle(now, nextPage),
        body: pageRecommendations.join("\n"),
        labels: [INBOX_LABEL],
      });
      remaining = remaining.slice(pageRecommendations.length);
      lastPage = {
        issue: { ...issue, body: pageRecommendations.join("\n") },
        title: { year: now.getUTCFullYear(), month: now.getUTCMonth() + 1, page: nextPage },
      };
      log(`Created Inbox page ${nextPage} with ${pageRecommendations.length} recommendation${pageRecommendations.length === 1 ? "" : "s"}.`);
      continue;
    }

    const available = 100 - countGeneratedRecommendations(lastPage.issue.body ?? "");
    const pageRecommendations = remaining.slice(0, available).map(({ repository: item }) => formatRecommendation(item, runId));
    const body = appendRecommendations(lastPage.issue.body ?? "", pageRecommendations);
    await client.updateIssue(repository, lastPage.issue.number, { body });
    remaining = remaining.slice(pageRecommendations.length);
    lastPage = {
      ...lastPage,
      issue: { ...lastPage.issue, body },
    };
    log(`Added ${pageRecommendations.length} recommendation${pageRecommendations.length === 1 ? "" : "s"} to Inbox page ${lastPage.title.page}.`);
  }
}

function validateWritableInboxPage(issue: GitHubIssue, expectedTitle: InboxTitle, now: Date): InboxTitle {
  const title = parseInboxTitle(issue.title);
  if (
    issue.state !== "open" ||
    issue.pull_request !== undefined ||
    !hasInboxLabel(issue) ||
    title === null ||
    title.year !== now.getUTCFullYear() ||
    title.month !== now.getUTCMonth() + 1 ||
    title.page !== expectedTitle.page
  ) {
    throw new Error(`Inbox page #${expectedTitle.page} is no longer a writable current-month Inbox`);
  }
  return title;
}
