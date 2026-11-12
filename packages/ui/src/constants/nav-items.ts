/**
 * Shared navigation item constants.
 * Imported by Sidebar (Phase 2) and CustomizePage (Phase 3).
 * Source of truth for all nav items — do NOT duplicate in Layout.tsx.
 */
import type React from 'react';
import {
  MessageSquare,
  History,
  Bot,
  Wrench,
  Cpu,
  DollarSign,
  Settings,
  UserCircle,
  LayoutDashboard,
  CheckCircle2,
  FileText,
  Calendar,
  Users,
  Bookmark,
  Database,
  Brain,
  Target,
  Zap,
  ListChecks,
  Shield,
  Puzzle,
  HardDrive,
  Activity,
  Code,
  Receipt,
  Repeat,
  Clock,
  Key,
  Globe,
  Server,
  Container,
  Info,
  Sparkles,
  BookOpen,
  GitBranch,
  Link,
  Terminal,
  ShieldCheck,
  Send,
  LayoutTemplate,
  Lock,
  Wifi,
} from '../components/icons';

export interface NavItem {
  to: string;
  icon: React.ComponentType<{ className?: string }>;
  label: string;
}

export interface NavGroup {
  id: string;
  label: string;
  icon: React.ComponentType<{ className?: string }>;
  items: NavItem[];
  defaultOpen?: boolean;
  /** Optional badge text (e.g. "Beta") shown next to group label */
  badge?: string;
}

// Main navigation items (always visible)
export const mainItems: NavItem[] = [
  { to: '/', icon: MessageSquare, label: 'Conversar' },
  { to: '/dashboard', icon: LayoutDashboard, label: 'Visão geral' },
  { to: '/analytics', icon: Activity, label: 'Análises' },
  { to: '/channels', icon: Send, label: 'WhatsApp e canais' },
  { to: '/history', icon: History, label: 'Conversas' },
];

// Grouped navigation
export const navGroups: NavGroup[] = [
  {
    id: 'data',
    label: 'Meu dia a dia',
    icon: Database,
    items: [
      { to: '/tasks', icon: CheckCircle2, label: 'Tarefas' },
      { to: '/notes', icon: FileText, label: 'Anotações' },
      { to: '/calendar', icon: Calendar, label: 'Agenda' },
      { to: '/contacts', icon: Users, label: 'Contatos' },
      { to: '/bookmarks', icon: Bookmark, label: 'Favoritos' },
      { to: '/expenses', icon: Receipt, label: 'Finanças' },
      { to: '/habits', icon: Repeat, label: 'Hábitos' },
      { to: '/pomodoro', icon: Clock, label: 'Foco' },
    ],
  },
  {
    id: 'ai',
    label: 'IA e automações',
    icon: Brain,
    items: [
      { to: '/memories', icon: Brain, label: 'Memória' },
      { to: '/goals', icon: Target, label: 'Objetivos' },
      { to: '/plans', icon: ListChecks, label: 'Planos' },
      { to: '/triggers', icon: Zap, label: 'Lembretes' },
      { to: '/workflows', icon: GitBranch, label: 'Automações' },
      { to: '/agentic', icon: Brain, label: 'Central de IA' },
      { to: '/autonomous', icon: Bot, label: 'Equipes de agentes' },
      { to: '/mission-control', icon: Activity, label: 'Monitoramento' },
      { to: '/claws', icon: Zap, label: 'Agentes autônomos' },
      { to: '/coding-agents', icon: Terminal, label: 'Execução de código' },
      { to: '/artifacts', icon: LayoutTemplate, label: 'Arquivos gerados' },
      { to: '/canvas', icon: LayoutTemplate, label: 'Área visual' },
      { to: '/approvals', icon: ShieldCheck, label: 'Aprovações' },
      { to: '/autonomy', icon: Shield, label: 'Autonomia' },
    ],
  },
  {
    id: 'tools',
    label: 'Ferramentas e extensões',
    icon: Wrench,
    items: [
      { to: '/tools', icon: Wrench, label: 'Ferramentas' },
      { to: '/custom-tools', icon: Code, label: 'Ferramentas personalizadas' },
      { to: '/skills', icon: BookOpen, label: 'Habilidades' },
      { to: '/plugins', icon: Puzzle, label: 'Integrações' },
    ],
  },
  {
    id: 'system',
    label: 'Sistema',
    icon: Cpu,
    items: [
      { to: '/agents', icon: Bot, label: 'Perfis de agente' },
      { to: '/wizards', icon: Sparkles, label: 'Assistentes guiados' },
      { to: '/workspaces', icon: HardDrive, label: 'Ambientes' },
      { to: '/custom-data', icon: Database, label: 'Dados personalizados' },
      { to: '/costs', icon: DollarSign, label: 'Custos' },
      { to: '/logs', icon: Activity, label: 'Registros' },
      { to: '/agent-observability', icon: Activity, label: 'Execução em tempo real' },
      { to: '/edge-devices', icon: Wifi, label: 'Dispositivos' },
      { to: '/tunnel', icon: Wifi, label: 'Túnel' },
    ],
  },
  {
    id: 'settings',
    label: 'Configurações',
    icon: Settings,
    items: [
      // Setup essentials
      { to: '/settings/api-keys', icon: Key, label: 'Chaves de API' },
      { to: '/settings/providers', icon: Server, label: 'Provedores de IA' },
      { to: '/settings/ai-models', icon: Cpu, label: 'Modelos de IA' },
      { to: '/settings/model-routing', icon: Sparkles, label: 'Roteamento de IA' },
      // Security & access
      { to: '/settings/security', icon: Lock, label: 'Acesso e senha' },
      { to: '/settings/security-scanner', icon: Shield, label: 'Verificação de segurança' },
      { to: '/settings/tool-groups', icon: Wrench, label: 'Grupos de ferramentas' },
      // Tools & integrations
      { to: '/settings/cli-tools', icon: Code, label: 'Ferramentas CLI' },
      { to: '/settings/coding-agents', icon: Terminal, label: 'Agentes de código' },
      { to: '/settings/mcp-servers', icon: Zap, label: 'Servidores MCP' },
      { to: '/settings/connected-apps', icon: Link, label: 'Aplicativos conectados' },
      { to: '/settings/workflow-tools', icon: GitBranch, label: 'Ferramentas de automação' },
      // System
      { to: '/settings/config-center', icon: Globe, label: 'Central de configurações' },
      { to: '/settings/layout', icon: LayoutDashboard, label: 'Aparência' },
      { to: '/settings/system', icon: Container, label: 'Sistema' },
    ],
  },
];

// Bottom navigation items
export const bottomItems: NavItem[] = [
  { to: '/about', icon: Info, label: 'Sobre' },
  { to: '/profile', icon: UserCircle, label: 'Meu perfil' },
];

/** Flat array of every nav item for use in CustomizePage grid. */
export const ALL_NAV_ITEMS: NavItem[] = [
  ...mainItems,
  ...navGroups.flatMap((g) => g.items),
  ...bottomItems,
];

/** Lookup map: route path → NavItem (shared by Sidebar, HeaderItemsBar, etc.) */
export const NAV_ITEM_MAP = new Map<string, NavItem>(ALL_NAV_ITEMS.map((item) => [item.to, item]));
