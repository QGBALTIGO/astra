/**
 * Channels Management Page
 *
 * Displays all channel plugins, their live connection status,
 * message stats, users, and provides connect/disconnect/reconnect actions.
 */

import { useState, useEffect, useCallback } from 'react';
import { useSearchParams, useNavigate } from 'react-router';
import { channelsApi } from '../api/endpoints/misc';
import { useGateway } from '../hooks/useWebSocket';
import { useSkipHome } from '../hooks/useSkipHome';
import { useToast } from '../components/ToastProvider';
import { useDialog } from '../components/ConfirmDialog';
import { ChannelSetupModal } from '../components/ChannelSetupModal';
import { PageHomeTab } from '../components/PageHomeTab';
import { Plus, Activity, Send, Home, MessageSquare, Globe, Inbox, Bot } from '../components/icons';
import type { Channel, ChannelUser, ChannelStats } from '../api/types';
import { ChannelDetail, PairingBanner } from './channels-detail';
import { timeAgo, getStatusColor, getStatusBg, StatusIcon, PlatformIcon } from './channels-helpers';

// Re-export for backward compatibility
export { timeAgo, getStatusColor, getStatusBg, StatusIcon, PlatformIcon };

// ============================================================================
// Tab system
// ============================================================================

type TabId = 'home' | 'channels';

const TAB_LABELS: Record<TabId, string> = {
  home: 'Início',
  channels: 'Canais',
};

// ============================================================================
// Main Component
// ============================================================================

export function ChannelsPage() {
  const toast = useToast();
  const { confirm } = useDialog();
  const { subscribe } = useGateway();
  const [searchParams] = useSearchParams();
  const navigate = useNavigate();

  const { skipHome, onSkipHomeChange } = useSkipHome({
    pageName: 'channels',
    defaultTab: 'channels',
  });

  const tabParam = searchParams.get('tab') as TabId;
  const activeTab: TabId = tabParam || 'home';

  const setTab = (tab: TabId) => {
    const params = new URLSearchParams(searchParams);
    params.set('tab', tab);
    navigate({ search: params.toString() }, { replace: true });
  };

  const [channels, setChannels] = useState<Channel[]>([]);
  const [summary, setSummary] = useState<{
    total: number;
    connected: number;
    disconnected: number;
  }>({
    total: 0,
    connected: 0,
    disconnected: 0,
  });
  const [isLoading, setIsLoading] = useState(true);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [showSetup, setShowSetup] = useState(false);

  // Detail panel state
  const [users, setUsers] = useState<ChannelUser[]>([]);
  const [stats, setStats] = useState<ChannelStats | null>(null);
  const [detailLoading, setDetailLoading] = useState(false);
  const [actionLoading, setActionLoading] = useState<string | null>(null);

  const selectedChannel = channels.find((ch) => ch.id === selectedId) ?? null;

  // ---- Load channels ----
  const loadChannels = useCallback(async () => {
    try {
      const resp = await channelsApi.list();
      setChannels(resp.channels);
      setSummary(resp.summary);

      // Auto-select first if nothing selected
      if (!selectedId && resp.channels.length > 0) {
        setSelectedId(resp.channels[0]!.id);
      }
    } catch {
      toast.error('Não foi possível carregar os canais');
    } finally {
      setIsLoading(false);
    }
  }, [selectedId, toast]);

  useEffect(() => {
    loadChannels();
  }, [loadChannels]);

  // ---- Load detail when selection changes ----
  const loadDetail = useCallback(
    async (channelId: string) => {
      setDetailLoading(true);
      try {
        const [usersResp, statsResp] = await Promise.all([
          channelsApi.getUsers(channelId),
          channelsApi.getStats(channelId),
        ]);
        setUsers(usersResp.users);
        setStats(statsResp);
      } catch {
        toast.error('Não foi possível carregar detalhes do canal');
      } finally {
        setDetailLoading(false);
      }
    },
    [toast]
  );

  useEffect(() => {
    if (selectedId) {
      loadDetail(selectedId);
    }
  }, [selectedId, loadDetail]);

  // ---- Real-time updates ----
  useEffect(() => {
    const unsub1 = subscribe<{ entity: string; action: string; id?: string }>(
      'data:changed',
      (data) => {
        if (data.entity === 'channel') {
          loadChannels();
          if (selectedId) loadDetail(selectedId);
        }
      }
    );
    const unsub2 = subscribe<{ channelId: string }>('channel:message', () => {
      // Refresh stats on new message
      if (selectedId) loadDetail(selectedId);
    });
    const unsub3 = subscribe<{ channelId: string; status: string }>('channel:status', (data) => {
      setChannels((prev) =>
        prev.map((ch) =>
          ch.id === data.channelId ? { ...ch, status: data.status as Channel['status'] } : ch
        )
      );
    });
    const unsub4 = subscribe<{ displayName?: string }>('channel:user:pending', (data) => {
      toast.info(`Novo usuário aguardando aprovação: ${data.displayName ?? 'Desconhecido'}`);
      if (selectedId) loadDetail(selectedId);
    });

    return () => {
      unsub1();
      unsub2();
      unsub3();
      unsub4();
    };
  }, [subscribe, selectedId, loadChannels, loadDetail, toast]);

  // ---- Actions ----
  const handleConnect = useCallback(
    async (channelId: string) => {
      setActionLoading('connect');
      try {
        await channelsApi.connect(channelId);
        toast.success('Canal conectado');
        await loadChannels();
      } catch {
        toast.error('Não foi possível conectar o canal');
      } finally {
        setActionLoading(null);
      }
    },
    [toast, loadChannels]
  );

  const handleDisconnect = useCallback(
    async (channelId: string) => {
      setActionLoading('disconnect');
      try {
        await channelsApi.disconnect(channelId);
        toast.success('Canal desconectado');
        await loadChannels();
      } catch {
        toast.error('Não foi possível desconectar o canal');
      } finally {
        setActionLoading(null);
      }
    },
    [toast, loadChannels]
  );

  const handleLogout = useCallback(
    async (channelId: string) => {
      if (
        !(await confirm({
          message:
            'Logout will clear session data. You will need to re-authenticate (e.g. scan QR code) on next connect. Continue?',
          variant: 'danger',
        }))
      )
        return;
      setActionLoading('logout');
      try {
        await channelsApi.logout(channelId);
        toast.success('Sessão do canal encerrada');
        await loadChannels();
      } catch {
        toast.error('Não foi possível encerrar a sessão do canal');
      } finally {
        setActionLoading(null);
      }
    },
    [toast, loadChannels]
  );

  const handleReconnect = useCallback(
    async (channelId: string) => {
      setActionLoading('reconnect');
      try {
        await channelsApi.reconnect(channelId);
        toast.success('Canal reconectado');
        await loadChannels();
      } catch {
        toast.error('Não foi possível reconectar o canal');
      } finally {
        setActionLoading(null);
      }
    },
    [toast, loadChannels]
  );

  const handleSendTest = useCallback(async (channelId: string, text: string, chatId?: string) => {
    await channelsApi.send(channelId, { text, ...(chatId ? { chatId } : {}) });
  }, []);

  const handleClearMessages = useCallback(
    async (channelId: string) => {
      if (
        !(await confirm({
          message: 'Apagar todas as mensagens deste canal? Esta ação não pode ser desfeita.',
          variant: 'danger',
        }))
      )
        return;
      setActionLoading('clear');
      try {
        const resp = await channelsApi.clearMessages(channelId);
        toast.success(`${resp.deleted} mensagens removidas`);
        if (selectedId === channelId) loadDetail(channelId);
      } catch {
        toast.error('Não foi possível limpar as mensagens');
      } finally {
        setActionLoading(null);
      }
    },
    [toast, selectedId, loadDetail]
  );

  // ---- User actions ----
  const handleApproveUser = useCallback(
    async (userId: string, pendingPairingCode?: string, platform?: string) => {
      try {
        if (pendingPairingCode && platform) {
          // DM pairing pending user — use code-based approval
          await channelsApi.approvePairing(platform, pendingPairingCode);
          toast.success('Usuário aprovado com código de vinculação');
        } else {
          await channelsApi.approveUser(userId);
          toast.success('Usuário aprovado');
        }
        if (selectedId) loadDetail(selectedId);
      } catch {
        toast.error('Não foi possível aprovar o usuário');
      }
    },
    [toast, selectedId, loadDetail]
  );

  const handleBlockUser = useCallback(
    async (userId: string) => {
      if (
        !(await confirm({
          message: 'Bloquear este contato? Ele não poderá mais falar com o assistente.',
          variant: 'danger',
        }))
      )
        return;
      try {
        await channelsApi.blockUser(userId);
        toast.success('Usuário bloqueado');
        if (selectedId) loadDetail(selectedId);
      } catch {
        toast.error('Não foi possível bloquear o usuário');
      }
    },
    [toast, selectedId, loadDetail]
  );

  const handleUnblockUser = useCallback(
    async (userId: string) => {
      try {
        await channelsApi.unblockUser(userId);
        toast.success('Usuário desbloqueado');
        if (selectedId) loadDetail(selectedId);
      } catch {
        toast.error('Não foi possível desbloquear o usuário');
      }
    },
    [toast, selectedId, loadDetail]
  );

  const handleDeleteUser = useCallback(
    async (userId: string) => {
      if (
        !(await confirm({ message: 'Excluir este usuário? Essa ação não poderá ser desfeita.', variant: 'danger' }))
      )
        return;
      try {
        await channelsApi.deleteUser(userId);
        toast.success('Usuário excluído');
        if (selectedId) loadDetail(selectedId);
      } catch {
        toast.error('Não foi possível excluir o usuário');
      }
    },
    [toast, selectedId, loadDetail]
  );

  const handleDenyUser = useCallback(
    async (_userId: string, platformUserId: string) => {
      if (!selectedChannel) return;
      if (
        !(await confirm({
          message: 'Rejeitar este contato? Ele será impedido de enviar mensagens ao assistente.',
          variant: 'danger',
        }))
      )
        return;
      try {
        const platform = selectedChannel.id.includes('.')
          ? selectedChannel.id.split('.')[1]!
          : selectedChannel.type;
        await channelsApi.denyPairing(platform, platformUserId);
        toast.success('Usuário recusado');
        if (selectedId) loadDetail(selectedId);
      } catch {
        toast.error('Não foi possível recusar o usuário');
      }
    },
    [toast, selectedId, loadDetail, selectedChannel]
  );

  return (
    <div className="h-full flex flex-col">
      {/* Header */}
      <header className="flex flex-col gap-3 border-b border-border px-4 py-5 dark:border-dark-border sm:flex-row sm:items-center sm:justify-between sm:px-6">
        <div>
          <h2 className="text-xl font-bold tracking-tight text-text-primary dark:text-dark-text-primary">
            Canais conectados
          </h2>
          <p className="text-sm text-text-muted dark:text-dark-text-muted">
            Conecte seu WhatsApp e acompanhe as mensagens do assistente.
          </p>
        </div>
        <button
          onClick={() => setShowSetup(true)}
          className="inline-flex min-h-10 items-center justify-center gap-2 rounded-xl bg-primary px-4 py-2 text-sm font-semibold text-white transition-colors hover:bg-primary-dark"
        >
          <Plus className="w-3.5 h-3.5" />
          Conectar canal
        </button>
      </header>

      {/* Status summary bar */}
      <div className="flex flex-wrap items-center gap-x-4 gap-y-2 px-4 sm:px-6 py-3">
        <div className="flex items-center gap-1.5 text-xs">
          <div className="w-2 h-2 rounded-full bg-success" />
          <span className="text-text-secondary dark:text-dark-text-secondary">
            {summary.connected} conectados
          </span>
        </div>
        <div className="flex items-center gap-1.5 text-xs">
          <div className="w-2 h-2 rounded-full bg-text-muted" />
          <span className="text-text-secondary dark:text-dark-text-secondary">
            {summary.disconnected} desconectados
          </span>
        </div>
        <div className="flex items-center gap-1.5 text-xs text-text-muted dark:text-dark-text-muted">
          <Activity className="w-3 h-3" />
          {summary.total} no total
        </div>
      </div>

      {/* Tab Bar */}
      <div className="flex gap-2 border-b border-border px-4 pt-2 dark:border-dark-border sm:px-6">
        {(['home', 'channels'] as TabId[]).map((tab) => (
          <button
            key={tab}
            onClick={() => setTab(tab)}
            className={`flex items-center gap-1.5 px-4 py-2.5 text-sm font-medium border-b-2 transition-colors -mb-px ${
              activeTab === tab
                ? 'border-primary text-primary'
                : 'border-transparent text-text-muted dark:text-dark-text-muted hover:text-text-secondary dark:hover:text-dark-text-secondary hover:border-border dark:hover:border-dark-border'
            }`}
          >
            {tab === 'home' && <Home className="w-3.5 h-3.5" />}
            {TAB_LABELS[tab]}
          </button>
        ))}
      </div>

      {/* Home Tab */}
      {activeTab === 'home' && (
        <div className="min-h-0 flex-1 overflow-y-auto bg-bg-primary dark:bg-dark-bg-primary">
          <PageHomeTab
            heroIcons={[
              { icon: MessageSquare, color: 'text-primary bg-primary/10' },
              { icon: Send, color: 'text-emerald-500 bg-emerald-500/10' },
              { icon: Globe, color: 'text-violet-500 bg-violet-500/10' },
            ]}
            title="Converse com o Astra pelo WhatsApp"
            subtitle="Conecte seu WhatsApp por QR Code para conversar com o Astra e receber ajuda com sua rotina diretamente pelo celular."
            cta={{
              label: 'Ver canais',
              icon: MessageSquare,
              onClick: () => setTab('channels'),
            }}
            features={[
              {
                icon: Globe,
                color: 'text-blue-500 bg-blue-500/10',
                title: 'Multiplataforma',
                description:
                  'Conecte WhatsApp e outros canais em um só painel, sem misturar as conversas.',
              },
              {
                icon: Inbox,
                color: 'text-emerald-500 bg-emerald-500/10',
                title: 'Conversas organizadas',
                description: 'Acompanhe tudo em um só histórico e não perca mensagens importantes.',
              },
              {
                icon: Bot,
                color: 'text-violet-500 bg-violet-500/10',
                title: 'Assistente com IA',
                description: 'O Astra responde com o modelo Groq selecionado para este ambiente.',
              },
              {
                icon: Activity,
                color: 'text-amber-500 bg-amber-500/10',
                title: 'Processamento inteligente',
                description:
                  'As mensagens passam por validações, memória e execução das ferramentas autorizadas.',
              },
            ]}
            steps={[
              {
                title: 'Escolha um canal',
                detail: 'Selecione o WhatsApp ou outro canal disponível no sistema.',
              },
              {
                title: 'Conecte com segurança',
                detail: 'No WhatsApp, use a câmera do celular para ler o QR Code de pareamento.',
              },
              {
                title: 'Envie uma mensagem de teste',
                detail: 'Teste o atendimento antes de ativar lembretes ou automações.',
              },
              {
                title: 'IA pronta para responder',
                detail:
                  'Depois da configuração, as mensagens são interpretadas e respondidas pelo Astra.',
              },
            ]}
            quickActions={[
              {
                icon: MessageSquare,
                label: 'Gerenciar canais',
                description: 'Veja o WhatsApp e configure a conexão',
                onClick: () => setTab('channels'),
              },
            ]}
            skipHomeChecked={skipHome}
            onSkipHomeChange={onSkipHomeChange}
            skipHomeLabel="Ir diretamente aos canais na próxima visita"
          />
        </div>
      )}

      {/* Channels Tab */}
      {activeTab === 'channels' && (
        <>
          {/* Pairing banner */}
          <PairingBanner />

          {/* Loading skeleton */}
          {isLoading ? (
            <div className="p-6 space-y-4">
              <div className="flex flex-col sm:flex-row gap-4">
                <div className="w-full sm:w-72 space-y-2">
                  {[1, 2, 3].map((i) => (
                    <div
                      key={i}
                      className="h-16 bg-bg-tertiary dark:bg-dark-bg-tertiary rounded-lg animate-pulse"
                    />
                  ))}
                </div>
                <div className="flex-1 h-96 bg-bg-tertiary dark:bg-dark-bg-tertiary rounded-lg animate-pulse" />
              </div>
            </div>
          ) : (
            /* Main content */
            <div className="flex-1 flex flex-col md:flex-row overflow-hidden min-h-0">
              {/* Sidebar — channel list */}
              <div className="max-h-64 w-full shrink-0 overflow-y-auto border-b border-border bg-bg-secondary dark:border-dark-border dark:bg-dark-bg-secondary md:max-h-none md:w-72 md:border-b-0 md:border-r">
                {channels.length === 0 ? (
                  <div className="p-6 text-center">
                    <Send className="w-8 h-8 mx-auto text-text-muted dark:text-dark-text-muted mb-2" />
                    <p className="text-sm text-text-muted dark:text-dark-text-muted">
                      Ainda não há canais conectados
                    </p>
                    <button
                      onClick={() => setShowSetup(true)}
                      className="mt-2 text-xs text-primary hover:underline"
                    >
                      Conectar meu WhatsApp
                    </button>
                  </div>
                ) : (
                  <div className="space-y-1 p-3">
                    {channels.map((ch) => (
                      <button
                        key={ch.id}
                        onClick={() => setSelectedId(ch.id)}
                        className={`flex w-full items-center gap-3 rounded-xl px-3 py-3 text-left transition-colors ${
                          selectedId === ch.id
                            ? 'border border-primary/30 bg-primary/10'
                            : 'border border-transparent hover:bg-bg-tertiary dark:hover:bg-dark-bg-tertiary'
                        }`}
                      >
                        <div
                          className={`shrink-0 w-9 h-9 rounded-lg flex items-center justify-center ${
                            ch.status === 'connected'
                              ? 'bg-primary/10 text-primary'
                              : 'bg-bg-tertiary dark:bg-dark-bg-tertiary text-text-muted dark:text-dark-text-muted'
                          }`}
                        >
                          <PlatformIcon type={ch.type} />
                        </div>
                        <div className="flex-1 min-w-0">
                          <div className="flex items-center gap-1.5">
                            <span className="text-sm font-medium text-text-primary dark:text-dark-text-primary truncate">
                              {ch.name}
                            </span>
                          </div>
                          <div className="flex items-center gap-1.5 mt-0.5">
                            <div
                              className={`w-1.5 h-1.5 rounded-full ${getStatusColor(ch.status).replace('text-', 'bg-')}`}
                            />
                            <span className="text-[10px] text-text-muted dark:text-dark-text-muted capitalize">
                              {{ connected: 'Conectado', connecting: 'Conectando', disconnected: 'Desconectado', error: 'Erro' }[ch.status] ?? ch.status}
                            </span>
                            {ch.botInfo?.username && (
                              <span className="text-[10px] text-text-muted dark:text-dark-text-muted">
                                @{ch.botInfo.username}
                              </span>
                            )}
                          </div>
                        </div>
                      </button>
                    ))}
                  </div>
                )}
              </div>

              {/* Detail panel */}
              <div className="min-h-0 flex-1 overflow-y-auto bg-bg-primary dark:bg-dark-bg-primary">
                {selectedChannel ? (
                  <ChannelDetail
                    channel={selectedChannel}
                    users={users}
                    stats={stats}
                    isLoading={detailLoading}
                    actionLoading={actionLoading}
                    onConnect={handleConnect}
                    onDisconnect={handleDisconnect}
                    onLogout={handleLogout}
                    onReconnect={handleReconnect}
                    onClearMessages={handleClearMessages}
                    onSendTest={handleSendTest}
                    onApproveUser={handleApproveUser}
                    onBlockUser={handleBlockUser}
                    onUnblockUser={handleUnblockUser}
                    onDeleteUser={handleDeleteUser}
                    onDenyUser={handleDenyUser}
                    channelPlatform={
                      selectedChannel.id.includes('.')
                        ? selectedChannel.id.split('.')[1]!
                        : selectedChannel.type
                    }
                  />
                ) : (
                  <div className="h-full flex items-center justify-center">
                    <div className="text-center">
                      <Send className="w-10 h-10 mx-auto text-text-muted dark:text-dark-text-muted mb-3" />
                      <p className="text-sm text-text-muted dark:text-dark-text-muted">
                        Selecione um canal para ver os detalhes
                      </p>
                    </div>
                  </div>
                )}
              </div>
            </div>
          )}
        </>
      )}

      {/* Setup modal */}
      {showSetup && (
        <ChannelSetupModal
          onClose={() => setShowSetup(false)}
          onSuccess={() => {
            setShowSetup(false);
            loadChannels();
          }}
        />
      )}
    </div>
  );
}
