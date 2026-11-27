import { expect, test } from '@playwright/test';

test('the composer ring replaces the old percentage after a compaction', async ({ page }) => {
  await page.goto('/');
  const render = await page.evaluateHandle(async () => {
    const dependency = (name: string) =>
      performance
        .getEntriesByType('resource')
        .find((e) => new URL(e.name).pathname.endsWith('/' + name + '.js'))!.name;
    const React = (await import(dependency('react'))).default;
    const { createRoot } = (await import(dependency('react-dom_client'))).default;
    const meterPath = '/src/ContextMeter.tsx',
      toolbarPath = '/src/CodexToolbar.tsx';
    const { default: Meter } = await import(meterPath);
    const { codexContext } = await import(toolbarPath);
    const container = document.body.appendChild(document.createElement('div'));
    container.style.cssText = 'position:fixed; bottom:24px; right:24px; z-index:9999';
    const root = createRoot(container);
    return (used: number | null) => {
      const payload =
        used === null
          ? { type: 'native.compact' }
          : {
              type: 'codex.usage',
              total: { totalTokens: 4303442 },
              last: { totalTokens: used },
              window: 258400,
            };
      root.render(
        React.createElement(Meter, {
          metrics: codexContext({ payload, createdAt: new Date().toISOString() }),
        }),
      );
    };
  });
  const ring = page.getByRole('button', { name: '上下文窗口', exact: true });
  await render.evaluate((fn) => fn(108203));
  await expect(ring).toHaveAttribute('title', '上下文 42%');
  await render.evaluate((fn) => fn(null));
  await ring.hover();
  await expect(page.getByText('已压缩，等待 Codex 上报当前上下文占用。')).toBeVisible();
  await render.evaluate((fn) => fn(22836));
  await expect(ring).toHaveAttribute('title', '上下文 9%');
  await expect(page.getByText(/22,836 \/ 258,400/)).toBeVisible();
});
