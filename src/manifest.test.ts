import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { ManifestError, parseManifest } from './manifest.ts';

const VALID = `
contract: 1
project: tomis
state: { provider: ainoflow }
pools:
  codex-review: { limit: 3, shared: true }
  claude-slot: { workspaces: [d1] }
workflows:
  development:
    timezone: Europe/Vilnius
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
  assert.equal(manifest.project, 'tomis');
  assert.equal(manifest.state.namespace, 'op-tomis');
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
