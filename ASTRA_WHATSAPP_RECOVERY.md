# Recuperação de primeiro contato

Mensagens legíveis reservam seu identificador antes do atendimento. Notificações vazias, de protocolo ou ainda cifradas não consomem esse identificador. Conteúdos humanos sem interpretação, como figurinhas, e anexos indisponíveis entram no atendimento de boas-vindas por um marcador neutro, sem enviar contatos, coordenadas ou conteúdo inventado para a IA.

Um pedido antigo comprovado pelo operador pode ser recuperado pelo próprio sistema com a variável privada `ASTRA_WHATSAPP_FIRST_CONTACT_RECOVERY`. É uma operação administrativa nominal, com um único telefone, identificador e expiração de até 24 horas:

```json
{
  "requestId": "example-first-contact-01",
  "phone": "5531999991234",
  "expiresAt": "2026-11-16T23:00:00Z"
}
```

Use apenas o contato cuja recuperação foi autorizada. O serviço exige modo multiusuário, um único WhatsApp conectado, destinatário comprovado pela consulta do WhatsApp e exclusão do número do bot e do proprietário. Ao alterar a configuração, informe uma expiração futura e curta.

O repositório confere novamente as duas grafias brasileiras, contas, aliases, sessões, conversas, mensagens, anexos, concessões anteriores, bloqueios e avisos de acesso. Só um contato novo ou uma descoberta pendente sem atendimento pode receber o primeiro teste de 72 horas. A concessão, as reivindicações das grafias e os avisos duráveis são gravados na mesma transação. Execuções repetidas não estendem o teste nem reabrem um envio incerto.

O worker normal entrega a apresentação e registra o identificador retornado pelo transporte. O bloco de autorização é vinculado ao ciclo exato do teste gratuito e vale somente para a primeira apresentação. A recuperação não fabrica uma mensagem recebida e não define interação a partir de um envio. O evento de log `Boas-vindas de recuperação transmitidas` comprova a transmissão aceita pelo transporte, não a leitura no aparelho do cliente.

Os testes cobrem pedidos expirados, destinatários ambíguos, concorrência, rollback, clientes já atendidos, teste anterior e recibos incertos. A verificação PostgreSQL do CI executa a suíte `whatsapp-trials.pg.test.ts`; os testes de apresentação e entrada fazem parte da regressão WhatsApp.
