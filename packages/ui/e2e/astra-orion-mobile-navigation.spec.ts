import { test, expect } from '@playwright/test';

/**
 * Visual regression for the header that previously clipped its action
 * buttons by 70px on small phones, even when the root document stayed narrow.
 */
for (const width of [320, 375, 390, 430, 768, 1024]) {
  test(`Astra automações: cabeçalho e ações visíveis em ${width}px`, async ({ page }) => {
    await page.setViewportSize({ width, height: 812 });
    await page.goto('/workflows');
    const heading = page.getByRole('heading', { name: 'Automações', exact: true });
    await expect(heading).toBeVisible();
    const importButton = page.getByRole('button', { name: 'Importar', exact: true });
    const createButton = page.getByRole('button', { name: 'Nova automação', exact: true });
    await expect(importButton).toBeVisible();
    await expect(createButton).toBeVisible();

    for (const item of [importButton, createButton]) {
      const box = await item.boundingBox();
      expect(box).not.toBeNull();
      expect(box!.x).toBeGreaterThanOrEqual(-1);
      expect(box!.x + box!.width).toBeLessThanOrEqual(width + 1);
      expect(box!.height).toBeGreaterThanOrEqual(36);
    }

    const documentOverflow = await page.evaluate(
      () => document.documentElement.scrollWidth - window.innerWidth
    );
    expect(documentOverflow).toBeLessThanOrEqual(2);
  });
}

for (const width of [320, 375, 390]) {
  test(`Astra habilidades: todas as abas continuam tocáveis em ${width}px`, async ({ page }) => {
    await page.setViewportSize({ width, height: 812 });
    await page.goto('/skills');
    for (const label of ['Início', 'Instaladas', 'Explorar', 'Criar']) {
      const tab = page.getByRole('button', { name: label, exact: true }).first();
      await expect(tab).toBeVisible();
      const box = await tab.boundingBox();
      expect(box).not.toBeNull();
      expect(box!.x).toBeGreaterThanOrEqual(-1);
      expect(box!.x + box!.width).toBeLessThanOrEqual(width + 1);
      expect(box!.height).toBeGreaterThanOrEqual(36);
    }
  });
}
