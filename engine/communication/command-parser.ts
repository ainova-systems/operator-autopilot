/**
 * Parse inbound text commands from any channel (GitHub, Telegram, Slack).
 * Commands start with "/" and have optional arguments.
 */

export interface ParsedCommand {
  readonly command: string;
  readonly args: string[];
  readonly raw: string;
}

const KNOWN_COMMANDS = new Set([
  "status", "research", "pause", "resume", "retry",
  "cancel", "duplicate", "help",
]);

/**
 * Parse a text message into a command, if it contains one.
 * Returns null if no command found.
 *
 * Formats:
 * - `/status` → { command: "status", args: [] }
 * - `/research <repo-id>` → { command: "research", args: ["<repo-id>"] }
 * - `/retry T20260322-000101` → { command: "retry", args: ["T20260322-000101"] }
 */
export function parseCommand(text: string): ParsedCommand | null {
  const trimmed = text.trim();

  // Find first /command in text
  const match = trimmed.match(/\/(\w+)(?:\s+(.*))?/);
  if (!match) return null;

  const command = match[1].toLowerCase();
  if (!KNOWN_COMMANDS.has(command)) return null;

  const argsStr = match[2]?.trim() || "";
  const args = argsStr ? argsStr.split(/\s+/) : [];

  return { command, args, raw: trimmed };
}

/**
 * Check if text contains a known command.
 */
export function hasCommand(text: string): boolean {
  return parseCommand(text) !== null;
}

/**
 * Extract all commands from a multi-line text (e.g., PR comment body).
 */
export function extractCommands(text: string): ParsedCommand[] {
  const commands: ParsedCommand[] = [];
  for (const line of text.split("\n")) {
    const cmd = parseCommand(line);
    if (cmd) commands.push(cmd);
  }
  return commands;
}
