# Revisão de dados, mídia e integrações — 17/11/2026

Este é o apêndice da frente de dados para `docs/ASTRA_MEMBER_READINESS_2026-11-17.md`. Base inicial inspecionada: `7915ecdd9933b55183b511f5718030b1d34e5304`. Durante a revisão, a main avançou para `6d939b28b97129de58087a1742d5c343b99e2156` (PR 141); seus fluxos de planejamento e pagamento de parcelas foram integrados e revistos. Branch de trabalho: `audit/member-readiness-20261117`. O commit consolidado da candidata e a decisão global constam no relatório principal. Nenhum serviço externo recebeu mensagem, arquivo, cobrança ou mudança nesta frente.

## Conclusão desta frente

Antes da integração da PR 141, as verificações locais desta frente executaram **3.121 testes aprovados em 43 arquivos**, sem falhas; três casos de inicialização do Radar com pgvector não foram executados localmente. Após a integração e as correções dos dois riscos encontrados, a rodada focal final aprovou **562 testes em 14 arquivos**, sem falhas nem casos pulados. Esta última rodada se sobrepõe às anteriores e não deve ser somada a elas. O detalhamento por arquivo e a versão de cada fase estão em [data-validation-summary.json](data-validation-summary.json). A validação global do commit consolidado consta no relatório principal.

Foram corrigidos quatro problemas altos: metas monetárias do canal não usavam o armazenamento do painel; conteúdos extraídos de PDF/imagem não ativavam a proteção existente contra escritas induzidas por conteúdo externo; o novo fluxo de planejamento podia gravar após o acesso expirar durante uma espera no banco; uma mesma mensagem alternando entre o atalho determinístico e a ferramenta podia criar duas metas ou repetir um aporte. Também foram corrigidos problemas de aceitação e comunicação de mídia. Há evidência local de persistência, isolamento, concorrência e rejeição de operações maliciosas; **isso não comprova funcionamento de WhatsApp, Cakto, transcrição/OCR remoto ou OAuth em produção**.

O parecer global precisa manter como bloqueio a validação real dos serviços críticos e dos cenários nativos de pgvector/worker indicados abaixo. Não houve implantação nesta frente.

## Inventário do funcionamento existente

| Área                                        | Implementação confirmada                                                                                                                                                                      | Estado e evidência                                                                                                                                                                                                                                                                                                                            |
| ------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Financeiro                                  | `expenses` e `customer_categories`, receitas/despesas, realizadas/pendentes, categorias por usuário, filtros por data, totais e séries, exclusão lógica, revisão para sincronização do painel | Implementado. SQL e APIs exercitados; criação pelo roteador do canal aparece na API do painel. Centavos exatos, fontes idempotentes e consultas por `user_id`.                                                                                                                                                                                |
| Metas financeiras                           | `customer_plans` com `kind='goal'`, objetivo e guardado em centavos; CRUD do painel, comandos determinísticos e ferramentas do canal                                                          | Implementado; ambos os caminhos do canal compartilham o registro e o recibo canônico da mensagem. Testado com três contas. Aportes mudam o planejamento, sem movimentar dinheiro nem criar despesa.                                                                                                                                           |
| Metas antigas                               | `goals` e `goal_steps`, progresso em percentual                                                                                                                                               | Legado separado. Dados preservados, leituras mantidas para membros; escritores legados removidos do conjunto descobrível do membro para impedir outra divergência com as metas financeiras. Sem conversão automática de porcentagem para reais.                                                                                               |
| Orçamentos, parcelas e assinaturas pessoais | Outros tipos de `customer_plans`; contador paga/total; valor e próxima renovação                                                                                                              | Implementados. A PR 141 adicionou pagamento explícito de parcela no painel e canal: grava a despesa e incrementa o contador na mesma transação, com recibo e versão para impedir repetição. Criar o plano ou informar histórico pago não gera despesa. Orçamento e assinatura continuam planejamento; não confirmam liquidação no fornecedor. |
| Financiamentos/dívidas no canal             | `finance_obligations` e pagamentos próprios; pagamento novo também grava despesa atomicamente                                                                                                 | Modelo distinto do plano de parcelas `customer_plans`, embora ambos registrem pagamentos explícitos no ledger. Saldo histórico não vira nova despesa. Não foi criada conversão entre modelos sem os dados necessários.                                                                                                                        |
| Agenda e tarefas                            | `calendar_events`, `tasks`, `customer_agenda_links` e recibos de mutação                                                                                                                      | Implementado. Criar/consultar/mover/excluir/concluir, datas locais, ambiguidades, concorrência e vínculos com lembretes exercitados com PostgreSQL real.                                                                                                                                                                                      |
| Lembretes                                   | `channel_reminders`, lease, token de posse, limite de tentativas, transporte separado do início da entrega                                                                                    | Implementado para avisos individuais. Reagendamento e cancelamento invalidam pendências; operação em envio é recusada. Lease antigo não pode enviar/confirmar uma posse nova.                                                                                                                                                                 |
| Recorrência geral de agenda                 | Campo `recurrence` no modelo legado                                                                                                                                                           | Parcial: portal não cria séries recorrentes e a mutação do canal recusa mover um evento recorrente. Não equivale a um motor completo de recorrência/exceções para membros. Rotinas específicas de saudação, Radar e resumo de e-mail são caminhos separados.                                                                                  |
| Memórias                                    | CRUD, deduplicação, busca híbrida/vetorial, consolidação e atualização de embeddings por revisão                                                                                              | Implementado no código. Dez testes PG de integridade executados; armazenamento/casts de vetor substituídos por texto no laboratório local. Distância e índices pgvector dependem da validação nativa.                                                                                                                                         |
| Notas, contatos e favoritos                 | Ferramentas pessoais e repositórios com proprietário injetado                                                                                                                                 | Encontrados e inspecionados. Não há uma tela/rota própria de memórias/notas no portal cliente equivalente ao CRUD administrativo. Não confundir promessa de nota no canal com disponibilidade de todas as telas administrativas.                                                                                                              |
| Áudio                                       | Groq Whisper, arquivos de até 12 MiB, um áudio por mensagem; fala do remetente separada de documento                                                                                          | Implementado; transporte simulado. Não houve chamada real de transcrição nem medição de acurácia de valores/datas falados.                                                                                                                                                                                                                    |
| Imagens                                     | JPEG, PNG e WebP, até 8 MiB cada e três por mensagem; extração estruturada; Groq e Gemini apenas com opt-in existente                                                                         | Implementado; transporte/OCR simulado. Recibos visuais não confirmam liquidação bancária. Correção passou a conferir assinatura de container antes de enviar bytes.                                                                                                                                                                           |
| PDFs                                        | `unpdf`, até 8 MiB e 20 páginas, texto limitado a 16 mil caracteres, interpretação de texto selecionável                                                                                      | Parser real validado com PDF sintético válido e corrompido. PDF digitalizado sem texto não ganha OCR local automaticamente; resposta orienta enviar foto. Outros documentos são informados como não suportados.                                                                                                                               |
| Armazenamento de anexos                     | Caminhos sanitizados, nomes aleatórios, diretórios 0700/arquivos 0600, índice no banco antes de escrever bytes, limpeza por validade                                                          | I/O real e PostgreSQL exercitados. Índice interno de assets usa plugin/chat/mensagem, sem rota pública de download encontrada para membros. Limpeza é acionada pelo uso do armazenamento; não foi presumido um serviço externo de expurgo contínuo.                                                                                           |
| Conexões pessoais                           | Composio: Google Agenda, Gmail, Drive, Planilhas, Todoist, Notion, Trello                                                                                                                     | Implementadas, condicionadas a `ASTRA_CUSTOMER_OAUTH_ENABLED=true` e configuração do provedor. Vínculo por `astra-customer:<accountId>`, ações permitidas explícitas, proposta/confirmacão para escrita, escopo do cache por usuário/conexão. Provedor real não testado.                                                                      |
| Google Agenda legado                        | Endpoint antigo `customer/integrations` anuncia indisponibilidade                                                                                                                             | Desativado nesse endpoint. O caminho `connected-apps` é a implementação diferente que deve ser usada; não assumir que o endpoint legado representa a disponibilidade da conexão atual.                                                                                                                                                        |
| Radar                                       | Fontes de clima, PTAX/câmbio, futebol, notícias, séries, diários oficiais, energia e releases; preferências, interesses, snapshots compartilhados públicos, outbox individual                 | Implementado no código; desligável por `ASTRA_RADAR_ENABLED=false`. Testes de rotas/repositório/HTTP/worker com fontes e envio simulados. Worker de coleta isolado em thread ou modo externo, com reinício e limites.                                                                                                                         |
| Investimentos                               | Livro por usuário, versão otimista, validação do estado, cálculos decimais, API same-origin BrAPI                                                                                             | Implementado; testes de concorrência/isolamento de livros e serviços simulados aprovados. Cotações reais e contrato do plano BrAPI não foram validados. Não envia ordens de compra/venda a corretora.                                                                                                                                         |
| Indicações/afiliados                        | Convite opaco, atribuição, validação/recompensa e pedidos de pagamento sujeitos a operação administrativa                                                                                     | Implementado; testes PG de atribuição, concorrência, duplicação, reembolso e Pix cifrado aprovados. Nenhum repasse real executado.                                                                                                                                                                                                            |
| Família/compartilhamento                    | Nenhuma implementação de compartilhamento encontrada nas rotas ou telas de membros desta base                                                                                                 | Não considerar disponível nem presumir permissões familiares.                                                                                                                                                                                                                                                                                 |

## Achados e correções

### DAT-01 — P1 — Metas do canal ausentes do painel

**Antes, na base inicial:** o seletor de ferramentas para “quero juntar 5 mil reais” oferecia `create_goal`, `list_goals` e `update_goal`. O executor usava `GoalService`/`goals`, cujo progresso é percentual e cujo esquema nem recebe o valor-alvo em reais. A seção Metas do portal consulta `customer_plans`, com valores monetários. A landing em `landing/src/public-pages.mjs` mostra justamente a jornada monetária de R$ 4.000 com R$ 2.600 guardados. Não existia ponte entre esses registros.

**Mudança:** as ferramentas de meta financeira do membro leem e escrevem `customer_plans`; o usuário vem do registro da ferramenta, não de argumentos do modelo. Nome e objetivo monetário são obrigatórios; progresso é valor total guardado, não incremento ou porcentagem. Escritas dependem de conta conhecida, mensagem estável e acesso ainda ativo após adquirir o lock. Um recibo durável por mensagem/ação impede repetição, inclusive depois de excluir a meta. Falha ao gravar o recibo reverte a escrita na mesma transação. As respostas são geradas dos dados persistidos. A descoberta de ferramentas para membros mantém somente leituras do sistema legado; administração e dados antigos permanecem intactos.

**Arquivos principais:** `tools/customer-planning-tools.ts`, `db/repositories/customer-planning.ts`, `db/schema/customer-portal.ts`, `channels/tool-selection.ts`, `channels/receipt-state.ts`, `channels/verified-facts.ts`, `channels/response-safety.ts`, `services/agent/service.ts`, `services/agent/prompt.ts` (caminhos relativos a `packages/gateway/src`).

**Validação:** oito casos novos em `db/repositories/customer-goals.pg.test.ts`, com PostgreSQL real, três usuários, mesmo ID de mensagem entre contas, criação concorrente, painel → edição → leitura pelo canal, IDs de outro usuário em ferramenta/API/repositório, 20 replays simultâneos, expiração, reconexão, exclusão seguida de replay e falha de gravação de recibo. Também foram executados testes do seletor, registro/descoberta e formatação de resposta. A revisão integrada de composição e fallback de metas é registrada no relatório principal.

**Revisão integrada posterior:** o agente de autenticação encontrou mais dois caminhos de apresentação: uma meta já persistida podia desaparecer do fallback após falha do modelo, e uma resposta mista podia omiti-la ao formatar o clima. Cinco casos reproduziram essas omissões antes da correção; a rodada final dele aprovou 173 testes em quatro arquivos de resposta/recibos/falha. Não somar essa rodada integralmente às contagens acima, pois há sobreposição. Em composição com uma consulta que ainda não tem um formatador verificável, a resposta conserva as escritas confirmadas e informa a necessidade de consultar os outros dados separadamente.

**Integração da PR 141:** o atalho determinístico passou a reconhecer criação de meta, orçamento, compra parcelada, aporte e parcela paga. A consulta `list_customer_planning` foi preservada junto às quatro ferramentas financeiras desta revisão; escritores legados em percentual não foram reativados. Ver DAT-04 e DAT-05 para as garantias adicionadas aos novos caminhos.

**Limite deliberado:** uma operação de planejamento por mensagem; pedidos adicionais exigem outra mensagem. Não se convertem metas antigas para dinheiro sem informação do usuário.

### DAT-02 — P1 — Documento/OCR não ativava o guard de escrita

**Antes:** o normalizador rotulava texto extraído como dado não confiável, mas os caminhos direto e MessageBus iniciavam `externalContentGuard.seen=false`. A proteção de servidor no registro de ferramentas só era ativada ao consultar integrações. Assim, instruções contidas num arquivo podiam chegar ao modelo junto ao texto do usuário sem a barreira de escrita existente. O caminho direto ainda usava todo o texto extraído como `channelRequestText`. Escritores legados de despesas também não conferiam esse guard.

**Mudança:** PDF e OCR compreendidos produzem `hasUntrustedContent=true`. Ambos os caminhos propagam esse marcador para o guard; o texto de autorização passa a conter somente a mensagem original e a fala transcrita do remetente. O executor legado de despesas rejeita suas quatro operações mutáveis quando já viu conteúdo externo. Áudio do remetente permanece distinguido de texto de documento.

**Validação:** dois testes de regressão falharam antes da correção nos caminhos direto/MessageBus, mostrando `seen=false`; passam depois. O teste de registro de ferramentas usa texto de PDF com comando malicioso, verifica que o executor de memória não é chamado, permite consulta escopada e permite uma mensagem seguinte explícita somente no usuário injetado. Quatro cenários adicionais verificam que add/batch/update/delete de despesas não chegam ao repositório após conteúdo externo.

**Efeito para membros:** foto/PDF podem ser analisados, mas a alteração exige uma mensagem seguinte explícita depois de conferir os dados. Isso também reduz o risco de gravar automaticamente um valor OCR incerto. Não representa prova de resistência de todo modelo a todas as injeções; a proteção testada é a negativa de execução no servidor.

**Arquivos:** `channels/normalizers/types.ts`, `channels/normalizers/media-understanding.ts`, `channels/channel-ai-routing.ts`, `tools/expense-tools.ts` e testes correspondentes.

### DAT-03 — P2 — Mídia divergente, não suportada e falha de extrator

**Antes:** bytes JPEG declarados PNG e Ogg declarados WAV eram enviados ao provedor; formato desconhecido voltava para o fluxo sem explicar que não fora lido; uma exceção do extrator podia escapar da normalização. Os testes antigos inclusive usavam fixtures com MIME incompatível.

**Mudança:** conferir assinatura mínima do container antes de chamar extratores/provedores, manter limites de tamanho na fronteira, informar formatos não suportados, remover binário do contexto textual e conter exceções sem inventar transcrição/fatos. Fixtures de imagem foram substituídas por arquivos sintéticos válidos. O idioma português e a política de opt-in do Gemini não foram alterados.

**Validação:** seis novos cenários falharam antes da correção; 26 testes de mídia passam no estado final. Incluem vazio, corrompido, MIME divergente, limite, chamada direta do transporte, falha de provedor e solicitações concorrentes. Um PDF é realmente processado por `unpdf`; STT/visão continuam simulados. Assinatura de container não substitui validação integral de codec pelo provedor.

### DAT-04 — P1 — Acesso expirado durante espera de planejamento

**Reprodução após integrar a PR 141:** um teste manteve o lock PostgreSQL real de finanças ocupado, iniciou a operação, confirmou em `pg_stat_activity` que ela aguardava o lock, expirou o grant e liberou a espera. Criar meta, somar aporte, pagar uma parcela no canal e pagar pela API continuavam gravando; os quatro casos falharam antes da correção. Não foi usado apenas um relógio simulado ou uma exceção de mock.

**Mudança:** o callback de autorização originado no roteador do servidor chega à transação de criação, aporte e pagamento e é reavaliado depois dos locks, antes das escritas. O caminho da próxima parcela a receber recebeu o mesmo controle. O atalho chamado sem callback nega a operação. A rota de pagamento do painel reconsulta a conta e o grant vinculados à sessão, sem aceitar identidade ou permissão vindas do corpo da requisição. O retorno 404 para ID que não pertence à conta foi mantido.

**Validação:** os quatro repros passaram; um caso adicional mantém o recebível pendente após expiração no lock e, após restabelecer acesso no laboratório, permite retry do mesmo pedido exatamente uma vez. A suíte de sincronização verifica o contrato HTTP, conflito de versão do painel, rollback, confirmações simultâneas, ID de outra conta e isolamento dos valores. Sem efeitos em contas reais.

**Arquivos:** `channels/customer-planning-routing.ts`, `channels/channel-ai-routing.ts`, `db/repositories/customer-plan-actions.ts`, `db/repositories/customer-planning.ts`, `db/repositories/customer-receivables.ts`, `routes/customer/planning.ts` e testes PG.

### DAT-05 — P1 — Replay entre atalho e ferramenta de meta

**Reprodução após integrar a PR 141:** o atalho gravava `customer_planning_requests`, enquanto as ferramentas financeiras desta revisão usavam `customer_goal_requests`. Quatro testes reais falharam: criação e aporte repetiam o efeito ao alternar entre os caminhos nos dois sentidos. Uma recuperação que consultasse o saldo já atualizado podia somar o aporte novamente.

**Mudança:** a ferramenta também consulta e grava o recibo compartilhado pelo ID canônico de usuário/plugin/chat/mensagem, dentro da mesma transação e dos mesmos locks da alteração. Criações equivalentes usam fingerprint normalizado compatível com o atalho; uma mensagem já consumida por outra mutação resulta em conflito sem outro efeito. O recibo específico da ferramenta e o histórico da main foram preservados. Não houve atribuição ou conversão de metas antigas.

**Validação:** quatro repros passaram; falha simulada na gravação de qualquer uma das duas tabelas de recibos reverte a meta e permite retry seguro. Exclusão seguida de replay, reconexão e 20 cópias concorrentes continuam cobertos. A suíte `customer-goals.pg.test.ts` tem agora 18 casos, todos aprovados na rodada integrada.

**Arquivos:** `db/repositories/customer-planning.ts`, `tools/customer-planning-tools.ts`, `db/schema/customer-portal.ts` e `db/repositories/customer-goals.pg.test.ts`.

## Evidências preservadas e testes executados

### Baseline antes de alterar fonte produtiva

- Inspeção inicial do Git: base e branch acima; nenhuma alteração prévia desta frente. Alterações do agente Cakto em andamento foram preservadas.
- Baseline focal: 17 arquivos/1.394 testes aprovados. Três suítes PostgreSQL falharam por `ECONNREFUSED` porque o processo de banco de outro comando não era visível no executor; duas suítes ficaram desabilitadas por variável. Falha de ambiente, não regressão.
- Primeiro wrapper de banco: 13 testes passaram; um teste antigo falhou porque exigia `astra_auth_lab`, ausente na configuração inicial. O wrapper foi corrigido pela frente principal; esse teste e o teste de range de lembretes passaram na rodada final.
- Mídia: seis falhas reproduzidas em `astra-media-red.log`, depois corrigidas. Guard de mídia: duas falhas de fronteira reproduzidas em `astra-media-guard-red.log`, depois corrigidas.
- Módulos adicionais: 20 arquivos/587 testes aprovados em uma rodada intermediária; sete casos não selecionados/sem flags. Não somar novamente aos testes finais que se sobrepõem.

### Rodadas finais por fase

| Rodada                                                        | Resultado                                                                          | Classificação                                                                                                                             |
| ------------------------------------------------------------- | ---------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------- |
| `astra-data-final-unit.json`                                  | 25 arquivos, 1.939 aprovados, zero falha/skip                                      | Funções, rotas, servidores de ferramentas e provedores simulados; parser PDF e alguns acessos a arquivo reais                             |
| `astra-data-final-pg.json`                                    | 18 arquivos, 1.182 aprovados, zero falha; três smoke cases do Radar não executados | PostgreSQL 16.4 local, bancos descartáveis e contas fictícias; HTTP/autenticação de contexto e transportes simulados                      |
| `astra-planning-merge-final.json`                             | Após PR 141: 14 arquivos, 562 aprovados, zero falha/skip                           | PG real em quatro suítes; demais unidades/roteamento com serviços simulados; inclui 18 testes de metas e oito de sincronização financeira |
| `corepack pnpm --filter @ownpilot/gateway typecheck`          | Aprovado                                                                           | Verificação TypeScript; não substitui jornadas                                                                                            |
| Validação adicional de financiamento/roteamento financeiro    | Três arquivos, 220 testes aprovados                                                | Regras monetárias e replays com banco/provedor simulados; log `astra-financing-detail.log`                                                |
| ESLint e Prettier dos 18 arquivos de fonte/teste desta frente | Aprovados, saída 0                                                                 | Verificações estáticas; os arquivos de composição revisados pelo outro agente tiveram lint separado                                       |
| `git diff --check`                                            | Aprovado                                                                           | Consistência do patch; não é teste funcional                                                                                              |

Comando da rodada PostgreSQL, executado a partir da raiz do repositório (o wrapper cria banco exclusivo e injeta variáveis somente para o processo filho):

```sh
node /workspace/scratch/79eb9d8781db/with-review-db.mjs corepack pnpm --filter @ownpilot/gateway exec vitest run \
  src/db/repositories/customer-goals.pg.test.ts \
  src/db/repositories/customer-finance-sync.pg.test.ts \
  src/db/repositories/channel-reminders-delivery.pg.test.ts \
  src/db/repositories/channel-reminders-range.pg.test.ts \
  src/db/repositories/channel-assets-integrity.pg.test.ts \
  src/db/repositories/reminder-selection.pg.test.ts \
  src/db/repositories/planning-concurrency.pg.test.ts \
  src/db/repositories/planning-integrity.pg.test.ts \
  src/db/repositories/memory-integrity.pg.test.ts \
  src/db/repositories/customer-investments.pg.test.ts \
  src/db/repositories/customer-referrals.pg.test.ts \
  src/db/repositories/customer-radar.pg.test.ts \
  src/channels/calendar-mutation.pg.test.ts \
  src/channels/personal-tasks.pg.test.ts \
  src/channels/personal-subscriptions.pg.test.ts \
  src/services/radar/http.pg.test.ts \
  src/services/radar/startup.pg.test.ts \
  src/routes/customer/radar.pg.test.ts \
  --maxWorkers=2 --reporter=json --outputFile=/workspace/scratch/79eb9d8781db/astra-data-final-pg.json
```

A rodada sem banco usou `corepack pnpm --filter @ownpilot/gateway exec vitest run <arquivos da seção runs.unit do JSON> --maxWorkers=2 --reporter=json --outputFile=/workspace/scratch/79eb9d8781db/astra-data-final-unit.json`. Os nomes exatos executados e a contagem de cada arquivo estão no resumo versionado. Logs completos de execução ficam no diretório de evidências local da missão e são apontados no relatório principal.

### O que as jornadas locais demonstram

- Gravação determinística recebida pelo caminho do WhatsApp aparece no ledger e na API de resumo do painel; replay do mesmo ID não duplica receita/despesa.
- Três usuários de meta criam simultaneamente, não leem/editam/excluem IDs alheios, e o valor salvo no canal é o valor do painel. Edição no painel é recuperada no canal.
- Lembretes recuperam preparação não enviada após expirar lease; posse antiga não pode enviar ou marcar entrega. Uma chamada de transporte já iniciada com resultado incerto não é repetida automaticamente. Mensagem aceita pelo transporte não equivale a confirmação no aparelho do destinatário.
- Tarefa concluída cancela o lembrete pendente vinculado; envio já iniciado causa conflito, sem alegar cancelamento que não ocorreu.
- Mutação de agenda registra o recibo atomicamente, usa data local, protege homônimos, rejeita grupo/revogação e invalida operações antigas. Falha do recibo reverte a mudança.
- Memórias corrigidas invalidam o hash/embedding antigo; embedding atrasado não sobrescreve a correção. Leituras/escritas/exclusões/embeddings alheios são recusados. Busca vetorial nativa não foi medida no laboratório sem extensão.
- Arquivos mantêm registro e bytes coerentes na limpeza; erros de remoção não eliminam o registro de retenção nem impedem limpar arquivos posteriores.
- Conexões validam dono da conexão, argumentos permitidos, confirmação explícita, limites e estado incerto após timeout. Os provedores nessas jornadas são simulados.

### Integração e cobertura: limites da evidência

O baseline focal após a resolução dos conflitos da PR 141 passou em seis arquivos/136 testes. Os oito repros DAT-04/DAT-05 foram executados em seguida, falharam antes da correção e passaram depois. A rodada focal integrada final está registrada em `astra-planning-merge-final.log` e JSON homônimo: 14 arquivos/562 testes. Typecheck, ESLint dos 11 arquivos de fonte/testes tocados na integração, Prettier e `git diff --check` foram aprovados.

O comando pós-integração usa o mesmo wrapper descartável, mas remove as variáveis genéricas `POSTGRES_HOST`, `POSTGRES_PORT`, `POSTGRES_USER`, `POSTGRES_PASSWORD` e `POSTGRES_DB` do processo filho, preservando somente `ASTRA_*` para as suítes opt-in:

```sh
node /workspace/scratch/79eb9d8781db/with-review-db.mjs \
  env -u POSTGRES_HOST -u POSTGRES_PORT -u POSTGRES_USER -u POSTGRES_PASSWORD -u POSTGRES_DB \
  corepack pnpm --filter @ownpilot/gateway exec vitest run \
  <arquivos da seção runs.postMerge do JSON versionado> --maxWorkers=2
```

A tentativa anterior de cobertura completa do gateway, com banco mas sem pgvector e excluindo explicitamente o teste de backup sem `pg_dump`, **não terminou com relatório final**. O log `astra-gateway-full-pg-coverage.log` foi preservado; a sessão já não existia quando retomada. Houve falhas de inicialização de esquema por extensão ausente, acionadas por variáveis genéricas de PostgreSQL em testes unitários. Essa tentativa é inconclusiva e não aprova gate. Uma rodada diagnóstica focal de 96 testes PG comprovou execução de código antes omitido, mas sua soma estimada com a cobertura anterior também não é uma aprovação. A cobertura completa com pgvector/cliente PostgreSQL fica a cargo do gate integrado registrado no relatório principal; nenhum threshold foi reduzido.

## Medição de carga do componente Radar

Após as verificações pequenas de repositório, foi executado o cenário existente de 500 contas fictícias, com 1.500 interesses em três recursos públicos compartilhados. O benchmark avaliou e enfileirou **500 notificações, zero erro e zero duplicata**. Medição da rodada registrada: 814 ms; 615 contas/s; lotes de até 100 com p50 116,96 ms, p95 e p99 332,44 ms; heap Node 64 MiB.

Os percentis são dos seis lotes dessa execução, não de 500 requisições HTTP independentes. Cenários de 2.000, 5.000 e 10.000 ficaram excluídos por filtro, para não concorrer com a validação integrada principal. O resultado mede somente PostgreSQL/evaluator local; não inclui envio, IA, rede externa nem capacidade de produção. O arquivo JSON versionado conserva a medição original.

```sh
ASTRA_RADAR_LOAD_TEST=true \
ASTRA_RADAR_BENCHMARK_OUTPUT=/workspace/scratch/79eb9d8781db/astra-radar-benchmark.jsonl \
node /workspace/scratch/79eb9d8781db/with-review-db.mjs \
  corepack pnpm --filter @ownpilot/gateway exec vitest run \
  src/services/radar/load.pg.test.ts --maxWorkers=1 -t 'evaluates 500 synthetic'
```

O teste passou a aceitar a variável opcional de evidência JSON porque o runner não exibia o `console.log` dos testes aprovados. Não foi alterado código de produção para a medição.

## Pendências reais e limites da liberação

| Pendência                                                                            | Razão/evidência                                                                                                                                    | Efeito na liberação                                                                                                                                                                             |
| ------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| WhatsApp real, resposta e entrega de lembrete, reinício/reconexão do provedor        | Esta frente não teve destinatários externos de teste autorizados nem iniciou sessões reais                                                         | Bloqueio global dos fluxos críticos até validação controlada; ver frente de canais                                                                                                              |
| Groq STT/visão e Gemini opt-in                                                       | Sem uso de chaves/arquivos reais ou cobrança externa; fetch simulado                                                                               | Não alegar qualidade de OCR/transcrição em produção. Testar erros de valores/datas e fallback com conta de teste antes de liberar mídia como recurso confiável                                  |
| OAuth/Composio: conectar, revogar, expirar/renovar tokens, cotas e espelhamento real | Somente mocks e inspeção dos controles por proprietário                                                                                            | Manter conexões fora do piloto até smoke real por conta de teste, ou declarar restrição de recurso não essencial                                                                                |
| Inicialização do worker Radar e vetores nativos                                      | Três casos smoke dependem de flag/pgvector; fixture de memória local usa texto para armazenamento de vetor                                         | Executar CI/ambiente com extensão antes de aprovar esses caminhos; não extrapolar fallback local                                                                                                |
| Metas antigas em percentual                                                          | Não há valor-alvo confiável para converter para `customer_plans`                                                                                   | Preservadas para leitura; pedir informação explícita caso seja preciso cadastrar uma versão monetária                                                                                           |
| Recorrências gerais e parcelas automáticas                                           | Não há motor completo de séries/exceções no portal nem geração automática de pagamentos; a PR 141 implementa confirmação explícita de cada parcela | Não anunciar automação bancária nem geração automática de pagamentos. Pagamento manual confirmado no canal/painel é suportado; financiamentos e planos de parcelas continuam modelos distintos. |
| Alegação de criptografia de memórias em `SECURITY.md`                                | `MemoriesRepository.create` grava `input.content` em `memories.content TEXT`; esse caminho não cifra o campo                                       | Ajustar comunicação/documentação e confirmar proteção de volume/backup. Não foi demonstrado vazamento; não se presume criptografia de campo por existir no documento genérico                   |
| Família/compartilhamento                                                             | Ausente no código de membros revisado                                                                                                              | Não apresentar como operacional                                                                                                                                                                 |

## Implantação e retorno

Esta frente adiciona `customer_goal_requests`; a PR 141 integrada também adiciona `customer_planning_requests`. Ambas estão em `CUSTOMER_PORTAL_TABLES_SQL`, já executado na inicialização. O recibo comum guarda usuário, chave, fingerprint, ID do plano e, quando houver, ID da despesa do pagamento. O recibo específico da meta foi mantido e sua gravação é atômica com o recibo comum. Não guardam o texto da conversa. O teste executou a DDL duas vezes sem perda. Não há atribuição de registros legados nem atualização em massa.

Implantar somente após os critérios globais: backup/restauração verificados, esquema aplicado, migrações completas, testes aprovados no commit final e smoke real autorizado. A versão anterior continua compatível com os registros existentes e pode ignorar a tabela aditiva. **Não excluir as tabelas de recibos em um rollback**: elas são necessárias para não recriar operações ao retornar à candidata. Um rollback também reintroduz a divergência de metas e a falta de guard de mídia; manter acesso de membros suspenso/restrito até retomar uma versão validada. Nenhuma ação de implantação ou rollback foi executada nesta frente.
