# Astra Simulation & Reliability Lab

Laboratório isolado para gerar população sintética, histórias com relógio virtual, testar propriedades e executar verificações sobre **funções reais do código-fonte do Astra**.

**Estado inicial:** gerador e verificadores de código, não um clone do gateway nem um teste ponta a ponta. É proibido chamar esta fase de "100.000 conversas reais testadas".

## Execução reproduzível

Requer Node.js >=22.22 e instalação separada do monorepo:

    cd tools/astra-simulation-lab
    npm ci --ignore-scripts
    npm test

Amostra sem chamadas externas:

    node lab.mjs generate --out ./amostra --personas 100 --stories 100 --scenarios 1000 --seed 20261111
    node lab.mjs verify --out ./amostra
    node lab.mjs probe --out ./amostra
    node lab.mjs report --out ./amostra

Geração integral, preferencialmente no disco secundário:

    node lab.mjs generate --out E:\AstraSimResults\baseline --personas 10000 --stories 10000 --scenarios 100000 --seed 20261111
    node lab.mjs verify --out E:\AstraSimResults\baseline
    node lab.mjs probe --out E:\AstraSimResults\baseline
    node lab.mjs report --out E:\AstraSimResults\baseline

Abra index.html no navegador. Não versionar dados de simulação ou informações privadas. A versão integral cria arquivos JSONL no caminho informado, sem manter 100.000 registros em RAM.

## Artefatos e semântica

- personas.jsonl: até 10.000 perfis fictícios com ID reservado, profissão, hábitos, estilo, região/fuso e contexto.
- stories.jsonl: até 10.000 jornadas independentes, cada uma com pelo menos 9 mensagens, dependências explícitas e dias virtuais. Possui 14 arquétipos; NÃO são 10.000 histórias escritas por IA nem necessariamente semanticamente únicas.
- scenarios.jsonl: até 100.000 casos divididos nas dez cotas oficiais; entradas procedurais em templates com variações de contexto, valores e intenção. Não contar permutações superficiais como evidência de diversidade semântica.
- manifest.json: seed, cotas e proveniência.
- validation.json: auditoria de integridade **dos fixtures**, que não testa compreensão do Astra.
- source-probes.json: execução de parsers e seletor de ferramentas extraídos/gerados do código-fonte de trabalho do Astra; nenhuma chamada ao banco, canal ou modelo.
- index.html: dashboard estático sem serviços externos.

Cotas fixas: finanças 20.000; agenda/lembretes 16.000; metas/dívidas 15.000; cotidiano 12.000; profissões 10.000; multimodal 8.000; memória 6.000; falhas 5.000; segurança/multiusuário 4.000; ambiguidades 4.000.

## Origem e distinção dos resultados

| Modo | O que comprova | O que **não** comprova |
| --- | --- | --- |
| synthetic-generated | Existe um dataset reprodutível | Que Astra entendeu ou executou qualquer pedido |
| fixture-integrity-validation | Quantidade, esquema, dependências e isolamento dos dados de teste | Que os bancos e ações de produção funcionam |
| real-Astra-source-probes | Funções isoladas **do código real** para valores, parsing, lembretes e tool selection | Persistência, tool execution, multiusuário, latência ou qualidade do modelo |
| isolated-gateway-integration | **Ainda não implementado**: deve verificar ferramentas, estado final e entrega fictícia | Nunca deve falar com clientes reais |
| local-llm-eval | **Ainda não executado**: poderá medir respostas amostradas | Não substitui verificação de estado |
| production-canary | Fora do escopo até gates de qualidade e autorização | Não usar para simulações destrutivas |

Qualquer reprovação de regressão define código de saída 1. Não gerar métricas de precisão da IA, p95 do gateway ou custo de tokens sem medições reais.

## Arquitetura de integração isolada: próxima etapa

1. Fazer compose **separado** com PostgreSQL descartável e segredo/test user exclusivo, sem copiar ambiente nem credenciais Railway.
2. Criar adaptador para ChannelIncomingMessage e ChannelManager do Astra, com canal de saída fake persistente, ID namespaceado sim-, relógio injetável e endpoint local fechado.
3. Usar transações por história, verificar registros nos repositórios customer-finance.ts, finance-obligations.ts, channel-reminders.ts, goals.ts, memories.ts.
4. Injetar falhas em ferramentas e chamadas externas com mocks, nunca alterando a produção. Verificar receipt-state.ts, response-safety.ts e idempotência após retry.
5. Registrar trace por turno: ID, pessoa fictícia, hora virtual, ferramentas, argumentos sanitizados, resultado do banco, tokens, latência e motivo da reprovação.
6. Executar baterias graduais de 1, 5, 20, 50, 100 sessões concorrentes; definir limites por RAM/disco/custo. Sem 10 mil agentes simultâneos.
7. Criar regressão unitária para cada defeito P0/P1, e exigir revisão/testes antes de implantar a branch.

**Bloqueios:** Docker não foi localizado no computador auditado. Não há ambiente PostgreSQL isolado pronto para testes nesta missão; a Railway conectada tem o banco de **produção**, que não deve ser usado. A GPU RX 580 4GB e a RAM livre baixa tornam inadequada a instalação padrão do MiroFish-Offline. Não modificar Ollama existente.

## Matriz open source — decisão inicial

| Projeto | Licença identificada | Decisão e motivo |
| --- | --- | --- |
| MiroFish (666ghj/MiroFish) | AGPL-3.0 | Não copiar/incorporar ao Astra comercial. Motor de comportamento social; teste externo futuro, após revisão jurídica |
| MiroFish-Offline (nikmcfly/MiroFish-Offline) | AGPL-3.0 | Não instalar por ora: Neo4j e modelo 14b/32b acima da VRAM confortável deste PC; uso separado opcional |
| Promptfoo | MIT | Ferramenta escolhida para avaliação de respostas em etapa de integração. Não instalada nesta fase (evitar processar saída fictícia como resposta real) |
| τ²-Bench | MIT | Referência para avaliador por estado final, ação, parâmetros e conversas completas. Sem dependência Python pesada nesta etapa |
| fast-check | MIT | **Instalado no laboratório**, propriedades com seed e shrink em Vitest |
| Vitest | MIT | Existente no monorepo e **executado** no laboratório isolado |
| Opik | Apache-2.0 | Opção principal para observabilidade futura por trace, sem colocar servidor pesado no PC agora |
| Langfuse | MIT core (exclui ee) | Alternativa não instalada, evitar dois observadores redundantes |
| OASIS | Apache-2.0 | Não instalar junto com MiroFish sem prova de necessidade |
| pg-boss / BullMQ / Mem0 | Licenças a revisar antes de possível implantação | Não instalar: verificar primeiro filas, memória e jobs do OwnPilot |
| Playwright | Licença do pacote a confirmar para alterações futuras | E2E do Astra já existe em packages/ui/e2e, aproveitar |
| Whisper / faster-whisper | Dependências/modelos a verificar | Não instalar nesta etapa, multimodal exige integração posterior |

Verificar a licença exata da versão fixada e obrigações de distribuição antes de qualquer redistribuição comercial. Documentar dependências e versões no lockfile; não copiar AGPL para dentro do monorepo.

## Plano de avaliação de qualidade após isolamento

- **P0**: cruzamento de conta, dados sensíveis/identificadores, exclusão em conta errada, deduplicação crítica.
- **P1**: falso sucesso financeiro, persistência incorreta, lembrete confirmado que não existe, erro após commit.
- **P2**: perda de contexto e seleção de ferramenta incorreta; parser conservador pode devolver à IA em vez de gravar.
- **P3**: tom e formatação.

Alvos não presumidos: 100% isolamento P0, zero confirmações falsas nos testes críticos, >=98% intenção em amostra representativa, >=4,5/5 comunicação, p95 medido e custo real dos modelos. **Produção: não publicar até todos os gates críticos serem comprovados.**

## Repositório de origem e segurança

Base: OwnPilot 0.8.3 com Hono, core agent, ferramentas financeiras/metas/agenda, Vitest e PostgreSQL. Fluxo específico Astra inclui packages/gateway/src/channels/finance-routing.ts, customer-finance-routing.ts, tool-selection.ts, relative-reminder.ts e response-safety.ts.

A documentação não autoriza o uso de chaves reais, dados de clientes, backups de produção, disparo de WhatsApp ou conexões a Cakto. A simulação é estritamente sintética; os arquivos JSONL devem ficar fora do GitHub. Todos os resultados apresentados devem trazer a indicação explícita do modo de execução.
