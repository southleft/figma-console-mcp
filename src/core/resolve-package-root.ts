/**
 * Resolve the package root directory.
 *
 * Uses import.meta.url (ESM) to compute an absolute path to the package root,
 * independent of process.cwd(). This file is ESM-only; in CJS test contexts
 * (Jest/ts-jest), it is replaced via moduleNameMapper — see jest.config.cjs.
 */
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';

// dist/core/resolve-package-root.js → ../../ = package root
export const PACKAGE_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
