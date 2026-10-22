# Scorers

> Part of the [TeamAI CLI Usage Guide](../usage-guide.md).

A scorer is a rubric a judge applies to a workflow step's work. It is a Markdown file at `scorers/<name>.md` in the team repo.

`scorers/review-quality.md`:

```markdown
---
labels:
  - value: good
    score: 1
    description: The change does what the step asked, with tests.
  - value: partial
    score: 0.5
    description: The change works but misses part of the request.
  - value: bad
    score: 0
    description: The change does not do what the step asked.
passingScore: 1
samplingRate: 25
---
Judge whether the change does what the step asked. Read the diff and the session.
```

| Field | Meaning |
|---|---|
| `labels` | 2 to 20 `{ value, score, description }`. At least one scores at or above `passingScore`, and one below it. |
| `passingScore` | A label passes when its score is at or above this. |
| `samplingRate`, `model`, `isolation` | Optional. Percent of passes judged, 0 to 100, default 25. The judge's model alias or name, default the tool's. `verified` or `best-effort`. |

The text after the frontmatter is the judge's prompt. `teamai pull` caches valid scorers and warns about the rest. `teamai review --branch` fails on a malformed scorer and on any file in `scorers/` other than `<name>.md`, `<namespace>/<name>.md` and `README.md`.

`scorers/ops/review-quality.md` belongs to the `ops` namespace. Members get it when their role or project lists it:

```yaml
# manifest/roles.yaml
roles:
  - id: ops
    resources: { knowledge: [], skills: [], scorers: [ops] }
```

It replaces a root scorer of the same name. One name in two active namespaces is an error. A team without roles or projects gets every namespace.

A workflow step lists the scorers that judge it, as `scorers: [review-quality]`. [Workflows](workflow.md) shows the full key.

## Judge with any driver

A run settles without waiting for its judge. Any driver then takes the judge work and answers for its own judge:

```console
$ teamai score --next --json '{"driver":{"kind":"t3","machine":"m1","workspace":"/work","can":{"judge":{"isolation":"verified","access":"read","tools":["claude"]}}},"running":[]}'
{"data":{"lease":{"ref":"s5d1e07c2a9b4/a91c0d7e","subject":{"runId":"r3f9…","step":"review","pass":1},
  "prompt":"…/prompt.md","answer":{"schema":{…}},"submit":"teamai score --lease s5d1e07c2a9b4/a91c0d7e --submit --stdin"}}}
$ teamai score --lease s5d1e07c2a9b4/a91c0d7e --submit --stdin <<'JSON'
{"driver":{"kind":"t3","machine":"m1","workspace":"/work"},"outcome":"success",
 "answer":{"label":"good","reasoning":"…"},"judge":{"tool":"claude"}}
JSON
{"data":{"label":{"scorer":"review-quality","label":"good","score":1,"passed":true,…},"published":true}}
```

`can.judge.access` says what your judge can do: `answer` (no tools), `read` (reads the evidence) or `full` (any tool, the default). Its labels record it. A label the scorer does not list is refused, and the lease stays open. `workflow next` never hands out judge work. `teamai score --help` has every field.

Where labels go:

| Path | What |
|---|---|
| `<dataHome>/scores/labels.jsonl` | Every label on this machine. |
| `<dataHome>/scores/reasoning/` | The judge's reasoning, one file per label. Never published. |
| `scores/<member>/<YYYY-MM>.jsonl` on `teamai-reports` | Published labels, the newest per scorer, rubric, pass and judge kind. Labels wait in `<dataHome>/scores/pending/` until a push lands, and stay there while usage reporting is off. |

Workflow Runs shows each pass's labels, and what judging cost apart from the run's own tokens. For a run on this machine that counts every judge attempt; for a run a member published, only the labelled ones.

`score --next` prepares `evidence.json`, `prompt.md`, `diff.patch` when a range was recorded, `repo/`, `transcripts/`, and `outputs.json`. The repository contains tracked files at the judged commit, with symlink targets stored as text. Transcripts include readable subagents and are redacted. Missing evidence is listed as gap codes. Evidence is removed when the lease settles or lapses.

## Judge locally

```sh
teamai score --lease "$REF" --json '{"driver":{"kind":"t3","machine":"m1","workspace":"/work"}}'
```

This runs the tool the lease names and records the label through the same submit path as any driver. A failed run leaves the lease open.

Claude uses a restricted read profile. Codex runs with a temporary home whose permission profile lets its shell read only the evidence, with no network and no writes. OpenCode runs standalone with isolated settings, database and data dirs, no project config, and denied command, edit, web, and external-directory permissions; its judge session and child sessions are deleted after reading. CodeBuddy runs with read-only tools, no MCP and no saved session; it has no restricted mode, so it stays `best-effort`, and a CodeBuddy that is not signed in fails `judge_tool_unavailable`. Labels record `access: read` for Claude, Codex and OpenCode, and `access: full` for CodeBuddy, which lists about 70 tools whatever `--tools` says. Prompts travel through stdin or a file. Tool login and supported model-switch settings are retained. A version without a verified profile is marked `best-effort`; it cannot serve a scorer that requires `verified`.

For a scorer's model alias, the first declared tool that resolves it wins. A member's local default or active model switch uses the tool default. An unmapped or unreadable alias closes the entry with `judge_model_unavailable`, without changing the workflow result. The label records the model the tool reports, or the concrete model requested when none is reported. Failed judge output stays locally under `<dataHome>/scores/raw/`.

Verified versions: Claude Code 2.1.308, codex-cli 0.163.0, and OpenCode v2.1.2. OpenCode is `verified` only when the temp dir it judges in is outside any git or hg checkout, because inside one its file tools may read the whole checkout.
