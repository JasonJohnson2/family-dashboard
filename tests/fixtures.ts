import { test as base } from '@playwright/test';
export { expect, type APIRequestContext, type Page } from '@playwright/test';
// API setup signs in the same browser context that exercises the UI.
export const test = base.extend({
  request: async ({ context }, use) => {
    await use(context.request);
  },
});
