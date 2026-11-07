/**
 * WorkflowEditorToolbar — header/toolbar for the workflow editor.
 */

import type { Node } from '@xyflow/react';

import {
  ChevronLeft,
  Save,
  Play,
  StopCircle,
  Code,
  Sparkles,
  LayoutDashboard,
  ListChecks,
  FlaskConical,
  History,
  Settings,
  Layout,
} from '../../components/icons';

interface WorkflowEditorToolbarProps {
  workflowName: string;
  setWorkflowName: (name: string) => void;
  hasUnsavedChanges: boolean;
  setHasUnsavedChanges: (v: boolean) => void;
  isSaving: boolean;
  isExecuting: boolean;
  isDryRun: boolean;
  nodes: Node[];
  variables: Record<string, unknown>;
  inputSchema: Array<{
    name: string;
    type: 'string' | 'number' | 'boolean' | 'json';
    required: boolean;
    defaultValue?: string;
    description?: string;
  }>;
  showVariables: boolean;
  setShowVariables: (v: boolean) => void;
  showCopilot: boolean;
  setShowCopilot: (v: boolean) => void;
  showVersions: boolean;
  setShowVersions: (v: boolean) => void;
  showInputParams: boolean;
  setShowInputParams: (v: boolean) => void;
  setShowTemplates: (v: boolean) => void;
  setShowSource: (v: boolean) => void;
  setSelectedNodeId: (id: string | null) => void;
  navigate: (path: string) => void;
  handleSave: () => void | Promise<unknown>;
  handleArrange: () => void;
  handleExecute: (dryRun: boolean) => void;
  handleCancel: () => void;
  executionProgress: {
    total: number;
    completed: number;
    running: string | null;
    failed: number;
    retries: number;
  } | null;
}

export function WorkflowEditorToolbar({
  workflowName,
  setWorkflowName,
  hasUnsavedChanges,
  setHasUnsavedChanges,
  isSaving,
  isExecuting,
  isDryRun,
  nodes,
  variables,
  inputSchema,
  showVariables,
  setShowVariables,
  showCopilot,
  setShowCopilot,
  showVersions,
  setShowVersions,
  showInputParams,
  setShowInputParams,
  setShowTemplates,
  setShowSource,
  setSelectedNodeId,
  navigate,
  handleSave,
  handleArrange,
  handleExecute,
  handleCancel,
  executionProgress,
}: WorkflowEditorToolbarProps) {
  return (
    <div>
      <header className="flex min-w-0 items-center gap-2 px-3 sm:px-4 py-2.5 border-b border-border dark:border-dark-border bg-bg-secondary dark:bg-dark-bg-secondary">
        <button
          onClick={() => navigate('/workflows')}
          className="p-1.5 text-text-muted hover:text-text-primary dark:hover:text-dark-text-primary transition-colors"
          title="Voltar para automações"
        >
          <ChevronLeft className="w-5 h-5" />
        </button>

        <input
          type="text"
          value={workflowName}
          onChange={(e) => {
            setWorkflowName(e.target.value);
            setHasUnsavedChanges(true);
          }}
          className="flex-1 text-sm font-semibold bg-transparent text-text-primary dark:text-dark-text-primary border-none focus:outline-none focus:ring-0 min-w-0"
          placeholder="Nome da automação..."
        />

        {hasUnsavedChanges && <span className="hidden sm:inline text-xs text-warning">Não salvo</span>}

        <button
          onClick={handleSave}
          disabled={isSaving || !hasUnsavedChanges}
          className="flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium bg-bg-tertiary dark:bg-dark-bg-tertiary text-text-primary dark:text-dark-text-primary hover:bg-bg-primary dark:hover:bg-dark-bg-primary border border-border dark:border-dark-border rounded-md transition-colors disabled:opacity-50"
        >
          <Save className="w-3.5 h-3.5" />
          {isSaving ? 'Salvando...' : 'Salvar'}
        </button>
      </header>

      {/* Secondary actions remain accessible via horizontal scroll on phones. */}
      <div
        className="flex min-w-0 items-center gap-2 overflow-x-auto whitespace-nowrap border-b border-border bg-bg-secondary px-3 py-2 dark:border-dark-border dark:bg-dark-bg-secondary"
        aria-label="Ferramentas do editor"
      >
        <button
          onClick={handleArrange}
          disabled={nodes.length === 0 || isExecuting}
          className="flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium bg-bg-tertiary dark:bg-dark-bg-tertiary text-text-primary dark:text-dark-text-primary hover:bg-bg-primary dark:hover:bg-dark-bg-primary border border-border dark:border-dark-border rounded-md transition-colors disabled:opacity-50"
          title="Organizar nós automaticamente"
        >
          <LayoutDashboard className="w-3.5 h-3.5" />
          Organizar
        </button>

        <button
          onClick={() => setShowSource(true)}
          className="flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium bg-bg-tertiary dark:bg-dark-bg-tertiary text-text-primary dark:text-dark-text-primary hover:bg-bg-primary dark:hover:bg-dark-bg-primary border border-border dark:border-dark-border rounded-md transition-colors"
          title="Visualizar código da automação"
        >
          <Code className="w-3.5 h-3.5" />
          Código
        </button>

        <button
          onClick={() => {
            setShowVariables(!showVariables);
            if (!showVariables) {
              setShowCopilot(false);
              setShowVersions(false);
              setSelectedNodeId(null);
            }
          }}
          className={`flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium rounded-md transition-colors ${
            showVariables
              ? 'bg-primary text-white'
              : 'bg-bg-tertiary dark:bg-dark-bg-tertiary text-text-primary dark:text-dark-text-primary hover:bg-bg-primary dark:hover:bg-dark-bg-primary border border-border dark:border-dark-border'
          }`}
          title={showVariables ? 'Ocultar variáveis' : 'Editar variáveis da automação'}
        >
          <ListChecks className="w-3.5 h-3.5" />
          Variáveis
          {Object.keys(variables).length > 0 && (
            <span className="ml-0.5 px-1.5 py-0 text-[10px] bg-white/20 rounded-full">
              {Object.keys(variables).length}
            </span>
          )}
        </button>

        <button
          onClick={() => {
            setShowInputParams(!showInputParams);
            if (!showInputParams) {
              setShowCopilot(false);
              setShowVariables(false);
              setShowVersions(false);
              setSelectedNodeId(null);
            }
          }}
          className={`flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium rounded-md transition-colors ${
            showInputParams
              ? 'bg-primary text-white'
              : 'bg-bg-tertiary dark:bg-dark-bg-tertiary text-text-primary dark:text-dark-text-primary hover:bg-bg-primary dark:hover:bg-dark-bg-primary border border-border dark:border-dark-border'
          }`}
          title={showInputParams ? 'Ocultar entradas' : 'Definir parâmetros de entrada'}
        >
          <Settings className="w-3.5 h-3.5" />
          Entradas
          {inputSchema.length > 0 && (
            <span className="ml-0.5 px-1.5 py-0 text-[10px] bg-white/20 rounded-full">
              {inputSchema.length}
            </span>
          )}
        </button>

        <button
          onClick={() => setShowTemplates(true)}
          className="flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium bg-bg-tertiary dark:bg-dark-bg-tertiary text-text-primary dark:text-dark-text-primary hover:bg-bg-primary dark:hover:bg-dark-bg-primary border border-border dark:border-dark-border rounded-md transition-colors"
          title="Importar da galeria de modelos"
        >
          <Layout className="w-3.5 h-3.5" />
          Modelos
        </button>

        <button
          onClick={() => {
            setShowVersions(!showVersions);
            if (!showVersions) {
              setShowCopilot(false);
              setShowVariables(false);
              setSelectedNodeId(null);
            }
          }}
          className={`flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium rounded-md transition-colors ${
            showVersions
              ? 'bg-primary text-white'
              : 'bg-bg-tertiary dark:bg-dark-bg-tertiary text-text-primary dark:text-dark-text-primary hover:bg-bg-primary dark:hover:bg-dark-bg-primary border border-border dark:border-dark-border'
          }`}
          title={showVersions ? 'Ocultar versões' : 'Histórico de versões'}
        >
          <History className="w-3.5 h-3.5" />
          Versões
        </button>

        <button
          onClick={() => {
            setShowCopilot(!showCopilot);
            if (!showCopilot) {
              setShowVariables(false);
              setShowVersions(false);
              setSelectedNodeId(null);
            }
          }}
          className={`flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium rounded-md transition-colors ${
            showCopilot
              ? 'bg-primary text-white'
              : 'bg-bg-tertiary dark:bg-dark-bg-tertiary text-text-primary dark:text-dark-text-primary hover:bg-bg-primary dark:hover:bg-dark-bg-primary border border-border dark:border-dark-border'
          }`}
          title={
            showCopilot ? 'Ocultar copiloto' : 'Copiloto de IA — crie automações por linguagem natural'
          }
        >
          <Sparkles className="w-3.5 h-3.5" />
          Copiloto
        </button>

        {isExecuting ? (
          <button
            onClick={handleCancel}
            className={`flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium text-white hover:opacity-90 rounded-md transition-colors ${isDryRun ? 'bg-warning' : 'bg-error'}`}
          >
            <StopCircle className="w-3.5 h-3.5" />
            {isDryRun ? 'Cancelar teste' : 'Cancelar'}
          </button>
        ) : (
          <>
            <button
              onClick={() => handleExecute(true)}
              disabled={nodes.length === 0}
              className="flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium bg-warning/15 text-warning hover:bg-warning/25 border border-warning/30 rounded-md transition-colors disabled:opacity-50"
              title="Simulação: valida a automação sem executar ferramentas e ações externas"
            >
              <FlaskConical className="w-3.5 h-3.5" />
              Testar
            </button>
            <button
              onClick={() => handleExecute(false)}
              disabled={nodes.length === 0}
              className="flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium bg-primary text-white hover:bg-primary-dark rounded-md transition-colors disabled:opacity-50"
            >
              <Play className="w-3.5 h-3.5" />
              Executar
            </button>
          </>
        )}
      </div>

      {isExecuting && executionProgress && (
        <div className="flex items-center gap-3 px-4 py-2 bg-warning/10 border-b border-warning/20">
          <div className="flex-1">
            <div className="flex items-center justify-between text-xs mb-1">
              <span className="font-medium text-warning">
                {executionProgress.running
                  ? `Executando: ${executionProgress.running}`
                  : 'Processando...'}
              </span>
              <span className="text-text-muted">
                {executionProgress.completed}/{executionProgress.total} nós
                {executionProgress.retries > 0 ? ` (${executionProgress.retries} tentativas)` : ''}
              </span>
            </div>
            <div className="w-full h-1.5 bg-warning/20 rounded-full overflow-hidden">
              <div
                className="h-full bg-warning rounded-full transition-all duration-300"
                style={{
                  width: `${(executionProgress.completed / Math.max(executionProgress.total, 1)) * 100}%`,
                }}
              />
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
