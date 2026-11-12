export const pages = {
  '/privacidade.html': {
    path: '/privacidade', title: 'Privacidade deste site | Astra', heading: 'Privacidade, com clareza.',
    description: 'Entenda como os formulários e as demonstrações da landing page do Astra tratam informações.',
    body: `<p class="info-date">Atualizado em 12 de novembro de 2026.</p><p>Esta política explica o site de apresentação do Astra e seus formulários. O assistente autenticado e o checkout têm operações próprias; esta página não substitui as informações desses ambientes.</p>
    <h2>O que acontece na demonstração</h2><p>As conversas, valores, nomes e gráficos são fictícios. Trocar os exemplos não envia mensagens ao assistente, não cria registros na sua conta e não solicita dados pessoais.</p>
    <h2>Quando você fala com a equipe</h2><p>O formulário recebe e-mail, nome opcional, a mensagem que você escrever e sua autorização para contato. Também registra data, protocolo e tipo de solicitação. Não envie senhas, documentos ou dados de cartão.</p>
    <h2>Finalidade e prazo</h2><p>Essas informações servem para responder à sua solicitação sobre o Astra. O envio do formulário não cria uma assinatura nem realiza uma cobrança. Os registros ficam em banco de dados do projeto, hospedado na Railway, e não são exibidos publicamente. São removidos depois de 90 dias pela rotina de limpeza ou quando você usa seu link pessoal de remoção.</p>
    <h2>Contadores e proteção contra abuso</h2><p>O site conta ações de forma agregada por dia, como visualização do plano e solicitações registradas, sem cookies de publicidade. Identificadores temporários derivados do IP protegem os formulários contra abuso e são descartados em até dois dias. Do Not Track e Global Privacy Control são respeitados na contagem de eventos de navegação.</p>
    <h2>Serviços externos</h2><p>As fontes e os recursos visuais desta página são servidos pelo próprio site. Ao abrir o checkout oficial, a Cakto recebe os dados necessários ao pagamento segundo sua própria política. O link do painel leva a um ambiente separado do Astra, que exige autenticação. O site de apresentação não pede conexão com sua conta bancária ou Google.</p>
    <h2>Remover uma solicitação ou falar com a equipe</h2><p>Guarde o link pessoal mostrado depois de enviar o formulário. Ele permite excluir aquela solicitação mediante confirmação; abrir o link não exclui nada. A remoção não cancela sua assinatura nem exclui sua conta do assistente. Para outras questões, use <a href="/#contato">o contato no site</a> e informe apenas o necessário.</p>`
  },
  '/condicoes.html': {
    path: '/condicoes', title: 'Termos, demonstração e contratação | Astra', heading: 'Antes de assinar, tudo claro.',
    description: 'Informações sobre a assinatura e condições das demonstrações do Astra.',
    body: `<p class="info-date">Atualizado em 12 de novembro de 2026.</p><h2>O produto</h2><p>O Astra é um assistente pessoal com inteligência artificial pelo WhatsApp para organizar informações como finanças, tarefas, lembretes, compromissos e metas. O painel web permite acompanhar os registros pessoais com seu acesso pessoal.</p>
    <h2>Preço e checkout oficial</h2><p>O plano apresentado custa R$ 19,90/mês. Antes de pagar, revise os dados da assinatura, a recorrência, os meios de pagamento, a identificação do fornecedor, as condições de cancelamento e os demais termos apresentados no checkout e no comprovante.</p><p><a href="https://pay.cakto.com.br/CubL455" target="_blank" rel="noopener noreferrer">Abrir o checkout oficial da Cakto (outra aba)</a></p>
    <h2>Sobre a demonstração</h2><p>Os exemplos desta landing são simulações guiadas com dados fictícios. Não são uma conversa ao vivo com a IA, uma conta real, um teste gratuito do serviço ou relatos de clientes. Não criam registros no produto. A prévia representa recursos existentes, mas não permite alterar uma conta.</p>
    <h2>Registros e confirmações</h2><p>Confira valores, datas e detalhes que o assistente interpretar. A interpretação de texto, áudio e imagem pode conter erros. As informações financeiras exibidas são registros do usuário: anotar um pagamento não realiza uma transação, conecta um banco ou confirma uma transferência. Integrações dependem de disponibilidade e de configuração da conta e não são habilitadas nesta demonstração.</p>
    <h2>Atendimento e cancelamento</h2><p>O formulário apenas registra uma solicitação para a equipe responder. Não envia confirmação automática por e-mail e não contrata ou cancela a assinatura. Para suporte, renovação ou cancelamento, consulte as informações da compra e <a href="/#contato">fale com a equipe</a>. Não envie dados de cartão ou documentos pelo formulário.</p>
    <h2>Marcas</h2><p>WhatsApp e as demais marcas citadas pertencem aos seus respectivos titulares. A apresentação do produto não implica parceria ou endosso dessas empresas.</p>`
  },
  '/remover.html': {
    path: '/remover', title: 'Remover solicitação de contato | Astra', heading: 'Você escolhe o que fica.', noindex: true,
    description: 'Remova uma solicitação enviada pelo formulário da landing page do Astra.',
    body: `<p>Esta página remove somente uma solicitação de contato feita neste site. É necessário o link pessoal mostrado no envio do formulário.</p><p id="remove-status" role="status" aria-live="polite">Abra o seu link pessoal e ative o JavaScript para continuar.</p><button class="button button-dark" id="remove-request" disabled type="button">Confirmar remoção da solicitação</button><p><a href="/">Voltar ao site do Astra</a></p>`
  },
  '/404.html': {
    path: '/404', title: 'Página não encontrada | Astra', heading: 'Vamos voltar ao caminho?', noindex: true,
    description: 'Esta página não foi encontrada. Conheça o Astra ou volte ao início.',
    body: `<p>Não encontramos esta página. O endereço pode ter mudado ou ter sido digitado de outra forma.</p><a class="button button-blue" href="/">Voltar para o Astra {{icon:arrow-right}}</a>`
  }
};
