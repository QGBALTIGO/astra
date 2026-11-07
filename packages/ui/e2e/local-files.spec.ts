import { test, expect } from '@playwright/test';

test.describe('Personalizar — ambientes e dispositivos reais', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/');
    await page.locator('[data-testid="sidebar-customize-link"] button').click();
    await page.locator('[data-testid="customize-tab-local-files"]').click();
    await expect(page.locator('[data-testid="local-files-tree"]')).toBeVisible();
  });

  test('lista fontes da conta sem simular outros computadores', async ({ page }) => {
    await expect(page.locator('[data-testid="local-files-edge-header"]')).toBeVisible();
    await expect(page.locator('[data-testid="local-files-workspaces-header"]')).toBeVisible();
    await expect(page.locator('[data-testid^="local-files-device-"]')).toHaveCount(0);
    await expect(page.locator('[data-testid="local-files-tree"]')).not.toContainText(
      'user@linux-host'
    );
    await expect(page.locator('[data-testid="local-files-tree"]')).not.toContainText(
      'user@windows-host'
    );
  });

  test('mostra dados reais ou estado vazio dos dispositivos', async ({ page }) => {
    await expect(page.getByText('Carregando dispositivos...')).toHaveCount(0);
    const devices = page.locator('[data-testid^="local-files-iot-"]');
    if ((await devices.count()) === 0) {
      await expect(page.locator('[data-testid="local-files-empty-devices"]')).toBeVisible();
    } else {
      await expect(devices.first()).toBeVisible();
    }
  });

  test('o cabeçalho de IoT abre informações da lista', async ({ page }) => {
    await expect(page.getByText('Carregando dispositivos...')).toHaveCount(0);
    await page.locator('[data-testid="local-files-edge-header"]').click();
    await expect(page.locator('[data-testid="customize-detail-edge"]')).toBeVisible();
    await expect(page.locator('[data-testid="customize-detail-edge"]')).toContainText(
      'dispositivo(s) cadastrado(s)'
    );
  });

  test('abrir dispositivos navega para página verdadeira', async ({ page }) => {
    await page.locator('[data-testid="local-files-edge-header"]').click();
    await page.locator('[data-testid="customize-detail-open-edge"]').click();
    await expect(page).toHaveURL(/\/edge-devices$/);
    await expect(page.locator('#main-content')).toBeVisible();
  });

  test('botão de gerenciamento do cabeçalho tem ação funcional', async ({ page }) => {
    await page.locator('[data-testid="local-files-add-device"]').click();
    await expect(page).toHaveURL(/\/edge-devices$/);
  });

  test('mostra ambientes reais ou estado vazio, nunca máquinas fictícias', async ({ page }) => {
    await expect(page.getByText('Carregando ambientes...')).toHaveCount(0);
    const workspaces = page.locator('[data-testid^="local-files-workspace-"]');
    if ((await workspaces.count()) === 0) {
      await expect(page.locator('[data-testid="local-files-empty-workspaces"]')).toBeVisible();
    } else {
      await expect(workspaces.first()).toBeVisible();
    }
  });

  test('permite abrir a gestão de ambientes', async ({ page }) => {
    await page.locator('[data-testid="local-files-workspaces-header"]').click();
    const detail = page.locator('[data-testid="customize-detail-edge"]');
    await expect(detail).toBeVisible();
    await expect(detail).toContainText('Ambientes de trabalho');
    await page.locator('[data-testid="customize-detail-open-edge"]').click();
    await expect(page).toHaveURL(/\/workspaces$/);
  });

  test('registra, exibe e remove dispositivo no PostgreSQL de teste', async ({ page }) => {
    const name = `Teste IoT automatizado ${Date.now()}`;
    let deviceId = '';
    try {
      const created = await page.evaluate(async (deviceName) => {
        const response = await fetch('/api/v1/edge', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ name: deviceName, type: 'custom' }),
        });
        return { ok: response.ok, status: response.status, body: await response.json() };
      }, name);
      expect(created.ok, `cadastro IoT via navegador: HTTP ${created.status}`).toBe(true);
      const body = created.body as {
        success?: boolean;
        data?: { id?: string };
      };
      expect(body.success).toBe(true);
      deviceId = body.data?.id ?? '';
      expect(deviceId).toBeTruthy();

      await page.getByRole('button', { name: 'Atualizar listas' }).click();
      await expect(page.locator(`[data-testid="local-files-iot-${deviceId}"]`)).toBeVisible();
      await page.locator(`[data-testid="local-files-iot-${deviceId}"]`).click();
      const detail = page.locator('[data-testid="customize-detail-iot"]');
      await expect(detail).toContainText(name);
      await expect(detail).toContainText('Desconectado');
    } finally {
      if (deviceId) {
        const removed = await page.evaluate(async (id) => {
          const response = await fetch(`/api/v1/edge/${encodeURIComponent(id)}`, {
            method: 'DELETE',
          });
          return { ok: response.ok, status: response.status };
        }, deviceId);
        expect(removed.ok, `exclusão via navegador: HTTP ${removed.status}`).toBe(true);
      }
    }
  });
});
