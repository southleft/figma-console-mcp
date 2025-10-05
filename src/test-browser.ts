/**
 * Test script to verify Browser Rendering API access
 * Run with: npx wrangler dev and visit /test-browser
 */

import puppeteer from '@cloudflare/puppeteer';
import type { Env } from './browser-manager.js';

export async function testBrowserRendering(env: Env): Promise<any> {
  const results = {
    timestamp: new Date().toISOString(),
    tests: [] as any[],
  };

  // Test 1: Check BROWSER binding exists
  results.tests.push({
    name: 'BROWSER binding exists',
    passed: !!env.BROWSER,
    details: env.BROWSER ? 'BROWSER binding found' : 'BROWSER binding missing',
  });

  if (!env.BROWSER) {
    return {
      ...results,
      overall: 'FAILED',
      message: 'BROWSER binding not found. Check wrangler.jsonc configuration.',
    };
  }

  // Test 2: Try to launch browser
  try {
    const browser = await puppeteer.launch(env.BROWSER, { keep_alive: 60000 });
    results.tests.push({
      name: 'Browser launch',
      passed: true,
      details: 'Successfully launched browser instance',
    });

    // Test 3: Try to create page
    try {
      const page = await browser.newPage();
      results.tests.push({
        name: 'Create browser page',
        passed: true,
        details: 'Successfully created new page',
      });

      // Test 4: Try to navigate
      try {
        await page.goto('https://example.com', { waitUntil: 'networkidle0' });
        results.tests.push({
          name: 'Navigate to URL',
          passed: true,
          details: 'Successfully navigated to example.com',
        });

        // Test 5: Get page title
        const title = await page.title();
        results.tests.push({
          name: 'Read page content',
          passed: true,
          details: `Page title: "${title}"`,
        });

        await page.close();
      } catch (error) {
        results.tests.push({
          name: 'Navigate to URL',
          passed: false,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    } catch (error) {
      results.tests.push({
        name: 'Create browser page',
        passed: false,
        error: error instanceof Error ? error.message : String(error),
      });
    }

    await browser.close();
  } catch (error) {
    results.tests.push({
      name: 'Browser launch',
      passed: false,
      error: error instanceof Error ? error.message : String(error),
      hint: 'Browser Rendering API may not be enabled on your account',
    });
  }

  const allPassed = results.tests.every((test) => test.passed);
  return {
    ...results,
    overall: allPassed ? 'PASSED' : 'FAILED',
    summary: `${results.tests.filter((t) => t.passed).length}/${results.tests.length} tests passed`,
  };
}
