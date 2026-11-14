/** Public navigation only; customer portal still requires an authenticated session. */
import type { ChannelOutgoingMessage } from '@ownpilot/core/channels';
import { ASTRA_CUSTOMER_ORIGIN, currentAstraPublicUrl } from '../config/astra-public-urls.js';
type DashboardAction = NonNullable<ChannelOutgoingMessage['urlButton']>;
export function weatherInfoAction(text: string, platform: string): DashboardAction | undefined {
  if (
    !['whatsapp', 'telegram'].includes(platform) ||
    !/🌤️ \*Tempo em [^\n]+\*/u.test(text) ||
    !/• \*Temperatura:\* [^\n]+°C · estimativa/u.test(text)
  )
    return undefined;
  return { label: 'Sobre o clima', url: ASTRA_CUSTOMER_ORIGIN + '/clima-fontes.html' };
}
function getOrigin(candidate: string | undefined): string {
  if (!candidate) return ASTRA_CUSTOMER_ORIGIN;
  try {
    const url = new URL(candidate);
    if (
      url.protocol !== 'https:' ||
      url.username ||
      url.password ||
      !url.hostname ||
      url.search ||
      url.hash
    )
      return ASTRA_CUSTOMER_ORIGIN;
    return new URL(currentAstraPublicUrl(url.origin + '/cliente')).origin;
  } catch {
    return ASTRA_CUSTOMER_ORIGIN;
  }
}
export function dashboardActionForConfirmedReply(
  text: string,
  userId: string,
  platform: string,
  configuredUrl = process.env.ASTRA_CUSTOMER_DASHBOARD_URL
): DashboardAction | undefined {
  if (platform !== 'whatsapp' || !userId.startsWith('whatsapp:')) return undefined;
  const origin = getOrigin(configuredUrl);
  if (/^⏳ \*Não consegui confirmar esse gasto\*/u.test(text))
    return { label: 'Conferir meus lançamentos', url: origin + '/cliente/transacoes' };
  if (
    /^(?:✅|⏳) \*(?:Entrada|Despesa|Valor a (?:pagar|receber)) (?:já )?(?:registrad[ao]|atualizad[ao])\*/u.test(
      text
    ) &&
    /(?:^|\n)• \*Valor:\* (?:R\$|[A-Z]{2,3}\$|€|£)/u.test(text)
  )
    return { label: 'Acompanhar no painel', url: origin + '/cliente/transacoes' };
  if (/^(?:✅|⏳) \*Lembrete (?:agendado|reagendado|registrado)\*/u.test(text))
    return { label: 'Ver minha agenda', url: origin + '/cliente/agenda' };
  if (/^✅ \*Tarefa (?:criada|atualizada|concluída)\*/u.test(text))
    return { label: 'Abrir meu painel', url: origin + '/cliente' };
  return undefined;
}
