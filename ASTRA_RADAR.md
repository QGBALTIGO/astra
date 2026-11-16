# Astra Radar — primeira entrega

Estado deste documento: implementação em revisão; publicação ainda não confirmada. Evidências abaixo foram obtidas em 16/11/2026. Não representam capacidade medida da infraestrutura de produção.

## O que esta entrega oferece

Área nativa `/cliente/radar`, com os componentes, cores, temas e navegação do painel. Cada conta escolhe seus assuntos, ativa ou pausa acompanhamentos, altera regras, exclui interesses e consulta o histórico. Os envios começam desativados. Adicionar um assunto não autoriza mensagens: é necessário salvar a opção de receber o Radar no WhatsApp.

O resumo reúne os acompanhamentos diários em uma mensagem. Também há aviso antecipado para jogos/episódios e comparação determinística de taxas com um valor, sem chamadas de IA. Horário diário, período de silêncio e apresentação respeitam o fuso da conta. Fontes, data da consulta e, quando disponível, data do dado são preservadas. Não se confirma uma alteração antes da persistência.

Pelo WhatsApp, `meu Radar` consulta a lista e `parar meu Radar` desativa novos envios, inclusive com acesso vencido. Pedidos ambíguos sobre lembretes não são interceptados. A criação de assuntos nesta entrega ocorre pelo Dashboard, onde o usuário escolhe o resultado exato da busca.

## Fontes e limites do escopo

| Categoria           | Fonte gratuita                                                                                     | Entregue                                                                     | Restrição real                                                                                                                                    |
| ------------------- | -------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------- |
| Clima               | [MET Norway](https://api.met.no/doc/TermsOfService)                                                | Previsão de temperatura e chuva nas próximas 24h, busca de cidades existente | Modelo, não medição ou alerta oficial; CC BY 4.0 e atribuição OSM para geocodificação                                                             |
| PTAX                | [Banco Central](https://dadosabertos.bcb.gov.br/dataset/taxas-de-cambio-todos-os-boletins-diarios) | Fechamento de venda e limiares                                               | Referência de fechamento, não dólar negociável ao vivo; ODbL                                                                                      |
| Moedas              | [Frankfurter](https://frankfurter.dev/)                                                            | Taxas diárias combinadas e limiares                                          | Sem promessa de cotação de negociação em tempo real                                                                                               |
| Futebol             | [football-data.org](https://www.football-data.org/coverage)                                        | Adaptador BSA, busca de equipes, calendário, resultados e aviso prévio       | Depende de chave gratuita e aceite dos termos pelo operador; desligado sem ambos; sem gols ao vivo, escudos ou outras ligas nesta fase            |
| Notícias            | [GDELT](https://www.gdeltproject.org/)                                                             | Manchetes/links em português por assunto nas últimas 24h                     | Conteúdo das matérias mantém direitos próprios; não se busca nem armazena o texto integral; manchete não é fato verificado                        |
| Séries              | [TVmaze](https://www.tvmaze.com/api)                                                               | Próximo episódio e aviso prévio quando existe horário                        | CC BY-SA e atribuição; data global não garante estreia no Brasil                                                                                  |
| Editais/comunicados | [Querido Diário](https://queridodiario.ok.org.br/)                                                 | Municípios cobertos + assunto, metadados e link oficial                      | Cobertura parcial; não é catálogo completo de concursos; sem trechos com dados pessoais                                                           |
| Energia             | [ANEEL](https://dadosabertos.aneel.gov.br/dataset/bandeiras-tarifarias)                            | Mudanças da bandeira tarifária no mês brasileiro vigente                     | ODbL; não calcula conta de energia; primeira leitura estabelece referência                                                                        |
| Tecnologia          | [GitHub REST](https://docs.github.com/en/rest/releases/releases#get-the-latest-release)            | Mudanças da última release estável pública                                   | Acesso anônimo apenas; orçamento conservador de uma requisição/65s para todo o Astra; sem token privado do operador, assets ou download de código |

Nenhum plano pago foi contratado. Taxa de API zero não significa infraestrutura gratuita: o worker, banco, rede e o canal continuam sujeitos aos custos e limites existentes. Fórmula 1, cripto, investimentos B3, vagas e outras categorias da pesquisa ficam para fases posteriores; não existem integrações fictícias para preencher catálogo.

## Arquitetura e isolamento

- **Gateway existente:** autenticação, APIs privadas, Dashboard e único remetente WhatsApp. O Radar usa a integração existente; não cria nova sessão nem mecanismos para contornar antispam.
- **`astra-radar-worker`:** executa somente coleta de dados públicos e avaliação de regras. Comando `node packages/gateway/dist/radar-worker.js`. Deve ser configurado antes de anexar a imagem para não iniciar um segundo gateway.
- **PostgreSQL existente:** seis tabelas aditivas. `radar_resources`, `radar_http_cache` e `radar_provider_limits` guardam somente dados públicos minimizados. Preferências, interesses e outbox são privados por `data_user_id` estável. Chaves estrangeiras compostas impedem relacionar aviso de uma conta ao interesse de outra. A exclusão futura da conta propaga para as tabelas privadas.
- **Cache compartilhado:** a mesma fonte/alvo divide coleta entre seguidores. URL pública idêntica divide também a resposta HTTP entre recursos, como o calendário BSA usado por vários times. Limiares pessoais, telefone e histórico privado não entram no cache público. A data original da resposta em cache não é renovada quando outro recurso a consome.
- **Fila persistente:** deduplicação por conta/evento, leases com tokens, recuperação após reinício e cancelamento por revisão de preferências/interesse. Cancelamento e autorização final do envio usam o mesmo lock da conta. Opt-out não pode retirar uma mensagem já em transmissão.
- **Entrega:** uma tentativa de Radar a cada cinco segundos globalmente. Antes do envio, verifica assinatura, opt-in, revisão, fonte, validade, silêncio, número atual e vínculo da conta. Uma rejeição comprovadamente anterior ao envio pode repetir; envio incerto vira `unknown` e não repete automaticamente. Não se promete exactly-once no WhatsApp.
- **Segurança externa:** HTTPS, allowlist de host **e rota**, sem redirects, limite de corpo, timeout de 15s em coleta de fundo, rate limit global e backoff de 429. Sem acesso arbitrário a URLs, sem execução de conteúdo externo e sem uso de IA para processar os feeds.
- **Retenção:** avisos terminais 30 dias; HTTP cache não utilizado 7 dias; recursos públicos órfãos são limpos após o período configurado no repositório. Não foram apagados dados reais.

O resumo do Radar é próprio. Nesta fase ele não altera o bom-dia existente nem agrega conteúdo privado de Gmail/agenda ao cache de fontes públicas. Nenhum limite de tokens por conta foi introduzido.

## Configuração e publicação

1. Validar CI e construir a imagem do commit revisado pelo fluxo existente.
2. Atualizar primeiro o gateway e verificar `/health/ready`. O esquema novo é criado de forma aditiva; nenhuma tabela comercial existente é removida.
3. Criar serviço vazio `astra-radar-worker`; configurar seu comando antes de anexar a imagem e referenciar somente o banco existente. `POSTGRES_POOL_SIZE=2`, uma réplica, sem domínio público e sem credenciais WhatsApp/IA/Cakto.
4. Usar a mesma imagem imutável no worker. Verificar inicialização, estabilidade, erros e consumo; nenhum cliente é inscrito automaticamente.
5. Publicação inicial depende de aprovação das verificações. Reverter a imagem para o SHA anterior e/ou definir `ASTRA_RADAR_ENABLED=false` nos dois processos interrompe o recurso sem apagar configurações ou exigir migração reversa destrutiva.

Variáveis opcionais:

- `ASTRA_RADAR_ENABLED=false`: manutenção; desativa coletores, entregas e novos assuntos, preservando leitura/pausa/exclusão.
- `ASTRA_RADAR_WHATSAPP_CHANNEL_ID`: necessário se houver mais de um descritor WhatsApp; sem seleção inequívoca, a fila espera.
- `ASTRA_RADAR_FOOTBALL_KEY` e `ASTRA_RADAR_FOOTBALL_APPROVED=true`: somente após obter a chave gratuita e conferir os termos para o uso comercial pretendido. Precisam existir nos processos que buscam/coletam/avaliam/entregam futebol. Sem isso o Dashboard informa indisponibilidade.
- Não configurar token GitHub do operador para o Radar. Acesso anônimo é deliberado para preservar a fronteira de repositórios privados.

## Evidências de correção e validação

| Achado                                       | Reprodução                                                                                                   | Correção                                                     | Regressão                                       |
| -------------------------------------------- | ------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------ | ----------------------------------------------- |
| RAD-001: BCB HTTP 400                        | Consulta real retornou erro de tipo e ordenação com `+` no OData; mesma consulta com `%20` retornou HTTP 200 | Codificação de espaços compatível com Olinda                 | Contrato e consulta pública real                |
| RAD-002: cancelamento concorrente            | PostgreSQL autorizava envio lendo preferências antigas durante opt-out não commitado                         | Lock transacional comum antes da autorização final           | Teste RED reproduziu; GREEN com PostgreSQL real |
| RAD-003: chuva incorreta                     | Horas parciais e pontos duplicados somavam mais de 24h; horizonte incompleto aparentava completo             | Deduplicação, ponderação por intervalo e cobertura           | Testes RED/GREEN                                |
| RAD-004: mês errado em UTC                   | 01h UTC de dezembro ainda é novembro no Brasil                                                               | Competência ANEEL e dia PTAX em America/Sao_Paulo            | Teste RED/GREEN                                 |
| RAD-005: cache aparentava atualização nova   | Recurso diferente podia reusar a resposta com nova data de consulta                                          | Propagação de timestamps do cache e expiração limitada       | Contratos + HTTP real com PostgreSQL            |
| RAD-006: repetição de envio incerto          | Exceções pós-transporte não distinguem não enviado de resultado desconhecido                                 | Classe de rejeição pré-envio confiável; `unknown` sem replay | Testes de transporte simulado + recuperação PG  |
| RAD-007: dados externos inválidos            | ID de jogo ausente e números de episódio nulos                                                               | IDs de origem validados e metadados desconhecidos omitidos   | Testes RED/GREEN                                |
| RAD-008: credencial privada no cache público | Operador pode possuir token GitHub com escopo privado                                                        | Radar anônimo, nenhuma herança de token                      | Teste negativo explícito                        |

Resultados locais concluídos antes do commit final: 197 testes de regras/provedores/canais, 125 testes da área do cliente e 53 testes com PostgreSQL real passaram, sem testes ignorados nessas execuções selecionadas. O benchmark separado passou nos quatro tamanhos. TypeScript, builds gateway/UI e lint dos arquivos novos/alterados também foram executados. O CI final e a publicação precisam ser registrados após conclusão; não inferir aprovação a partir deste documento.

Validação visual local: Chromium headless, 320/375/430/768/1024/1440 px, claro/escuro, tela principal, catálogo e regra de valor. As 12 combinações verificaram ausência de overflow horizontal, seis entradas móveis/sete desktop e acesso móvel ao Radar. Dados sintéticos; nenhum código de login, mensagem ou registro real foi criado.

Consultas públicas reais: MET Norway, BCB, Frankfurter, TVmaze (nenhum episódio agendado é resultado válido), ANEEL e GitHub responderam com sucesso. GDELT e Querido Diário retornaram HTTP 503 nesta estação/rota; permanecem dependências externas instáveis, com erro explícito e nova tentativa controlada. Futebol não foi testado contra a API autenticada porque não há chave configurada. Não confundir mocks com validação do provedor real.

## Benchmark de componente, não de capacidade comercial

PostgreSQL local isolado, três recursos sintéticos compartilhados por todas as contas, três interesses por conta, um resumo por conta. Nenhuma API ou transporte foi chamado. Medidas de uma execução, sem comparação de antes/depois e sem garantia de SLA:

| Contas | Interesses | Avaliação total | p50 por lote de 100 |       p95 |       p99 | Erros de enfileiramento |
| -----: | ---------: | --------------: | ------------------: | --------: | --------: | ----------------------: |
|    500 |      1.500 |          682 ms |           129,95 ms | 142,46 ms | 142,46 ms |                       0 |
|  2.000 |      6.000 |        1.955 ms |            86,03 ms | 138,02 ms | 146,34 ms |                       0 |
|  5.000 |     15.000 |        6.288 ms |           122,09 ms | 161,12 ms | 164,02 ms |                       0 |
| 10.000 |     30.000 |       17.188 ms |           167,09 ms | 222,40 ms | 248,77 ms |                       0 |

O processo registrou heap entre 50–71 MiB nessas etapas; não é RAM total/RSS de produção. Os testes também repetem a avaliação e exigem zero avisos duplicados. A execução contínua real tem o intervalo de paginação do worker, que não está incluído no tempo total acima.

O gargalo de grande distribuição é o canal: a política inicial de 5s entre tentativas permitiria no máximo 720 tentativas/h, sem representar limite oficial ou taxa segura garantida. Um pico de 2.000 destinatários levaria pelo menos 2h46 e alguns avisos expirariam. Por isso não se deve anunciar gols ao vivo, ativar todos automaticamente ou declarar suporte real a 10 mil notificações simultâneas com base neste benchmark.

## Como reproduzir

Use Node 22.22+ e `pnpm@10.29.3` do Corepack. `pnpm install --frozen-lockfile`, build do core, testes e builds existentes. O workflow `astra-radar.yml` provisiona um PostgreSQL **de teste** `astratest_radar`, role `astratest`, senha sintética `radar-local-tests-only` e porta 5432. Os testes criam e removem somente databases `radar_lab_<uuid>` sob essa instância verificada.

```
ASTRA_RADAR_TEST_PORT=5432 pnpm --filter @ownpilot/gateway exec vitest run src/db/repositories/customer-radar.pg.test.ts src/services/radar/http.pg.test.ts src/routes/customer/radar.pg.test.ts
ASTRA_RADAR_TEST_PORT=5432 ASTRA_RADAR_LOAD_TEST=true pnpm --filter @ownpilot/gateway exec vitest run src/services/radar/load.pg.test.ts
pnpm --filter @ownpilot/ui exec vitest run src/pages/customer
pnpm --filter @ownpilot/ui exec playwright test e2e/customer-radar.spec.ts
```

Sem o banco controlado, suites PG são ignoradas por design e **não contam como aprovadas**. Não apontar essas variáveis para produção. O CI dedicado executa explicitamente as suites com o banco disponível.

## Pendências e evolução

- Chave/termos futebol; conferência autenticada da cobertura BSA e atrasos do plano gratuito.
- Verificar recuperação de GDELT e Querido Diário na região de execução antes de promover essas fontes como confiáveis.
- Ensaiar WhatsApp com contato de teste autorizado e medir entrega/receipt/desconexão; não foi feito envio em massa.
- Monitorar uso real e fila. Antes de crescimento comercial, negociar a estratégia do canal e testar muitas fontes distintas, não só recursos compartilhados.
- Novas fases: criação de regras por linguagem natural com confirmação apenas quando ambígua, resumo semanal, F1, fontes oficiais adicionais e união opcional com bom-dia. Reutilizar adaptadores/contratos, sem reescrever o painel nem adicionar IA ao polling.
