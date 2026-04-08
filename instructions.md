# Screen Capture to Figma — Usage Guide

## Setup (one-time)

### 1. Add the MCP server to Claude Code

```bash
claude mcp add figma-console -s user -e FIGMA_ACCESS_TOKEN=figd_YOUR_TOKEN_HERE -- node /path/to/figma-console-mcp/dist/local.js
```

Replace `/path/to/` with your local clone path and add your [Figma personal access token](https://www.figma.com/settings) (Settings → Personal access tokens).

### 2. Build the project

```bash
cd figma-console-mcp
npm install
npm run build:local
```

### 3. Open the Desktop Bridge in Figma

In Figma Desktop: **Plugins → Development → Figma Desktop Bridge**

The plugin auto-connects to `ws://localhost:9223`. You should see "Connected" in the plugin panel.

### 4. Start a Claude Code session

The three screen capture tools will be available automatically.

## Quick Start

### List available flows

> "List the available screen capture flows"

### Capture a full activation funnel

> "Capture the activation funnel for DE on staging, mobile viewport"

### Capture Factor US flow

> "Capture the activation flow for US with the factor-us variant on mobile"

### Capture any URL

> "Capture https://www-staging.hellofresh.com/plans on desktop"

## Tools

### screen_capture_list_flows

No parameters. Returns all domains, steps, variants, supported countries, and viewport options.

### screen_capture_flow

| Parameter | Required | Description |
|-----------|----------|-------------|
| `domain` | Yes | `activation`, `reactivation`, or `onboarding` |
| `country` | Yes | Country code: `US`, `GB`, `DE`, etc. |
| `environment` | No | `staging` (default) or `live` |
| `viewport` | No | `desktop` (1440x900) or `mobile` (375x812) |
| `variant` | No | Experiment variant ID (see below) |
| `steps` | No | Array of specific step IDs (omit for all) |
| `email` | Conditional | Required for reactivation |
| `password` | Conditional | Required for reactivation |

### screen_capture_url

| Parameter | Required | Description |
|-----------|----------|-------------|
| `url` | Yes | Full URL to capture |
| `viewport` | No | `desktop` or `mobile` |
| `label` | No | Name for the Figma frame |

## Flows

### Activation Funnel (default)

No auth needed. Navigates through the single-question flow (SQF) by clicking continue between sub-steps.

| Step ID | Screen |
|---------|--------|
| `activation-landing` | Landing / Homepage |
| `activation-plans-preferences` | Plans - Preferences |
| `activation-plans-additional-preference` | Plans - Additional Preference |
| `activation-plans-goals` | Plans - Goals |
| `activation-plans-assurance` | Plans - Assurance |
| `activation-plans-meal-type` | Plans - Meal Type |
| `activation-plans-meals` | Plans - Meal Count |
| `activation-plans-size` | Plans - Size Selection |
| `activation-plans-recommendation` | Plans - Plan Recommendation |
| `activation-signup` | Sign Up - Email |
| `activation-checkout-address` | Checkout - Address |
| `activation-checkout-delivery` | Checkout - Delivery Window |
| `activation-checkout-payment` | Checkout - Payment |

### Activation Variants

| Variant ID | Description | Steps |
|------------|-------------|-------|
| `extended-funnel` | Extended Funnel (USCRO-7882) — 15-step mobile funnel with personalization questions | 15 |
| `factor-us` | Factor US Mobile — 8-step quiz (auto-overrides country to FJ/factor75.com) | 8 |
| `factor-us-desktop` | Factor US Desktop — 9-step quiz with recommender | 9 |
| `factor-us-extended` | Factor US Extended Funnel (USCRO-8126) | 8 |

Usage:
> "Capture the activation flow for US with the factor-us variant on mobile"

Variants with `countryOverride` (like Factor) automatically use the correct brand URL regardless of the `country` parameter.

### Reactivation

Requires authentication — provide staging test account credentials.

| Step ID | Screen |
|---------|--------|
| `reactivation-login` | Login |
| `reactivation-main` | Reactivation Page - Top |
| `reactivation-plan` | Plan Selection (scrolled) |
| `reactivation-delivery` | Delivery Options (scrolled) |
| `reactivation-summary` | Summary (scrolled) |

### Onboarding

No auth needed.

| Step ID | Screen |
|---------|--------|
| `onboarding-start` | Start |
| `onboarding-zipcode` | Zipcode |
| `onboarding-preferences` | Preferences |
| `onboarding-plan-select` | Plan Recommendation |

## What You Get in Figma

For each captured screen, a Figma frame is created with a full-fidelity screenshot at 100% opacity. All screens are laid out sequentially in a Section frame named:

```
Screen Capture - activation - DE staging - mobile - 2026-04-08
```

## Supported Countries

**HelloFresh:** US, AT, AU, BE, CA, CH, DE, DK, ES, FR, GB, IE, IT, JP, LU, NL, NZ, SE, NO

**Sub-brands:** ER (EveryPlate), CG (Green Chef), CK (Chef's Plate), FJ (Factor), GN (Green Chef UK), YE (Youfoodz), CF (Factor CA), KN (The Pet's Table)

## Adding New Flows or Steps

Edit `src/screen-capture/flow-definitions.ts`:

- Add steps to an existing flow's `steps` array
- Add experiment variants to the `variants` array on a `FlowConfig`
- Add new brands/countries to `BASE_URL_MAP`

Each step needs:
- `id` — unique identifier
- `label` — human-readable name (becomes the Figma frame name)
- `url` — relative path (optional, omit to stay on current page)
- `actions` — interactions before capture: `click`, `fill`, `scroll`, `wait`
- `waitFor` — CSS selector(s) to confirm the page is ready

Rebuild after changes: `npm run build:local`

## Troubleshooting

**"Cannot connect to Figma Desktop"** — Open the Desktop Bridge plugin in Figma.

**"Failed to connect to Chrome"** — Google Chrome must be installed at `/Applications/Google Chrome.app/`.

**"Authentication required"** — The reactivation flow needs `email` and `password` params.

**Screens look incomplete** — Some pages may not fully load before capture. Update `waitFor` selectors in `flow-definitions.ts` to match current production markup, or add `wait` actions for additional delay.
