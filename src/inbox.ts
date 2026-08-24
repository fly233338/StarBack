import type { GitHubIssue, GitHubRepository } from "./github.ts";
import { parseRepositoryPath, type RepositoryPath } from "./identifiers.ts";

export const INBOX_LABEL = "starback-inbox";
export const INBOX_LABEL_COLOR = "0969da";
export const INBOX_LABEL_DESCRIPTION = "Managed by StarBack";
export const RUN_MARKER_PREFIX = "<!-- starback-run:";

const MONTH_NAMES = [
  "January",
  "February",
  "March",
  "April",
  "May",
  "June",
  "July",
  "August",
  "September",
  "October",
  "November",
  "December",
] as const;

export interface InboxTitle {
  year: number;
  month: number;
  page: number;
}

export interface CheckboxRow {
  repository: RepositoryPath;
  checked: boolean;
  line: string;
  lineIndex: number;
}

export function formatInboxTitle(date: Date, page = 1): string {
  const title = `StarBack Inbox · ${MONTH_NAMES[date.getUTCMonth()]} ${date.getUTCFullYear()}`;
  return page === 1 ? title : `${title} · #${page}`;
}

export function parseInboxTitle(title: string): InboxTitle | null {
  const match = /^StarBack Inbox · (January|February|March|April|May|June|July|August|September|October|November|December) (\d{4})(?: · #(\d+))?$/.exec(
    title,
  );
  if (match === null) {
    return null;
  }

  const month = MONTH_NAMES.indexOf(match[1] as (typeof MONTH_NAMES)[number]) + 1;
  const page = match[3] === undefined ? 1 : Number(match[3]);
  if (match[3] === "1" || page < 1 || !Number.isInteger(page)) {
    return null;
  }

  return { year: Number(match[2]), month, page };
}

export function isBeforeMonth(title: InboxTitle, date: Date): boolean {
  const titleMonth = title.year * 12 + title.month;
  const currentMonth = date.getUTCFullYear() * 12 + date.getUTCMonth() + 1;
  return titleMonth < currentMonth;
}

export function hasInboxLabel(issue: GitHubIssue): boolean {
  return issue.labels.some((label) => {
    const name = typeof label === "string" ? label : label.name;
    return name.toLowerCase() === INBOX_LABEL;
  });
}

export function getCheckboxRows(body: string): CheckboxRow[] {
  return body.split(/\r?\n/).flatMap((line, lineIndex) => {
    const match = /^- \[([ x])\] ([^\s]+)(?:\s.*)?$/.exec(line);
    if (match === null) {
      return [];
    }
    const repository = parseRepositoryPath(match[2]);
    if (repository === null) {
      return [];
    }
    return [{ repository, checked: match[1] === "x", line, lineIndex }];
  });
}

export function extractRepositoryKeys(body: string): Set<string> {
  return new Set(getCheckboxRows(body).map((row) => row.repository?.key).filter((key): key is string => key !== undefined));
}

export function countGeneratedRecommendations(body: string): number {
  return getCheckboxRows(body).filter((row) => row.line.includes(RUN_MARKER_PREFIX)).length;
}

export function formatRecommendation(repository: GitHubRepository, runId: string): string {
  const language = repository.language?.trim() || "Unknown";
  const stars = Math.max(0, Math.trunc(repository.stargazers_count));
  return `- [ ] ${repository.full_name} — ${language} · ★${stars} ${RUN_MARKER_PREFIX}${runId} -->`;
}

export function appendRecommendations(body: string, recommendations: readonly string[]): string {
  if (recommendations.length === 0) {
    return body;
  }
  const suffix = recommendations.join("\n");
  if (body.length === 0) {
    return suffix;
  }
  return body.endsWith("\n") ? `${body}${suffix}` : `${body}\n${suffix}`;
}

export function restoreFailedRepositories(body: string, failedKeys: ReadonlySet<string>): string {
  return body
    .split(/\r?\n/)
    .map((line) => {
      const row = getCheckboxRows(line)[0];
      if (row?.checked !== true || row.repository === null || !failedKeys.has(row.repository.key)) {
        return line;
      }
      return line.replace("[x]", "[ ]");
    })
    .join("\n");
}
