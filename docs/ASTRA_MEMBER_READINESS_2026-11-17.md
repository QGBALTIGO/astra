# Astra — revisão para liberação de membros

Data: 17 de novembro de 2026, America/Campo_Grande.

> Documento de trabalho da versão candidata. Os resultados de CI e o identificador
> final da versão serão registrados antes de encerrar a revisão. Esta branch não
> foi publicada em produção. Aprovação de build, testes simulados ou geração de
> cenários não equivale a confirmação de funcionamento com WhatsApp, IA e Cakto reais.

## 1. Escopo, versões e preservação

Repositório: `QGBALTIGO/astra`. Branch da revisão:
`audit/member-readiness-20261117`. Base imutável:
`7915ecdd9933b55183b511f5718030b1d34e5304`, merge do PR #140.

Foi criado um checkout isolado para as correções e um worktree da base para
comparação. Os checkouts anteriores, inclusive alterações de landing sem commit,
foram preservados. Não foram feitas cobranças, envios para contatos reais,
alterações de assinaturas, restaurações de produção ou publicações.

A consulta somente leitura ao Railway identificou:

| Componente              | Versão/configuração observada                                                                                                                                                       |
| ----------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Gateway                 | Imagem `ghcr.io/qgbaltigo/astra:sha-7915ecdd9933b55183b511f5718030b1d34e5304`; deployment `1f0174f2-e6d8-4fd4-8640-6473c6a06c2e`, bem-sucedido em 17/11 às 14:01 no fuso do usuário |
| Réplicas e persistência | Uma réplica em `iad`, volume `/app/data` de 500 MB                                                                                                                                  |
| PostgreSQL              | Serviço `astra-postgres`, imagem `pgvector/pgvector:pg16`, volume persistente de 500 MB; versão patch do servidor não consultada                                                    |
| Cakto                   | Receiver `astra-cakto-webhook` e worker `astra-svg-preflight-temp`, ambos Bun 1.4.4; worker a cada cinco minutos; inbox privado em bucket separado                                  |
| Código das Functions    | Receiver e worker correspondiam ao arquivo da base após remover whitespace nas extremidades; as Functions são publicadas separadamente da imagem do gateway                         |
| Landing                 | Railway Function separada, Bun 1.4.4; conteúdo consultado sem alteração                                                                                                             |
| Configuração            | Não havia mudanças staged; variáveis consultadas com valores ocultos pelo conector                                                                                                  |

O endpoint público `/api/v1/auth/status` informou senha configurada e sessão não
autenticada. `/api/v1/customer/auth/me` recusou acesso sem sessão (401).
`/health/ready` respondeu `ready`; `/health` respondeu `degraded` com HTTP 200.
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
- Webhooks Cakto autenticados são registrados em armazenamento criptografado antes
  da confirmação de recebimento. Eventos sem associação segura ficam retidos para
  conciliação, sem conceder acesso por suposição.
- Arquivos de sessão, chaves e anexos privados precisam do volume persistente;
  os testes usam diretórios e credenciais exclusivamente sintéticos.

## 3. Inventário funcional

“Implementado” descreve existência no código, não certificação externa em produção.
Os inventários detalhados e limites de cada frente estão nos documentos vinculados.

| Área                             | Situação encontrada                                                             | Validação e limite                                                                                                                            |
| -------------------------------- | ------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------- |
| WhatsApp e acesso                | Implementado; deduplicação, serialização por sessão, teste e controle de acesso | Regressões locais e PostgreSQL; conexão, entrega e reinício com conta real pendentes                                                          |
| Login por telefone/OTP e sessões | Implementado                                                                    | Três contas reais de laboratório, OTP concorrente, revogação, expiração, CSRF e isolamento                                                    |
| Administração HTTP/WebSocket     | Implementada separadamente                                                      | Bypass condicionado à configuração reproduzido e corrigido; configuração efetiva de produção ainda precisa ser confirmada                     |
| Teste de três dias               | Implementado para contatos novos elegíveis, uma vez por identidade              | Concorrência e persistência exercitadas; contatos históricos não recebem novo teste arbitrariamente                                           |
| Cakto                            | Implementado com inbox, worker, idempotência e retenção de casos ambíguos       | Bun e PostgreSQL reais no laboratório; compra de teste externa e configuração do checkout pendentes                                           |
| Finanças/categorias/relatórios   | Implementados                                                                   | Testes de parsing, centavos, replays, proprietário e consistência do painel; referências nos testes da frente de dados                        |
| Agenda/tarefas/lembretes         | Implementados                                                                   | Persistência, edição/cancelamento e filas testados em laboratório; entrega real e fuso/dispositivo externos pendentes                         |
| Recorrência de calendário        | Parcial/legada                                                                  | Campo legado existe; portal não oferece criação de recorrência, e mutação pelo canal recusa eventos recorrentes                               |
| Metas monetárias                 | Implementadas, com integração corrigida nesta branch                            | Antes havia estruturas diferentes no WhatsApp e painel; agora usa planos do cliente e recibos idempotentes                                    |
| Memórias/histórico               | Implementados                                                                   | Escopo e persistência revisados; busca vetorial depende de pgvector e avaliação de qualidade com modelo real                                  |
| Áudio/imagem/PDF                 | Implementados com limites                                                       | MIME/conteúdo, tamanho, PDF válido/corrompido e guard de conteúdo externo; qualidade real de STT/OCR não certificada                          |
| Integrações                      | Implementação parcial e controlada                                              | Google Calendar de `/customer/integrations` desativado; fluxo separado de contas conectadas existe, condicionado a configuração e autorização |
| Radar                            | Implementado                                                                    | Testes de banco/isolamento e avaliação sintética; fornecedores e notificações reais pendentes                                                 |
| Investimentos                    | Implementado para carteira/lançamentos e avaliação                              | Banco e contratos locais; preços/provedores e comportamento externo não certificados                                                          |
| Indicações/afiliados             | Implementado com aprovação/pagamento manual                                     | Não constitui pagamento automático a afiliados; sem transferência real nesta revisão                                                          |
| Família/compartilhamento         | Não identificado como fluxo operacional do cliente                              | Não apresentado como recurso liberado                                                                                                         |
| Landing/dashboard                | Implementados                                                                   | Landing consultada e contratos revisados; matriz visual da candidata em execução no CI                                                        |

Detalhes: [autenticação e interface](reviews/2026-11-17/auth-ui.md),
[WhatsApp e Cakto](reviews/2026-11-17/whatsapp-cakto.md),
[dados, mídia e integrações](reviews/2026-11-17/data-media-integrations.md).

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

A documentação de segurança também foi corrigida: o cofre criptográfico do core
não implica cifra de campo em `memories.content`. O repositório atual armazena o
conteúdo em TEXT. Controles de proprietário foram testados; criptografia de volume
e cópia externa de backup precisam de confirmação operacional. Isso não constitui
um vazamento demonstrado.

Os dados antigos de metas não foram arbitrariamente atribuídos ou migrados entre
proprietários. Escritas legadas administrativas são preservadas; o caminho do membro
usa o repositório monetário correto. Mudanças na regra comercial não foram inferidas
de exemplos ou memórias contraditórias.

Também foram corrigidos fixtures de DNS em testes de provedor, RSS e áudio legado.
Os mocks de HTTP usavam resolução DNS real e falhavam no ambiente restrito. A
proteção SSRF de produção foi preservada e ganhou casos explícitos de IP privado
e resposta DNS mista.

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

### Verificações concluídas até este registro

- Build dos quatro pacotes: aprovado.
- Typecheck global: aprovado.
- Auditoria de dependências de produção: 527 dependências, nenhum advisory retornado
  pelo registry na consulta. Isso não constitui prova de ausência de vulnerabilidades.
- Autenticação: 432 testes focais, incluindo 15 em PostgreSQL e três contas.
- API/UI cancelada: 36 testes focais aprovados.
- Adaptador PostgreSQL: 122 testes aprovados, inclusive falha após efeito persistido.
- Correções de data/RSS/áudio legado: 300 testes aprovados.
- Provedor/SSRF: 160 testes aprovados.
- Cakto, mídia, metas, shutdown, testes globais e CI: resultados finais nos anexos e
  no registro de validação que acompanha o commit candidato.

Contagens focais podem se sobrepor às suítes completas; não devem ser somadas como
se fossem jornadas ou testes distintos. Geração de corpus sintético foi mantida
separada de execução contra a aplicação.

## 6. Jornadas obrigatórias e evidência necessária

| Jornada                           | Evidência disponível                                   | Pendência externa                                                     |
| --------------------------------- | ------------------------------------------------------ | --------------------------------------------------------------------- |
| Primeiro contato e teste          | Repositório/serviço e concorrência em PostgreSQL       | Recepção e orientação no número de teste autorizado                   |
| Despesa WhatsApp → painel         | Parsing, roteamento e banco compartilhado              | Mensagem e consulta autenticada no ambiente de homologação            |
| Edição painel → consulta WhatsApp | Repositórios e contratos de consulta                   | Modelo e transporte reais                                             |
| Criar/editar/cancelar lembrete    | Persistência, invalidação e recuperação de filas       | Entrega real e indisponibilidade controlada do canal                  |
| Meta e progresso                  | Três contas, mesmo repositório, replays e escopo       | Conversa real completa                                                |
| Anexo                             | Fixtures válidos, inválidos, limites, leitura e guard  | Qualidade de STT/OCR e consentimentos efetivos dos provedores         |
| Código/login/logout               | Três contas e HTTP autenticado em laboratório          | Envio do OTP por WhatsApp e login real no dispositivo                 |
| Pagamento de teste                | Webhook assinado sintético e PostgreSQL                | Evento de teste/sandbox da Cakto e associação ao checkout configurado |
| Renovação única                   | Duplicação/ordenação no banco                          | Conferir duração/produto/período do checkout                          |
| Expiração                         | Restrição de escrita e preservação de dados            | Relógio/acesso observado no ambiente de homologação                   |
| Reinício/pendências               | Reconexão de repositórios e shutdown simulado          | Reinício do processo completo com sessão WhatsApp de teste            |
| Acesso cruzado                    | IDs/parâmetros e três contas reais de laboratório      | Smoke da candidata publicada em homologação                           |
| Duplicatas                        | Mensagens/recibos e webhooks sintéticos                | Duplicação do webhook de teste fornecido pelo provedor                |
| Falhas controladas                | Banco/adaptador/provedor/envio simulados e filas reais | Ensaios externos sem tocar dados ou destinatários reais               |

## 7. Configuração, implantação e retorno

A versão candidata exige migrações aditivas: tabela `customer_goal_requests` e
índice parcial para a limpeza de OTP expirado. O smoke de migração inclui a nova
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
   worker antigo ao verificar retenção/recuperação.
6. Validar readiness, configuração, migrações e as jornadas externas com contas e
   destinatários de teste autorizados. Somente depois admitir membros do piloto.

Retorno: conservar a imagem anterior e os códigos anteriores das duas Functions,
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

## 8. Pendências de liberação e parecer provisório

**Ainda não apto para admitir membros nesta etapa da revisão.** Os testes externos
essenciais não foram autorizados com destinatários/contas de teste identificados,
e a candidata ainda está passando pelos gates finais. A existência de código
corrigido não significa que produção já o executa.

Pendências críticas: E2E real WhatsApp/OTP/IA, evento Cakto de teste, confirmação de
configuração administrativa e comercial, implantação coerente das três unidades,
recuperação com sessão real, e validações finais de migração/backup/interface.

Há divergência a conciliar entre a referência de renovação manual preservando dias
restantes e o contrato atual da integração Cakto, que usa `paidAt + 30 dias`. A regra
Cakto não foi alterada por suposição. Produto, periodicidade e comportamento de
renovação do checkout devem ser confirmados antes de admitir assinantes.

Mesmo após resolver os bloqueios, o piloto deve começar com poucos membros, uma
única instância WhatsApp, acompanhamento de operações sem recibo, idade das filas,
eventos Cakto retidos, envios incertos, erros de login e consumo dos volumes.
Testes locais com IA e transportes simulados não estimam a capacidade de atendimento
real dos provedores ou do WhatsApp.
