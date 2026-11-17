# Astra — revisão para liberação de membros

Data: 17 de novembro de 2026, America/Campo_Grande.

> **Parecer: ainda não apto para liberar membros.** As falhas confirmadas abaixo
> foram corrigidas e a candidata passou pela validação disponível em laboratório
> e CI. Permanecem gates essenciais de WhatsApp/OTP/IA, pagamento externo,
> recuperação com sessão real e configuração operacional. Esta revisão não
> publicou suas correções em produção nem fez cobranças ou envios reais.

## 1. Escopo, versões e preservação

Repositório: `QGBALTIGO/astra`. Branch da revisão:
`audit/member-readiness-20261117`. Base imutável:
`7915ecdd9933b55183b511f5718030b1d34e5304`, merge do PR #140.

Entrega: [PR #142, em rascunho](https://github.com/QGBALTIGO/astra/pull/142).
Código candidato final: `43118c019e3d08bc3adea9f4887481c09fe4ee48`, árvore
`3947f33a813cc38514b0a6f27013811e48549289`. As rodadas integradas anteriores
avaliaram `3e50657ffbc4bbef13c6239b9242471937af1c4b` e
`f1c8b1302ce511102fa0e74ee6a36bcadb9df3d2`. A final também preserva a atualização
externa de branding/PWA `83fecbc16da8220b3ff603c8faa08887bec655ea` e corrige a
promessa de recorrência da landing. O guard de autenticação foi preservado; a
única alteração adicional de gateway é a política de cache dos ícones públicos.
Os commits de documentação posteriores registram evidências, sem alterar a
aplicação. O resumo de execução registra os SHAs e runs, evitando atribuir
resultados de uma rodada a outra.

Foi criado um checkout isolado para as correções e um worktree da base para
comparação. Durante a revisão, a principal avançou para `6d939b28b97129de58087a1742d5c343b99e2156` (PR #141). Essa atualização foi incorporada preservando o novo planejamento, pagamento de parcelas e sincronização, e recebeu regressões adicionais de acesso e idempotência. No fechamento, a principal avançou novamente para `83fecbc16da8220b3ff603c8faa08887bec655ea` (branding/PWA); essa versão também foi integrada, com revisão dos guards, manifesto e cache, sem sobrepor trabalho de terceiros. Os checkouts anteriores, inclusive alterações de landing sem commit,
foram preservados. Não foram feitas cobranças, envios para contatos reais,
alterações de assinaturas, restaurações de produção ou publicações.

A consulta somente leitura ao Railway identificou:

| Componente              | Versão/configuração observada                                                                                                                                                                                                                                                                         |
| ----------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Gateway                 | Inicialmente `sha-7915ecdd...`. Na leitura final, imagem `ghcr.io/qgbaltigo/astra:sha-6d939b28b97129de58087a1742d5c343b99e2156`; deployment `55628ded-e112-4811-b42f-f84fe4cbaa21`, criado às 19:24:47 UTC / 15:24 no fuso do usuário. Essa implantação ocorreu por outro fluxo, não por esta revisão |
| Réplicas e persistência | Uma réplica em `iad`, volume `/app/data` de 500 MB                                                                                                                                                                                                                                                    |
| PostgreSQL              | Serviço `astra-postgres`, imagem `pgvector/pgvector:pg16`, volume persistente de 500 MB; versão patch do servidor não consultada                                                                                                                                                                      |
| Cakto                   | Receiver `astra-cakto-webhook` e worker `astra-svg-preflight-temp`, ambos Bun 1.4.4; worker a cada cinco minutos; inbox privado em bucket separado                                                                                                                                                    |
| Código das Functions    | Receiver e worker correspondiam ao arquivo da base após remover whitespace nas extremidades; as Functions são publicadas separadamente da imagem do gateway                                                                                                                                           |
| Landing                 | Railway Function separada, Bun 1.4.4; conteúdo consultado sem alteração                                                                                                                                                                                                                               |
| Configuração            | Não havia mudanças staged; variáveis consultadas com valores ocultos pelo conector                                                                                                                                                                                                                    |

A leitura final encontrou cinco serviços sem alertas/falhas de deployment nas
duas horas consultadas; o cron Cakto havia concluído. Isso descreve o estado da
plataforma, sem certificar jornadas. A versão publicada `6d939b2` está incorporada
à candidata, mas não contém as correções desta revisão. Evidências:
[estado final](reviews/2026-11-17/production-final-state.json),
[sondas finais](reviews/2026-11-17/production-final-health.json) e
[métricas somente leitura](reviews/2026-11-17/production-metrics.json).

No levantamento inicial, o endpoint público `/api/v1/auth/status` informou senha configurada e sessão não
autenticada. `/api/v1/customer/auth/me` recusou acesso sem sessão (401).
`/health/ready` respondeu `ready`; `/health` respondeu `degraded` com HTTP 200.
Em uma verificação posterior, em 17/11 às 15:10 no fuso do usuário, `GET /api/v1/health/live` retornou 401 tanto sem credenciais como com uma chave sintética inválida acima do limite aceito. Nenhum corpo foi lido e nenhum redirect foi seguido. O padrão de bypass HTTP não foi observado nesse endpoint; isso não identifica toda a configuração nem certifica WebSocket. A evidência está em [production-admin-health-probe.json](reviews/2026-11-17/production-admin-health-probe.json).

O health agregado pode incluir dependências opcionais, como Docker, mas a causa
exata da degradação não foi demonstrada. Não se deve tratá-lo como prova de saúde
integral. Os logs consultados registraram erros de processamento de mensagens;
não foi possível atribuir a causa sem reproduzir o caso e sem expor conteúdo de membros.

## 2. Funcionamento e fronteiras de confiança

O fluxo de membro implementado passa por recepção/normalização do WhatsApp,
resolução da identidade e acesso, persistência do identificador da mensagem,
serialização da sessão, interpretação direta ou por agente, ferramentas com
contexto do proprietário, repositórios PostgreSQL, recibo da operação e envio da
resposta. O painel consulta os mesmos repositórios de cliente através de sessões
próprias e validações no servidor. As correções desta revisão integram as metas
monetárias a esse caminho comum.

O recebimento de uma mensagem, a conclusão da operação, a geração de uma resposta,
a aceitação do envio pelo adaptador e a entrega ao aparelho são estados distintos.
Os testes locais confirmam os estados persistidos e o comportamento dos adaptadores
simulados. Não certificam entrega no aparelho nem interpretação por um modelo real.

O gateway reúne API, WhatsApp e vários workers. Filas de lembretes, OTP, notificações,
Radar e processamento de pagamentos têm mecanismos persistidos específicos. O fluxo
genérico de mensagens não constitui uma fila transacional durável de execução de
todas as ações. Uma queda abrupta entre registrar a entrada e terminar a ação ainda
exige conciliação; repetir automaticamente uma ação de resultado incerto seria inseguro.

Os limites principais são:

- Sessão de cliente resolve `accountId` e `dataUserId` no servidor. IDs e parâmetros
  enviados pelo cliente não substituem essa identidade.
- Ferramentas do membro usam seleção restrita e contexto injetado. Recursos
  administrativos e ferramentas genéricas herdadas do OwnPilot não são
  automaticamente funcionalidades disponíveis ao membro.
- Dados extraídos de documentos e imagens são conteúdo não confiável. A revisão
  conecta esse conteúdo à proteção existente contra operações de escrita induzidas.
- Eventos Cakto autenticados e elegíveis ao processamento são registrados em armazenamento criptografado antes
  da confirmação de recebimento. Eventos sem associação segura ficam retidos para
  conciliação, sem conceder acesso por suposição.
- Arquivos de sessão, chaves e anexos privados precisam do volume persistente;
  os testes usam diretórios e credenciais exclusivamente sintéticos.

## 3. Inventário funcional

“Implementado” descreve existência no código, não certificação externa em produção.
Os inventários detalhados e limites de cada frente estão nos documentos vinculados.

| Área                                      | Situação encontrada                                                             | Validação e limite                                                                                                                                                        |
| ----------------------------------------- | ------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| WhatsApp e acesso                         | Implementado; deduplicação, serialização por sessão, teste e controle de acesso | Regressões locais e PostgreSQL; conexão, entrega e reinício com conta real pendentes                                                                                      |
| Login por telefone/OTP e sessões          | Implementado                                                                    | Três contas fictícias em PostgreSQL real, OTP concorrente, revogação, expiração, CSRF e isolamento                                                                        |
| Administração HTTP/WebSocket              | Implementada separadamente                                                      | Bypass condicionado à configuração reproduzido e corrigido; configuração efetiva de produção ainda precisa ser confirmada                                                 |
| Teste de três dias                        | Implementado para contatos novos elegíveis, uma vez por identidade              | Concorrência e persistência exercitadas; contatos históricos não recebem novo teste arbitrariamente                                                                       |
| Cakto                                     | Implementado com inbox, worker, idempotência e retenção de casos ambíguos       | Bun e PostgreSQL reais no laboratório; compra de teste externa e configuração do checkout pendentes                                                                       |
| Finanças/categorias/relatórios            | Implementados                                                                   | Testes de parsing, centavos, replays, proprietário e consistência do painel; referências nos testes da frente de dados                                                    |
| Agenda/tarefas/lembretes                  | Implementados                                                                   | Persistência, edição/cancelamento e filas testados em laboratório; entrega real e fuso/dispositivo externos pendentes                                                     |
| Recorrência geral de lembretes/calendário | Ausente no caminho de lembrete do membro; calendário legado parcial             | Avisos individuais e rotinas específicas de saudações/Radar existem; não há criação de séries arbitrárias pelo membro. A promessa correspondente da landing foi corrigida |
| Metas monetárias                          | Implementadas, com integração corrigida nesta branch                            | Antes havia estruturas diferentes no WhatsApp e painel; agora usa planos do cliente e recibos idempotentes                                                                |
| Memórias/histórico                        | Implementados                                                                   | Escopo, correção e persistência testados, inclusive `vector(1536)` nativo no CI. Qualidade semântica, consultas de distância e desempenho HNSW não certificados           |
| Áudio/imagem/PDF                          | Implementados com limites                                                       | MIME/conteúdo, tamanho, PDF válido/corrompido e guard de conteúdo externo; qualidade real de STT/OCR não certificada                                                      |
| Integrações                               | Implementação parcial e controlada                                              | Google Calendar de `/customer/integrations` desativado; fluxo separado de contas conectadas existe, condicionado a configuração e autorização                             |
| Radar                                     | Implementado                                                                    | Testes de banco/isolamento e avaliação sintética; fornecedores e notificações reais pendentes                                                                             |
| Investimentos                             | Implementado para carteira/lançamentos e avaliação                              | Banco e contratos locais; preços/provedores e comportamento externo não certificados                                                                                      |
| Indicações/afiliados                      | Implementado com aprovação/pagamento manual                                     | Não constitui pagamento automático a afiliados; sem transferência real nesta revisão                                                                                      |
| Família/compartilhamento                  | Não identificado como fluxo operacional do cliente                              | Não apresentado como recurso liberado                                                                                                                                     |
| Landing/dashboard                         | Implementados                                                                   | Contratos, navegadores, responsividade e amostra visual executados; APIs externas da UI são simuladas nos cenários de cliente                                             |

A integração do PR #141 acrescenta confirmação de parcela paga no painel e no canal: somente o pagamento novo confirmado gera despesa, com versão esperada e recibo. Atualizar um contador histórico não cria despesas retroativas. O modelo de obrigações com saldo continua distinto e não foi convertido arbitrariamente.

Detalhes: [autenticação e interface](reviews/2026-11-17/auth-ui.md),
[WhatsApp e Cakto](reviews/2026-11-17/whatsapp-cakto.md),
[dados, mídia e integrações](reviews/2026-11-17/data-media-integrations.md),
[infraestrutura](reviews/2026-11-17/infrastructure.md).

## 4. Diagnóstico e correções

| ID       | Gravidade                      | Comportamento anterior e impacto                                                                                                                                                                                     | Correção/validação                                                                                                                                                      |
| -------- | ------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| AUTH-01  | P0 condicionado à configuração | Com senha administrativa e `auth.type=none`, um cabeçalho de autenticação qualquer podia contornar o guard HTTP; WS ignorava a senha. API keys explicitamente habilitadas, mas vazias, também falhavam abertas no WS | Delegação somente quando há guard API efetivo; WS exige a proteção configurada. Dez regressões iniciais reproduzidas. Não afirmamos exposição ou exploração da produção |
| AUTH-02  | P2                             | Cookie administrativo malformado lançava exceção                                                                                                                                                                     | Decodificação inválida recusa autenticação normalmente                                                                                                                  |
| AUTH-03  | P2                             | OTP expirado conservava ciphertext quando o WhatsApp ficava offline                                                                                                                                                  | Limpeza periódica, preservando quotas, tentativas e histórico; regressão em PostgreSQL                                                                                  |
| PAY-01   | P1                             | Evento válido sem identidade segura perdia a única cópia pendente                                                                                                                                                    | Retenção criptografada em `held/v1`, sem concessão indevida; erro ao reter conserva possibilidade de recuperação                                                        |
| PAY-02   | P1                             | Aprovação atrasada podia reativar pedido reembolsado/chargeback                                                                                                                                                      | Precedência terminal do mesmo pedido; nova compra com novo pedido permanece possível; PostgreSQL real                                                                   |
| PAY-03   | P1                             | Eventos simultâneos do mesmo pedido com telefones diferentes podiam perder o conflito                                                                                                                                | Serialização também por pedido e retenção do conflito; regression de retry após commit e falha no armazenamento                                                         |
| DATA-01  | P1                             | Meta criada no WhatsApp não aparecia no modelo monetário do painel                                                                                                                                                   | Ferramentas de membro usam `customer_plans`, centavos e recibo `customer_goal_requests`; três contas e vinte replays simultâneos                                        |
| DB-01    | P1                             | SQL podia ser reaplicado após gravação concluída seguida de perda da resposta                                                                                                                                        | Removido retry implícito de SQL; erro incerto propagado. Duas reproduções de efeito duplicado; 122 testes do adaptador aprovados                                        |
| WA-01    | P1                             | SIGTERM fechava dependências sem drenar os turnos e as credenciais do canal                                                                                                                                          | Drenagem limitada, disconnect sem logout antes do banco; configuração de draining do Railway é pré-requisito separado                                                   |
| WA-02    | P2                             | Falha ao registrar convite de integração depois do envio gerava segunda resposta de erro                                                                                                                             | Falha de bookkeeping é isolada; confirmação continua exigindo registro persistido                                                                                       |
| MEDIA-01 | P2                             | Conteúdo incompatível e falhas de extração podiam chegar ao provedor ou escapar do fluxo de erro                                                                                                                     | Validação de formato/conteúdo/tamanho e resposta controlada; fixtures válidos/corrompidos                                                                               |
| MEDIA-02 | P1                             | PDF/OCR não ativava guard de conteúdo externo, podendo induzir ferramentas de escrita                                                                                                                                | Encaminhamento do marcador aos dois caminhos de agente e aos writers de despesas; regressões de bloqueio                                                                |
| UI-01    | P2                             | Resposta antiga cancelada podia publicar dados ou emitir logout por 401 obsoleto                                                                                                                                     | Preservação de AbortError e verificação após leitura do corpo; três regressões                                                                                          |
| DATE-01  | P2                             | Streak de Pomodoro interpretava data civil UTC como dia local anterior                                                                                                                                               | Cálculo por dias civis; regressões em Campo Grande, São Paulo, Tóquio e Nova York, inclusive virada de ano/DST                                                          |
| OFFER-01 | P2                             | Landing prometia e demonstrava lembretes diários recorrentes, mas o membro só agenda avisos individuais                                                                                                              | Texto, ícone e demonstração ajustados para data/hora combinadas; dois contratos reproduziram a divergência. Nenhum motor de recorrência foi acrescentado                |

A documentação de segurança também foi corrigida: o cofre criptográfico do core
não implica cifra de campo em `memories.content`. O repositório atual armazena o
conteúdo em TEXT. Controles de proprietário foram testados; criptografia de volume
e cópia externa de backup precisam de confirmação operacional. Isso não constitui
um vazamento demonstrado.

O guard de PDF/OCR tem consequência explícita de uso: conteúdo extraído pode ser
analisado, mas uma escrita exige nova mensagem explícita do usuário. O documento
não autoriza a própria alteração. A validação de mídia confere assinatura do
contêiner, MIME e limites; não constitui validação integral de todos os codecs
nem certificação de qualidade do OCR/transcritor.

### Achados adicionais na integração da principal

- **PAY-04 — P1:** a segunda pausa de uma assinatura após retomada era ignorada como duplicata. A candidata identifica transições pelo timestamp original do corpo autenticado, preserva microssegundos e retém eventos sem data, contraditórios ou anteriores ao estado conhecido. Chaves históricas de pagamentos e prazos não mudaram. A recuperação do backlog legado exige conciliação.
- **SYNC-01 — P1:** a mesma mensagem, ao alternar entre o novo atalho e a ferramenta de metas, podia criar duas metas ou somar um aporte novamente. Os dois caminhos agora compartilham um recibo canônico na mesma transação, preservando também os recibos anteriores.
- **ACCESS-01 — P1:** criação/progresso/pagamento que aguardavam locks podiam gravar após expiração. A permissão de servidor agora é reconsultada dentro da transação, após a espera e antes da escrita, incluindo parcela no painel e recebíveis no canal.

Oito cenários novos reproduziram as duas falhas de integração antes da correção. A bateria final teve **14 arquivos e 562 testes aprovados**, incluindo 18 casos PostgreSQL de metas e oito de sincronização financeira.

Os dados antigos de metas não foram arbitrariamente atribuídos ou migrados entre
proprietários. Escritas legadas administrativas são preservadas; o caminho do membro
usa o repositório monetário correto. Mudanças na regra comercial não foram inferidas
de exemplos ou memórias contraditórias.

Também foram corrigidos fixtures de DNS em testes de provedor, RSS e áudio legado.
Os mocks de HTTP usavam resolução DNS real e falhavam no ambiente restrito. A
proteção SSRF de produção foi preservada e ganhou casos explícitos de IP privado
e resposta DNS mista.

Dois ajustes P3 finais corrigem evidências/texto: `summarize-smoke.mjs` contava a
linha agregada “PASS 26 PostgreSQL screenshot scenarios” como um 27º cenário;
agora conserva exatamente os 26 títulos individuais. A correção foi executada
contra o log real do CI, com comparação dos demais campos. `CustomerRadar` passa
a exibir “1 assunto selecionado”; seus 23 testes existentes passaram. Não houve
redesenho do produto nem alteração comercial nesses ajustes.

## 5. Baseline e verificações

Runtime local: Node 24.22.1, dependências do lockfile e pnpm 10.29.3 via Corepack.
O CI usa Node 22. O PostgreSQL local embarcado é 16.4, descartável e exclusivo de
laboratório. Ele não inclui pgvector nem clientes `pg_dump`/`pg_restore`; testes
dependentes desses componentes foram encaminhados ao CI com a imagem adequada.
Os testes reais de repositórios usam PostgreSQL, não um banco em memória.

### Baseline imutável, antes das correções

| Pacote  | Resultado inicial                                                                           | Explicação das falhas                                                                   |
| ------- | ------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------- |
| Core    | 10.009 passaram; 28 falharam; 3 ignorados                                                   | DNS real em teste com HTTP simulado                                                     |
| Gateway | 23.385 passaram; 29 falharam; 1.258 ignorados; uma falha adicional de carregamento de suíte | RSS/áudio com DNS real; dois casos de data civil; smoke de subpaths exigia build prévio |
| UI      | 2.397 passaram; 1 ignorado                                                                  | Sem falhas                                                                              |
| CLI     | 434 passaram e uma suíte não carregou                                                       | Dependia do gateway compilado                                                           |

Após construir o gateway da **mesma base**, os seis testes de subpaths e os 438
testes CLI passaram. Essas duas falhas iniciais eram pré-requisitos do ambiente,
não defeitos novos do produto.

### Suítes completas, cobertura e regressões

| Verificação executada                               | Resultado                                                               | Alcance                                                                                                                                                           |
| --------------------------------------------------- | ----------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Build, typecheck, lint e formatação                 | Aprovados na rodada integrada, inclusive Linux/Windows no CI            | Código compilado e verificações estáticas; não substituem jornadas                                                                                                |
| Core, cobertura local                               | 10.039 passaram; três skips                                             | Statements 92,62%; branches 86,16%; functions 92,50%; lines 93,65%; limites 80% mantidos                                                                          |
| Gateway, cobertura local com PostgreSQL 16.4        | 24.772 passaram; sete skips; zero falhas; 162,46 s                      | 628 arquivos aprovados. Somente backup PG excluído localmente por falta dos executáveis. Vector desativado apenas no fixture local                                |
| Gateway, cobertura CI com PostgreSQL 16.16/pgvector | 23.728 passaram; 1.052 skips; zero falhas                               | 622 arquivos aprovados. Os legados que exigem outras flags foram executados no laboratório e/ou workflows específicos; não apresentar esses skips como aprovações |
| UI                                                  | 2.400 passaram; um skip                                                 | 139 arquivos; regressões de cancelamento e sessão inclusas                                                                                                        |
| CLI                                                 | 438 passaram                                                            | 14 arquivos após build das dependências                                                                                                                           |
| Cakto, Bun 1.4.4 e PostgreSQL                       | 16 passaram; zero skips/falhas                                          | HMAC, retenção criptografada, concessão, reembolso, duplicação, ordenação e retomada; eventos fabricados, S3 simulado                                             |
| Autenticação focal                                  | 432 passaram, incluindo 15 PG                                           | Três contas independentes; 12 consumos concorrentes de um OTP resultam em um sucesso; limite de cinco erros, proprietário, expiração, revogação e CSRF            |
| Planejamento integrado                              | 562 passaram em 14 arquivos                                             | Inclui 18 PG de metas, oito PG de sincronização financeira, espera por locks e recibos compartilhados                                                             |
| Memórias nativas                                    | Dez casos PG passaram                                                   | `vector(1536)`, isolamento, correção, consolidação e rollback; não certifica qualidade semântica                                                                  |
| Migração completa / boot                            | Aprovados                                                               | 32 tabelas críticas, migração idempotente, schema pgvector; readiness em aproximadamente dez segundos na candidata final                                          |
| Backup e restauração                                | Um teste PG integrado e 25 unitários aprovados, além do gate de release | Dump, restauração e arquivos privados em ambiente descartável; sem archive plaintext. Não restaura a base de produção                                             |
| Dependências de produção                            | Zero advisories retornados no workspace (527 dependências) e na landing | Consulta pontual aos registries; não é garantia de ausência de vulnerabilidades nem auditoria integral da cadeia de fornecimento                                  |

Cobertura final do gateway local: **85,58% statements, 78,10% branches, 86,05%
functions e 86,90% lines**. No CI nativo: **85,07%, 77,32%, 85,62% e 86,42%**,
respectivamente. Os limites existentes de 83/75/84/84 foram preservados. A primeira
tentativa sem banco falhou no limite de functions; uma tentativa interrompida não
produziu resultado. Ambas continuam registradas como falha de gate/inconclusiva,
sem reinterpretá-las como aprovação. A execução completa posterior resolveu a
lacuna com banco real e não com redução do limite.

Os 1.052 skips do gateway CI são: calendar-mutation 15, personal-subscriptions 511,
verification-postgres sete, personal-tasks 506, whatsapp-contact-discovery quatro,
channel-reminders-range um, reminder-selection um, Radar load quatro e startup
três. Esses arquivos foram executados com as flags adequadas no laboratório e/ou
nos workflows WhatsApp, Simulation Lab e Radar. O detalhamento por execução está
nos anexos; não somar os números sobrepostos.

### Navegadores, experiência e inspeção visual

- CI Playwright geral: **176 testes aprovados** na candidata final (175 antes da integração de branding).
- Portal do cliente: **180 cenários aprovados** em Chromium/WebKit, mais cinco
  verificações de referências/PWA; 169 testes unitários focais aprovados. Há cenários
  de erro de gravação/leitura, centavos, UTC, sessão expirada, exportação e acesso.
- Verificação adicional das telas reais React: **23 cenários aprovados**, 80
  combinações de dez rotas × quatro larguras (320/390/768/1440) × dois temas,
  zero overflow reportado e 51 screenshots. Inclui modais em 320 px, gráficos
  vazios/esparsos/negativos, conflito de versão, privacidade/tema concorrentes e
  retry de indicação. As APIs são interceptadas com dados fictícios persistentes
  no fixture; não se trata de acesso ao banco de produção.
- Landing: build, **35 contratos e 171 testes de navegador aprovados na candidata final**, com
  Chromium, WebKit e Firefox, de 320 a 1440 px, temas, teclado, movimento reduzido,
  acessibilidade automatizada e destinos públicos. A captura inicial de referências
  não existentes no Git não prova equivalência histórica de pixels.
- Auditoria de interface administrativa isolada: **59 rotas / 177 visitas**, sem
  erro/overflow reportado, mais telas críticas em dez larguras. Essa navegação não
  certifica as integrações externas de cada ferramenta administrativa.
- Inspeção visual das imagens originais: 17 capturas do painel de
  cliente (dez áreas, quatro modais, desktop e gráfico negativo), quatro da
  landing (telefone/tablet/desktop), duas da administração em tablet e login
  WebKit; outra frente inspecionou dez capturas de acesso/expiração/administração.
  Não foi identificado bloqueio visual concreto nessa amostra. O plural do Radar
  foi corrigido. Não há screenshot da etapa OTP no artifact geral: seu teste é
  funcional; não alegamos inspeção visual de uma imagem inexistente. Na candidata final foram inspecionadas mais duas amostras da landing: conversa em 320 px e demonstração financeira desktop no tema escuro. Ambas estavam legíveis; essas imagens não mostram o cenário de estudo, cuja promessa foi validada pelos contratos.

O merge de branding/PWA foi revisado separadamente. O build integrado e 248 testes de aplicação, sessão e WebSocket passaram. Uma verificação HTTP com gateway compilado, UI compilada e credenciais fictícias confirmou MIME/cache dos ícones e manifesto, cache imutável de asset com hash e recusa de credencial ausente/inválida. Evidência: [static-http-probe.json](reviews/2026-11-17/static-http-probe.json). O teste de manifesto/ícones/offline usa Chromium; não certifica instalação na tela inicial de aparelhos iOS/Android reais.

A revisão preserva o padrão visual. A landing anuncia três dias grátis para novos
contatos, sem cadastro/cartão, e R$ 19,90/mês se a pessoa assinar. Texto, áudio,
imagem, finanças, tarefas, lembretes, metas e painel têm implementação; qualidade
dos provedores e regras do checkout ainda exigem validação externa. A fila de
lembretes do membro agenda ocorrências individuais; não há motor de lembretes
arbitrários recorrentes. As rotinas diárias de saudações/Radar são específicas.
A revisão remove a promessa de “lembretes recorrentes” e a confirmação de repetição
diária da demonstração, substituindo-as por aviso em data/hora determinada, sem
criar funcionalidade. “Rotina familiar” não foi interpretada como acesso
compartilhado entre contas.

### Comandos e reprodução

Os workflows versionados contêm serviços, flags e comandos completos de execução.
Não apontar os testes PG para bancos reais: as suítes criam e removem schemas de
laboratório. Principais comandos efetivamente usados:

```bash
pnpm install --frozen-lockfile
pnpm build
pnpm typecheck
pnpm lint
pnpm format:check
pnpm --filter @ownpilot/core exec vitest run --coverage --maxWorkers=2
pnpm --filter @ownpilot/gateway exec vitest run --coverage --maxWorkers=2
pnpm --filter @ownpilot/ui exec vitest run
pnpm --filter @ownpilot/cli exec vitest run
bun test integrations/cakto/railway-function.test.mjs
pnpm --filter @ownpilot/gateway exec node --import tsx scripts/whatsapp-screenshot-smoke.ts
pnpm --filter @ownpilot/gateway exec node --import tsx scripts/customer-capacity-burst.ts /tmp/astra-http-capacity.json
```

A rodada local usa wrapper de PostgreSQL descartável; a CI usa `pgvector/pgvector:pg16`,
clientes PostgreSQL 16, Bun 1.4.4 e as variáveis de teste registradas nos workflows.
Para landing foram executados `npm ci`, `npm run build`, `npm test` e
`npm run test:browser`. Para a varredura React foi usado
`node qa-release-dashboard.mjs` sobre o build servido pelo Vite. Instalar browsers
localmente estava bloqueado por restrições do executor; as execuções ocorreram
de fato no GitHub Actions e seus artifacts foram baixados, conferidos por SHA-256
e inspecionados. O ambiente de teste não reutilizou cookies/sessões do usuário.

Contagens focais podem se sobrepor às suítes completas; não devem ser somadas como
se fossem jornadas ou testes distintos. Geração de corpus sintético foi mantida
separada de execução contra a aplicação.

### Gates do código candidato final

Os dez workflows abaixo terminaram com sucesso para `43118c019e3d08bc3adea9f4887481c09fe4ee48`.
O checkout de testes foi o merge virtual `f435e18e18e94462a3dc80c9f960516d084e2957`;
sua árvore é idêntica à do head: `3947f33a813cc38514b0a6f27013811e48549289`.
Git e a comparação pela API confirmaram zero diferenças. O job de cobertura do workflow CI geral é condicional à principal e ficou pulado;
a cobertura PG nativa foi executada e aprovada pelo workflow Member Readiness.

| Workflow                                                     | Execução final                                                             |
| ------------------------------------------------------------ | -------------------------------------------------------------------------- |
| CI — Linux, Windows, Playwright, migração e boot             | [44163054826](https://github.com/QGBALTIGO/astra/actions/runs/44163054826) |
| Member Readiness — PG/Cakto, landing e matriz de cliente     | [44163054983](https://github.com/QGBALTIGO/astra/actions/runs/44163054983) |
| Dashboard release — contratos, banco e backup/restore        | [44163054765](https://github.com/QGBALTIGO/astra/actions/runs/44163054765) |
| WhatsApp reliability                                         | [44163055100](https://github.com/QGBALTIGO/astra/actions/runs/44163055100) |
| Simulation Lab — pipeline, propriedades e HTTP               | [44163054907](https://github.com/QGBALTIGO/astra/actions/runs/44163054907) |
| Customer portal                                              | [44163055148](https://github.com/QGBALTIGO/astra/actions/runs/44163055148) |
| Touch e teclado                                              | [44163054835](https://github.com/QGBALTIGO/astra/actions/runs/44163054835) |
| Interface isolada                                            | [44163055034](https://github.com/QGBALTIGO/astra/actions/runs/44163055034) |
| Radar PG/carga/worker                                        | [44163054793](https://github.com/QGBALTIGO/astra/actions/runs/44163054793) |
| Landing — contratos, navegadores e desempenho em laboratório | [44163054881](https://github.com/QGBALTIGO/astra/actions/runs/44163054881) |

Resumo verificável: [validation-summary.json](reviews/2026-11-17/validation-summary.json),
[visual-review.json](reviews/2026-11-17/visual-review.json) e os anexos por frente.
A matriz React final repetiu 23 cenários/51 imagens; a captura do Radar corrigido
também foi inspecionada na rodada anterior identificada no registro visual. A rodada final de boot levou aproximadamente dez segundos; as rodadas anteriores levaram cerca de 16 e 6 segundos. Todas atingiram readiness no laboratório; a variação isolada não demonstra regressão ou melhoria de desempenho.

### Carga gradual medida

No head final `43118c0`, o laboratório HTTP executou ondas de 10, 50, 100, 250 e
500 contas fictícias. Foram **8.190 requisições em 910 jornadas, zero erros e zero
chamadas externas**. As 500 contas distintas são reutilizadas nas ondas; sessões
são fixtures, sem envio de OTP. Na onda de 500: 4.500 requisições em 6.923 ms,
650,03 req/s; p95 do resumo financeiro 3.134,65 ms, p95 de criação de despesa
1.556,47 ms e pico RSS Node de 371 MiB. O pico amostrado da fila chegou a
**1.852 de 2.048 posições**, terminando em zero, com 32 solicitações ativas permitidas.
Há pouca folga de fila nessa onda; não é uma meta segura de produção. A rodada anterior `f1c8b13` chegou a 1.942 posições e p95 de resumo de 3.764,92 ms. As diferenças entre bursts não demonstram melhoria de desempenho; os componentes medidos não mudaram.

O pipeline separado de mensagens com transporte simulado processou 500 operações
verificadas sem erro, p95 de serviço 463,01 ms e 1.063,09 operações/s; não mede tempo
de fila. São unidades diferentes de req/s HTTP e não devem ser comparadas diretamente.
Radar, como componente PostgreSQL/evaluator, rodou 500/2.000/5.000/10.000 contas;
na rodada integrada inicial, 10.000 contas/30.000 interesses produziram 10.000
outbox em 12.260 ms, sem divergência/duplicata. Não houve IA, fornecedor externo
ou entrega WhatsApp nessa medição.

Esses são bursts únicos em loopback/CI, sem medição de recursos do PostgreSQL,
ingresso público Railway ou carga sustentada. Não identificam isoladamente o
gargalo como banco e não comprovam capacidade de 500 membros conversando com IA.
O corpus gerado de 100 mil casos e as 18 mil iterações de propriedades sintéticas
não são 118 mil conversas reais; declararam zero model calls e zero escritas DB
nessa etapa. Detalhes: [CI WhatsApp e carga final](reviews/2026-11-17/ci-whatsapp-simulation-final.md).

## 6. Jornadas obrigatórias e evidência necessária

| Jornada                           | Evidência disponível                                      | Pendência externa                                                     |
| --------------------------------- | --------------------------------------------------------- | --------------------------------------------------------------------- |
| Primeiro contato e teste          | Repositório/serviço e concorrência em PostgreSQL          | Recepção e orientação no número de teste autorizado                   |
| Despesa WhatsApp → painel         | Parsing, roteamento e banco compartilhado                 | Mensagem e consulta autenticada no ambiente de homologação            |
| Edição painel → consulta WhatsApp | Repositórios e contratos de consulta                      | Modelo e transporte reais                                             |
| Criar/editar/cancelar lembrete    | Persistência, invalidação e recuperação de filas          | Entrega real e indisponibilidade controlada do canal                  |
| Meta e progresso                  | Três contas, mesmo repositório, replays e escopo          | Conversa real completa                                                |
| Anexo                             | Fixtures válidos, inválidos, limites, leitura e guard     | Qualidade de STT/OCR e consentimentos efetivos dos provedores         |
| Código/login/logout               | Três contas e HTTP autenticado em laboratório             | Envio do OTP por WhatsApp e login real no dispositivo                 |
| Pagamento de teste                | Webhook assinado sintético e PostgreSQL                   | Evento de teste/sandbox da Cakto e associação ao checkout configurado |
| Renovação única                   | Duplicação/ordenação no banco                             | Conferir duração/produto/período do checkout                          |
| Expiração                         | Restrição de escrita e preservação de dados               | Relógio/acesso observado no ambiente de homologação                   |
| Reinício/pendências               | Reconexão de repositórios e shutdown simulado             | Reinício do processo completo com sessão WhatsApp de teste            |
| Acesso cruzado                    | IDs/parâmetros e três contas fictícias em PostgreSQL real | Smoke da candidata publicada em homologação                           |
| Duplicatas                        | Mensagens/recibos e webhooks sintéticos                   | Duplicação do webhook de teste fornecido pelo provedor                |
| Falhas controladas                | Banco/adaptador/provedor/envio simulados e filas reais    | Ensaios externos sem tocar dados ou destinatários reais               |

## 7. Configuração, implantação e retorno

A versão candidata exige migrações aditivas: tabela `customer_goal_requests` e
índice parcial para a limpeza de OTP expirado. A atualização incorporada da principal também inclui `customer_planning_requests`, agora usado como recibo comum dos caminhos de planejamento. O smoke de migração inclui a nova
tabela. Não há migração destrutiva nem reatribuição de registros legados.

Antes de publicar:

1. Resolver todos os gates da candidata e registrar o SHA exato aprovado.
2. Confirmar `AUTH_TYPE`, segredo estável de OTP/sessão, chaves de criptografia,
   proteção administrativa, limites e feature flags sem divulgar seus valores.
3. Configurar tempo de draining do Railway compatível com o encerramento: proposta
   `RAILWAY_DEPLOYMENT_DRAINING_SECONDS=30`, uma réplica e overlap zero. A documentação
   oficial informa default zero; a leitura atual não mostrou essa variável nem
   configuração de draining. Não foi alterada produção nesta revisão.
4. Gerar backup criptografado do banco e `/app/data`, verificar sua restauração em
   banco separado e manter cópia externa ao próprio volume que se pretende proteger.
5. Publicar imagem imutável do gateway; publicar separadamente receiver e worker
   Cakto usando o mesmo arquivo revisado. Não misturar versão nova do receiver com
   worker antigo ao verificar retenção/recuperação. Publicar também a landing separada com a oferta corrigida, usando o bundle revisado; a imagem do gateway não atualiza essa Function.
6. Validar readiness, configuração, migrações e as jornadas externas com contas e
   destinatários de teste autorizados. Somente depois admitir membros do piloto.

Retorno: conservar a imagem anterior, os códigos anteriores das duas Functions Cakto e o bundle anterior da landing,
interromper novas admissões/envios durante a troca e voltar aos artefatos anteriores
sem apagar as tabelas aditivas. Não restaurar um backup antigo sobre o banco vivo
por rotina, pois isso perderia dados posteriores. A versão anterior contém os
defeitos descritos; um rollback por incidente exige manter o acesso restrito e
conciliar mensagens/pagamentos de resultado incerto.

Fontes operacionais: [Railway — teardown](https://docs.railway.com/deployments/deployment-teardown),
[variáveis](https://docs.railway.com/variables/reference),
[healthchecks e volumes](https://docs.railway.com/deployments/healthchecks),
[Cakto — webhooks](https://docs.cakto.com.br/conceitos/webhooks),
[node-postgres — transações](https://node-postgres.com/features/transactions).

## 8. Pendências reais e parecer de liberação

**Ainda não apto, com os bloqueios identificados abaixo.** As falhas P0/P1
confirmadas e reproduzidas nesta revisão foram corrigidas no código candidato.
Isso não elimina gates críticos não executados nem transfere as correções à
produção. Ausência de falha nos testes disponíveis não prova ausência de todos
os defeitos possíveis.

| Gate                                         | O que falta e por quê                                                                                                                                                                                                          | Impede liberação?                                        | Evidência necessária para encerrar                                                                                                                                                                                                   |
| -------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | -------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| G1 — WhatsApp, OTP e IA reais                | Não foram fornecidos três números/destinatários de teste autorizados nem sessão de homologação para enviar/receber. Transportes e modelos foram simulados                                                                      | **Sim, funções essenciais**                              | Três contas independentes percorrem contato/trial, despesa↔painel, correção, meta, OTP/login/logout, expiração e falha controlada com modelo e transporte reais; conferir banco e resposta                                           |
| G2 — Cakto externo e regra comercial         | Nenhum evento desta revisão veio da plataforma Cakto/checkout. Produto, período e campos temporais das transições precisam de confirmação                                                                                      | **Sim para assinantes e concessão automática**           | Evento de teste autenticado e associado à conta correta, replay, renovação, reversão e falha de aviso. Confirmar produto/periodicidade e conciliar dados retidos/legados                                                             |
| G3 — Recuperação com sessão real             | Encerramento em teste drena turnos, mas não houve reinício completo conectado ao WhatsApp. O adaptador não consome confirmação final de entrega; queda abrupta após persistir entrada não tem reexecução transacional genérica | **Sim, gate de recuperação**                             | Reiniciar homologação antes/depois da operação e lembrete, indisponibilizar/reconectar o canal, conferir credenciais, filas, efeitos e resultados incertos. Definir conciliação manual de efeito ambíguo sem repetir automaticamente |
| G4 — Configuração e preservação operacionais | Valores das variáveis foram ocultados; presença dos nomes não prova chaves estáveis, diretório correto, limites ou configuração administrativa. Draining não aparece configurado. Restore testou dados fictícios               | **Sim**                                                  | Verificar valores sem divulgá-los; uma réplica, overlap zero, draining compatível; confirmar volume `/app/data`, chave, espaço, backup com rótulo novo, cópia externa e restauração isolada de um snapshot operacional               |
| G5 — Versão publicada                        | Produção executa `6d939b2`, candidata é `43118c0`; receiver/worker Cakto e landing são artefatos separados                                                                                                                     | **Sim para afirmar funcionamento corrigido em produção** | Aprovar/publicar depois dos gates, atualizar gateway, ambas Functions Cakto e landing coerentemente, verificar health e repetir smoke com contas autorizadas                                                                         |
| R1 — Mídia e integrações opcionais           | Qualidade de STT/visão/Gemini, OAuth/Composio, cotações e notificações Radar externas não foi exercitada                                                                                                                       | Restringe os recursos respectivos                        | Testar provedores com dados fictícios e permissões corretas; manter fora do piloto as integrações não validadas                                                                                                                      |
| R2 — Recursos parciais/legados               | Lembretes arbitrários recorrentes não estão implementados no caminho do membro; calendário legado é parcial; metas antigas em percentual não têm alvo monetário confiável; compartilhamento familiar não foi encontrado        | Não bloqueia o núcleo se a oferta for explícita          | Preservar dados legados, não prometer funções ausentes, cadastrar meta monetária somente com informação explícita; não converter propriedade ou valores por suposição                                                                |
| R3 — Memórias e capacidade                   | Armazenamento vetorial nativo passou, mas qualidade semântica/HNSW e carga sustentada externa não foram medidas; `memories.content` não tem cifra de campo                                                                     | Restringe garantias sobre esses aspectos                 | Confirmar proteção de volume/backup e avaliar recuperação com dados de teste; medir IA, WhatsApp, banco e ingresso separadamente durante homologação                                                                                 |

G1 não é falta de autorização genérica para testes: o usuário já a concedeu.
Faltam destinatários identificados que possam receber mensagens externas com
segurança e o ambiente correspondente. Não foram usadas pessoas reais como teste
nem enviados códigos a números inferidos. G2 não autoriza cobrança real.

Há uma diferença a conciliar entre a referência de renovação manual preservando
dias restantes e o contrato atual da integração Cakto, que usa `paidAt + 30 dias`.
Isso não foi classificado como defeito comercial confirmado: pode haver regras
distintas para os dois caminhos. A revisão preserva o comportamento existente
até confirmar o contrato do checkout. Pausas/retomadas sem data original confiável
permanecem em `held_*`; o histórico antigo não é reconstruído por suposição.

Migração nativa, backup/restauração de laboratório, layout e navegadores deixaram
de ser bloqueios de execução: os gates correspondentes passaram. A pendência de
backup em G4 é a configuração e uma cópia operacional real, não falta de teste do
mecanismo. Nenhuma área crítica não testada foi convertida em aprovação.

## 9. Plano de implantação e acompanhamento do piloto

A candidata está pronta para revisão de código e homologação controlada. Não há
aprovação de publicação de produção nesta conversa, e os gates acima ainda não
justificam solicitá-la como se a liberação estivesse pronta.

Depois de encerrar G1–G4, a recomendação é começar com **cinco a dez membros
convidados**, uma única sessão/réplica WhatsApp, suporte próximo e expansão por
evidência. Esse número é uma proposta conservadora de operação, não uma capacidade
medida de produção. Mídia ou integrações opcionais podem permanecer restritas até
sua validação; o núcleo de login, dados, lembretes e acesso pago precisa passar.

Antes da implantação, registrar imagem imutável candidata, códigos receiver/worker, bundle da landing,
configuração efetiva, rótulo e local do backup, resultado da restauração e imagem
anterior (na leitura final, `sha-6d939b2...`, não mais `sha-7915ecd...`). A adição
das tabelas de recibo é compatível com retorno sem apagá-las. Não executar uma
restauração destrutiva como rollback de rotina. Nunca reaplicar pagamentos ou
mensagens de efeito incerto só porque houve timeout.

Nos primeiros membros, acompanhar: falhas de login e entrega de OTP; tempo de
resposta por etapa; idade/profundidade das filas e rejeições; escritas sem recibo;
lembretes atrasados/cancelados; avisos aceitos pelo adaptador versus entrega
observável; eventos Cakto `pending/held/failed`; datas de grants; reconexões;
consumo de banco/volumes e sucesso/idade do backup. Qualquer acesso cruzado,
concessão indevida, perda ou duplicação essencial exige interromper novas
admissões e conciliar o efeito antes de retomar.

O relatório distingue **código corrigido**, **código validado em laboratório/CI**,
**versão publicada** e **funcionamento verificado externamente**. Somente os dois
primeiros receberam as correções e evidências desta missão; a verificação final
com os serviços externos permanece explicitamente bloqueada.
