import { scenarios, scenarioState, base, money } from './scenarios.js';

const $ = (selector, root = document) => root.querySelector(selector);
const $$ = (selector, root = document) => [...root.querySelectorAll(selector)];
const icon = (name) => `<svg class="icon" aria-hidden="true"><use href="/assets/icons.svg#${name}"></use></svg>`;
const reducedMotion = matchMedia('(prefers-reduced-motion: reduce)');

// Native dialogs provide an inert background, Escape support and a focus boundary.
const menu = $('#mobile-menu');
const menuToggle = $('.menu-toggle');
let menuReturn = null;
function syncScrollLock() {
  document.body.classList.toggle('modal-open', Boolean($('dialog[open]')));
}
menuToggle?.addEventListener('click', () => {
  menuReturn = document.activeElement;
  menu.showModal();
  menuToggle.setAttribute('aria-expanded', 'true');
  syncScrollLock();
});
function closeMenu(restore = true) {
  if (!menu?.open) return;
  if (!restore) menuReturn = null;
  menu.close();
}
menu?.addEventListener('close', () => {
  menuToggle?.setAttribute('aria-expanded', 'false');
  syncScrollLock();
  menuReturn?.focus({ preventScroll: true });
});
$('[data-close-menu]')?.addEventListener('click', () => closeMenu());
$$('a', menu || document.createElement('nav')).forEach((link) => link.addEventListener('click', () => closeMenu(false)));
matchMedia('(min-width: 960px)').addEventListener('change', (event) => { if (event.matches) closeMenu(false); });

const panel = $('#dashboard-panel');
const tabs = $$('[data-view]');
let activeScenario = scenarios[0];
let activeView = activeScenario.tab;
let replayTimer;
const transaction = (title, detail, amount, { highlight = false, symbol = 'wallet', positive = false } = {}) =>
  `<div class="transaction-row${highlight ? ' highlighted' : ''}"><span class="transaction-icon${highlight ? '' : ' muted'}">${icon(symbol)}</span><div><strong>${title}</strong><span>${detail}</span></div><b${positive ? ' class="positive"' : ''}>${positive ? '+' : '−'} ${money(amount)}</b></div>`;
const heading = (title) => `<div class="dashboard-view-heading"><div><p class="mini-label">NOVEMBRO · 2026</p><h3>${title}</h3></div><span class="panel-success">${icon('check')} ${activeScenario.cta}</span></div>`;
const agendaItem = (time, title, detail, symbol = 'calendar') => `<div class="agenda-list-item"><time>${time}</time><div><strong>${title}</strong><span>${detail}</span></div>${icon(symbol)}</div>`;
const goal = () => `<div class="dashboard-goal"><div><strong>Meta: Viagem</strong><small>${money(base.goal)} de ${money(base.target)}</small></div><div class="progress-track" role="progressbar" aria-label="Progresso da meta Viagem" aria-valuemin="0" aria-valuemax="100" aria-valuenow="65"><span></span></div><small>65% do objetivo registrado · Progresso informado por você</small></div>`;

function dashboardMarkup(view) {
  const state = scenarioState(activeScenario);
  if (view === 'inicio') return `${heading('Seu dia, em uma visão.')}
    <div class="overview-balance"><span>Saldo dos registros</span><strong>${money(state.balance)}</strong></div>
    <div class="overview-items"><div><small>PRÓXIMO COMPROMISSO</small><strong>Dentista</strong><span>13 de novembro · 15h</span></div><div><small>PARA NÃO ESQUECER</small><strong>Revisar a proposta</strong><span>12 de novembro · 17h</span></div></div>${goal()}`;
  if (view === 'transacoes') {
    const monetary = ['expense', 'income'].includes(activeScenario.kind);
    return `${heading('Seu dinheiro, com contexto.')}
      <div class="stat-pair"><div><span>Entradas registradas</span><strong>${money(state.income)}</strong></div><div><span>Saídas registradas</span><strong>${money(state.expenses)}</strong></div></div>
      ${monetary ? transaction(activeScenario.record, activeScenario.detail, activeScenario.amount, { highlight: true, positive: activeScenario.kind === 'income' }) : transaction('Mercado', 'Alimentação · 11/11', 15200, { symbol: 'wallet' })}
      ${transaction('Aluguel', 'Casa · 05/11', 95000, { symbol: 'home' })}
      ${transaction('Salário', 'Receita · 05/11', 480000, { positive: true, symbol: 'arrow-down-left' })}
      <div class="balance-line"><span>Saldo dos registros</span><strong>${money(state.balance)}</strong></div>`;
  }
  if (view === 'categorias') {
    const colors = { navy: '#263f65', blue: '#0061fd', sky: '#5685be', gray: '#8c9eb7', violet: '#7370ad' };
    return `${heading('Cada gasto tem seu lugar.')}<div class="balance-line"><span>Total das despesas registradas</span><strong>${money(state.expenses)}</strong></div>${state.categories.map((category) => `<div class="category-row" style="--bar-color:${colors[category.color]};--bar-width:${(category.amount / state.expenses * 100).toFixed(2)}%"><div class="category-label"><span><i></i>${category.name}</span><strong>${money(category.amount)}</strong></div><div class="category-bar" aria-hidden="true"><i></i></div></div>`).join('')}`;
  }
  if (view === 'agenda') {
    const hasEvent = ['event', 'reminder', 'task'].includes(activeScenario.kind);
    return `${heading('O que vem pela frente.')}<div class="agenda-day"><div class="agenda-date"><small>NOV</small><b>12</b></div><div><strong>Uma coisa de cada vez.</strong><span>Compromissos, tarefas e lembretes.</span></div></div>
      ${hasEvent ? agendaItem(activeScenario.time, activeScenario.record, `${activeScenario.detail} · ${activeScenario.note}`, activeScenario.icon) : agendaItem('15:00', 'Dentista', '13 de novembro · Aviso às 14h')}
      ${agendaItem('17:00', 'Revisar a proposta', '12 de novembro · Tarefa pendente', 'check')}
      ${agendaItem('18:00', 'Pagar a fatura', '12 de novembro · Lembrete no WhatsApp', 'bell')}`;
  }
  return `${heading('Um espaço que é seu.')}<div class="profile-person"><span class="profile-avatar">MC</span><div><strong>Marina Costa</strong><p>Perfil fictício · Demonstração</p></div></div><div class="profile-setting"><span>Acesso ao painel</span><strong>Código pelo WhatsApp</strong></div><div class="profile-setting"><span>Moeda dos registros</span><strong>Real brasileiro (R$)</strong></div><div class="profile-setting"><span>Preferência de tema</span><strong>Claro, escuro ou sistema</strong></div><p class="profile-note">Esta prévia não permite alterar uma conta. Para consultar e editar seus dados reais, entre no seu painel pessoal.</p>`;
}
function showView(view, focusTab = false) {
  if (!panel || !tabs.some((tab) => tab.dataset.view === view)) return;
  activeView = view;
  tabs.forEach((tab) => {
    const selected = tab.dataset.view === view;
    tab.setAttribute('aria-selected', String(selected));
    tab.tabIndex = selected ? 0 : -1;
    if (selected && focusTab) tab.focus({ preventScroll: true });
  });
  panel.setAttribute('aria-labelledby', `tab-${view}`);
  panel.innerHTML = dashboardMarkup(view);
}
tabs.forEach((tab, index) => {
  tab.addEventListener('click', () => showView(tab.dataset.view));
  tab.addEventListener('keydown', (event) => {
    let next;
    if (event.key === 'ArrowRight') next = (index + 1) % tabs.length;
    if (event.key === 'ArrowLeft') next = (index - 1 + tabs.length) % tabs.length;
    if (event.key === 'Home') next = 0;
    if (event.key === 'End') next = tabs.length - 1;
    if (next === undefined) return;
    event.preventDefault();
    showView(tabs[next].dataset.view, true);
  });
});
function playScenario(scenario, animate = true) {
  clearTimeout(replayTimer);
  activeScenario = scenario;
  $$('[data-scenario]').forEach((button) => button.setAttribute('aria-pressed', String(button.dataset.scenario === scenario.id)));
  $('#demo-user').textContent = scenario.user;
  $('#demo-tag').textContent = scenario.tag;
  $('#demo-status').textContent = '';
  const reply = $('#demo-reply');
  const bubble = $('#demo-reply-bubble');
  const workspace = $('.demo-workspace');
  const finish = () => {
    reply.textContent = scenario.reply;
    workspace.classList.remove('demo-pending');
    panel.removeAttribute('aria-busy');
    showView(scenario.tab);
    if (animate && !reducedMotion.matches) {
      bubble.classList.remove('message-enter');
      panel.classList.remove('panel-enter');
      // A fresh frame restarts only these finite, small entrance animations.
      requestAnimationFrame(() => { bubble.classList.add('message-enter'); panel.classList.add('panel-enter'); });
    }
    $('#demo-status').textContent = `${scenario.label}: ${scenario.cta}. A prévia do painel foi atualizada. Dados fictícios.`;
  };
  if (!animate || reducedMotion.matches) { finish(); return; }
  workspace.classList.add('demo-pending');
  panel.setAttribute('aria-busy', 'true');
  reply.innerHTML = '<span class="typing" aria-label="Preparando exemplo"><i></i><i></i><i></i></span>';
  replayTimer = setTimeout(finish, 320);
}
$$('[data-scenario]').forEach((button) => button.addEventListener('click', () => playScenario(scenarios.find((scenario) => scenario.id === button.dataset.scenario))));
$('#replay')?.addEventListener('click', () => playScenario(activeScenario));

// All requests keep the existing landing API contract and its CSRF protection.
const contact = $('#contact-dialog');
const form = $('#contact-form');
let contactReturn;
let csrf = '';
let formRun = 0;
let requestId = '';
let previousPayload = '';
let requestController;
async function getToken(signal) {
  const response = await fetch('/api/form-token', { cache: 'no-store', signal });
  if (!response.ok) throw Error('Não foi possível preparar o formulário. Tente novamente.');
  const data = await response.json();
  if (typeof data.token !== 'string') throw Error('O formulário não está disponível agora. Tente novamente.');
  return data.token;
}
function track(event) {
  if (navigator.doNotTrack === '1' || navigator.globalPrivacyControl) return;
  fetch('/api/evento', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ event }), keepalive: true }).catch(() => {});
}
function openContact() {
  if (!contact || contact.open) return;
  closeMenu(false);
  formRun++;
  requestId = crypto.randomUUID();
  previousPayload = '';
  contactReturn = document.activeElement;
  form.reset();
  form.hidden = false;
  form.removeAttribute('aria-busy');
  $('#contact-success').hidden = true;
  $('#contact-status').textContent = '';
  $('#contact-submit').disabled = false;
  $('#contact-submit').innerHTML = `Enviar solicitação ${icon('arrow-right')}`;
  $('#contact-title').textContent = 'Vamos conversar?';
  $('#contact-intro').textContent = 'Conte como podemos ajudar. Sua solicitação será registrada para a equipe responder.';
  contact.showModal();
  syncScrollLock();
  track('contact_open');
}
$$('[data-contact]').forEach((button) => button.addEventListener('click', () => openContact(button.dataset.contact)));
$$('[data-close-contact]').forEach((button) => button.addEventListener('click', () => contact.close()));
contact?.addEventListener('close', () => {
  formRun++;
  requestController?.abort();
  requestController = undefined;
  syncScrollLock();
  contactReturn?.focus({ preventScroll: true });
});
$$('dialog').forEach((dialog) => dialog.addEventListener('click', (event) => {
  if (event.target !== dialog) return;
  const rect = dialog.getBoundingClientRect();
  if (event.clientX < rect.left || event.clientX > rect.right || event.clientY < rect.top || event.clientY > rect.bottom) dialog.close();
}));
form?.addEventListener('submit', async (event) => {
  event.preventDefault();
  if (requestController || !form.reportValidity()) return;
  const run = formRun;
  const data = new FormData(form);
  const fields = { name: data.get('name'), email: data.get('email'), message: data.get('message'), website: data.get('website'), consent: form.elements.consent.checked, intent: 'contato' };
  const fingerprint = JSON.stringify(fields);
  if (previousPayload && previousPayload !== fingerprint) requestId = crypto.randomUUID();
  previousPayload = fingerprint;
  const payload = { ...fields, requestId };
  const submit = $('#contact-submit');
  const status = $('#contact-status');
  requestController = new AbortController();
  const controller = requestController;
  const timer = setTimeout(() => controller.abort(), 12000);
  submit.disabled = true;
  submit.textContent = 'Enviando solicitação…';
  form.setAttribute('aria-busy', 'true');
  status.textContent = 'Registrando sua solicitação…';
  try {
    if (!csrf) csrf = await getToken(controller.signal);
    const response = await fetch('/api/interesse', { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Astra-Form-Token': csrf }, body: JSON.stringify(payload), signal: controller.signal });
    const result = await response.json().catch(() => ({}));
    if (formRun !== run || !contact.open) return;
    if (!response.ok) { if (response.status === 403) csrf = ''; throw Error(result.error || 'Não foi possível registrar agora. Tente novamente.'); }
    if (!/^ASTRA-[a-f0-9-]{36}$/i.test(result.receipt || '') || !/^[a-f0-9]{64}$/.test(result.cancellationToken || '')) throw Error('Não conseguimos confirmar o registro. Tente novamente com os mesmos dados.');
    form.hidden = true;
    $('#contact-success').hidden = false;
    $('#receipt').value = result.receipt;
    $('#removal-link').href = `/remover#${result.cancellationToken}`;
    $('#success-title').focus({ preventScroll: true });
  } catch (error) {
    if (formRun !== run || !contact.open) return;
    status.textContent = error.name === 'AbortError' ? 'A conexão demorou. Tente novamente com os mesmos dados; o protocolo evita duplicidade.' : error.message;
    status.focus({ preventScroll: true });
  } finally {
    clearTimeout(timer);
    if (requestController === controller) requestController = undefined;
    if (formRun === run) {
      submit.disabled = false;
      submit.innerHTML = `Enviar solicitação ${icon('arrow-right')}`;
      form.removeAttribute('aria-busy');
    }
  }
});

const remove = $('#remove-request');
if (remove) {
  const value = location.hash.slice(1);
  history.replaceState(null, '', location.pathname);
  const valid = /^[a-f0-9]{64}$/.test(value);
  remove.disabled = !valid;
  $('#remove-status').textContent = valid ? 'Para excluir esta solicitação de contato, confirme no botão abaixo. Sua assinatura e sua conta do Astra não serão alteradas.' : 'Abra o link pessoal exibido ao concluir o formulário para remover aquela solicitação. Este endereço sem o código não permite localizar um cadastro.';
  remove.addEventListener('click', async () => {
    remove.disabled = true;
    $('#remove-status').textContent = 'Removendo a solicitação…';
    try {
      const response = await fetch('/api/remover', { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Astra-Form-Token': await getToken(AbortSignal.timeout(12000)) }, body: JSON.stringify({ token: value }), signal: AbortSignal.timeout(12000) });
      if (!response.ok) throw Error();
      $('#remove-status').textContent = 'Solicitação removida ou já inexistente. Nenhum novo contato será feito por esse cadastro.';
      remove.textContent = 'Solicitação removida';
    } catch {
      $('#remove-status').textContent = 'Não foi possível remover agora. Tente novamente.';
      remove.disabled = false;
    }
  });
}
if ($('#plano') && 'IntersectionObserver' in window) {
  const observer = new IntersectionObserver((entries) => { if (entries.some((entry) => entry.isIntersecting)) { track('plan_view'); observer.disconnect(); } }, { threshold: .15 });
  observer.observe($('#plano'));
}
if (['#contato', '#interesse'].includes(location.hash)) openContact();
if (['#painel', '#experimente', '#funcionalidades', '#como'].includes(location.hash)) {
  const aliases = { '#painel': '#na-pratica', '#experimente': '#na-pratica', '#funcionalidades': '#recursos', '#como': '#como-comecar' };
  const target = aliases[location.hash];
  history.replaceState(null, '', target);
  $(target)?.scrollIntoView();
}
