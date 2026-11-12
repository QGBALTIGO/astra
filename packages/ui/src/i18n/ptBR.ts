/** Astra Portuguese compatibility layer.
 * Localizes only exact UI chrome labels. Never translates chat messages,
 * editor/code content, arbitrary user data, or model output.
 * Core screens also use translated source strings. This layer covers
 * legacy OwnPilot pages pending component-level i18n conversion.
 */
const labels: Record<string, string> = {
  Chat: 'Conversa',
  Home: 'Início',
  Dashboard: 'Visão geral',
  Overview: 'Visão geral',
  Analytics: 'Análises',
  Tools: 'Ferramentas',
  Settings: 'Configurações',
  Menu: 'Menu',
  Close: 'Fechar',
  Open: 'Abrir',
  Search: 'Buscar',
  'Search...': 'Buscar...',
  'Search anything...': 'Busque qualquer informação...',
  'Search conversations...': 'Buscar conversas...',
  'New Chat': 'Nova conversa',
  'New chat': 'Nova conversa',
  'New Conversation': 'Nova conversa',
  'New conversation': 'Nova conversa',
  Conversations: 'Conversas',
  Recent: 'Recentes',
  'Recent Chats': 'Conversas recentes',
  'All Conversations': 'Todas as conversas',
  Today: 'Hoje',
  Yesterday: 'Ontem',
  'This Week': 'Esta semana',
  'Last Week': 'Semana passada',
  'This Month': 'Este mês',
  Older: 'Anteriores',
  Calendar: 'Agenda',
  Tasks: 'Tarefas',
  Notes: 'Anotações',
  Contacts: 'Contatos',
  Expenses: 'Finanças',
  Bookmarks: 'Favoritos',
  Habits: 'Hábitos',
  Goals: 'Objetivos',
  Plans: 'Planos',
  Memories: 'Memórias',
  Workflows: 'Automações',
  Triggers: 'Lembretes',
  Channels: 'Canais',
  WhatsApp: 'WhatsApp',
  Agents: 'Agentes',
  Autonomy: 'Autonomia',
  'AI Providers': 'Provedores de IA',
  'AI Models': 'Modelos de IA',
  Provider: 'Provedor',
  Providers: 'Provedores',
  Model: 'Modelo',
  Models: 'Modelos',
  'Default Model': 'Modelo padrão',
  'Default Provider': 'Provedor padrão',
  Groq: 'Groq',
  Connected: 'Conectado',
  'Connecting...': 'Conectando...',
  Disconnected: 'Desconectado',
  'Connection Error': 'Erro de conexão',
  Active: 'Ativo',
  Inactive: 'Inativo',
  Enabled: 'Ativado',
  Disabled: 'Desativado',
  Available: 'Disponível',
  Unavailable: 'Indisponível',
  Online: 'Online',
  Offline: 'Offline',
  Ready: 'Pronto',
  Pending: 'Pendente',
  Running: 'Em execução',
  Completed: 'Concluído',
  Failed: 'Falhou',
  Paused: 'Pausado',
  Error: 'Erro',
  Success: 'Sucesso',
  Warning: 'Aviso',
  Save: 'Salvar',
  'Save Changes': 'Salvar alterações',
  'Save changes': 'Salvar alterações',
  Saved: 'Salvo',
  'Saving...': 'Salvando...',
  Cancel: 'Cancelar',
  Delete: 'Excluir',
  Edit: 'Editar',
  Add: 'Adicionar',
  Create: 'Criar',
  Update: 'Atualizar',
  Remove: 'Remover',
  Clear: 'Limpar',
  Reset: 'Restaurar',
  Refresh: 'Atualizar',
  Retry: 'Tentar novamente',
  'Try Again': 'Tentar novamente',
  Confirm: 'Confirmar',
  Continue: 'Continuar',
  Back: 'Voltar',
  Next: 'Próximo',
  Done: 'Concluído',
  'Close menu': 'Fechar menu',
  'Open menu': 'Abrir menu',
  'Loading...': 'Carregando...',
  Loading: 'Carregando',
  'No results found': 'Nenhum resultado encontrado',
  'No data available': 'Nenhum dado disponível',
  'No results': 'Nenhum resultado',
  'View All': 'Ver tudo',
  'View all': 'Ver tudo',
  'Show More': 'Mostrar mais',
  'Show Less': 'Mostrar menos',
  Details: 'Detalhes',
  'See Details': 'Ver detalhes',
  History: 'Histórico',
  Title: 'Título',
  Name: 'Nome',
  Description: 'Descrição',
  Date: 'Data',
  Time: 'Horário',
  Status: 'Status',
  Category: 'Categoria',
  Amount: 'Valor',
  Priority: 'Prioridade',
  Type: 'Tipo',
  Duration: 'Duração',
  Actions: 'Ações',
  Options: 'Opções',
  Filters: 'Filtros',
  Filter: 'Filtrar',
  Sort: 'Ordenar',
  'Today’s Tasks': 'Tarefas de hoje',
  High: 'Alta',
  Low: 'Baixa',
  Normal: 'Normal',
  Urgent: 'Urgente',
  'Add Task': 'Adicionar tarefa',
  'New Task': 'Nova tarefa',
  'Create Task': 'Criar tarefa',
  'Task Details': 'Detalhes da tarefa',
  'Due Date': 'Prazo',
  Overdue: 'Atrasada',
  'All Tasks': 'Todas as tarefas',
  'Pending Tasks': 'Tarefas pendentes',
  'Create Event': 'Criar compromisso',
  'New Event': 'Novo compromisso',
  'Upcoming Events': 'Próximos compromissos',
  'All Events': 'Todos os compromissos',
  'Event Details': 'Detalhes do compromisso',
  Reminder: 'Lembrete',
  Reminders: 'Lembretes',
  Schedule: 'Agendar',
  'Add Expense': 'Registrar despesa',
  'New Expense': 'Nova despesa',
  'Total Expenses': 'Total de despesas',
  'Monthly Expenses': 'Despesas do mês',
  'Total by Currency': 'Total por moeda',
  'Daily Average': 'Média diária',
  Transactions: 'Transações',
  'Top Category': 'Principal categoria',
  Budget: 'Orçamento',
  'New Note': 'Nova anotação',
  'Add Note': 'Adicionar anotação',
  'Create Note': 'Criar anotação',
  'Quick Add': 'Adicionar rapidamente',
  'Quick Actions': 'Ações rápidas',
  'Quick Capture': 'Registro rápido',
  Profile: 'Meu perfil',
  About: 'Sobre',
  Preferences: 'Preferências',
  Appearance: 'Aparência',
  Theme: 'Tema',
  Light: 'Claro',
  Dark: 'Escuro',
  System: 'Sistema',
  Language: 'Idioma',
  Customize: 'Personalizar',
  Layout: 'Aparência',
  Help: 'Ajuda',
  Support: 'Suporte',
  Logout: 'Sair',
  'Log out': 'Sair',
  'Sign Out': 'Sair',
  'Sign In': 'Entrar',
  'Sign in': 'Entrar',
  Password: 'Senha',
  Connect: 'Conectar',
  Disconnect: 'Desconectar',
  'Connected Apps': 'Aplicativos conectados',
  'Connect WhatsApp': 'Conectar WhatsApp',
  'Scan QR Code': 'Escanear QR Code',
  'Scan the QR code': 'Escaneie o QR Code',
  'Provider not configured': 'Provedor de IA não configurado',
  'No API Keys': 'Nenhuma chave de IA configurada',
  'Setup Required': 'Configuração necessária',
  'Type a message...': 'Escreva sua mensagem...',
  Send: 'Enviar',
  'Send Message': 'Enviar mensagem',
  'Stop Generation': 'Parar resposta',
  'Stop generation': 'Parar resposta',
  'Attach image': 'Anexar imagem',
  'Upload File': 'Enviar arquivo',
  'Upload file': 'Enviar arquivo',
  'Model Routing': 'Roteamento de IA',
  'API Keys': 'Chaves de API',
  'Config Center': 'Central de configurações',
  Security: 'Segurança',
  'Security Scanner': 'Verificação de segurança',
  Logs: 'Registros',
  Costs: 'Custos',
  Skills: 'Habilidades',
  Plugins: 'Integrações',
  Extensions: 'Extensões',
  Workspaces: 'Ambientes',
  'Custom Data': 'Dados personalizados',
  'Personal Data': 'Dados pessoais',
  'AI & Automation': 'IA e automações',
  'Tools & Extensions': 'Ferramentas e extensões',
  'My Data': 'Meus dados',
  'Agentic Center': 'Central de IA',
  'Mission Control': 'Monitoramento',
  'Code Runners (CLI)': 'Execução de código',
  'Nothing here yet': 'Ainda não há itens aqui',
  'Get Started': 'Começar',
  'Get started': 'Começar',
  'Learn More': 'Saiba mais',
  'Learn more': 'Saiba mais',
  'Getting Started': 'Primeiros passos',
  All: 'Todos',
  Configured: 'Configurados',
  Unconfigured: 'Não configurados',
  'Recent Activity': 'Atividades recentes',
  'AI Assistant': 'Assistente de IA',
  'Personal Assistant': 'Assistente pessoal',
  Agent: 'Agente',
  'Create your first task': 'Crie sua primeira tarefa',
  'Manage AI providers and their configurations': 'Gerencie seus provedores de IA',
  'Loading providers...': 'Carregando provedores...',
  'Failed to load providers': 'Não foi possível carregar os provedores',
  New: 'Novo',
  NEW: 'NOVO',
  'Today’s Schedule': 'Agenda de hoje',
  'Task Progress': 'Progresso das tarefas',
  'Pinned Artifacts': 'Arquivos fixados',
  'Calendar Events': 'Compromissos',
  Welcome: 'Bem-vindo',
  'Good morning': 'Bom dia',
  'Good afternoon': 'Boa tarde',
  'Good evening': 'Boa noite',
  'Search providers...': 'Buscar provedores...',
  'Ask anything...': 'Pergunte o que quiser...',
  'Your assistant is ready': 'Seu assistente está pronto',
  'Welcome to OwnPilot': 'Bem-vindo ao Astra',
  'For you': 'Para você',
  Examples: 'Sugestões',
  'Configure API Keys': 'Configurar IA',
  'View details': 'Ver detalhes',
  'Add new': 'Adicionar',
  'No items yet': 'Nenhum item ainda',
};

const uiTags =
  'button,label,h1,h2,h3,h4,nav,aside,header,option,[role="tab"],[role="button"],[role="dialog"]';
const protectedContent =
  'pre,code,kbd,textarea,[contenteditable="true"],[data-testid*="message"],.prose,[class*="markdown"],[class*="Markdown"],[data-no-translate]';

function lookup(value: string): string | undefined {
  return labels[value.trim()];
}

function applyAttributes(element: Element) {
  if (element.closest(protectedContent)) return;
  for (const name of ['placeholder', 'title', 'aria-label']) {
    const value = element.getAttribute(name);
    if (!value) continue;
    const translation = lookup(value);
    if (translation && translation !== value) element.setAttribute(name, translation);
  }
}

function applyText(node: Node) {
  const element = node.parentElement;
  if (!element || element.closest(protectedContent)) return;
  if (!element.closest(uiTags)) return;
  const value = node.nodeValue;
  if (!value) return;
  const trimmed = value.trim();
  const translation = labels[trimmed];
  if (!translation || translation === trimmed) return;
  node.nodeValue = value.replace(trimmed, translation);
}

function visit(root: Node) {
  if (root.nodeType === Node.TEXT_NODE) {
    applyText(root);
    return;
  }
  if (root.nodeType !== Node.ELEMENT_NODE) return;
  const element = root as Element;
  if (element.matches('[placeholder],[title],[aria-label]')) applyAttributes(element);
  for (const child of element.querySelectorAll('[placeholder],[title],[aria-label]')) {
    applyAttributes(child);
  }
  const walker = document.createTreeWalker(element, NodeFilter.SHOW_TEXT);
  while (walker.nextNode()) applyText(walker.currentNode);
}

export function installPtBrUi() {
  document.documentElement.lang = 'pt-BR';
  const root = document.getElementById('root');
  if (!root) return;
  const pending = new Set<Node>();
  let scheduled = false;
  const schedule = (node: Node) => {
    pending.add(node);
    if (scheduled) return;
    scheduled = true;
    requestAnimationFrame(() => {
      scheduled = false;
      for (const item of pending) visit(item);
      pending.clear();
    });
  };
  schedule(root);
  const observer = new MutationObserver((mutations) => {
    for (const m of mutations) {
      if (m.type === 'childList') {
        for (const node of m.addedNodes) schedule(node);
      } else if (m.type === 'characterData') {
        schedule(m.target);
      } else if (m.type === 'attributes') {
        schedule(m.target);
      }
    }
  });
  observer.observe(root, {
    childList: true,
    subtree: true,
    characterData: true,
    attributes: true,
    attributeFilter: ['placeholder', 'title', 'aria-label'],
  });
}
