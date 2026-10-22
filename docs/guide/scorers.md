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
