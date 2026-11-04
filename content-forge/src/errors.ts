import { formatProblem, type Problem } from './catalog.ts';

export type ForgeErrorCode = 'catalog_invalid' | 'bad_request' | 'refused';

/** A failure of this folder's own checks, with every problem that caused it. */
export class ForgeError extends Error {
  readonly code: ForgeErrorCode;
  readonly problems: readonly Problem[];
  constructor(code: ForgeErrorCode, message: string, problems: readonly Problem[] = []) {
    super(problems.length === 0 ? message : `${message}:\n  - ${problems.map(formatProblem).join('\n  - ')}`);
    this.name = 'ForgeError';
    this.code = code;
    this.problems = problems;
  }
}
