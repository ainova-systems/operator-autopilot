export type SortDir = "asc" | "desc";

export interface SortState<C extends string = string> {
  readonly sort?: C;
  readonly dir?: SortDir;
}

export function parseSort<C extends string>(
  raw: { readonly sort?: string; readonly dir?: string },
  allowed: ReadonlyArray<C>,
): SortState<C> {
  const sort = raw.sort && (allowed as ReadonlyArray<string>).includes(raw.sort)
    ? (raw.sort as C)
    : undefined;
  const dir: SortDir | undefined =
    sort && (raw.dir === "asc" || raw.dir === "desc") ? raw.dir : sort ? "asc" : undefined;
  return { sort, dir };
}

/**
 * Tri-state cycle for header clicks: none → asc → desc → none.
 * Clicking a different column always starts at asc.
 */
export function nextSort<C extends string>(
  current: SortState<C>,
  column: C,
): SortState<C> {
  if (current.sort !== column) return { sort: column, dir: "asc" };
  if (current.dir === "asc") return { sort: column, dir: "desc" };
  return { sort: undefined, dir: undefined };
}

export function compareStrings(a: string | undefined, b: string | undefined): number {
  if (a === b) return 0;
  if (a == null) return 1;
  if (b == null) return -1;
  return a.localeCompare(b);
}

export function compareNumbers(a: number | undefined, b: number | undefined): number {
  if (a === b) return 0;
  if (a == null) return 1;
  if (b == null) return -1;
  return a - b;
}

export function compareByOrder(
  a: string | undefined,
  b: string | undefined,
  order: ReadonlyArray<string>,
): number {
  if (a === b) return 0;
  if (a == null) return 1;
  if (b == null) return -1;
  const ai = order.indexOf(a);
  const bi = order.indexOf(b);
  if (ai === -1 && bi === -1) return a.localeCompare(b);
  if (ai === -1) return 1;
  if (bi === -1) return -1;
  return ai - bi;
}

export function withDirection(cmp: number, dir: SortDir): number {
  return dir === "asc" ? cmp : -cmp;
}
