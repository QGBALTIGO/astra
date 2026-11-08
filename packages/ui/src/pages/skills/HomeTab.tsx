import { useNavigate, useSearchParams } from 'react-router';
import {
  BookOpen,
  Sparkles,
  Download,
  Puzzle,
  Globe,
  Code,
  Zap,
  CheckCircle2,
  Search,
  Plus,
  Terminal,
  Brain,
  Wrench,
} from '../../components/icons';

// =============================================================================
// Data
// =============================================================================

interface Feature {
  icon: React.ComponentType<{ className?: string }>;
  color: string;
  title: string;
  description: string;
}

const FEATURES: Feature[] = [
  {
    icon: BookOpen,
    color: 'text-primary bg-primary/10',
    title: 'Padrão SKILL.md',
    description:
      'As habilidades seguem o padrão aberto AgentSkills.io, em arquivos Markdown que outros assistentes também compreendem.',
  },
  {
    icon: Puzzle,
    color: 'text-violet-500 bg-violet-500/10',
    title: 'Pronto para usar',
    description:
      'Instale uma habilidade e ela ficará disponível para sua IA sem reiniciar ou alterar o código.',
  },
  {
    icon: Globe,
    color: 'text-emerald-500 bg-emerald-500/10',
    title: 'Biblioteca npm',
    description:
      'Encontre habilidades da comunidade no npm por palavra-chave, autor ou categoria.',
  },
  {
    icon: Wrench,
    color: 'text-orange-500 bg-orange-500/10',
    title: 'Ferramentas integradas',
    description:
      'As habilidades podem adicionar ferramentas, integrações e transformações de dados ao assistente.',
  },
];

interface QuickAction {
  tab: 'installed' | 'discover' | 'create';
  icon: React.ComponentType<{ className?: string }>;
  label: string;
  description: string;
  color: string;
}

const QUICK_ACTIONS: QuickAction[] = [
  {
    tab: 'installed',
    icon: Terminal,
    label: 'Ver instaladas',
    description: 'Gerencie, ative ou remova suas habilidades',
    color: 'border-primary/30 hover:border-primary/60',
  },
  {
    tab: 'discover',
    icon: Search,
    label: 'Explorar biblioteca',
    description: 'Pesquise habilidades disponíveis no npm',
    color: 'border-emerald-500/30 hover:border-emerald-500/60',
  },
  {
    tab: 'create',
    icon: Plus,
    label: 'Criar habilidade',
    description: 'Crie uma habilidade com o assistente passo a passo',
    color: 'border-violet-500/30 hover:border-violet-500/60',
  },
];

interface Step {
  n: number;
  title: string;
  detail: string;
}

const STEPS: Step[] = [
  {
    n: 1,
    title: 'Encontre ou crie uma habilidade',
    detail:
      'Explore a biblioteca de habilidades ou crie a sua usando o assistente. O formato é um arquivo SKILL.md.',
  },
  {
    n: 2,
    title: 'Instale com poucos cliques',
    detail:
      'Instale um pacote encontrado, envie um arquivo .skill ou informe o endereço de um SKILL.md.',
  },
  {
    n: 3,
    title: 'Sua IA aprende novas habilidades',
    detail:
      "As habilidades instaladas são disponibilizadas ao assistente automaticamente.",
  },
  {
    n: 4,
    title: 'Teste, avalie e melhore',
    detail:
      'Avalie a qualidade das habilidades e melhore suas descrições para obter resultados mais precisos.',
  },
];

const SKILL_EXAMPLES = [
  { emoji: '📧', name: 'Escrever e-mails', desc: 'Crie e-mails profissionais no seu estilo' },
  { emoji: '📊', name: 'Análise de dados', desc: 'Analise CSVs, gráficos e tendências' },
  { emoji: '🔍', name: 'Pesquisa na web', desc: 'Pesquise, resuma e cite fontes' },
  { emoji: '📝', name: 'Notas de reunião', desc: 'Resuma reuniões e organize tarefas' },
  { emoji: '🛠️', name: 'DevOps', desc: 'Monitore sistemas, logs e publicações' },
  { emoji: '🌐', name: 'Tradução', desc: 'Traduza textos em mais de 50 idiomas' },
];

// =============================================================================
// Component
// =============================================================================

export function HomeTab() {
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();

  const goToTab = (tab: string) => {
    const params = new URLSearchParams(searchParams);
    params.set('tab', tab);
    navigate({ search: params.toString() }, { replace: true });
  };

  return (
    <div className="max-w-4xl mx-auto px-4 py-6 space-y-10 overflow-y-auto h-full">
      {/* Hero */}
      <div className="text-center space-y-3">
        <div className="flex justify-center gap-3 mb-4">
          <span className="w-12 h-12 rounded-2xl bg-primary/10 flex items-center justify-center">
            <Sparkles className="w-6 h-6 text-primary" />
          </span>
          <span className="w-12 h-12 rounded-2xl bg-violet-500/10 flex items-center justify-center">
            <Brain className="w-6 h-6 text-violet-500" />
          </span>
          <span className="w-12 h-12 rounded-2xl bg-emerald-500/10 flex items-center justify-center">
            <Code className="w-6 h-6 text-emerald-500" />
          </span>
        </div>
        <h1 className="text-2xl font-bold text-text-primary dark:text-dark-text-primary">
          Ensine novas habilidades à sua IA
        </h1>
        <p className="text-text-secondary dark:text-dark-text-secondary max-w-xl mx-auto leading-relaxed">
          Habilidades ampliam o que seu assistente pode fazer, de e-mails à análise de dados.
          Instale pacotes prontos ou crie os seus.
        </p>
        <button
          onClick={() => goToTab('discover')}
          className="inline-flex items-center gap-2 px-5 py-2.5 bg-primary text-white rounded-xl font-medium hover:bg-primary/90 transition-colors mt-2"
        >
          <Download className="w-4 h-4" />
          Explorar habilidades
        </button>
      </div>

      {/* Features grid */}
      <div className="space-y-3">
        <h2 className="text-sm font-semibold text-text-primary dark:text-dark-text-primary uppercase tracking-wide flex items-center gap-2">
          <Zap className="w-4 h-4 text-primary" />
          O que são habilidades?
        </h2>
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
          {FEATURES.map((f) => (
            <div
              key={f.title}
              className="border border-border dark:border-dark-border rounded-xl p-4 space-y-1.5"
            >
              <div className="flex items-center gap-2">
                <span className={`w-8 h-8 rounded-lg flex items-center justify-center ${f.color}`}>
                  <f.icon className="w-4 h-4" />
                </span>
                <span className="text-sm font-medium text-text-primary dark:text-dark-text-primary">
                  {f.title}
                </span>
              </div>
              <p className="text-xs text-text-secondary dark:text-dark-text-secondary leading-relaxed">
                {f.description}
              </p>
            </div>
          ))}
        </div>
      </div>

      {/* Skill examples */}
      <div className="space-y-3">
        <h2 className="text-sm font-semibold text-text-primary dark:text-dark-text-primary uppercase tracking-wide flex items-center gap-2">
          <Sparkles className="w-4 h-4 text-primary" />
          Ideias de habilidades
        </h2>
        <div className="grid grid-cols-2 sm:grid-cols-3 gap-2">
          {SKILL_EXAMPLES.map((ex) => (
            <div
              key={ex.name}
              className="flex items-center gap-2.5 border border-border dark:border-dark-border rounded-lg px-3 py-2.5"
            >
              <span className="text-lg">{ex.emoji}</span>
              <div className="min-w-0">
                <p className="text-xs font-medium text-text-primary dark:text-dark-text-primary truncate">
                  {ex.name}
                </p>
                <p className="text-[10px] text-text-muted dark:text-dark-text-muted truncate">
                  {ex.desc}
                </p>
              </div>
            </div>
          ))}
        </div>
      </div>

      {/* Getting started steps */}
      <div className="space-y-3">
        <h2 className="text-sm font-semibold text-text-primary dark:text-dark-text-primary uppercase tracking-wide flex items-center gap-2">
          <CheckCircle2 className="w-4 h-4 text-primary" />
          Primeiros passos
        </h2>
        <div className="space-y-3">
          {STEPS.map((step) => (
            <div key={step.n} className="flex gap-4">
              <div className="flex-shrink-0 w-7 h-7 rounded-full bg-primary/10 text-primary text-xs font-bold flex items-center justify-center mt-0.5">
                {step.n}
              </div>
              <div>
                <p className="text-sm font-medium text-text-primary dark:text-dark-text-primary">
                  {step.title}
                </p>
                <p className="text-xs text-text-secondary dark:text-dark-text-secondary mt-0.5 leading-relaxed">
                  {step.detail}
                </p>
              </div>
            </div>
          ))}
        </div>
      </div>

      {/* Quick actions */}
      <div className="space-y-3">
        <h2 className="text-sm font-semibold text-text-primary dark:text-dark-text-primary uppercase tracking-wide flex items-center gap-2">
          <Zap className="w-4 h-4 text-primary" />
          Acesso rápido
        </h2>
        <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
          {QUICK_ACTIONS.map((qa) => (
            <button
              key={qa.tab}
              onClick={() => goToTab(qa.tab)}
              className={`border-2 ${qa.color} rounded-xl p-4 text-left transition-colors group`}
            >
              <qa.icon className="w-5 h-5 text-text-secondary dark:text-dark-text-secondary mb-2 group-hover:text-primary transition-colors" />
              <p className="text-sm font-medium text-text-primary dark:text-dark-text-primary">
                {qa.label}
              </p>
              <p className="text-xs text-text-muted dark:text-dark-text-muted mt-0.5">
                {qa.description}
              </p>
            </button>
          ))}
        </div>
      </div>

      {/* Format info box */}
      <div className="border border-blue-200 dark:border-blue-500/30 bg-blue-50 dark:bg-blue-500/10 rounded-xl p-4 space-y-2">
        <p className="text-sm font-semibold text-blue-700 dark:text-blue-400 flex items-center gap-2">
          <BookOpen className="w-4 h-4" />
          Sobre o formato SKILL.md
        </p>
        <p className="text-xs text-blue-700 dark:text-blue-300 leading-relaxed">
          As habilidades seguem o padrão aberto <span className="font-semibold">AgentSkills.io</span>,
          com metadados em YAML e instruções em Markdown. O Astra também aceita o formato nativo
          com ferramentas e seções adicionais. Ambos são compatíveis.
        </p>
      </div>

      {/* CTA footer */}
      <div className="text-center pb-4">
        <button
          onClick={() => goToTab('create')}
          className="inline-flex items-center gap-2 px-6 py-3 bg-primary text-white rounded-xl font-medium hover:bg-primary/90 transition-colors shadow-sm"
        >
          <Plus className="w-4 h-4" />
          Crie sua primeira habilidade
        </button>
        <p className="text-xs text-text-muted dark:text-dark-text-muted mt-2">
          O assistente ajuda a escrever, testar e preparar sua habilidade.
        </p>
      </div>
    </div>
  );
}
