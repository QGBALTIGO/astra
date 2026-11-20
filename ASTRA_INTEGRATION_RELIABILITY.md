# Falhas de ações em aplicativos conectados

## Evidência do incidente

Em 20/11/2026, às 08h54 em America/Campo_Grande (12h54 UTC), o gateway recebeu uma mensagem no WhatsApp. O Groq foi recusado pelo controle local de quota; o OpenRouter atingiu o prazo de sete segundos; a Cloudflare respondeu como alternativa. O agente fez quatro chamadas a `search_tools`, consultou `connected_apps_status`, recebeu falha de `run_connected_action` e terminou por limite de turnos.

O log daquela versão não preservava o aplicativo, a ação nem o motivo específico da falha. Também não contém o texto da mensagem. A sequência não comprova indisponibilidade do aplicativo externo nem autoriza repetir a ação. Esta correção trata lacunas observadas no código; não atribui uma causa específica sem evidência e não reexecuta pedidos anteriores.

## Descoberta e validação

Pedidos genéricos sobre aplicativos ou contas conectadas passam a receber diretamente as ferramentas de integração, assim como pedidos que mencionam Gmail ou Google Agenda. Uma mudança de assunto não herda ferramentas financeiras de mensagens anteriores. A exposição de ferramentas continua separada da autorização de execução.

O prompt compacto diferencia os catálogos: `search_tools` encontra ferramentas do Astra; `search_connected_actions` consulta a ação e o esquema real do aplicativo. Depois da descoberta, `run_connected_action` valida novamente o vínculo do cliente, a ação permitida e os campos. A orientação de não repetir descoberta não substitui essas verificações.

## Evidência de falha

O executor retorna uma estrutura controlada pela aplicação: etapa, motivo conhecido, aplicativo e ação permitidos, além da certeza sobre alterações externas e locais. O diagnóstico não registra argumentos, conteúdo de mensagens, documentos, identificadores de conta, tokens ou corpos de erro do provedor.

`run_connected_action` consulta dados ou prepara uma proposta. A alteração externa depende de outra mensagem de confirmação, processada por `confirm()`. Uma falha ao preparar a proposta ou processar uma consulta pode ocorrer depois de gravar uma proposta, quota ou cópia local; esses casos não são apresentados como ausência de alterações. Erros desconhecidos conservam a incerteza.

As mensagens ao cliente vêm de motivos e rótulos controlados pela aplicação. Campos obrigatórios só aparecem quando pertencem à lista de rótulos conhecidos. Texto livre de provedores e campos extras nos resultados não são usados como explicação confiável.

## Resposta e repetição

Quando todos os resultados relevantes são consultas de status/descoberta e falhas verificadas da ação, o canal pode responder diretamente com o motivo e o próximo passo. Isso também funciona se o modelo falhar ou esgotar turnos. A resposta não depende de outra chamada de IA nem reexecuta a ação para descobrir o que aconteceu.

Essa finalização é intencional: campos rejeitados são apresentados para esclarecimento, sem adivinhar dados ou executar novas tentativas no mesmo turno. Ela não promete recuperar automaticamente uma integração indisponível.

Um resultado incerto anterior não desaparece porque uma tentativa posterior foi recusada antes do envio. A proteção também não substitui comprovantes de outra operação salva, propostas concluídas ou falhas de operações desconhecidas por uma alegação geral de que nada aconteceu.

## Verificação

As regressões cobrem vínculos do próprio cliente, campos obrigatórios, etapas antes e depois de possíveis gravações locais, quotas, ocultação de dados sensíveis nos logs, conteúdo externo malformado, propostas pendentes, resultados financeiros parciais, falha final do provedor e limite de turnos. Os testes usam dados e provedores simulados; não enviam mensagens nem ações a contas reais.

As suítes são executadas pela CI e pela qualificação da imagem. Os limites de tokens, concorrência, quota, prazos de provedor e confirmações de alterações externas permanecem os mesmos. Não há migração de banco nem conciliação retroativa de registros.
