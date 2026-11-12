# Integração Astra ↔ Cakto (webhook)
 
Servidor: Railway Function independente `astra-cakto-webhook` (Bun). Código em [railway-function.ts](./railway-function.ts). Esta função grava exclusivamente tabelas de faturamento `astra_cakto_*` e autorizações de WhatsApp existentes no PostgreSQL do Astra.
 
## Endereço
`https://astra-cakto-webhook-production.up.railway.app/webhooks/cakto`
 
No painel Cakto, em **Integrações → Webhooks → Astra**, edite a URL, mantenha **Ativado**, o produto **Astra Acessor**, marque Compra aprovada, Assinatura renovada, Assinatura recuperada, Reembolso, Chargeback, Assinatura cancelada, pausada e retomada; salve. A chave deve corresponder a `CAKTO_WEBHOOK_SECRET`. **Não** envie o webhook para a raiz do site nem o gateway principal. Apenas o endpoint com caminho `/webhooks/cakto` recebe os eventos.
 
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
5. Ignorar eventos pendentes (Pix/boleto gerado, carrinho abandonado), produtos diferentes, upsells/order bumps e identidades inválidas.
6. Não transmitir CPF, e-mail, outros detalhes do pagamento ou corpo bruto nos logs de aplicação.
 
## Validação
- `GET /health` retorna HTTP 200 somente quando a função iniciou e suas tabelas foram preparadas.
- `POST /webhooks/cakto` sem assinatura retorna HTTP 401, sem acesso ao banco.
- Testar evento real **após** configurar a URL na Cakto. O botão de teste da Cakto envia um produto fictício; o endpoint pode retornar `ignored_product`, sem liberar acesso — isto é intencional.
- Validar um pedido real aprovado com número de teste controlado; conferir `channel_users.access_source='cakto'`, `is_verified=true`, `access_expires_at`, primeiro acesso via WhatsApp e reenvio idempotente.
- Verificar renovação, reembolso, cancelamento, concorrência, erros e logs de entrega; nunca usar pagamentos de produção sintéticos para testar sem autorização e limpeza controlada.
 
## Limitações
A função não altera nem testa o checkout da Cakto nem reconfigura o webhook no painel. Eventos anteriores à troca da URL precisam ser reenviados pelo histórico Cakto. Sem evento real assinado e aprovado, **a ativação real ainda não foi validada ponta a ponta**. Não há migração em lote de assinantes anteriores.
 
Referência: https://docs.cakto.com.br/conceitos/webhooks
