import { join, resolve } from 'node:path';
import type { OperationSpec } from './manifest.ts';

/** The command a run executes, assembled from the operation's configuration. */
export interface EngineCommand {
  argv: string[];
  /** Codex writes its last message here; the runtime builds the contract result from it. */
  outputPath?: string;
}

export interface CommandContext {
  root: string;
  runDir: string;
  inputPath: string;
  resultPath: string;
  workflow: string;
  operation: string;
  subject: string;
  /** A Codex thread to resume, when the operation keeps one per subject. */
  threadId?: string;
}

export const DEFAULT_CLAUDE_PROMPT = 'Delegated sub-agent: do not orchestrate. Run the {skill} skill for subject {subject}. The operation input file is {input}. Write the operation result (contract 1) to {result}.';
export const DEFAULT_CODEX_PROMPT = 'Delegated sub-agent: do not orchestrate. Act as the {agent} agent defined in {agentFile} for subject {subject}. The operation input file is {input}. Answer only with the requested output.';

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
    agentFile: op.agent ? join(context.root, '.codex', 'agents', `${op.agent}.toml`) : '',
  };
  switch (op.engine) {
    case 'command':
      return { argv: ['/bin/sh', '-c', op.command ?? 'false'] };
    case 'claude': {
      const prompt = renderPrompt(op.prompt ?? DEFAULT_CLAUDE_PROMPT, values);
      return { argv: ['claude', '-p', prompt, ...(op.model ? ['--model', op.model] : []), ...op.args] };
    }
    case 'codex': {
      const outputPath = join(context.runDir, 'output.json');
      const prompt = renderPrompt(op.prompt ?? DEFAULT_CODEX_PROMPT, { ...values, output: outputPath });
      const shared = ['--json', '-o', outputPath, ...(op.schema ? ['--output-schema', resolve(context.root, op.schema)] : []), ...(op.model ? ['-m', op.model] : []), ...op.args];
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
