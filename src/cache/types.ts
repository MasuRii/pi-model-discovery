import type { ProviderModelConfig } from "@earendil-works/pi-coding-agent";

import type { CapabilityFlags, InputModality, OutputModality, ThinkingLevelMap } from "../config/types.js";
import type { EndpointModelMetadata, EndpointPricingMetadata } from "../discovery/types.js";

export type CapabilityProvenance = Partial<Record<"id" | "name" | "baseUrl" | "reasoning" | "thinkingLevelMap" | "input" | "output" | "capabilities" | "cost" | "contextWindow" | "maxTokens" | "compat" | "description" | "created" | "ownedBy" | "tags" | "isFree" | "endpointPricing" | "endpointMetadata", string>>;

export type DiscoveredModel = Omit<ProviderModelConfig, "input"> & {
  input: InputModality[];
  output?: OutputModality[];
  capabilities?: CapabilityFlags;
  baseUrl?: string;
  thinkingLevelMap?: ThinkingLevelMap;
  description?: string;
  created?: number;
  ownedBy?: string;
  tags?: string[];
  isFree?: boolean;
  endpointPricing?: EndpointPricingMetadata;
  endpointMetadata?: EndpointModelMetadata;
  sources: Record<string, boolean>;
  capabilityProvenance?: CapabilityProvenance;
};

export interface CacheEntry {
  fetchedAt: string;
  ttlMs: number;
  authoritative: boolean;
  models: DiscoveredModel[];
  schemaVersion?: number;
}

export interface CacheSchema {
  version: 5;
  updatedAt: string;
  providers: Record<string, CacheEntry>;
}
