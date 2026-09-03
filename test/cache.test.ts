import { mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import assert from "node:assert/strict";

import { CacheManager, CURRENT_CACHE_SCHEMA_VERSION, isCacheEntryFresh, isProviderCacheEntryFresh, NON_AUTHORITATIVE_RETRY_MS } from "../src/cache/manager.js";
import { CACHE_SCHEMA_VERSION, readCacheFile } from "../src/cache/json-store.js";
import type { CacheEntry, DiscoveredModel } from "../src/cache/types.js";
import type { ProviderConfigEntry } from "../src/config/types.js";
import { createTestApiKey } from "./support/secrets.js";

const model: DiscoveredModel = {
  id: "raw/provider-model",
  name: "Provider Model",
  reasoning: false,
  input: ["text"],
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  contextWindow: 128000,
  maxTokens: 16384,
  sources: { test: true },
};

const TEST_API_KEY = createTestApiKey("cache");

const provider: ProviderConfigEntry = {
  id: "test-provider",
  baseUrl: "http://127.0.0.1:8000/v1",
  apiKey: TEST_API_KEY,
  api: "openai-completions" as ProviderConfigEntry["api"],
  authHeader: true,
  headers: {},
  discovery: {
    type: "openai-compat",
    enabled: true,
    headers: {},
    timeoutMs: 1000,
    ttlMs: 60_000,
    includeDetails: false,
    allowModels: [],
    blockModels: [],
  },
  defaults: {},
  modelDefaults: {},
  source: "explicit",
};

test("cache TTL uses authoritative TTL and non-authoritative retry windows", () => {
  const now = new Date("2026-05-01T00:10:00.000Z");
  const authoritative: CacheEntry = { fetchedAt: "2026-05-01T00:00:00.000Z", ttlMs: 60 * 60 * 1000, authoritative: true, models: [] };
  const staleAuthoritative: CacheEntry = { ...authoritative, ttlMs: 1000 };
  const nonAuthoritative: CacheEntry = { fetchedAt: new Date(now.getTime() - NON_AUTHORITATIVE_RETRY_MS + 1000).toISOString(), ttlMs: 60 * 60 * 1000, authoritative: false, models: [model] };
  assert.equal(isCacheEntryFresh(authoritative, now), true);
  assert.equal(isCacheEntryFresh(staleAuthoritative, now), false);
  assert.equal(isCacheEntryFresh(nonAuthoritative, now), true);
});

test("cache freshness rejects empty non-authoritative entries so transient startup failures retry quickly", () => {
  const now = new Date("2026-05-01T00:10:00.000Z");
  const emptyNonAuthoritative: CacheEntry = {
    fetchedAt: new Date(now.getTime() - 1000).toISOString(),
    ttlMs: 60 * 60 * 1000,
    authoritative: false,
    models: [],
  };
  const fallbackNonAuthoritative: CacheEntry = {
    ...emptyNonAuthoritative,
    models: [model],
  };

  assert.equal(isCacheEntryFresh(emptyNonAuthoritative, now), false);
  assert.equal(isCacheEntryFresh(fallbackNonAuthoritative, now), true);
});

test("current-schema entries skip legacy migration validators and stay fresh", () => {
  const now = new Date("2026-05-01T00:10:00.000Z");
  // The current enrichment writer emits gpt-5* models without reasoning
  // metadata when reasoning is false or the catalog match failed. Under the
  // legacy validators such an entry was permanently stale, so cache-first
  // startup registration never happened.
  const gapModel: DiscoveredModel = {
    ...model,
    id: "gpt-5-codex-mini",
    reasoning: false,
  };
  const currentEntry: CacheEntry = {
    fetchedAt: "2026-05-01T00:09:00.000Z",
    ttlMs: 60 * 60 * 1000,
    authoritative: true,
    models: [gapModel],
    schemaVersion: CURRENT_CACHE_SCHEMA_VERSION,
  };
  const legacyEntry: CacheEntry = { ...currentEntry, schemaVersion: undefined };

  assert.equal(isProviderCacheEntryFresh("test-provider", currentEntry, now), true);
  assert.equal(isProviderCacheEntryFresh("test-provider", legacyEntry, now), false);
});

test("cache freshness rejects legacy entries that only contain global-default metadata", () => {
  const now = new Date("2026-05-01T00:10:00.000Z");
  const legacyEntry: CacheEntry = {
    fetchedAt: "2026-05-01T00:09:00.000Z",
    ttlMs: 60 * 60 * 1000,
    authoritative: true,
    models: [
      {
        ...model,
        sources: { dynamic: true, globalDefaults: true },
        capabilityProvenance: { id: "dynamic" },
      },
    ],
  };
  const enrichedEntry: CacheEntry = {
    ...legacyEntry,
    models: [
      {
        ...legacyEntry.models[0]!,
        capabilityProvenance: { id: "dynamic", contextWindow: "modelsDev" },
      },
    ],
  };

  assert.equal(isCacheEntryFresh(legacyEntry, now), false);
  assert.equal(isCacheEntryFresh(enrichedEntry, now), true);
});

test("provider cache freshness rejects legacy BlazeAPI Claude Anthropic endpoint pollution", () => {
  const now = new Date("2026-05-01T00:10:00.000Z");
  const pollutedEntry: CacheEntry = {
    fetchedAt: "2026-05-01T00:09:00.000Z",
    ttlMs: 60 * 60 * 1000,
    authoritative: true,
    models: [
      {
        ...model,
        id: "claude-opus-4.7",
        api: "anthropic-messages" as never,
        baseUrl: "https://blazeai.boxu.dev/api/anthropic",
        endpointMetadata: {
          providerId: "route:claude-opus-4.7",
          routingGroup: "claude-opus-4.7",
        },
        sources: { dynamic: true, modelsDev: true },
        capabilityProvenance: { id: "dynamic", contextWindow: "modelsDev" },
      },
    ],
  };
  const cleanEntry: CacheEntry = {
    ...pollutedEntry,
    models: [
      {
        ...pollutedEntry.models[0]!,
        api: undefined,
        baseUrl: undefined,
      },
    ],
  };

  assert.equal(isProviderCacheEntryFresh("blazeapi", pollutedEntry, now), false);
  assert.equal(isProviderCacheEntryFresh("providerx", pollutedEntry, now), true);
  assert.equal(isProviderCacheEntryFresh("blazeapi", cleanEntry, now), true);
});

test("provider cache freshness rejects legacy OpenAI-compatible reasoning metadata gaps", () => {
  const now = new Date("2026-05-01T00:10:00.000Z");
  const staleReasoningEntry: CacheEntry = {
    fetchedAt: "2026-05-01T00:09:00.000Z",
    ttlMs: 60 * 60 * 1000,
    authoritative: true,
    models: [
      {
        ...model,
        id: "gpt-5.5-openai-compact",
        reasoning: true,
        compat: {},
        sources: { dynamic: true, modelsDev: true },
        capabilityProvenance: { id: "dynamic", reasoning: "modelsDev" },
      },
    ],
  };
  const freshReasoningEntry: CacheEntry = {
    ...staleReasoningEntry,
    models: [
      {
        ...staleReasoningEntry.models[0]!,
        compat: { supportsReasoningEffort: true },
        thinkingLevelMap: { off: "none", minimal: null, xhigh: "xhigh" },
      },
    ],
  };

  assert.equal(isProviderCacheEntryFresh("qianxiang", staleReasoningEntry, now), false);
  assert.equal(isProviderCacheEntryFresh("qianxiang", freshReasoningEntry, now), true);
});

test("provider cache freshness rejects legacy Claude Opus entries without xhigh metadata", () => {
  const now = new Date("2026-05-01T00:10:00.000Z");
  const staleOpusEntry: CacheEntry = {
    fetchedAt: "2026-05-01T00:09:00.000Z",
    ttlMs: 60 * 60 * 1000,
    authoritative: true,
    models: [
      {
        ...model,
        id: "claude-opus-4-8",
        reasoning: true,
        sources: { dynamic: true, modelsDev: true },
        capabilityProvenance: { id: "dynamic", reasoning: "modelsDev" },
      },
    ],
  };
  const freshOpusEntry: CacheEntry = {
    ...staleOpusEntry,
    models: [
      {
        ...staleOpusEntry.models[0]!,
        thinkingLevelMap: { xhigh: "xhigh" },
      },
    ],
  };

  assert.equal(isProviderCacheEntryFresh("qianxiang", staleOpusEntry, now), false);
  assert.equal(isProviderCacheEntryFresh("qianxiang", freshOpusEntry, now), true);
});

test("provider cache freshness rejects legacy GLM-5.2 entries without xhigh metadata", () => {
  const now = new Date("2026-05-01T00:10:00.000Z");
  const staleGlmEntry: CacheEntry = {
    fetchedAt: "2026-05-01T00:09:00.000Z",
    ttlMs: 60 * 60 * 1000,
    authoritative: true,
    models: [
      {
        ...model,
        id: "@cf/zai-org/glm-5.2",
        reasoning: true,
        sources: { dynamic: true, modelsDev: true },
        capabilityProvenance: { id: "dynamic", reasoning: "modelsDev" },
      },
    ],
  };
  const freshGlmEntry: CacheEntry = {
    ...staleGlmEntry,
    models: [
      {
        ...staleGlmEntry.models[0]!,
        thinkingLevelMap: { xhigh: "max" },
      },
    ],
  };

  assert.equal(isProviderCacheEntryFresh("cloudflare", staleGlmEntry, now), false);
  assert.equal(isProviderCacheEntryFresh("cloudflare", freshGlmEntry, now), true);
});

test("provider cache freshness rejects legacy catalog metadata hidden behind cache provenance", () => {
  const now = new Date("2026-05-01T00:10:00.000Z");
  const staleCatalogOverlay: CacheEntry = {
    fetchedAt: "2026-05-01T00:09:00.000Z",
    ttlMs: 60 * 60 * 1000,
    authoritative: true,
    models: [
      {
        ...model,
        id: "gpt-5.5",
        reasoning: true,
        compat: { supportsReasoningEffort: true },
        thinkingLevelMap: { off: "none", minimal: null, xhigh: "xhigh" },
        sources: { dynamic: true, cache: true, modelsDev: true },
        capabilityProvenance: { id: "dynamic", contextWindow: "cache", maxTokens: "modelsDev" },
      },
    ],
  };
  const freshCatalogOverlay: CacheEntry = {
    ...staleCatalogOverlay,
    models: [
      {
        ...staleCatalogOverlay.models[0]!,
        capabilityProvenance: { id: "dynamic", contextWindow: "modelsDev", maxTokens: "modelsDev" },
      },
    ],
  };

  assert.equal(isProviderCacheEntryFresh("swtaiapi", staleCatalogOverlay, now), false);
  assert.equal(isProviderCacheEntryFresh("swtaiapi", freshCatalogOverlay, now), true);
});

test("provider cache freshness rejects legacy non-chat OpenAI-compatible cache entries", () => {
  const now = new Date("2026-05-01T00:10:00.000Z");
  const staleNonChatEntry: CacheEntry = {
    fetchedAt: "2026-05-01T00:09:00.000Z",
    ttlMs: 60 * 60 * 1000,
    authoritative: true,
    models: [
      {
        ...model,
        id: "gpt-image-2",
        name: "GPT Image 2",
        sources: { dynamic: true, endpointMetadata: true },
        capabilityProvenance: { id: "dynamic", contextWindow: "endpointMetadata" },
      },
    ],
  };
  const freshChatEntry: CacheEntry = {
    ...staleNonChatEntry,
    models: [
      {
        ...staleNonChatEntry.models[0]!,
        id: "chat-model",
        name: "Chat Model",
      },
    ],
  };

  assert.equal(isProviderCacheEntryFresh("swtaiapi", staleNonChatEntry, now), false);
  assert.equal(isProviderCacheEntryFresh("swtaiapi", freshChatEntry, now), true);
});

test("cache provider batch writes read and write the cache once", async () => {
  const dir = mkdtempSync(join(tmpdir(), "pi-model-discovery-cache-batch-"));
  const cachePath = join(dir, "cache.json");
  const manager = new CacheManager(cachePath);

  await manager.writeProviders([{ provider, models: [model], authoritative: true }], new Date("2026-05-01T00:00:00.000Z"));

  const parsed = JSON.parse(readFileSync(cachePath, "utf-8")) as { providers: Record<string, CacheEntry> };
  assert.equal(parsed.providers[provider.id]?.models[0]?.id, "raw/provider-model");
  assert.equal(parsed.providers[provider.id]?.authoritative, true);
  assert.equal(manager.getFreshEntry(provider.id, new Date("2026-05-01T00:00:01.000Z"))?.models[0]?.id, "raw/provider-model");
});

test("cache writes are atomic JSON writes and invalid JSON is regenerated", async () => {
  const dir = mkdtempSync(join(tmpdir(), "pi-model-discovery-cache-"));
  const cachePath = join(dir, "cache.json");
  const manager = new CacheManager(cachePath);
  await manager.writeProvider(provider, [model], true, new Date("2026-05-01T00:00:00.000Z"));
  const parsed = JSON.parse(readFileSync(cachePath, "utf-8")) as { providers: Record<string, unknown> };
  assert.ok(parsed.providers[provider.id]);
  if (process.platform !== "win32") {
    assert.equal(statSync(cachePath).mode & 0o777, 0o600);
  }

  writeFileSync(cachePath, "{ invalid json", "utf-8");
  const regenerated = readCacheFile(cachePath);
  assert.deepEqual(regenerated.providers, {});
});

test("legacy cache schemas are regenerated after models.dev Pi Mono mapping changes", () => {
  const dir = mkdtempSync(join(tmpdir(), "pi-model-discovery-cache-version-"));
  const cachePath = join(dir, "cache.json");
  writeFileSync(
    cachePath,
    JSON.stringify({ version: 3, updatedAt: "2026-05-01T00:00:00.000Z", providers: { [provider.id]: { fetchedAt: "2026-05-01T00:00:00.000Z", ttlMs: 60_000, authoritative: true, models: [model] } } }),
    "utf-8",
  );

  assert.equal(CACHE_SCHEMA_VERSION, 5);
  assert.deepEqual(readCacheFile(cachePath).providers, {});
});
