import { chromium, expect } from '@playwright/test';
import { mkdir, writeFile, readFile } from 'node:fs/promises';
import {
  BASE,
  ago,
  mockReleaseDashboard,
  portfolioSeed,
} from './e2e/release-dashboard-fixtures.mjs';

const output = 'test-results/release-dashboard';
await mkdir(output, { recursive: true });
const filterWidth = process.argv.find((value) => value.startsWith('--width='))?.slice(8);
const filterTheme = process.argv.find((value) => value.startsWith('--theme='))?.slice(8);
const only = process.argv.find((value) => value.startsWith('--only='))?.slice(7);
const phase = process.argv.find((value) => value.startsWith('--phase='))?.slice(8) || 'all';
const browser = await chromium.launch({
  ...(process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH
    ? { executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH }
    : { channel: 'chrome' }),
  headless: true,
});
const report = {
  baseURL: BASE,
  scope:
    'Integrated real React customer routes, synthetic account and durable API stubs only. Chrome disposable contexts; all customer API, market data, logos, referral requests and external network calls intercepted. No user browser/storage, provider traffic, actual OTP/WhatsApp or payout.',
  startedAt: new Date().toISOString(),
  tests: [],
  screenshots: [],
};
const routes = [
  ['', 'Início'],
  ['transacoes', 'Transações'],
  ['agenda', 'Agenda'],
  ['planejamento', 'Planejamento'],
  ['categorias', 'Categorias'],
  ['conexoes', 'Conexões'],
  ['radar', 'Radar'],
  ['perfil', 'Perfil'],
  ['investimentos', 'Investimentos'],
  ['indicacoes', 'Indique o Astra'],
];
const noDemo = /\b(pr[ée]via|demonstra[cç][aã]o|dados ilustrativos|vers[aã]o de teste)\b/i;
const check = (value, message) => {
  if (!value) throw new Error(message);
};
async function run(name, fn) {
  if (only && !name.includes(only)) return;
  try {
    const details = await fn();
    report.tests.push({ name, pass: true, ...details });
    console.log('PASS ' + name);
  } catch (error) {
    report.tests.push({ name, pass: false, error: String(error.stack || error) });
    console.log('FAIL ' + name + ': ' + error.message);
  }
}
async function opened(options = {}) {
  const width = options.width || 390,
    theme = options.theme || 'light';
  const context = await browser.newContext({
    viewport: { width, height: width < 700 ? 900 : 1024 },
    locale: 'pt-BR',
    timezoneId: 'America/Campo_Grande',
    reducedMotion: 'reduce',
    colorScheme: theme,
    serviceWorkers: 'block',
  });
  await context.addInitScript(() => {
    window.__qaShares = [];
    Object.defineProperty(navigator, 'share', {
      configurable: true,
      value: async (data) => {
        window.__qaShares.push(data);
      },
    });
  });
  const page = await context.newPage();
  page.setDefaultTimeout(10000);
  const errors = [];
  page.on('pageerror', (error) => errors.push(page.url() + ' ' + String(error.stack || error)));
  const api = await mockReleaseDashboard(page, options);
  return { context, page, api, errors, width, theme };
}
const panel = (page) => page.locator('main .ac-tab-panel:not([hidden])');
async function visit(c, path) {
  await c.page.goto(BASE + '/cliente' + (path ? '/' + path : ''), { timeout: 60000 });
  await expect(c.page.locator('.astra-customer')).toBeVisible();
  await expect(panel(c.page).getByRole('heading', { level: 1 })).toHaveCount(1);
  await expect(panel(c.page).getByRole('heading', { level: 1 })).toBeVisible();
  await c.page.evaluate(() => document.fonts.ready);
  await expect(panel(c.page).locator('.ac-loading')).toHaveCount(0);
}
async function shot(c, name) {
  const path = output + '/' + name + '.png';
  await c.page.screenshot({ path, fullPage: false, animations: 'disabled' });
  report.screenshots.push(path);
  return path;
}
async function geometry(page) {
  const value = await page.evaluate(() => {
    const root = document.querySelector('.astra-customer'),
      groups = [];
    for (const group of root.querySelectorAll('.ac-segmented, .segmented-control')) {
      const rect = group.getBoundingClientRect();
      if (!rect.width || !rect.height || group.closest('[hidden]')) continue;
      const buttons = [...group.children].filter((item) => item.tagName === 'BUTTON');
      groups.push({
        label: group.getAttribute('aria-label'),
        width: rect.width,
        left: rect.left,
        right: rect.right,
        radius: parseFloat(getComputedStyle(group).borderRadius),
        buttons: buttons.map((button) => {
          const r = button.getBoundingClientRect(),
            text = document.createRange();
          text.selectNodeContents(button);
          const t = text.getBoundingClientRect(),
            style = getComputedStyle(button);
          return {
            text: button.textContent.trim(),
            width: r.width,
            height: r.height,
            left: r.left,
            right: r.right,
            textLeft: t.left,
            textRight: t.right,
            selected:
              button.getAttribute('aria-selected') === 'true' ||
              button.getAttribute('aria-pressed') === 'true' ||
              button.classList.contains('active'),
            background: style.backgroundColor,
            color: style.color,
            after: getComputedStyle(button, '::after').display,
          };
        }),
      });
    }
    return {
      overflow:
        Math.max(document.documentElement.scrollWidth, document.body.scrollWidth) - innerWidth,
      viewport: innerWidth,
      groups,
    };
  });
  check(value.overflow <= 1, 'Horizontal page overflow ' + value.overflow + 'px');
  for (const group of value.groups) {
    check(group.radius >= 100, 'Non-pill track: ' + group.label);
    check(
      group.left >= -1 && group.right <= value.viewport + 1,
      'Selector extends outside viewport: ' + group.label
    );
    const widths = group.buttons.map((value) => value.width);
    check(
      Math.max(...widths) - Math.min(...widths) <= 1,
      'Unequal selector columns: ' + group.label
    );
    for (const button of group.buttons) {
      check(button.height >= 43.5, 'Small selection touch area: ' + button.text);
      check(
        button.textLeft >= button.left - 1 && button.textRight <= button.right + 1,
        'Clipped selection label: ' + button.text
      );
      check(button.after === 'none', 'Legacy underline on ' + button.text);
    }
  }
  return value;
}
async function clean(c) {
  check(c.errors.length === 0, 'Page errors: ' + c.errors.join(' | '));
  check(
    c.api.unexpectedRequests.length === 0,
    'Unexpected APIs: ' + c.api.unexpectedRequests.join(' | ')
  );
  check(c.api.credentialHeaders.length === 0, 'Client sent provider/admin credentials');
}
async function modalActions(page) {
  const dialog = page.getByRole('dialog');
  await expect(dialog).toBeVisible();
  const actions = dialog
    .locator('.ac-dialog-footer > button, .modal-actions > button')
    .filter({ visible: true });
  if ((await actions.count()) !== 2) throw new Error('Expected a two-action dialog');
  await actions.last().scrollIntoViewIfNeeded();
  const boxes = await actions.evaluateAll((buttons) =>
    buttons.map((button) => {
      const r = button.getBoundingClientRect();
      return { text: button.textContent, x: r.x, y: r.y, width: r.width, height: r.height };
    })
  );
  check(Math.abs(boxes[0].y - boxes[1].y) <= 1, 'Dialog actions are stacked');
  check(Math.abs(boxes[0].width - boxes[1].width) <= 1, 'Dialog action widths are unbalanced');
  check(
    boxes.every((box) => box.height >= 44),
    'Dialog actions too short'
  );
  return boxes;
}

async function matrix(width, theme) {
  const c = await opened({ width, theme }),
    evidence = [];
  try {
    for (const [path, title] of routes) {
      await visit(c, path);
      const text = await panel(c.page).innerText();
      check(!noDemo.test(text), 'Preview/demo text on ' + path + ': ' + text.match(noDemo)?.[0]);
      const layout = await geometry(c.page);
      evidence.push({ route: path || 'home', title, layout });
      if (path === '') {
        const hero = await c.page.locator('.home-summary').boundingBox(),
          main = await c.page.locator('main.approved-content').boundingBox();
        if (width <= 650)
          check(
            Math.abs(hero.x - main.x) <= 1 && Math.abs(hero.width - main.width) <= 1,
            'Mobile home hero has side gutters'
          );
        if (width <= 650) {
          const bg = await c.page
            .locator('.topbar')
            .evaluate((el) => getComputedStyle(el).backgroundColor);
          const rgb = bg.match(/[\d.]+/g)?.map(Number) || [];
          check(rgb[2] > 120 && rgb[2] > rgb[0] + 40, 'Mobile home top is not blue: ' + bg);
        }
      }
      if (path === 'perfil') {
        for (const name of ['Preferências', 'Privacidade', 'Plano e acesso', 'Geral']) {
          await c.page.getByRole('tab', { name, exact: true }).click();
          await geometry(c.page);
        }
        const selected = c.page.getByRole('tab', { name: 'Geral', exact: true });
        await selected.focus();
        await c.page.keyboard.press('End');
        await expect(c.page.getByRole('tab', { name: 'Plano e acesso' })).toHaveAttribute(
          'aria-selected',
          'true'
        );
        await c.page.keyboard.press('Home');
        await expect(selected).toHaveAttribute('aria-selected', 'true');
      }
      if (path === 'planejamento') {
        for (const name of ['Orçamentos', 'Parcelas', 'Assinaturas', 'Metas']) {
          await c.page.getByRole('tab', { name, exact: true }).click();
          await geometry(c.page);
        }
      }
      if (path === 'transacoes') {
        await c.page.getByRole('button', { name: 'Despesas', exact: true }).click();
        const pointer = await c.page
          .getByRole('button', { name: 'Despesas', exact: true })
          .evaluate((el) => ({
            outline: getComputedStyle(el).outlineStyle,
            mode: document.documentElement.dataset.astraInput,
          }));
        check(pointer.outline === 'none', 'Pointer selection has a focus box');
        await c.page.keyboard.press('Tab');
        const focus = await c.page.evaluate(() => ({
          outline: getComputedStyle(document.activeElement).outlineStyle,
          width: getComputedStyle(document.activeElement).outlineWidth,
        }));
        check(
          focus.outline !== 'none' && parseFloat(focus.width) >= 2,
          'Keyboard focus is not visible'
        );
      }
      if (
        (width === 320 && theme === 'dark') ||
        (width === 390 && theme === 'light') ||
        (width === 1440 && theme === 'dark' && ['', 'investimentos', 'perfil'].includes(path))
      ) {
        await panel(c.page).getByRole('heading', { level: 1 }).click();
        await shot(c, `approved-${path || 'home'}-${width}-${theme}`);
      }
    }
    await clean(c);
    return {
      routes: evidence,
      bookWrites: c.api.bookWrites.length,
      externalRequestsIntercepted: c.api.blocked.length,
    };
  } catch (error) {
    await shot(c, `failure-approved-${width}-${theme}`);
    throw error;
  } finally {
    await c.context.close();
  }
}

async function setup(c, { held = false } = {}) {
  await visit(c, 'investimentos');
  await c.page.getByRole('button', { name: 'Começar', exact: true }).click();
  const dialog = c.page.getByRole('dialog');
  await dialog.getByLabel(new RegExp('^Nome\\ da\\ carteira')).fill('Carteira QA');
  await dialog.getByLabel(/^Conta de custódia/).fill('Custódia QA');
  await dialog.getByLabel(/^Caixa inicial/).fill('1000,00');
  await dialog.getByLabel(new RegExp('^Data\\ inicial')).fill(ago(30));
  const actions = await modalActions(c.page);
  if (held) c.api.holdBook();
  await dialog.getByRole('button', { name: 'Criar carteira', exact: true }).click();
  if (held) {
    await expect.poll(() => c.api.pendingBook()).toBe(true);
    check(c.api.getBook().state.portfolios.length === 0, 'Book changed before its save response');
    await c.page.keyboard.press('Escape');
    const remained = await dialog.isVisible();
    const closeDisabled = await dialog
      .getByRole('button', { name: 'Fechar', exact: true })
      .isDisabled();
    c.api.releaseBook();
    check(
      remained && closeDisabled,
      'Saving investment dialog can be closed before server confirmation'
    );
  }
  await expect(dialog).toHaveCount(0);
  check(
    c.api.getBook().state.portfolios.length === 1 && c.api.getBook().state.accounts.length === 1,
    'Setup did not save portfolio and custody together'
  );
  return actions;
}
async function operation(c, type, { price = '30,00', gross = '50,00', reason } = {}) {
  await c.page.getByRole('tab', { name: 'Minha carteira', exact: true }).click();
  await c.page.getByRole('button', { name: 'Adicionar investimento', exact: true }).click();
  const dialog = c.page.getByRole('dialog');
  await dialog.getByLabel(/^Tipo de movimentação/).selectOption(type);
  await dialog.getByLabel(new RegExp('^Data\\ da\\ movimentação')).fill(ago(29));
  await dialog.getByLabel(/^Ativo/).selectOption(c.api.getBook().state.assets[0].id);
  if (type === 'BUY') {
    await dialog.getByLabel(new RegExp('^Quantidade')).fill('10');
    await dialog.getByLabel(new RegExp('^Preço\\ unitário\\ \\(R\\$\\)')).fill(price);
    await dialog.getByLabel(new RegExp('^Taxas\\ da\\ operação\\ \\(R\\$\\)')).fill('0');
  } else {
    await dialog.getByLabel(new RegExp('^Provento\\ bruto\\ \\(R\\$\\)')).fill(gross);
    await dialog.getByLabel(new RegExp('^Retenção\\ \\(R\\$\\)')).fill('5,00');
  }
  if (reason) await dialog.getByLabel(/^Motivo da correção/).fill(reason);
  const before = c.api.bookWrites.length;
  await dialog.getByRole('button', { name: 'Revisar movimentação', exact: true }).click();
  check(c.api.bookWrites.length === before, 'Review unexpectedly saved a book');
  await dialog.getByRole('button', { name: 'Confirmar movimentação', exact: true }).click();
  await expect(dialog).toHaveCount(0);
}
async function investmentWorkflow() {
  const c = await opened({ width: 390, theme: 'light', mode: 'empty' });
  try {
    const setupActions = await setup(c, { held: true });
    await c.page.getByRole('button', { name: 'Mais opções de investimentos', exact: true }).click();
    await c.page.getByRole('button', { name: /Gerenciar carteiras e ativos/ }).click();
    let dialog = c.page.getByRole('dialog');
    await dialog.getByLabel(new RegExp('^Código\\ do\\ ativo')).fill('PETR4');
    await dialog.getByLabel(new RegExp('^Nome\\ do\\ ativo')).fill('Petrobras PN');
    await dialog.getByRole('button', { name: 'Cadastrar ativo', exact: true }).click();
    await expect.poll(() => c.api.getBook().state.assets.length).toBe(1);
    await dialog.getByRole('button', { name: 'Concluir', exact: true }).click();
    await operation(c, 'BUY');
    await operation(c, 'INCOME');
    let saved = c.api.getBook();
    const buy = saved.state.operations.find((op) => op.type === 'BUY'),
      income = saved.state.operations.find((op) => op.type === 'INCOME');
    check(buy?.quantity === '10' && buy?.unitPrice === '30', 'Exact buy data was not persisted');
    check(
      income?.gross === '50' && income?.withholding === '5',
      'Exact income data was not persisted'
    );
    await c.page.getByRole('tab', { name: 'Movimentações', exact: true }).click();
    await c.page
      .locator('.investment-activity-row')
      .filter({ hasText: 'Provento recebido' })
      .first()
      .click();
    dialog = c.page.getByRole('dialog');
    await dialog.getByRole('button', { name: 'Corrigir', exact: true }).click();
    await dialog.getByLabel(new RegExp('^Provento\\ bruto\\ \\(R\\$\\)')).fill('60,00');
    await dialog.getByLabel(/^Motivo da correção/).fill('Correção sintética conferida');
    await dialog.getByRole('button', { name: 'Revisar movimentação', exact: true }).click();
    await dialog.getByRole('button', { name: 'Confirmar correção', exact: true }).click();
    await expect(dialog).toHaveCount(0);
    await c.page
      .locator('.investment-activity-row')
      .filter({ hasText: 'Provento recebido' })
      .first()
      .click();
    dialog = c.page.getByRole('dialog');
    await dialog.getByRole('button', { name: 'Cancelar registro', exact: true }).click();
    await dialog
      .getByLabel(new RegExp('^Motivo\\ do\\ cancelamento'))
      .fill('Cancelamento sintético conferido');
    await dialog.getByRole('button', { name: 'Confirmar cancelamento', exact: true }).click();
    await expect(dialog).toHaveCount(0);
    saved = c.api.getBook();
    const finalIncome = saved.state.operations.find((op) => op.type === 'INCOME');
    check(
      finalIncome.status === 'cancelled' && finalIncome.history.length >= 2,
      'Correction/cancellation audit history was not preserved'
    );
    const before = JSON.stringify(saved.state);
    await c.page.reload();
    await c.page.locator('.investment-page').waitFor();
    check(JSON.stringify(c.api.getBook().state) === before, 'Reload lost the saved book');
    await clean(c);
    await shot(c, 'approved-investment-workflow-390-light');
    return {
      setupActions,
      storageVersion: saved.storageVersion,
      operationTypes: saved.state.operations.map((op) => ({
        type: op.type,
        status: op.status,
        revision: op.revision,
      })),
      bookWrites: c.api.bookWrites.length,
    };
  } catch (error) {
    c.api.releaseBook();
    await shot(c, 'failure-investment-workflow');
    throw error;
  } finally {
    await c.context.close();
  }
}
async function investmentConflict() {
  const c = await opened({ width: 390, theme: 'dark', mode: 'dense' });
  try {
    c.api.failBook(409);
    await visit(c, 'investimentos');
    await expect.poll(() => c.api.bookWrites.length).toBeGreaterThan(0);
    await expect(panel(c.page)).toContainText(/outro aparelho|Conflito|carteira mudou/i);
    await c.page.waitForTimeout(1100);
    const count = c.api.bookWrites.length;
    await c.page.waitForTimeout(1100);
    check(c.api.bookWrites.length === count, 'Automatic quotes retried a failed CAS indefinitely');
    await clean(c);
    return { failedWrites: count, storageVersion: c.api.getBook().storageVersion };
  } finally {
    await c.context.close();
  }
}
async function referralWorkflow() {
  const c = await opened({ width: 390, theme: 'light' });
  try {
    await visit(c, 'indicacoes');
    await c.page
      .getByRole('button', { name: /Convidar amigos|Compartilhar convite|Compartilhar link/ })
      .first()
      .click();
    const shared = await c.page.evaluate(() => window.__qaShares);
    check(
      shared.length === 1 &&
        shared[0].url ===
          'https://app.astraacessor.pro/api/v1/customer/referrals/invite/AST-0123456789ABCDEF',
      'Share did not use the actual returned invite link'
    );
    await c.page.getByRole('button', { name: /Convite 12AB34CD/ }).click();
    let dialog = c.page.getByRole('dialog');
    await dialog.getByRole('button', { name: 'Solicitar Pix', exact: true }).click();
    dialog = c.page.getByRole('dialog');
    await dialog.getByLabel(/chave Pix/i).fill('qa@astra.example');
    c.api.failPayout();
    await dialog.getByRole('button', { name: 'Solicitar Pix', exact: true }).click();
    await expect(dialog).toContainText('Não foi possível registrar o pedido agora.');
    await expect(dialog.getByLabel(/chave Pix/i)).toHaveValue('qa@astra.example');
    await dialog.getByRole('button', { name: 'Solicitar Pix', exact: true }).click();
    await expect(dialog).toHaveCount(0);
    await expect(panel(c.page)).toContainText('Pix solicitado');
    check(c.api.payouts.length === 2, 'Expected one failed and one confirmed payout request');
    await clean(c);
    await shot(c, 'approved-referral-workflow-390-light');
    return { shares: shared.length, payoutAttempts: c.api.payouts.length };
  } catch (error) {
    await shot(c, 'failure-referral-workflow');
    throw error;
  } finally {
    await c.context.close();
  }
}

async function charts(mode, historyShape) {
  const manual = mode === 'sparse' || mode === 'single' || mode === 'manual-empty';
  const book = manual ? portfolioSeed(mode === 'manual-empty' ? 'single' : mode) : undefined;
  if (book) {
    book.assets[0].symbol = 'QA3';
    book.assets[0].name = 'Ativo manual QA';
    if (mode === 'manual-empty') book.quotes = [];
  }
  const c = await opened({
    width: 390,
    theme: mode === 'negative' ? 'dark' : 'light',
    mode: manual ? 'sparse' : mode,
    book,
    historyShape,
  });
  try {
    await visit(c, 'investimentos');
    if (mode === 'empty') {
      await expect(c.page.getByRole('button', { name: 'Começar', exact: true })).toBeVisible();
      check(
        (await c.page.locator('[data-portfolio-chart-mode]').count()) === 0,
        'Empty wallet fabricated a wealth chart'
      );
      await clean(c);
      await shot(c, 'approved-investments-empty-390-light');
      return { state: 'empty-onboarding' };
    }
    const wealth = c.page.locator('[data-portfolio-chart-mode]');
    if (manual) {
      await expect(wealth).toHaveAttribute(
        'data-portfolio-chart-mode',
        mode === 'manual-empty' ? 'empty' : 'comparison'
      );
      if (mode !== 'manual-empty') {
        const cards = c.page.locator('[data-record-index]');
        await expect(cards).toHaveCount(mode === 'single' ? 1 : 2);
        await cards.first().click();
        await expect(cards.first()).toHaveAttribute('aria-pressed', 'true');
        if (mode === 'sparse') {
          await c.page.keyboard.press('ArrowRight');
          await expect(cards.last()).toHaveAttribute('aria-pressed', 'true');
        }
        check(
          (await wealth.locator('polyline').count()) === 0,
          'Sparse observations were joined into a fictitious time series'
        );
      }
    } else if (historyShape === 'empty' || historyShape === 'single') {
      await expect(wealth).toHaveAttribute('data-portfolio-chart-mode', 'comparison');
      check(
        Number(await wealth.getAttribute('data-portfolio-valid-points')) <= 2,
        'Incomplete daily data invented portfolio observations'
      );
    } else {
      await expect(wealth).toHaveAttribute('data-portfolio-chart-mode', 'series');
      const count = Number(await wealth.getAttribute('data-portfolio-valid-points'));
      check(count >= 15, 'Too few real daily portfolio points');
      const canvas = wealth.locator('svg.invest-wealth-canvas');
      await canvas.scrollIntoViewIfNeeded();
      await canvas.focus();
      const readout = wealth.locator('.invest-wealth-readout');
      const before = await readout.innerText();
      await c.page.keyboard.press('ArrowLeft');
      check((await readout.innerText()) !== before, 'Wealth keyboard readout did not move');
      const box = await canvas.boundingBox();
      await c.page.mouse.move(box.x + box.width * 0.2, box.y + box.height * 0.4);
      check(
        (await readout.innerText()).includes('R$'),
        'Portfolio pointer readout omitted exact monetary value'
      );
      const gain = c.page.locator('.invest-balance > .invest-gain');
      await expect(gain).toHaveClass(mode === 'negative' ? /down/ : /up/);
    }
    const portfolioMode = await wealth.getAttribute('data-portfolio-chart-mode');
    await panel(c.page).getByRole('heading', { level: 1 }).click();
    await shot(
      c,
      `approved-investments-portfolio-${mode}-${historyShape || 'normal'}-390-${c.theme}`
    );
    await c.page
      .getByRole('button', { name: 'Abrir ativo ' + (manual ? 'QA3' : 'PETR4'), exact: true })
      .first()
      .click();
    const detail = c.page.locator('.invest-asset-detail');
    await expect(detail).toBeVisible();
    const expected =
      mode === 'manual-empty' || historyShape === 'empty'
        ? 'no-data'
        : mode === 'single' || historyShape === 'single'
          ? 'single-point'
          : 'ready';
    const chart = detail.locator('[data-chart-state]');
    await expect(chart).toHaveAttribute('data-chart-state', expected);
    if (expected !== 'no-data') {
      const canvas = chart.locator('svg[role="img"]');
      await canvas.scrollIntoViewIfNeeded();
      await canvas.focus();
      await c.page.keyboard.press('ArrowLeft');
      await expect(chart.locator('.invest-chart-readout')).toContainText('R$');
      if (expected === 'single-point')
        check(
          (await chart.locator('polyline').count()) === 0,
          'Single observation fabricated a price line'
        );
      if (historyShape === 'gaps')
        check(
          (await chart.locator('polyline').count()) >= 2,
          'Missing prices were joined across a gap'
        );
      if (expected === 'ready') {
        const before = await chart.locator('.invest-chart-readout').innerText();
        await c.page.keyboard.press('ArrowRight');
        check(
          (await chart.locator('.invest-chart-readout').innerText()) !== before,
          'Individual chart keyboard selection did not move'
        );
      }
    } else
      check(
        (await chart.locator('polyline').count()) === 0,
        'No data chart contains a fabricated price line'
      );
    await geometry(c.page);
    await clean(c);
    await panel(c.page).getByRole('heading', { level: 1 }).click();
    await shot(c, `approved-investments-chart-${mode}-${historyShape || 'normal'}-390-${c.theme}`);
    return { portfolioMode, individualState: expected, historyShape: historyShape || 'normal' };
  } catch (error) {
    await shot(c, `failure-chart-${mode}-${historyShape || 'normal'}`);
    throw error;
  } finally {
    await c.context.close();
  }
}

async function financeDialogs(theme) {
  const c = await opened({ width: 320, theme });
  const evidence = [];
  try {
    for (const [route, action] of [
      ['transacoes', 'Nova transação'],
      ['agenda', 'Novo compromisso'],
      ['planejamento', 'Nova meta'],
      ['categorias', 'Nova categoria'],
    ]) {
      await visit(c, route);
      await c.page.getByRole('button', { name: action, exact: true }).first().click();
      let dialog = c.page.getByRole('dialog');
      await expect(dialog).toBeVisible();
      if (route === 'transacoes') {
        for (const type of ['Despesa', 'Entrada']) {
          await dialog.getByRole('button', { name: type, exact: true }).click();
          const category = dialog.getByLabel(/^Categoria/);
          await expect(category.locator('option').filter({ hasText: /^Outros$/ })).toHaveCount(1);
          await category.selectOption({ label: 'Criar categoria…' });
          await dialog.getByLabel(/^Nome da nova categoria/).fill('Categoria QA cancelada');
        }
      }
      const actions = await modalActions(c.page);
      await geometry(c.page);
      const overflow = await dialog.evaluate((el) => el.scrollWidth - el.clientWidth);
      check(overflow <= 1, route + ' dialog scrolls horizontally');
      evidence.push({ route, actions });
      await shot(c, `approved-${route}-modal-320-${theme}`);
      await dialog.getByRole('button', { name: 'Cancelar', exact: true }).click();
      await expect(dialog).toHaveCount(0);
    }
    check(c.api.mutations.length === 0, 'Cancelling a finance dialog wrote customer data');
    await clean(c);
    return { dialogs: evidence, cancelledWrites: c.api.mutations.length };
  } catch (error) {
    await shot(c, 'failure-finance-dialog-' + theme);
    throw error;
  } finally {
    await c.context.close();
  }
}

async function headerRaces() {
  const completed = [];
  for (const order of [
    ['hideAmounts', 'theme'],
    ['theme', 'hideAmounts'],
  ]) {
    const c = await opened({ width: 390, theme: 'light' }),
      pending = new Map();
    try {
      const session = c.page.waitForResponse(
        (response) =>
          new URL(response.url()).pathname.endsWith('/auth/session') && response.status() === 200
      );
      await visit(c, '');
      const original = (await (await session).json()).data.customer;
      await c.page.route('**/api/v1/customer/profile', async (route) => {
        if (route.request().method() !== 'PATCH') return route.fallback();
        const body = route.request().postDataJSON(),
          field = Object.hasOwn(body, 'theme') ? 'theme' : 'hideAmounts';
        await new Promise((resolve) =>
          pending.set(field, { resolve, profile: { ...original, ...body } })
        );
        return route.fulfill({
          json: { success: true, data: { profile: pending.get(field).profile } },
        });
      });
      await c.page.getByRole('button', { name: 'Ativar tema escuro', exact: true }).click();
      await expect.poll(() => pending.has('theme')).toBe(true);
      await c.page.getByRole('button', { name: 'Ocultar valores', exact: true }).click();
      await expect.poll(() => pending.has('hideAmounts')).toBe(true);
      pending.get(order[0]).resolve();
      if (order[0] === 'hideAmounts')
        await expect(
          c.page.getByRole('button', { name: 'Mostrar valores', exact: true })
        ).toBeVisible();
      else
        await expect(c.page.locator('#astra-approved-dashboard')).toHaveAttribute(
          'data-theme',
          'dark'
        );
      pending.get(order[1]).resolve();
      await expect(
        c.page.getByRole('button', { name: 'Mostrar valores', exact: true })
      ).toBeVisible();
      await expect(c.page.locator('#astra-approved-dashboard')).toHaveAttribute(
        'data-theme',
        'dark'
      );
      await expect(c.page.locator('.home-summary-balance > strong')).not.toContainText(/[0-9]/);
      await clean(c);
      completed.push(order.join(' -> '));
    } finally {
      for (const value of pending.values()) value.resolve();
      await c.context.close();
    }
  }
  const c = await opened({ width: 390, theme: 'light' }),
    requests = [];
  try {
    c.page.on('request', (request) => {
      if (new URL(request.url()).pathname.endsWith('/finance/summary'))
        requests.push(request.url());
    });
    await visit(c, '');
    const period = c.page.locator('.home-summary-period'),
      original = await period.innerText();
    await period.click();
    let dialog = c.page.getByRole('dialog');
    await dialog.getByRole('button', { name: 'Mês anterior', exact: true }).click();
    await expect(period).toHaveText(original);
    await dialog.getByRole('button', { name: 'Fechar', exact: true }).click();
    await expect(dialog).toHaveCount(0);
    await expect(period).toHaveText(original);
    await period.click();
    dialog = c.page.getByRole('dialog');
    await dialog.getByRole('button', { name: 'Mês anterior', exact: true }).click();
    await dialog.getByRole('button', { name: 'Concluir', exact: true }).click();
    await expect(dialog).toHaveCount(0);
    await expect(period).not.toHaveText(original);
    const previousEnd = new Date(new URL(requests[0]).searchParams.get('from') + 'T12:00:00Z');
    previousEnd.setUTCDate(0);
    const expectedTo = previousEnd.toISOString().slice(0, 10),
      expectedFrom = expectedTo.slice(0, 8) + '01';
    await expect
      .poll(() =>
        requests.some(
          (value) =>
            new URL(value).searchParams.get('from') === expectedFrom &&
            new URL(value).searchParams.get('to') === expectedTo
        )
      )
      .toBe(true);
    await clean(c);
    await shot(c, 'approved-home-private-period-final-390-light');
    return { responseOrders: completed, periodCancelPreserved: true, periodApplyConfirmed: true };
  } finally {
    await c.context.close();
  }
}

try {
  if (phase === 'all' || phase === 'matrix') {
    const cases = [];
    for (const width of [320, 390, 768, 1440])
      for (const theme of ['light', 'dark'])
        if (
          (!filterWidth || Number(filterWidth) === width) &&
          (!filterTheme || filterTheme === theme)
        )
          cases.push([width, theme]);
    for (let i = 0; i < cases.length; i += 2)
      await Promise.all(
        cases
          .slice(i, i + 2)
          .map(([width, theme]) => run(`ten routes ${width} ${theme}`, () => matrix(width, theme)))
      );
  }
  if (phase === 'all' || phase === 'charts') {
    for (const [mode, historyShape] of [
      ['dense'],
      ['negative'],
      ['sparse'],
      ['single'],
      ['manual-empty'],
      ['dense', 'empty'],
      ['dense', 'single'],
      ['dense', 'gaps'],
      ['empty'],
    ])
      await run(`investment chart ${mode} ${historyShape || 'normal'}`, () =>
        charts(mode, historyShape)
      );
  }
  if (phase === 'all' || phase === 'dialogs') {
    for (const theme of ['light', 'dark'])
      await run(`finance mobile dialogs ${theme}`, () => financeDialogs(theme));
  }
  if (phase === 'all' || phase === 'header') {
    await run('header parallel theme/privacy responses and Home period cancel/apply', headerRaces);
  }
  if (phase === 'all' || phase === 'functional') {
    await run(
      'investment setup, custody, asset, buy, income, correction, cancellation and reload',
      investmentWorkflow
    );
    await run(
      'investment CAS409 stays honest and stops automatic write retries',
      investmentConflict
    );
    await run('referral share and actual awaited Pix request failure/retry', referralWorkflow);
  }
} finally {
  await browser.close();
  report.finishedAt = new Date().toISOString();
  report.pass = report.tests.length > 0 && report.tests.every((test) => test.pass);
  await writeFile(output + `/approved-${phase}-report.json`, JSON.stringify(report, null, 2));
  await writeFile(output + '/approved-report.json', JSON.stringify(report, null, 2));
  console.log(
    JSON.stringify(
      {
        pass: report.pass,
        tests: report.tests.map(({ name, pass, error }) => ({ name, pass, error })),
        screenshots: report.screenshots,
      },
      null,
      2
    )
  );
  if (!report.pass) process.exitCode = 1;
}
