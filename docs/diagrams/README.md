# Diagrams

The Markdown docs use **Mermaid** diagrams, which GitHub renders automatically. The files here are
**Eraser diagram-as-code** versions with product icons (OpenAI, Postgres, Inngest, ...), for
presentations or a richer README image.

| File                                               | Eraser diagram type | Shows                                                                                                   |
| -------------------------------------------------- | ------------------- | ------------------------------------------------------------------------------------------------------- |
| [`architecture.eraser`](architecture.eraser)       | Cloud Architecture  | The whole system: client, API layers, Inngest, data stores, OpenAI and external services                |
| [`chat-flow.eraser`](chat-flow.eraser)             | Sequence            | One chat request: history, query rewrite, Pinecone + Mem0 retrieval, streaming, web search, persistence |
| [`source-pipeline.eraser`](source-pipeline.eraser) | Sequence            | Adding a source and the `process-source` job (extract → chunk → embed → index)                          |
| [`background-jobs.eraser`](background-jobs.eraser) | Flow Chart          | Which service sends which Inngest event, which function runs, what cancels what                         |
| [`database-er.eraser`](database-er.eraser)         | Entity Relationship | All Postgres tables, columns and relations                                                              |

## Rendering a diagram

1. Open [app.eraser.io](https://app.eraser.io) and create a file.
2. Add a **diagram** of the type in the table above (the type matters: the syntax differs per type).
3. Paste the file's contents into the code panel. The diagram renders on the right.
4. If an icon doesn't appear, pick a replacement from Eraser's icon list (type `icon:` in the editor
   for suggestions) and keep the rest of the line.
5. Export as PNG or SVG into `docs/images/` (for example `docs/images/architecture.png`).

To show an exported image in the README, add:

```markdown
![Architecture](docs/images/architecture.png)
```

Keep the `.eraser` file as the source of truth and re-export the image when it changes.
