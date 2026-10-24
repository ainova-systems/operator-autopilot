import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { createHerdr, herdrRefusal, HerdrRefusal, shellQuote } from './herdr.ts';

test('the herdr adapter opens its own tab and names it, using the CLI\'s JSON answers', async () => {
  const calls: string[][] = [];
  const answers: Record<string, string> = {
    'workspace list': JSON.stringify({ result: { workspaces: [{ workspace_id: 'w1', label: 'tradintek-tomis-d1' }, { workspace_id: 'wA', label: 'operator-demo' }] } }),
    'tab create': JSON.stringify({ result: { root_pane: { pane_id: 'wA:p3', tab_id: 'wA:t3' }, tab: {} } }),
    'pane get': JSON.stringify({ result: { pane: { agent_status: 'blocked' } } }),
  };
  const herdr = createHerdr(async (args) => {
    calls.push(args);
    return answers[`${args[0]} ${args[1]}`] ?? '{"result":{}}';
  });
  assert.equal(await herdr.findWorkspace('operator-demo'), 'wA');
  assert.equal(await herdr.findWorkspace('w1'), 'w1');
  assert.equal(await herdr.findWorkspace('missing'), undefined);
  assert.deepEqual(await herdr.createTab('wA', '/repo', 'pr-7 op:review'), { tabId: 'wA:t3', paneId: 'wA:p3', workspaceId: 'wA' });
  await herdr.setTitle('wA:p3', 'pr-7 op:review');
  assert.equal(await herdr.agentStatus('wA:p3'), 'blocked');
  await herdr.closeTab('wA:t3');
  assert.deepEqual(calls[3], ['tab', 'create', '--workspace', 'wA', '--cwd', '/repo', '--label', 'pr-7 op:review', '--no-focus']);
  assert.deepEqual(calls[4], ['pane', 'report-metadata', 'wA:p3', '--source', 'operator', '--title', 'pr-7 op:review']);
  assert.deepEqual(calls.at(-1), ['tab', 'close', 'wA:t3']);
});

test('herdr being absent reads as unavailable, not as an error', async () => {
  const herdr = createHerdr(async () => { throw new Error('spawn herdr ENOENT'); });
  assert.equal(await herdr.available(), false);
});

test('pane commands quote arguments for the shell', () => {
  assert.equal(shellQuote('/usr/bin/node'), '/usr/bin/node');
  assert.equal(shellQuote('/tmp/my runs/a1'), "'/tmp/my runs/a1'");
  assert.equal(shellQuote("it's"), "'it'\\''s'");
});

test('a tab herdr no longer has counts as closed; any other refusal is reported', async () => {
  const refusing = (reason: string) => createHerdr(async () => { throw new HerdrRefusal(reason, `refused: ${reason}`); });
  assert.equal(await refusing('tab_not_found').closeTab('wA:t9'), 'gone');
  await assert.rejects(refusing('server_unavailable').closeTab('wA:t9'), /refused: server_unavailable/);
  assert.equal(await createHerdr(async () => '{"result":{}}').closeTab('wA:t3'), 'closed');
});

test('a failed herdr call is read for the reason it prints', () => {
  const refusal = herdrRefusal({ stdout: '', stderr: '{"error":{"code":"tab_not_found","message":"tab wD:t999 not found"},"id":"cli:tab:close"}\n' });
  assert.equal(refusal?.reason, 'tab_not_found');
  assert.equal(refusal?.message, 'tab wD:t999 not found');
  assert.equal(herdrRefusal({ stdout: '', stderr: '{"error":{"code":"tab_not_found"}}' }, ['tab', 'close', 'wD:t9'])?.message, 'herdr tab close wD:t9: tab_not_found');
  assert.equal(herdrRefusal({ stdout: '', stderr: 'socket closed' }), undefined);
  assert.equal(herdrRefusal(new Error('spawn herdr ENOENT')), undefined);
});
