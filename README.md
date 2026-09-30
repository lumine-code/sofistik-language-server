# sofistik-language-server

Provides SOFiSTiK CADINP language services over LSP.

> **NOTE**: This package is not an official SOFiSTiK product and is not affiliated with or endorsed by SOFiSTiK AG.

## Features

- **Context finder**: indexes logical records in JavaScript without Tree-sitter, WebAssembly or native modules.
- **Language information**: preserves schema order in completion, shows compact parameter positions and declaration previews, and provides ordered record signatures.
- **Navigation**: finds document and workspace symbols, variable and macro definitions, references and static include targets.
- **Diagnostics**: reports unsupported file releases and confidently identified structural problems.
- **Enum highlighting**: supplements the editor grammar with context-specific enum member tokens.
- **Calculation logs**: imports existing error-position logs on request without running SOFiSTiK.
- **Offline operation**: runs without an installed SOFiSTiK release or network access.

## Installation

Install the library from an immutable Git commit:

```sh
npm install github:lumine-code/sofistik-language-server#<commit-sha>
```

The server is distributed through Git pins and is not published to the npm registry. The ide-sofistik adapter includes and launches it using the editor's Node runtime.

## Usage

```sh
sofistik-language-server --stdio
```

One process indexes a workspace, while each saved file uses only `sofistik.def` beside that file. `SOF_VERSION = 2026` selects the release for files in that directory; definitions in the workspace root or an ancestor never apply to a child directory. Without a sibling declaration, the newest release installed under `C:\Program Files\SOFiSTiK` applies, then the newest schema included in sofistik-data. File headers do not select a release, language or edition. Untitled documents use the installed or bundled fallback without reading a definition.

`SOF_LANGUAGE = EN` or `DE` and `SOF_EDITION = professional` or `educational` in the same definition select the language and edition; the defaults are English and professional. These are integration declarations used by the Lumine packages, not a claim that SOFiSTiK itself interprets these fields. Every consumer uses the lightweight resolver from sofistik-data directly; no environment service or installation-path setting is required.

Included files use their own directory's release, language and edition while retaining the caller's lexical module and variable scope for fragment navigation. A changed or deleted definition refreshes only documents in its directory and clears their imported calculation diagnostics; installation changes are checked on subsequent requests and saves.

The server consumes the `sofistik` workspace configuration section: `textCase` is `upper` or `lower`, and `encoding` defaults to `utf-8` for closed files. Open documents always use the client's text. Unsupported declared releases are reported rather than silently substituted.

Semantic tokens classify only confidently resolved enum values as `enumMember`. Ordinary syntax highlighting stays with the editor grammar. Dynamic includes, CDB values and unevaluated preprocessing may leave navigation ambiguous; this finder does not execute CADINP or replace the calculation programs' validation.

Parameter hover shows the record context and positional slot on its first line, such as `ASE · GRP · VAL /2`, followed by the complete catalogue enum list when available. Lists wrap naturally without truncation. Release, language and raw catalogue type codes are omitted. A uniquely resolved variable or macro reference shows its source declaration instead; modules, record names and empty space do not produce metadata-only tooltips.

`workspace/executeCommand` with `sofistik.readCalculationDiagnostics` and arguments `[{ "uri": "file:///path/model.dat" }]` reads the corresponding `.error_positions` JSONL. Static and imported diagnostics are published together; editing the source clears the imported findings. Log import never starts a calculation.

## Contributing

Got ideas to make this package better, found a bug, or want to help add new features? Just drop your thoughts on GitHub. Any feedback is welcome!
