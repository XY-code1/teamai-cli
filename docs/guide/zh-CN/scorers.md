# 评分器

> 本文是 [TeamAI CLI 使用指南](../../usage-guide.zh-CN.md) 的一部分。

评分器（scorer）是评审者用来评判工作流步骤成果的评分标准。它是团队仓库里的 Markdown 文件 `scorers/<name>.md`。

`scorers/review-quality.md`：

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

| 字段 | 含义 |
|---|---|
| `labels` | 2 到 20 个 `{ value, score, description }`。至少一个分数不低于 `passingScore`，至少一个低于它。 |
| `passingScore` | 标签分数不低于它即为通过。 |
| `samplingRate`、`model`、`isolation` | 可选。被评判的步骤执行比例，0 到 100，默认 25。评审者使用的模型别名或模型名，默认用工具自己的模型。`verified` 或 `best-effort`。 |

frontmatter 之后的文本是评审者的提示词。`teamai pull` 缓存有效的评分器，并对其余文件给出警告。`teamai review --branch` 遇到格式错误的评分器，或 `scorers/` 里除 `<name>.md`、`<namespace>/<name>.md` 和 `README.md` 以外的文件时会失败。

`scorers/ops/review-quality.md` 属于 `ops` 命名空间。成员的角色或项目列出它时才会拿到：

```yaml
# manifest/roles.yaml
roles:
  - id: ops
    resources: { knowledge: [], skills: [], scorers: [ops] }
```

它会替换根目录下同名的评分器。同一个名字出现在两个生效的命名空间里会报错。没有角色也没有项目的团队会拿到所有命名空间。

工作流步骤用 `scorers: [review-quality]` 列出评判它的评分器。完整写法见[工作流](workflow.md)。

## 任意驱动评审

运行结束时不等待评审。之后任意驱动都可以领取评审任务，并提交它自己的评审结果：

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

`can.judge.access` 说明你的评审能做什么：`answer`（不用工具）、`read`（读取证据）或 `full`（任意工具，默认值）。它的标签会记录该值。评分器未列出的标签会被拒绝，租约保持打开。`workflow next` 从不分发评审任务。所有字段见 `teamai score --help`。

标签存放位置：

| 路径 | 内容 |
|---|---|
| `<dataHome>/scores/labels.jsonl` | 本机的所有标签。 |
| `<dataHome>/scores/reasoning/` | 评审者的理由，每个标签一个文件。从不发布。 |
| `teamai-reports` 上的 `scores/<member>/<YYYY-MM>.jsonl` | 已发布的标签，每个评分器、评分标准、执行轮次和评审类型只保留最新一条。推送成功前标签留在 `<dataHome>/scores/pending/`；关闭用量上报时一直留在那里。 |

工作流运行页面显示每一轮的标签，以及评审开销，与运行本身的 token 分开统计。本机的运行统计每一次评审尝试；成员发布的运行只统计产生了标签的评审。
