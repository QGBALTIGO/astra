import { test, expect } from '@playwright/test';

/** Regressões das capturas móveis: conteúdo em inglês, seletor nativo gigante e sobreposição. */
for (const width of [320, 375, 390, 430, 768, 1024]) {
  test(`capacidades: filtro e cartões acessíveis em ${width}px`, async ({ page }) => {
    await page.setViewportSize({ width, height: 812 });
    await page.goto('/agentic');

    await expect(
      page.getByRole('heading', { name: 'Central de tarefas automatizadas' })
    ).toBeVisible();
    await page.getByRole('button', { name: 'Capacidades' }).click();

    const filter = page.getByRole('button', { name: 'Filtrar por tipo de executor' });
    await expect(filter).toBeVisible();
    await expect(filter).toHaveAttribute('aria-expanded', 'false');

    const bounds = await filter.boundingBox();
    expect(bounds).not.toBeNull();
    expect(bounds!.x).toBeGreaterThanOrEqual(-1);
    expect(bounds!.x + bounds!.width).toBeLessThanOrEqual(width + 1);
    expect(bounds!.width).toBeGreaterThan(180);

    await filter.click();
    const options = page.getByRole('listbox', { name: 'Tipos de executor' });
    await expect(options).toBeVisible();
    await expect(options.getByRole('option', { name: 'Agente autônomo' })).toBeVisible();

    const menuBounds = await options.boundingBox();
    expect(menuBounds).not.toBeNull();
    expect(menuBounds!.x).toBeGreaterThanOrEqual(-1);
    expect(menuBounds!.x + menuBounds!.width).toBeLessThanOrEqual(width + 1);

    await options.getByRole('option', { name: 'Agente autônomo' }).click();
    await expect(filter).toContainText('Agente autônomo');
    await expect(options).toHaveCount(0);
    await filter.click();
    await expect(options).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(options).toHaveCount(0);
    const overflow = await page.evaluate(
      () => document.documentElement.scrollWidth - window.innerWidth
    );
    expect(overflow).toBeLessThanOrEqual(2);
  });
}
