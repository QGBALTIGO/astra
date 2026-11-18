export type RadarSourceId =
  | 'weather'
  | 'ptax'
  | 'currency'
  | 'football'
  | 'news'
  | 'series'
  | 'gazettes'
  | 'energy'
  | 'releases';
export interface RadarChoice {
  id: string;
  label: string;
  description?: string;
}
export interface RadarPreferences {
  enabled: boolean;
  time: string;
  quietStart: string;
  quietEnd: string;
}
export interface RadarInput {
  source: RadarSourceId;
  target: string;
  query?: string;
  delivery: 'digest' | 'before' | 'threshold' | 'matchday';
  notifyTime?: string;
  threshold?: string;
  comparison?: 'above' | 'below' | 'at_or_above' | 'at_or_below';
  leadMinutes: number;
}
export interface RadarInterest extends RadarInput {
  id: string;
  label: string;
  active: boolean;
  revision: number;
  createdAt: string;
  errorCode: string | null;
  snapshot: {
    items: Array<{
      id: string;
      title: string;
      text?: string;
      url?: string;
      at?: string;
      date?: string;
      status?: 'scheduled' | 'finished';
      value?: string;
    }>;
    observedAt: string;
    sourceUpdatedAt?: string;
    expiresAt: string;
    sourceLabel: string;
    sourceUrl: string;
    notice?: string;
  } | null;
}
export interface RadarCatalogItem {
  id: RadarSourceId;
  name: string;
  description: string;
  provider: string;
  url: string;
  license: string;
  hint: string;
  needsSearch: boolean;
  available: boolean;
  disabledReason?: string;
}
export interface CustomerRadarData {
  chatUrl?: string | null;
  catalog: RadarCatalogItem[];
  preferences: RadarPreferences;
  interests: RadarInterest[];
  timeZone: string;
  history: Array<{
    id: string;
    label: string | null;
    status: string;
    created_at: string;
    sent_at: string | null;
  }>;
}
