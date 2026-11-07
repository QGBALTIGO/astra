/**
 * Layout configuration types.
 *
 * Controls visual presentation of header zones, sidebar, and general layout.
 * Persisted in localStorage via useLayoutConfig hook.
 * Version field enables forward-compatible migrations.
 *
 * Header has 5 zones:
 *   [Brand] | [Zone Left] [Zone Center] [Zone Right] | [Settings icon]
 * Brand and Settings are fixed. The 3 middle zones are user-configurable.
 *
 * Sidebar sections use an add/remove pattern:
 *   - Built-in sections: 'search', 'customize', 'workspaces', etc.
 *   - Nav item sections: route paths like '/', '/dashboard', '/analytics'
 *   - If in config array → shown. If not → hidden.
 */

export const LAYOUT_CONFIG_VERSION = 11;

/** How pinned header items render */
export type HeaderItemDisplayMode = 'icon' | 'icon-text' | 'text';

/** Identifies one of the 3 configurable header zones */
export type HeaderZoneId = 'left' | 'center' | 'right';

/** A single entry in a header zone — references useHeaderItems config by index or directly */
export type HeaderZoneEntry =
  | { type: 'item'; path: string }
  | { type: 'group'; id: string; label: string; items: string[] }
  | { type: 'widget'; widgetId: string }; // Future: pulse-slots, pomodoro, ws-status

export interface HeaderZoneConfig {
  entries: HeaderZoneEntry[];
  displayMode: HeaderItemDisplayMode;
}

export interface LayoutConfigHeader {
  /** Global fallback display mode (used when zone doesn't override) */
  itemDisplayMode: HeaderItemDisplayMode;
  /** Per-zone configuration */
  zones: Record<HeaderZoneId, HeaderZoneConfig>;
}

/** Sidebar width preset — affects the aside element width class */
export type SidebarWidth = 'narrow' | 'default' | 'wide';

/** Legacy type — kept for migration compatibility */
export type SidebarPinnedConfig =
  { type: 'item'; path: string } | { type: 'group'; id: string; label: string; items: string[] };

export const MAX_PINNED_ITEMS = 15;

/** Built-in sidebar section identifiers (footer is structural, not configurable) */
type SidebarSectionId =
  // Core (always-visible UI controls)
  | 'search'
  | 'scheduled'
  | 'customize'
  // Data (API-backed list sections with accordion/flat toggle)
  | 'workspaces'
  | 'workflows'
  | 'recents'
  // AI & Automation
  | 'agents'
  | 'claws'
  | 'agentic-executions'
  | 'triggers'
  | 'artifacts'
  // Tools & Extensions
  | 'tools'
  | 'custom-tools'
  | 'extensions'
  // Personal Data
  | 'tasks'
  | 'notes'
  | 'goals'
  | 'plans'
  | 'memories'
  | 'bookmarks'
  | 'contacts'
  | 'habits'
  // System
  | 'channels'
  | 'edge-devices'
  | 'mcp-servers'
  | 'ai-models'
  | 'coding-agents';

/**
 * ID for a sidebar section — built-in IDs are typed as SidebarSectionId,
 * nav item paths (e.g. '/', '/dashboard') are also valid section IDs.
 * Kept as string (not branded) because JSON serialization loses brand info.
 */
export type SidebarSectionIdOrCustom = SidebarSectionId | (string & {});

/** How a data section header renders in the sidebar */
export type SidebarSectionStyle = 'accordion' | 'flat';

export interface SidebarSectionConfig {
  id: SidebarSectionIdOrCustom;
  order: number;
  /** Display style — 'accordion' shows items with collapse, 'flat' shows as single nav link */
  style?: SidebarSectionStyle;
}

/** Core sections that cannot be removed from sidebar (structural UI controls) */
export const CORE_SECTION_IDS = new Set<string>(['search', 'customize']);

/** Default styles for sections when added via "+ Add Section" */
export const SECTION_DEFAULT_STYLES: Record<string, SidebarSectionStyle> = {
  workspaces: 'accordion',
  workflows: 'accordion',
  recents: 'accordion',
  agents: 'accordion',
  claws: 'accordion',
  tools: 'accordion',
};

/** Default sidebar sections — prioritize what people use daily. Advanced tools remain accessible via customization. */
export const DEFAULT_SIDEBAR_SECTIONS: SidebarSectionConfig[] = [
  { id: '/', order: 0 },
  { id: '/dashboard', order: 1 },
  { id: 'scheduled', order: 2 },
  { id: '/tasks', order: 3 },
  { id: '/expenses', order: 4 },
  { id: '/channels', order: 5 },
  { id: '/memories', order: 6 },
  { id: '/triggers', order: 7 },
  { id: 'search', order: 8 },
  { id: 'recents', order: 9, style: 'flat' },
  { id: 'customize', order: 10 },
];

/** Human-readable labels for built-in sidebar sections */
export const SIDEBAR_SECTION_LABELS: Record<string, string> = {
  // Core
  search: 'Buscar',
  scheduled: 'Agenda',
  customize: 'Personalizar',
  // Data
  workspaces: 'Ambientes',
  workflows: 'Automações',
  recents: 'Conversas recentes',
  // AI & Automation
  agents: 'Agents',
  claws: 'Claws',
  'agentic-executions': 'Tarefas automatizadas',
  triggers: 'Lembretes',
  artifacts: 'Arquivos gerados',
  // Tools & Extensions
  tools: 'Ferramentas',
  'custom-tools': 'Ferramentas personalizadas',
  extensions: 'Habilidades e extensões',
  // Personal Data
  tasks: 'Tarefas',
  notes: 'Anotações',
  goals: 'Objetivos',
  plans: 'Planos',
  memories: 'Memória',
  bookmarks: 'Favoritos',
  contacts: 'Contatos',
  habits: 'Hábitos',
  // System
  channels: 'WhatsApp e canais',
  'edge-devices': 'Dispositivos',
  'mcp-servers': 'Servidores MCP',
  'ai-models': 'Modelos de IA',
  'coding-agents': 'Agentes de código',
};

/** Sidebar width presets — narrow is still text-visible, not icon-only */
export const SIDEBAR_WIDTH_VALUES: Record<
  SidebarWidth,
  { class: string; label: string; px: number }
> = {
  narrow: { class: 'w-48', label: 'Compacta', px: 192 },
  default: { class: 'w-60', label: 'Padrão', px: 240 },
  wide: { class: 'w-72', label: 'Ampla', px: 288 },
};

export interface LayoutConfigSidebar {
  width: SidebarWidth;
  sections: SidebarSectionConfig[];
}

/** User-defined custom group — global, reusable across zones and sidebar */
export interface CustomGroup {
  id: string; // custom-{timestamp}
  label: string; // user-defined name
  items: string[]; // route paths
}

export interface LayoutConfig {
  version: number;
  header: LayoutConfigHeader;
  sidebar: LayoutConfigSidebar;
  /** Global custom groups — can be added to any header zone or sidebar */
  customGroups: CustomGroup[];
}

const EMPTY_ZONE: HeaderZoneConfig = { entries: [], displayMode: 'icon' };

export const DEFAULT_LAYOUT_CONFIG: LayoutConfig = {
  version: LAYOUT_CONFIG_VERSION,
  header: {
    itemDisplayMode: 'icon',
    zones: {
      left: { ...EMPTY_ZONE },
      center: { ...EMPTY_ZONE },
      right: { ...EMPTY_ZONE },
    },
  },
  sidebar: {
    width: 'default',
    sections: [...DEFAULT_SIDEBAR_SECTIONS],
  },
  customGroups: [],
};
