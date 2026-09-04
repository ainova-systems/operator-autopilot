import type { KVListFilter } from "@operator/core";

function fieldPath(field: string): string {
  return `$."${field.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}

function addEquality(
  params: unknown[],
  field: string,
  expected: unknown,
): string {
  const path = fieldPath(field);
  if (expected === null) {
    params.push(path);
    return "json_type(value, ?) = 'null'";
  }
  params.push(path, JSON.stringify(expected));
  return "json_extract(value, ?) = json_extract(?, '$')";
}

/** Add bound SQLite JSON predicates before ordering and pagination. */
export function appendJsonListFilters(
  clauses: string[],
  params: unknown[],
  filter: KVListFilter | undefined,
): void {
  for (const [field, expected] of Object.entries(filter?.where ?? {})) {
    clauses.push(addEquality(params, field, expected));
  }

  for (const [field, expectedValues] of Object.entries(filter?.whereIn ?? {})) {
    if (expectedValues.length === 0) {
      clauses.push("0 = 1");
      continue;
    }
    const alternatives = expectedValues.map((expected) =>
      addEquality(params, field, expected),
    );
    clauses.push(`(${alternatives.join(" OR ")})`);
  }

  for (const [field, lowerBound] of Object.entries(filter?.whereGte ?? {})) {
    params.push(fieldPath(field), JSON.stringify(lowerBound));
    clauses.push("json_extract(value, ?) >= json_extract(?, '$')");
  }
}
