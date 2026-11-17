# Astra Radar

O cliente escolhe o que quer acompanhar na conversa particular do Astra. O Dashboard mostra os assuntos, as atualizações e o histórico, com os ajustes de horário em uma janela própria.

## Escolha pelo chat

A IA tem a ferramenta restrita `manage_radar`: consultar, acompanhar, testar uma consulta agora, configurar o resumo, pausar ou retomar um assunto. Pedidos de notícias e Radar exigem uma chamada real; o modelo não deve responder que não tem acesso sem consultar a ferramenta.

“Envie meu Radar agora” pede um resumo extra dos assuntos ativos, sem mudar horários ou ativar envios pausados. A solicitação é identificada pela mensagem original e limitada a uma por minuto e cliente. Ela cria um pedido novo e preserva os envios anteriores sem confirmação; esses registros nunca são repetidos automaticamente. A autorização e a preferência são conferidas novamente antes de transmitir.

Mensagens com mais de 1.024 caracteres usam texto com o link do painel, pois não cabem no botão nativo do WhatsApp. Os parâmetros do botão continuam sendo validados antes dessa escolha. Uma falha após transmitir permanece incerta e não gera um segundo envio automático.

Exemplos:

- “Quero receber notícias de tecnologia todo dia às 8h.”
- “Acompanhe o Flamengo no meu resumo das 7h.”
- “Me avise sempre que tiver jogo do Vasco.” → pergunta em qual horário do dia quer o aviso.
- “Quero acompanhar meu time.” → pergunta o time e o horário que faltarem.
- “Mude meu Radar para as 9h.”
- “Pause o Flamengo.”
- “Meu Radar.”
- “Parar meu Radar.”

Uma consulta agora não cria assinatura. Exemplos e pedidos hipotéticos também não autorizam envios. A confirmação de configuração só aparece depois de persistir a alteração.

Se o Radar estava inteiramente desligado, uma nova assinatura pelo chat ativa somente o assunto pedido. Outros assuntos que estavam sem envio continuam salvos e pausados. A operação é uma transação: falhar ao salvar o horário não pode deixar uma assinatura parcialmente criada. Um pedido de um assunto não muda silenciosamente o horário do resumo de todos os outros.

As respostas curtas de uma configuração incompleta têm prazo de dez minutos e ficam vinculadas à conta, conversa e canal que fizeram o pedido. O assunto público do futebol permanece em memória por até 24 horas para explicar continuações como “Antes do jogo começar”; esse contexto não contém operação ou horário e nunca renova a autorização vencida. Pedir aviso antes do jogo elimina a configuração incompleta, pois o calendário atual não informa horários confirmados. “Todos do Vasco” pode esclarecer essa limitação mesmo após reiniciar o processo, sem criar acompanhamento. Cancelar ou pausar elimina o contexto. Assinaturas e horários já confirmados permanecem no PostgreSQL.

## Fontes gratuitas de futebol e notícias

| Assunto  | Fonte                                                                       | Licença e acesso                                                                                                                                | Cobertura real                                                                                                                                         |
| -------- | --------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Futebol  | [openfootball/south-america](https://github.com/openfootball/south-america) | [CC0 1.0](https://github.com/openfootball/south-america/blob/master/LICENSE.md); sem chave, conta ou assinatura paga                            | Calendário comunitário do Brasileirão Série A e resultados efetivamente preenchidos na fonte. Datas previstas podem mudar. Não é placar ao vivo.       |
| Notícias | [Global Voices em português](https://pt.globalvoices.org/)                  | API pública do próprio editor; CC BY 3.0, indicada no rodapé do site e vinculada a [esta licença](https://creativecommons.org/licenses/by/3.0/) | Busca por assunto nos últimos 30 dias. A frequência varia; não há promessa de cobertura de qualquer cidade ou tema, nem de notícias publicadas no dia. |

O futebol usa exclusivamente o arquivo público da temporada. Não usa escudos, imagens, endpoints privados ou credenciais do operador. Uma partida sem placar permanece sem resultado; uma hora ausente não vira um alarme inventado. O cliente pode escolher o resumo diário ou avisos somente nos dias de jogo. “Me avise quando tiver jogo” escolhe o segundo modo, com horário individual obrigatório, informado pelo cliente. Esse horário não é o início da partida e não muda o horário do resumo dos outros assuntos. Pedidos de antecedência ao apito inicial recebem uma explicação da limitação, sem ativar outro modo silenciosamente.

O modo `matchday` usa a data prevista no fuso da conta. Avaliação e entrega exigem o mesmo dia, partida ainda não concluída, fonte válida e janela de até duas horas após o horário escolhido, limitada à meia-noite local. Reagendamentos, revisões, pausas, silêncio e expiração são conferidos novamente antes do envio. A chave inclui partida e data; enviados, incertos e envios com recibo não são reabertos. A regra de aviso antes do evento continua disponível para séries que tenham instante confirmado.

Notícias guardam apenas título, data e link original, com atribuição ao Global Voices e indicação da licença. Não guardam corpos de artigos, imagens ou perfis de autores. A data original permanece visível. Uma busca sem resultados é diferente de falha da fonte. Conteúdo já incluído no resumo não se repete enquanto a seleção de publicações não mudar.

No WhatsApp, até três matérias são apresentadas em cartões individuais com título, data, crédito e um botão nativo **Ler matéria**. A URL original fica no botão, fora do texto. O restante do Radar continua em um resumo separado. Consultas avulsas também usam cartões e não ativam envios diários; têm deduplicação por mensagem e limite de uma consulta a cada dez segundos por cliente. Cada recibo do lote fica registrado. Uma falha ou interrupção depois de transmitir mantém o lote sem repetição automática; a autorização é conferida antes de cada cartão restante.

As antigas dependências de `ASTRA_RADAR_FOOTBALL_KEY`, `ASTRA_RADAR_FOOTBALL_APPROVED`, football-data.org e GDELT foram removidas desses adaptadores. Uma limitação antiga do GDELT não pode bloquear o novo provedor. No início do coletor, observações antigas dessas fontes são invalidadas e consultas de notícias com erro são reagendadas, sem mudar preferências privadas.

As demais fontes permanecem: MET Norway, Banco Central/PTAX, Frankfurter, TVmaze, Querido Diário, ANEEL e releases públicos no GitHub. Cada adaptador mantém cobertura, frequência, atribuição e tratamento de indisponibilidade próprios.

## Dashboard

- Entrada nativa em `/cliente/radar` e acesso no cabeçalho/navegação do portal.
- Ação principal abre a conversa do bot atualmente conectado com um pedido preenchido; não envia a mensagem automaticamente.
- Visão compacta do estado do resumo, assuntos escolhidos e horário.
- Exemplos de pedidos pelo WhatsApp, sem configurar a conta ao abrir a página.
- Cartões de acompanhamento com ícone, estado, novidades e ações próprias.
- Fonte, data de consulta e limitações disponíveis sem ocupar o lugar principal do conteúdo.
- Horário, silêncio e ativação manual ficam em “Horários e notificações”.
- Adicionar um assunto pelo formulário continua sem habilitar envios automaticamente.
- Layout claro/escuro e navegação móvel preservados; nenhuma biblioteca visual nova.

## Dados e autorização

As seis tabelas do Radar separam recursos públicos, limites dos provedores e cache HTTP das preferências, interesses e caixa de saída de cada cliente. A chave privada é o `data_user_id` estável da conta. Uma troca autorizada de telefone não pode misturar históricos.

A API usa a sessão do portal e exige `X-Astra-Account` nas alterações. A ferramenta de chat recebe a identidade do contexto autenticado, não dos argumentos gerados pelo modelo. Ela confere conversa particular, telefone atual, acesso e identidade novamente depois de uma busca e antes de gravar.

Não são permitidas consultas HTTP arbitrárias. Os hosts e caminhos são fixos, sem redirecionamentos e com resposta limitada. O cache e os intervalos são compartilhados: clientes que seguem o mesmo assunto não fazem uma chamada externa por pessoa. A consulta de notícias usa uma janela diária estável para não anular o cache a cada segundo.

Conteúdo externo nunca é autorização. Depois de uma prévia de notícias, o contexto bloqueia novas alterações nesse mesmo turno. Identificadores internos e falhas de infraestrutura não são enviados ao WhatsApp.

## Operação

O coletor roda em Worker Thread com limite de memória e conexão pequena ao PostgreSQL. Ele não inicia outro gateway, bot ou sessão de canal. O gateway principal continua responsável pela entrega. Os adaptadores novos não precisam de novas chaves nem de serviços pagos.

`ASTRA_RADAR_ENABLED=false` interrompe consultas e novos envios, preservando os dados. A opção `ASTRA_RADAR_WORKER_MODE=external` mantém o modo alternativo de coletor separado, quando houver infraestrutura para isso. O processo normal pode continuar usando `node packages/gateway/dist/server.js`.

Antes do envio, a fila confere preferências, horário de silêncio, acesso, telefone atual, revisão do interesse e validade dos dados. Uma transmissão de resultado incerto fica como `unknown`: não é reenviada automaticamente. Uma rejeição comprovadamente anterior ao transporte pode ser reagendada.

O resumo do Radar é independente do bom-dia diário e do resumo de Gmail. Alterar o Radar não cancela essas outras rotinas.

## Verificação da alteração

A suíte `Astra Radar verification` executa:

1. Regras, fontes públicas, ferramentas de chat, isolamento de contexto, apresentação e regressões dos canais.
2. Testes com PostgreSQL real: identidade, sessões, concorrência, cache, limite de provedor, alteração atômica, cancelamento e recuperação.
3. Avaliação sintética de diferentes tamanhos de população, sem chamadas externas nem envio real.
4. Inicialização e encerramento do coletor em processo, thread e thread compilada.

O portal também tem testes de interação e uma matriz de larguras de 320 a 1440 pixels, nos temas claro e escuro. O teste de 500 conversas sobre assuntos diferentes usa contexto e transporte simulados: ele verifica separação de contas, não comprova 500 sessões reais simultâneas de WhatsApp.

A prova de produção deve registrar separadamente a versão publicada, o carregamento real do Dashboard, as consultas aos provedores e a chegada legível de respostas e de um resumo agendado na conversa de teste autorizada.
