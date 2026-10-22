# jev-harness

Judgment gates for Claude Code, built on Jev, TypeSafe's decision model that answers a structured question about the current state with a typed, probability-scored answer. The gates sit beside the agent: deterministic rules first, Jev only where a rule cannot decide, and everything recorded before anything is enforced.

**Everything is off by default.** Installing the plugin and having a key sends nothing anywhere.

## Gates in 0.0.1

| Gate | Hook | What it does | What leaves the machine |
| --- | --- | --- | --- |
| Stop gate | `classic.Stop`, after your own Stop hooks | Catches a turn that ends by announcing work it has not done ("이어서 리팩터링하겠습니다", "Next, I will…") | The turn's last paragraph, scrubbed, to TypeSafe |
| Tool gate | `tool.call`, every tool | Finds tool calls that touch secret files or print secrets; refuses them when the session is served by a provider other than Anthropic. Refuses writes to this plugin's files and to Claude settings | Nothing |

Each gate is `off`, `shadow` (record what it would do) or `active` (do it), set per gate.

### Stop gate

1. Your settings Stop hooks run first; if one of them blocks, that stands.
2. Not judged: re-entry (`stop_hook_active`), plan mode, background or scheduled work, subagents, a last sentence that is a question, and a last sentence with a condition ("알려주시면 처리하겠습니다", "결과가 나오면…", "once the checks pass…").
3. A rule looks for an announcing ending; Jev is asked a two-way choice, `announce` or `report`.
4. In `shadow` the turn ends at once and the judgment is recorded afterwards. In `active`, a probability of `announce` at or above `stopThreshold` (0.7) sends the model back: *"Your last paragraph announces work you have not done yet. If you can do it now, do it. If you are waiting for the person, say plainly what you need from them."*

The paragraph is scrubbed before it is sent: secret-shaped strings, `NAME=value` secrets, email addresses and your home folder are removed.

### Tool gate

- **Provider trust.** A session counts as first-party only when every sign agrees: an Anthropic credential, no `HTTPS_PROXY`/`HTTP_PROXY`, no `NODE_EXTRA_CA_CERTS`, no Bedrock/Vertex/Foundry, and an `ANTHROPIC_BASE_URL` that is empty or `https://*.anthropic.com`. A local proxy counts as external unless listed in `trustedProxies`. `providerTrust: external` forces external; nothing forces first-party.
- **Secret files.** `.env` and `.env.*` (not `.example`, `.sample`, `.template`, `.tpl`, `.dist`), `*.env`, `~/.ssh` (not `*.pub`, `known_hosts`), `~/.aws`, `~/.gnupg`, gcloud, `~/.kube/config`, `~/.docker/config.json`, `~/.config/gh/hosts.yml`, Codex and Claude credential files, `.netrc`, `.npmrc`, `.pypirc`, `.pgpass`, `.git-credentials`, `*.pem`, `*.p12`, `*.pfx`, `*.kdbx`, `id_rsa` and kin. Paths are resolved through `~`, `$HOME`, `..` and symlinks and compared without case.
- **Shell.** Every argument of a Bash command is checked, including git pathspecs (`git show :.env`), `--opt=path` and redirects. Commands that print the environment or a stored secret (`env`, `printenv`, `export -p`, `security … -w`, `gh auth token`) count too.
- **Active and external:** refused, with the path, or the link and what it leads to. **First-party:** allowed and recorded. **Writes** to the plugin's folder, its logs or `.claude*/settings*.json` are refused in active mode whatever the provider, so an agent cannot switch the gates off.
- A guard that breaks in active mode refuses the call instead of letting it through.

## Install and enable

```text
/plugin install jev-harness --marketplace ysys143/jev-harness
```

Then turn on the gates you want, in `/config` under jev-harness or in `settings.json`:

```json
{ "pluginConfigs": { "jev-harness@jev-harness": { "options": { "stopGate": "shadow", "toolGate": "shadow" } } } }
```

The Stop gate needs a TypeSafe key, read from the first of: the plugin's `apiKey` setting (kept in secure storage), a `TYPESAFE_API_KEY=` line in a `.env` in the plugin's folder, or the `TYPESAFE_API_KEY` environment variable. Without one the status line says `jev: no key` and nothing is sent.

## Records, labels and when to turn a gate on

Every judged event is one JSON file under `~/.local/state/jev-harness/<session>/<gate>/`, in a folder only you can open (700), kept 14 days. A record holds the rule's verdict, exactly what was sent (scrubbed), Jev's probability, tokens, latencies, and any failure as a kind or status code, never a response body or a key.

- `/jev-report`: per gate, records, skips by reason, coverage, failures by kind, hook and Jev latency (p50/p95), tokens per call, the rule-versus-Jev table with Cohen's kappa, the latest unlabeled disagreements, and, once you have labeled some, precision and recall at several thresholds.
- `/jev-mark <id> y|n`: label a record yourself (y: the turn did stop on an announcement).

Suggested before switching the Stop gate to `active`: at least 50 positive and 100 negative labels, and a threshold with precision of 0.9 or more on them. Agreement with the rule alone is not evidence: in replayed transcripts the rule flags about 5% of turn ends, so a gate that always says "no" agrees about 95% of the time.

`scripts/replay.ts` (run with `bun`) replays past transcripts through the rule offline, and with `--jev N` sends up to N scrubbed paragraphs to Jev; it writes JSONL under `~/.local/state/jev-harness/replay/`.

## Measured

**Jev API** (`jev-1.14.0`, 2026-10-22, 61 calls):

| Question | p50 | p95 | Tokens in / out |
| --- | --- | --- | --- |
| noul | 217 ms | 448 ms | 366 / 20 |
| choice (2 options) | 206 ms | 339 ms | 373 / 31 |
| score (4 levels) | 312 ms | 363 ms | 356 / 17 |
| 12 noul questions in one request | 184 ms (n=1) | | 1132 / 210 |

`noul` returns a number in [0, 1], not a boolean.

**Why the Stop gate asks a choice, not a noul** (10 repeats each):

| Last paragraph | noul | choice: P(announce) |
| --- | --- | --- |
| "I updated the parser… Next I will refactor the cache layer." | 0.45-0.55 | 0.98-0.99 |
| "…all 24 tests pass… nothing else is pending." | 0.01-0.02 | 0.01 |
| "…이어서 캐시 계층을 리팩터링하겠습니다." | 0.54-0.63 | 0.98-0.99 |
| "…캐시 계층도 리팩터링할까요?" | 0.06-0.08 | 0.02-0.03 |

**The rule, replayed offline** over the 3,000 most recent turn ends of the author's Claude Code transcripts:

- Before conditional endings were excluded, the rule flagged 12.4% of judged turn ends, mostly ones that wait on the person or on running work ("알려주시면 처리하겠습니다", "결과가 나오면 말씀드리겠습니다"). With them excluded: 1,205 skipped (conditional 898, question 297, empty 10), and 91 of the remaining 1,795 (5.1%) flagged.
- A short nudge from the person right after a turn end ("계속", "go") followed 1.3% of them, mostly API errors and empty turns, and none of the turns the rule flagged. Nudges are not a usable label for this gate; labels have to come from `/jev-mark`.

**Tool gate, live** (Claude Code 2.1.306, Haiku 5.5, `providerTrust: external`, `toolGate: active`, a folder of fake secrets):

| Call | Result |
| --- | --- |
| Read `.env` | refused (env file) |
| Read `notes.txt`, a symlink to `fake.pem` | refused (key material) |
| Bash `git diff --no-index /dev/null .ENV` | refused (env file) |
| Bash `printenv` | refused |
| Read `README.md`, Bash `ls` | allowed |

The guard held each call for 2-4 ms. With the author's global instructions loaded, the model declined to try the first, third and fourth calls on its own.

**Tests:** 38 (`claude plugin test`), including a shadow Stop hook returning while its Jev call is still pending, a Jev call that never answers, the cap and the circuit breaker, key precedence, symlinks, and a guard that breaks.

## Not yet

- 0.0.2: Jev for the tool gate, for external sessions only (`choice` open / standard / restricted / custom).
- 0.0.3: conditional instructions: instruction fragments attached to a turn only when Jev judges them relevant.
- The Stop gate has not yet been measured live against Jev or run in active mode over a series of turns.

## License

MIT
