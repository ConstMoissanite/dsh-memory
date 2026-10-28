# dsh-memory

Durable, local memory for DSH agents. Markdown files are the source of truth; a
SQLite FTS5 database is a derived index. Global entries are injected in full;
workspace and session entries are injected as retrieval hints. Edits made
outside the plugin are quarantined and surfaced in a composer warning bar.

## Storage

```text
$DSH_HOME/memory/
  MEMORY.md
  index.db
  config.json
  workspaces/<sha1(workspace_dir)>/
    MEMORY.md
    <session_id>/
      MEMORY.md
```

`workspace_dir` is the session's initial working directory (`session.header.cwd`),
so a later `cd` does not move the workspace's shared memory. Session memory is
nested below the workspace and is private to that session. Nothing is written
inside the repository, so environment notes cannot be accidentally pushed.

POSIX files are created `0600` (directories `0700`). The store is plaintext;
do not store credentials in memory.

## Markdown format

One `##` heading per entry. The heading is the override key: a session entry
overrides a workspace entry with the same heading, which overrides global.
A leading blockquote is the retrieval hint.

```markdown
## MinGW64 gcc shadowing
> Use when: compiling C/C++ on Windows and gcc resolves to Git's MinGW64.

Git's MinGW64 gcc shadows the intended toolchain. Use the toolchain gcc.
```

`###` and deeper headings remain part of the body. Content before the first
`##` is the file preamble and is preserved on edits.

## Injection

- **Global** entries are shown in full, up to `globalFullMaxChars`.
- **Workspace/session** entries are a compact hint index, up to
  `maxIndexEntries` and the remaining budget.
- A more specific entry that overrides a global heading inherits full injection.
- The response-style section (`order: 461`) is separate and carries the
  `verbosity` preference.
- The memory section (`order: 460`) is a system-prompt section, never a synthetic
  user message.

If full blocks do not fit the budget, every entry falls back to the hint index
instead of exceeding `memoryMaxChars`. When the index itself is truncated, a
tail line points at `memory_list` / `memory_search`.

## Tools

| Tool | Purpose |
|---|---|
| `memory_write` | Write one entry, or rename an existing one with `previousHeading`. A same-heading write with different text or hint returns `CONFLICT` unless `replace: true`. |
| `memory_read` | Fetch one entry's full body by scope and heading. |
| `memory_search` | Full-text search; returns compact snippets. |
| `memory_list` | List headings and hints without bodies. |
| `memory_forget` | Permanently remove one entry; requires `confirm: true`. |
| `memory_compact` | Replace a scope with a compacted entry set; omitted entries are deleted and tombstoned. Requires `confirm: true`. |

`memory_write` defaults to `defaultScope` (workspace). Global entries are
injected in full, so keep them short and broadly applicable. Workspace/session
entries need a precise hint because the body is only fetched on demand. The
tools are the primary interface; there is no memory command.

The heading is the identity within one scope. Writing the same heading with the
same text and hint only updates metadata; writing different text or a different
hint returns `CONFLICT` unless the call explicitly sets `replace: true`. The
same heading in another scope is a scope override, not a conflict.

Use `previousHeading` with the new `heading` to rename an entry in place. Omit
`text` and `hint` to keep them; tags, confidence, timestamps, and the row id are
preserved, and the FTS entry is updated atomically. A manual heading edit is
paired by body hash and shown as one `renamed` item in the review bar; approving
it moves the metadata to the new heading instead of losing it.

Search joins an identifier-like Latin query (`MEM-REV3-ALPHA`, no spaces) with
`AND`, so every part must match. Multi-word and Chinese queries use `OR` and
rely on BM25 ranking, preserving natural-language recall.

Session memory is not pruned on a timer. When it grows, read the current entries
and call `memory_compact` with the kept or merged set; omitted entries are
deleted and tombstoned. Metadata for kept headings is preserved when `tags` and
`confidence` are omitted.

## External edits and the warning bar

At session start, and before queries/injection, the plugin compares each
Markdown file's hash (and each entry's body hash) with the index:

- A modified entry keeps its last-good body in SQLite, gets `status = 1`, and
  appears in the review bar with old/current text.
- A new entry is quarantined as `added`; a removed entry as `removed`.
- A malformed file sets the file's `status = 1`; every entry in it is excluded
  until the file is fixed.
- The bar offers **Approve** (accept the current text, keep metadata),
  **Delete**, and for parse errors **Retry** / **Rebuild** (rebuild accepts the
  current Markdown and resets that file's metadata).
- Approved and quarantined entries are the only states; there is no automatic
  trust of an external edit.

The bar lives in `conversation.input.dock` above the composer and polls
`/dsh-memory/anomalies?sessionId=...` while mounted.

## Configuration

Precedence:

```text
$CWD/.DSH/memory.json  (verbosity, autoInject, defaultScope only)
  > $DSH_HOME/memory/config.json
  > the plugin row config
  > built-in defaults
```

```json
{
  "enabled": true,
  "autoInject": true,
  "verbosity": 3,
  "defaultScope": "workspace",
  "memoryMaxChars": 2000,
  "globalFullMaxChars": 1000,
  "maxIndexEntries": 24,
  "maxIndexChars": 1200,
  "autoCapture": false
}
```

`verbosity` is 1–5 (`null` or `0` disables the response-style section).
`autoCapture` is reserved and has no implementation in v1.

## Install for testers

Requirements: DSH with Node 24 (`node:sqlite`) and no external dependencies.

### From a folder (simplest)

1. Extract the `dsh-memory` folder.
2. In DSH, open Plugins and install from a local folder; if your build has no
   such action, ask your DSH agent to run the `plugin_manager` tool with
   `action: install_bundle` and the absolute path to the extracted folder.
3. Enable the **Memory** bundle if it is not already enabled.
4. Restart DSH or reload the profile if the `memory_*` tools are missing;
   refresh the Web UI for the composer bar. New sessions get both.

### From an npm tarball or registry

`npm pack` builds a runtime-only tarball. Extract it and use the folder flow, or
publish a scoped package and install `<scope>/dsh-memory@<version>` through the
Plugin Manager. The package is MIT-licensed; for npm publishing, choose a unique
package name and remove `"private": true`.

### After install

- Memory files live in `$DSH_HOME/memory/`, never in the repository.
- Run `node --test` inside the package folder to verify the store; the zip
  includes the tests, the npm tarball does not.
- Uninstall through the Plugin Manager. Data stays under `$DSH_HOME/memory/`;
  delete that directory manually to reset.

## Development

```text
node --test
```

The tests cover Markdown parsing/replacement, scope isolation, conflict
handling, rename/compaction, quarantine/approval, parse-error rebuild,
tombstones, CJK/English FTS5 search, budgeting, override inheritance, and
config precedence.

## Limits

- SQLite is a single-owner derived index; do not point multiple DSH processes at
  the same `$DSH_HOME/memory/index.db` concurrently.
- A manual heading rename is paired by body hash. If the body also changed or
  the pairing is ambiguous, it stays remove + add and metadata does not move.
- Session memory is not auto-pruned; use `memory_compact` when it grows.
- No embeddings, no automatic capture, no secret redaction. The store is local
  plaintext and the user is responsible for what is written.

## License

MIT © 2026 ConstMoissanite. See [LICENSE](LICENSE).

## Credits

Designed and maintained by ConstMoissanite. Implementation assisted by DeepSeek Harness.
