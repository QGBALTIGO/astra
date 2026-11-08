/**
 * Traduções somente de apresentação. IDs de executores, capacidades e tags
 * permanecem inalterados para garantir compatibilidade com a API.
 */
export const EXECUTOR_KIND_LABELS: Record<string, string> = {
  claw: 'Agente autônomo',
  soul_heartbeat: 'Rotinas do assistente',
  crew: 'Equipe de agentes',
  coding_agent: 'Agente de programação',
  workflow: 'Fluxo de automação',
  trigger: 'Gatilho',
  channel: 'Canal de comunicação',
  direct_llm: 'Conversa com IA',
  sandbox_code: 'Código isolado',
  tool_catalog: 'Ferramentas',
};

export const AGENTIC_STATUS_LABELS: Record<string, string> = {
  pending: 'Pendente',
  running: 'Em execução',
  completed: 'Concluída',
  failed: 'Falhou',
  cancelled: 'Cancelada',
  partially_completed: 'Parcialmente concluída',
  escalated: 'Precisa de aprovação',
  skipped: 'Ignorada',
  timed_out: 'Tempo esgotado',
};

export const CAPABILITY_PT_BR: Record<string, { name: string; description: string }> = {
  'claw:continuous-autonomy': {
    name: 'Execução autônoma contínua',
    description:
      'Mantém um agente autônomo em ciclos com intervalos adaptativos, histórico persistente, plano de tarefas e acesso às ferramentas disponíveis. Permite intervenção pelo painel de mensagens.',
  },
  'claw:single-shot': {
    name: 'Execução de tarefa única',
    description:
      'Executa uma tarefa usando o agente autônomo, com raciocínio por IA, ferramentas, ambiente de trabalho e suporte a programação. Encerra ao concluir.',
  },
  'claw:interval-autonomy': {
    name: 'Execução periódica por intervalo',
    description:
      'Executa um agente autônomo em intervalos definidos, para monitoramento, verificações, geração de conteúdo e processamento recorrente.',
  },
  'claw:event-driven': {
    name: 'Agente acionado por eventos',
    description:
      'Executa um agente quando ocorre um evento do sistema, webhook ou mensagem. Fica inativo entre eventos.',
  },
  'soul:heartbeat': {
    name: 'Rotinas automáticas do assistente',
    description:
      'Executa tarefas recorrentes com agenda definida, lista de atividades, horários silenciosos, recuperação automática e acompanhamento de recursos.',
  },
  'soul:crew-leader': {
    name: 'Coordenação de agentes',
    description:
      'Coordena vários agentes, distribui tarefas, reúne resultados e acompanha o andamento, com diferentes formas de colaboração.',
  },
  'coding-agent:claude-code': {
    name: 'Integração com Claude Code',
    description:
      'Usa o Claude Code no ambiente de desenvolvimento para analisar, modificar, testar e gerar código, com acesso aos arquivos autorizados.',
  },
  'coding-agent:codex': {
    name: 'Integração com Codex',
    description:
      'Executa tarefas de programação, depuração e engenharia de software com o Codex em ambiente de trabalho isolado.',
  },
  'workflow:dag': {
    name: 'Fluxo visual de automações',
    description:
      'Executa fluxos visuais com etapas de IA, código, ferramentas, condições, processamento paralelo e transformação de dados.',
  },
  'trigger:schedule': {
    name: 'Gatilhos programados',
    description:
      'Executa automaticamente ações em horários definidos: conversas, ferramentas, avisos, metas, resumos e fluxos.',
  },
  'trigger:event': {
    name: 'Gatilhos por eventos',
    description:
      'Executa ações quando determinados eventos do sistema acontecem, com filtros por tipo e conteúdo.',
  },
  'trigger:condition': {
    name: 'Gatilhos por condição',
    description:
      'Verifica condições periodicamente e executa ações quando elas são atendidas, como limites e indicadores.',
  },
  'trigger:webhook': {
    name: 'Recebimento de webhooks',
    description:
      'Recebe chamadas externas com verificação opcional de segredo e filtragem de origens para acionar automações.',
  },
  'channel:telegram': {
    name: 'Mensagens pelo Telegram',
    description:
      'Envia e recebe mensagens pelo Telegram, incluindo arquivos, documentos, imagens e respostas formatadas.',
  },
  'channel:discord': {
    name: 'Mensagens pelo Discord',
    description:
      'Permite conversas no Discord, com comandos, tópicos, arquivos, mensagens incorporadas e permissões.',
  },
  'channel:slack': {
    name: 'Mensagens pelo Slack',
    description:
      'Permite conversas no Slack, com comandos, respostas em tópicos, blocos de mensagem e arquivos.',
  },
  'channel:email': {
    name: 'Comunicação por e-mail',
    description:
      'Envia e recebe e-mails via IMAP/SMTP, processa anexos e organiza respostas por conversa.',
  },
  'channel:whatsapp': {
    name: 'Mensagens pelo WhatsApp',
    description:
      'Envia e recebe mensagens pelo WhatsApp, com suporte a texto, imagens, documentos e interações.',
  },
  'channel:webchat': {
    name: 'Chat para sites',
    description:
      'Disponibiliza um chat personalizável em sites, com conversas em tempo real para visitantes.',
  },
  'direct-llm:chat': {
    name: 'Conversa direta com IA',
    description:
      'Responde perguntas, analisa informações, cria conteúdo e realiza tarefas simples sem executar ferramentas externas.',
  },
  'sandbox:javascript': {
    name: 'Execução isolada de JavaScript',
    description:
      'Executa JavaScript em ambiente isolado com permissões controladas, sem acesso automático à rede ou arquivos.',
  },
  'sandbox:python': {
    name: 'Execução isolada de Python',
    description:
      'Executa Python em ambiente isolado, com suporte a bibliotecas e processamento de dados. Pode utilizar Docker.',
  },
  'tools:all': {
    name: 'Catálogo completo de ferramentas',
    description:
      'Reúne as ferramentas disponíveis para arquivos, web, Git, memória, tarefas, dados, execução de código, áudio, imagens, PDF e outras funções.',
  },
};

export const CAPABILITY_TAG_PT_BR: Record<string, string> = {
  autonomous: 'autônomo',
  continuous: 'contínuo',
  background: 'segundo plano',
  persistent: 'persistente',
  agent: 'agente',
  'single-shot': 'tarefa única',
  task: 'tarefa',
  research: 'pesquisa',
  code: 'código',
  interval: 'intervalo',
  periodic: 'periódico',
  monitoring: 'monitoramento',
  scheduled: 'programado',
  'event-driven': 'por evento',
  reactive: 'reativo',
  webhook: 'webhook',
  listener: 'escuta',
  soul: 'identidade',
  heartbeat: 'rotina',
  identity: 'identidade',
  automation: 'automação',
  cron: 'agenda cron',
  crew: 'equipe',
  coordination: 'coordenação',
  'multi-agent': 'vários agentes',
  delegation: 'delegação',
  leadership: 'liderança',
  claude: 'Claude',
  cli: 'terminal',
  refactoring: 'refatoração',
  analysis: 'análise',
  codex: 'Codex',
  openai: 'OpenAI',
  generation: 'geração',
  workflow: 'fluxo',
  dag: 'fluxo visual',
  pipeline: 'etapas',
  visual: 'visual',
  trigger: 'gatilho',
  schedule: 'agenda',
  event: 'evento',
  condition: 'condição',
  threshold: 'limiar',
  external: 'externo',
  integration: 'integração',
  channel: 'canal',
  telegram: 'Telegram',
  discord: 'Discord',
  slack: 'Slack',
  email: 'e-mail',
  whatsapp: 'WhatsApp',
  webchat: 'chat web',
  messaging: 'mensagens',
  communication: 'comunicação',
  social: 'social',
  business: 'negócios',
  async: 'assíncrono',
  widget: 'widget',
  'customer-support': 'atendimento',
  conversation: 'conversa',
  llm: 'IA',
  chat: 'chat',
  sandbox: 'isolamento',
  javascript: 'JavaScript',
  python: 'Python',
  execution: 'execução',
  safe: 'seguro',
  docker: 'Docker',
  tools: 'ferramentas',
  catalog: 'catálogo',
  filesystem: 'arquivos',
  web: 'web',
  git: 'Git',
  memory: 'memória',
  utility: 'utilidades',
};

export function localizedCapability<T extends { id: string; name: string; description: string }>(
  cap: T
): T {
  const translated = CAPABILITY_PT_BR[cap.id];
  return translated ? { ...cap, ...translated } : cap;
}
