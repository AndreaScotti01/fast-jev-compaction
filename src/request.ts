import type { LayaAnswer, LayaQuestions, LayaResponse, LayaState } from './types.js';

const SYSTEMONE_PATH = '/v1/systemone';

/**
 * Normalizes a user-typed server address to `scheme://host[:port]`: trims it,
 * drops trailing slashes and a pasted `/v1/systemone`. Throws when it is not
 * an http(s) URL.
 */
export function layaServerUrl(input: string): string {
  if (input.trim() === '') {
    throw new Error('no Laya server URL configured; set it under /config → Laya server URL');
  }
  const trimmed = input.trim().replace(/\/+$/, '').replace(/\/v1\/systemone$/, '');
  let url: URL;
  try {
    url = new URL(trimmed);
  } catch {
    throw new Error(`"${input}" is not a URL; expected e.g. http://192.168.1.50:8000`);
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new Error(`"${input}" must start with http:// or https://`);
  }
  if (url.pathname !== '/' || url.search || url.hash) {
    throw new Error(`"${input}" must be just the server address, without a path`);
  }
  return url.origin;
}

/** The 322M multilingual checkpoint is trained for up to 8192 tokens; typed-decisions for 1024. */
export const DEFAULT_MODEL = 'multilingual';
/** Laya reads 1024 tokens of state unless `max_len` asks for more; the server caps it at 8192. */
export const DEFAULT_MAX_LEN = 8192;

export interface LayaRequest {
  url: string;
  method: 'POST';
  headers: Record<string, string>;
  body: string;
}

/** The HTTP request for one `laya-serve` call, for any fetch-like transport. */
export function buildLayaRequest(
  params: {
    apiKey?: string;
    model?: string;
    baseUrl: string;
  },
  state: LayaState,
  questions: LayaQuestions,
): LayaRequest {
  return {
    url: `${layaServerUrl(params.baseUrl)}${SYSTEMONE_PATH}`,
    method: 'POST',
    headers: {
      ...(params.apiKey ? { authorization: `Bearer ${params.apiKey}` } : {}),
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      model: params.model ?? DEFAULT_MODEL,
      max_len: DEFAULT_MAX_LEN,
      state,
      questions,
    }),
  };
}

/** Validates a Laya response body; throws on anything but an `answers` object. */
export function parseLayaResponse(
  status: number,
  ok: boolean,
  text: string,
): LayaResponse {
  if (!ok) {
    throw new Error(`Laya request failed (${status}): ${text.slice(0, 200)}`);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new Error('Laya returned malformed JSON');
  }
  if (
    parsed === null ||
    typeof parsed !== 'object' ||
    !('answers' in parsed) ||
    parsed.answers === null ||
    typeof parsed.answers !== 'object'
  ) {
    throw new Error('Laya response is missing answers');
  }
  return parsed as LayaResponse;
}

/** The `noul` probability of one answer; throws when it is not there. */
export function noulAnswer(
  answers: Record<string, LayaAnswer>,
  name: string,
): number {
  const answer = answers[name];
  if (
    !answer ||
    !('noul' in answer) ||
    typeof answer.noul !== 'number' ||
    !Number.isFinite(answer.noul)
  ) {
    throw new Error(`Invalid Laya answer for ${name}`);
  }
  return answer.noul;
}
