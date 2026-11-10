import { join, resolve } from 'node:path';
import type { CodexAgent } from './codex-agent.ts';
import type { OperationSpec } from './manifest.ts';

/** The command a run executes, assembled from the operation's configuration. */
export interface EngineCommand {
  argv: string[];
  /**
   * Codex writes its last message here, and the runtime writes a structured-output claude run's
   * answer here; the runtime builds the contract result from it.
   */
  outputPath?: string;
  /**
   * A claude run in a per-subject tab: the command that resumes its session and the one that starts
   * it under its id. The wrapper, where the session runs, picks between them.
   */
  session?: { id: string; resume: boolean; resumeArgv: string[]; freshArgv: string[] };
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
  /** The schema's JSON text, which a structured-output claude run passes to `--json-schema`. */
  jsonSchema?: string;
  /** The operation's agent has a Claude definition (`.claude/agents/<agent>.md`) in the run's working directory. */
  claudeAgent?: boolean;
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
      // A structured-output run stands in for a codex schema operation: its prompt renders as Codex's would.
      const outputPath = op.structuredOutput ? join(context.runDir, 'output.json') : undefined;
      if (op.structuredOutput && context.jsonSchema === undefined) throw new Error(`operation ${op.name}: a structured-output claude run needs its schema`);
      const prompt = renderPrompt(op.prompt ?? DEFAULT_CLAUDE_PROMPT, outputPath ? { ...values, output: outputPath } : values);
      const structured = op.structuredOutput ? ['--json-schema', context.jsonSchema ?? '', ...(op.agent && context.claudeAgent ? ['--agent', op.agent] : [])] : [];
      // A session takes the prompt as its first message and stays open; -p answers once and exits.
      // A per-subject tab names its session, so the next run of the operation continues it.
      const outputArgs = context.attended || op.args.some((arg) => arg === '--output-format' || arg.startsWith('--output-format=')) ? [] : ['--output-format', 'stream-json', '--verbose'];
      const argv = (session: string[]): string[] => ['claude', ...(context.attended ? [] : ['-p']), prompt, ...session, ...(op.model ? ['--model', op.model] : []), ...structured, ...op.args, ...outputArgs];
      const output = outputPath ? { outputPath } : {};
      // A structured-output run answers once, so it never starts or resumes a session.
      if (!context.session || op.structuredOutput) return { argv: argv([]), ...output };
      const { id, resume } = context.session;
      const resumeArgv = argv(['--resume', id]);
      const freshArgv = argv(['--session-id', id]);
      return { argv: resume ? resumeArgv : freshArgv, ...output, session: { id, resume, resumeArgv, freshArgv } };
    }
    case 'codex': {
      const outputPath = join(context.runDir, 'output.json');
      const rendered = renderPrompt(op.prompt ?? DEFAULT_CODEX_PROMPT, { ...values, output: outputPath });
      const prompt = op.contractResult ? `${rendered}\nReturn the operation result (contract 1) as your final JSON message. The runtime validates it as the original task result; plain prose is not success. In a read-only sandbox, return this JSON instead of writing the result file.` : rendered;
      const sandbox = op.contractResult && op.access === 'write' ? 'workspace-write' : 'read-only';
      const agent = context.codexAgent;
      const model = op.model ?? agent?.model;
      // The definition is the one source of the reviewer's model and instructions; -c takes TOML values.
      const fromAgent = [
        ...(agent?.reasoningEffort ? ['-c', `model_reasoning_effort=${JSON.stringify(agent.reasoningEffort)}`] : []),
        ...(agent?.instructions ? ['-c', `developer_instructions=${JSON.stringify(agent.instructions)}`] : []),
      ];
      const shared = ['--json', '-o', outputPath, ...(op.contractResult && op.access === 'write' ? ['-c', `sandbox_workspace_write.writable_roots=${JSON.stringify([context.runDir])}`] : []), ...(op.schema ? ['--output-schema', resolve(context.root, op.schema)] : []), ...(model ? ['-m', model] : []), ...fromAgent, ...op.args];
      // `exec resume` takes no --sandbox flag, so the read-only sandbox is set through config there.
      const argv = context.threadId
        ? ['codex', 'exec', 'resume', context.threadId, ...shared, '-c', `sandbox_mode=${JSON.stringify(sandbox)}`, prompt]
        : ['codex', 'exec', '-s', sandbox, ...shared, prompt];
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

/** Creates a Codex-compatible task only for an explicitly opted-in Claude operation. */
export function codexFallback(op: OperationSpec): OperationSpec {
  const { model: _model, agent: _agent, fallback: _fallback, ...base } = op;
  return {
    ...base, engine: 'codex', kind: 'agent', contractResult: true,
    args: ['-c', 'approval_policy="on-request"'],
    prompt: op.prompt ?? DEFAULT_CLAUDE_PROMPT,
    thread: op.tabs === 'per-subject' ? 'per-subject' : 'none',
  };
}

/**
 * The permissions of a Claude stand-in for a Codex schema operation. It has no file-editing tools,
 * and it runs unattended: `dontAsk` never waits on a prompt, so every other tool is limited to what
 * the project's own permission rules allow. This is not a sandbox; a command those rules allow runs.
 */
// Reads anywhere, like Codex's read-only sandbox: the operation's input file lives in the run
// directory and its inputs may name files outside the working directory, which dontAsk would refuse.
export const CLAUDE_FALLBACK_ARGS: readonly string[] = ['--permission-mode', 'dontAsk', '--allowedTools', 'Read(//**)', '--disallowedTools', 'Edit,Write,NotebookEdit'];

/**
 * Creates a Claude-compatible task only for an explicitly opted-in codex schema operation. It
 * answers once with the schema's structured output and keeps nothing for the subject: no session,
 * tab or provider affinity, and never the operation's Codex thread, which a later Codex run continues.
 */
export function claudeFallback(op: OperationSpec): OperationSpec {
  const { model: _model, fallback: _fallback, ...base } = op;
  return {
    ...base, engine: 'claude', kind: 'agent', structuredOutput: true,
    args: [...CLAUDE_FALLBACK_ARGS],
    prompt: op.prompt ?? DEFAULT_CODEX_PROMPT,
    thread: 'none',
    tabs: 'per-job',
  };
}

/** The operation a run executes on `provider`: the configured one, or its fallback variant. */
export function onProvider(op: OperationSpec, provider: string | undefined): OperationSpec {
  if (provider === 'codex' && op.engine === 'claude') return codexFallback(op);
  // Claude can stand in only where the runtime collects the answer itself: a codex agent with a schema.
  if (provider === 'claude' && op.engine === 'codex' && op.kind === 'agent' && op.schema) return claudeFallback(op);
  return op;
}
