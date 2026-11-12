/** Public navigation only; customer portal still requires an authenticated session. */
import type { ChannelOutgoingMessage } from '@ownpilot/core/channels';
type DashboardAction = NonNullable<ChannelOutgoingMessage['urlButton']>;
const ORIGIN = 'https://astra-gateway-production.up.railway.app';
function getOrigin(candidate: string | undefined): string {
  if (!candidate) return ORIGIN;
  try {
    const url = new URL(candidate);
    if (url.protocol !== 'https:' || url.username || url.password || !url.hostname || url.search || url.hash)
      return ORIGIN;
    return url.origin;
  } catch { return ORIGIN; }
}
export function dashboardActionForConfirmedReply(
  text: string, userId: string, platform: string,
  configuredUrl = process.env.ASTRA_CUSTOMER_DASHBOARD_URL
): DashboardAction | undefined {
  if (platform !== 'whatsapp' || !userId.startsWith('whatsapp:')) return undefined;
  const origin = getOrigin(configuredUrl);
  if (/^(?:✅|⏳) \*(?:Entrada|Despesa|Valor a (?:pagar|receber)) (?:já )?(?:registrad[ao]|atualizad[ao])\*/u.test(text) &&
      /(?:^|\n)• \*Valor:\* (?:R\$|[A-Z]{2,3}\$|€|£)/u.test(text))
    return { label: 'Acompanhar no painel', url: origin + '/cliente/transacoes' };
  if (/^(?:✅|⏳) \*Lembrete (?:agendado|reagendado|registrado)\*/u.test(text))
    return { label: 'Ver minha agenda', url: origin + '/cliente/agenda' };
  if (/^✅ \*Tarefa (?:criada|atualizada|concluída)\*/u.test(text))
    return { label: 'Abrir meu painel', url: origin + '/cliente' };
  return undefined;
}
