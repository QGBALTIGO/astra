# Astra — matriz técnica de referências brasileiras
Data da inspeção: 07/11/2026. Escopo: levantamento de código de repositórios públicos, sem rodar nem implantar os serviços de terceiros.

## Regra de adoção
- Astra continua com Node.js/TypeScript, PostgreSQL, interface própria e Groq como único provedor IA ativado nesta fase.
- Não copiar interface, credenciais, bancos nem fluxos de outras aplicações.
- Licença verificada para reuso de código: MIT apenas quando o repositório publica LICENSE. Ausência de LICENSE significa **não copiar código**.
- As propostas abaixo são **candidatas**, não funcionalidades já integradas ou testadas no Astra.
- Lembretes, despesas e alterações externas exigem confirmação da gravação real antes de uma resposta de sucesso.

## Matriz de oito projetos

| Fonte | Arquivos efetivamente inspecionados | Mecanismo técnico encontrado | Licença visível | Comparação com Astra; decisão |
|---|---|---|---|---|
| [Atlas](https://github.com/alvaro209890/atlas-assistente-pessoal) | README, apps/worker/src/reminder-schedule.ts, batcher.ts, session-sync.ts | Recorrência com cálculo no fuso do usuário, normalização de regras brasileiras, agrupamento de mensagens por userId+chatJid com ordenação e reconciliação de sessões WhatsApp | MIT | Astra já tem conversas, tarefas, gatilhos e memórias; **adaptar** recorrência local e batching com persistência/locks, sem criar outro worker incompatível |
| [Zelar IA](https://github.com/Ricardo071106/Zelar_IA) | README, server/services/eventParser.ts, reminderService.ts, lessonSlotConflict.ts, diretório pluggy | Parser misto de datas/títulos, jobs node-schedule rehidratados de lembretes não enviados; integração de calendários e módulos Pluggy separados | Sem LICENSE detectada | **Reimplementar conceito**, não código: importar calendários como conectores opcionais, garantir reprocessamento idempotente; sem contratar Pluggy, Stripe nem serviços externos |
| [Nort Finance](https://github.com/AElise08/nort-finance) | README e index.js | Um processo whatsapp-web.js + Supabase, intenção Mistral, transcrição/análise via Groq, cron para lembretes; handlers de áudio/imagem | MIT | **Adaptar apenas desenho de entrada multimodal**. Mistral e Supabase adicionais contrariam a restrição Groq/PostgreSQL do Astra; sessões Map/Set em memória não são suficientes para multiusuário resiliente |
| [WhatsApp Gastos AI](https://github.com/AndreRuperto/whatsapp_gastos_ai) | README, backend/services/gastos_service.py, db_init.py, scheduler.py | FastAPI+Postgres, fatura_cartao, gastos, parcelas por mês e APScheduler/CronTrigger com rehidratação dos lembretes ao reiniciar | MIT | Astra já tem tabela expenses (DECIMAL(12,2)); **modelar cartões e parcelas nativamente** em TypeScript/SQL com centavos e transações, sem integrar backend Python ou obrigar WhatsApp Cloud API |
| [FinBot](https://github.com/ofelipevilela/finbot) | README, src/whatsapp-bot/index.ts, config.ts | Baileys + Supabase; categorização por palavras-chave e regex; registra valores convertidos com parseFloat em transacoes | Sem LICENSE detectada | **Reimplementar taxonomia de categorias**, não copiar; evitar parseFloat para dinheiro, dependência Supabase extra e fragilidade da categorização apenas por palavras |
| [Agenda WhatsApp Bot](https://github.com/usernameazevedo/agenda-whatsapp-bot) | README, src/conversa.js, ia.js, recorrentes.js, jobs.js | Máquina de estados, pedido de campos ausentes, confirmação S/N antes de mexer na agenda, desambiguação, aviso de sobrecarga; recorrentes mensais com confirmação; jobs com proteção contra execução duplicada por dia | MIT | **Prioridade alta**: adaptar fluxos de confirmação, datas relativas e idempotência para as ferramentas próprias; não usar Anthropic/Claude nem a persistência JSON em arquivo do original |
| [Guará](https://github.com/AntonyAraujo87/Guara) | README, backend/ai-service.js, db-service.js, leitura-simples.js, run-recurring.js | A IA classifica intenções; números são calculados no backend a partir do banco; pesquisa de duplicidade recente dentro de 15 s; lançamentos recorrentes cron separados | Sem LICENSE detectada | **Reimplementar princípio crítico**: saldo sempre de consultas reais e gravação com chave de idempotência (não apenas janela de 15 s); manter somente Groq e PostgreSQL Astra |
| [Bot Agendamento IA](https://github.com/levicostaq/whatsapp-agendamento-bot) | README e agendamento-bot.json (workflow n8n) | Webhook Evolution API, roteamento texto/áudio/imagem, debounce Redis, ficha de usuário preenchida progressivamente, busca antes de marcar e transferência humana | MIT | **Adaptar lógica de mensagens fragmentadas e handoff**, não importar workflow n8n, Redis e OpenAI pagos. Verificar consentimento e isolamento da sessão WhatsApp |

## Referência comercial: [ANIA Finanças](https://www.aniafinancas.com.br/)
A página pública anuncia organização financeira conversacional, registro por áudio, cartões, resumos, agenda, metas, contas compartilhadas e Open Finance. São **declarações comerciais da empresa, não código aberto nem funcionalidades tecnicamente verificadas**. Não comprar o serviço, não prometer sincronização bancária e não reproduzir elementos visuais proprietários.

## Situação comprovada no Astra
- Existe navegação React para chat, gastos, agenda, tarefas, objetivos, memórias, agentes, gatilhos e outras rotas (packages/ui/src/App.tsx).
- O schema financeiro contém expenses com valor DECIMAL(12,2) em BRL (packages/gateway/src/db/schema/finance.ts). A análise deste arquivo **não** comprova a presença de tabelas específicas de cartões, faturas e parcelas; inventariar todos os demais modelos antes de criar novas tabelas.
- Auditoria de 59 rotas por três resoluções (GitHub Actions 42384523704) apresentou overflow em vários módulos, textos ingleses e HTTP 500 em /edge-devices. A conclusão SUCCESS do job indica que a captura rodou, não que o produto passou em todos os critérios.
- O erro SQL edge_devices foi corrigido em main pelo commit 4d709aaf. A PR #3 complementa teste de migração contra PostgreSQL real e tratamento visual da falha.
- Os serviços Railway existentes são independentes do Orion; nenhuma migração ou publicação de produção foi realizada nesta pesquisa.

## Propostas ordenadas por dependências e custo

1. **Qualidade base**: corrigir overflow e localizações, teste funcional CRUD, observabilidade de API, segurança e backup restaurável. Validar browser em 320, 360, 375, 390, 430, 768, 1024, 1280, 1440 e 1920 px.
2. **IA Groq confiável**: parser pt-BR com intenção/entidades em JSON estruturado, validação por schema, classificação de ações, autorização por usuário e somente depois tool calls; resposta de sucesso **após** confirmação da gravação. Sem inventar saldo ou compromissos.
3. **Finanças brasileiras**: contas, cartão, fechamento, vencimento, parcela, estorno e recorrência com valores em centavos/NUMERIC e chaves idempotentes. Conciliar soma de parcelas/estornos com testes de centavos.
4. **Agenda e lembretes**: entrada texto/áudio, idempotência, conflitos, confirmação de ações irreversíveis, fuso da conta, recorrência e recuperação após reinício com job persistente e worker único por tarefa.
5. **WhatsApp**: validar sessão atual, preservar credenciais, reconexão, WhatsApp tests somente com número de teste, dedupe e envio único por evento. Baileys e Evolution têm riscos e não oferecem garantia absoluta de banimento/desconexão zero.
6. **Integrações opcionais**: Google/Outlook e bancos via Open Finance **somente** após consentimento, fornecedor aprovado e avaliação de custos; sem novas contratações nesta fase.

## Testes mínimos para aceitar cada mecanismo
- Lançamento: texto/áudio/comprovante -> extração -> confirmação quando ambígua -> INSERT -> GET -> relatório atualizado -> UPDATE/estorno -> verificação de valor exato. Reentrega da mesma mensagem não pode duplicar.
- Lembrete: interpretar fuso e recorrência -> persistir -> reiniciar processo -> disparar uma vez -> registrar entrega/falha -> reprocessar sem duplicar.
- Conversas: alternar temas, mensagens picotadas e usuários simultâneos; nenhuma memória, conta ou resposta pode escapar do escopo do remetente.
- Interface: desktop/tablet/mobile claro/escuro, zoom, teclado, falha de rede, tabela grande, data e moeda pt-BR, sem overflow.
- Deploy: backup comprovadamente restaurável, migração reversível, Docker versionado, CI verde e smoke completo na produção após o deploy.

## Pendências desta análise
Esta matriz usa evidência **estática do código**, sem instalar ou executar os oito projetos. Não comprova qualidade dos testes deles, segurança de produção, nem funcionamento dos seus provedores. O código próprio do Astra deve ser testado isoladamente antes de reutilizar qualquer ideia. Sem LICENSE em Zelar IA, FinBot e Guará, não há autorização de copiar implementações. Não há evidência de permissão para abrir bancos de terceiros.

## Checkpoint
- Repositório: https://github.com/QGBALTIGO/astra
- Correção não destrutiva da interface/checagem do banco: https://github.com/QGBALTIGO/astra/pull/3
- Auditoria anterior: https://github.com/QGBALTIGO/astra/actions/runs/42384523704
- Nenhum custo novo autorizado; IA Groq somente; Orion intocado.
