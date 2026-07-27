// Custom matchers the generated specs rely on. `toBeOneOf` is NOT a
// Playwright/expect built-in — importing this module (side-effect) registers
// it. Generated API specs `import '../../helpers/matchers.mjs'` at the top.
import { expect } from '@playwright/test';

expect.extend({
  toBeOneOf(received, expectedList) {
    const pass = Array.isArray(expectedList) && expectedList.includes(received);
    return {
      pass,
      message: () =>
        `expected ${received} ${pass ? 'not ' : ''}to be one of [${(expectedList || []).join(', ')}]`,
    };
  },
});
