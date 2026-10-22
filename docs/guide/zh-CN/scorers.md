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
