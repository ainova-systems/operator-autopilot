import { Octokit } from "@octokit/rest";
import type { Logger } from "../../logging/logger.js";

/** Matches @octokit/plugin-request-log: `"${method} ${path} - ${status}..."`. */
const REQUEST_LOG_STATUS_RE = / - (\d{3})(?: |$)/;

/**
 * Routes Octokit request-log errors: expected 404 existence probes are DEBUG
 * (callers treat absent resources as control flow); real failures stay ERROR.
 */
function routeOctokitErrorLog(logger: Logger, msg: string): void {
  const match = REQUEST_LOG_STATUS_RE.exec(msg);
  if (match?.[1] === "404") {
    logger.debug(msg);
    return;
  }
  logger.error(msg);
}

/**
 * Creates an authenticated Octokit instance.
 *
 * When a Logger is provided, Octokit's built-in request-log plugin
 * routes through pino so every HTTP line is structured JSON.
 * Without a logger, Octokit defaults to console (raw text).
 */
export function createOctokit(token: string, logger?: Logger): Octokit {
  return new Octokit({
    auth: token,
    ...(logger ? {
      log: {
        debug: (msg: string) => logger.debug(msg),
        info: (msg: string) => logger.debug(msg),
        warn: (msg: string) => logger.warn(msg),
        error: (msg: string) => routeOctokitErrorLog(logger, msg),
      },
    } : {}),
  });
}

/**
 * Parses "owner/repo" slug into components.
 */
export function parseRepoSlug(slug: string): { owner: string; repo: string } {
  const parts = slug.split("/");
  if (parts.length !== 2 || !parts[0] || !parts[1]) {
    throw new Error(`Invalid repo slug: "${slug}" — expected "owner/repo"`);
  }
  return { owner: parts[0], repo: parts[1] };
}
