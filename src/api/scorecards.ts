/**
 * Scorecard template and threshold client, on hapi-server-scorecards (`/v2/templates`,
 * `/v2/thresholds`), over the same port-forward and headers as `thresholdEvents.ts`.
 *
 * Why the suite needs it: hapi-server-live-events only turns a harsh trip event into a
 * scorecard violation when the asset has a `scorecard_template_id` and that template has a
 * threshold for the event type (`processor-scorecard/consumers/standardEventConsumer.js`,
 * `lookupAssetTemplateThresholds`). Fixture assets are created with none, so without this their
 * trips never have violations to reassign.
 *
 * Handlers: `scorecard-api/handlers/template/templateCreate` and `templateList`,
 * `threshold/thresholdCreate` and `thresholdList`. Both creates take an array. Creating either
 * publishes a template event that live-events' `sync-scorecard` template consumer writes to its
 * account cache.
 */
import type { ApiClient } from './client';
import { env } from '../env';
import type { Uuid } from '../types';

export interface ScorecardTemplate {
  id: Uuid;
  name: string;
  isActive: boolean;
}

export interface ScorecardThreshold {
  id: Uuid;
  templateId: Uuid;
  type: string;
}

export interface NewThreshold {
  templateId: Uuid;
  name: string;
  type: string;
  priority: 'low' | 'medium' | 'high';
  scoringType: 'deduction';
  points: number;
  maxPoints: number;
  /** `value` is the g-force to reach, `minimum` the speed (km/h) the event must be at. */
  variables: { value: number; minimum: number };
}

interface SearchResponse<T> {
  results?: T[];
}

export async function searchTemplates(api: ApiClient): Promise<ScorecardTemplate[]> {
  const response = await api.serviceCall<SearchResponse<ScorecardTemplate>>('post', env.scorecardsBaseUrl, '/v2/templates/search', {});
  return response.results ?? [];
}

export async function createTemplate(api: ApiClient, name: string, description: string): Promise<ScorecardTemplate> {
  const [created] = await api.serviceCall<ScorecardTemplate[]>('post', env.scorecardsBaseUrl, '/v2/templates', [
    { name, description, isActive: true },
  ]);
  if (!created) throw new Error(`createTemplate: POST /v2/templates returned no template for "${name}"`);
  return created;
}

export async function searchThresholds(api: ApiClient, templateId: Uuid): Promise<ScorecardThreshold[]> {
  const response = await api.serviceCall<SearchResponse<ScorecardThreshold>>('post', env.scorecardsBaseUrl, '/v2/thresholds/search', {
    limit: 100,
  });
  return (response.results ?? []).filter((t) => t.templateId === templateId);
}

export async function createThresholds(api: ApiClient, thresholds: readonly NewThreshold[]): Promise<void> {
  if (thresholds.length === 0) return;
  await api.serviceCall<unknown>('post', env.scorecardsBaseUrl, '/v2/thresholds', [...thresholds]);
}
