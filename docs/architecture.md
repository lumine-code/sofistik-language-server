# Language-server architecture

The server keeps source storage, environment selection, lexical navigation, expanded analysis and calculation-log imports under separate owners. SofistikProject coordinates their lifecycle and exposes the document and navigation operations used by LSP features.

| Component | Owns |
| --- | --- |
| SourceStore | Open and closed document generations, compact or full indexes, bounded disk reads, decoding and source epochs. |
| SourceResolver | Canonical include URIs and file identity; every relative include is resolved beside its owning source. |
| EnvironmentContext | Directory selections composed from sofistik-context and sofistik-schema, supported-release decisions and preprocessing definitions with their origins. |
| NavigationIndex | Raw include reachability, caller-specific lexical contexts, declaration bindings and navigation caches. |
| AnalysisService | Replaceable jobs, the persistent worker, accepted analysis results, expanded dependency tracking and diagnostic contributions. |
| AnalysisSnapshot | The entry generation, environment identity, encoding, definition input and each source actually read during analysis. |
| CalculationDiagnostics | Existing calculation-log findings and their source/version validation. |
| lexer and structure | CADINP scanner state, logical records and the document hierarchy used by symbol projection. |

## Raw and expanded views

Raw navigation stays available while analysis is pending. It indexes the user's source without executing preprocessing, retains caller scope for included fragments and selects each fragment's own schema environment. Completion, hover, signatures, semantic tokens and source navigation use this view.

The analysis worker expands preprocessor input in source order, tracks uncertainty and source provenance, then passes that expansion through the same lexical scanner to the lint engine. Its source map remains inside the worker; only the expansion, diagnostics, dependencies and metrics cross the worker boundary. Diagnostic pulls and preprocessor previews join the same scheduled analysis.

Tree-sitter remains responsible for editor parsing, highlighting, folds and basic tags in language-sofistik. The server has no native-parser or WebAssembly runtime dependency. Both engines test the same cadinp-structure.json corpus distributed by sofistik-schema; fresh, compact and incremental server indexes and fresh/incremental Tree-sitter parses must agree on program and explicit-command selections.

## Analysis generations

A job captures an immutable entry snapshot before it is queued, then captures known source generations when its worker begins. Include reads use that captured open-buffer generation or the SourceStore's bounded disk decoder. The accepted result contains uri, version, snapshot, sources, expansion, diagnostics, dependencies and metrics; scheduler promises, timers and cancellation state remain with the job.

A result is current only while its entry text, version, complete environment identity, encoding, definition epoch and observed source generations agree with the project. Cancelling a client pull does not cancel the shared analysis. A superseded job is discarded, and later work converges on the latest source generation.

## Invalidation

Navigation caches record candidate file dependencies even when an include is missing. Editing, opening, closing or discovering a source invalidates caller views that reach it; unrelated raw graphs remain cached. Schema changes invalidate affected source directories. Aggregate declaration views are invalidated whenever their constituent generations can change.

Expanded dependencies are tracked separately because macros, conditional branches and repeated block invocations can change the files actually read. An adjacent definition edit invalidates its directory's analyses even if it changes only preprocessing parameters or NOQA. Imported calculation findings are cleared when their source generation or selected environment changes.
