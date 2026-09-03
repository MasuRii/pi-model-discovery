import type { ProviderConfigEntry } from "../config/types.js";
import { isLikelyNonTextGenerationModel } from "../shared/model-kind.js";
import { createEmptyCache, readCacheFile, writeCacheFile } from "./json-store.js";
import type { CacheEntry, CacheSchema, DiscoveredModel } from "./types.js";

export const NON_AUTHORITATIVE_RETRY_MS = 5 * 60 * 1000;
export const CURRENT_CACHE_SCHEMA_VERSION = 2;

function hasLegacyGlobalDefaultOnlyMetadata(entry: CacheEntry): boolean {
  return entry.models.some((model) => {
    if (model.sources.globalDefaults !== true) return false;
    const provenanceEntries = Object.entries(model.capabilityProvenance ?? {}).filter(([field]) => field !== "id");
    return provenanceEntries.length === 0 || provenanceEntries.every(([_field, source]) => source === "globalDefaults");
  });
}

function hasLegacyBlazeApiClaudeAnthropicOverrides(providerId: string | undefined, entry: CacheEntry): boolean {
  if (providerId !== "blazeapi") return false;
  return entry.models.some((model) => {
    const routeId = model.endpointMetadata?.routingGroup ?? model.endpointMetadata?.providerId ?? model.id;
    if (!/^route:claude-|^claude-/i.test(routeId)) return false;
    return model.api === "anthropic-messages" || /\/anthropic\/?$/i.test(model.baseUrl ?? "");
  });
}

function compatSupportsReasoningEffort(compat: DiscoveredModel["compat"] | undefined): boolean {
  return (compat as { supportsReasoningEffort?: unknown } | undefined)?.supportsReasoningEffort === true;
}

function hasLegacyModelGap(
  providerId: string | undefined,
  entry: CacheEntry,
  idPattern: RegExp,
  hasGap: (model: DiscoveredModel) => boolean,
): boolean {
  if (providerId === undefined) return false;
  return entry.models.some((model) => {
    if (!idPattern.test(model.id)) return false;
    return hasGap(model);
  });
}

function hasLegacyOpenAIReasoningCompatGaps(providerId: string | undefined, entry: CacheEntry): boolean {
  return hasLegacyModelGap(providerId, entry, /(^|\/)gpt-[5-9](?:[.\-]\d+)?(?:[.\-][\w.-]+)?(?:$|[:/])/i, (model) => model.reasoning !== true || !compatSupportsReasoningEffort(model.compat) || model.thinkingLevelMap?.minimal !== null || model.thinkingLevelMap?.xhigh !== "xhigh");
}

function hasLegacyClaudeOpusThinkingLevelGaps(providerId: string | undefined, entry: CacheEntry): boolean {
  return hasLegacyModelGap(providerId, entry, /(^|\/)claude-opus-4-[678](?:$|[-:/])/i, (model) => model.reasoning !== true || model.thinkingLevelMap?.xhigh === undefined);
}

function hasLegacyGlm52ThinkingLevelGaps(providerId: string | undefined, entry: CacheEntry): boolean {
  return hasLegacyModelGap(providerId, entry, /(^|\/)glm-5\.2(?:$|[-:/])/i, (model) => model.reasoning === true && model.thinkingLevelMap?.xhigh === undefined);
}

const LEGACY_CATALOG_CACHE_OVERLAY_PATTERN = /(^|\/)(?:gpt-[5-9]|claude-(?:haiku|opus|sonnet)-4|gemini-(?:2\.5|3)|grok-4|kimi-k2|mimo-v2|deepseek-v4|qwen3\.5|glm-4\.7|gpt-oss-120b)(?:$|[-.:/])/i;

function hasLegacyCatalogCacheOverlay(entry: CacheEntry): boolean {
  return entry.models.some((model) => {
    if (model.sources.modelsDev !== true) return false;
    if (!LEGACY_CATALOG_CACHE_OVERLAY_PATTERN.test(model.id)) return false;
    return model.capabilityProvenance?.contextWindow === "cache" || model.capabilityProvenance?.maxTokens === "cache";
  });
}

function hasLegacyNonTextGenerationModels(entry: CacheEntry): boolean {
  return entry.models.some((model) => isLikelyNonTextGenerationModel(model));
}

export function isCacheEntryFresh(entry: CacheEntry, now = new Date(), providerId?: string): boolean {
  // The legacy validators below are one-time migrations for entries written
  // before the enrichment pipeline filled reasoning metadata itself. Gating
  // them on schemaVersion prevents a permanent writer/validator mismatch: the
  // current writer legitimately emits gap-pattern models without that
  // metadata (non-reasoning gpt-5* variants, catalog-unmatched opus/glm
  // ids), which would otherwise keep every freshly written entry stale and
  // defeat cache-first startup registration entirely.
  const isCurrentSchema = entry.schemaVersion === CURRENT_CACHE_SCHEMA_VERSION;
  if (!isCurrentSchema) {
    if (!entry.authoritative && entry.models.length === 0) return false;
    if (hasLegacyGlobalDefaultOnlyMetadata(entry)) return false;
    if (hasLegacyBlazeApiClaudeAnthropicOverrides(providerId, entry)) return false;
    if (hasLegacyOpenAIReasoningCompatGaps(providerId, entry)) return false;
    if (hasLegacyClaudeOpusThinkingLevelGaps(providerId, entry)) return false;
    if (hasLegacyGlm52ThinkingLevelGaps(providerId, entry)) return false;
    if (hasLegacyCatalogCacheOverlay(entry)) return false;
    if (hasLegacyNonTextGenerationModels(entry)) return false;
  }
  const fetchedAtMs = Date.parse(entry.fetchedAt);
  if (!Number.isFinite(fetchedAtMs)) return false;
  const maxAge = entry.authoritative ? entry.ttlMs : NON_AUTHORITATIVE_RETRY_MS;
  return now.getTime() - fetchedAtMs < maxAge;
}

export function isProviderCacheEntryFresh(providerId: string, entry: CacheEntry, now = new Date()): boolean {
  return isCacheEntryFresh(entry, now, providerId);
}

export interface CacheProviderWrite {
  provider: ProviderConfigEntry;
  models: DiscoveredModel[];
  authoritative: boolean;
}

export class CacheManager {
  constructor(private readonly cachePath: string) {}

  read(): CacheSchema {
    return readCacheFile(this.cachePath);
  }

  getFreshEntry(providerId: string, now = new Date()): CacheEntry | undefined {
    const entry = this.read().providers[providerId];
    if (!entry) return undefined;
    return isProviderCacheEntryFresh(providerId, entry, now) ? entry : undefined;
  }

  getAnyEntry(providerId: string): CacheEntry | undefined {
    return this.read().providers[providerId];
  }

  async writeProvider(provider: ProviderConfigEntry, models: DiscoveredModel[], authoritative: boolean, now = new Date()): Promise<void> {
    await this.writeProviders([{ provider, models, authoritative }], now);
  }

  async writeProviderEntry(providerId: string, entry: CacheEntry): Promise<void> {
    const cache = this.read();
    cache.providers[providerId] = entry;
    await writeCacheFile(this.cachePath, cache);
  }

  async writeProviders(entries: CacheProviderWrite[], now = new Date()): Promise<void> {
    if (entries.length === 0) return;
    const cache = this.read();
    const fetchedAt = now.toISOString();
    for (const { provider, models, authoritative } of entries) {
      cache.providers[provider.id] = {
        fetchedAt,
        ttlMs: provider.discovery.ttlMs ?? 2 * 60 * 60 * 1000,
        authoritative,
        models,
        schemaVersion: CURRENT_CACHE_SCHEMA_VERSION,
      };
    }
    await writeCacheFile(this.cachePath, cache);
  }

  private async deleteProviderIds(providerIds: readonly string[], cache: CacheSchema): Promise<string[]> {
    const removed: string[] = [];
    for (const providerId of providerIds) {
      if (!(providerId in cache.providers)) continue;
      delete cache.providers[providerId];
      removed.push(providerId);
    }
    if (removed.length > 0) await writeCacheFile(this.cachePath, cache);
    return removed;
  }

  async pruneProviders(activeProviderIds: ReadonlySet<string>): Promise<string[]> {
    const cache = this.read();
    const removable = Object.keys(cache.providers).filter((providerId) => !activeProviderIds.has(providerId));
    return this.deleteProviderIds(removable, cache);
  }

  async pruneProviderIds(providerIds: ReadonlySet<string>): Promise<string[]> {
    if (providerIds.size === 0) return [];
    const cache = this.read();
    return this.deleteProviderIds([...providerIds], cache);
  }

  async replaceAll(entries: Record<string, CacheEntry>, now = new Date()): Promise<void> {
    await writeCacheFile(this.cachePath, {
      ...createEmptyCache(now),
      providers: entries,
    });
  }
}
