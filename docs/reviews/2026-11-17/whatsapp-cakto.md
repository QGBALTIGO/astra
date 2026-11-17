# Astra — revisão de WhatsApp, teste grátis e Cakto

Data: 17/11/2026. Frente integrante da revisão de liberação de membros.

## Versão e alcance

- Base revisada: `7915ecdd9933b55183b511f5718030b1d34e5304`.
- Branch: `audit/member-readiness-20261117`.
- As correções desta frente estão na árvore de trabalho da candidata. O commit final, a versão publicada e o parecer integrado são registrados em `docs/ASTRA_MEMBER_READINESS_2026-11-17.md`.
- Release da função Cakto candidata: `astra-cakto-20261117-member-readiness-v6`.
- Nenhum pagamento, destinatário real, dado de produção ou configuração de produção foi alterado por esta frente.
- Fonte comercial usada: implementação atual, documentação do repositório e decisões confirmadas pela coordenação. Não se alterou o cálculo Cakto de `paidAt + 30 dias`.

Arquivos alterados nesta frente:

- `integrations/cakto/railway-function.ts`
- `integrations/cakto/railway-function.test.mjs`
- `integrations/cakto/README.md`
- `packages/gateway/src/channels/service-impl.ts`
- `packages/gateway/src/channels/service-impl.test.ts`
- `packages/gateway/src/server.ts` — somente o trecho de encerramento dos canais e a antecipação da parada dos workers de mensagens.

## Ambiente e grau de integração

Os testes usaram dados fictícios, Node, pnpm 10.29.3, Vitest 4.1.10, Bun 1.4.4 e PostgreSQL 16.4 descartável. Cada execução PostgreSQL criou um cluster local novo e cada suíte criou seu próprio esquema. O encerramento removeu os esquemas e clusters de teste. Nenhuma conexão usou banco de produção.

O executor não compartilhou o `localhost` entre comandos independentes; tentativas iniciais de usar a porta 55441 falharam com `ECONNREFUSED`. Isso foi resolvido iniciando PostgreSQL e testes no mesmo comando, com porta dinâmica. Essas falhas de preparação não foram apresentadas como falhas do Astra nem como testes aprovados.

| Componente                           | O que foi executado                                                                                      | Limite da evidência                                                                |
| ------------------------------------ | -------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------- |
| Banco de trials e diretório WhatsApp | SQL, locks, transações e tabelas reais no PostgreSQL descartável                                         | Não é o banco publicado; migração completa/pgvector pertence à validação integrada |
| Função Cakto                         | Código real da função, HMAC com segredo fictício, runtime Bun e caso integrado com PostgreSQL real       | Requisições construídas localmente; nenhum evento veio da plataforma Cakto         |
| Inbox Cakto                          | Criptografia real, adulteração, falhas controladas, novo processo lógico de worker e efeitos persistidos | Armazenamento S3 simulado em memória; não houve probe no bucket publicado          |
| Endereçamento S3                     | Cliente S3 nativo do Bun gerou o endereço do bucket esperado                                             | Não houve tráfego de leitura/gravação em S3 real                                   |
| WhatsApp                             | Fluxo de serviço, normalização, geração de recibos, concorrência e ciclo de conexão em testes existentes | Baileys/socket, IA e envio são simulados; não comprova entrega a um telefone       |
| Encerramento                         | Drenagem de turnos, limite, falhas de adaptador e espera de credenciais em testes                        | Não foi executado SIGTERM do aplicativo completo conectado ao WhatsApp real        |

## Inventário e caminho efetivamente implementado

### Recebimento e execução

`WhatsAppChannelAPI` admite eventos `messages.upsert` de mensagens utilizáveis, resolve identificadores do provedor e aplica os controles de contato, grupo e conta conectada. Uma proteção em memória evita concorrência de eventos repetidos no transporte. Conteúdos históricos alimentam o diretório/histórico sem executar comandos antigos. Anexos passam pelo armazenamento e normalização revisados na frente de dados.

`ChannelServiceImpl` resolve grafias telefônicas somente com confirmação do transporte, identifica o usuário, verifica acesso e obtém a identidade de dados pelo serviço de contas. Conversas privadas do WhatsApp são serializadas por canal, conversa e remetente. A gravação `ChannelMessagesRepository.createIfNew` usa `ON CONFLICT (id) DO NOTHING`; mensagens já gravadas não passam novamente para IA e ferramentas. A conversa e o agente recebem o `dataUserId` determinado no servidor. O roteamento aplica nova checagem de acesso após aguardar a fila e antes de devolver a resposta.

Os recibos das ferramentas e os módulos `receipt-state`/`response-safety` distinguem gravações confirmadas, consultas e operações rejeitadas. Um recibo de gravação sem ID e uma falha escondida por sucesso de operação diferente não são tratados como confirmação. A resposta não recebe o corpo técnico do erro do provedor. Os testes de falhas financeiras orientam a conferir o dado salvo antes de repetir uma escrita cujo resultado é incerto.

O ID retornado por `sendMessage` confirma o resultado do adaptador de transporte. Não foi encontrado consumidor de `message-receipt.update`/ACK final do aparelho neste adaptador. Portanto, “respondido/transportado” não deve ser interpretado como leitura ou entrega final confirmada ao membro.

### Teste grátis e acesso

A concessão implementada dura 72 horas e usa transação, locks nas grafias telefônicas e claims persistentes. Antes de conceder, verifica usuário, conta/alias, claim anterior, histórico, sessão, anexo e avisos anteriores. A concessão e os avisos duráveis são gravados juntos. Uma recuperação administrativa de primeiro contato é separada e exige critérios explícitos; não deve ser usada para conceder teste novo indiscriminadamente a antigos contatos.

Os 52 testes PostgreSQL existentes de trials foram executados. Incluem concorrência, identidade preexistente, impedimentos, persistência dos claims, boas-vindas, expiração e recuperação das etapas recuperáveis dos avisos. Os quatro testes PostgreSQL do diretório também passaram. A frente de autenticação/painel valida a política de consulta/exportação após expiração; esta frente não declarou esse fluxo web como validado.

### Pagamentos

O receptor Cakto é uma função Bun independente do gateway. Valida `X-Cakto-Timestamp`, HMAC sobre os bytes do corpo e `secret` do corpo; filtra produto e pedido principal; exige `status=paid` e `paidAt` para conceder acesso. Pix gerado apenas registra a intenção. O código não inicia cobrança nem cria assinatura automaticamente durante trial.

Antes de acessar o banco, grava um registro mínimo criptografado em `pending/v1/`. A transação no PostgreSQL mantém ledger de eventos/pedidos/assinaturas, autorização WhatsApp e aviso durável. A falha de banco mantém o objeto e responde 202. Um worker independente reprocessa o backlog. Falha de entrega de aviso não desfaz o reconhecimento do pagamento.

A idempotência de pagamentos/Pix/reversões é por tipo de evento e ID de pedido. A candidata também serializa por pedido, assinatura quando aplicável e telefone, preserva estados terminais de reembolso/chargeback e conserva eventos `held_*` criptografados para conciliação. Estados mutáveis da assinatura usam também sua data original no corpo assinado para distinguir transições repetidas. Nenhuma identificação é inferida por nome ou e-mail.

Referência oficial consultada: [Webhooks — Cakto](https://docs.cakto.com.br/conceitos/webhooks). Foram conferidos HMAC/timestamp, corpo original, segredo, identidade de pedido, eventos e limitações de reenvio. Os testes locais não comprovam que o checkout e o painel Cakto publicados estejam configurados de acordo com essa documentação.

## Problemas confirmados e correções

| ID     | Gravidade e impacto demonstrado                                                                     | Antes                                                                                                                                                                                | Correção e validação                                                                                                                                                                                                                                                                            |
| ------ | --------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| CKT-01 | P1 — evento de pagamento autenticado sem associação válida podia perder sua única cópia recuperável | `processStored` removia o objeto mesmo quando o resultado era `held_*`, inclusive antes de qualquer gravação de identidade no banco                                                  | Registros retidos vão para `held/v1/` com motivo, criptografados. O pending só é excluído depois. Dois testes falharam antes: objeto esperado 1/obtido 0; status esperado 202/obtido 200 na falha da retenção. Passaram após a correção                                                         |
| CKT-02 | P1 — reembolso podia ser revertido por aprovação atrasada do mesmo pedido                           | Após refund e approval com mesmo timestamp milissegundo, o banco ficou `paid`, com acesso concedido                                                                                  | `refunded` e `chargedback` são terminais para aquele pedido. Teste real reproduziu `paid !== refunded`; a candidata passou refund/chargeback com datas iguais e mais recentes, os três eventos de concessão, Pix coerente, ausência de aviso indevido e nova compra com outro pedido            |
| CKT-03 | P1 — conflito de associação simultâneo podia ser descartado sem conciliação                         | Locks apenas por telefone deixavam dois eventos diferentes do mesmo pedido consultar ausência simultaneamente; segundo retornava `no_active_payment` em vez de `held_order_conflict` | Lock de pedido antes de telefone em ambos os caminhos. Teste PostgreSQL com concorrência e atraso controlado confirmou um grant e um hold, somente uma conta autorizada                                                                                                                         |
| CHN-01 | P2 — erro de bookkeeping depois do envio produzia duas respostas                                    | `markPromptSent` falhava após envio da proposta OAuth e caía no erro genérico, enviando uma segunda mensagem                                                                         | Catch local preserva a resposta já enviada e registra a falha sem conteúdo sensível. Regressão observou 2 chamadas de envio antes e 1 após. A confirmação continua exigindo `prompt_sent_at` persistido                                                                                         |
| CHN-02 | P1 — encerramento não coordenava turnos/canais antes de desmontar dependências                      | O caminho SIGTERM/SIGINT não chamava o disconnect que já aguardava as escritas de credenciais nem drenava turnos aceitos                                                             | `shutdown()` espera até 15s por turnos, fecha entrada/subscrições e desconecta os canais; aguarda até 5s por disconnect/credenciais. O gancho ocorre antes de MCP e banco. Cinco regressões novas e testes existentes de credenciais passaram. Não foi alegada perda real observada em produção |

A avaliação integrada classifica CHN-02/WA-01 como **P1**, por afetar o requisito essencial de recuperação durante encerramento. A reprodução é do controle de drenagem em teste; não foi demonstrada perda real de dados em produção. A classificação inicial da frente era P2.

### CKT-04 — transições repetidas de assinatura (P1)

A revisão final do ciclo mostrou que `pago → pausa → retomada → pausa` para o mesmo pedido descartava a segunda pausa como `duplicate`, deixando o acesso ativo. A regressão PostgreSQL falhou antes da correção (15 aprovados, 1 falha): esperava `revoked`, recebeu `duplicate`.

Somente pausa/retomada/cancelamento passaram a ter identidade temporal própria, com data proveniente do corpo assinado. O teste agora cobre duas pausas legítimas, compatibilidade com registros antigos de evento, replay de pagamento sem nova concessão, eventos atrasados, empate contraditório, ausência de data, três transições distintas dentro de um milissegundo, cancelamento com/sem ID de assinatura e legado com hora de recebimento no ledger. A precisão de microssegundos permanece na string original até o PostgreSQL; não se usa `Date` truncado para escolher a ordem.

A [API de assinaturas Cakto](https://docs.cakto.com.br/api-reference/subscriptions/list) documenta `updatedAt` e `status`. O contrato geral do webhook não detalha a garantia desses campos dentro de `subscription`; o processamento só os usa quando presentes no corpo autenticado. Sem data confiável, guarda `held_missing_subscription_date`. Eventos anteriores ao estado local ficam como `held_stale_subscription`, porque um registro legado pode conter horário de recebimento e não provar a ordem real. Empates contraditórios ficam como `held_ambiguous_subscription_order`. Não se escolhe um novo estado automaticamente nesses casos.

Objetos de backlog criados pelo `minimalRecord` antigo só conservavam `subscription.id` e `__eventAt` local. Quando faltar a data original, eles também ficam retidos. **Conciliar esses objetos/assinaturas antes de liberá-los; não anunciar recuperação automática integral do backlog antigo.** A chave de pagamentos permanece a mesma, e sua regressão de compatibilidade confirmou que grant e validade não mudam no replay.

### Regressão detectada durante a revisão do próprio patch

A revisão cruzada encontrou um caso não coberto pelos dois primeiros testes de retenção: o banco já tinha commitado `held_order_conflict`, mas a gravação em S3 falhava; no retry, a idempotência retornava apenas `duplicate` e apagava o pending. A regressão com PostgreSQL real falhou antes da correção complementar (`held` esperado 2, obtido 1).

`priorEventOutcome` agora recupera o resultado persistido ao encontrar evento duplicado e mantém `held_*` durante o retry, sem reaplicar o pagamento. O teste com falha somente da escrita held, reinício do worker e banco real passou. Este caso foi uma falha detectada no patch em desenvolvimento, corrigida antes da entrega; não deve ser contado como incidente de produção.

## Testes executados

### Estado inicial

- Cakto Node antes das alterações: **7 aprovados, 2 pulados, 0 falhas**.
- Conjunto inicial de 12 arquivos WhatsApp, identidade, roteamento, recibos e trial-entry: **327 aprovados, 0 falhas**.
- Serviço de canal e workers/repositório de avisos no levantamento adicional: **365 aprovados**. Os testes PostgreSQL dessa tentativa ficaram bloqueados por conexão recusada; foram executados novamente com sucesso depois do ajuste de ambiente.
- Regressões CKT-01, CKT-02, CKT-03, CKT-04 e CHN-01 foram executadas e falharam sobre o comportamento anterior relevante antes da correção. A revisão complementar de held após commit também teve resultado vermelho registrado.

### Resultado final desta frente

| Comando/grupo                                                                                                | Resultado                                                                                      | Integração                                                                                                                           |
| ------------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------ |
| `node --test integrations/cakto/railway-function.test.mjs`                                                   | **14 aprovados, 2 pulados, 0 falhas**                                                          | Os dois skips exigem Bun e/ou PostgreSQL                                                                                             |
| `bun test integrations/cakto/railway-function.test.mjs` com variáveis `ASTRA_REVIEW_PG_*` e PostgreSQL local | **16 aprovados, 0 falhas, 0 pulados**                                                          | Inclui um caso amplo com SQL real, cliente S3 nativo para construção de endereço, demais casos com S3/SQL simulados conforme fixture |
| Vitest focal, 18 arquivos abaixo, com PostgreSQL local                                                       | **768 aprovados, 18 arquivos aprovados, 0 falhas e nenhum erro de tipo informado pelo runner** | 52 testes de trials e 4 de diretório usam PostgreSQL real; IA e WhatsApp simulados                                                   |
| Prettier nos arquivos desta frente                                                                           | Formatados e conferidos                                                                        | Não equivale a validação funcional                                                                                                   |
| `git diff --check` nos arquivos desta frente                                                                 | Aprovado                                                                                       | Não equivale a validação funcional                                                                                                   |

Os 768 testes incluem alterações de outras frentes já presentes na árvore compartilhada. Não somar as rodadas intermediárias como se fossem testes independentes adicionais.

Comando focal completo executado dentro do wrapper PostgreSQL descartável:

```bash
corepack pnpm --filter @ownpilot/gateway exec vitest run \
  src/channels/plugins/whatsapp/whatsapp-lifecycle.test.ts \
  src/channels/plugins/whatsapp/whatsapp-api.test.ts \
  src/channels/plugins/whatsapp/whatsapp-copy-code.test.ts \
  src/channels/plugins/whatsapp/session-store.test.ts \
  src/channels/whatsapp-inbound-identity.test.ts \
  src/channels/whatsapp-contact-discovery.test.ts \
  src/channels/channel-ai-routing-concurrency.test.ts \
  src/channels/channel-ai-routing-access.test.ts \
  src/channels/receipt-state.test.ts \
  src/channels/response-safety.test.ts \
  src/channels/trial-entry.test.ts \
  src/services/whatsapp-first-contact-recovery.test.ts \
  src/channels/service-impl.test.ts \
  src/channels/customer-integrations.test.ts \
  src/services/channel-access-notification-worker.test.ts \
  src/db/repositories/channel-access-notifications.test.ts \
  src/db/repositories/whatsapp-trials.pg.test.ts \
  src/db/repositories/whatsapp-contact-discovery.pg.test.ts \
  --maxWorkers=2 --reporter=dot
```

As variáveis usadas pelo teste Cakto e trials são `ASTRA_REVIEW_PG_PORT`, `ASTRA_REVIEW_PG_USER`, `ASTRA_REVIEW_PG_DATABASE` e `ASTRA_REVIEW_PG_PASSWORD`. O caso de diretório usa `ASTRA_AUTH_TEST_PORT` e o role/banco de laboratório `astra_auth_lab`/`astra_auth_verification_lab`. São bancos de teste separados e não exigem segredos da aplicação.

O wrapper local utilizado foi `/workspace/scratch/79eb9d8781db/with-review-db.mjs`, com executável e argumentos da suíte como parâmetros. Bun foi instalado fora do repositório com `npm install --prefix /workspace/scratch/79eb9d8781db/bun-runtime --no-package-lock --no-save bun@1.4.4`; nenhum lockfile/dependência do projeto foi alterado por isso. A CI pode usar seu PostgreSQL descartável sem esse wrapper.

Resultados resumidos dos logs finais locais:

```text
Cakto / Bun 1.4.4 / PostgreSQL 16.4:
16 pass
0 fail
Ran 16 tests across 1 file.
ISOLATED_TEST_EXIT 0

WhatsApp focal / Vitest 4.1.10 / PostgreSQL 16.4:
Test Files 18 passed (18)
Tests      768 passed (768)
Type Errors no errors
Duration   8.37s
ISOLATED_TEST_EXIT 0
```

Essa duração é tempo de suíte local, não medida de latência de atendimento nem capacidade de produção.

## Recuperação: o que existe e o que não está comprovado

### Recursos implementados e validados no alcance descrito

- Credenciais persistentes, fila de gravação e invalidação de callbacks de socket antigo dentro de um processo.
- Reconexão limitada, preservação de sessão no disconnect e limpeza somente no logout explícito, conforme testes de lifecycle.
- Dedupe durável de inbound, concorrência por conversa/usuário e rechecagem de acesso.
- Claims/leases duráveis de boas-vindas e avisos de acesso; etapas anteriores ao envio podem ser recuperadas. Envio de resultado incerto não é repetido automaticamente.
- Inbox Cakto criptografada, recuperação após falha de banco, idempotência SQL e retenção para conciliação.
- Drenagem limitada de **turnos inbound aceitos** e espera da fila de credenciais na candidata.

### Restrições e pendências reais

1. **Uma instância escritora por sessão WhatsApp.** Não existe lease entre processos para os arquivos de autenticação Baileys. As proteções atuais são por objeto/processo. Manter uma réplica e impedir sobreposição de processos/instâncias usando a mesma sessão. A topologia de duas instâncias não foi aprovada. Não foi introduzido um lease parcial que pudesse dar falsa segurança após perda de conexão/expiração.
2. **Queda abrupta não tem replay genérico seguro.** `createIfNew` marca o inbound como existente antes de executar. Não há coluna/worker universal que distinga “ainda não executado”, “efeito aplicado” e “resposta pendente”. Após crash entre essas etapas, o mesmo ID é ignorado. O dado já gravado permanece, mas não se garante resposta nem retomada do pedido. Quando a exceção é capturada com o processo vivo, há mensagem de falha e orientação compatível com incerteza; após SIGKILL/queda não há como prometer esse aviso. A nova drenagem reduz a janela no encerramento normal, sem resolver hard crash.
3. **Shutdown não drena todos os jobs.** Os timers de workers são parados, mas não se criou barreira global de todos os envios já em voo. O método novo acompanha turnos inbound; os workers preservam seus próprios estados/recibos. Timeout mantém resultado incerto e gera log de contagem. Não declarar “todo o sistema drenado”.
4. **Conciliação Cakto é administrativa.** Eventos `held_*` ficam conservados e não são autoatribuídos a contas. É necessário acompanhar o prefixo e motivos, consultar Cakto autenticada e resolver a identidade de forma explícita. Reenvio não contorna evento já persistido como conflito. Também conciliar pausa/retomada/cancelamento sem timestamp confiável, inclusive backlog e relógio legado, antes de liberar as assinaturas afetadas.
5. **Regra de renovação precisa permanecer explícita.** O README atual calcula validade pelo pagamento, e o teste real confirmou que dois pedidos com o mesmo `paidAt` não acumulam mais 30 dias. Referências a preservar saldo de dias para renovação manual não foram aplicadas automaticamente ao checkout. Uma decisão comercial diferente exige atualização coordenada de checkout, código e testes.
6. **Validação externa essencial ainda pendente.** Não houve primeiro contato real, QR/reconexão real, entrega a três números autorizados, pagamento/renovação Cakto de teste originados na plataforma, validação real de assinatura recebida, nem recuperação do bucket publicado. Falta autorização/configuração de contas e destinatários de teste para completar essa etapa sem atingir membros reais.
7. **Falha no bookkeeping de proposta OAuth fecha a confirmação.** Se `prompt_sent_at` não foi persistido, a proposta não pode executar. A pessoa precisa renovar o pedido/confirmar após uma proposta persistida; a correção evita a segunda resposta genérica e não cria autorização implícita.

## Implantação e acompanhamento

As alterações Cakto não requerem nova tabela/migração: usam ledger e inbox existentes, mais o prefixo `held/v1/`. Antes de publicar, conferir permissões privadas de gravação/leitura desse prefixo, preservar `CAKTO_INBOX_KEY` para o backlog e atualizar **receptor e worker** com a mesma versão. Publicar apenas o gateway não atualiza a função Cakto.

**Pré-requisito de publicação:** configurar `RAILWAY_DEPLOYMENT_DRAINING_SECONDS=30`, uma réplica e overlap zero. A frente de infraestrutura verificou que a configuração inspecionada não define essa variável nem `drainingSeconds`; a [referência de deploys da Railway](https://docs.railway.com/deployments/reference) e a [referência de variáveis](https://docs.railway.com/variables/reference) documentam o default de zero segundos entre SIGTERM e SIGKILL. Sem o ajuste, o patch de shutdown não recebe a janela necessária. Os 30s reservam os até 15s de turnos, 5s de disconnect e tempo para os demais serviços. Nada foi alterado em produção. O volume `/app/data` ajuda a impedir sobreposição ativa no mesmo serviço, mas não equivale a lease entre serviços/processos compartilhando a sessão.

Acompanhar nos primeiros membros: contagens `held`/`failed` e idade do backlog Cakto; avisos em `sending`/`failed`; erros de persistência; estado de conexão; tempo até resposta; timeouts da drenagem; conferência amostral do efeito salvo e do painel. Logs não devem expor código OTP, segredo, payload de pagamento ou conteúdo privado.

Rollback de código não deve remover objetos criptografados nem restaurar banco sobre pagamentos novos. Voltar à função anterior reintroduz os defeitos de pagamento descritos; se a candidata precisar ser interrompida, manter evidências/backlog e avaliar receptor/worker de forma conjunta. A política de retorno completa e sua autorização pertencem ao plano integrado de implantação.

## Parecer desta frente

As correções descritas estão implementadas e os testes locais indicados passaram. Isso permite revisar a candidata com evidência de transações, idempotência e isolamento de identidades em PostgreSQL real, com transporte simulado.

**Esta frente não comprova liberação de membros em produção.** A aprovação deve permanecer condicionada ao conjunto integrado de testes e aos fluxos externos essenciais autorizados. A ausência de teste real de WhatsApp/Cakto e a janela de hard crash devem constar do parecer final; nenhuma delas foi substituída por um resultado de compilação ou por teste simulado.
