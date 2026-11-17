# Roteamento de texto dos canais

Pedidos explícitos de avisos de jogo e respostas a uma configuração pendente do Radar passam diretamente pela operação autenticada. A mensagem original continua sendo a autorização: exemplos, citações, sugestões sem ação, grupos, mensagens de saída e dados externos não ativam acompanhamentos. O horário precisa ser dito pelo cliente; a pendência pertence à conta, canal e conversa e expira em dez minutos. A conversa geral continua com IA.

Para priorizar a conexão Groq já configurada em texto do WhatsApp e Telegram, o operador pode definir:

```env
ASTRA_CHANNEL_USE_PRIMARY=true
ASTRA_PRIMARY_PROVIDER=groq
ASTRA_GROQ_MODEL=openai/gpt-oss-20b
ASTRA_ONLY_GROQ=false
ASTRA_FALLBACK_CHAIN=groq=openai/gpt-oss-20b
```

O roteamento exige credencial existente e um modelo na lista aprovada. Com a opção ativa, preferências antigas de modelo da sessão continuam salvas, mas deixam de substituir essa escolha para texto desses dois canais. Mídia, painel e outros processos mantêm suas rotas. Desativar a opção restaura a escolha anterior; nenhuma configuração ou sessão do banco é regravada.

O contrato de ferramentas continua obrigatório para operações que dependem da IA. A lista explícita de alternativas mantém o controle existente de modelos e não deduz permissão de gasto a partir de uma chave. A disponibilidade real e os limites da conta do provedor ainda precisam ser verificados em produção; a verificação de `/models` sozinha não comprova uma resposta ao cliente.

Referência do modelo: [documentação oficial Groq](https://console.groq.com/docs/model/openai/gpt-oss-20b).
