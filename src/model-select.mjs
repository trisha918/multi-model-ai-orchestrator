import {
  ModelSelectionError,
  assertSafeModelValue,
  availableModels,
  findModelById,
  formatUnavailableManual,
  isAutoToken,
  isProfile,
  resolveAlias,
  resolveProfile,
} from './model-registry.mjs';
import { desiredProfile, modelReason, teamStageProfiles } from './model-policy.mjs';
import { classifyTask } from './router.mjs';

function providedValue(args, key) {
  if (args?.provided?.[key]) return args[key];
  return undefined;
}

function configValue(config, key, nestedTeamKey) {
  if (nestedTeamKey && config?.team && config.team[nestedTeamKey] != null) {
    return config.team[nestedTeamKey];
  }
  return config?.[key];
}

export function pickRequestedModel({ provider, route, args = {}, config = {} }) {
  const p = String(provider || '').toLowerCase();
  if (args.model && args.modelId) {
    throw new ModelSelectionError('Ambiguous model selection: pass only one of --model or --model-id.', {
      code: 'AMBIGUOUS_MODEL',
    });
  }
  const stageFlag = p === 'cursor' ? 'cursorModel' : p === 'codex' ? 'codexModel' : 'geminiModel';
  const cliStage = providedValue(args, stageFlag);
  const cliModel = providedValue(args, 'model');
  const cliId = providedValue(args, 'modelId');

  if (cliId) {
    return { kind: 'id', value: assertSafeModelValue(cliId, { exactId: true }), manual: true, source: 'cli' };
  }
  if (cliStage && isAutoToken(cliStage)) return { kind: 'auto', value: 'auto', manual: false, source: 'cli' };
  if (!cliStage && cliModel && isAutoToken(cliModel)) return { kind: 'auto', value: 'auto', manual: false, source: 'cli' };
  if (cliStage && !isAutoToken(cliStage)) {
    return { kind: 'alias', value: assertSafeModelValue(cliStage), manual: true, source: 'cli' };
  }
  if (cliModel && String(route).toLowerCase() !== 'team') {
    if (!isAutoToken(cliModel)) {
      return { kind: 'alias', value: assertSafeModelValue(cliModel), manual: true, source: 'cli' };
    }
  }
  if (String(route).toLowerCase() === 'team' && cliModel && !isAutoToken(cliModel)) {
    throw new ModelSelectionError('TEAM mode does not accept --model. Use --cursor-model, --codex-model, and/or --gemini-model.', {
      code: 'TEAM_MODEL_FLAG',
    });
  }

  const envKey = p === 'cursor' ? 'AI_CURSOR_MODEL' : p === 'codex' ? 'AI_CODEX_MODEL' : 'AI_GEMINI_MODEL';
  const envVal = args.env?.[envKey] ?? config._env?.[envKey];
  if (envVal && !isAutoToken(envVal)) {
    return { kind: 'alias', value: assertSafeModelValue(envVal), manual: true, source: 'env' };
  }

  const cfgTeam = p === 'cursor' ? 'cursorModel' : p === 'codex' ? 'codexModel' : 'geminiModel';
  const teamCfg = String(route).toLowerCase() === 'team' ? configValue(config, null, cfgTeam) : undefined;
  if (teamCfg && !isAutoToken(teamCfg)) {
    return { kind: 'alias', value: assertSafeModelValue(teamCfg), manual: true, source: 'config' };
  }
  const cfg = configValue(config, stageFlag);
  if (cfg && !isAutoToken(cfg)) {
    return { kind: 'alias', value: assertSafeModelValue(cfg), manual: true, source: 'config' };
  }
  return { kind: 'auto', value: 'auto', manual: false, source: 'auto' };
}

function failManual({ provider, requested, registry }) {
  throw new ModelSelectionError(formatUnavailableManual({ provider, requested, registry }), {
    code: 'UNAVAILABLE_MODEL',
    provider,
    requested,
  });
}

export function resolveProviderModel({
  provider,
  task,
  route,
  args = {},
  config = {},
  registry,
  classification,
}) {
  const analysis = classification || classifyTask(task);
  const requested = pickRequestedModel({ provider, route, args, config });
  const preferredProfile = desiredProfile(task, analysis);

  if (requested.manual) {
    if (requested.kind === 'id') {
      const found = findModelById(registry, provider, requested.value);
      if (!found || found.available !== true) {
        failManual({ provider, requested: requested.value, registry });
      }
      return {
        provider,
        selection: 'manual',
        requestedAlias: requested.value,
        profile: found.tier || '',
        model: found.id,
        manual: true,
        reason: modelReason(found.tier || 'manual', { provider, manual: true, alias: requested.value }),
      };
    }

    if (isProfile(requested.value)) {
      const resolved = resolveProfile(registry, provider, requested.value);
      if (!resolved?.model || resolved.fallback) {
        failManual({ provider, requested: requested.value, registry });
      }
      if (resolved.model.available !== true && provider !== 'cursor') {
        failManual({ provider, requested: requested.value, registry });
      }
      return {
        provider,
        selection: 'manual',
        requestedAlias: requested.value,
        profile: requested.value,
        model: resolved.model.id,
        manual: true,
        reason: modelReason(requested.value, { provider, manual: true, alias: requested.value }),
      };
    }

    const aliased = resolveAlias(registry, provider, requested.value);
    if (!aliased || aliased.available !== true) {
      failManual({ provider, requested: requested.value, registry });
    }
    return {
      provider,
      selection: 'manual',
      requestedAlias: requested.value,
      profile: aliased.tier || '',
      model: aliased.id,
      manual: true,
      reason: modelReason(aliased.tier || 'manual', { provider, manual: true, alias: requested.value }),
    };
  }

  const resolved = resolveProfile(registry, provider, preferredProfile);
  if (!resolved?.model) {
    if (provider === 'cursor') {
      return {
        provider,
        selection: 'auto',
        requestedAlias: 'auto',
        profile: preferredProfile,
        preferred: preferredProfile,
        model: 'auto',
        manual: false,
        fallback: true,
        reason: 'No Cursor model catalog; using Auto',
      };
    }
    const any = availableModels(registry, provider)[0];
    if (!any) {
      if (provider === 'codex') {
        return {
          provider,
          selection: 'auto',
          requestedAlias: 'auto',
          profile: preferredProfile,
          preferred: preferredProfile,
          model: '',
          manual: false,
          fallback: true,
          reason: 'Codex model enumeration unavailable; CLI default will be used',
        };
      }
      throw new ModelSelectionError(`No available ${provider} models were discovered.`, {
        code: 'NO_MODELS',
        provider,
      });
    }
    return {
      provider,
      selection: 'auto',
      requestedAlias: 'auto',
      profile: any.tier || preferredProfile,
      preferred: preferredProfile,
      model: any.id,
      manual: false,
      fallback: true,
      reason: resolved?.reason || 'Fell back to an available model',
    };
  }
  return {
    provider,
    selection: 'auto',
    requestedAlias: 'auto',
    profile: resolved.profile,
    preferred: preferredProfile,
    model: resolved.model.id,
    manual: false,
    fallback: Boolean(resolved.fallback),
    reason: resolved.reason || modelReason(resolved.profile, { provider }),
  };
}

export function resolveRunModels({ task, route, args, config, registry, classification }) {
  if (args?.provided?.model && args.provided.modelId) {
    throw new ModelSelectionError('Ambiguous model selection: pass only one of --model or --model-id.', {
      code: 'AMBIGUOUS_MODEL',
    });
  }
  const analysis = classification || classifyTask(task);
  const label = String(route || '').toUpperCase();
  if (label === 'TEAM') {
    const stages = teamStageProfiles(task, analysis);
    const plan = resolveProviderModel({
      provider: 'cursor', task, route: 'TEAM', args, config, registry, classification: analysis,
    });
    const implementation = resolveProviderModel({
      provider: 'codex', task, route: 'TEAM', args, config, registry, classification: analysis,
    });
    const review = resolveProviderModel({
      provider: 'gemini', task, route: 'TEAM', args, config, registry, classification: analysis,
    });
    if (!args.cursorModel || isAutoToken(args.cursorModel)) {
      if (!plan.manual) {
        const forced = resolveProfile(registry, 'cursor', stages.plan);
        if (forced?.model) {
          plan.profile = forced.profile;
          plan.preferred = stages.plan;
          plan.model = forced.model.id;
          plan.fallback = forced.fallback;
          plan.reason = forced.reason;
        }
      }
    }
    if (!implementation.manual) {
      const forced = resolveProfile(registry, 'codex', stages.implementation);
      if (forced?.model) {
        implementation.profile = forced.profile;
        implementation.preferred = stages.implementation;
        implementation.model = forced.model.id;
        implementation.fallback = forced.fallback;
        implementation.reason = forced.reason;
      }
    }
    if (!review.manual) {
      const forced = resolveProfile(registry, 'gemini', stages.review);
      if (forced?.model) {
        review.profile = forced.profile;
        review.preferred = stages.review;
        review.model = forced.model.id;
        review.fallback = forced.fallback;
        review.reason = forced.reason;
      }
    }
    const fix = { ...implementation, profile: stages.fix };
    if (!implementation.manual) {
      const forcedFix = resolveProfile(registry, 'codex', stages.fix);
      if (forcedFix?.model) {
        fix.profile = forcedFix.profile;
        fix.preferred = stages.fix;
        fix.model = forcedFix.model.id;
        fix.fallback = forcedFix.fallback;
      }
    }
    return {
      selection: [plan, implementation, review].some(s => s.manual) ? 'mixed' : 'auto',
      stages: { plan, implementation, review, fix },
    };
  }
  const provider = label === 'CURSOR' ? 'cursor' : label === 'CODEX' ? 'codex' : 'gemini';
  const single = resolveProviderModel({
    provider, task, route: label, args, config, registry, classification: analysis,
  });
  return { selection: single.selection, worker: single };
}

export function modelsJsonPayload({ route, resolved }) {
  if (String(route).toUpperCase() === 'TEAM') {
    const s = resolved.stages;
    return {
      route: 'TEAM',
      selection: resolved.selection,
      stages: {
        plan: {
          provider: 'cursor',
          profile: s.plan.profile,
          model: s.plan.model,
          manual: Boolean(s.plan.manual),
        },
        implementation: {
          provider: 'codex',
          profile: s.implementation.profile,
          model: s.implementation.model,
          manual: Boolean(s.implementation.manual),
        },
        review: {
          provider: 'gemini',
          profile: s.review.profile,
          model: s.review.model,
          manual: Boolean(s.review.manual),
        },
        fix: {
          provider: 'codex',
          profile: s.fix.profile,
          model: s.fix.model,
          manual: Boolean(s.fix.manual),
        },
      },
    };
  }
  const w = resolved.worker;
  return {
    route: String(route).toUpperCase(),
    selection: w.selection,
    worker: {
      provider: w.provider,
      profile: w.profile,
      model: w.model,
      manual: Boolean(w.manual),
      requestedAlias: w.requestedAlias,
      reason: w.reason,
    },
  };
}
