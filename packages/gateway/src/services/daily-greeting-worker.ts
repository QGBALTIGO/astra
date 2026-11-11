/**
 * At-most-once dispatch of persisted daily greetings. No AI call is required
 * at 6 AM; each day selects a different pre-vetted educational curiosity.
 */
import { getChannelService } from '@ownpilot/core/channels';
import { dailyGreetingsRepo } from '../db/repositories/daily-greetings.js';
import { customerAccountsRepo } from '../db/repositories/customer-accounts.js';
import { channelUsersRepo } from '../db/repositories/channels/users.js';
import { resolveCustomerPhone } from './customer-identity.js';
import { isChannelUserAccessActive } from '../channels/channel-access-service.js';
import { getOwnerUserId } from './pairing-service.js';
import { customerLocalDay } from './customer-date.js';
import { formatAstraMessage } from '../channels/response-presentation.js';
import { getLog } from './log.js';

const log = getLog('DailyGreetingWorker');
let timer: ReturnType<typeof setInterval> | null = null;
let running = false;

/** Offline and cost-free: do not promise a daily web search without a provider. */
export const DAILY_CURIOSITIES = [
  'Os polvos têm três corações.',
  'A luz do Sol leva cerca de 8 minutos e 20 segundos para chegar à Terra.',
  'As abelhas podem se comunicar por meio de uma dança.',
  'Os corais são animais, e não plantas.',
  'Saturno tem densidade média menor que a da água.',
  'O som não se propaga no vácuo.',
  'A Antártida é considerada o maior deserto da Terra.',
  'A Lua se afasta da Terra alguns centímetros a cada ano.',
  'O café é feito das sementes dos frutos do cafeeiro.',
  'Vênus demora mais para girar sobre si mesmo do que para dar uma volta no Sol.',
  'A Terra é levemente achatada nos polos.',
  'Os pinguins têm penas, assim como outras aves.',
  'Existem fungos capazes de produzir luz por bioluminescência.',
  'O lado da Lua que não vemos também recebe luz solar.',
  'A pele é o maior órgão do corpo humano.',
  'Uma estrela pode ter diferentes cores conforme sua temperatura.',
  'As auroras polares são causadas pela interação de partículas solares com a atmosfera.',
  'O arco-íris pode formar um círculo completo quando observado do alto.',
  'O planeta Júpiter completa uma rotação em menos de 10 horas.',
  'A neve pode formar cristais com simetria de seis lados.',
  'A água ferve a temperaturas menores em grandes altitudes.',
  'As bananas são classificadas botanicamente como bagas.',
  'Há montanhas submersas no fundo dos oceanos.',
  'O campo magnético da Terra ajuda a desviar partículas do vento solar.',
  'Os camaleões mudam de cor também para se comunicar.',
  'As baleias são mamíferos e precisam subir para respirar.',
  'A eletricidade dos relâmpagos pode aquecer o ar rapidamente.',
  'A maioria das estrelas visíveis no céu noturno pertence à Via Láctea.',
  'A gravidade faz as marés variarem ao longo do dia.',
  'A água cobre cerca de 71% da superfície terrestre.',
  'Borboletas percebem sabores também com receptores nas patas.',
] as const;

export function dailyGreetingText(localDay: string, withCuriosity: boolean): string {
  const ordinal = Math.floor(Date.parse(localDay + 'T12:00:00Z') / 86_400_000);
  const index =
    ((ordinal % DAILY_CURIOSITIES.length) + DAILY_CURIOSITIES.length) % DAILY_CURIOSITIES.length;
  return formatAstraMessage(
    '☀️ Bom dia!',
    withCuriosity ? [{ label: 'Curiosidade do dia', value: DAILY_CURIOSITIES[index]! }] : [],
    'Que hoje seja um ótimo dia para você! ✨'
  );
}

export async function dispatchDueDailyGreetings(): Promise<{
  claimed: number;
  delivered: number;
  failed: number;
}> {
  if (running) return { claimed: 0, delivered: 0, failed: 0 };
  running = true;
  let claimed = 0,
    delivered = 0,
    failed = 0;
  try {
    const entries = await dailyGreetingsRepo.claimDue(20);
    claimed = entries.length;
    for (const entry of entries) {
      try {
        const channels = getChannelService();
        const api = channels.getChannel(entry.channelPluginId);
        if (!api) {
          await dailyGreetingsRepo.deferNotSent(entry.id);
          continue;
        }
        if (api.getPlatform() !== 'whatsapp' || !entry.userId.startsWith('whatsapp:')) {
          await dailyGreetingsRepo.markFailed(entry.id, 'invalid_channel', true);
          failed++;
          continue;
        }
        const account = await customerAccountsRepo.getByDataUserId(entry.userId);
        const phone = account?.phoneNumber ?? entry.userId.slice('whatsapp:'.length);
        const recipient = entry.platformChatId.includes('@')
          ? entry.platformChatId.match(
              /^([1-9][0-9]{9,14})(?::[0-9]+)?@(?:s\.whatsapp\.net|c\.us)$/
            )?.[1]
          : entry.platformChatId.replace(/[^0-9]/g, '');
        const alias = account && recipient ? await resolveCustomerPhone(recipient) : null;
        const user = await channelUsersRepo.findByPlatform('whatsapp', phone);
        const ownerPhone = await getOwnerUserId('whatsapp');
        const isOwner =
          ownerPhone === phone && user?.isVerified && !user.isBlocked && user.status === 'active';
        if (
          (account ? alias?.accountId !== account.id : recipient !== phone) ||
          user?.ownpilotUserId !== 'whatsapp:' + phone ||
          (!isOwner && !isChannelUserAccessActive(user))
        ) {
          await dailyGreetingsRepo.markFailed(entry.id, 'channel_access_inactive', true);
          failed++;
          continue;
        }
        if (api.getStatus() !== 'connected') {
          await dailyGreetingsRepo.deferNotSent(entry.id);
          continue;
        }
        const localDay = customerLocalDay(new Date(), entry.timeZone);
        const receipt = await channels.send(entry.channelPluginId, {
          platformChatId: phone,
          text: dailyGreetingText(localDay, entry.withCuriosity),
        });
        if (typeof receipt !== 'string' || !receipt.trim()) {
          // The transport may have sent it. No retry after an ambiguous receipt.
          await dailyGreetingsRepo.markFailed(entry.id, 'delivery_receipt_missing');
          failed++;
          continue;
        }
        await dailyGreetingsRepo.markDelivered(entry.id, receipt);
        delivered++;
      } catch (error) {
        failed++;
        await dailyGreetingsRepo.markFailed(
          entry.id,
          error instanceof Error ? error.name : 'delivery_error'
        );
        log.warn('Falha no envio da rotina diária', {
          category: error instanceof Error ? error.name : 'unknown',
        });
      }
    }
  } catch (error) {
    log.error('Falha na consulta das rotinas diárias', {
      category: error instanceof Error ? error.name : 'unknown',
    });
  } finally {
    running = false;
  }
  return { claimed, delivered, failed };
}

export function startDailyGreetingWorker(): void {
  if (timer) return;
  void dispatchDueDailyGreetings();
  timer = setInterval(() => void dispatchDueDailyGreetings(), 15_000);
  timer.unref?.();
  log.info('Rotinas diárias iniciadas (15 segundos)');
}

export function stopDailyGreetingWorker(): void {
  if (timer) clearInterval(timer);
  timer = null;
}
