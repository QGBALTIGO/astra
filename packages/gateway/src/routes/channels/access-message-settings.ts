import { Hono } from 'hono';
import {
  getWhatsAppAccessMessageSettings,
  setWhatsAppAccessMessageSettings,
  whatsAppAccessMessageSettingsSchema,
} from '../../channels/channel-access-message-settings.js';
import { apiError, apiResponse, ERROR_CODES } from '../helpers.js';

// Mounted under channelAuthRoutes, after requireChannelAccessAdmin. Keeping the
// guard in the parent avoids a circular dependency on the auth route module.
export const whatsappAccessMessageSettingsRoutes = new Hono();

whatsappAccessMessageSettingsRoutes.get('/', async (c) =>
  apiResponse(c, { settings: await getWhatsAppAccessMessageSettings() })
);

whatsappAccessMessageSettingsRoutes.put('/', async (c) => {
  const parsed = whatsAppAccessMessageSettingsSchema.safeParse(
    await c.req.json().catch(() => null)
  );
  if (!parsed.success) {
    return apiError(
      c,
      {
        code: ERROR_CODES.INVALID_INPUT,
        message:
          'Informe o site HTTPS, o link de renovação HTTPS ou vazio e um fuso horário válido.',
      },
      400
    );
  }
  return apiResponse(c, { settings: await setWhatsAppAccessMessageSettings(parsed.data) });
});
