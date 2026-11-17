# Indicações do Astra — operação manual

O painel do participante usa registros reais no servidor. Não há dados de exemplo, saldo antecipado, aprovação automática ou transferência automática por Pix.

## Acesso da equipe

Entre na conta administrativa do Astra e abra `/api/v1/referrals-admin/console` no mesmo domínio. Essa tela exige uma sessão administrativa válida: a sessão do cliente e o acesso administrativo implícito sem autenticação não autorizam decisões financeiras.

A fila permite filtrar e paginar indicações aguardando validação, recompensas aprovadas, pedidos de Pix, pagamentos confirmados e recusas. As chaves Pix são criptografadas no banco e exibidas somente na revisão administrativa.

## Validar uma assinatura

1. Localize a indicação em **Aguardando validação**.
2. Confira o cliente indicado e a assinatura no sistema de vendas. É necessário um pagamento efetivamente confirmado; cobrança gerada, teste gratuito ou compra pendente não bastam.
3. Confira se é um novo cliente elegível. O vínculo inicial pelo convite é imutável; a integração específica do parceiro Júlio é preservada.
4. Selecione **Aprovar assinatura paga**, informe a referência única da assinatura/compra e uma justificativa clara. A justificativa aparece para o participante; não inclua dados pessoais de terceiros.
5. Confirme a conferência e registre a decisão.

O servidor define uma única recompensa em reais inteiros, de R$ 20 a R$ 100, com chance igual entre os 81 valores. Há no máximo cinco concessões por participante no mês da aprovação, no horário de São Paulo. A operação é serializada e auditada. Repetir a mesma referência na mesma indicação mantém a recompensa; a mesma compra não pode aprovar outra indicação.

Uma recusa deve informar o motivo. Uma recompensa aprovada ou solicitada pode ser anulada antes do pagamento em caso de reembolso, cancelamento ou irregularidade. A concessão anulada permanece na auditoria e continua contando no limite mensal. Um Pix já confirmado não pode ser apagado por essa ação.

## Realizar e confirmar um Pix

1. O participante solicita o pagamento de uma recompensa aprovada e informa uma chave Pix de sua titularidade.
2. Abra **Pix solicitado** na fila administrativa.
3. Confira novamente a elegibilidade da assinatura, o valor aprovado e a titularidade/destinatário da chave antes de transferir.
4. Realize o Pix no banco. O console não movimenta dinheiro.
5. Somente depois do Pix realizado, selecione **Confirmar Pix realizado**, informe a identificação única do comprovante e registre a confirmação.

O participante verá **Pagamento confirmado** apenas após essa etapa. O comprovante não pode ser reutilizado em outra indicação. Em caso de conexão interrompida, consulte o estado salvo antes de repetir: não realize um novo Pix para solucionar uma falha da tela. Uma repetição da confirmação com o mesmo comprovante é idempotente.

## Como o convite é identificado

Cada conta recebe no servidor um código público opaco e durável. O link abre o acesso oficial, registrando um token aleatório em cookie HttpOnly, Secure e SameSite=Lax, válido por 30 dias. Somente o hash do token fica no banco.

Depois de o convidado se cadastrar pelo WhatsApp e acessar o painel no mesmo navegador, a sessão autenticada associa o convite ao novo cliente. O servidor impede autoindicação, troca retroativa de indicador, cadastro anterior ao convite e sobreposição da indicação do parceiro Júlio. O primeiro convite válido é preservado. O painel do indicador não expõe o telefone, o e-mail ou o nome do convidado.

## Contratos técnicos

- Público: `GET /api/v1/customer/referrals/invite/:code` registra o primeiro convite e redireciona para o login oficial.
- Cliente autenticado: `GET /api/v1/customer/referrals?page=1`, `POST /claim` e `POST /:id/payout` sob o mesmo prefixo. As escritas exigem `X-Astra-Account` correspondente à sessão e a proteção de origem do portal.
- Administração autenticada: `GET /api/v1/referrals-admin?status=registered&page=1` e `POST /:id/review` com `action`, `reference` e `note`.
- Estados: `registered`, `approved`, `requested`, `paid`, `rejected`.
- Persistência: códigos, visitas opacas, atribuições, concessões, pedidos, comprovantes e auditoria em tabelas próprias. Não modifica as transações financeiras do cliente.
