# Protecoes da entrada de novos clientes

## Incidente de referencia

O PR #147 corrigiu o descarte do primeiro contato quando `owner_whatsapp` ainda nao estava configurado. A entrada do cliente nao deve depender da posse administrativa do canal. O teste de 72 horas continua unico por numero elegivel, com dados isolados e sem reautorizar clientes bloqueados, revogados, expirados ou telefones aposentados.

## Publicacao

`publish-astra-image.yml` depende de `astra-onboarding-release.yml` no mesmo commit, alem das qualificacoes ja existentes. A imagem nao e produzida por esse fluxo se a qualificacao falhar ou for pulada. O gate exercita a admissao sem proprietario, resposta inicial sem IA, isolamento, reconexao, avisos duraveis, recuperacao e PostgreSQL real descartavel. Nenhuma credencial ou base de producao e usada nos testes.

Nao publicar imagens antigas de branches que nao contenham os commits integrados. Comparar a revisao OCI com o commit qualificado e usar digest imutavel. Nao contornar os gates. Uma execucao direta ou manual fora desse fluxo nao ganha essa protecao automaticamente.

## Checagem operacional somente-leitura

`GET /health/onboarding` retorna somente `probe` e `status`, com HTTP 200 para `ready` e 503 para `not_ready`. A versao do protocolo impede aceitar o HTML do portal ou um healthcheck generico como sucesso. Diagnosticos sem dados pessoais ficam disponiveis no mount administrativo autenticado `/api/v1/health/onboarding` e nas mudancas de estado dos logs.

A checagem exige modo multiusuario e inscricao automatica explicitamente ligados, um unico canal WhatsApp com conta autenticada, atividade recente do worker, banco acessivel e tabelas de protecao do teste. Sinaliza testes ativos com boas-vindas sem comprovacao de envio apos 10 minutos. Um recibo de outro ciclo nao basta. Clientes intencionalmente inativos nao geram esse alerta. O endpoint nao cria clientes, concede testes, reenvia mensagens, chama IA nem faz consultas externas ao WhatsApp.

Consultas simultaneas compartilham uma unica leitura, com cache interno curto e limite de espera. Uma leitura bloqueada nao gera novas consultas ilimitadas. Um ciclo pulado porque o worker anterior continua executando nao conta como sinal de progresso.

## Monitor externo

`astra-onboarding-monitor.yml` solicita execucao a cada cinco minutos no GitHub Actions, independente do processo do Astra e do computador pessoal. Tres tentativas malsucedidas abrem ou reabrem uma unica issue de incidente e deixam o workflow em falha. Nao comenta a cada rodada. Ao recuperar, registra a recuperacao e fecha a issue. Notificacoes dependem das preferencias do GitHub; nao ha envio de e-mail ou WhatsApp personalizado neste monitor.

O agendamento do GitHub pode atrasar ou deixar de executar. Este mecanismo nao e um SLA de deteccao em cinco minutos. Falha da propria API de issues tambem deixa o workflow em falha. O incidente publico nao deve conter telefones, dados, segredos ou conversas.

## Recuperacao e limites

Avisos comprovadamente nao enviados podem seguir a recuperacao ja implementada. Envio com resultado incerto exige verificacao: reenviar indiscriminadamente pode duplicar a mensagem. A checagem nao altera essa regra. Recuperacao nominal de um primeiro contato continua sendo acao administrativa autorizada, nao uma varredura dos contatos.

Uma checagem pronta nao comprova que um telefone externo enviou uma mensagem, que o WhatsApp a entregou ao gateway, que a IA respondera corretamente nem que o cliente leu a resposta. Falhas upstream sem evento recebido e novos defeitos fora dos cenarios cobertos continuam possiveis. Nao prometer risco zero. Os gates, o monitor e a verificacao de recibos reduzem o risco e tornam os sinais cobertos detectaveis.
