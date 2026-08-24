export interface RepositoryPath {
  owner: string;
  repo: string;
  fullName: string;
  key: string;
}

const repositoryPart = /^[A-Za-z0-9](?:[A-Za-z0-9_.-]*[A-Za-z0-9_-])?$/;

export function parseRepositoryPath(value: string): RepositoryPath | null {
  const parts = value.split("/");
  if (parts.length !== 2 || !repositoryPart.test(parts[0]) || !repositoryPart.test(parts[1])) {
    return null;
  }

  const [owner, repo] = parts;
  return {
    owner,
    repo,
    fullName: `${owner}/${repo}`,
    key: `${owner}/${repo}`.toLowerCase(),
  };
}

export function sameRepositoryPath(left: string, right: string): boolean {
  const leftPath = parseRepositoryPath(left);
  const rightPath = parseRepositoryPath(right);
  return leftPath !== null && rightPath !== null && leftPath.key === rightPath.key;
}

export function splitRepositoryName(value: string): RepositoryPath {
  const parsed = parseRepositoryPath(value);
  if (parsed === null) {
    throw new Error(`Invalid repository path: ${value}`);
  }
  return parsed;
}
