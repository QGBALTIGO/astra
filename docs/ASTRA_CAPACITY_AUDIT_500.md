# Astra — auditoria de capacidade e confiabilidade para 500 usuários

Data: 11/11/2026. Fonte: código no GitHub e métricas/logs do gateway e PostgreSQL na Railway (produção). Nenhum teste de carga foi enviado para números reais do WhatsApp.

## Escopo: 500 usuários ativos não é igual a 500 turnos simultâneos

**Status atual: NÃO homologado para 500 conversas simultâneas.**
500 contas cadastradas, com mensagens distribuídas ao longo do dia, têm uma
necessidade completamente diferente de 500 solicitações enviadas no mesmo minuto.

### Infraestrutura observada (janela: 24 horas)

| Item | Observado | Interpretação |
| --- | --- | --- |
| Gateway | 1 réplica, 2 vCPU limite, 1 GB RAM limite | Sem dados de stress real |
| Volume gateway | 500 MB em /app/data | Railway não permite escalar réplicas do serviço com volume |
| Pico de RAM | 0,318 GB | Baixo na carga atual; não comprova carga de 500 |
| CPU gateway | Máx. amostra ~0,054 CPU_USAGE | Pouco uso observado; métrica não é benchmark |
| PostgreSQL | 2 vCPU / 1 GB limites; ~0,070 GB pico RAM | Não recebeu teste de 500 conversas |
| WhatsApp | Uma sessão Baileys por gateway | Não duplicar o socket ao escalar |
| Ollama relay | MAX_JOBS = 6, MAX_WAIT_MS = 48s | O worker do PC executa o loop de inferência sequencialmente |
| Saída WhatsApp | 20 mensagens / 60s global; intervalo de 3s por destinatário | Política de envio, não capacidade do servidor |

**Teto teórico atual de saída:** 500 respostas únicas destinadas a usuários
diferentes, admitindo a primeira leva no minuto zero e 20 envios por janela,
colocam a última leva no minuto 24 (aproximadamente 25 minutos de capacidade).
Não inclui IA, demora de atendimento, mensagens longas divididas, lembretes
nem eventuais taxas extras do protocolo. Não elevar limites anti-ban sem
validação; isso pode prejudicar a conta de WhatsApp.

Railway: https://docs.railway.com/volumes/reference
Ollama: https://github.com/ollama/ollama/blob/main/envconfig/config.go

### Amostra real de processamento da IA (sem entrega)

Foram recuperados 21 turnos com durationMs de 11/11/2026. A seleção se
baseou em janelas dos logs disponíveis, NÃO é uma amostra aleatória nem
representativa de picos.

- p50 **5036 ms**, p90 **32471 ms**, p95 **36180 ms**, p99 **44495 ms**.
- 8/21 ultrapassaram 20 segundos; 3/21 ultrapassaram 30 segundos.
- Distribuição: 10 até 5s, 2 de 5–10s, 1 de 10–20s, 5 de 20–30s,
  3 acima de 30s.
- Logs registram timeout de 20s no Ollama, 429 do Z.ai e fallback para
  OpenRouter. O tempo total de entrega ao WhatsApp não foi medido.
- O long-poll de 20s que retorna HTTP 204 do worker Ollama **não é**
  tempo de resposta do chatbot.

### Problemas ordenados por criticidade

**P0/P1 (capacidade e confiabilidade):**
1. Política de envio de 20/min faz a última resposta esperar ~24 min em
   pico de 500 solicitações. Limite configurado no Baileys — não é seguro
   aumentá-lo cegamente.
2. Gateway com volume persistente não pode ter várias réplicas na Railway.
   Separar conector/sessão WhatsApp singleton do serviço de API e dos
   workers stateless antes de adicionar réplicas.
3. Mensagens recebidas são processadas assíncronas pelo canal. Deduplicação
   e serialização por sessão existem, mas NÃO há fila **global durável de
   inferência** validada para 500 usuários; quedas durante o turno exigem
   estratégia de recibo e recuperação de mensagens.
4. Ollama ponte: no máximo 6 solicitações em memória, com worker sequencial
   no PC. Cloud fallback sujeito a limites de RPM/TPM e erros 429. Em carga
   alta, não prometer inferência local simultânea para 500 pessoas.
5. O MessageBus retornava mensagens internas de exceção, nome da etapa e
   warnings brutos no conteúdo de respostas do canal. Corrigido nesta
   branch com regressão para evitar vazamento.
6. Solicitações Ollama abandonadas permaneciam ocupando slots até timeout.
   Corrigido nesta branch com cancelamento do request e eliminação segura
   de IDs pendentes; retorno tardio do worker vira 410.

**P2 (desempenho, privacidade e diagnóstico):**
7. Flood guard gerava advertência com platformUserId (frequentemente
   telefone). Removido esse dado das advertências na branch.
8. Valores malformados de configuração do flood guard podiam resultar em
   limite desabilitado ou comportamento incoerente. Agora são limitados.
9. Métricas e tempos de resposta precisam ser separados por etapa:
   enfileiramento, modelo escolhido, tokens, ferramentas, escrita PG,
   envio, recibo. Habilitar tracing com retenção e proteção de PII.
10. A versão atual de Railway pode estar atrasada em relação à main:
    conferir imagem Docker exata antes de presumir correções implantadas.

### Bateria de 500 usuários (esta branch)

Arquivo: packages/gateway/src/services/capacity-smoke.test.ts

- 500 sessões sintéticas distintas no MessageBus real, com modelo fictício
  sem rede; verifica respostas associadas ao usuário correto.
- 500 turnos sequenciais distribuídos por 25 sessões, preservando a ordem.
- 500 remetentes fictícios passam pelo flood guard sem misturar rate limit.
- Aritmética documentada do piso de atraso: 20 envios/min.
- Em CI, registrar p50/p95/p99 **sintéticos do MessageBus**, que não medem
  tempo do Ollama, WhatsApp, PostgreSQL ou experiência real do cliente.

A bateria não faz 500 logins, consultas DB, envios Baileys ou solicitações
reais de modelos. Não declarar "Astra aprovado para 500 usuários" baseada
nesse resultado.

### Arquitetura necessária para atender 500 conversas simultâneas

1. **Conector WhatsApp singleton** separado, com estado persistente e
   confirmação por ID. Para produção intensiva, avaliar WhatsApp Business
   Platform oficial (preço, limites, templates, políticas e aprovação);
   não simular 500 destinatários reais no Baileys.
2. **Fila durável** por turno com chaves idempotentes e estado
   pending -> processing -> succeeded/failed; tentativas controladas,
   DLQ e recuperação pós-restart. Mensagens do mesmo usuário FIFO,
   usuários independentes podem progredir em paralelo.
3. **Workers stateless de IA** separados do gateway e redimensionados com
   quotas reais de cada provedor. Roteamento por prioridade, orçamento
   e tipo de tarefa; Ollama local apenas como componente opcional com
   slots e timeout estritos.
4. **Outbox durável** para entregas WhatsApp. Não repetir uma operação
   financeira quando o modelo ou o envio falha após commit.
5. **Observabilidade com rastreios sem conteúdo pessoal:** fila, backlog,
   latência p50/p95/p99 por etapa, erros 429 e timeouts, uso de tokens,
   sucesso de ferramenta, taxa de repetição.
6. **Teste gradual isolado** com banco e canal fake: 10, 25, 50, 100, 250,
   500 usuários com ondas de carga e soak; falhas controladas. Medir
   latência da resposta final e estado do banco, não só HTTP 200.

### Gates de qualidade para um futuro rollout de capacidade

- 0 cruzamentos de identidade, falhas de autorização e duplicação
  financeira sob retry; 100% P0 aprovados.
- Não confirmar operações sem receipt persistido.
- p95 fim a fim alvo inicial <= 15s em carga **definida e testada**,
  com política de fila explícita; não alegar esse resultado sem medi-lo.
- Taxa de entrega, taxa de erros, backlog, limites por conta e plano de
  custos devem ser medidos antes de habilitar 500 simultâneos.
- Rollback da imagem e das migrations ensaiado; sem tráfego de clientes
  nos testes.
