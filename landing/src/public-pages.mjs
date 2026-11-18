import { scenarios } from './assets/scenarios.js';

const exampleTitles = {
  financas: 'Registrar um gasto',
  agenda: 'Marcar uma consulta',
  lembretes: 'Lembrar de pagar uma conta',
  tarefas: 'Criar uma tarefa',
  familia: 'Organizar a reunião da escola',
  trabalho: 'Registrar um recebimento',
  estudos: 'Programar um lembrete de estudo',
  metas: 'Acompanhar uma meta',
  notas: 'Consultar uma nota',
  viagens: 'Anotar um gasto de viagem',
};

export const publicPages = [
  {
    path: '/demonstracao',
    title: 'Demonstração do Astra: assistente com IA no WhatsApp',
    description:
      'Veja exemplos ilustrativos de gastos, tarefas, agenda e metas organizados pelo Astra em uma conversa no WhatsApp.',
    body: `<section class="demo-section container" id="demonstracao-interativa" aria-labelledby="demo-title">
      <header class="demo-intro">
        <h1 id="demo-title">O Astra na prática</h1>
        <p>Veja como uma conversa no WhatsApp aparece no seu painel. Os exemplos usam dados fictícios.</p>
      </header>
      <div class="scenario-choice">
        <span id="example-label">Escolha um exemplo</span>
        <details id="scenario-chooser">
          <summary aria-labelledby="example-label example-title"><span id="example-title">${exampleTitles.financas}</span>{{icon:chevron-down}}</summary>
          <div class="scenario-options" role="group" aria-labelledby="example-label">
            ${scenarios.map(({ id }) => `<button type="button" data-example="${id}" aria-pressed="${id === 'financas'}">${exampleTitles[id]} {{icon:check}}</button>`).join('')}
          </div>
        </details>
      </div>
      <div class="demo-workspace">
        <section class="demo-conversation" aria-labelledby="conversation-title">
          <div class="demo-conversation-top">
            <img src="/assets/brand-bc825f0438ab.svg" alt="" width="35" height="32">
            <h2 id="conversation-title">Astra no WhatsApp</h2>
            <button type="button" id="replay" aria-label="Rever conversa">{{icon:replay}} Rever</button>
          </div>
          <div class="demo-chat" id="demo-chat">
            <div class="message message-out">
              <p id="demo-user">Astra, gastei R$ 42 no almoço de hoje.</p>
              <span class="message-time">12:30 {{icon:double-check}}</span>
            </div>
            <div class="message message-in" id="demo-reply-bubble">
              <p id="demo-reply">Anotado: R$ 42,00 em Alimentação. Seu almoço já está nos registros.</p>
              <span class="message-time">12:30</span>
            </div>
          </div>
        </section>
        <section class="demo-dashboard" aria-labelledby="preview-title">
          <div class="demo-dashboard-top">{{icon:layout}}<h2 id="preview-title">Prévia do painel</h2></div>
          <div
            class="dashboard-tabs"
            role="tablist"
            aria-label="Explore as áreas do painel demonstrativo"
          >
            <button
              type="button"
              role="tab"
              id="tab-inicio"
              aria-controls="dashboard-panel"
              aria-selected="false"
              tabindex="-1"
              data-view="inicio"
            >
              {{icon:home}} Início</button
            ><button
              type="button"
              role="tab"
              id="tab-transacoes"
              aria-controls="dashboard-panel"
              aria-selected="true"
              tabindex="0"
              data-view="transacoes"
            >
              {{icon:wallet}} Transações</button
            ><button
              type="button"
              role="tab"
              id="tab-categorias"
              aria-controls="dashboard-panel"
              aria-selected="false"
              tabindex="-1"
              data-view="categorias"
            >
              {{icon:chart}} Categorias</button
            ><button
              type="button"
              role="tab"
              id="tab-agenda"
              aria-controls="dashboard-panel"
              aria-selected="false"
              tabindex="-1"
              data-view="agenda"
            >
              {{icon:calendar}} Agenda</button
            ><button
              type="button"
              role="tab"
              id="tab-perfil"
              aria-controls="dashboard-panel"
              aria-selected="false"
              tabindex="-1"
              data-view="perfil"
            >
              {{icon:user}} Perfil
            </button>
          </div>
          <div
            id="dashboard-panel"
            class="dashboard-panel"
            role="tabpanel"
            aria-labelledby="tab-transacoes"
            tabindex="0"
          >
            <div class="dashboard-view-heading">
              <div>
                <p class="mini-label">NOVEMBRO · 2026</p>
                <h3>Seu dinheiro, com contexto.</h3>
              </div>
              <span class="panel-success">{{icon:check}} Almoço registrado</span>
            </div>
            <div class="stat-pair">
              <div><span>Entradas registradas</span><strong>R$ 4.800,00</strong></div>
              <div><span>Saídas registradas</span><strong>R$ 1.624,00</strong></div>
            </div>
            <div class="transaction-row highlighted">
              <span class="transaction-icon">{{icon:wallet}}</span>
              <div><strong>Almoço</strong><span>Alimentação · Hoje, 12/11</span></div>
              <b>− R$ 42,00</b>
            </div>
            <div class="transaction-row">
              <span class="transaction-icon muted">{{icon:home}}</span>
              <div><strong>Aluguel</strong><span>Casa · 05/11</span></div>
              <b>− R$ 950,00</b>
            </div>
            <div class="transaction-row">
              <span class="transaction-icon muted">{{icon:arrow-down-left}}</span>
              <div><strong>Salário</strong><span>Receita · 05/11</span></div>
              <b class="positive">+ R$ 4.800,00</b>
            </div>
            <div class="balance-line">
              <span>Saldo dos registros</span><strong>R$ 3.176,00</strong>
            </div>
          </div>
        </section>
      </div>
      <p class="visually-hidden" id="demo-status" role="status"></p>
      <div class="demo-note"><a class="text-link" href="https://app.astraacessor.pro/cliente/entrar">Entrar no meu painel {{icon:arrow-up-right}}</a></div>
      <noscript><p class="noscript-note">Ative o JavaScript para trocar de exemplo.</p></noscript>
    </section><section class="closing container"><img class="closing-mark" src="/assets/brand-bc825f0438ab.svg" width="62" height="62" alt=""><h2>Sua próxima mensagem.<br>Uma coisa a menos na cabeça.</h2><p>Finanças, agenda, tarefas e planos.<br>Conte com o Astra nos detalhes do seu dia.</p><a class="button button-dark checkout" href="https://pay.cakto.com.br/CubL455" target="_blank" rel="noopener noreferrer">Quero meu Astra {{icon:arrow-right}}<span class="visually-hidden"> (abre o checkout em outra aba)</span></a><small>R$ 19,90/mês</small></section>`,
  },
  {
    path: '/financas',
    title: 'Controle financeiro pelo WhatsApp com IA | Astra',
    description:
      'Registre gastos e entradas pelo WhatsApp, consulte despesas por categoria e acompanhe seus registros financeiros no painel do Astra.',
    body: '<section class="subpage-hero container"><div class="feature-label"><span class="module-icon">{{icon:wallet}}</span><span>Astra · Finanças</span></div><h1>Seu dinheiro, sem ficar na memória.</h1><p>O almoço, o mercado, o salário que entrou. Conte ao Astra e consulte seus registros depois. Entenda para onde o dinheiro foi, sem montar uma planilha.</p><a class="button button-dark" href="/demonstracao#financas">Explorar um exemplo {{icon:arrow-right}}</a></section><section class="single-product container"><div class="product-art finance-art" role="img" aria-label="Exemplo ilustrativo de gastos registrados e uma consulta sobre alimentação"><div class="white-card expense-summary"><div><small>Despesas registradas neste mês</small><strong><span>R$</span> 1.624<small>,00</small></strong></div><span class="large-module">{{icon:wallet}}</span><p>{{icon:chart}} Seus registros, organizados por categoria.</p></div><div class="white-card spending-list"><strong>Os pequenos gastos também contam.</strong><small>Alguns registros de alimentação</small><div><span class="row-symbol">{{icon:basket}}</span><span>Mercado<small>Alimentação</small></span><b>R$ 152,00</b>{{icon:check}}</div><div><span class="row-symbol">{{icon:utensils}}</span><span>Almoço<small>Alimentação</small></span><b>R$ 42,00</b>{{icon:check}}</div><div><span class="row-symbol">{{icon:coffee}}</span><span>Café<small>Alimentação</small></span><b>R$ 18,00</b>{{icon:check}}</div><footer><span>Estes três registros</span><strong>R$ 212,00</strong></footer></div><div class="message message-out"><p>Quanto anotei com alimentação neste mês?</p><span class="message-time">12:30 {{icon:double-check}}</span></div><div class="message message-in"><strong class=message-author>Astra</strong><p>Você registrou R$ 420,00 em Alimentação neste mês. Separei os gastos por categoria.</p><span class="message-time">12:30 </span></div></div><div><h2>Gastos e entradas.<br>Com valor, data e contexto.</h2><p>Para registrar uma despesa, conte o valor e o motivo: “Gastei R$ 42 no almoço de hoje”. Depois, pergunte quanto registrou em alimentação no mês. Os exemplos usam dados fictícios.</p><p>O painel reúne entradas, saídas e categorias. O saldo mostrado é a diferença entre os registros informados por você; ele não consulta o saldo da sua conta bancária.</p><a class="text-link" href="/metas">Conheça também as metas {{icon:arrow-right}}</a></div></section><section class="faq-section container"><div><h2>Sobre seus registros financeiros</h2><p>Entenda de onde vêm os valores que você acompanha.</p></div><div class="faq-list"><details><summary>Preciso conectar meu banco? {{icon:plus}}</summary><div><p>Nesta experiência, os registros partem das informações que você envia. O Astra não movimenta seu dinheiro. Confira os detalhes em <a href="/seguranca">acesso e privacidade</a>.</p></div></details><details><summary>O resumo inclui todos os meus gastos? {{icon:plus}}</summary><div><p>Inclui os registros que você informou ao Astra. Se você anotar apenas parte das despesas ou entradas, os totais vão refletir essa parte.</p></div></details><details><summary>Anotar uma conta significa que ela foi paga? {{icon:plus}}</summary><div><p>Não. Registrar um gasto ou criar um <a href="/lembretes">lembrete de pagamento</a> organiza a informação. O pagamento precisa ser realizado por você.</p></div></details></div></section><section class="closing container"><img class="closing-mark" src="/assets/brand-bc825f0438ab.svg" width="62" height="62" alt=""><h2>Sua próxima mensagem.<br>Uma coisa a menos na cabeça.</h2><p>Finanças, agenda, tarefas e planos.<br>Conte com o Astra nos detalhes do seu dia.</p><a class="button button-dark checkout" href="https://pay.cakto.com.br/CubL455" target="_blank" rel="noopener noreferrer">Quero meu Astra {{icon:arrow-right}}<span class="visually-hidden"> (abre o checkout em outra aba)</span></a><small>R$ 19,90/mês</small></section>',
  },
  {
    path: '/agenda',
    title: 'Agenda pessoal pelo WhatsApp com IA | Astra',
    description:
      'Organize compromissos pelo WhatsApp com o Astra. Informe data e horário, combine o lembrete e consulte sua agenda na conversa ou no painel.',
    body: '<section class="subpage-hero container"><div class="feature-label"><span class="module-icon">{{icon:calendar}}</span><span>Astra · Agenda</span></div><h1>Você combina. O Astra ajuda a lembrar.</h1><p>Uma mensagem ou um áudio vira compromisso. Combine o lembrete e receba o aviso pelo WhatsApp, para aquela data importante continuar no seu dia.</p><a class="button button-dark" href="/demonstracao#agenda">Explorar um exemplo {{icon:arrow-right}}</a></section><section class="single-product container"><div class="product-art agenda-art" role="img" aria-label="Exemplo ilustrativo de áudio transcrito, compromisso e lembrete no WhatsApp"><div class="audio-example"><span class="audio-play">{{icon:play}}</span><div><div class="waveform" aria-hidden="true"><i></i><i></i><i></i><i></i><i></i><i></i><i></i><i></i><i></i><i></i><i></i><i></i><i></i><i></i><i></i><i></i><i></i><i></i><i></i><i></i><i></i><i></i><i></i><i></i><i></i><i></i><i></i><i></i><i></i><i></i><i></i><i></i></div><small>Áudio transcrito · 0:07</small></div>{{icon:mic}}<p>“Tenho dentista amanhã às 15h. Me lembra uma hora antes.”</p></div><div class="white-card appointment-card"><div class="mini-label">{{icon:calendar}} AGENDA DO ASTRA</div><div class="appointment-date"><strong>13</strong><span>NOV<br>SEXTA</span></div><h3>Dentista</h3><p>13 de novembro · 15:00</p><footer>{{icon:bell}} Lembrete combinado para as 14h.</footer></div><div class="message message-in"><strong class=message-author>Astra</strong><p>Lembrete: seu dentista é hoje, às 15h. Falta uma hora. Pense no tempo do trajeto.</p><span class="message-time">14:00 </span></div></div><div><h2>Um compromisso.<br>Os detalhes no lugar.</h2><p>Informe o assunto, a data e o horário. Se quiser um aviso, diga também quando precisa recebê-lo: “Tenho dentista amanhã às 15h. Me lembra uma hora antes”. Este é um exemplo ilustrativo.</p><p>Confira a data do compromisso e o horário do lembrete na confirmação. Você pode consultar sua agenda pelo WhatsApp e acompanhar os registros no painel.</p><a class="text-link" href="/lembretes">Entenda os lembretes {{icon:arrow-right}}</a></div></section><section class="closing container"><img class="closing-mark" src="/assets/brand-bc825f0438ab.svg" width="62" height="62" alt=""><h2>Sua próxima mensagem.<br>Uma coisa a menos na cabeça.</h2><p>Finanças, agenda, tarefas e planos.<br>Conte com o Astra nos detalhes do seu dia.</p><a class="button button-dark checkout" href="https://pay.cakto.com.br/CubL455" target="_blank" rel="noopener noreferrer">Quero meu Astra {{icon:arrow-right}}<span class="visually-hidden"> (abre o checkout em outra aba)</span></a><small>R$ 19,90/mês</small></section>',
  },
  {
    path: '/lembretes',
    title: 'Lembretes pelo WhatsApp com IA | Astra',
    description:
      'Crie lembretes de contas, compromissos e tarefas pelo WhatsApp. Informe o assunto, a data e o horário e confira a confirmação do Astra.',
    body: '<section class="subpage-hero container"><div class="feature-label"><span class="module-icon">{{icon:bell}}</span><span>Astra · Lembretes</span></div><h1>Combine agora. Lembre na hora certa.</h1><p>Um compromisso, a conta para pagar, o estudo de todo dia. Diga o que precisa lembrar, informe a data e o horário e confira a confirmação do Astra.</p><a class="button button-dark" href="/demonstracao#lembretes">Explorar um exemplo {{icon:arrow-right}}</a></section><section class="single-product container"><div class="product-art agenda-art" role="img" aria-label="Exemplo ilustrativo de áudio transcrito, compromisso e lembrete no WhatsApp"><div class="audio-example"><span class="audio-play">{{icon:play}}</span><div><div class="waveform" aria-hidden="true"><i></i><i></i><i></i><i></i><i></i><i></i><i></i><i></i><i></i><i></i><i></i><i></i><i></i><i></i><i></i><i></i><i></i><i></i><i></i><i></i><i></i><i></i><i></i><i></i><i></i><i></i><i></i><i></i><i></i><i></i><i></i><i></i></div><small>Áudio transcrito · 0:07</small></div>{{icon:mic}}<p>“Tenho dentista amanhã às 15h. Me lembra uma hora antes.”</p></div><div class="white-card appointment-card"><div class="mini-label">{{icon:calendar}} AGENDA DO ASTRA</div><div class="appointment-date"><strong>13</strong><span>NOV<br>SEXTA</span></div><h3>Dentista</h3><p>13 de novembro · 15:00</p><footer>{{icon:bell}} Lembrete combinado para as 14h.</footer></div><div class="message message-in"><strong class=message-author>Astra</strong><p>Lembrete: seu dentista é hoje, às 15h. Falta uma hora. Pense no tempo do trajeto.</p><span class="message-time">14:00 </span></div></div><div><h2>O que lembrar.<br>Quando receber o aviso.</h2><p>Envie o assunto, a data e o horário do lembrete. Para uma conta, por exemplo: “Me lembra amanhã às 9h de pagar a internet”. Para um compromisso, informe também o horário em que ele acontece.</p><p>Confira a confirmação antes de considerar o aviso agendado. Se faltar algum detalhe ou a resposta estiver diferente do pedido, esclareça na conversa. Os exemplos desta página são ilustrativos.</p><a class="text-link" href="/agenda">Organize também sua agenda {{icon:arrow-right}}</a></div></section><section class="faq-section container"><div><h2>Sobre os avisos na conversa</h2><p>Pequenos detalhes ajudam a deixar seu pedido claro.</p></div><div class="faq-list"><details><summary>Como peço um lembrete? {{icon:plus}}</summary><div><p>Diga o assunto, a data e o horário na conversa do WhatsApp. Você também pode enviar áudio. Confira o que o Astra confirmou, especialmente números e datas interpretados.</p></div></details><details><summary>Qual é a diferença entre agenda e lembrete? {{icon:plus}}</summary><div><p>A <a href="/agenda">agenda</a> registra o compromisso e seu horário. O lembrete é um aviso combinado, que pode acontecer antes. Por exemplo: consulta às 15h e aviso às 14h.</p></div></details><details><summary>A demonstração já agenda um aviso? {{icon:plus}}</summary><div><p>Não. A <a href="/demonstracao">demonstração do site</a> usa dados fictícios e não envia mensagens. Para usar o serviço, comece a conversa pelo botão de teste grátis.</p></div></details></div></section><section class="closing container"><img class="closing-mark" src="/assets/brand-bc825f0438ab.svg" width="62" height="62" alt=""><h2>Sua próxima mensagem.<br>Uma coisa a menos na cabeça.</h2><p>Finanças, agenda, tarefas e planos.<br>Conte com o Astra nos detalhes do seu dia.</p><a class="button button-dark checkout" href="https://pay.cakto.com.br/CubL455" target="_blank" rel="noopener noreferrer">Quero meu Astra {{icon:arrow-right}}<span class="visually-hidden"> (abre o checkout em outra aba)</span></a><small>R$ 19,90/mês</small></section>',
  },
  {
    path: '/tarefas',
    title: 'Tarefas e pendências pelo WhatsApp | Astra',
    description:
      'Registre tarefas, informe prazos e combine lembretes pelo WhatsApp. Consulte suas pendências com o Astra e acompanhe seus registros no painel.',
    body: '<section class="subpage-hero container"><div class="feature-label"><span class="module-icon">{{icon:check}}</span><span>Astra · Tarefas</span></div><h1>O que estava na cabeça. Agora tem lugar.</h1><p>A proposta para revisar, uma ideia no meio do caminho, o que ficou para amanhã. Guarde as pendências na conversa e volte a elas quando precisar.</p><a class="button button-dark" href="/demonstracao#tarefas">Explorar um exemplo {{icon:arrow-right}}</a></section><section class="single-product container"><div class="product-art task-art" role="img" aria-label="Exemplo ilustrativo de tarefa com prazo e lembrete"><div class="message message-out"><p>Cria a tarefa de revisar a proposta amanhã às 10h e me lembra às 9h.</p><span class="message-time">16:20 {{icon:double-check}}</span></div><div class="message message-in"><strong class=message-author>Astra</strong><p>Tarefa criada: revisar a proposta, amanhã às 10h. O lembrete ficou para as 9h.</p><span class="message-time">16:20 </span></div><div class="white-card task-sheet"><div><strong>O que precisa da sua atenção</strong><small>Suas tarefas · exemplo</small></div><div class="task-line"><span class="task-square"></span><span>Revisar a proposta<small>Amanhã · 10h</small></span><b>Nova</b></div><div class="task-line"><span class="task-square"></span><span>Separar documentos<small>Sexta-feira</small></span></div><div class="task-line done"><span class="task-square">{{icon:check}}</span><span>Enviar o orçamento<small>Concluída</small></span></div></div><div class="art-caption">{{icon:bell}} O prazo anotado. O lembrete combinado.</div></div><div><h2>A pendência, o prazo.<br>E um aviso, se precisar.</h2><p>Conte o que precisa fazer e informe o prazo: “Cria a tarefa de revisar a proposta amanhã às 10h e me lembra às 9h”. O exemplo é ilustrativo; confira os detalhes confirmados na sua conversa.</p><p>A tarefa registra uma ação a fazer. O lembrete é o aviso para ajudar você a voltar a ela. Consulte as pendências pelo WhatsApp ou acompanhe seus registros no painel.</p><a class="text-link" href="/lembretes">Veja como pedir um lembrete {{icon:arrow-right}}</a></div></section><section class="closing container"><img class="closing-mark" src="/assets/brand-bc825f0438ab.svg" width="62" height="62" alt=""><h2>Sua próxima mensagem.<br>Uma coisa a menos na cabeça.</h2><p>Finanças, agenda, tarefas e planos.<br>Conte com o Astra nos detalhes do seu dia.</p><a class="button button-dark checkout" href="https://pay.cakto.com.br/CubL455" target="_blank" rel="noopener noreferrer">Quero meu Astra {{icon:arrow-right}}<span class="visually-hidden"> (abre o checkout em outra aba)</span></a><small>R$ 19,90/mês</small></section>',
  },
  {
    path: '/metas',
    title: 'Metas financeiras pelo WhatsApp | Astra',
    description:
      'Defina uma meta, informe o valor já guardado e acompanhe seu progresso com o Astra pelo WhatsApp. Os valores são registros informados por você.',
    body: '<section class="subpage-hero container"><div class="feature-label"><span class="module-icon">{{icon:target}}</span><span>Astra · Metas</span></div><h1>Aquele plano. Um pouco mais perto.</h1><p>A próxima viagem, sua reserva, um projeto pessoal. Defina a meta e acompanhe o progresso que você registrar. Um próximo passo fica mais fácil de enxergar.</p><a class="button button-dark" href="/demonstracao#metas">Explorar um exemplo {{icon:arrow-right}}</a></section><section class="single-product container"><div class="product-art goal-art" role="img" aria-label="Exemplo ilustrativo de uma meta de viagem com 65 por cento do valor registrado"><div class="message message-out"><p>Quero guardar R$ 4.000 para viajar. Já tenho R$ 2.600.</p><span class="message-time">18:10 {{icon:double-check}}</span></div><div class="message message-in"><strong class=message-author>Astra</strong><p>Meta Viagem registrada. R$ 2.600,00 de R$ 4.000,00: você chegou a 65% do objetivo.</p><span class="message-time">18:10 </span></div><div class="white-card goal-sheet"><span class="mini-label">{{icon:plane}} SEU PRÓXIMO PLANO</span><h3>Uma viagem para chamar de sua.</h3><div class="goal-figure"><div class="goal-ring"><strong>65<span>%</span></strong></div><div><small>Valor registrado</small><strong>R$ 2.600,00</strong><small>Objetivo de R$ 4.000,00</small></div></div><footer>Mais R$ 1.400,00 para chegar lá.</footer></div><span class="art-caption">Progresso informado por você. Nenhum dinheiro é movimentado.</span></div><div><h2>Seu objetivo.<br>O progresso que você registra.</h2><p>Informe o que deseja alcançar, o valor do objetivo e quanto já guardou. No exemplo ilustrativo da viagem, R$ 2.600 de R$ 4.000 representam 65% da meta; faltam R$ 1.400.</p><p>O progresso depende das informações que você registra. A meta ajuda a acompanhar o plano, sem transferir dinheiro ou fazer aplicações financeiras.</p><a class="text-link" href="/financas">Organize também seus gastos {{icon:arrow-right}}</a></div></section><section class="faq-section container"><div><h2>Sobre o progresso da sua meta</h2><p>Um jeito de acompanhar o valor que você informou.</p></div><div class="faq-list"><details><summary>O Astra guarda ou investe o dinheiro da meta? {{icon:plus}}</summary><div><p>Não. O valor na meta é um registro informado por você. Ele não representa dinheiro depositado no Astra nem uma aplicação financeira.</p></div></details><details><summary>O que preciso informar para começar? {{icon:plus}}</summary><div><p>Conte o objetivo, o valor que deseja alcançar e quanto já guardou. Confira os valores confirmados antes de acompanhar o progresso. Veja os <a href="/como-usar">primeiros passos</a>.</p></div></details></div></section><section class="closing container"><img class="closing-mark" src="/assets/brand-bc825f0438ab.svg" width="62" height="62" alt=""><h2>Sua próxima mensagem.<br>Uma coisa a menos na cabeça.</h2><p>Finanças, agenda, tarefas e planos.<br>Conte com o Astra nos detalhes do seu dia.</p><a class="button button-dark checkout" href="https://pay.cakto.com.br/CubL455" target="_blank" rel="noopener noreferrer">Quero meu Astra {{icon:arrow-right}}<span class="visually-hidden"> (abre o checkout em outra aba)</span></a><small>R$ 19,90/mês</small></section>',
  },
  {
    path: '/notas',
    title: 'Notas e ideias pelo WhatsApp com IA | Astra',
    description:
      'Guarde ideias, anotações e informações pelo WhatsApp. Peça ao Astra para salvar uma nota e consulte o que registrou quando precisar.',
    body: '<section class="subpage-hero container"><div class="feature-label"><span class="module-icon">{{icon:note}}</span><span>Astra · Notas</span></div><h1>Guarde a ideia. Encontre depois.</h1><p>Uma informação do trabalho, o nome daquele lugar, uma anotação que vale guardar. Conte ao Astra, peça para salvar a nota e consulte suas informações quando precisar.</p><a class="button button-dark" href="/demonstracao#notas">Explorar um exemplo {{icon:arrow-right}}</a></section><section class="single-product container"><div class="product-art task-art" role="img" aria-label="Exemplo ilustrativo de consulta a uma nota pessoal sobre uma viagem"><div class="message message-out"><p>Qual o nome da pousada que pedi para anotar?</p><span class="message-time">16:20 {{icon:double-check}}</span></div><div class="message message-in"><strong class="message-author">Astra</strong><p>Na sua nota: Pousada do Lago. Você anotou para consultar a disponibilidade em dezembro.</p><span class="message-time">16:20</span></div><div class="white-card task-sheet"><div><strong>Uma informação para consultar</strong><small>Nota pessoal · exemplo</small></div><div class="task-line"><span class="task-square">{{icon:note}}</span><span>Pousada do Lago<small>Consultar disponibilidade em dezembro</small></span></div></div><div class="art-caption">{{icon:note}} Informação anotada por você.</div></div><div><h2>Uma anotação.<br>Com contexto para consultar.</h2><p>Peça para salvar a informação como nota e inclua um assunto fácil de reconhecer, como uma ideia para um projeto ou uma lista para a viagem.</p><p>Depois, peça para consultar essa nota pelo WhatsApp. Para uma ação com prazo, use uma tarefa; para receber um aviso, peça um lembrete. Os exemplos do site são ilustrativos.</p><a class="text-link" href="/tarefas">Conheça as tarefas {{icon:arrow-right}}</a></div></section><section class="closing container"><img class="closing-mark" src="/assets/brand-bc825f0438ab.svg" width="62" height="62" alt=""><h2>Sua próxima mensagem.<br>Uma coisa a menos na cabeça.</h2><p>Finanças, agenda, tarefas e planos.<br>Conte com o Astra nos detalhes do seu dia.</p><a class="button button-dark checkout" href="https://pay.cakto.com.br/CubL455" target="_blank" rel="noopener noreferrer">Quero meu Astra {{icon:arrow-right}}<span class="visually-hidden"> (abre o checkout em outra aba)</span></a><small>R$ 19,90/mês</small></section>',
  },
  {
    path: '/como-usar',
    title: 'Como usar o Astra no WhatsApp: primeiros passos',
    description:
      'Aprenda a começar no Astra, registrar gastos e lembretes e acessar o painel. Novos contatos têm 3 dias grátis, sem cartão e sem cobrança automática.',
    body: '<section class="subpage-hero container"><p class="eyebrow">DO PRIMEIRO OI AO DIA A DIA</p><h1>Seu jeito de conversar.<br>Um jeito de organizar.</h1><p>O Astra cabe no WhatsApp que você já usa.</p></section><section class="info-content container"><ol class="start-steps"><li><span>01</span><div><h2>Conheça seu Astra.</h2><p>Explore as conversas ilustrativas e veja como gastos, datas e pendências ganham lugar.</p><a class="text-link" href="/demonstracao">Abrir demonstração {{icon:arrow-right}}</a></div></li><li><span>02</span><div><h2>Comece grátis no WhatsApp.</h2><p>Envie a mensagem pronta para experimentar por 3 dias, se for sua primeira conversa com o Astra. Sem cadastro e sem cartão. Depois, assine por R$ 19,90/mês somente se quiser.</p><a class="text-link checkout" href="https://pay.cakto.com.br/CubL455" target="_blank" rel="noopener noreferrer">Testar 3 dias grátis {{icon:arrow-up-right}}</a></div></li><li><span>03</span><div><h2>Conte o que precisa.</h2><p>Durante seu teste, mande uma mensagem pelo WhatsApp. Informe o valor, a data ou o horário que o Astra precisa organizar e confira a confirmação.</p></div></li><li><span>04</span><div><h2>Consulte. Continue seu dia.</h2><p>Pergunte pelos registros salvos ou acompanhe as informações no painel pelo navegador.</p><a class="text-link" href="https://app.astraacessor.pro/cliente/entrar">Acessar meu painel {{icon:arrow-up-right}}</a></div></li></ol></section><section class="faq-section container"><div><h2>Antes da primeira mensagem</h2><p>Respostas para começar com clareza.</p></div><div class="faq-list"><details><summary>Preciso instalar outro aplicativo? {{icon:plus}}</summary><div><p>Você conversa pelo WhatsApp que já usa. O painel abre no navegador do celular ou computador, com seu telefone e o código de verificação enviado ao número cadastrado.</p></div></details><details><summary>Posso enviar áudio e imagem? {{icon:plus}}</summary><div><p>Sim. O Astra tem transcrição de áudio e leitura de imagens. Confira valores, datas e detalhes interpretados. Se a informação estiver incompleta, esclareça na conversa.</p></div></details><details><summary>O que acontece depois dos 3 dias grátis? {{icon:plus}}</summary><div><p>O teste é para novos contatos, sem cadastro e sem cartão. Depois, assine por R$ 19,90/mês se quiser continuar. O fim do teste não gera cobrança automática. Consulte as <a href="/condicoes">condições de contratação</a>.</p></div></details></div></section><section class="closing container"><img class="closing-mark" src="/assets/brand-bc825f0438ab.svg" width="62" height="62" alt=""><h2>Sua próxima mensagem.<br>Uma coisa a menos na cabeça.</h2><p>Finanças, agenda, tarefas e planos.<br>Conte com o Astra nos detalhes do seu dia.</p><a class="button button-dark checkout" href="https://pay.cakto.com.br/CubL455" target="_blank" rel="noopener noreferrer">Quero meu Astra {{icon:arrow-right}}<span class="visually-hidden"> (abre o checkout em outra aba)</span></a><small>R$ 19,90/mês</small></section>',
  },
  {
    path: '/seguranca',
    title: 'Acesso, segurança e privacidade no Astra',
    description:
      'Entenda o acesso por telefone e código de verificação, os registros informados por você e os cuidados ao usar o Astra pelo WhatsApp.',
    body: '<section class="subpage-hero container"><div class="feature-label"><span class="module-icon">{{icon:shield}}</span><span>Astra · Acesso e privacidade</span></div><h1>Suas informações.<br>Com o cuidado que merecem.</h1><p>Clareza sobre o que você compartilha e como acessa o Astra.</p></section><section class="info-content container"><div class="info-columns"><article><h2>Seu acesso é pessoal.</h2><p>O painel pede seu telefone e o código de verificação enviado ao número cadastrado. Não compartilhe esse código.</p></article><article><h2>Exemplos sem dados de clientes.</h2><p>As conversas, valores e gráficos públicos são fictícios. Explorar uma demonstração não cria registros na sua conta.</p></article><article><h2>Você escolhe o que informar.</h2><p>Os valores financeiros vêm das informações registradas. O Astra não pede para conectar seu banco nesta experiência e não movimenta seu dinheiro.</p></article><article><h2>Confira as confirmações.</h2><p>A interpretação por IA pode conter erros. Confira os valores, as datas e os detalhes importantes e peça uma correção quando necessário.</p></article></div><p><a class="text-link" href="/privacidade">Leia a política deste site {{icon:arrow-right}}</a></p><p><a class="text-link" href="/condicoes">Veja os termos da demonstração e contratação {{icon:arrow-right}}</a></p></section><section class="closing container"><img class="closing-mark" src="/assets/brand-bc825f0438ab.svg" width="62" height="62" alt=""><h2>Sua próxima mensagem.<br>Uma coisa a menos na cabeça.</h2><p>Finanças, agenda, tarefas e planos.<br>Conte com o Astra nos detalhes do seu dia.</p><a class="button button-dark checkout" href="https://pay.cakto.com.br/CubL455" target="_blank" rel="noopener noreferrer">Quero meu Astra {{icon:arrow-right}}<span class="visually-hidden"> (abre o checkout em outra aba)</span></a><small>R$ 19,90/mês</small></section>',
  },
  {
    path: '/sobre',
    title: 'O que é o Astra? Assistente pessoal com IA no WhatsApp',
    description:
      'Conheça o Astra: assistente pessoal com IA para finanças, agenda, lembretes, tarefas, metas e notas pelo WhatsApp, com painel no navegador.',
    body: '<section class="subpage-hero container"><p class="eyebrow">SEU ASSISTENTE PESSOAL COM IA</p><h1>Você tem muita coisa<br>para viver.</h1><p>O Astra é um assistente pessoal com inteligência artificial no WhatsApp para organizar finanças, agenda, tarefas e informações do dia a dia.</p></section><section class="about-content container"><p class="large-copy">Uma conta para lembrar. Uma data para não perder. Uma ideia que vale guardar.</p><p>O Astra reúne diferentes formas de ajudar em uma única conversa: finanças, agenda, lembretes, tarefas, metas e notas. Você fala pelo WhatsApp e consulta seus registros quando precisar.</p><div class="module-cards"><a href="/financas"><span class="module-icon">{{icon:wallet}}</span><h2>Finanças</h2><p>Seu dinheiro, com clareza.</p>{{icon:arrow-right}}</a><a href="/agenda"><span class="module-icon">{{icon:calendar}}</span><h2>Agenda</h2><p>Cada compromisso no seu lugar.</p>{{icon:arrow-right}}</a><a href="/lembretes"><span class="module-icon">{{icon:bell}}</span><h2>Lembretes</h2><p>O aviso que chega na hora combinada.</p>{{icon:arrow-right}}</a><a href="/tarefas"><span class="module-icon">{{icon:check}}</span><h2>Tarefas</h2><p>Do que precisa fazer ao que já resolveu.</p>{{icon:arrow-right}}</a><a href="/metas"><span class="module-icon">{{icon:target}}</span><h2>Metas</h2><p>Seus planos, um passo de cada vez.</p>{{icon:arrow-right}}</a><a href="/notas"><span class="module-icon">{{icon:note}}</span><h2>Notas</h2><p>As informações que você quer guardar.</p>{{icon:arrow-right}}</a></div></section><section class="faq-section container"><div><h2>O Astra no seu dia a dia</h2><p>Uma conversa para registrar. Um painel para acompanhar.</p></div><div class="faq-list"><details><summary>O que é o Astra? {{icon:plus}}</summary><div><p>O Astra é um assistente pessoal com inteligência artificial no WhatsApp. Ele ajuda a registrar e consultar finanças, compromissos, lembretes, tarefas, metas e notas. O painel web reúne seus registros pessoais.</p></div></details><details><summary>Para quem ele faz sentido? {{icon:plus}}</summary><div><p>Para quem prefere organizar informações da rotina em uma conversa pelo WhatsApp e consultar seus registros depois. Os <a href="/demonstracao">exemplos ilustrativos</a> ajudam a conhecer os usos antes de experimentar.</p></div></details><details><summary>Como conheço o serviço e falo com a equipe? {{icon:plus}}</summary><div><p>Veja <a href="/como-usar">como começar</a> ou abra a página de <a href="/suporte">suporte</a> para dúvidas sobre acesso e assinatura. Leia também as informações de <a href="/seguranca">acesso e privacidade</a>.</p></div></details></div></section><section class="closing container"><img class="closing-mark" src="/assets/brand-bc825f0438ab.svg" width="62" height="62" alt=""><h2>Sua próxima mensagem.<br>Uma coisa a menos na cabeça.</h2><p>Finanças, agenda, tarefas e planos.<br>Conte com o Astra nos detalhes do seu dia.</p><a class="button button-dark checkout" href="https://pay.cakto.com.br/CubL455" target="_blank" rel="noopener noreferrer">Quero meu Astra {{icon:arrow-right}}<span class="visually-hidden"> (abre o checkout em outra aba)</span></a><small>R$ 19,90/mês</small></section>',
  },
  {
    path: '/suporte',
    title: 'Suporte do Astra: acesso, assinatura e uso',
    description:
      'Receba orientação sobre acesso ao painel, teste grátis, assinatura e uso do Astra. Fale com a equipe para questões de renovação e cancelamento.',
    body: '<section class="subpage-hero container"><div class="feature-label"><span class="module-icon">{{icon:headphones}}</span><span>Astra · Atendimento</span></div><h1>Podemos ajudar<br>com o próximo passo.</h1><p>Dúvidas sobre o Astra, seu acesso ou sua assinatura.<br>Conte para a equipe o que você precisa.</p><button type="button" class="button button-dark" data-contact="question">Falar com a equipe {{icon:arrow-right}}</button></section><section class="info-content container"><div class="info-columns"><article><h2>Entrar no painel</h2><p>Use seu número cadastrado e confira o código recebido pelo WhatsApp. Se precisar de ajuda, informe apenas o necessário no contato.</p><a class="text-link" href="https://app.astraacessor.pro/cliente/entrar">Abrir meu acesso {{icon:arrow-up-right}}</a></article><article><h2>Plano e assinatura</h2><p>Para renovação, cobrança ou cancelamento, tenha as informações da compra em mãos. Não envie dados de cartão, senhas ou documentos pelo formulário.</p><a class="text-link" href="/condicoes">Consultar as condições {{icon:arrow-right}}</a></article></div></section>',
  },
];
