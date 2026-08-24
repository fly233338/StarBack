import type { GitHubRepository } from "./github.ts";

export interface RankedRepository {
  repository: GitHubRepository;
  score: number;
}

const DAYS_PER_YEAR = 365;
const DAY_MS = 24 * 60 * 60 * 1000;

export function rankRepositories(
  repositories: readonly GitHubRepository[],
  now = new Date(),
): RankedRepository[] {
  const candidates = repositories.filter(isEligibleRepository);
  const maxStars = Math.max(0, ...candidates.map((repository) => repository.stargazers_count));
  const maxForks = Math.max(0, ...candidates.map((repository) => repository.forks_count));

  return candidates
    .map((repository) => ({
      repository,
      score: scoreRepository(repository, maxStars, maxForks, now),
    }))
    .sort(compareRankedRepositories);
}

export function isEligibleRepository(repository: GitHubRepository): boolean {
  return (
    repository.private !== true &&
    repository.visibility !== "private" &&
    repository.fork !== true &&
    repository.archived !== true &&
    repository.disabled !== true &&
    repository.pushed_at !== null
  );
}

export function scoreRepository(
  repository: GitHubRepository,
  maxStars: number,
  maxForks: number,
  now = new Date(),
): number {
  const starScore = normalizedLogScore(repository.stargazers_count, maxStars, 35);
  const activeAgeDays = (now.getTime() - Date.parse(repository.pushed_at ?? now.toISOString())) / DAY_MS;
  const activityScore = 30 * clamp(1 - activeAgeDays / DAYS_PER_YEAR, 0, 1);
  const forkScore = normalizedLogScore(repository.forks_count, maxForks, 10);
  const descriptionScore = hasText(repository.description) ? 10 : 0;
  const topicsScore = repository.topics !== undefined && repository.topics.length > 0 ? 10 : 0;
  const homepageScore = hasText(repository.homepage) ? 5 : 0;

  return starScore + activityScore + forkScore + descriptionScore + topicsScore + homepageScore;
}

function normalizedLogScore(value: number, maximum: number, weight: number): number {
  if (maximum <= 0) {
    return 0;
  }
  return weight * (Math.log1p(Math.max(0, value)) / Math.log1p(maximum));
}

function hasText(value: string | null | undefined): boolean {
  return value !== null && value !== undefined && value.trim().length > 0;
}

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.min(maximum, Math.max(minimum, value));
}

function compareRankedRepositories(left: RankedRepository, right: RankedRepository): number {
  if (right.score !== left.score) {
    return right.score - left.score;
  }
  if (right.repository.stargazers_count !== left.repository.stargazers_count) {
    return right.repository.stargazers_count - left.repository.stargazers_count;
  }
  if (right.repository.pushed_at !== left.repository.pushed_at) {
    return (right.repository.pushed_at ?? "").localeCompare(left.repository.pushed_at ?? "");
  }
  const leftName = left.repository.full_name.toLowerCase();
  const rightName = right.repository.full_name.toLowerCase();
  return leftName.localeCompare(rightName) || left.repository.full_name.localeCompare(right.repository.full_name);
}
