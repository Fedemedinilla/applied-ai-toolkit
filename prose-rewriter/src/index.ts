/**
 * The public entry of prose-rewriter. Phase F0 publishes the contract only; rewrite() itself
 * comes in F5, once the pure core (F4) and the stages through the gateway exist.
 */
export {
  Change,
  defaultMode,
  DiffHunk,
  Edit,
  FactReport,
  Flag,
  Genre,
  GENRES,
  Lang,
  Mode,
  Register,
  RewriteInput,
  RewriteResult,
  STAGES,
  Variety,
} from './types.ts';
