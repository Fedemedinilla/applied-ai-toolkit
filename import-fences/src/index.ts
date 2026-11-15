export { check, matchesSpecifier, type CheckResult, type RuleId, type Violation } from './check.ts';
export {
  CONFIG_SCHEMA_URL,
  ConfigError,
  configJsonSchema,
  defineConfig,
  loadConfig,
  NODE_BUILTINS,
  parseConfig,
  type FencesConfig,
  type FencesConfigInput,
} from './config.ts';
export { isTypeOnlyDeclaration, moduleRefs, namesOf, parse, reexports, stringsContaining, type ModuleRef, type RefKind } from './extract.ts';
export { DEFAULT_IGNORE, diskSource, memorySource, type FileSource } from './files.ts';
export { globMatcher, globToRegExp } from './glob.ts';
export { formatText } from './report.ts';
export { FINGERPRINT_KEY, toSarif, type SarifLog, type SarifOptions, type SarifResult } from './sarif.ts';
