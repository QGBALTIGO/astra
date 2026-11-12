# Astra — Diário de qualidade e evolução

## Objetivo

Registrar **cada envio confirmado pelo transporte** (WhatsApp, lembretes,
avisos e envios pelo serviço de canais) sem copiar novamente o conteúdo da
conversa. O diário não é treinamento contínuo dos pesos do modelo e não dá
permissão para o Astra alterar código ou colocar mudanças em produção.

## O que já existe

- `channel_messages`: conteúdo de conversas normais e respostas do Astra;
  deve continuar sendo a fonte de texto, sem criar uma segunda cópia.
- `messages`: histórico do agente e uso de ferramentas.
- `request_logs`: solicitações e uso, com retenção preexistente de 30 dias.
  Novos registros de solicitação deixam de duplicar o texto integral enviado
  pelo usuário; guardam somente a origem e número de caracteres.
- `provider_metrics`: tempos de modelo e custo já existentes.

## Novo diário (metadados; sem dados pessoais de texto)

`astra_outbound_quality_events`: uma linha por (canal, ID opaco retornado
pelo transporte), com horário UTC, tamanho da mensagem e indicadores locais.

`astra_outbound_quality_daily`: uma linha por canal, dia UTC e indicador
com a contagem acumulada, atualizada **atomicamente e somente uma vez** por
ID. Indicadores:

- `sent`: o transporte retornou um identificador não vazio; não prova leitura
  pelo destinatário e não substitui recibos de entrega.
- `legacy_error_banner`: texto antigo e pouco profissional.
- `technical_markup`: possíveis tags técnicas ou stack traces no texto.
- `generic_operation_menu`: resposta de operação em vez de ajuda natural.
- `empty_reply`: resposta vazia.

As regras geram **indícios para investigação**, nunca uma afirmação automática
de que um lançamento no banco estava errado.

Os identificadores de envio passam por um hash SHA-256 antes de serem salvos.
**Nenhum** número de telefone, texto original, conteúdo de áudio, chave Pix,
CPF, credencial, código de seis dígitos, dado financeiro pessoal ou argumento
de ferramenta entra nas novas tabelas. O texto é inspecionado apenas em
memória e descartado. A identidade do destinatário não é registrada nelas.

A captura ocorre somente _após_ confirmação de envio no transporte. Erros
de telemetria não bloqueiam a resposta ao usuário e **não geram reenvio**:
evita-se o problema do envio já entregue e do registro local ter falhado.
Mensagens longas divididas em segmentos são registradas por segmento.
Envios através de `ChannelService.send/broadcast` e a saída conversacional
são abrangidos, com chave única para evitar contagem duplicada.

## Retenção e capacidade

- Detalhes por envio: **14 dias**.
- Contadores agregados por dia: **180 dias**.
- Limpeza via processo noturno de retenção já existente.
- O uso de memória do processo não cresce com o histórico: a coleta é
  processada a cada envio, sem buffer de todas as mensagens em RAM.
- Sem chamadas a Groq, Gemini, OpenRouter ou Ollama para a coleta.

Consulta agregada interna:

```ts
const digest = await outboundQualityRepo.summary('channel.whatsapp', 30);
// { channelId, days, totalSent, flags, recommendations }
```

A consulta é **interna ao backend**, sem endpoint público. Não usar
`summary()` para liberar dados entre empresas/contas. Antes de criar uma UI
multiempresa, a consulta precisará ser vinculada à identidade autorizada de
cada conta; o ID do canal, sozinho, não comprova autorização.

## Como o Astra deve evoluir de maneira segura

1. Coletar sinais de qualidade e falhas sem exposição de dados.
2. Agregar indícios por dia e agrupar causas (fallback, vazamento técnico,
   interpretação de intenção, mensagens genéricas).
3. Reproduzir com cenários sintéticos no Astra Simulation & Reliability Lab.
4. Propor pequenas alterações em _pull requests_ revisáveis.
5. Exigir testes de segurança, banco, WhatsApp e regressão antes do merge.
6. Publicar com rollback somente após gates críticos, e avaliar novamente.

Não há **auto-edição, auto-merge ou treinamento com mensagens privadas**.
Para qualquer avaliação qualitativa usando texto real de usuários, primeiro
definir aviso de privacidade, base legal/consentimento apropriado, opt-out,
anonimização, acesso estrito e prazo de eliminação. Nunca enviar conversas
privadas para modelos externos por padrão.

## Reproduzir testes

```sh
pnpm --filter @ownpilot/gateway exec vitest run src/services/outbound-quality.test.ts
pnpm --filter @ownpilot/gateway exec vitest run src/channels/service-impl.test.ts src/services/middleware/audit.test.ts
pnpm --filter @ownpilot/gateway lint
pnpm format:check
```

Os testes unitários verificam ausência de texto pessoal no novo banco,
classificação, retenção e idempotência. A migração da tabela deve passar no
smoke PostgreSQL antes de qualquer implantação.
