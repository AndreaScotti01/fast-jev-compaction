export type Role = 'user' | 'assistant';

/**
 * A tool_use block of an assistant message. `text` and `isError` mirror the
 * outcome once the transcript holds it (Claude Code attaches them).
 */
export interface ToolUse {
  tool_use_id: string;
  tool: string;
  input: Record<string, unknown>;
  text?: string;
  isError?: boolean;
}

/** A tool_result block of a user message. */
export interface ToolResult {
  tool_use_id: string;
  text: string;
  isError?: boolean;
}

/**
 * One transcript message. The shape is a subset of Claude Code's
 * `SessionMessage`, so a session transcript can be passed in as is.
 */
export interface Message {
  role: Role;
  text: string;
  toolUses: ToolUse[];
  toolResults?: ToolResult[];
}

/** A tool call paired with its result by `tool_use_id`. */
export interface ToolCall {
  /** Short id used in the Laya state and question names (`t1`, `t2`, ...). */
  id: string;
  tool_use_id: string;
  tool: string;
  input: Record<string, unknown>;
  /** Index of the message holding the tool_use block. */
  callIndex: number;
  /** Index of the message holding the tool_result block. */
  resultIndex: number;
  resultChars: number;
  /** Estimated tokens of the serialised input and of the result text. */
  inputTokens: number;
  resultTokens: number;
  isError: boolean;
  /** In the first or the newest preserved messages; never a candidate. */
  pinned: boolean;
}

export interface CallAnswer {
  /** Laya's probability that the call itself still matters. */
  keepCall: number;
  /** Laya's probability that the full result still needs to stay verbatim. */
  keepResult: number;
}

export type CallAction = 'keep' | 'drop_result' | 'drop_call';

export interface CallDecision extends CallAnswer {
  id: string;
  tool: string;
  action: CallAction;
  reason: 'pinned' | 'kept' | 'result_dropped' | 'call_dropped';
}

/** A decision with the estimated tokens of this call that stay in and leave the transcript. */
export interface CountedDecision extends CallDecision {
  tokensKept: number;
  tokensDropped: number;
}

export interface HistoryToolCall {
  id: string;
  tool: string;
  input: string;
  result: string;
}

export interface HistoryEntry {
  i: number;
  role: Role;
  text: string;
  /** Structured per call, or one compact line per call once the state has to shrink. */
  tool_calls?: HistoryToolCall[] | string[];
}

/** The state sent with every Laya request: the whole history, results omitted. */
export interface CompactionState {
  context: string;
  goal: string;
  history: HistoryEntry[];
}

export interface FittedState {
  state: CompactionState;
  tokens: number;
  /** Which fitting stage produced the state, for diagnostics. */
  stage: string;
}

export interface CompactOptions {
  /** Ongoing task description; defaults to the last few user prompts. */
  goal?: string;
  /** Minimum keep probability for a call or result to stay. Default 0.5. */
  keepThreshold?: number;
  /** Newest messages never touched (the first message is always kept). Default 6. */
  preserveRecentMessages?: number;
  /** Estimated token ceiling for the state. Default 7000. */
  maxStateTokens?: number;
  /** Estimated token ceiling for state plus one batch of questions. Default 8000. */
  maxRequestTokens?: number;
  /** Characters of a dropped tool result to retain. Default 300. */
  truncateHeadChars?: number;
}

export interface ResolvedCompactOptions {
  goal: string;
  keepThreshold: number;
  preserveRecentMessages: number;
  maxStateTokens: number;
  maxRequestTokens: number;
  truncateHeadChars: number;
}

export interface CompactResult {
  /** The compacted transcript; untouched messages are the input objects. */
  messages: Message[];
  decisions: CountedDecision[];
  stats: {
    messagesBefore: number;
    messagesAfter: number;
    charsBefore: number;
    charsAfter: number;
    /** Estimated tokens of the whole transcript (text, tool inputs, tool results). */
    tokensBefore: number;
    tokensAfter: number;
    /** Largest state Laya reported reading, 0 when it reported none. */
    layaStateTokens: number;
    /** Laya cut off part of the state (it was over `max_len`). */
    stateTruncated: boolean;
    calls: number;
    kept: number;
    resultsDropped: number;
    callsDropped: number;
    pinned: number;
    stateTokens: number;
    /** Which fitting stage the state needed, '' when no request was made. */
    stateStage: string;
    requests: number;
    ms: number;
  };
}

/** The `state` of a Laya request: a string or any JSON-serialisable object. */
export type LayaState = string | object;

export interface NoulQuestion {
  type: 'noul';
  instructions: string;
  criteria?: {
    true?: string;
    false?: string;
  };
}

export interface ChoiceQuestion {
  type: 'choice';
  instructions: string;
  criteria: Record<string, string | null>;
}

export interface ScoreQuestion {
  type: 'score';
  instructions: string;
  criteria: string[];
}

export type LayaQuestion = NoulQuestion | ChoiceQuestion | ScoreQuestion;
export type LayaQuestions = Record<string, LayaQuestion>;

export interface NoulAnswer {
  type?: 'noul';
  noul: number;
}

export interface ChoiceAnswer {
  type?: 'choice';
  choice: string;
  confidence: number;
  probabilities: Record<string, number>;
}

export interface ScoreAnswer {
  type?: 'score';
  score: number;
  confidence: number;
  probabilities: Record<string, number>;
}

export type LayaAnswer = NoulAnswer | ChoiceAnswer | ScoreAnswer;

export interface LayaResponse {
  model?: string;
  answers: Record<string, LayaAnswer>;
  usage?: {
    input_tokens?: number;
    output_tokens?: number;
    state_tokens?: number;
    truncated?: boolean;
  };
  [key: string]: unknown;
}

/** Anything that can answer Laya questions: the hook's `$.http.fetch` adapter, or a test double. */
export interface LayaAsker {
  ask(state: LayaState, questions: LayaQuestions): Promise<LayaResponse>;
}
