# Confiabilidade dos pagamentos e dos comprovantes financeiros

## Problema corrigido

Um pedido de abatimento podia significar um novo pagamento, um total acumulado já pago ou a correção de um lançamento anterior. As instruções do modelo distinguiam esses casos, mas os executores não verificavam a intenção da mensagem original antes de gravar. Uma correção também podia acabar criando um financiamento com valores inferidos.

Outra falha ocorria após operações concluídas: quando o agente esgotava os turnos ou a resposta final do provedor falhava, a recuperação não reconhecia os resultados das ferramentas de financiamento. O usuário recebia um erro genérico apesar de existirem operações confirmadas.

## Comportamento

- Pedidos ambíguos sobre um total já pago exigem esclarecimento antes de criar despesas, alterar valores ou excluir lançamentos. Variações comuns, possessivos e expressões de valor acumulado compartilham a mesma verificação.
- Cadastro de financiamento exige nome, valor contratado e valor histórico já pago na mensagem atual. O valor histórico, inclusive zero, não gera uma nova despesa.
- Um novo pagamento precisa corresponder ao nome e ao valor da mensagem autenticada. A dívida e a despesa são atualizadas na mesma transação.
- Correções explícitas de categoria ou descrição continuam disponíveis. A exceção permite apenas atualizar o campo solicitado no registro identificado; não permite mudar valor, data, estado ou tipo, criar outro registro ou excluir o anterior.
- As proteções são aplicadas na entrada dos canais e nos executores. Um argumento ou descrição produzido pelo modelo não substitui a mensagem original.
- Gastos comuns com combustível, manutenção, lavagem e seguro continuam disponíveis.

## Repetições e concorrência

O lançamento genérico usa a identidade do cliente, canal, conversa e mensagem. Alterar a descrição numa repetição não cria uma identidade nova. Listas explícitas podem usar posições distintas, derivadas dos itens da própria mensagem; listas ambíguas não recebem posições inventadas. A verificação existente de conteúdo no repositório rejeita uma repetição conflitante.

Os pagamentos de financiamento usam um lock transacional por cliente e verificam tanto o financiamento quanto o valor ao reconhecer uma repetição. O comprovante contém o ID do pagamento, a despesa vinculada e o valor persistido. Repetições com outro valor ou outra dívida são recusadas. O instante recebido no canal determina a data do pagamento, inclusive quando uma fila atravessa a meia-noite.

O bloqueio durável de entrada por ID da mensagem continua protegendo reentregas de mensagens antigas enquanto seu registro de entrada existir. Esta alteração não migra nem compara registros históricos por semelhança. Uma mensagem nova enviada manualmente tem outra identidade: valores iguais, por si só, não provam que dois pagamentos são o mesmo evento.

## Respostas depois de falhas

Comprovantes de financiamento e pagamento usam apenas resultados persistidos. Valores, IDs ou descrições presentes exclusivamente nos argumentos do modelo não confirmam gravação. A resposta apresenta total, pago acumulado, saldo e o valor do pagamento quando há comprovante válido.

Uma falha posterior conserva as operações confirmadas e informa o que ainda está sem confirmação. Não há repetição de ferramentas financeiras para produzir essa resposta. Uma pergunta simples de esclarecimento só substitui o erro quando todas as escritas têm prova explícita de recusa anterior à gravação. Sucesso parcial ou resultado incerto não é apresentado como ausência de alterações.

## Verificação e limites operacionais

As regressões cobrem os dois caminhos de entrada do WhatsApp e Telegram, executores atuais e legados, valores acumulados, correções, respostas após limite de turnos, falhas do provedor, comprovantes incompletos e isolamento de clientes.

`finance-obligations.pg.test.ts` verifica PostgreSQL real: concorrência com a mesma mensagem, conflito entre financiamentos, limite do saldo, rollback após criar a despesa, data original e isolamento. Também verifica que mudar a descrição numa repetição conserva uma única despesa. A CI exige que essa suíte execute sem testes pulados; a qualificação da imagem também a executa.

Não há migração de esquema, alteração automática de lançamentos existentes nem conciliação retroativa nesta correção. A conciliação de um registro já salvo precisa conferir o financiamento, a despesa vinculada e a intenção correta do usuário antes de alterar valores.
