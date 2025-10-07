# DOM-Based Variable Extraction - Feasibility Analysis

## Executive Summary

This document analyzes the feasibility of extracting Figma variables directly from the browser DOM using Puppeteer/Chrome DevTools Protocol, as an alternative to the current plugin console-based approach.

**Recommendation: Network Interception Approach** - Most reliable, captures structured API data without DOM parsing complexity.

---

## Current Implementation Analysis

### Console-Based Extraction (Current)

**How it works:**
1. Figma REST API attempted first (requires Enterprise plan)
2. On 403 error, provides JavaScript snippet for plugin console
3. User runs snippet in Figma plugin context (`Plugins → Development → Open Console`)
4. Snippet uses `figma.variables.getLocalVariablesAsync()` API
5. Data logged to console with markers: `[MCP_VARIABLES]...data...[MCP_VARIABLES_END]`
6. Chrome DevTools Protocol monitors plugin console via Web Worker listeners
7. Second tool call parses captured console logs

**Limitations:**
- Requires user to manually run snippet in plugin console
- Two-step workflow (provide snippet → run → parse)
- Plugin context required (browser DevTools console won't work)
- User friction in discovering/using plugin console

**Advantages:**
- Works without Enterprise plan
- Gets complete variable data via official Plugin API
- Reliable and consistent data format
- Already implemented and tested

---

## DOM-Based Extraction Approaches

We have full Puppeteer capabilities available:
- Page navigation and interaction
- JavaScript execution in page context
- DOM querying and manipulation
- Network request/response interception
- Screenshot and element inspection

### Approach 1: Network Interception (RECOMMENDED)

**Concept:** Intercept API requests made by Figma's web app when loading variables data.

#### Implementation Strategy

```typescript
// In BrowserManager or new NetworkInterceptor class
async extractVariablesViaNetwork(fileKey: string): Promise<any> {
  const page = await this.getPage();

  // Storage for captured responses
  const capturedData: any[] = [];

  // Enable request interception
  await page.setRequestInterception(true);

  // Intercept responses containing variable data
  page.on('response', async (response) => {
    const url = response.url();
    const status = response.status();

    // Look for variable-related endpoints
    // These are hypothetical - need to inspect actual Figma network traffic
    if (
      url.includes('/api/variables') ||
      url.includes('/api/file_variables') ||
      url.includes('/graphql') && status === 200
    ) {
      try {
        const contentType = response.headers()['content-type'];
        if (contentType?.includes('application/json')) {
          const data = await response.json();
          capturedData.push({ url, data });
          logger.info({ url }, 'Captured variable API response');
        }
      } catch (error) {
        logger.error({ error, url }, 'Failed to parse response');
      }
    }
  });

  // Navigate to Figma file
  const figmaUrl = `https://www.figma.com/design/${fileKey}`;
  await page.goto(figmaUrl, { waitUntil: 'networkidle2' });

  // Wait for potential lazy-loaded variable requests
  await page.waitForTimeout(3000);

  // Attempt to trigger variables panel (if needed)
  await this.triggerVariablesPanel(page);

  // Wait for additional network activity
  await page.waitForTimeout(2000);

  return capturedData;
}

async triggerVariablesPanel(page: Page): Promise<void> {
  try {
    // Option 1: Keyboard shortcut (if exists)
    // await page.keyboard.press('Alt+v'); // hypothetical

    // Option 2: Click variables icon
    // Need to find stable selector via aria-label or data attribute
    const variablesButton = await page.$(
      '[aria-label*="Variables"],' +
      '[data-testid*="variables"],' +
      'button:has-text("Variables")'
    );

    if (variablesButton) {
      await variablesButton.click();
      await page.waitForTimeout(1000);
    }
  } catch (error) {
    logger.warn('Could not trigger variables panel, data may already be loaded');
  }
}
```

#### Testing Steps

1. **Manual Network Inspection First:**
   ```bash
   # Open Figma file in browser with DevTools open
   # Navigate to Network tab
   # Filter by: XHR, Fetch, or search "variable"
   # Identify actual endpoint patterns
   ```

2. **Implement Interception:**
   ```typescript
   // Add to figma-tools.ts or new network-extractor.ts
   const networkExtractor = new NetworkExtractor(browserManager);
   const variableData = await networkExtractor.extractVariables(fileKey);
   ```

3. **Compare Output:**
   - Run network extraction
   - Run plugin console extraction
   - Verify data completeness and format

#### Pros
- Most reliable - captures actual API data Figma uses
- No DOM parsing or obfuscation concerns
- Gets structured JSON responses
- Works regardless of UI changes
- Handles all variables without pagination issues
- Single-step extraction (no user interaction)

#### Cons
- Need to discover correct endpoint patterns (one-time investigation)
- Depends on Figma's internal API structure (could change)
- May need authentication/session handling
- Might miss data if timing is incorrect

#### Feasibility: HIGH
- Puppeteer has built-in response interception
- Network traffic is observable
- API responses are structured data
- Less brittle than DOM scraping

---

### Approach 2: DOM Scraping

**Concept:** Navigate to variables panel and extract data from rendered HTML table elements.

#### Implementation Strategy

```typescript
async extractVariablesViaDOMScraping(fileKey: string): Promise<any> {
  const page = await this.getPage();

  // Navigate to Figma file
  await page.goto(`https://www.figma.com/design/${fileKey}`);
  await page.waitForSelector('[data-testid="canvas"]', { timeout: 10000 });

  // Open variables panel
  await this.openVariablesPanel(page);

  // Wait for variables table to load
  await page.waitForSelector('[aria-label*="Variables table"]', { timeout: 5000 });

  // Extract variable data from DOM
  const variables = await page.evaluate(() => {
    const result: any[] = [];

    // Strategy 1: Find by ARIA labels (most stable)
    const table = document.querySelector('[role="table"]');
    if (!table) return result;

    const rows = table.querySelectorAll('[role="row"]');

    rows.forEach((row) => {
      const cells = row.querySelectorAll('[role="cell"]');
      if (cells.length >= 2) {
        result.push({
          name: cells[0]?.textContent?.trim(),
          value: cells[1]?.textContent?.trim(),
          // Additional columns as needed
        });
      }
    });

    return result;
  });

  return variables;
}

async openVariablesPanel(page: Page): Promise<void> {
  // Attempt multiple strategies to open variables panel

  // Strategy 1: Click icon by aria-label
  try {
    await page.click('[aria-label="Variables"]');
    return;
  } catch (e) {}

  // Strategy 2: Click by text content
  try {
    await page.click('button:has-text("Variables")');
    return;
  } catch (e) {}

  // Strategy 3: Use keyboard shortcut
  try {
    await page.keyboard.press('Alt+v'); // hypothetical
    return;
  } catch (e) {}

  throw new Error('Could not open variables panel');
}
```

#### Handling Virtualization

```typescript
// If Figma uses virtualized scrolling (only visible rows in DOM)
async extractAllVariablesWithScrolling(page: Page): Promise<any[]> {
  const allVariables: any[] = [];
  let previousCount = 0;

  while (true) {
    // Extract currently visible variables
    const visible = await this.extractVisibleVariables(page);
    allVariables.push(...visible);

    // Scroll down
    await page.evaluate(() => {
      const container = document.querySelector('[role="table"]')?.parentElement;
      if (container) {
        container.scrollTop += 1000;
      }
    });

    await page.waitForTimeout(500);

    // Check if new items loaded
    if (allVariables.length === previousCount) {
      break; // No new items, reached end
    }
    previousCount = allVariables.length;
  }

  // Deduplicate
  return Array.from(new Map(allVariables.map(v => [v.name, v])).values());
}
```

#### Finding Stable Selectors

```typescript
// Test different selector strategies
async findVariablesContainer(page: Page): Promise<string | null> {
  const strategies = [
    '[data-testid="variables-panel"]',
    '[aria-label*="Variables"]',
    '[class*="variables"]',
    'div:has(> h2:has-text("Variables"))',
  ];

  for (const selector of strategies) {
    const exists = await page.$(selector);
    if (exists) {
      logger.info({ selector }, 'Found variables container');
      return selector;
    }
  }

  return null;
}
```

#### Pros
- Direct access to visible data
- No API endpoint discovery needed
- Can capture exactly what user sees
- Works if network interception fails

#### Cons
- **Brittle:** Class names are likely obfuscated and change frequently
- **Virtualization:** May only see visible rows, need scrolling logic
- **Pagination:** Might need to handle multiple pages
- **Timing:** Need to wait for lazy-loaded content
- **Maintenance:** UI changes break selectors
- **Incomplete data:** DOM might not show all variable properties

#### Feasibility: MEDIUM
- Requires finding stable selectors (aria-labels, data-testid)
- Must handle virtualization/pagination
- Higher maintenance burden
- Good as fallback only

---

### Approach 3: React State Access

**Concept:** Access React component internals to extract state containing variable data.

#### Implementation Strategy

```typescript
async extractVariablesViaReactState(fileKey: string): Promise<any> {
  const page = await this.getPage();
  await page.goto(`https://www.figma.com/design/${fileKey}`);

  // Extract React Fiber state
  const variables = await page.evaluate(() => {
    // Find React root
    const rootElement = document.querySelector('#root') as any;
    if (!rootElement) return null;

    // Access React Fiber (React 16+)
    const fiberKey = Object.keys(rootElement).find(key =>
      key.startsWith('__reactFiber') || key.startsWith('__reactInternalInstance')
    );

    if (!fiberKey) return null;

    // Traverse Fiber tree to find variables state
    let fiber = rootElement[fiberKey];
    const maxDepth = 50;
    let depth = 0;

    while (fiber && depth < maxDepth) {
      // Check if this component has variables in state/props
      const state = fiber.memoizedState;
      const props = fiber.memoizedProps;

      if (state?.variables || props?.variables) {
        return state?.variables || props?.variables;
      }

      // Continue traversing
      fiber = fiber.child || fiber.sibling || fiber.return;
      depth++;
    }

    return null;
  });

  return variables;
}
```

#### Pros
- Direct access to application state
- Gets complete data structure
- No network dependency

#### Cons
- **Extremely brittle:** React internals are not public API
- **Obfuscated:** Figma likely uses production builds with minification
- **Unknown structure:** Don't know where variables live in state tree
- **Version-dependent:** React version changes break this
- **Unreliable:** State might be in Redux, MobX, or custom state management
- **Not recommended:** This approach is reverse-engineering and very fragile

#### Feasibility: LOW
- React Fiber API is unstable
- State structure unknown
- Too fragile for production use
- Not worth investigating further

---

## Recommended Implementation Plan

### Phase 1: Network Traffic Analysis (1-2 hours)

**Goal:** Identify actual API endpoints Figma uses for variables

**Steps:**
1. Open Figma file in browser with DevTools Network tab
2. Clear network log
3. Click on variables panel/icon
4. Filter requests by:
   - XHR/Fetch
   - Search terms: "variable", "token", "style"
   - Response type: JSON
5. Document endpoint patterns found
6. Inspect response structure
7. Note any authentication/headers required

**Expected Findings:**
- REST endpoints like `/api/variables/{fileKey}`
- GraphQL queries with variable-related selections
- WebSocket messages (less likely for read operations)

### Phase 2: Network Interception Implementation (2-4 hours)

**Create new file:** `/Users/tjbackup/Sites/figma-console-mcp/src/core/network-extractor.ts`

```typescript
/**
 * Network-based Variable Extractor
 * Captures variable data from Figma's internal API calls
 */

import type { Page } from 'puppeteer-core';
import { createChildLogger } from './logger.js';

const logger = createChildLogger({ component: 'network-extractor' });

interface CapturedResponse {
  url: string;
  data: any;
  timestamp: number;
}

export class NetworkExtractor {
  private capturedResponses: CapturedResponse[] = [];

  /**
   * Extract variables by intercepting network requests
   */
  async extractVariables(page: Page, fileKey: string): Promise<any> {
    this.capturedResponses = [];

    // Set up response listener
    page.on('response', async (response) => {
      await this.handleResponse(response);
    });

    // Navigate and trigger data loading
    await page.goto(`https://www.figma.com/design/${fileKey}`, {
      waitUntil: 'networkidle2',
    });

    // Wait for potential lazy-loaded requests
    await page.waitForTimeout(3000);

    // Attempt to open variables panel (triggers API call if not loaded)
    await this.triggerVariablesPanel(page);
    await page.waitForTimeout(2000);

    // Process captured responses
    return this.processVariableResponses();
  }

  private async handleResponse(response: any): Promise<void> {
    const url = response.url();
    const status = response.status();

    // Filter for variable-related endpoints
    // TODO: Update patterns based on Phase 1 findings
    if (
      (url.includes('/api/variables') ||
       url.includes('/api/file_variables') ||
       url.includes('/graphql')) &&
      status === 200
    ) {
      try {
        const contentType = response.headers()['content-type'];
        if (contentType?.includes('application/json')) {
          const data = await response.json();

          this.capturedResponses.push({
            url,
            data,
            timestamp: Date.now(),
          });

          logger.info({ url, dataSize: JSON.stringify(data).length },
                      'Captured variable response');
        }
      } catch (error) {
        logger.error({ error, url }, 'Failed to parse response');
      }
    }
  }

  private async triggerVariablesPanel(page: Page): Promise<void> {
    // Try multiple strategies to open variables panel
    const selectors = [
      '[aria-label*="Variables"]',
      '[data-testid*="variables"]',
      'button:has-text("Variables")',
    ];

    for (const selector of selectors) {
      try {
        const element = await page.$(selector);
        if (element) {
          await element.click();
          logger.info({ selector }, 'Clicked variables panel trigger');
          return;
        }
      } catch (error) {
        logger.debug({ selector, error }, 'Selector not found');
      }
    }

    logger.warn('Could not trigger variables panel, using passively loaded data');
  }

  private processVariableResponses(): any {
    if (this.capturedResponses.length === 0) {
      throw new Error('No variable data captured from network');
    }

    // Find response with variable data
    // TODO: Update based on actual response structure from Phase 1
    for (const response of this.capturedResponses) {
      if (response.data.variables || response.data.variableCollections) {
        return this.formatVariableData(response.data);
      }
    }

    throw new Error('Captured responses did not contain variable data');
  }

  private formatVariableData(rawData: any): any {
    // Format to match current console extraction format
    // TODO: Update based on actual API response structure
    return {
      source: 'network_interception',
      timestamp: Date.now(),
      local: {
        summary: {
          total_variables: rawData.variables?.length || 0,
          total_collections: rawData.variableCollections?.length || 0,
        },
        collections: rawData.variableCollections || [],
        variables: rawData.variables || [],
      },
    };
  }
}
```

### Phase 3: Integration with Existing Tools (1 hour)

**Update:** `/Users/tjbackup/Sites/figma-console-mcp/src/core/figma-tools.ts`

```typescript
import { NetworkExtractor } from './network-extractor.js';

// In figma_get_variables tool handler
async ({ fileUrl, parseFromConsole, useNetworkExtraction, ... }) => {
  try {
    // NEW: Try network extraction first
    if (useNetworkExtraction) {
      const page = await browserManager.getPage();
      const networkExtractor = new NetworkExtractor();
      const fileKey = extractFileKey(fileUrl || getCurrentUrl());

      const variableData = await networkExtractor.extractVariables(page, fileKey);

      return {
        content: [{
          type: 'text',
          text: JSON.stringify(variableData, null, 2),
        }],
      };
    }

    // Existing REST API and console extraction logic...
  }
}
```

### Phase 4: Testing & Validation (2 hours)

**Test Cases:**
1. Public Figma file with variables
2. File with large number of variables (100+)
3. File with multiple collections
4. File with different variable types (color, number, string)
5. Compare with plugin console extraction output

**Validation:**
```bash
# Test network extraction
npm run test:network-extraction

# Compare with existing method
npm run test:compare-extraction-methods
```

---

## Comparison Matrix

| Approach | Reliability | Maintenance | User Friction | Data Completeness | Implementation Effort |
|----------|-------------|-------------|---------------|-------------------|---------------------|
| **Current (Console)** | High | Low | Medium | Complete | Done |
| **Network Interception** | High | Medium | None | Complete | Medium |
| **DOM Scraping** | Low | High | None | Partial | High |
| **React State** | Very Low | Very High | None | Unknown | High |

---

## Technical Limitations & Challenges

### Network Interception Challenges

1. **Authentication:**
   - Figma's API calls may require session cookies
   - Need to ensure browser has valid Figma session
   - May need to handle OAuth/token refresh

2. **Timing:**
   - Variables might load on initial page load
   - Or only when panel is opened
   - Need to capture both scenarios

3. **API Changes:**
   - Figma can change internal API endpoints
   - Response structure could evolve
   - Need monitoring and updates

4. **Rate Limiting:**
   - Multiple rapid extractions might trigger rate limits
   - Need to respect Figma's usage policies

### DOM Scraping Challenges

1. **Obfuscation:**
   - Class names like `css-1a2b3c4` change with each deployment
   - Need to rely on semantic HTML (aria-labels, roles)
   - Figma might not have consistent semantic markup

2. **Virtualization:**
   - Large variable lists only render visible rows
   - Need scrolling logic to capture all data
   - Complex implementation

3. **Dynamic Loading:**
   - Content loads asynchronously
   - Need proper wait conditions
   - Flaky tests possible

### General Challenges

1. **Browser Session:**
   - User needs to be logged into Figma
   - Session might expire
   - Need to handle auth state

2. **Performance:**
   - Full browser automation is slower than API calls
   - Network interception adds overhead
   - Need to balance speed vs reliability

3. **Maintenance:**
   - Any Figma UI/API changes require updates
   - More moving parts than REST API
   - Need monitoring and alerts

---

## Conclusion & Recommendation

### Recommended Approach: Network Interception

**Rationale:**
1. **Most Reliable:** Captures actual structured API data
2. **Low Maintenance:** Less brittle than DOM scraping
3. **Complete Data:** Gets all variable properties
4. **No User Friction:** Fully automated, no manual steps
5. **Proven Pattern:** Similar to how browser extensions work

### Implementation Timeline

- **Phase 1** (Research): 1-2 hours - Network traffic analysis
- **Phase 2** (Development): 2-4 hours - Network extractor implementation
- **Phase 3** (Integration): 1 hour - Connect to existing tools
- **Phase 4** (Testing): 2 hours - Validation and comparison
- **Total:** ~6-9 hours of development

### Fallback Strategy

If network interception proves unreliable:
1. Keep current console-based extraction as primary
2. Use network interception as optional feature
3. Add DOM scraping as last resort

### When to Use Each Method

```typescript
async function extractVariables(fileKey: string) {
  // Strategy 1: REST API (if Enterprise)
  try {
    return await restAPI.getVariables(fileKey);
  } catch (e) {
    if (!e.message.includes('403')) throw e;
  }

  // Strategy 2: Network Interception (automated)
  try {
    return await networkExtractor.extract(fileKey);
  } catch (e) {
    logger.warn('Network extraction failed, falling back to console');
  }

  // Strategy 3: Console-based (requires user action)
  return await consoleExtractor.extract(fileKey);
}
```

---

## Next Steps

1. **Immediate:** Perform Phase 1 network traffic analysis manually
2. **Document:** Record actual endpoint patterns and response structures
3. **Implement:** Create NetworkExtractor class based on findings
4. **Test:** Validate with multiple Figma files
5. **Iterate:** Refine based on edge cases discovered
6. **Deploy:** Release as optional feature alongside console extraction

---

## Code Examples for Testing

### Manual Network Analysis Script

```javascript
// Run this in browser DevTools console while on Figma file
(function() {
  const capturedRequests = [];

  // Intercept fetch
  const originalFetch = window.fetch;
  window.fetch = function(...args) {
    const url = args[0];
    if (typeof url === 'string' && (
      url.includes('variable') ||
      url.includes('token') ||
      url.includes('style')
    )) {
      console.log('[MCP INTERCEPT]', url);
      capturedRequests.push({ url, timestamp: Date.now() });
    }
    return originalFetch.apply(this, args);
  };

  // Intercept XMLHttpRequest
  const originalOpen = XMLHttpRequest.prototype.open;
  XMLHttpRequest.prototype.open = function(method, url) {
    if (typeof url === 'string' && (
      url.includes('variable') ||
      url.includes('token') ||
      url.includes('style')
    )) {
      console.log('[MCP INTERCEPT XHR]', url);
      capturedRequests.push({ url, timestamp: Date.now(), method });
    }
    return originalOpen.apply(this, arguments);
  };

  console.log('[MCP] Network interception active. Open variables panel now.');
  console.log('[MCP] Run window.mcpCapturedRequests to see results');

  window.mcpCapturedRequests = capturedRequests;
})();
```

### Test Integration

```typescript
// test/network-extraction.test.ts
import { NetworkExtractor } from '../src/core/network-extractor';
import puppeteer from 'puppeteer-core';

describe('Network-based Variable Extraction', () => {
  let browser: Browser;
  let page: Page;
  let extractor: NetworkExtractor;

  beforeAll(async () => {
    browser = await puppeteer.launch({ headless: false });
    page = await browser.newPage();
    extractor = new NetworkExtractor();
  });

  test('extracts variables from public file', async () => {
    const fileKey = 'y83n4o9LOGs74oAoguFcGS'; // Altitude Design System
    const result = await extractor.extractVariables(page, fileKey);

    expect(result.local.summary.total_variables).toBeGreaterThan(0);
    expect(result.local.variables).toBeInstanceOf(Array);
  });

  afterAll(async () => {
    await browser.close();
  });
});
```

---

## Resources

- [Puppeteer Request Interception Docs](https://pptr.dev/guides/request-interception)
- [Chrome DevTools Protocol - Network Domain](https://chromedevtools.github.io/devtools-protocol/tot/Network/)
- [Figma Plugin API - Variables](https://www.figma.com/plugin-docs/api/variables/)

---

**Document Version:** 1.0
**Last Updated:** 2025-10-06
**Author:** Backend Architect Analysis
