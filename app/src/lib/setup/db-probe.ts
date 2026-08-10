import { createTransientKVStore } from "../kv-factory.js";

/**
 * Open the engine's SQLite state file the way the engine itself would.
 *
 * SQLite opens read-write-create, so a path the app cannot create or write
 * fails at open time — which is exactly the answer the setup screen needs
 * before it saves a connection. Nothing is written: the probe lists a
 * category and closes, so it never leaves a row behind in a real instance.
 */
export interface DbProbeResult {
  readonly ok: boolean;
  readonly message: string;
  /** True once the engine has seeded its workflow configuration into this file. */
  readonly seeded?: boolean;
}

export async function probeEngineDb(dbPath: string): Promise<DbProbeResult> {
  let store: ReturnType<typeof createTransientKVStore> | null = null;
  try {
    store = createTransientKVStore({ name: "setup-probe", dbPath });
    const stages = await store.list("workflow-stages", { limit: 1 });
    const seeded = stages.length > 0;
    return {
      ok: true,
      message: seeded
        ? "opened; engine configuration is present"
        : "opened; empty — the engine seeds its configuration on first start",
      seeded,
    };
  } catch (err) {
    return { ok: false, message: err instanceof Error ? err.message : String(err) };
  } finally {
    store?.close();
  }
}
