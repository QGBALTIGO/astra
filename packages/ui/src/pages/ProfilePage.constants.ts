/**
 * ProfilePage pure data + types.
 *
 * Extracted from ProfilePage.tsx — no React component logic: the quick-setup
 * shape, autonomy/communication/verbosity option tables, and language list.
 */

import { MessageSquare, Building, Sparkles } from '../components/icons';

export interface QuickSetupData {
  name: string;
  nickname: string;
  location: string;
  timezone: string;
  occupation: string;
  language: string;
  communicationStyle: 'formal' | 'casual' | 'mixed';
  verbosity: 'concise' | 'detailed' | 'mixed';
  autonomyLevel: 'none' | 'low' | 'medium' | 'high' | 'full';
}

export interface EditableSection {
  hobbies: string[];
  skills: string[];
  goals: { short: string[]; medium: string[]; long: string[] };
  favoriteFoods: string[];
  dietaryRestrictions: string[];
  allergies: string[];
}

export type TabId = 'home' | 'overview' | 'identity' | 'behavior' | 'memories' | 'advanced';

export const DEFAULT_QUICK_SETUP: QuickSetupData = {
  name: '',
  nickname: '',
  location: '',
  timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
  occupation: '',
  language: navigator.language.split('-')[0] || 'en',
  communicationStyle: 'casual',
  verbosity: 'detailed',
  autonomyLevel: 'medium',
};

export const AUTONOMY_DESCRIPTIONS: Record<string, string> = {
  none: 'AI always asks before taking any action',
  low: 'AI can read freely, asks for writes',
  medium: 'AI acts freely, asks for destructive actions',
  high: 'AI acts autonomously, rarely asks',
  full: 'Full autonomy - AI makes all decisions',
};

export const AUTONOMY_COLORS: Record<string, string> = {
  none: 'text-blue-500 bg-blue-500/10 border-blue-500/20',
  low: 'text-emerald-500 bg-emerald-500/10 border-emerald-500/20',
  medium: 'text-amber-500 bg-amber-500/10 border-amber-500/20',
  high: 'text-orange-500 bg-orange-500/10 border-orange-500/20',
  full: 'text-purple-500 bg-purple-500/10 border-purple-500/20',
};

export const COMMUNICATION_STYLES: {
  value: QuickSetupData['communicationStyle'];
  label: string;
  icon: typeof MessageSquare;
  desc: string;
}[] = [
  { value: 'formal', label: 'Formal', icon: Building, desc: 'Professional and polite' },
  { value: 'casual', label: 'Casual', icon: MessageSquare, desc: 'Friendly and relaxed' },
  { value: 'mixed', label: 'Mixed', icon: Sparkles, desc: 'Adapts to context' },
];

export const VERBOSITY_OPTIONS: {
  value: QuickSetupData['verbosity'];
  label: string;
  desc: string;
}[] = [
  { value: 'concise', label: 'Concise', desc: 'Brief, to-the-point responses' },
  { value: 'detailed', label: 'Detailed', desc: 'Comprehensive explanations' },
  { value: 'mixed', label: 'Adaptive', desc: 'Adjusts based on context' },
];

export const LANGUAGES = [
  { code: 'en', name: 'English', flag: '🇺🇸' },
  { code: 'tr', name: 'Turkish', flag: '🇹🇷' },
  { code: 'de', name: 'German', flag: '🇩🇪' },
  { code: 'fr', name: 'French', flag: '🇫🇷' },
  { code: 'es', name: 'Spanish', flag: '🇪🇸' },
  { code: 'it', name: 'Italian', flag: '🇮🇹' },
  { code: 'pt', name: 'Portuguese', flag: '🇵🇹' },
  { code: 'ru', name: 'Russian', flag: '🇷🇺' },
  { code: 'zh', name: 'Chinese', flag: '🇨🇳' },
  { code: 'ja', name: 'Japanese', flag: '🇯🇵' },
  { code: 'ko', name: 'Korean', flag: '🇰🇷' },
  { code: 'ar', name: 'Arabic', flag: '🇸🇦' },
  { code: 'nl', name: 'Dutch', flag: '🇳🇱' },
  { code: 'pl', name: 'Polish', flag: '🇵🇱' },
  { code: 'sv', name: 'Swedish', flag: '🇸🇪' },
];
