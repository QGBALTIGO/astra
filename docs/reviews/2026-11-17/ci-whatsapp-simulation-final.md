# Evidência final de CI — WhatsApp e laboratório isolado

A candidata mais recente validada nesta frente é `43118c019e3d08bc3adea9f4887481c09fe4ee48`. As seções iniciais preservam as medições de `f1c8b13`; a seção final registra a revalidação e os novos artefatos de `43118c0`, sem misturar os resultados entre commits.

## Rodada f1c8b13 — resultados preservados

- Código avaliado: `f1c8b1302ce511102fa0e74ee6a36bcadb9df3d2`.
- [WhatsApp reliability, run 44159910697](https://github.com/QGBALTIGO/astra/actions/runs/44159910697): **2/2 jobs aprovados**.
- [Simulation & Reliability Lab, run 44159910665](https://github.com/QGBALTIGO/astra/actions/runs/44159910665): **4/4 jobs aprovados**.
- Consulta dos jobs, logs e artefatos efetuada em 17/11/2026. Esta verificação não reexecutou jobs e não alterou produção.
- Os dois artefatos abaixo identificam o mesmo SHA avaliado; os SHA-256 dos ZIPs baixados foram conferidos com os hashes retornados pela API do GitHub.

| Artefato                                                                                                                    | ID          | SHA-256 do ZIP                                                     |
| --------------------------------------------------------------------------------------------------------------------------- | ----------- | ------------------------------------------------------------------ |
| [astra-http-real-pg-500](https://github.com/QGBALTIGO/astra/actions/runs/44159910665/artifacts/14361394612)                 | 14361394612 | `796cba294b9e123d20bfe21dff6f5dd7e9f8023aa2135ce8e2c0b2dcb73ddc73` |
| [astra-lab-real-pipeline-synthetic-data](https://github.com/QGBALTIGO/astra/actions/runs/44159910665/artifacts/14363296405) | 14363296405 | `858bcd0da9b33e3fb717581fbe89868b7bdad026af1c3c4785545c34b292bc8c` |

## Contador corrigido

O novo `pipeline-baseline.json` contém `testsPassed: 26`, `testsFailed: 0` e exatamente **26 entradas individuais** em `checks`. A linha agregada `26 PostgreSQL screenshot scenarios; ...` não aparece entre os cenários. Permanecem as quatro verificações de financiamento. O log do job confirma `checks: 26`, `realModels: 0` e `realWhatsApp: 0`.

Essa evidência valida a correção em `scripts/astra-simulation-lab/summarize-smoke.mjs`: o artefato anterior contava a linha-resumo como um 27º cenário. Os mesmos 26 cenários são executados nos dois workflows; não devem ser somados como 52 cenários distintos.

## Carga HTTP com PostgreSQL real

Fonte: `astra-http-capacity.json`, medição encerrada em **2026-11-17T19:34:55.145Z**, Node **v22.23.4**, serviço CI `pgvector/pgvector:pg16`.

Foram preparadas **500 contas fictícias distintas**, reutilizadas entre as ondas. Executaram-se **910 jornadas / 8.190 requisições**, sem erros e sem tentativas de acesso externo.

| Contas na onda | Requisições | Erros | Duração (ms) |  Req/s | Resumo p95 (ms) | Despesa p95 (ms) | Pico RSS Node (MiB) | Pico de fila |
| -------------: | ----------: | ----: | -----------: | -----: | --------------: | ---------------: | ------------------: | -----------: |
|             10 |          90 |     0 |          337 | 267,15 |          142,01 |           111,56 |                 217 |            0 |
|             50 |         450 |     0 |        2.070 | 217,38 |          613,02 |           381,13 |                 215 |          154 |
|            100 |         900 |     0 |        2.352 | 382,59 |          966,86 |           711,25 |                 243 |          349 |
|            250 |       2.250 |     0 |        6.760 | 332,85 |        2.002,33 |         2.591,01 |                 346 |          941 |
|            500 |       4.500 |     0 |        9.095 | 494,75 |        3.764,92 |         2.324,70 |                 406 |        1.942 |

Na maior onda, o resumo financeiro teve p50 de **2.563,79 ms**, p99 de **3.879,67 ms** e máximo de **3.896,87 ms**. O atraso do event loop p99 foi **23 ms**, com resolução de amostragem de 20 ms. CPU do processo Node nessa onda: **7.374,020 ms de usuário** e **1.511,850 ms de sistema**.

As jornadas exercitam criação de despesa com replay simultâneo e conferência do mesmo ID, assinatura pessoal, lembrete, leituras de lançamentos/agenda/planejamento/resumo e tentativa de leitura por outra conta, exigindo 404. As sessões já são preparadas como fixtures; este teste não executa envio ou confirmação de OTP. O campo `subscription` desta carga refere-se a uma assinatura pessoal do módulo de planejamento, não a pagamento ou renovação Cakto.

O middleware real `CustomerAdmission` limita a 32 solicitações ativas e 2.048 em espera, com timeout de 15 segundos. O pico amostrado foi 1.942 em espera, sem rejeição nesta execução; o script confirmou zero solicitações ativas e pendentes ao final de cada onda. Há crescimento da fila e da latência. Os dados não isolam o banco como gargalo, pois CPU e memória do PostgreSQL não foram medidas.

As medições são ondas únicas em loopback, com o roteador de clientes e PostgreSQL reais. Excluem ingresso público Railway, middleware global fora desse roteador, navegador, inferência de IA, entrega WhatsApp/Telegram e recursos do processo PostgreSQL. Não constituem teste sustentado nem comprovação de capacidade equivalente em produção.

No run anterior, do SHA `3e50657`, a onda de 500 mediu 662,22 req/s e resumo p95 de 3.111,43 ms. A variação entre duas execuções em CI não demonstra, por si, regressão ou melhoria; a mudança entre esses commits não altera o processamento da carga. Os números da tabela acima correspondem ao SHA `f1c8b13`.

## Burst do canal com PostgreSQL real

Fonte: `postgres-burst.json`, **2026-11-17T19:35:22.140Z**. Gateway e PostgreSQL reais, contas e mensagens sintéticas, transporte simulado, **zero tentativas de modelo ou HTTP externo**.

| Usuários na onda | Operações verificadas | Erros | Duração (ms) | Serviço p95 (ms) | Operações/s | Pico RSS Node (MiB) |
| ---------------: | --------------------: | ----: | -----------: | ---------------: | ----------: | ------------------: |
|               10 |                    10 |     0 |       161,35 |           161,01 |       61,98 |              198,07 |
|               50 |                    50 |     0 |        65,12 |            64,45 |      767,76 |              198,45 |
|              100 |                   100 |     0 |       120,54 |           118,96 |      829,59 |              201,02 |
|              250 |                   250 |     0 |       291,94 |           286,29 |      856,35 |              208,27 |
|              500 |                   500 |     0 |       565,33 |           552,75 |      884,44 |              225,64 |

São ondas únicas e o tempo de fila não é medido nesse script. Seus números de operações/s correspondem a trabalho diferente do teste HTTP e não devem ser comparados diretamente com req/s. As métricas de recursos abrangem somente Node, sem o processo PostgreSQL.

## Testes executados e limites das contagens

### WhatsApp reliability

- Vitest core: **306 aprovados**.
- Grupos gateway: **1.336 + 1.203 aprovados**. Total dos três grupos: **2.845 aprovações**.
- Cakto com Node: **14 aprovados, 2 ignorados**.
- Cakto com Bun 1.4.4: **15 aprovados, 1 ignorado**.
- Build e lint de core/gateway: aprovados.
- Smoke PostgreSQL: **26 cenários aprovados**, incluindo espera real de 20 segundos e envio por transporte simulado.

O caso Cakto com PostgreSQL está ignorado neste workflow; depende da evidência específica do workflow Member Readiness e não deve ser declarado aprovado a partir desses resultados. O caso de endereçamento do cliente S3 real do Bun foi executado no grupo Bun. As execuções Node e Bun compartilham cenários, portanto seus totais não representam casos distintos adicionais.

### Simulation & Reliability Lab

- Smoke: os mesmos **26 cenários** já citados.
- Parser e intenções: **14 testes** aprovados, incluindo um teste que percorre 500 valores monetários.
- Autenticação PostgreSQL e intervalo de lembretes: **8 aprovados**.
- Descoberta de contatos, seleção de lembretes, alterações de agenda e assinaturas pessoais: **531 aprovados**.
- Tarefas pessoais: **506 aprovados**.
- Total Vitest deste workflow: **1.059 aprovações**, além do smoke e dos bursts.
- Fast-check: **5 propriedades / 18.000 iterações sintéticas**, sem falha, com **zero gravações reais no banco e zero chamadas de modelo**.
- O job de geração de 100 mil cenários foi aprovado, mas esse corpus, seus scripts de ação exportados e o assistente deliberadamente simulado **não são 100 mil conversas ou execuções reais do Astra**. Não houve execução do tau2-bench.

## Comandos relevantes executados pelo CI

Os comandos completos e as variáveis de banco fictício estão nos workflows `whatsapp-reliability.yml` e `astra-simulation-lab.yml` do SHA avaliado. Principais comandos dos artefatos:

```bash
node --test integrations/cakto/railway-function.test.mjs
pnpm dlx bun@1.4.4 test integrations/cakto/railway-function.test.mjs
pnpm --filter @ownpilot/core --filter @ownpilot/gateway build
pnpm --filter @ownpilot/core --filter @ownpilot/gateway lint

pnpm --filter @ownpilot/gateway exec node --import tsx \
  scripts/whatsapp-screenshot-smoke.ts

pnpm --filter @ownpilot/gateway exec node --import tsx \
  scripts/customer-capacity-burst.ts "${RUNNER_TEMP}/astra-http-capacity.json"

pnpm --filter @ownpilot/gateway exec node --import tsx \
  scripts/channel-expense-burst.ts \
  "${RUNNER_TEMP}/astra-lab-integration/postgres-burst.json"

node scripts/astra-simulation-lab/summarize-smoke.mjs \
  "${RUNNER_TEMP}/astra-pipeline.log" "${RUNNER_TEMP}/astra-lab-integration"
```

## Conclusão da rodada f1c8b13

Nenhum job falhou e ambas as cargas medidas terminaram sem erro. O contador corrigido foi validado no artefato produzido pelo CI no SHA `f1c8b13`. Esses resultados sustentam a validação em ambiente isolado; não encerram as pendências de WhatsApp real, provedores de IA, Cakto externo, configuração de implantação ou recuperação em produção identificadas no relatório de prontidão.

## Revalidação da candidata 43118c0

Após a integração adicional da principal, o código candidato é `43118c019e3d08bc3adea9f4887481c09fe4ee48`, árvore `3947f33a813cc38514b0a6f27013811e48549289`.

- [WhatsApp reliability, run 44163055100](https://github.com/QGBALTIGO/astra/actions/runs/44163055100): **2/2 jobs aprovados**.
- [Simulation & Reliability Lab, run 44163054907](https://github.com/QGBALTIGO/astra/actions/runs/44163054907): **4/4 jobs aprovados**.
- A comparação local entre `f1c8b13` e `43118c0` não encontrou diferença em `integrations/cakto`, canais do gateway, middleware de admissão, scripts dos dois bursts, scripts do laboratório nem nos dois workflows acompanhados. Não se atribuiu a mudança das métricas a uma correção de desempenho.
- Os logs repetiram **2.845 aprovações Vitest** no workflow WhatsApp e **1.059** no Simulation Lab, além dos mesmos **26 cenários PostgreSQL**. Node Cakto: 14 aprovados/2 ignorados; Bun Cakto: 15 aprovados/1 ignorado. Permanece a necessidade da evidência separada do caso Cakto com PostgreSQL no workflow Member Readiness.
- O novo `pipeline-baseline.json` confirmou **26 cenários individuais**, zero falhas, quatro verificações de financiamento e nenhuma linha-resumo agregada entre os cenários. Não houve chamadas reais de modelo ou entrega WhatsApp.

Os dois artefatos abaixo identificam `43118c019e3d08bc3adea9f4887481c09fe4ee48`; os SHA-256 dos ZIPs baixados foram novamente conferidos:

| Artefato                                                                                                                    | ID          | SHA-256 do ZIP                                                     |
| --------------------------------------------------------------------------------------------------------------------------- | ----------- | ------------------------------------------------------------------ |
| [astra-http-real-pg-500](https://github.com/QGBALTIGO/astra/actions/runs/44163054907/artifacts/14363997186)                 | 14363997186 | `d2ad89940984fd9c8f591070d833d31a308d23bd6a8e19a4339abde14b446bc7` |
| [astra-lab-real-pipeline-synthetic-data](https://github.com/QGBALTIGO/astra/actions/runs/44163054907/artifacts/14363473936) | 14363473936 | `a06e1e10b58cf62ae2478c6490958d309d7894116cc952731b5b630904f4fd6d` |

O HTTP foi medido em **2026-11-17T19:52:41.113Z**: ondas 10/50/100/250/500, novamente **8.190 requisições, 910 jornadas, zero erros e zero tentativas externas**. O burst de canal foi medido em **2026-11-17T19:52:36.090Z**, com zero erros e zero tentativas de modelo ou HTTP externo em todas as ondas. Comparação da onda de 500:

| Medida                       |  f1c8b13 |  43118c0 |
| ---------------------------- | -------: | -------: |
| HTTP: requisições            |    4.500 |    4.500 |
| HTTP: duração (ms)           |    9.095 |    6.923 |
| HTTP: req/s                  |   494,75 |   650,03 |
| HTTP: resumo p95 (ms)        | 3.764,92 | 3.134,65 |
| HTTP: despesa p95 (ms)       | 2.324,70 | 1.556,47 |
| HTTP: pico RSS Node (MiB)    |      406 |      371 |
| HTTP: pico amostrado da fila |    1.942 |    1.852 |
| Canal: operações verificadas |      500 |      500 |
| Canal: duração (ms)          |   565,33 |   470,33 |
| Canal: serviço p95 (ms)      |   552,75 |   463,01 |
| Canal: operações/s           |   884,44 | 1.063,09 |
| Canal: pico RSS Node (MiB)   |   225,64 |   229,66 |

Não houve falha nos workflows acompanhados. Os limites de interpretação continuam iguais aos da rodada anterior: dados fictícios, bursts únicos em CI, transporte simulado, recursos medidos somente no Node e ausência de inferência/entrega externas. A variação de latência e vazão entre runs não isola um gargalo nem comprova capacidade em produção. O corpus sintético gerado continua excluído da contagem de conversas reais.
