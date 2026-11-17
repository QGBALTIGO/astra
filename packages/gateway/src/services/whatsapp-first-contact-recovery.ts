/** A named, expiring operator request; never scan contacts or fabricate inbound messages. */
import { z } from 'zod';
import { getChannelService, type IChannelService } from '@ownpilot/core/channels';
import { whatsAppTrialsRepo } from '../db/repositories/whatsapp-trials.js';
import { whatsappPhoneSpellings } from '../channels/whatsapp-phone.js';
import { getOwnerUserId } from './pairing-service.js';
import { getLog } from './log.js';

const log = getLog('WhatsAppFirstContactRecovery');
const requestSchema = z
  .object({
    requestId: z.string().regex(/^[A-Za-z0-9_-]{8,80}$/),
    phone: z.string().regex(/^[1-9]\d{9,14}$/),
    expiresAt: z.string().datetime({ offset: true }),
  })
  .strict();
interface Dependencies {
  readRequest: () => string | undefined;
  enabled: () => boolean;
  channels: () => Pick<IChannelService, 'listChannels' | 'getChannel'>;
  owner: () => Promise<string | null>;
  recover: typeof whatsAppTrialsRepo.recoverFirstContactTrial;
  now: () => Date;
}
export function createWhatsAppFirstContactRecovery(overrides: Partial<Dependencies> = {}) {
  const d: Dependencies = {
    readRequest: () => process.env.ASTRA_WHATSAPP_FIRST_CONTACT_RECOVERY,
    enabled: () => process.env.ASTRA_WHATSAPP_MULTIUSER === 'true',
    channels: getChannelService,
    owner: () => getOwnerUserId('whatsapp'),
    recover: (input) => whatsAppTrialsRepo.recoverFirstContactTrial(input),
    now: () => new Date(),
    ...overrides,
  };
  let running = false;
  let completedRequest: string | undefined;
  return async (): Promise<'disabled' | 'invalid' | 'deferred' | 'queued' | 'skipped'> => {
    const raw = d.readRequest();
    if (!raw || !d.enabled()) return 'disabled';
    if (completedRequest === raw) return 'skipped';
    if (running) return 'deferred';
    let request: z.infer<typeof requestSchema>;
    try {
      if (raw.length > 1024) return 'invalid';
      request = requestSchema.parse(JSON.parse(raw));
    } catch {
      return 'invalid';
    }
    const validTime = () => {
      const remaining = Date.parse(request.expiresAt) - d.now().getTime();
      return remaining > 0 && remaining <= 86_400_000;
    };
    if (!validTime()) return 'invalid';
    running = true;
    try {
      const channels = d.channels();
      const connected = channels
        .listChannels()
        .filter((c) => c.platform === 'whatsapp' && c.status === 'connected');
      if (connected.length !== 1) return 'deferred';
      const channelId = connected[0]!.pluginId;
      const api = channels.getChannel(channelId);
      const botPhone = api?.getBotInfo?.()?.username;
      if (
        !api?.resolveWhatsAppRecipient ||
        api.getPlatform() !== 'whatsapp' ||
        api.getStatus() !== 'connected' ||
        !botPhone ||
        !/^[1-9]\d{9,14}$/.test(botPhone)
      )
        return 'deferred';
      const candidates = whatsappPhoneSpellings(request.phone);
      const owner = await d.owner();
      if (candidates.includes(botPhone) || (owner && candidates.includes(owner))) {
        completedRequest = raw;
        return 'skipped';
      }
      const recipient = await api.resolveWhatsAppRecipient(request.phone);
      if (!recipient || !candidates.includes(recipient)) return 'deferred';
      const stillConnected = channels
        .listChannels()
        .filter((c) => c.platform === 'whatsapp' && c.status === 'connected');
      if (
        stillConnected.length !== 1 ||
        stillConnected[0]!.pluginId !== channelId ||
        !d.enabled() ||
        d.readRequest() !== raw ||
        !validTime() ||
        channels.getChannel(channelId) !== api ||
        api.getStatus() !== 'connected' ||
        api.getBotInfo?.()?.username !== botPhone
      )
        return 'deferred';
      const result = await d.recover({ requestId: request.requestId, phone: recipient, botPhone });
      completedRequest = raw;
      log.info('Recuperação nominal de primeiro contato avaliada', {
        requestId: request.requestId,
        outcome: result.outcome,
        reason: result.reason,
      });
      return result.outcome;
    } catch {
      // No manual send. A lost commit response is resolved by the trial/notice ledger.
      log.warn('Recuperação de primeiro contato adiada; nenhum reenvio manual');
      return 'deferred';
    } finally {
      running = false;
    }
  };
}
export const recoverWhatsAppFirstContact = createWhatsAppFirstContactRecovery();
