# Diagrams

Every diagram in the docs exists in two forms:

- **Mermaid** inside the Markdown, which github.com renders automatically.
- **An exported PNG** in [`docs/images/`](../images/), made from the **Eraser** files in this folder.
  Each Mermaid diagram has a collapsed _"View it as an image"_ section under it showing the PNG,
  for places that don't render Mermaid, such as the GitHub mobile app.

## Files

| Eraser file                                                        | Eraser diagram type | Export as                      | Used in                                             |
| ------------------------------------------------------------------ | ------------------- | ------------------------------ | --------------------------------------------------- |
| [`how-it-works.eraser`](how-it-works.eraser)                       | Flow Chart          | `how-it-works.png`             | README → How it works                               |
| [`architecture.eraser`](architecture.eraser)                       | Cloud Architecture  | `architecture.png`             | README → Architecture; ARCHITECTURE §2              |
| [`genai-core-architecture.eraser`](genai-core-architecture.eraser) | Flow Chart          | `gen-ai-core-architecture.png` | README → GenAI Core Architecture; ARCHITECTURE §2.1 |
| [`layered-design.eraser`](layered-design.eraser)                   | Flow Chart          | `layered-design.png`           | ARCHITECTURE §5                                     |
| [`request-lifecycle.eraser`](request-lifecycle.eraser)             | Flow Chart          | `request-lifecycle.png`        | ARCHITECTURE §6                                     |
| [`auth-flow.eraser`](auth-flow.eraser)                             | Sequence            | `auth-flow.png`                | ARCHITECTURE §7                                     |
| [`source-pipeline.eraser`](source-pipeline.eraser)                 | Sequence            | `source-pipeline.png`          | ARCHITECTURE §8.2                                   |
| [`chat-flow.eraser`](chat-flow.eraser)                             | Sequence            | `chat-flow.png`                | ARCHITECTURE §8.3                                   |
| [`conversation-summary.eraser`](conversation-summary.eraser)       | Flow Chart          | `conversation-summary.png`     | ARCHITECTURE §8.4                                   |
| [`artifact-generation.eraser`](artifact-generation.eraser)         | Sequence            | `artifact-generation.png`      | ARCHITECTURE §8.6                                   |
| [`background-jobs.eraser`](background-jobs.eraser)                 | Flow Chart          | `background-jobs.png`          | ARCHITECTURE §9                                     |
| [`dev-orchestration.eraser`](dev-orchestration.eraser)             | Flow Chart          | `dev-orchestration.png`        | ARCHITECTURE §15                                    |
| [`db-overview.eraser`](db-overview.eraser)                         | Flow Chart          | `db-overview.png`              | DATABASE §1                                         |
| [`database-er.eraser`](database-er.eraser)                         | Entity Relationship | `database-er.png`              | DATABASE §2                                         |
| [`db-cascade.eraser`](db-cascade.eraser)                           | Flow Chart          | `db-cascade.png`               | DATABASE §4                                         |
| [`source-lifecycle.eraser`](source-lifecycle.eraser)               | Flow Chart          | `source-lifecycle.png`         | DATABASE §6                                         |
| [`artifact-lifecycle.eraser`](artifact-lifecycle.eraser)           | Flow Chart          | `artifact-lifecycle.png`       | DATABASE §6                                         |
| [`external-stores.eraser`](external-stores.eraser)                 | Cloud Architecture  | `external-stores.png`          | DATABASE §8                                         |

## Rendering and exporting

1. Open [app.eraser.io](https://app.eraser.io), open (or create) a file and switch to **Canvas**.
2. Insert a **Diagram**, choose the **diagram type** from the table (each type has its own syntax),
   and paste the file's contents into its code editor.
3. If an icon doesn't appear, pick a replacement from Eraser's suggestions (type `icon:`).
4. Select the diagram → **Export** → **PNG**, with a **solid white background**, **2x** scale and the light theme.
5. Save it into `docs/images/` with the exact name from the **Export as** column.

## Changing a diagram

Update both forms so they stay in sync:

1. Edit the Mermaid block in the Markdown file.
2. Edit the matching `.eraser` file, re-render it in Eraser, and overwrite the PNG in `docs/images/`.
