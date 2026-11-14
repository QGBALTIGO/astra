import type { ToolDefinition } from '@ownpilot/core/tools';
import { customerWeather } from '../services/customer-weather.js';

export const CUSTOMER_WEATHER_TOOLS: ToolDefinition[] = [
  {
    name: 'get_local_weather',
    category: 'Weather',
    brief: 'Consultar temperatura e tempo na cidade do cliente',
    description:
      'Consulta clima, tempo, temperatura, calor, frio, chuva e weather reais. Sem city usa a cidade salva do próprio cliente. Se não houver cidade, retorna a pergunta necessária; nunca deduza a cidade pelo DDD, fuso ou endereço do administrador. Uma consulta em outra cidade não muda a preferência. A resposta é uma estimativa meteorológica para agora, não uma medição de estação. Não invente resultados.',
    parameters: {
      type: 'object',
      properties: {
        city: {
          type: 'string',
          description:
            'Cidade e estado ou país explicitamente informados pelo cliente ou verificados na memória. Omita para usar a preferência salva.',
        },
      },
    },
  },
  {
    name: 'set_weather_city',
    category: 'Weather',
    brief: 'Guardar a cidade informada para próximas consultas do tempo',
    description:
      'Salva ou atualiza a cidade de clima/temperatura do próprio cliente. Use quando a pessoa informar onde mora/está, pedir para mudar sua cidade, ou responder à pergunta sobre a cidade para consultar o tempo. Não salva endereço nem altera o fuso dos lembretes. Não use para buscas ocasionais sobre outra cidade ou situações fictícias. Depois consulte get_local_weather sem city se havia uma pergunta de temperatura pendente. Só confirme que guardou após saved=true.',
    parameters: {
      type: 'object',
      properties: {
        city: {
          type: 'string',
          description: 'Cidade e estado ou país informados pelo usuário, sem endereço.',
        },
      },
      required: ['city'],
    },
  },
];
export async function executeCustomerWeatherTool(
  name: string,
  args: Record<string, unknown>,
  userId = 'default'
) {
  try {
    if (!CUSTOMER_WEATHER_TOOLS.some((t) => t.name === name))
      throw new Error('Consulta indisponível.');
    if (name === 'set_weather_city' && typeof args.city !== 'string')
      throw new Error('Me diga sua cidade e o estado.');
    const result = await customerWeather(
      userId,
      typeof args.city === 'string' ? args.city : undefined,
      name === 'set_weather_city'
    );
    return { success: true, result };
  } catch (error) {
    // Provider bodies and internal configuration never enter the conversation.
    return {
      success: false,
      error:
        error instanceof Error &&
        /^(?:Me |Entre |Estou |O tempo|Não |A consulta|A previsão)/.test(error.message)
          ? error.message
          : 'Não consegui consultar o tempo agora. Tente novamente em instantes.',
    };
  }
}
