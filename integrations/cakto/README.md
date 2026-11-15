# Integração Astra ↔ Cakto (webhook)

Servidor: Railway Function independente `astra-cakto-webhook` (Bun). Código em [railway-function.ts](./railway-function.ts). Esta função grava exclusivamente tabelas de faturamento `astra_cakto_*` e autorizações de WhatsApp existentes no PostgreSQL do Astra.

## Endereço

`https://webhook.astraacessor.pro/webhooks/cakto` (domínio próprio; serviço atualmente hospedado na Railway)

No painel Cakto, em **Integrações → Webhooks → Astra**, edite a URL, mantenha **Ativado**, o produto **Astra Acessor**, marque Pix gerado, Compra aprovada, Assinatura renovada, Assinatura recuperada, Reembolso, Chargeback, Assinatura cancelada, pausada e retomada; salve. A chave deve corresponder a `CAKTO_WEBHOOK_SECRET`. **Não** envie o webhook para a raiz do site nem o gateway principal. Apenas o endpoint com caminho `/webhooks/cakto` recebe os eventos.

## Variáveis (somente na Railway, nunca no Git)

- `CAKTO_WEBHOOK_SECRET`: segredo do webhook na Cakto, com permissão de leitura restrita
- `CAKTO_PRODUCT_NAME`: `Astra Acessor` (idealmente substituir por `CAKTO_PRODUCT_ID` após consultar o identificador no painel)
- `CAKTO_ACCESS_DAYS`: `30`
- `POSTGRES_HOST`, `POSTGRES_DB`, `POSTGRES_USER`, `POSTGRES_PASSWORD`, `POSTGRES_PORT`: referências privadas do serviço `astra-postgres`

## Regras

1. Validar `X-Cakto-Timestamp`, `X-Cakto-Signature` HMAC-SHA256 e o `secret` do corpo de forma segura antes de qualquer operação.
2. Aceitar somente o produto Astra, pedido principal e eventos `purchase_approved`, `subscription_renewed` ou `subscription_late_recovered` com `status=paid` e `paidAt` para conceder acesso a `data.customer.phone`, normalizado conforme a implementação do gateway.
3. Validade: 30 dias após pagamento. Quando expira, a própria verificação do gateway nega novas mensagens; eventos de reembolso, chargeback e cancelamento/pausa recalculam o acesso.
4. Idempotência por tipo de evento + ID do pedido, com transação e lock de telefone. Um pagamento repetido não acrescenta 30 dias novamente. Acesso manual existente não é substituído.
5. `pix_gerado`: registrar pedido em `astra_cakto_pending_pix` com ID, nome, telefone e e-mail do comprador, status `pending` e data da geração. Não liberar WhatsApp. Quando `purchase_approved` chegar, vincular a intenção à compra aprovada e marcar `paid`.
6. Ignorar boleto gerado, carrinho abandonado, produtos diferentes, upsells/order bumps e identidades inválidas.
7. Não transmitir CPF, e-mail, nome completo, telefone, códigos Pix ou corpo bruto nos logs de aplicação; guardar apenas o mínimo necessário em tabelas privadas.

## Validação

- `GET /health` retorna HTTP 200 e `pendingPixTracking: true` somente quando a função iniciou e as tabelas foram preparadas.
- `POST /webhooks/cakto` sem assinatura retorna HTTP 401, sem acesso ao banco.
- Um evento real de `pix_gerado`, corretamente assinado e do produto Astra, deve responder `{"received":true,"outcomes":["pending_recorded"]}` e gravar registro privado. Não autoriza cliente.
- O reenvio do mesmo evento deve retornar `duplicate`, sem duplicar dados ou conceder 30 dias.
- Testar evento real **após** configurar a URL na Cakto. O botão de teste da Cakto envia um produto fictício; o endpoint pode retornar `ignored_product`, sem liberar acesso — isto é intencional.
- Validar um pedido real aprovado com número de teste controlado; conferir `channel_users.access_source='cakto'`, `is_verified=true`, `access_expires_at`, primeiro acesso via WhatsApp e reenvio idempotente.
- Verificar renovação, reembolso, cancelamento, concorrência, erros e logs de entrega; nunca usar pagamentos de produção sintéticos para testar sem autorização e limpeza controlada.

## Limitações

A função não altera nem testa o checkout da Cakto nem reconfigura o webhook no painel. Eventos de `pix_gerado` recebidos antes desta correção (versão `astra-cakto-20261112-pix-pending-v2`) foram ignorados e **não podem ser recuperados pelo Astra**; consulte o payload no histórico da Cakto e, quando houver opção de reenvio autenticado, reenvie o evento. Para consultar os dados armazenados de novos Pix, use uma interface administrativa autenticada no banco; esta função não expõe endpoints públicos de leitura de dados pessoais. Eventos anteriores à troca da URL precisam ser reenviados pelo histórico Cakto. Sem evento real assinado e aprovado, **a ativação real ainda não foi validada ponta a ponta**. Não há migração em lote de assinantes anteriores.

Referência: https://docs.cakto.com.br/conceitos/webhooks

## Recuperação durável (v4)

O receptor autentica assinatura, timestamp e segredo antes de gravar uma cópia mínima criptografada (AES-256-GCM) no bucket privado `astra-cakto-inbox`. CPF, corpo bruto, código Pix e segredo não são persistidos nessa fila. A aplicação no banco e a exclusão do objeto só ocorrem após o commit; uma falha do banco retorna 202 com `queued:true`. Um worker em cron de 5 minutos reprocessa os objetos. A chave do objeto é opaca e a idempotência no banco protege reprocessamentos e recibos duplicados.

Use o mesmo arquivo da função para ambos os serviços. No receptor, deixe `CAKTO_INBOX_MODE` ausente. No worker, use `worker` e configure cron `*/5 * * * *` com política de reinício `NEVER`. O serviço temporário `astra-svg-preflight-temp` foi selecionado para ser reaproveitado como worker, evitando criar outro serviço. O modo `probe` valida escrita, leitura, autenticação da criptografia e exclusão de um objeto sintético, sem acessar tabelas de clientes.

Variáveis adicionais: `CAKTO_INBOX_KEY` (32 bytes hex, compartilhada e mantida para ler o backlog), `S3_ENDPOINT`, `S3_BUCKET`, `S3_REGION`, `S3_ACCESS_KEY_ID`, `S3_SECRET_ACCESS_KEY` (referências do bucket) e `S3_VIRTUAL_HOSTED_STYLE=true`. O worker referencia a configuração do receptor. Não rotacionar a chave enquanto houver backlog sem migração explícita.

O recebimento só é confirmado após uma gravação durável. Falha no armazenamento retorna 503 e exige alerta/reenvio, pois nenhuma infraestrutura elimina indisponibilidade simultânea de todos os destinos. Eventos retidos são mantidos e os logs do worker indicam contagens de processados/falhos, sem conteúdo pessoal. A rotina pagina até 1.000 objetos por execução; backlog maior continua na execução seguinte. O bucket não tem URL pública.

Testes: `node --test integrations/cakto/railway-function.test.mjs` cobre indisponibilidade do banco, reinício, integridade da criptografia, assinatura, falha do armazenamento e preservação de e-mail. Não cria pagamentos em produção.

### Validação com o runtime e banco reais

`bun test integrations/cakto/railway-function.test.mjs` também verifica o endereço gerado pelo cliente S3 nativo. No modo virtual-host, `S3_ENDPOINT` recebe o nome do bucket no hostname: informar só o endpoint regional faz o Bun consultar o bucket incorreto.

Com `ASTRA_REVIEW_PG_PORT`, `ASTRA_REVIEW_PG_PASSWORD` e, opcionalmente, `ASTRA_REVIEW_PG_USER`/`ASTRA_REVIEW_PG_DATABASE`, o mesmo comando executa a recuperação de um evento criptografado em PostgreSQL de teste na interface local. O teste cria um esquema exclusivo, usa os contratos reais das tabelas envolvidas e o remove ao terminar. Cobre concessão, duplicação, renovação, Pix sem pagamento, reembolso com outra compra vigente e revogação da última compra. A CI executa esse caso em seu PostgreSQL descartável.

Os parâmetros JSON são enviados com `tx.json(...)`: serializar o objeto previamente fazia o Bun gravar uma string JSON em vez de um objeto, impedindo a criação do aviso de acesso. Uma nova renovação também recupera os campos desse formato legado. Esses testes não simulam o checkout nem o envio final do aviso no WhatsApp de produção.
