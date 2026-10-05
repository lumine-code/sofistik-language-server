# sofistik-language-server

Provides SOFiSTiK CADINP language services over LSP.

> **NOTE**: This package is not an official SOFiSTiK product and is not affiliated with or endorsed by SOFiSTiK AG.

## Features

- **Context finder**: indexes logical records in JavaScript without Tree-sitter, WebAssembly or native modules.
- **Language information**: preserves schema order in completion, shows record keys, compact parameter positions and declaration previews on hover, and provides ordered record signatures.
- **Navigation**: shows document symbols as programs containing commands and declarations, and finds workspace symbols, variable and macro definitions, references and static include targets.
- **Indexing progress**: reports background workspace indexing and file counts through standard LSP work-done progress while open-buffer language features remain available.
- **Diagnostics**: reports unsupported releases, preprocessor problems, variable uses without known declarations and verified module context checks.
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

Closed inputs and include fragments retain a compact navigation index; full token indexes are kept only for open documents. Inputs larger than 32 MiB are excluded from language services to prevent generated outputs from exhausting the server's memory. Skipped disk inputs are reported in the server log, and opening an oversized input shows a diagnostic. Reducing its size restores language services automatically.

Semantic tokens classify only confidently resolved, unquoted enum values as `enumMember`. Quoted values keep the editor grammar's string highlighting. Dynamic includes, CDB values and unevaluated preprocessing may leave navigation ambiguous; this finder does not execute CADINP or replace the calculation programs' validation.

Document symbols use a PROG → command hierarchy with complete structural ranges and precise name selections. Repeated explicit commands remain separate entries, while omitted-keyword rows, tables and `$$` continuations belong to the preceding command. Recognized module tails after END remain within their program, and incomplete programs end at the next header, root statement or end of the buffer. Comments, quoted text and TEXT prose do not create command entries. Commented `$PROG` headers form a scope boundary without a visible program entry. Variable and macro declarations remain available within their containing program or command; workspace symbols and definition lookup retain their declaration-based behavior.

Parameter hover shows the record context and positional slot on its first line, such as `ASE · GRP · VAL /2`, followed by the complete catalogue enum list when available. Values following a named parameter advance through the subsequent slots: `GRP NUMB 57 OFF SPRI` in WING resolves to `NUMB /1`, `OPTI /2` and `ETYP /3`. Comma-separated alternatives share one slot: both `BEAM` and `GLN` in `GRP NUMB 31+#grp YES BEAM,GLN` are `ETYP /3`, with separate completion, hover and enum tokens. Lists wrap naturally without truncation. Release, language and raw catalogue type codes are omitted. A uniquely resolved variable or macro reference shows its source declaration instead; modules, record names and empty space do not produce metadata-only tooltips.

`workspace/executeCommand` with `sofistik.readCalculationDiagnostics` and arguments `[{ "uri": "file:///path/model.dat" }]` reads the corresponding `.error_positions` JSONL. Static and imported diagnostics are published together; editing the source clears the imported findings. Log import never starts a calculation.

## Linting

The server schedules analysis 300 ms after the latest source change. One persistent worker expands CADINP preprocessor directives in memory, then checks the resulting programs in source order. Diagnostic pulls wait for the same scheduled job; completion and navigation remain available while it runs. Open include buffers override disk copies. Changes to included sources and adjacent definitions invalidate dependent results, and outdated worker results are discarded.

The preprocessor supports case-insensitive, deferred `#DEFINE` substitutions, nested parameter names, blocks, repeated `#INCLUDE`, `#UNDEF` and SPS string-based `#IF` branches. It never executes `SYS`, `APPLY` or calculation programs. Unresolved input and runtime-generated sources reduce certainty instead of producing invented variable or context errors. Source and expansion limits bound memory and work.

Variable checks distinguish ordered local `LET` declarations, persistent `STO` exports, `DEL`, external `RCL`, built-in names, arrays and conditional control flow. They report missing declarations in the analyzed input, rather than asserting that an existing CDB lacks a variable. Runtime CADINP expressions are not evaluated. Local variables reset at a new `PROG`; intermediate `END` input blocks reset command contexts such as the active load case while retaining local variables. Module caches include incoming persistent symbols, the selected schema and rule version. Compact lexical records are reused when the expanded program is unchanged or only one program body changes.

Findings point to the original `PROG` header. When an entire program is generated by a reusable definition or include, its invocation is the primary location and the original header and offending record are related locations. Inactive preprocessor branches produce no module findings. Existing calculation-log imports retain their original calculation codes and are independent of the static linter.

New linter diagnostic numbers are stable and globally unique. Add `NOQA = 2001,3001` to the adjacent `sofistik.def` to suppress selected numbers for that input, or `NOQA = ALL` to suppress all new linter findings. A source comment `! noqa: 2001` or `$ noqa: 2001` suppresses that rule on the original offending line; bare `! noqa` suppresses all linter findings on that line. A pragma on a `PROG` header applies to its program, and one on an invocation applies to that expansion. Quoted text is not a pragma. These checks use original source locations even when the displayed finding is attached to a program header.

```text
SOF_VERSION = 2026
NOQA = 3001
```

```text
+PROG ASE
GRP NO #imported VAL FULL ! noqa: 2001
END
```

| Number | Rule                                                 |
| ------ | ---------------------------------------------------- |
| 1001   | Source, expansion or work limit exceeded.            |
| 1002   | Substitution nesting limit exceeded.                 |
| 1003   | Unclosed substitution.                               |
| 1004   | Undefined preprocessor parameter.                    |
| 1005   | Recursive substitution.                              |
| 1006   | Block used as a scalar substitution.                 |
| 1007   | Unsupported preprocessor condition.                  |
| 1008   | Conditional branch without a matching `#IF`.         |
| 1009   | Unclosed block definition.                           |
| 1010   | Invalid preprocessor parameter name.                 |
| 1011   | Include nesting limit exceeded.                      |
| 1012   | Unresolved include.                                  |
| 1013   | Unsupported preprocessor directive.                  |
| 1014   | Unclosed preprocessor conditional.                   |
| 2001   | Variable has no known declaration before its use.    |
| 2002   | Known array index has no preceding declaration.      |
| 3001   | SOFILOAD loading record without an active load case. |
| 3002   | SOFILOAD supplementary LTD record without a task.    |
| 3003   | SOFILOAD LTD MOD without a known source selection.   |
| 3004   | SOFILOAD LTD MOD without a known target selection.   |
| 3005   | SOFILOAD LTDG without a task.                        |
| 3006   | SOFILOAD tributary record without a tributary area.  |
| 4001   | AQUA vertex without a polygon.                       |
| 5001   | MAXIMA combination member without a combination.     |

## Contributing

Got ideas to make this package better, found a bug, or want to help add new features? Just drop your thoughts on GitHub. Any feedback is welcome!
