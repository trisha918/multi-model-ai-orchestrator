const TRUSTED_ASSOCIATIONS = new Set(['OWNER', 'MEMBER', 'COLLABORATOR']);
const TRUSTED_PERMISSIONS = new Set(['admin', 'maintain', 'write']);

export const BLOCK_UNTRUSTED = 'untrusted trigger actor';

export function normalizeLogin(login) {
  return String(login || '').trim().replace(/^@/, '').toLowerCase();
}

export function isTrustedAssociation(association) {
  return TRUSTED_ASSOCIATIONS.has(String(association || '').trim().toUpperCase());
}

export function isTrustedPermission(permission) {
  return TRUSTED_PERMISSIONS.has(String(permission || '').trim().toLowerCase());
}

/**
 * Authorize an ai-auto trigger using GitHub actor metadata, never issue text.
 */
export function authorizeAiAutoTrigger({
  triggerLabelPresent = false,
  triggerLabelName = 'ai-auto',
  labeledBy = '',
  actorLogin = '',
  association = '',
  permission = '',
  allowedUsers = [],
} = {}) {
  const actor = normalizeLogin(actorLogin || labeledBy);
  const allowed = new Set((allowedUsers || []).map(normalizeLogin).filter(Boolean));
  const allowlisted = Boolean(actor) && allowed.has(actor);
  const trustedMeta = isTrustedAssociation(association) || isTrustedPermission(permission);

  if (!triggerLabelPresent) {
    return {
      ok: false,
      blocked: false,
      skip: true,
      reason: `Trigger label ${triggerLabelName} is not present`,
      actor,
    };
  }

  if (!actor) {
    return {
      ok: false,
      blocked: true,
      skip: false,
      reason: BLOCK_UNTRUSTED,
      detail: 'Trigger actor is missing from GitHub metadata',
      actor: '',
    };
  }

  if (!trustedMeta && !allowlisted) {
    return {
      ok: false,
      blocked: true,
      skip: false,
      reason: BLOCK_UNTRUSTED,
      detail: `Actor @${actor} is not OWNER/MEMBER/COLLABORATOR and is not in allowed_actors`,
      actor,
    };
  }

  return {
    ok: true,
    blocked: false,
    skip: false,
    reason: allowlisted && !trustedMeta ? 'allowlisted actor' : 'trusted repository actor',
    actor,
  };
}

export function extractLabelEventActor(events, labelName = 'ai-auto') {
  const wanted = String(labelName || 'ai-auto').toLowerCase();
  const labeled = (events || []).filter(ev => {
    const action = String(ev.event || ev.type || '').toLowerCase();
    const name = String(ev.label?.name || ev.label || '').toLowerCase();
    return (action === 'labeled' || action === 'issueslabeled') && name === wanted;
  });
  const last = labeled[labeled.length - 1];
  if (!last) return { login: '', association: '', permission: '' };
  return {
    login: last.actor?.login || last.sender?.login || last.login || '',
    association: last.author_association || last.actor?.author_association || '',
    permission: last.permission || last.actor?.permission || '',
  };
}
