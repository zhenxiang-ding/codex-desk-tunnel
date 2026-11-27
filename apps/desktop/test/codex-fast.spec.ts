import { expect, test } from '@playwright/test';
import type { CodexChoice } from '@cc-desk-tunnel/protocol';

test('composer shows the inherited Fast tier and saves the selected speed independently of effort', async ({
  page,
}) => {
  await page.goto('/');
  await page.evaluate(async () => {
    // Use the same Vite dependency instances that rendered the app.
    const dependency = (name: string) =>
      performance
        .getEntriesByType('resource')
        .find((entry) => new URL(entry.name).pathname.endsWith('/' + name + '.js'))!.name;
    const reactPath = dependency('react');
    const domPath = dependency('react-dom_client');
    const toolbarPath = '/src/CodexToolbar.tsx';
    const React = (await import(reactPath)).default;
    const { createRoot } = (await import(domPath)).default;
    const { CodexToolbar } = await import(toolbarPath);
    const container = document.body.appendChild(document.createElement('div'));
    container.id = 'test-toolbar';
    container.style.cssText = 'position:fixed; bottom:24px; right:24px; z-index:9999';
    const model = {
      model: 'test',
      displayName: 'Test',
      isDefault: true,
      defaultReasoningEffort: 'high',
      serviceTiers: [{ id: 'priority', name: 'Fast' }],
      defaultServiceTier: 'priority',
      supportedReasoningEfforts: [{ reasoningEffort: 'high', description: '' }],
    };
    const client = {
      state: {},
      fetch: async () => ({
        models: [
          model,
          {
            ...model,
            model: 'other',
            displayName: 'Other',
            serviceTiers: [],
            defaultServiceTier: null,
          },
        ],
        defaults: {},
        supportsSessionServiceTier: true,
      }),
    };
    function Harness() {
      const [choice, setChoice] = React.useState({});
      return React.createElement(CodexToolbar, {
        client,
        session: { id: 'test', codex: choice },
        disabled: false,
        quota: null,
        commandMenu: null,
        setServiceTiers: () => {},
        openAccount: () => {},
        configure: async (patch: CodexChoice) => {
          container.dataset.patch = JSON.stringify(patch);
          setChoice({ ...choice, ...patch });
        },
      });
    }
    createRoot(container).render(React.createElement(Harness));
  });
  const toolbar = page.locator('#test-toolbar');
  const trigger = toolbar.getByRole('button', { name: '模型与推理强度' });
  const fast = toolbar.getByRole('button', { name: 'Fast 模式' });
  const indicator = trigger.locator('.fast-indicator');
  await expect(indicator).toBeVisible();
  await trigger.click();
  await expect(fast).toHaveAttribute('aria-pressed', 'true');
  await fast.click();
  await expect(toolbar).toHaveAttribute('data-patch', JSON.stringify({ serviceTier: 'default' }));
  await expect(indicator).toHaveCount(0);
  await trigger.click();
  await expect(fast).toHaveAttribute('aria-pressed', 'false');
  await fast.click();
  await expect(toolbar).toHaveAttribute('data-patch', JSON.stringify({ serviceTier: 'priority' }));
  await expect(indicator).toBeVisible();
  await trigger.click();
  await toolbar.getByRole('button', { name: 'Test', exact: true }).click();
  await toolbar.getByRole('option', { name: 'Other' }).click();
  await expect(indicator).toHaveCount(0);
  await trigger.click();
  await expect(fast).toBeDisabled();
  await expect(fast).toHaveAttribute('aria-pressed', 'false');
});
