/**
 * Public surface of the token sync engine.
 *
 * Re-exports the canonical types, the parser/formatter dispatchers, the
 * config loader, the alias resolver, and the Figma converter. External
 * callers (tools, tests) should import from here rather than reaching into
 * subdirectories.
 */

export type {
  Token,
  TokenDocument,
  TokenSet,
  TokenType,
  TokenValue,
  TokenDiff,
  FigmaMcpExtensions,
  SyncStrategy,
  ConflictResolution,
  ExportFormat,
  ImportFormat,
  TypographyValue,
  ShadowValue,
  GradientValue,
  GradientStop,
  BorderValue,
  TransitionValue,
} from "./types.js";

export { FIGMA_MCP_EXTENSION_KEY } from "./types.js";

export {
  TokensConfigSchema,
  type TokensConfig,
  type OutputTarget,
  type LoadedTokensConfig,
  loadTokensConfig,
  findTokensConfig,
  DEFAULT_TOKENS_CONFIG,
  buildSuggestedScaffold,
  resolveOutputTargets,
  resolveConflictStrategy,
} from "./config.js";

export {
  ExportTokensInputSchema,
  ImportTokensInputSchema,
  ExportFormatSchema,
  ImportFormatSchema,
  SyncStrategySchema,
  ConflictResolutionSchema,
  type ExportTokensInput,
  type ImportTokensInput,
} from "./schemas.js";

export {
  parse,
  detectFormat,
  type ParseInput,
  type ParseResult,
} from "./parsers/index.js";

export {
  format,
  type FormatOptions,
  type FormatResult,
} from "./formatters/index.js";

export {
  buildTokenIndex,
  resolveReference,
  resolveAliasChain,
  validateAliases,
  formatDtcgReference,
  parseDtcgReference,
} from "./alias-resolver.js";

export {
  convertFigmaVariablesToDocument,
  type FigmaVariablesPayload,
  type ConvertOptions,
  type ConvertResult,
} from "./figma-converter.js";
