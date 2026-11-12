/**
 * Crew Templates — Registry and Lookup
 */

export type { CrewTemplate, AgentSoulTemplate } from './types.js';

import type { CrewTemplate } from './types.js';
import { contentCrewTemplate } from './content-crew.js';
import { devopsCrewTemplate } from './devops-crew.js';
import { researchCrewTemplate } from './research-crew.js';
import { personalOpsCrewTemplate } from './personal-ops-crew.js';
import { financeCrewTemplate } from './finance-crew.js';
import { supportCrewTemplate } from './support-crew.js';
import { dataCrewTemplate } from './data-crew.js';

const CREW_TEMPLATES: ReadonlyMap<string, CrewTemplate> = new Map([
  [contentCrewTemplate.id, contentCrewTemplate],
  [devopsCrewTemplate.id, devopsCrewTemplate],
  [researchCrewTemplate.id, researchCrewTemplate],
  [personalOpsCrewTemplate.id, personalOpsCrewTemplate],
  [financeCrewTemplate.id, financeCrewTemplate],
  [supportCrewTemplate.id, supportCrewTemplate],
  [dataCrewTemplate.id, dataCrewTemplate],
]);

/** Get a crew template by ID. Returns null if not found. */
export function getCrewTemplate(templateId: string): CrewTemplate | null {
  return CREW_TEMPLATES.get(templateId) ?? null;
}

/** List all available crew templates. */
export function listCrewTemplates(): CrewTemplate[] {
  return [...CREW_TEMPLATES.values()];
}
