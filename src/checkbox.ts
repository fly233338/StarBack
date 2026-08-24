import { getCheckboxRows, type CheckboxRow } from "./inbox.ts";
import type { RepositoryPath } from "./identifiers.ts";

export interface CheckboxTransition {
  repository: RepositoryPath;
  lineIndex: number;
}

export function findCheckboxTransitions(oldBody: string, newBody: string): CheckboxTransition[] {
  const oldRows = getCheckboxRows(oldBody);
  const newRows = getCheckboxRows(newBody);
  const transitions: CheckboxTransition[] = [];
  const matchedNewRows = new Set<number>();

  matchRowsByIdentity(oldRows, newRows, matchedNewRows, transitions);

  const oldByRepository = groupRowsByRepository(oldRows);
  const newByRepository = groupRowsByRepository(newRows);
  for (const [key, oldRepositoryRows] of oldByRepository) {
    const newRepositoryRows = newByRepository.get(key) ?? [];
    if (oldRepositoryRows.length !== newRepositoryRows.length) {
      continue;
    }

    for (let index = 0; index < oldRepositoryRows.length; index += 1) {
      const oldRow = oldRepositoryRows[index];
      const newRow = newRepositoryRows[index];
      if (oldRow.checked || !newRow.checked || matchedNewRows.has(newRow.lineIndex)) {
        continue;
      }
      matchedNewRows.add(newRow.lineIndex);
      transitions.push({ repository: newRow.repository, lineIndex: newRow.lineIndex });
    }
  }

  return transitions
    .sort((left, right) => left.lineIndex - right.lineIndex)
    .filter((transition, index, all) => index === all.findIndex((other) => other.repository.key === transition.repository.key));
}

function matchRowsByIdentity(
  oldRows: readonly CheckboxRow[],
  newRows: readonly CheckboxRow[],
  matchedNewRows: Set<number>,
  transitions: CheckboxTransition[],
): void {
  const available = new Map<string, CheckboxRow[]>();
  for (const row of newRows) {
    const identity = rowIdentity(row);
    const rows = available.get(identity) ?? [];
    rows.push(row);
    available.set(identity, rows);
  }

  for (const oldRow of oldRows) {
    const rows = available.get(rowIdentity(oldRow));
    const newRow = rows?.shift();
    if (newRow === undefined) {
      continue;
    }
    matchedNewRows.add(newRow.lineIndex);
    if (!oldRow.checked && newRow.checked) {
      transitions.push({ repository: newRow.repository, lineIndex: newRow.lineIndex });
    }
  }
}

function groupRowsByRepository(rows: readonly CheckboxRow[]): Map<string, CheckboxRow[]> {
  const grouped = new Map<string, CheckboxRow[]>();
  for (const row of rows) {
    const existing = grouped.get(row.repository.key) ?? [];
    existing.push(row);
    grouped.set(row.repository.key, existing);
  }
  return grouped;
}

function rowIdentity(row: CheckboxRow): string {
  return row.line.replace("[x]", "[?]").replace("[ ]", "[?]");
}
