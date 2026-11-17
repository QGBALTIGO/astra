export type MarketQuote = {
  symbol: string;
  price: string;
  change: string | null;
  changePercent: string | null;
  marketTimestamp: string;
  fetchedAt: string;
  currency: 'BRL';
  source: 'BRAPI';
  sourceUrl: string;
  provenance: 'public-evaluation' | 'authenticated-proxy';
  logoUrl?: string | null;
};
export type MarketHistoryPoint = {
  date: string;
  price: string | null;
  source: 'BRAPI';
  fetchedAt: string;
  barTimestamp: string;
  raw: true;
};
export type MarketHistory = {
  symbol: string;
  points: MarketHistoryPoint[];
  fetchedAt: string;
  fromCache: boolean;
  error?: string;
};
