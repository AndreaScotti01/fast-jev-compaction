# laya-compaction

A Claude Code plugin that replaces the compaction summary with pruning: every old
tool call and tool result is scored by a [Laya](https://github.com/NandhaKishorM/laya)
server on your network, stale ones are dropped or truncated, and everything kept
stays verbatim. It is built and installed from this folder only; nothing is
published anywhere.

> **Status: the plumbing works, the model does not yet.** The plugin, the
> Docker server, the network setup and the token stats are all built and tested,
> but the open-weight Laya checkpoints tried so far cannot tell a stale tool call
> from a needed one, so with default settings almost nothing gets pruned. See
> [Findings so far](#findings-so-far). Making this useful needs a smarter,
> already-tuned open-weight model.

## What and why

Most context compaction asks an LLM to summarize old turns. A summary is
lossy: a file path, exact error, constraint, or command can disappear even when
it matters later. This plugin never rewrites anything. It only deletes tool
calls and tool results Laya says are no longer needed, and it asks Laya while
showing it the whole conversation. User and assistant text stays verbatim and
in order.

## What you need

- **A GPU machine on your network** running the Laya server in Docker (below):
  Docker Desktop with WSL2 and an NVIDIA driver. Tested on an RTX 5070 Ti.
- **On every machine that runs Claude Code:** Claude Code 2.1.274 or newer with
  function hooks enabled (`CLAUDE_CODE_ENABLE_FUNCTION_HOOKS=1`), and Node.js
  22.13 or newer on PATH (for the build and for the token stats database).

## 1. Run Laya on your network

On the GPU machine, in this folder:

```sh
docker compose up -d --build
docker compose logs -f laya        # first start downloads the ~1 GB model
curl http://localhost:8000/health  # {"status":"ok","loaded":["multilingual"],"device":"cuda",...}
```

The container publishes port 8000 on every interface, so other machines can
reach it at `http://<this machine's address>:8000`.

- **Windows firewall** (PowerShell as administrator), for the private profile only:
  `New-NetFirewallRule -DisplayName "laya-serve" -Direction Inbound -Protocol TCP -LocalPort 8000 -Profile Private -Action Allow`
- **Stable address:** give the machine a DHCP reservation on your router, or use its
  hostname, so the URL you configure does not change.
- **Authentication is off by default.** Anyone on the network can use the GPU and
  the traffic is plain HTTP, so the conversation text (code, paths, command
  output) crosses the network unencrypted. To require a token, copy `.env.example`
  to `.env`, set `LAYA_API_KEY=...`, run `docker compose up -d`, and enter the same
  key in the plugin's "Laya API key" setting.
- Check it from another machine: `curl http://<address>:8000/health`.

## 2. Build and install the plugin locally

Rename this folder first if you want a different name (for example
`laya-compaction`): the install stores the folder's path.

```sh
npm run setup -- http://192.168.1.50:8000
```

That runs `npm ci`, builds `dist/`, adds this folder as a local plugin marketplace
and installs `laya-compaction` from it, with the server URL you gave as its
setting. Without the argument it asks for the URL. Enable function hooks once,
for example in `~/.claude/settings.json`:

```json
{ "env": { "CLAUDE_CODE_ENABLE_FUNCTION_HOOKS": "1" } }
```

Restart Claude Code, then run `/laya-status`. The plugin runs straight from this
folder, so after changing code: `npm run build`, then `/reload-plugins`.

The server address is a required setting: change it any time under `/config` ->
"Laya server URL" (it is checked when you save). To remove the plugin:
`claude plugin uninstall laya-compaction` and `claude plugin marketplace remove laya-compaction`.

## 3. Use it

`/compact` and automatic compaction (at `compactAtPercent` of the context) go
through Laya. The toast reads `kept N/M messages, no summary (...)` when the
pruned history replaced the built-in summary, or `fallback to built-in summary
(...)` when the server is unreachable (requests time out after 30 s), the history
cannot be fitted, or the reduction is below `minReductionRatio`.

| Command | What it does |
| --- | --- |
| `/laya-status` | Checks that the server answers `/health` and shows its models and device |
| `/laya-stats [days\|all]` | Shows how many tokens compaction let through and dropped |

### Token stats

Every compaction (applied, fallen back, or failed) is recorded in a SQLite
database on the machine running Claude Code, at
`~/.claude/plugins/data/laya-compaction/stats.db` (set `LAYA_STATS_DB` to move
it). Each Claude Code machine keeps its own. `/laya-stats` reads it:

```
Laya compaction stats (all time; token counts are estimates)
Compactions: 12 (9 applied, 2 fell back to the built-in summary, 1 failed)
Transcript tokens in applied compactions: 412,300 seen -> 301,120 let through (73%), 111,180 dropped (27%)

Tool calls (kept = let through, dropped = removed or cut from results):
tool  calls  removed  truncated  kept tok  dropped tok  dropped
Read     40       18          6    12,300       30,100      71%
Bash     22        4          9     8,900       11,400      56%
```

Tokens are estimated from text (about 6% low on prose and 18% high on JSON
compared with Laya's own count), not counted by a tokenizer. The database and the
stats need `node` on PATH; without it compaction still works and the stats are
skipped with a log line.

## How it works

1. Every `tool_use` is paired with its `tool_result` by `tool_use_id`. Calls in
   the first message or in the newest `preserveRecentMessages` messages are
   pinned and never touched.
2. The **state** sent to Laya is the whole conversation so far, oldest first,
   with every tool result replaced by a short note (`ok, 4213 chars (omitted)`).
   Tool inputs are included, texts are included, nothing is summarized.
3. The state is fitted into `maxStateTokens` (7000 by default, under Laya's
   8192-token `max_len`) in stages, each applied only if the previous one was not
   enough: tool inputs truncated to 1000, then 200, then 60 characters; long
   texts abridged to head + tail, oldest non-pinned messages first; old
   non-pinned messages collapsed to a `[... N chars omitted ...]` note; old tool
   calls reduced to one line each; old call-less messages left out; runs of old
   call-only messages folded into one entry. If it still does not fit,
   compaction fails and the built-in summary is used.
4. For every non-pinned call Laya gets two `noul` questions: should the **call**
   stay (knowing it was made, with its input, still matters), and should the
   **result** stay verbatim (its contents are still needed and re-running the
   tool would not do).
5. Questions are split into as many requests as needed so state plus questions
   stays under `maxRequestTokens` (8000 by default). The same full state is
   resent with every request; requests run concurrently and their answers are
   merged. Each request asks for `max_len: 8192`, which the `multilingual`
   checkpoint is trained for. The container also serves `typed-decisions`
   (trained at 1,024 tokens); select it with the "Laya model" setting.
6. Decisions per call, against `keepThreshold`:
   - `keepResult >= threshold` -> keep call and result;
   - else `keepCall >= threshold` -> keep the call, truncate the result to its
     first `truncateHeadChars` characters plus a one-line note;
   - else -> remove the call together with its result.
7. The message list is rebuilt: a message that loses all its content is
   removed, untouched messages are returned as the same objects, and no result
   is ever left without its call.

Laya reports the state it actually read; if it had to cut some off
(`usage.truncated`), `/laya-stats` warns you to lower "Maximum Laya state tokens".

## Settings

Set at install time and editable under `/config` (each shows as a row):

| Setting | Default | Description |
| --- | --- | --- |
| Laya server URL (`baseUrl`) | required | `http://<address>:8000` of the machine running `laya-serve` |
| Laya API key (`apiKey`) | none | Bearer token, only if the server sets `LAYA_API_KEY` (or use the env var) |
| Keep threshold (`keepThreshold`) | `0.5` | Minimum keep probability for a call or result to stay |
| Recent messages to preserve | `6` | Newest messages never touched (the first is always kept) |
| Compaction percentage (`compactAtPercent`) | `60` | Context percentage that triggers auto-compaction |
| Minimum reduction ratio | `0.25` | Below this estimated reduction the built-in summary is used |
| Maximum Laya state tokens | `7000` | Estimated token ceiling for the state |
| Maximum Laya request tokens | `8000` | Estimated ceiling for state plus one batch of questions |
| Truncated tool result head | `300` | Characters of a dropped tool result retained before its note |
| Laya model (`model`) | `multilingual` | Checkpoint to ask |

## Findings so far

This design was built around a classifier that had been trained to answer
"should this tool call or result stay?" over a whole conversation. Laya's open
checkpoints were not, and testing them against a running server showed it.

**What was tested.** Laya `multilingual` and `typed-decisions`, served on an
RTX 5070 Ti, asked about a small 6-call coding transcript in which one file read
was clearly irrelevant, one test output was clearly superseded, and the rest were
needed. The tests were spot checks on one hand-built transcript, not a
benchmark.

| Approach | Result |
| --- | --- |
| Two `noul` questions per call over the whole conversation (what the plugin does now), four different wordings, both checkpoints | Every call scored about the same: 0.85-0.95 on `multilingual`, 0.50-0.55 on `typed-decisions`. Even an inverted "is this obsolete and can be deleted?" wording answered high for everything, so nothing falls below the 0.5 keep threshold and nothing is dropped. |
| `noul`, `choice` and `score` questions over a per-call state that includes the real tool output | `typed-decisions`: still flat on every question type. `multilingual` with a keep/drop `choice` question: 5 of 6 calls came out as expected, but the margins are small (0.57 for "drop") and six calls prove nothing. |

**Why.** Laya's own documentation says the base checkpoints score near chance
(about 0.36) on decision types they were not fine-tuned for, and that it is "a
fast base to specialise, not a zero-shot decision engine". `typed-decisions` is
tuned for four workflows (invoices, security incidents, customer service,
agent-trace observability); the closest, agent-trace, judges a whole agent run
for outcome and risk, not individual tool calls. It is also trained at 1,024
tokens and English only. No published checkpoint is tuned for keeping or
dropping tool calls.

**A design flaw that is separate from the model.** The state sent to Laya replaces
every tool result with `ok, N chars (omitted)`, so the model never sees what a
result contains (for example a "do not touch" comment in a file). That was
reasonable for a model that judged from the flow of the conversation, but it
starves a general-purpose classifier.

**What would make this work.** Any one of these, roughly in order of effort:

1. **A smarter open-weight model that is already tuned enough.** Something that
   judges relevance of a tool output to the current request without further
   training, such as a local instruct model used as a yes/no judge (reading the
   probability of "yes"), or a long-context reranker or NLI model scoring each
   result against the latest request. Nothing tested here qualifies yet.
2. **Rules next to the model.** For coding sessions many drops are mechanical:
   a file read superseded by a later edit or read of the same file, a failing test
   run superseded by a later run, a very large old output. This needs no model.
3. **Fine-tuning Laya** on labelled keep-or-drop tool calls, using the notebook in
   its repository. This needs a labelled dataset that does not exist yet.
4. **Re-designing the request** to ask one `choice` question per call over a small
   state that includes the tool output (Laya's batch endpoint takes up to 64
   states), and validating it on many real transcripts before trusting it.

Until one of these is done, treat the token stats as a way to watch what the
plugin does, not as evidence that it is saving context.

## Limitations

- Only tool calls and results are candidates; text messages are never removed
  or shortened in the output (they are only abridged in the state Laya sees).
- With the checkpoints tested so far the keep probabilities do not discriminate
  (see above), so `keepThreshold` cannot be tuned into something useful.
- A probability is not a proof that a result is safe to delete. The assistant
  can always re-run the tool.
- The full state is repeated with every request, so long sessions cost several
  requests each.
- Token counts in `/laya-stats` are estimates, not tokenizer counts.
- The conversation text is sent over plain HTTP to the machine running Laya.
- Function hooks are an early-access Claude Code feature and may change.

## Development

```sh
npm ci
npm run typecheck   # library code + hook
npm test
npm run build       # dist/, including the stats helper the hook runs with node
```

The unit tests use a fake Laya and an in-memory SQLite database; nothing
touches the network. See [`hooks/README.md`](hooks/README.md) for how the hook
is wired.
