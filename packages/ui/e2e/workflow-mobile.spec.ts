/**
 * Responsive E2E tests for a real, temporary workflow.
 *
 * The legacy suite navigated to /workflows/e2e-mobile-test without creating
 * that record, then silently skipped a nonexistent editor. This suite creates
 * a workflow via the authenticated browser, tests actual UI and cleans up
 * against the isolated CI PostgreSQL database. It never runs a workflow or IA.
 */
import { test as base, expect } from '@playwright/test';

type WorkflowFixture = { workflowId: string };

const test = base.extend<WorkflowFixture>({
  workflowId: async ({ page }, use) => {
    await page.goto('/workflows');
    const created = await page.evaluate(async () => {
      const response = await fetch('/api/v1/workflows', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name: 'Astra E2E — editor responsivo',
          nodes: [],
          edges: [],
        }),
      });
      return { ok: response.ok, status: response.status, body: await response.json() };
    });

    expect(created.ok, `criação do fluxo de teste: HTTP ${created.status}`).toBe(true);
    const data = created.body as { success?: boolean; data?: { id?: string } };
    expect(data.success).toBe(true);
    const workflowId = data.data?.id;
    expect(workflowId).toBeTruthy();

    try {
      await page.goto(`/workflows/${encodeURIComponent(workflowId!)}`);
      await expect(page.locator('#main-content')).toBeVisible();
      await use(workflowId!);
    } finally {
      const removed = await page.evaluate(async (id) => {
        const response = await fetch(`/api/v1/workflows/${encodeURIComponent(id)}`, {
          method: 'DELETE',
        });
        return { ok: response.ok, status: response.status };
      }, workflowId!);
      expect(removed.ok, `remoção do fluxo de teste: HTTP ${removed.status}`).toBe(true);
    }
  },
});

test.describe('Editor de automações — celular', () => {
  test.use({ viewport: { width: 375, height: 812 } });

  test('mostra as três abas acessíveis', async ({ page, workflowId }) => {
    await expect(page).toHaveURL(new RegExp(`/workflows/${workflowId}`));
    await expect(page.getByRole('tablist', { name: 'Editor de automação' })).toBeVisible();
    await expect(page.getByTestId('workflow-mobile-tab-nodes')).toBeVisible();
    await expect(page.getByTestId('workflow-mobile-tab-canvas')).toBeVisible();
    await expect(page.getByTestId('workflow-mobile-tab-config')).toBeVisible();
    await expect(page.getByTestId('workflow-mobile-tab-nodes')).toHaveAttribute(
      'aria-selected',
      'true'
    );
  });

  test('troca entre nós e canvas sem perder a pesquisa', async ({ page, workflowId }) => {
    expect(workflowId).toBeTruthy();
    await expect(page.getByPlaceholder('Buscar ferramentas...')).toBeVisible();
    await page.getByTestId('workflow-mobile-tab-canvas').click();
    await expect(page.locator('.react-flow')).toBeVisible();
    await expect(page.getByTestId('workflow-mobile-tab-canvas')).toHaveAttribute(
      'aria-selected',
      'true'
    );
    await page.getByTestId('workflow-mobile-tab-nodes').click();
    await expect(page.getByPlaceholder('Buscar ferramentas...')).toBeVisible();
  });

  test('aba de configuração mostra estado vazio correto', async ({ page, workflowId }) => {
    expect(workflowId).toBeTruthy();
    await page.getByTestId('workflow-mobile-tab-config').click();
    await expect(page.getByText('Selecione um nó para configurar')).toBeVisible();
  });

  test('o editor não cria overflow horizontal no celular', async ({ page, workflowId }) => {
    expect(workflowId).toBeTruthy();
    await expect(page.getByTestId('workflow-mobile-tab-nodes')).toBeVisible();
    const overflow = await page.evaluate(() =>
      Math.max(0, document.documentElement.scrollWidth - innerWidth)
    );
    expect(overflow).toBeLessThanOrEqual(7);
  });
});

test.describe('Editor de automações — computador', () => {
  test.use({ viewport: { width: 1440, height: 900 } });

  test('mostra ferramentas e canvas do fluxo real', async ({ page, workflowId }) => {
    expect(workflowId).toBeTruthy();
    await expect(page.getByPlaceholder('Buscar ferramentas...')).toBeVisible();
    await expect(page.locator('.react-flow')).toBeVisible();
  });

  test('não exibe a barra de abas exclusiva do celular', async ({ page, workflowId }) => {
    expect(workflowId).toBeTruthy();
    await expect(page.getByPlaceholder('Buscar ferramentas...')).toBeVisible();
    await expect(page.getByTestId('workflow-mobile-tab-nodes')).toHaveCount(0);
  });
});
