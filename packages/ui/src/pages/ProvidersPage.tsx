import { ProvidersTab } from '../components/ProvidersTab';

export function ProvidersPage() {
  return (
    <div className="flex h-full min-w-0 flex-col">
      <header className="border-b border-border px-4 py-5 dark:border-dark-border sm:px-6">
        <h2 className="text-xl font-bold tracking-tight text-text-primary dark:text-dark-text-primary">
          Provedores de IA
        </h2>
        <p className="text-sm text-text-muted dark:text-dark-text-muted">
          Neste ambiente, o Groq é o único provedor de IA ativo.
        </p>
      </header>
      <div className="min-h-0 flex-1 overflow-y-auto p-4 sm:p-6">
        <ProvidersTab />
      </div>
    </div>
  );
}
