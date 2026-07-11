import type { KindRegistry } from "@operator/core";

export function inferKindFromBranch(branch: string, registry: KindRegistry): { kind: string; id: string } | null {
  for (const kindDef of registry.all) {
    const prefix = kindDef.branchPrefix.endsWith("/") ? kindDef.branchPrefix : `${kindDef.branchPrefix}/`;
    if (branch.startsWith(prefix)) {
      const id = branch.slice(prefix.length);
      if (id) return { kind: kindDef.name, id };
    }
  }
  return null;
}
