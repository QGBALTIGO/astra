import { useEffect, useRef, useState } from 'react';
import { channelsApi } from '../api/endpoints/misc';
import type { ChannelUser } from '../api/types/channels';
import { useDialog } from '../components/ConfirmDialog';
import { useToast } from '../components/ToastProvider';
import {
  AlertTriangle,
  Clock,
  Plus,
  RefreshCw,
  Shield,
  ShieldAlert,
  ShieldCheck,
  Trash2,
  Unlock,
  Users,
} from '../components/icons';
import {
  formatAccessExpiry,
  formatWhatsAppPhone,
  getWhatsAppAccessState,
  isProtectedChannelUser,
  type WhatsAppAccessState,
} from './channels-access-helpers';
import { timeAgo } from './channels-helpers';
import { WhatsAppAuthorizeModal } from './channels-whatsapp-access-modal';

const ACCESS_STATES: Record<WhatsAppAccessState, { label: string; color: string }> = {
  active: { label: 'Autorizado', color: 'bg-success/10 text-success' },
  pending: { label: 'Pendente', color: 'bg-warning/10 text-warning' },
  expired: { label: 'Expirado', color: 'bg-warning/10 text-warning' },
  revoked: {
    label: 'Revogado',
    color: 'bg-bg-tertiary text-text-muted dark:bg-dark-bg-tertiary dark:text-dark-text-muted',
  },
  blocked: { label: 'Bloqueado', color: 'bg-error/10 text-error' },
};

const actionClass =
  'inline-flex min-h-9 items-center justify-center gap-1.5 rounded-lg border border-border px-2.5 py-1.5 text-xs font-medium text-text-secondary transition-colors hover:bg-bg-tertiary disabled:opacity-50 dark:border-dark-border dark:text-dark-text-secondary dark:hover:bg-dark-bg-tertiary';

interface WhatsAppAccessPanelProps {
  users: ChannelUser[];
  isLoading: boolean;
  hasMore?: boolean;
  isLoadingMore?: boolean;
  onLoadMore?: () => void;
  onChanged: () => void;
  onBlockUser: (userId: string) => void;
  onUnblockUser: (userId: string) => void;
  onDeleteUser: (userId: string) => void;
}

export function WhatsAppAccessPanel({
  users,
  isLoading,
  hasMore = false,
  isLoadingMore = false,
  onLoadMore,
  onChanged,
  onBlockUser,
  onUnblockUser,
  onDeleteUser,
}: WhatsAppAccessPanelProps) {
  const { confirm } = useDialog();
  const toast = useToast();
  const [authorization, setAuthorization] = useState<{ user?: ChannelUser } | null>(null);
  const [busyAction, setBusyAction] = useState<{ id: string; action: 'renew' | 'revoke' } | null>(
    null
  );
  const [actionError, setActionError] = useState<{ id: string; message: string } | null>(null);
  const actionRef = useRef(false);
  const [clockRevision, refreshClock] = useState(0);
  const now = Date.now();
  let nextExpiry = Infinity;
  for (const user of users) {
    if (isProtectedChannelUser(user) || !user.accessExpiresAt) continue;
    const expiry = Date.parse(user.accessExpiresAt);
    if (expiry > now && expiry < nextExpiry) nextExpiry = expiry;
  }

  // Update a visible authorization at its expiry even without a new channel message.
  useEffect(() => {
    if (!Number.isFinite(nextExpiry)) return;
    const timer = setTimeout(
      () => refreshClock((value) => value + 1),
      Math.min(Math.max(0, nextExpiry - Date.now()) + 10, 2_147_483_647)
    );
    return () => clearTimeout(timer);
  }, [nextExpiry, clockRevision]);

  const handleAccessAction = async (user: ChannelUser, action: 'renew' | 'revoke') => {
    if (actionRef.current || isProtectedChannelUser(user)) return;
    actionRef.current = true;
    try {
      const phone = formatWhatsAppPhone(user.platformUserId);
      const confirmed = await confirm(
        action === 'renew'
          ? {
              title: 'Renovar acesso por 30 dias',
              message:
                'Renovar o acesso de ' +
                phone +
                '? Se ainda estiver válido, os 30 dias serão somados ao prazo atual. Se já venceu, o novo prazo começa agora.',
              confirmText: 'Renovar 30 dias',
              cancelText: 'Cancelar',
            }
          : {
              title: 'Revogar acesso',
              message:
                'Revogar o acesso de ' +
                phone +
                '? Este número deixará de usar o Astra. O histórico e os registros serão preservados.',
              confirmText: 'Revogar acesso',
              cancelText: 'Cancelar',
              variant: 'danger',
            }
      );
      if (!confirmed) return;
      setBusyAction({ id: user.id, action });
      setActionError(null);
      if (action === 'renew') {
        await channelsApi.renewUserAccess(user.id, 30);
        toast.success('Acesso renovado por 30 dias');
      } else {
        await channelsApi.revokeUserAccess(user.id);
        toast.success('Acesso revogado');
      }
      onChanged();
    } catch (error) {
      setActionError({
        id: user.id,
        message:
          error instanceof Error
            ? error.message
            : 'Não foi possível atualizar o acesso. Tente novamente.',
      });
    } finally {
      actionRef.current = false;
      setBusyAction(null);
    }
  };

  return (
    <section aria-label="Acesso ao WhatsApp" className="space-y-3">
      <div className="flex flex-col gap-3 sm:flex-row sm:flex-wrap sm:items-start sm:justify-between">
        <div className="min-w-0">
          <h3 className="flex items-center gap-2 text-sm font-semibold text-text-primary dark:text-dark-text-primary">
            <Users className="h-4 w-4 text-text-muted dark:text-dark-text-muted" />
            Acesso ao WhatsApp
          </h3>
          <p className="mt-1 max-w-md text-xs leading-relaxed text-text-muted dark:text-dark-text-muted">
            Autorize quem pode conversar com o Astra e acompanhe a validade.
          </p>
        </div>
        <button
          type="button"
          onClick={() => setAuthorization({})}
          disabled={Boolean(busyAction)}
          className="inline-flex min-h-10 shrink-0 items-center justify-center gap-2 rounded-lg bg-primary px-3 py-2 text-sm font-semibold text-white transition-colors hover:bg-primary-dark disabled:opacity-50"
        >
          <Plus className="h-4 w-4" />
          Autorizar número
        </button>
      </div>

      {isLoading ? (
        <div className="rounded-xl border border-border p-4 dark:border-dark-border">
          <p role="status" className="text-sm text-text-muted dark:text-dark-text-muted">
            Carregando acessos…
          </p>
        </div>
      ) : users.length === 0 ? (
        <div className="rounded-xl border border-dashed border-border bg-bg-secondary/50 p-5 dark:border-dark-border dark:bg-dark-bg-secondary/50">
          <div className="flex items-start gap-3">
            <Shield className="mt-0.5 h-5 w-5 shrink-0 text-text-muted dark:text-dark-text-muted" />
            <div>
              <p className="text-sm font-medium text-text-primary dark:text-dark-text-primary">
                Nenhum número cadastrado ainda
              </p>
              <p className="mt-1 text-xs leading-relaxed text-text-muted dark:text-dark-text-muted">
                Use Autorizar número para liberar o acesso. O contato aparecerá aqui mesmo antes de
                enviar uma mensagem.
              </p>
            </div>
          </div>
        </div>
      ) : (
        <ul className="divide-y divide-border overflow-hidden rounded-xl border border-border dark:divide-dark-border dark:border-dark-border">
          {users.map((user) => {
            const state = getWhatsAppAccessState(user, now);
            const badge = ACCESS_STATES[state];
            const protectedUser = isProtectedChannelUser(user);
            const phone = formatWhatsAppPhone(user.platformUserId);
            const expiry = formatAccessExpiry(user.accessExpiresAt);
            const canRenew =
              !protectedUser &&
              (state === 'expired' || (state === 'active' && Boolean(user.accessExpiresAt)));
            const canRevoke = !protectedUser && (state === 'active' || state === 'expired');
            const canAuthorize = !protectedUser && (state === 'pending' || state === 'revoked');
            const disabled = Boolean(busyAction);
            const busy = busyAction?.id === user.id;
            return (
              <li key={user.id} className="space-y-3 p-3 sm:p-4">
                <div className="flex flex-col gap-2 sm:flex-row sm:items-start sm:justify-between">
                  <div className="min-w-0">
                    <p className="break-words text-sm font-semibold text-text-primary dark:text-dark-text-primary">
                      {user.displayName || phone}
                    </p>
                    {user.displayName ? (
                      <p className="mt-0.5 break-words text-xs text-text-muted dark:text-dark-text-muted">
                        {phone}
                      </p>
                    ) : null}
                  </div>
                  <div className="flex shrink-0 flex-wrap items-center gap-1.5">
                    {protectedUser ? (
                      <span className="inline-flex items-center gap-1 rounded-md bg-primary/10 px-2 py-1 text-[11px] font-medium text-primary">
                        <Shield className="h-3 w-3" /> Proprietário
                      </span>
                    ) : null}
                    <span
                      className={
                        'inline-flex items-center gap-1 rounded-md px-2 py-1 text-[11px] font-medium ' +
                        badge.color
                      }
                    >
                      {state === 'active' ? (
                        <ShieldCheck className="h-3 w-3" />
                      ) : state === 'blocked' ? (
                        <AlertTriangle className="h-3 w-3" />
                      ) : (
                        <Clock className="h-3 w-3" />
                      )}
                      {badge.label}
                    </span>
                  </div>
                </div>

                <div className="flex flex-col gap-1 text-xs text-text-muted dark:text-dark-text-muted sm:flex-row sm:flex-wrap sm:gap-x-4">
                  <p>
                    <span className="font-medium">Validade: </span>
                    {protectedUser ? (
                      'Acesso de proprietário'
                    ) : expiry ? (
                      <time dateTime={user.accessExpiresAt ?? undefined}>{expiry}</time>
                    ) : state === 'pending' ? (
                      'Aguardando autorização'
                    ) : (
                      'Sem vencimento'
                    )}
                  </p>
                  <p>
                    {user.hasInteracted === false
                      ? 'Ainda não conversou'
                      : 'Última atividade: ' + timeAgo(user.lastSeenAt)}
                  </p>
                </div>

                {!protectedUser ? (
                  <div className="flex flex-wrap items-center gap-2">
                    {canAuthorize ? (
                      <button
                        type="button"
                        onClick={() => setAuthorization({ user })}
                        disabled={disabled}
                        className={actionClass}
                        aria-label={'Autorizar ' + phone}
                      >
                        <ShieldCheck className="h-3.5 w-3.5 text-success" /> Autorizar
                      </button>
                    ) : null}
                    {canRenew ? (
                      <button
                        type="button"
                        onClick={() => void handleAccessAction(user, 'renew')}
                        disabled={disabled}
                        className={actionClass}
                        aria-label={'Renovar acesso por 30 dias para ' + phone}
                      >
                        <RefreshCw className="h-3.5 w-3.5" />
                        {busy && busyAction.action === 'renew' ? 'Renovando…' : 'Renovar 30 dias'}
                      </button>
                    ) : null}
                    {canRevoke ? (
                      <button
                        type="button"
                        onClick={() => void handleAccessAction(user, 'revoke')}
                        disabled={disabled}
                        className={actionClass}
                        aria-label={'Revogar acesso de ' + phone}
                      >
                        <ShieldAlert className="h-3.5 w-3.5 text-error" />
                        {busy && busyAction.action === 'revoke' ? 'Revogando…' : 'Revogar'}
                      </button>
                    ) : null}
                    {state === 'blocked' ? (
                      <button
                        type="button"
                        onClick={() => onUnblockUser(user.id)}
                        disabled={disabled}
                        className={actionClass}
                        aria-label={'Desbloquear ' + phone}
                      >
                        <Unlock className="h-3.5 w-3.5" /> Desbloquear
                      </button>
                    ) : (
                      <button
                        type="button"
                        onClick={() => onBlockUser(user.id)}
                        disabled={disabled}
                        className={actionClass}
                        aria-label={'Bloquear ' + phone}
                      >
                        <ShieldAlert className="h-3.5 w-3.5" /> Bloquear
                      </button>
                    )}
                    <button
                      type="button"
                      onClick={() => onDeleteUser(user.id)}
                      disabled={disabled}
                      className={actionClass}
                      aria-label={'Excluir ' + phone}
                    >
                      <Trash2 className="h-3.5 w-3.5" /> Excluir
                    </button>
                  </div>
                ) : null}
                {busy ? (
                  <p role="status" className="text-xs text-text-muted dark:text-dark-text-muted">
                    Atualizando acesso…
                  </p>
                ) : null}
                {actionError?.id === user.id ? (
                  <p role="alert" className="rounded-lg bg-error/5 p-2 text-xs text-error">
                    {actionError.message}
                  </p>
                ) : null}
              </li>
            );
          })}
        </ul>
      )}

      {hasMore && onLoadMore ? (
        <div className="space-y-2">
          <button
            type="button"
            onClick={onLoadMore}
            disabled={isLoading || isLoadingMore || Boolean(busyAction)}
            aria-busy={isLoadingMore}
            className="inline-flex min-h-11 w-full items-center justify-center gap-2 rounded-lg border border-border px-4 py-2 text-sm font-medium text-text-secondary transition-colors hover:bg-bg-secondary disabled:opacity-50 dark:border-dark-border dark:text-dark-text-secondary dark:hover:bg-dark-bg-secondary"
          >
            <Plus className="h-4 w-4" />
            {isLoadingMore ? 'Carregando mais números…' : 'Carregar mais números'}
          </button>
          {isLoadingMore ? (
            <p
              role="status"
              className="text-center text-xs text-text-muted dark:text-dark-text-muted"
            >
              Seus números continuam visíveis enquanto buscamos a próxima página.
            </p>
          ) : null}
        </div>
      ) : null}

      {authorization ? (
        <WhatsAppAuthorizeModal
          user={authorization.user}
          onClose={() => setAuthorization(null)}
          onAuthorized={() => {
            toast.success('Número autorizado no WhatsApp');
            onChanged();
          }}
        />
      ) : null}
    </section>
  );
}
