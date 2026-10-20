/**
 * A tool definition, independent of any agent framework.
 *
 * The enforcement layer must not depend on the LLM SDK. The PayPal toolkit
 * happens to ship its tools in this shape, and whatever agent framework is
 * driving the session is adapted to it at the edge — not the other way round.
 *
 * `parameters` is left as `unknown` on purpose: this layer never reads it, it
 * only carries it. The adapter that speaks to a particular SDK decides what it
 * has to be.
 */

export interface ToolExecOptions {
  toolCallId: string
  messages: unknown[]
  abortSignal?: AbortSignal
}

export interface ToolLike {
  description?: string
  parameters: unknown
  execute?: (args: unknown, options: ToolExecOptions) => PromiseLike<unknown>
}

export type ToolSet = Record<string, ToolLike>
