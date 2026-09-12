import test from 'node:test';
import assert from 'node:assert/strict';
import { authorizeAiAutoTrigger, extractLabelEventActor, BLOCK_UNTRUSTED } from './github-auth.mjs';

test('trusted owner/member/collaborator may trigger ai-auto', () => {
  for (const association of ['OWNER', 'MEMBER', 'COLLABORATOR']) {
    const r = authorizeAiAutoTrigger({
      triggerLabelPresent: true,
      actorLogin: 'ben',
      association,
    });
    assert.equal(r.ok, true, association);
  }
  const write = authorizeAiAutoTrigger({
    triggerLabelPresent: true,
    actorLogin: 'ben',
    permission: 'write',
  });
  assert.equal(write.ok, true);
});

test('untrusted actor is blocked and must not start workers', () => {
  const r = authorizeAiAutoTrigger({
    triggerLabelPresent: true,
    actorLogin: 'random-user',
    association: 'NONE',
    permission: 'none',
  });
  assert.equal(r.ok, false);
  assert.equal(r.blocked, true);
  assert.equal(r.reason, BLOCK_UNTRUSTED);
});

test('allowlisted actor can trigger without org association', () => {
  const r = authorizeAiAutoTrigger({
    triggerLabelPresent: true,
    actorLogin: 'contractor',
    association: 'NONE',
    allowedUsers: ['contractor'],
  });
  assert.equal(r.ok, true);
});

test('missing ai-auto skips rather than authorizing from issue text', () => {
  const r = authorizeAiAutoTrigger({
    triggerLabelPresent: false,
    actorLogin: 'owner',
    association: 'OWNER',
  });
  assert.equal(r.skip, true);
  assert.equal(r.ok, false);
});

test('label event actor is taken from GitHub metadata not issue body', () => {
  const actor = extractLabelEventActor([
    { event: 'labeled', label: { name: 'bug' }, actor: { login: 'stranger' } },
    { event: 'labeled', label: { name: 'ai-auto' }, actor: { login: 'maintainer' }, author_association: 'OWNER' },
  ]);
  assert.equal(actor.login, 'maintainer');
  assert.equal(actor.association, 'OWNER');
});
