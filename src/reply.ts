import { UserError } from 'fastmcp';

export type Status = 'succeeded' | 'partial' | 'no_op';

export interface ReplyInput {
  status: Status;
  operation: string;
  summary: string;
  target?: unknown;
  result?: unknown;
  proof?: unknown;
  warnings?: string[];
  recovery?: unknown;
}

/** Plain JSON reply. status is one of succeeded, partial, no_op. */
export function reply(input: ReplyInput): string {
  return JSON.stringify({ target: null, result: null, proof: null, recovery: null, ...input, warnings: input.warnings ?? [] }, null, 2);
}

/** Plain error; the MCP layer reports it as a tool error. Uses fastmcp's UserError so the
 * message reaches the client unwrapped (a plain Error gets a "Tool '<name>' execution
 * failed: " prefix from fastmcp's tool-call handler). */
export function fail(code: string, message: string, hint = 'Correct credentials, permissions, identifiers, or parameters before retrying.'): never {
  throw new UserError(`${code}: ${message} ${hint}`);
}
