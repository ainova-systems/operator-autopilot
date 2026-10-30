import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { ManifestError, parseManifest } from './manifest.ts';

const VALID = `
contract: 1
project: project-a
state: { provider: ainoflow }
pools:
  codex-review: { limit: 3, shared: true }
  claude-slot: { workspaces: [d1] }
workflows:
  development:
    timezone: Europe/Helsinki
    triggers:
      - every: 5m
        run: discover-development
    operations:
      discover-development: { kind: script, command: node scripts/discover.mjs }
      review: { kind: agent, engine: codex, agent: code-reviewer, schema: review.json, thread: per-subject, pool: codex-review, placement: herdr, then: review-verdict }
      review-verdict: { kind: agent, engine: claude, skill: post-review, pool: claude-slot }
  staging:
    enabled: false
    triggers: [{ cron: "0 6 * * 1-5", run: discover-staging }]
`;

test('reads the plan example: pools, workflows, defaults and a disabled sketch', () => {
  const { manifest, warnings } = parseManifest(VALID, '/repo/operator.yaml');
  assert.equal(manifest.project, 'project-a');
  assert.equal(manifest.state.namespace, 'op-project-a');
  assert.deepEqual(manifest.pools.get('codex-review'), { kind: 'limit', name: 'codex-review', limit: 3, slotTtlMs: 4 * 3_600_000, shared: true });
  assert.deepEqual(manifest.pools.get('claude-slot'), { kind: 'workspaces', name: 'claude-slot', members: [{ name: 'd1', cwd: '/repo', herdr: 'd1' }] });
  const development = manifest.workflows.get('development');
  assert.equal(development?.triggers[0]?.kind, 'every');
  const review = development?.operations.get('review');
  assert.equal(review?.placement, 'herdr');
  assert.equal(review?.thread, 'per-subject');
  assert.equal(development?.operations.get('discover-development')?.placement, 'headless');
  assert.equal(development?.operations.get('discover-development')?.timeoutMs, 15 * 60_000);
  assert.equal(manifest.workflows.get('staging')?.enabled, false);
  assert.deepEqual(warnings, ['workflows.staging.triggers[0].run: unknown operation "discover-staging" (workflow disabled)']);
});

test('reports every unresolved reference of an enabled workflow with its path', () => {
  const broken = VALID.replace('pool: codex-review, placement', 'pool: nowhere, placement').replace('run: discover-development', 'run: discover');
  assert.throws(() => parseManifest(broken, 'operator.yaml'), (error: unknown) => {
    assert.ok(error instanceof ManifestError);
    assert.deepEqual(error.problems, [
      'workflows.development.operations.review.pool: unknown pool "nowhere"',
      'workflows.development.triggers[0].run: unknown operation "discover"',
    ]);
    return true;
  });
});

test('refuses unknown fields, a wrong contract and engine misuse', () => {
  const text = `
contract: 2
project: Bad_Name
workflows:
  w:
    operations:
      a: { kind: agent, engine: claude, placement: nowhere, colour: red }
      b: { kind: script, command: x, then: a }
`;
  assert.throws(() => parseManifest(text, 'm.yaml'), (error: unknown) => {
    assert.ok(error instanceof ManifestError);
    const all = error.problems.join('\n');
    assert.match(all, /contract: this runtime speaks contract 1/);
    assert.match(all, /manifest\.project: "Bad_Name" must match/);
    assert.match(all, /operations\.a\.colour: unknown field/);
    assert.match(all, /operations\.a: a claude operation needs skill or prompt/);
    assert.match(all, /operations\.a\.placement: expected headless or herdr/);
    assert.match(all, /operations\.b\.then: then is for codex schema operations/);
    return true;
  });
});

test('caps Guard slot leases at Ainoflow\'s 24 hours', () => {
  assert.throws(() => parseManifest(VALID.replace('{ limit: 3, shared: true }', '{ limit: 3, slotTtl: 2d }'), 'm.yaml'), /slotTtl: Guard slot leases cannot exceed 24h/);
});

test('a bad runtime value is reported, not replaced by its default', () => {
  const text = VALID.replace('state: { provider: ainoflow }', 'state: { provider: ainoflow }\nruntime: { tick: nope, leaseTtl: -1 }');
  assert.throws(() => parseManifest(text, 'm.yaml'), (error: unknown) => {
    assert.ok(error instanceof ManifestError);
    assert.equal(error.problems.length, 2);
    assert.match(error.problems.join('\n'), /runtime\.tick: expected a duration/);
    assert.match(error.problems.join('\n'), /runtime\.leaseTtl: expected a duration/);
    return true;
  });
});

test('enabled must be a boolean, not a string that looks like one', () => {
  assert.throws(() => parseManifest(VALID.replace('    enabled: false', '    enabled: "false"'), 'm.yaml'), /workflows\.staging\.enabled: expected true or false/);
});

test('an operation that can outlive its Guard slot is refused', () => {
  const text = VALID.replace('{ limit: 3, shared: true }', '{ limit: 3, slotTtl: 1h, shared: true }');
  assert.throws(() => parseManifest(text, 'm.yaml'), /operations\.review\.timeout: 14400s exceeds pool codex-review slotTtl 3600s/);
});

test('an interactive operation needs a terminal placement and runs claude or a command', () => {
  const text = `
contract: 1
project: demo
workflows:
  w:
    operations:
      plan: { kind: interactive, engine: claude, skill: plan-change }
      review: { kind: interactive, engine: codex, agent: reviewer, placement: herdr }
      mode: { kind: session, command: x }
`;
  assert.throws(() => parseManifest(text, 'm.yaml'), (error: unknown) => {
    assert.ok(error instanceof ManifestError);
    const all = error.problems.join('\n');
    assert.match(all, /operations\.plan\.placement: an interactive operation needs a terminal placement/);
    assert.match(all, /operations\.review\.engine: an interactive operation runs claude or a command/);
    assert.match(all, /operations\.mode\.kind: expected one of script, agent, interactive/);
    return true;
  });
});

test('notify defaults to an agent\'s questions and failures, and takes only result statuses', () => {
  const text = (notify: string): string => `
contract: 1
project: demo
workflows:
  w:
    operations:
      scan: { kind: script, command: x }
      plan: { kind: interactive, engine: claude, skill: plan-change, placement: herdr, timeout: 2h }
      verify: { kind: agent, engine: claude, skill: verify-change${notify} }
`;
  const operations = parseManifest(text(''), 'm.yaml').manifest.workflows.get('w')?.operations;
  assert.deepEqual(operations?.get('scan')?.notify, []);
  assert.deepEqual(operations?.get('plan')?.notify, ['needs-input', 'failed']);
  assert.equal(operations?.get('plan')?.kind, 'interactive');
  assert.equal(operations?.get('plan')?.timeoutMs, 2 * 3_600_000);
  assert.deepEqual(operations?.get('verify')?.notify, ['needs-input', 'failed']);
  const chosen = parseManifest(text(', notify: [done, failed]'), 'm.yaml').manifest.workflows.get('w')?.operations;
  assert.deepEqual(chosen?.get('verify')?.notify, ['done', 'failed']);
  assert.deepEqual(parseManifest(text(', notify: []'), 'm.yaml').manifest.workflows.get('w')?.operations.get('verify')?.notify, []);
  assert.throws(() => parseManifest(text(', notify: [blocked]'), 'm.yaml'), /operations\.verify\.notify: expected a list of result statuses/);
});

test('limit names a limit pool, and read access needs a workspaces pool', () => {
  const text = (review: string): string => `
contract: 1
project: demo
pools:
  slots: { workspaces: [d1, d2] }
  codex: { limit: 2, slotTtl: 1h }
workflows:
  w:
    operations:
      review: ${review}
`;
  const review = parseManifest(text('{ kind: agent, engine: command, command: x, pool: slots, access: read, limit: codex, timeout: 45m }'), 'm.yaml').manifest.workflows.get('w')?.operations.get('review');
  assert.equal(review?.access, 'read');
  assert.equal(review?.limit, 'codex');
  assert.equal(parseManifest(text('{ kind: script, command: x }'), 'm.yaml').manifest.workflows.get('w')?.operations.get('review')?.access, 'write');
  assert.throws(() => parseManifest(text('{ kind: agent, engine: command, command: x, pool: codex, access: read, limit: slots, timeout: 2h }'), 'm.yaml'), (error: unknown) => {
    assert.ok(error instanceof ManifestError);
    const all = error.problems.join('\n');
    assert.match(all, /operations\.review\.limit: pool slots is a workspaces pool/);
    assert.match(all, /operations\.review\.access: read access places a run in a workspace member/);
    assert.match(all, /operations\.review\.timeout: 7200s exceeds pool codex slotTtl 3600s/);
    return true;
  });
  assert.throws(() => parseManifest(text('{ kind: agent, engine: command, command: x, pool: slots, access: write-ish }'), 'm.yaml'), /operations\.review\.access: expected write or read/);
});

test('keepTab keeps a herdr tab open after its run, and needs a herdr placement', () => {
  const text = (op: string): string => `
contract: 1
project: demo
workflows:
  w:
    operations:
      plan: ${op}
`;
  assert.equal(parseManifest(text('{ kind: interactive, engine: claude, skill: plan-change, placement: herdr, keepTab: 30m }'), 'm.yaml').manifest.workflows.get('w')?.operations.get('plan')?.keepTabMs, 30 * 60_000);
  assert.equal(parseManifest(text('{ kind: interactive, engine: claude, skill: plan-change, placement: herdr }'), 'm.yaml').manifest.workflows.get('w')?.operations.get('plan')?.keepTabMs, 0);
  assert.throws(() => parseManifest(text('{ kind: agent, engine: claude, skill: plan-change, keepTab: 30m }'), 'm.yaml'), /operations\.plan\.keepTab: keepTab keeps a herdr tab open; the placement is headless/);
});
