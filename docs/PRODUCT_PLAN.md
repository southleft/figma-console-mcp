# Figma Console MCP Server - Product Plan

## Executive Summary

**Product Name:** Figma Console MCP
**Version:** 1.0.0
**Target Market:** Figma plugin developers using AI coding assistants (Cursor, Claude Code, etc.)
**Core Value Proposition:** Enable AI agents to autonomously debug Figma plugins by accessing console logs and screenshots in real-time, eliminating manual copy-paste workflows.

## 1. Product Vision & Strategy

### Problem Statement
Figma plugin developers currently face significant friction when debugging with AI assistants:
- Must manually copy console logs from Figma's DevTools
- Must manually capture and share screenshots
- AI cannot see the runtime results of its own code changes
- Debugging is slow, iterative, and requires constant human intervention

### Solution
An MCP server that bridges AI coding assistants to Figma's runtime environment, providing:
- Real-time console log access from Figma plugins
- Automated screenshot capture of plugin UI
- Direct visibility into plugin execution state
- Autonomous debugging loop: AI writes code → sees results → fixes issues

### Product Goals
1. **Autonomous Debugging**: Enable AI to debug Figma plugins without human intervention
2. **Zero Friction**: Eliminate all manual copy-paste steps in the debugging workflow
3. **Real-time Visibility**: Provide console logs within 1 second of generation
4. **Universal Compatibility**: Work with all MCP-compatible AI assistants
5. **Developer Productivity**: 10x improvement in plugin debugging speed

### Success Metrics (KPIs)
- Console log retrieval latency < 1 second
- Screenshot capture success rate > 95%
- Zero manual interventions required for standard debugging scenarios
- Adoption by 100+ Figma plugin developers in first 6 months
- 5-star average rating in MCP server directory

### Target Audience
**Primary Users:**
- Figma plugin developers using AI coding assistants
- Teams building complex Figma plugins with AI assistance
- Solo developers prototyping Figma plugin ideas

**User Personas:**
1. **Alex - Solo Plugin Developer**: Uses Claude Code, builds plugins in spare time, frustrated by debugging overhead
2. **Jamie - Enterprise Plugin Team Lead**: Manages team using Cursor, needs efficient debugging for rapid iteration
3. **Sam - AI-First Developer**: Relies heavily on AI for coding, wants AI to handle debugging autonomously

## 2. Technical Architecture

### Technology Stack

**Core Dependencies:**
- `@modelcontextprotocol/sdk` (^1.0.0) - MCP server framework
- `puppeteer` (^23.0.0) - Browser automation
- `typescript` (^5.0.0) - Type safety
- `chrome-remote-interface` (^0.33.0) - Chrome DevTools Protocol client

**Development Tools:**
- Node.js >= 18
- npm/pnpm for package management
- TypeScript compiler
- ESLint + Prettier for code quality

### System Architecture

```
┌─────────────────────────────────────────────────────┐
│                  AI Coding Assistant                 │
│              (Cursor, Claude Code, etc.)             │
└───────────────────┬─────────────────────────────────┘
                    │ MCP Protocol
                    │
┌───────────────────▼─────────────────────────────────┐
│              Figma Console MCP Server                │
│  ┌─────────────────────────────────────────────┐   │
│  │  MCP Tools Layer                            │   │
│  │  - figma_get_console_logs()                 │   │
│  │  - figma_take_screenshot()                  │   │
│  │  - figma_watch_console()                    │   │
│  │  - figma_reload_plugin()                    │   │
│  │  - figma_clear_console()                    │   │
│  └──────────────────┬──────────────────────────┘   │
│                     │                               │
│  ┌──────────────────▼──────────────────────────┐   │
│  │  Console Monitor (CDP)                      │   │
│  │  - Attach to Figma tab                      │   │
│  │  - Filter plugin logs                       │   │
│  │  - Buffer recent messages                   │   │
│  └──────────────────┬──────────────────────────┘   │
│                     │                               │
│  ┌──────────────────▼──────────────────────────┐   │
│  │  Screenshot Manager                         │   │
│  │  - Capture full page / element              │   │
│  │  - Timestamp & metadata                     │   │
│  └──────────────────┬──────────────────────────┘   │
│                     │                               │
│  ┌──────────────────▼──────────────────────────┐   │
│  │  Figma Manager (Puppeteer)                  │   │
│  │  - Launch/connect to browser                │   │
│  │  - Navigate to Figma                        │   │
│  │  - Detect plugin context                    │   │
│  └─────────────────────────────────────────────┘   │
└───────────────────┬─────────────────────────────────┘
                    │ Chrome DevTools Protocol
                    │
┌───────────────────▼─────────────────────────────────┐
│              Chrome Browser (Controlled)             │
│  ┌─────────────────────────────────────────────┐   │
│  │            Figma Web Application            │   │
│  │  ┌───────────────────────────────────────┐ │   │
│  │  │      Figma Plugin (User's Code)       │ │   │
│  │  │      Console logs → DevTools          │ │   │
│  │  └───────────────────────────────────────┘ │   │
│  └─────────────────────────────────────────────┘   │
└─────────────────────────────────────────────────────┘
```

### Core Components

#### 1. MCP Server (`src/server.ts`)
- Implements MCP protocol handlers
- Registers and exposes tools to AI agents
- Manages server lifecycle and configuration
- Handles authentication and permissions

#### 2. Figma Manager (`src/figma-manager.ts`)
- Browser automation via Puppeteer
- Navigate to Figma and detect plugin context
- Handle browser lifecycle (launch, connect, close)
- Retry logic and error recovery

#### 3. Console Monitor (`src/console-monitor.ts`)
- Connect to Chrome DevTools Protocol
- Subscribe to Console domain events
- Filter logs to plugin-specific messages
- Buffer recent logs with timestamps
- Real-time streaming support

#### 4. Screenshot Manager (`src/screenshot-manager.ts`)
- Capture screenshots via Puppeteer
- Support full page and element screenshots
- Add timestamps and metadata
- Store in temporary directory with cleanup

#### 5. MCP Tools (`src/tools/`)
Individual tool implementations:
- `get-console-logs.ts` - Retrieve buffered console messages
- `take-screenshot.ts` - Capture current plugin state
- `watch-console.ts` - Stream logs in real-time
- `reload-plugin.ts` - Reload plugin after code changes
- `clear-console.ts` - Clear console for next test

### Data Models

```typescript
interface ConsoleLogEntry {
  timestamp: number;
  level: 'log' | 'info' | 'warn' | 'error' | 'debug';
  message: string;
  args: any[];
  stackTrace?: string;
  source: 'plugin' | 'figma' | 'unknown';
}

interface Screenshot {
  id: string;
  timestamp: number;
  path: string;
  format: 'png' | 'jpeg';
  width: number;
  height: number;
  metadata?: Record<string, any>;
}

interface PluginContext {
  pluginId?: string;
  pluginName?: string;
  isRunning: boolean;
  lastReloadTime?: number;
}
```

### Scalability & Performance

**Performance Targets:**
- Console log retrieval: < 1 second latency
- Screenshot capture: < 2 seconds
- Memory footprint: < 200MB
- Concurrent connections: Support 1 active debugging session

**Optimization Strategies:**
- Lazy browser initialization (only launch when needed)
- Log buffer with configurable size (default 1000 messages)
- Screenshot caching with TTL
- Efficient CDP message filtering
- Connection pooling for multiple tabs

## 3. Development Methodology

### Development Framework
**Approach:** Agile with weekly sprints
**Sprint Duration:** 1 week
**Team:** 1-2 developers (initially solo, AI-assisted)

### Sprint Ceremonies
- **Sprint Planning:** Define sprint goals and tasks (Monday)
- **Daily Standup:** Quick async check-in (Slack/Discord)
- **Sprint Review:** Demo working features (Friday)
- **Sprint Retro:** Improve process (Friday)

### Coding Standards
- **TypeScript Strict Mode:** Enabled
- **Linting:** ESLint with recommended rules
- **Formatting:** Prettier (2 spaces, single quotes)
- **Testing:** Jest for unit tests, minimum 70% coverage
- **Documentation:** JSDoc for public APIs

### Version Control Strategy
- **Branching:** GitFlow (main, develop, feature/*, hotfix/*)
- **Commits:** Conventional Commits (feat:, fix:, docs:, etc.)
- **PRs:** Required for all changes, AI-assisted reviews
- **Versioning:** Semantic Versioning (MAJOR.MINOR.PATCH)

### Review & Approval Process
1. Developer creates feature branch
2. Implements feature with tests
3. Creates PR with description
4. AI code review + human validation
5. Merge to develop
6. Weekly release to main

## 4. Agent OS Setup

### Agent Roles & Permissions

**Primary Agents:**

1. **Implementation Agent** (`/sc:implement`)
   - Permission: Write code, run tests
   - Responsibility: Feature development
   - Tools: All Serena MCP tools

2. **Testing Agent** (`/sc:test`)
   - Permission: Read code, write tests, run builds
   - Responsibility: Test coverage and quality
   - Tools: Test runner, code coverage tools

3. **Review Agent** (`senior-code-reviewer`)
   - Permission: Read all code
   - Responsibility: Code quality and architecture
   - Tools: Read, Grep, Glob

4. **Documentation Agent** (`/sc:document`)
   - Permission: Read code, write docs
   - Responsibility: API docs, README, guides
   - Tools: Read, Write

### Agent Collaboration Rules

**Workflow:**
1. User requests feature via `/sc:implement <feature>`
2. Implementation Agent builds feature
3. Testing Agent validates with tests
4. Review Agent provides feedback
5. Implementation Agent addresses feedback
6. Documentation Agent updates docs
7. Feature complete

**Communication:**
- Agents use structured comments in code
- Handoffs documented in PR descriptions
- Issues tracked in GitHub Issues

### Automation Workflows

```yaml
# .github/workflows/agent-os.yml
name: Agent OS CI/CD

on:
  push:
    branches: [develop, main]
  pull_request:

jobs:
  test:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v3
      - name: Run tests
        run: npm test

  review:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v3
      - name: AI Code Review
        run: npx @anthropic/code-reviewer

  build:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v3
      - name: Build package
        run: npm run build
```

## 5. Resource Planning

### Required Skills & Expertise
- **TypeScript/Node.js** - Core development (Senior level)
- **Browser Automation** - Puppeteer/Playwright expertise (Mid level)
- **MCP Protocol** - Understanding of MCP SDK (Junior-Mid level)
- **Chrome DevTools Protocol** - CDP knowledge (Mid level)
- **Figma API** - Plugin development experience (Mid level)

### Human Resources
**Phase 1 (MVP):** 1 developer + AI assistance (100 hours)
**Phase 2-3:** 1-2 developers + AI assistance (150 hours)
**Phase 4:** 2 developers + AI assistance (100 hours)

**Total Estimated:** 350 development hours over 12 weeks

### AI Resources
- **Claude Code:** Primary coding assistant
- **Implementation Agent:** Feature development
- **Testing Agent:** Test generation and validation
- **Review Agent:** Code quality and architecture review
- **Documentation Agent:** API and user documentation

### Infrastructure Needs

**Development:**
- GitHub repository (public/private)
- CI/CD via GitHub Actions
- npm registry for package distribution
- Development machines with Chrome installed

**Production:**
- npm package hosting (free tier)
- GitHub Pages for documentation
- No server infrastructure needed (runs locally)

**Costs:**
- Development: $0 (open source tooling)
- CI/CD: $0 (GitHub Actions free tier)
- Distribution: $0 (npm registry)
- **Total: $0/month**

### Budget Estimation

**Development Costs:**
- Developer time: 350 hours × $75/hr = $26,250
- AI assistance: Included in Claude Code subscription
- Infrastructure: $0
- **Total Development Budget: $26,250**

**Ongoing Costs:**
- Maintenance: 10 hours/month × $75/hr = $750/month
- Infrastructure: $0/month
- **Total Monthly: $750**

### Timeline & Milestones

**Phase 1: MVP (Weeks 1-4)**
- Week 1: Project setup, basic MCP server
- Week 2: Puppeteer integration, Figma navigation
- Week 3: Console log capture via CDP
- Week 4: Testing, documentation, release v0.1.0

**Phase 2: Screenshots (Weeks 5-7)**
- Week 5: Screenshot capture implementation
- Week 6: Screenshot management and storage
- Week 7: Testing, release v0.2.0

**Phase 3: Real-time Monitoring (Weeks 8-10)**
- Week 8: WebSocket streaming for live logs
- Week 9: Auto-reload on file changes
- Week 10: Testing, release v0.3.0

**Phase 4: Advanced Features (Weeks 11-12)**
- Week 11: Error categorization, network monitoring
- Week 12: Polish, documentation, release v1.0.0

**Total Timeline:** 12 weeks from start to v1.0.0

## 6. Risk Management

### Identified Risks

| Risk | Impact | Likelihood | Mitigation Strategy |
|------|--------|------------|---------------------|
| Figma UI changes break automation | High | Medium | Use robust selectors, version detection, fallback strategies |
| Console log volume overwhelms buffer | Medium | High | Implement filtering, configurable limits, pagination |
| Screenshot timing issues | Medium | Medium | Add wait/retry logic, configurable delays |
| Browser crashes/disconnects | High | Low | Automatic reconnection, graceful error handling |
| Performance overhead | Medium | Medium | Lazy loading, caching, connection pooling |
| CDP API changes | Medium | Low | Pin Puppeteer version, monitor CDP updates |
| Figma plugin sandbox limitations | High | Low | Test early, document limitations, provide workarounds |
| MCP protocol changes | Medium | Low | Pin MCP SDK version, monitor updates |

### Contingency Plans

**If Figma blocks automation:**
- Fallback to browser extension approach
- Work with Figma team on official API
- Document manual workarounds

**If performance is poor:**
- Implement aggressive caching
- Reduce log buffer size
- Optimize CDP message filtering

**If adoption is slow:**
- Create demo videos and tutorials
- Integrate with popular plugin templates
- Submit to MCP server directory early

### Monitoring & Alerts

**Development:**
- GitHub Actions CI failures → Email notification
- Test coverage drops below 70% → Block PR merge
- Build failures → Slack notification

**Production:**
- npm download metrics (weekly review)
- GitHub issue response time < 48 hours
- User feedback via GitHub Discussions

### Escalation Procedures

**Level 1 - Minor Issues:**
- Developer handles independently
- Log in GitHub Issues
- Fix in next sprint

**Level 2 - Major Bugs:**
- Create hotfix branch
- Emergency fix within 24 hours
- Release patch version

**Level 3 - Critical Failures:**
- Halt development
- Root cause analysis
- Architecture review if needed
- Community communication

## 7. Feature Roadmap

### Phase 1: MVP (v0.1.0)
**Goal:** Basic console log capture from Figma plugins

**Features:**
- ✅ MCP server boilerplate with TypeScript
- ✅ Puppeteer integration to launch/control Chrome
- ✅ Navigate to Figma and detect plugin context
- ✅ Connect to Chrome DevTools Protocol
- ✅ Capture console logs (all levels)
- ✅ Filter logs to plugin-specific messages
- ✅ Tool: `figma_get_console_logs()`
- ✅ Basic error handling and reconnection
- ✅ README with setup instructions

**Success Criteria:**
- AI can retrieve console logs from running Figma plugin
- Logs retrieved within 1 second of generation
- Works with Claude Code and Cursor

### Phase 2: Screenshots (v0.2.0)
**Goal:** Visual debugging via automated screenshots

**Features:**
- ✅ Screenshot capture via Puppeteer
- ✅ Support full page and element screenshots
- ✅ Timestamp and metadata tagging
- ✅ Tool: `figma_take_screenshot()`
- ✅ Screenshot storage with cleanup
- ✅ Base64 encoding for MCP transport

**Success Criteria:**
- AI can capture screenshots of plugin UI
- Screenshots accurately reflect current state
- Capture completes in < 2 seconds

### Phase 3: Real-time Monitoring (v0.3.0)
**Goal:** Live console streaming and auto-reload

**Features:**
- ✅ WebSocket/streaming for live console logs
- ✅ Tool: `figma_watch_console()` (streaming mode)
- ✅ File watcher for plugin code changes
- ✅ Tool: `figma_reload_plugin()` (auto-reload)
- ✅ Tool: `figma_clear_console()`
- ✅ Configurable log retention and filtering

**Success Criteria:**
- AI can stream console logs in real-time
- Plugin auto-reloads on code changes
- AI completes full debug loop autonomously

### Phase 4: Advanced Features (v1.0.0)
**Goal:** Production-ready with advanced debugging

**Features:**
- ✅ Error categorization (error/warn/info/debug)
- ✅ Network request monitoring
- ✅ Performance metrics (FPS, memory, CPU)
- ✅ Plugin state inspection (Figma API calls)
- ✅ Multi-tab support (test multiple plugins)
- ✅ Configurable via .figmarc file
- ✅ Comprehensive documentation
- ✅ Video tutorials and examples

**Success Criteria:**
- Production-ready for daily use
- Comprehensive documentation
- Listed in MCP server directory
- 10+ active users

### Future Enhancements (Post v1.0)
- Integration with Figma Plugin API for deeper inspection
- Support for FigJam plugins
- Historical log analysis and search
- AI-powered error pattern detection
- VS Code extension for easier setup
- Figma plugin manifest validation
- Auto-generate plugin tests from console logs

## 8. Competitive Analysis

### Existing Solutions

| Solution | Pros | Cons | Differentiation |
|----------|------|------|-----------------|
| **Manual Copy-Paste** | Simple, always works | Slow, error-prone, breaks AI flow | We automate completely |
| **ChromeDevTools MCP** | General browser automation | Not Figma-specific, manual navigation | We auto-detect Figma plugins |
| **Browser Extensions** | Direct access to DevTools | Requires manual setup, not AI-native | We integrate with AI directly |
| **Figma Plugin Debugger** | Built into Figma | Manual, no AI integration | We enable autonomous AI debugging |

### Unique Value Propositions

1. **Figma-Native:** Auto-detects and filters plugin-specific logs
2. **AI-First:** Designed for autonomous AI debugging workflows
3. **Zero Configuration:** Works out-of-the-box with MCP clients
4. **Real-time:** Live console streaming, not just snapshots
5. **Auto-Reload:** Watches code changes and reloads automatically

## 9. Go-to-Market Strategy

### Launch Plan

**Week 1-2 (Soft Launch):**
- Publish v0.1.0 to npm
- Create GitHub repository (public)
- Write comprehensive README
- Submit to MCP server directory

**Week 3-4 (Public Launch):**
- Publish v0.2.0 with screenshots
- Create demo video (3-5 minutes)
- Post on Twitter, LinkedIn, Dev.to
- Submit to Figma plugin community forum

**Week 5-8 (Growth):**
- Publish v0.3.0 with real-time features
- Create tutorial blog posts
- Reach out to popular Figma plugin creators
- Present at Figma plugin meetup

**Week 9-12 (Scale):**
- Publish v1.0.0 production-ready
- Create comprehensive documentation site
- Submit to Product Hunt
- Sponsor Figma plugin newsletter

### Marketing Channels

1. **GitHub:** Primary distribution and community
2. **npm:** Package hosting and discovery
3. **MCP Server Directory:** Official MCP listing
4. **Twitter/X:** Developer community engagement
5. **Dev.to:** Tutorial blog posts
6. **Figma Community:** Plugin developer forum
7. **YouTube:** Demo videos and tutorials
8. **Product Hunt:** Launch announcement

### Success Metrics

**Month 1:**
- 50 npm downloads
- 10 GitHub stars
- 3 active users

**Month 3:**
- 250 npm downloads
- 50 GitHub stars
- 20 active users
- 5 community contributions

**Month 6:**
- 1,000 npm downloads
- 150 GitHub stars
- 100 active users
- Listed in top 20 MCP servers
- Featured in Figma newsletter

## 10. Deliverables Summary

### Documentation
- ✅ Product Requirements Document (this file)
- ✅ Technical Architecture Document
- ✅ API Reference Documentation
- ✅ User Guide and Tutorials
- ✅ Contributing Guidelines
- ✅ Code of Conduct
- ✅ LICENSE (MIT)

### Code Deliverables
- ✅ MCP Server Implementation
- ✅ Puppeteer Browser Automation
- ✅ Console Monitor (CDP)
- ✅ Screenshot Manager
- ✅ MCP Tool Implementations
- ✅ TypeScript Type Definitions
- ✅ Unit Tests (70%+ coverage)
- ✅ Integration Tests

### Infrastructure
- ✅ GitHub Repository
- ✅ CI/CD Pipeline (GitHub Actions)
- ✅ npm Package
- ✅ Documentation Site (GitHub Pages)
- ✅ Issue Templates
- ✅ PR Templates

### Marketing Materials
- ✅ Demo Video (3-5 minutes)
- ✅ Tutorial Blog Posts (3+)
- ✅ Screenshot Gallery
- ✅ Use Case Examples
- ✅ Comparison Matrix

## 11. Appendices

### A. Glossary

- **MCP:** Model Context Protocol - Standard for AI agent tool integration
- **CDP:** Chrome DevTools Protocol - Low-level browser debugging API
- **Puppeteer:** Node.js library for browser automation
- **Figma Plugin:** Custom code running in Figma's plugin sandbox
- **AI Agent:** Autonomous coding assistant (Claude Code, Cursor, etc.)

### B. References

- [Chrome DevTools MCP GitHub](https://github.com/ChromeDevTools/chrome-devtools-mcp/)
- [MCP Protocol Specification](https://modelcontextprotocol.io/)
- [Puppeteer Documentation](https://pptr.dev/)
- [Chrome DevTools Protocol](https://chromedevtools.github.io/devtools-protocol/)
- [Figma Plugin API](https://www.figma.com/plugin-docs/)

### C. Related Projects

- [chrome-devtools-mcp](https://github.com/ChromeDevTools/chrome-devtools-mcp) - General browser automation
- [browser-tools-mcp](https://github.com/AgentDeskAI/browser-tools-mcp) - Browser log monitoring
- [playwright-mcp](https://github.com/microsoft/playwright) - Alternative browser automation

---

**Document Version:** 1.0
**Last Updated:** 2025-10-05
**Author:** AI Product Planning Agent
**Status:** Ready for Implementation
