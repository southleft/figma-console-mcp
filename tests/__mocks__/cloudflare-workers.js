/**
 * Mock for cloudflare:workers module used in Jest tests.
 * Provides a minimal DurableObject base class so cloud-only
 * modules can be imported in Node.js test environment.
 */

class DurableObject {
  constructor(ctx, env) {
    this.ctx = ctx;
    this.env = env;
  }
}

module.exports = { DurableObject };
