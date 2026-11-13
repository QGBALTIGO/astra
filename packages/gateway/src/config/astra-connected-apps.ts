/** Curated personal-assessor connections. Provider free plans have their own limits. */
export const ASTRA_CONNECTED_APPS = [
  {
    slug: 'googlecalendar',
    name: 'Google Agenda',
    description: 'Consulte compromissos e organize os horários da sua rotina.',
  },
  {
    slug: 'gmail',
    name: 'Gmail',
    description: 'Encontre e-mails e acompanhe mensagens importantes.',
  },
  {
    slug: 'googledrive',
    name: 'Google Drive',
    description: 'Encontre seus documentos e arquivos autorizados.',
  },
  {
    slug: 'googlesheets',
    name: 'Google Planilhas',
    description: 'Organize controles, listas e informações em planilhas.',
  },
  {
    slug: 'todoist',
    name: 'Todoist',
    description: 'Organize tarefas, prioridades e prazos pessoais.',
  },
  {
    slug: 'notion',
    name: 'Notion',
    description: 'Reúna anotações, ideias e projetos nas páginas que escolher.',
  },
  {
    slug: 'trello',
    name: 'Trello',
    description: 'Acompanhe tarefas e projetos em quadros e cartões.',
  },
] as const;

export type AstraConnectedAppSlug = (typeof ASTRA_CONNECTED_APPS)[number]['slug'];
export const ASTRA_CONNECTED_APP_SLUGS = ASTRA_CONNECTED_APPS.map((app) => app.slug) as [
  AstraConnectedAppSlug,
  ...AstraConnectedAppSlug[],
];
