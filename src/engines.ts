import { join, resolve } from 'node:path';
import type { CodexAgent } from './codex-agent.ts';
import type { OperationSpec } from './manifest.ts';

/** The command a run executes, assembled from the operation's configuration. */
export interface EngineCommand {
  argv: string[];
  /** Codex writes its last message here; the runtime builds the contract result from it. */
  outputPath?: string;
}

export interface CommandContext {
  root: string;
  /** Where the run executes; a workspace pool member's checkout, otherwise the manifest root. */
  cwd: string;
  runDir: string;
  inputPath: string;
  resultPath: string;
  workflow: string;
  operation: string;
  subject: string;
  /** A Codex thread to resume, when the operation keeps one per subject. */
  threadId?: string;
  /** The operation's Codex agent definition, read from the run's working directory. */
  codexAgent?: CodexAgent;
  /** An interactive run that got its terminal: claude starts a session instead of `-p`. */
  attended?: boolean;
  /** A claude session this run starts under a known id, or resumes when `resume` is set. */
  session?: { id: string; resume: boolean };
}

export const DEFAULT_CLAUDE_PROMPT = 'Run the {skill} skill for subject {subject}. The operation input file is {input}. Write the operation result (contract 1) to {result}.';
export const DEFAULT_CODEX_PROMPT = 'Act as the {agent} agent defined in {agentFile} for subject {subject}. The operation input file is {input}. Answer only with the requested output.';

export function renderPrompt(template: string, values: Record<string, string>): string {
  return template.replace(/\{([a-zA-Z]+)\}/g, (whole, name: string) => values[name] ?? whole);
}

export function buildCommand(op: OperationSpec, context: CommandContext): EngineCommand {
  const values: Record<string, string> = {
    input: context.inputPath,
    result: context.resultPath,
    subject: context.subject,
    operation: context.operation,
    workflow: context.workflow,
    skill: op.skill ?? '',
    agent: op.agent ?? '',
    agentFile: op.agent ? join(context.cwd, '.codex', 'agents', `${op.agent}.toml`) : '',
  };
  switch (op.engine) {
    case 'command':
      return { argv: ['/bin/sh', '-c', op.command ?? 'false'] };
    case 'claude': {
      const prompt = renderPrompt(op.prompt ?? DEFAULT_CLAUDE_PROMPT, values);
      // A session takes the prompt as its first message and stays open; -p answers once and exits.
      // A per-subject tab names its session, so the next run of the operation continues it.
      const session = context.session ? (context.session.resume ? ['--resume', context.session.id] : ['--session-id', context.session.id]) : [];
      return { argv: ['claude', ...(context.attended ? [] : ['-p']), prompt, ...session, ...(op.model ? ['--model', op.model] : []), ...op.args] };
    }
    case 'codex': {
      const outputPath = join(context.runDir, 'output.json');
      const prompt = renderPrompt(op.prompt ?? DEFAULT_CODEX_PROMPT, { ...values, output: outputPath });
      const agent = context.codexAgent;
      const model = op.model ?? agent?.model;
      // The definition is the one source of the reviewer's model and instructions; -c takes TOML values.
      const fromAgent = [
        ...(agent?.reasoningEffort ? ['-c', `model_reasoning_effort=${JSON.stringify(agent.reasoningEffort)}`] : []),
        ...(agent?.instructions ? ['-c', `developer_instructions=${JSON.stringify(agent.instructions)}`] : []),
      ];
      const shared = ['--json', '-o', outputPath, ...(op.schema ? ['--output-schema', resolve(context.root, op.schema)] : []), ...(model ? ['-m', model] : []), ...fromAgent, ...op.args];
      // `exec resume` takes no --sandbox flag, so the read-only sandbox is set through config there.
      const argv = context.threadId
        ? ['codex', 'exec', 'resume', context.threadId, ...shared, '-c', 'sandbox_mode="read-only"', prompt]
        : ['codex', 'exec', '-s', 'read-only', ...shared, prompt];
      return { argv, outputPath };
    }
  }
}

/** Finds the thread id Codex announces on its JSON event stream (`thread.started`). */
export function findCodexThread(output: string): string | undefined {
  for (const line of output.split('\n')) {
    if (!line.includes('thread.started')) continue;
    try {
      const event = JSON.parse(line) as { type?: string; thread_id?: string };
      if (event.type === 'thread.started' && typeof event.thread_id === 'string') return event.thread_id;
    } catch {
      // Output lines that are not JSON events are normal and carry no thread id.
    }
  }
  return undefined;
}
