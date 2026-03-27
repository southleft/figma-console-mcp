/**
 * CJS mock for src/core/resolve-package-root.ts (Jest).
 *
 * The real module uses import.meta.url (ESM-only). In CJS test
 * context, __dirname is available and resolves correctly.
 */
const { join } = require('path');

// tests/__mocks__/ → ../../ = package root
module.exports = { PACKAGE_ROOT: join(__dirname, '..', '..') };
