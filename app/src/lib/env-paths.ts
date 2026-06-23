import { homedir } from "node:os";
import { join } from "node:path";

/**
 * Minimal cross-platform config directory resolver for the Operator app.
 *
 * Mirrors the subset of the `env-paths` npm package the app actually needs —
 * just the config directory — without adding a runtime dependency. See
 * architecture-v5.md §15a.4 for the contract.
 *
 * Resolution order:
 *   - `OPERATOR_APP_DB_PATH` env var (absolute path to app.db) — full override
 *   - Platform-specific default:
 *       darwin:  `${HOME}/Library/Application Support/operator-app/app.db`
 *       win32:   `${APPDATA}\\operator-app\\app.db`
 *       linux:   `${XDG_CONFIG_HOME ?? ${HOME}/.config}/operator-app/app.db`
 */
export function resolveAppDbPath(): string {
  const override = process.env["OPERATOR_APP_DB_PATH"];
  if (override) return override;
  return join(resolveAppConfigDir(), "app.db");
}

export function resolveAppConfigDir(): string {
  const platform = process.platform;
  if (platform === "win32") {
    const appData = process.env["APPDATA"];
    if (appData) return join(appData, "operator-app");
    return join(homedir(), "AppData", "Roaming", "operator-app");
  }
  if (platform === "darwin") {
    return join(homedir(), "Library", "Application Support", "operator-app");
  }
  // Linux and other POSIX: respect XDG_CONFIG_HOME per XDG Base Dir spec.
  const xdg = process.env["XDG_CONFIG_HOME"];
  if (xdg) return join(xdg, "operator-app");
  return join(homedir(), ".config", "operator-app");
}
