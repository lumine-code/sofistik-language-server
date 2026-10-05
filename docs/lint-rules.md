# SOFiSTiK linter rules

The linter selects verified rules by the source's exact SOFiSTiK release and keyword language. It never carries a newer rule into an unverified older release.

G identifies general checks. Other prefixes identify canonical calculation modules; executable aliases use their canonical module's prefix. Codes remain stable when version-specific predicates or bindings differ.

## Suppressions

Use NOQA = G101,SL001 in the adjacent sofistik.def, or a source comment ! noqa: G101. A bare noqa or NOQA = ALL suppresses all static findings. Selectors without digits select one complete module prefix: AQ selects AQUA, while AQB remains separate. A partial numbered selector such as G1 selects that numbered family. Imported calculation findings retain their original codes and are not suppressed by these static selectors.

Source ranges identify the original variable, proven invalid value or record, even when preprocessing changes its length or removes preceding branches. A substituted value selects its full use site and links its actual definitions. Reusable blocks select the failing invocation and link the precise body location; ordinary file includes publish findings in the included file. A pragma on any original physical line of the offending record retains its scope independently of the displayed range. A program header selects its variable and module checks; preprocessing failures use their offending line, invocation or project selector. A scalar definition's pragma does not silence unrelated uses through a related-location link.

## Prefixes

| Prefix | Module       |
| ------ | ------------ |
| G      | BASIC        |
| AQB    | AQB          |
| AQ     | AQUA         |
| AS     | ASE          |
| BD     | BDK          |
| BM     | BEAM         |
| BE     | BEMESS       |
| CL     | COLUMN       |
| CP     | COMPOSITE    |
| CS     | CSA          |
| CM     | CSM          |
| DI     | DBINFO       |
| DM     | DBME         |
| DP     | DBPRIN       |
| DC     | DECREATOR    |
| DF     | DOLFYN       |
| DS     | DSYNC        |
| DY     | DYNA         |
| DR     | DYNR         |
| EL     | ELLA         |
| FB     | FEABENCH     |
| FC     | FEACHECK     |
| FT     | FOOTING      |
| HA     | HASE         |
| HY     | HYDRA        |
| MX     | MAXIMA       |
| RL     | RELY         |
| RS     | RESULTS      |
| SW     | SHEARWALL    |
| SI     | SIR          |
| SL     | SOFILOAD     |
| PL     | PLBCONVERTER |
| SHA    | SOFIMSHA     |
| SHC    | SOFIMSHC     |
| ST     | STAR         |
| TA     | TALPA        |
| TP     | TEMPLATE     |
| TD     | TENDON       |
| TX     | TEXTILE      |
| TU     | TUNA         |
| WG     | WING         |

## General and existing context checks

| Code | Rule |
| --- | --- |
| G001 | Source, expansion or work limit exceeded. |
| G002 | Substitution nesting limit exceeded. |
| G003 | Unclosed substitution. |
| G004 | Undefined preprocessor parameter. |
| G005 | Recursive substitution. |
| G006 | Block used as a scalar substitution. |
| G007 | Unsupported preprocessor condition. |
| G008 | Conditional branch without a matching IF. |
| G009 | Unclosed block definition. |
| G010 | Invalid preprocessor parameter name. |
| G011 | Include nesting limit exceeded. |
| G012 | Unresolved include. |
| G013 | Unsupported preprocessor directive. |
| G014 | Unclosed preprocessor conditional. |
| G101 | Variable has no known declaration before its use. |
| G102 | Known array index has no preceding declaration. |
| G301 | Module is absent from the selected release's command catalogue. |
| G302 | Selected release has no bundled command schema. |
| G303 | Input exceeds the language-service size limit. |
| G304 | ENDDEF has no matching DEFINE. |
| G305 | Control terminator has no matching opening record. |
| G306 | Unterminated quoted value. |
| G307 | Native control branch or terminator conflicts with the open IF/LOOP structure. |
| G308 | IF or ELSEIF has no condition expression. Bare LOOP retains its documented default bound. |
| G309 | Native IF/LOOP remains open at a confirmed program boundary. Intermediate END does not close its scope. |
| SL001 | SOFILOAD loading record without an active load case. |
| SL002 | SOFILOAD supplementary LTD record without a task. |
| SL003 | SOFILOAD LTD MOD without a known source selection. |
| SL004 | SOFILOAD LTD MOD without a known target selection. |
| SL005 | SOFILOAD LTDG without a task. |
| SL006 | SOFILOAD tributary record without a tributary area. |
| MX001 | MAXIMA member without an active combination. |

Native control checks run only for the verified releases. They inspect structure without evaluating CADINP conditions, preserve controls across intermediate END input blocks, and stop claiming certainty when expansion or runtime input can change that structure. Bare LOOP is valid with its documented default iteration limit. G307 relates a conflicting closer or branch to its opener; G309 selects the unclosed opener. The new module families likewise check only definite local values or known task state: zero bedding/load defaults stay inactive, BET suppresses the legacy ALF check, and moving-load position styles reset at TASK, END and PROG boundaries.

## ERR-derived module rules

A rule listed for a release still requires its language's native command and parameter bindings to exist in that release's schema. Source values, implicit units and control-flow states that cannot be resolved from text remain unknown; they do not become guessed defaults.

| Code | Module | Rule | Verified releases |
| --- | --- | --- | --- |
| AQB001 | AQB | An AND continuation needs an earlier combination in the current input block. | 2018, 2020, 2022, 2023, 2024, 2025, 2026 |
| AQB002 | AQB | EIGE RH must lie in its accepted numeric interval. | 2018, 2020, 2022, 2023, 2024, 2025, 2026 |
| AQB003 | AQB | EIGE TEMP must lie in its accepted numeric interval. | 2018, 2020, 2022, 2023, 2024, 2025, 2026 |
| AQB004 | AQB | Creep processing excludes GMAX and GMIN combination modes. | 2018, 2020, 2022, 2023, 2024, 2025, 2026 |
| AQ001 | AQUA | A vertex record needs an active polygon definition. | 2018, 2020, 2022, 2023, 2024, 2025, 2026 |
| AS001 | ASE | Explicit result storage in STEP is restricted to a single step. | 2018, 2020, 2022, 2023, 2024, 2025, 2026 |
| AS002 | ASE | A launch record cannot combine its DX translation and PHI rotation inputs. | 2018, 2020, 2022, 2023, 2024, 2025, 2026 |
| AS003 | ASE | A rotation axis must not define all three center coordinates in LAUN. | 2018, 2020, 2022, 2023, 2024, 2025, 2026 |
| BD001 | BDK | CTRL SFAC must lie in its accepted numeric interval. | 2018, 2020, 2022, 2023, 2024, 2025, 2026 |
| BE001 | BEMESS | MREI FFCT must lie in its accepted numeric interval. | 2018, 2020, 2022, 2023, 2024, 2025, 2026 |
| BE002 | BEMESS | The explicit K and KC reinforcement coefficients are restricted to their input interval. | 2018, 2020, 2022, 2023, 2024, 2025, 2026 |
| BE003 | BEMESS | CTRL GALF must lie in its accepted numeric interval. | 2018, 2020, 2022, 2023, 2024, 2025, 2026 |
| BE004 | BEMESS | The reinforcement direction input accepts at most two explicit coordinate components. | 2018, 2020, 2022, 2023, 2024, 2025, 2026 |
| BE005 | BEMESS | Explicit material strength and strain inputs must have the documented positive sign. | 2018, 2020, 2022, 2023, 2024, 2025, 2026 |
| BE006 | BEMESS | The concrete strain C1 uses a negative sign. | 2018, 2020, 2022, 2023, 2024, 2025, 2026 |
| CL001 | COLUMN | A positive fire resistance class must be one of the supported classes. | 2018, 2020, 2022, 2023, 2024, 2025, 2026 |
| CP001 | COMPOSITE | A ULS task cannot select the serviceability PERM or RARE check. | 2025, 2026 |
| CP002 | COMPOSITE | A SLS task cannot use the listed ultimate design check modes. | 2025, 2026 |
| CP003 | COMPOSITE | The crack width input is limited to the documented discrete choices. | 2025, 2026 |
| CP004 | COMPOSITE | TS BETA must lie in its accepted numeric interval. | 2025, 2026 |
| CP005 | COMPOSITE | Selection properties require an earlier selection definition. | 2024, 2025, 2026 |
| CS001 | CSA | An explicit load-set number must be positive. | 2026 |
| CM001 | CSM | A safety-factor override supplies both ultimate and accidental factors. | 2020, 2022, 2023, 2024, 2025, 2026 |
| CM002 | CSM | EQIT FMAX must lie in its accepted numeric interval. | 2022, 2023, 2024, 2025, 2026 |
| CM003 | CSM | These construction-stage numbers are zero or reserved identifiers. | 2018, 2020, 2022, 2023, 2024, 2025, 2026 |
| CM004 | CSM | The stage cantilever mode must use a supported numeric selector. | 2023, 2024, 2025, 2026 |
| CM005 | CSM | Variable-temperature mode excludes the conventional explicit height inputs. | 2023, 2024, 2025, 2026 |
| DY001 | DYNA | A transient time-stepping block cannot also request response spectra. | 2018, 2020, 2022, 2023, 2024, 2025, 2026 |
| DR001 | DYNR | Response-spectrum damping values cannot be negative. | 2018, 2020, 2022, 2023, 2024, 2025, 2026 |
| EL001 | ELLA | Individual train-load records require an earlier train definition. | 2018, 2020, 2022, 2023, 2024, 2025, 2026 |
| FT001 | FOOTING | An action identifier must begin with a supported action family letter. | 2018, 2020, 2022, 2023, 2024, 2025, 2026 |
| HA001 | HASE | An explicit FLEX selector must use the substructure category. | 2018, 2020, 2022, 2023, 2024, 2025, 2026 |
| HA002 | HASE | Internal and imported pile declarations must use separate input blocks. | 2018, 2020, 2022, 2023, 2024, 2025, 2026 |
| HY001 | HYDRA | These hydraulic boundary types do not accept the directional differential inputs. | 2018, 2020, 2022, 2023, 2024, 2025, 2026 |
| TA001 | TALPA | CGRP FACS must lie in its accepted numeric interval. | 2018, 2020, 2022, 2023, 2024, 2025, 2026 |
| TA002 | TALPA | CGRP K must lie in its accepted numeric interval. | 2018, 2020, 2022, 2023, 2024, 2025, 2026 |
| TA003 | TALPA | CGRP ALPH must lie in its accepted numeric interval. | 2018, 2020, 2022, 2023, 2024, 2025, 2026 |
| SHA001 | SOFIMSHA | IMPD requires an earlier IMPO import definition. | 2018, 2020, 2022, 2023, 2024, 2025, 2026 |
| SHA002 | SOFIMSHA | CTRL NODE must be defined before SYST. | 2018, 2020, 2022, 2023, 2024, 2025, 2026 |
| SHA003 | SOFIMSHA | UBND requires an earlier UMSH definition. | 2018, 2020, 2022, 2023, 2024, 2025, 2026 |
| SHA004 | SOFIMSHA | BSEC requires a preceding BEAM definition or explicit NO and X. | 2018, 2020, 2022, 2023, 2024, 2025, 2026 |
| SHA005 | SOFIMSHA | GRP BASE requires SYST GDIV 0. | 2018, 2020, 2022, 2023, 2024, 2025, 2026 |
| SHC001 | SOFIMSHC | GRP BASE requires SYST GDIV 0. | 2018, 2020, 2022, 2023, 2024, 2025, 2026 |
| SHC002 | SOFIMSHC | Geometric axis properties require an earlier GAX definition. | 2018, 2020, 2022, 2023, 2024, 2025, 2026 |
| SHC003 | SOFIMSHC | Geometric area properties require an earlier GAR definition. | 2018, 2020, 2022, 2023, 2024, 2025, 2026 |
| SL007 | SOFILOAD | PUSH requires NLCC > 0. | 2022, 2023, 2024, 2025, 2026 |
| SL008 | SOFILOAD | LTD requires SRLC > 0. | 2025, 2026 |
| SL009 | SOFILOAD | LTD MOD cannot use SRCT ALL or TRGT AUTO/FALL. | 2025, 2026 |
| SL010 | SOFILOAD | LTD IGN permits only SLN, SPT, GRP or GUID selections. | 2025, 2026 |
| SL011 | SOFILOAD | LTD HMOM AUTO requires TYPE MOMT. | 2025, 2026 |
| SL012 | SOFILOAD | TRB requires NO > 0. | 2026 |
| SL013 | SOFILOAD | TRBP requires POLY >= 1. | 2026 |
| TD001 | TENDON | PTUV requires RH > 0; RV > 0. | 2018, 2020, 2022, 2023, 2024, 2025, 2026 |
| TD002 | TENDON | PTUV RH/RV require DUS and DVS to be zero. | 2018, 2020, 2022, 2023, 2024, 2025, 2026 |
| TD003 | TENDON | PTUV X is available only for TYPE BEAM. | 2018, 2020, 2022, 2023, 2024, 2025, 2026 |
| TD004 | TENDON | AXES KIND AUTO/QUAD requires TYPE REFX or POLY. | 2023, 2024, 2025, 2026 |
| TD005 | TENDON | LOAD requires LC > 0. | 2018, 2020, 2022, 2023, 2024, 2025, 2026 |
| TD006 | TENDON | TEND requires NOT >= 1 <= 1000000. | 2023, 2024, 2025, 2026 |
| TD007 | TENDON | TENDON supports only SIZE FORM URS. | 2023, 2024, 2025, 2026 |
| TX001 | TEXTILE | Only one CUTT record is allowed in an input block. | 2018, 2020, 2022, 2023, 2024, 2025, 2026 |
| TX002 | TEXTILE | COMP requires N >= 2 <= 10. | 2018, 2020, 2022, 2023, 2024, 2025, 2026 |
| ST001 | STAR | Only one DESI record is allowed in an input block. | 2018, 2020, 2022, 2023, 2024, 2025, 2026 |
| ST002 | STAR | Only one NSTR record is allowed in an input block. | 2018, 2020, 2022, 2023, 2024, 2025, 2026 |
| MX002 | MAXIMA | ACT requires TYPE. | 2018, 2020, 2022, 2023, 2024, 2025, 2026 |
| MX003 | MAXIMA | ACT TYPE must begin with an ASCII letter. | 2018, 2020, 2022, 2023, 2024, 2025, 2026 |
| MX004 | MAXIMA | SUPP requires ETYP. | 2020, 2022, 2023, 2024, 2025, 2026 |
| MX005 | MAXIMA | SUPP EXTR SRSS requires COMB EXTR STAN. | 2018, 2020, 2022, 2023, 2024, 2025, 2026 |
| MX006 | MAXIMA | SUPP ETYP SPAC requires COMB EXTR NONL or STAN. | 2018, 2020, 2022, 2023, 2024, 2025, 2026 |
| MX007 | MAXIMA | SUM requires COMB EXTR STAN. | 2018, 2020, 2022, 2023, 2024, 2025, 2026 |
| MX008 | MAXIMA | ACT is unavailable with COMB EXTR EXPL. | 2018, 2020, 2022, 2023, 2024, 2025, 2026 |
| MX009 | MAXIMA | ADD FACF is unavailable when FACU is GAM, PSIG, PS1G, PS2G or P1SG. | 2018, 2020, 2022, 2023, 2024, 2025, 2026 |
| WG001 | WING | DCDB requires NUMB > 0. | 2018, 2020, 2022, 2023, 2024, 2025, 2026 |
| WG002 | WING | DVDF requires NUMB > 0. | 2018, 2020, 2022, 2023, 2024, 2025, 2026 |
| WG003 | WING | DDEF requires NUMB > 0. | 2018, 2020, 2022, 2023, 2024, 2025, 2026 |
| WG004 | WING | DFNC requires NUMB > 0. | 2018, 2020, 2022, 2023, 2024, 2025, 2026 |
| WG005 | WING | DMET requires NUMB > 0. | 2018, 2020, 2022, 2023, 2024, 2025, 2026 |
| WG006 | WING | DVAL requires NUMB > 0. | 2018, 2020, 2022, 2023, 2024, 2025, 2026 |
| WG007 | WING | DUTP requires NUMB > 0. | 2018, 2020, 2022, 2023, 2024, 2025, 2026 |
| WG008 | WING | DETP requires NUMB > 0. | 2018, 2020, 2022, 2023, 2024, 2025, 2026 |
| WG009 | WING | DGRP requires NUMB > 0. | 2018, 2020, 2022, 2023, 2024, 2025, 2026 |
| RS001 | RESULTS | JOIN requires COL1 and COL2. | 2018, 2020, 2022, 2023, 2024, 2025, 2026 |
| SW001 | SHEARWALL | DESI requires SCMC >= 0.1; SCMS >= 0.1. | 2024, 2025, 2026 |
| FC001 | FEACHECK | SOFT requires MR1L >= 0; SRX1 >= 0; SRX3 >= 0; MR1L <= MR1U; SRX1 <= SR1; SRX3 <= SR3; SR1 <= SR3. | 2022, 2023, 2024, 2025, 2026 |
| FC002 | FEACHECK | WEAK requires TAUC > 0; TAUS > 0; CR1X >= 0; CR1X <= CR1. | 2022, 2023, 2024, 2025, 2026 |
| FC003 | FEACHECK | SHPR requires QD >= 1; IMP >= 1. | 2022, 2023, 2024, 2025, 2026 |
| FC004 | FEACHECK | DRFT requires D2HX >= 0; NRED >= 0 <= 1. | 2022, 2023, 2024, 2025, 2026 |
| FC005 | FEACHECK | PDEL requires THT1 >= 0; THT1 <= THT2; THT2 <= THTX. | 2022, 2023, 2024, 2025, 2026 |
| FC006 | FEACHECK | SELE requires ZLVB < ZLVT. | 2024, 2025, 2026 |
| FB001 | FEABENCH | LCPY requires . | 2023, 2024, 2025, 2026 |
| MX010 | MAXIMA | COMB requires NO >= 1 <= 999. | 2022, 2023, 2024, 2025, 2026 |
| WG010 | WING | DCDB requires KW >= 0. | 2018, 2020, 2022, 2023, 2024, 2025, 2026 |
| WG011 | WING | DCDB requires INT >= 0. | 2018, 2020, 2022, 2023, 2024, 2025, 2026 |
| WG012 | WING | DCDB requires FLOA >= 0. | 2018, 2020, 2022, 2023, 2024, 2025, 2026 |
| DM001 | DBME | An explicitly negative destination load-case number is rejected. Zero is not rejected by this rule. | 2025, 2026 |
| DP001 | DBPRIN | The explicit beam-stiffness ITEM combination is unsupported in this print module. | 2018, 2020, 2022, 2023, 2024, 2025, 2026 |
| RL001 | RELY | Each VAR requires a nonempty name. | 2018, 2020, 2022, 2023, 2024, 2025, 2026 |
| RL002 | RELY | A VAR selects its distribution using exactly one of TYPE and TID. | 2018, 2020, 2022, 2023, 2024, 2025, 2026 |
| RL003 | RELY | EXDS sampling from DAT needs a nonempty SAIF filename. | 2018, 2020, 2022, 2023, 2024, 2025, 2026 |
| RL004 | RELY | An explicitly supplied SLSF record selects exactly one of VARN and EXPR. | 2018, 2020, 2022, 2023, 2024, 2025, 2026 |
| RL005 | RELY | SLSF cannot specify VARN and EXPR together. | 2026 |
| FB002 | FEABENCH | An explicit numeric time duration must be positive. | 2024, 2025, 2026 |
| FB003 | FEABENCH | An explicit numeric time step must be positive. | 2024, 2025, 2026 |
| FB004 | FEABENCH | A specified load-train speed must be positive; TDIR controls its direction. | 2024, 2025, 2026 |
| FB005 | FEABENCH | Explicit convergence tolerance, maximum steps and maximum study iterations must be positive. | 2024, 2025, 2026 |
| FB006 | FEABENCH | Reject explicit reduction factors outside the unit interval. The ERR wording does not settle endpoints; do not reject exactly 0 or 1 from this descriptor. | 2024, 2025, 2026 |
| FB007 | FEABENCH | When requesting newly computed eigenmodes, an explicit numeric count must be positive. | 2022, 2023, 2024, 2025, 2026 |
| CS002 | CSA | An explicit compressive strain limit must be nonpositive. | 2025, 2026 |
| CS003 | CSA | An explicit tensile strain limit must be nonnegative. | 2025, 2026 |
| CS004 | CSA | Within category/criteria definition TASK PERF, PCRT must follow an active PCAT record. | 2025, 2026 |
| G203 | AQB, ASE, STAR, TALPA | Reject explicit KMIN above 1 or KMAX below 1 in this shared strain-analysis record. | 2018, 2020, 2022, 2023, 2024, 2025, 2026 |
| G204 | AQB, ASE, STAR, TALPA | An explicitly supplied ALPH must satisfy 0 < ALPH <= 0.99 in the mapped strain-analysis record. | 2018, 2020, 2022, 2023, 2024, 2025, 2026 |
| PL001 | PLBCONVERTER | An explicitly named input file must use the .plb extension. | 2018, 2020 |
| PL002 | PLBCONVERTER | An explicitly named Word output file must use the .docx extension. | 2018, 2020 |
| PL003 | PLBCONVERTER | An explicitly named Word template must use the .docx extension. | 2018, 2020 |
| PL004 | PLBCONVERTER | An explicit image filename rule must contain both %number% and %ext%. | 2020 |
| AS004 | ASE | STEP ALF must be nonnegative when BET is omitted. | 2018, 2020, 2022, 2023, 2024, 2025, 2026 |
| AS005 | ASE | LC FACD cannot be active together with DLX, DLY or DLZ. | 2018, 2020, 2022, 2023, 2024, 2025, 2026 |
| CS005 | CSA | Takeda unloading coefficients TAY and TAZ must be between 0 and 1. | 2026 |
| CS006 | CSA | Takeda reloading factors TBY and TBZ must be between -1 and 1. | 2026 |
| SHC004 | SOFIMSHC | Do not combine CX/CY/CZ/CMX/CMY/CMZ bedding with CA/CL/CD or a material number. | 2026 |
| FB008 | FEABENCH | TASK MLT requires physically and geometrically linear behavior. | 2024, 2025, 2026 |
| FB009 | FEABENCH | An explicit STEP TYPE GENA RHOI must be strictly between 0 and 1. | 2024, 2025, 2026 |
| FB010 | FEABENCH | Moving-load trains in one MLT task cannot mix numeric SVAL with STRT/END start positions. | 2025, 2026 |

## Audit coverage

The audit covers all 61 distinct local ERR resources across 2018, 2020 and 2022–2026, including shared DLL catalogues and historical-only files. A resource without a precise CADINP binding or a reliable text-only condition does not manufacture a module rule. General language checks remain available for those modules.

The JSON audit retains source paths, message locations and binary SHA-256 digests matching sofistik-data's committed provenance. Raw licensed catalogues and their message bodies are not shipped. See err-rule-audit.json for evidence and deferred categories.

| Resource | Review result | Excluded or deferred checks |
| --- | --- | --- |
| AQB | safe-candidates | Element ordering/selection, cross sections, reinforcement and design outcomes depend on CDB or engineering semantics. Not all COMB types are valid parents of AND; only definite absence is covered. |
| AQUA | safe-candidates | Most material/section geometry and stress-strain checks need geometry, CDB or defaults. SECT-before-all-section-shapes remains unclassified without a precise shape family. |
| ASE | safe-candidates | Nonlinear/design-code restrictions, primary load cases and system dimensionality require CDB. GRP2 restrictions from native ERR 666/946 conflict with the 2026 manual's combined-factor formulas and remain deferred. Legacy STEP ALF is checked only without an explicit BET override. |
| BDK | safe-candidates | Buckling curves, selected design code, cross-section classes and lateral restraint checks depend on the structural model. |
| BEAM | no-safe-text-rule | All concrete candidate messages found refer to design elements, CDB load combinations, structural geometry or design results; no dependable additional text-only ERR rule identified. |
| BEMESS | safe-candidates | Design-code-dependent reinforcement checks, punching geometry, force/result presence and strength calculations are excluded. MREI missing FFCT, DDES/WK dependencies and changing CTRL modes need default/inheritance documentation before absence rules. |
| COLUMN | safe-candidates | System, cross section, convergence and reinforcement diagnostics depend on CDB. Only an explicit positive FIRE class is assessed. |
| COMPOSITE | safe-candidates | Several ERR messages use outdated option names NON/NOFF while schema uses MNON/MNOF. Do not map those options by guessing. ULS full-complement enforcement would wrongly judge ELA2/BOT2; only clearly conflicting serviceability modes are included. |
| COMREL | no-safe-text-rule | This ERR is a separate STRUREL/COMREL block-format catalogue (YINITI/YINITV etc.), not a CADINP command catalogue. The shipped provider has no COMREL command schemas. Its numeric/parser diagnostics must not be applied to PROG CADINP. |
| CSA | safe-candidates | Takeda coefficient bounds are verified only for the 2026 EXPO SMAT / MTYP MTAK form. TASK family legality still depends on inherited task state and defaults. |
| CSM | safe-candidates | Tendon stages, actions/design-code compatibility, equivalent loads and target solvability require CDB or design semantics. Creep-time defaults and PARAM inheritance are excluded. |
| DYNA | safe-candidates | Eigenvalue count, damping model activation, CDB accelerations, spectra direction completeness and eigensolver results are excluded. Frequency-domain STEP is not treated as transient. |
| DYNR | safe-candidates | Stored vs external function conflicts and accelerations depend on CDB. Missing function values/time monotonicity need precise continuation/default semantics. |
| ELLA | safe-candidates | Lane geometry, influence lines, train velocities and design-code rules require CDB/geometry. Clearing the train context on LC remains unproved; the candidate deliberately only checks total prior-train absence in an input block. |
| FOOTING | safe-candidates | Foundation geometry, anchoring depth, load-number references and soil/bearing checks are excluded. Omitted POS/LCZ identifiers may involve inherited defaults and are not asserted. |
| HASE | safe-candidates | Halfspace coordinates, profiles/layers, stiffness matrices, supports and pile geometry are excluded. FLEX omission/default handling is not judged. |
| HYDRA | safe-candidates | Load-case/start-value absence may be inherited or CDB-derived. Hydraulic geometry, material properties, boundary/node existence and flow results are excluded. |
| TALPA | safe-candidates | Construction stage order, group references, strain/stiffness results and model-specific physical restrictions need CDB. Missing K/ALPH on CGRP remains deferred pending default/inheritance proof. |
| TUNARS | no-safe-text-rule | The catalogue contains command forms and only a generic no-message terminator; no concrete ERR diagnostics available for a dependable module-specific rule. |
| sofimsha | safe candidates | Do not infer arbitrary node/element ranges or SYST defaults from runtime messages. BSEC number/axis existence and imports need CDB/file state. MASS095 PRZ<=1.5 requires percentage/factor/sentinel semantics before applying a numeric lower bound. |
| sofimshc | safe candidates | Geometric radii, mesh subdivisions, axis station order and referenced entities require geometry/CDB semantics. Family-specific property validation needs authoritative grouping beyond generic message230. |
| sofiload | safe candidates | LTD419 English permits DIR Y/Z but German permits X/Y; unresolved translation conflict. TRBS463 names ANG; schema uses FANG/FANT, so no direct bound mapping without documentation. TRBP470 clamps H to0.05 but does not state a universal lower bound. LC/TRB/LTD context rules are existing stable rules and should retain numeric IDs. RESP083 uses T1/T2/T3 absent from current RESP schema (TB/TC/TD/TE); timing constraints require documented semantic mapping, not assumed renaming. |
| tendon | safe candidates | PTUV167 English says >0.10m while German says at least0.10m: unresolved inclusive bound plus unit conversion. Mixing prestress method messages and obsolete backend messages require current backend/default verification. TEND165 claims duplicate is fatal while550 says previous definitions are overwritten: scope/backend conflict. GEOX curve length, tendon geometry, axes and prestressing material existence are geometric/CDB-dependent. Missing values in PTUV/SYSP/PDEF can depend on remembered record data or library prestressing systems; no guessed required-field rules. |
| textile | safe candidates | CUTT LC0 can mean an explicit no-loadcase mode; missing LC cannot be diagnosed from the file alone. COMP111 interpreted only for explicit matrix types; do not apply to CE/DE simple strain forms. Material/mesh shape and strain-monotonicity checks excluded. |
| star2 | safe candidates | STAR2 executable and ERR source normalize to STAR schema module. KMOD tension-stiffening subsets in442 include TN absent from2026schema; cannot derive valid modern subtype matrix solely from this message. Actual load numbers, nonlinear analysis prerequisites and stored cross sections require CDB. |
| maxima | safe candidates | Do not assume missing COMB TYPE, SUPP LC, ACT/LC groups or CSAV are errors without tracking defaults, database-resident combinations and complete end-of-block state. SUPP/ETYP option predicates must resolve the referenced COMB number; last-seen COMB is insufficient when SUPP COMB explicitly references another combination. ADD/ADA action-group classification and supported action factors depend on design code/CDB. |
| sir | safe candidates | Normal/local axis directions and XS ordering are geometry semantics; implicit normal defaults prevent naive missing-value checks. SIZE SPLI sentinel/default forms need manual verification before publishing a strict pattern rule. |
| wing | safe candidates | Drawing representation and referenced functions/types require CDB/generated graphical type state. DMET AFTE enum includes INPB absent from749 order prose; do not infer a total ordering. Positive definition IDs are static; dynamic IDs and special DETP OLDG stay valid. |
| gks | none safe | No CADINP command schema: graphics-library diagnostics, not a standalone parsed module. |
| gkx | none safe | No CADINP command schema: legacy interactive metafile viewer, not a standalone parsed module. |
| results | safe candidates | FLT970 does not identify which item is universally mandatory; do not guess NAME/RULE defaults. DIAG669-675 coexist with automatic selection/deprecation messages671-674: omitted axes/graphs may be valid in the current release. JOIN required field check is text-only; column existence/valid result names require runtime result data. |
| shearwall | safe candidates | Concrete/core cross sections and result cases require CDB. DESI maximum ratios are percentages; publish bounds only with verified percent-unit conversion. Missing task/material and reinforcement ordering are entity/geometry-dependent. |
| design | none safe | No standalone CADINP command schema: shared design library diagnostics; inputs are owned by other programs. |
| design_elements | none safe | No standalone CADINP command schema: shared design-element engine; cross section and geometric box checks belong to caller-specific schemas. |
| feacheck | safe candidates | Do not diagnose missing selected load cases/storeys without runtime state. Explicit constant inequalities are well specified; use SRX1/SRX3 despite message typo. |
| feabench | safe candidates | Only one specific text-only message, LCPY needs a containing LC; remaining input error is generic and no arbitrary predicate can be derived. |
| dbinfo | none-safe | The three diagnostic messages concern starting, processing and finishing database macros. They establish no precise input-only parameter constraint. |
| dbmerg | safe-rules | DBME is the generated schema name; the ERR header is DBME while the installed manual and PROG name use DBMERG. Negative load-case numbers are explicitly rejected. Database-count and grouping validity messages require runtime state. |
| dbprin | safe-rules | An explicit BEAM/STIF pair is unsupported. Additional ITEM/SELE/PRIN constraints are input-only in principle but require confirmed print-block boundaries before implementation. |
| decreator | none-safe | Missing DSLN may refer to current or stored design elements; DSID can select existing database elements. Limit messages do not establish the reset scopes of DSLC/DSEL/DGEO counters, so even the stated 1024 DSEL limit is deferred. |
| dolfyn | none-safe | Faulty time-stepping has no explicit bounds. Wind boundary-layer turbulence is a promising cross-record rule, but raw DOLF input can alter effective fluid state and the exact triggering WIND mode needs confirmation. |
| dsync | none-safe | The ERR contains only a test diagnostic, not actionable text-only input constraints. |
| ifc_export | none-safe | The ERR explicitly declares a dummy CADINP section injected at startup. EXPO TO and selection sequencing are promising, but no stable command schema or default behavior is supplied locally. |
| plbconverter | none-safe | The CADINP grammar is injected. File-extension and ASYN/WAIT constraints lack available command/parameter bindings. First-module warnings depend on external WPS append-results settings and must not become unconditional lint. |
| rely | safe-rules | VAR identifier/distribution selection, conditional EXDS input filename, and SLSF alternative selection are supported by the schema and installed manual. Generic distribution-parameter messages have defaults and linked Vn alternatives, so they are not treated as unconditional required parameters. |
| saf_export | none-safe | The ERR explicitly declares a runtime-injected dummy grammar. EXPO TO and CTRL options are named, but exact allowed values and selection command bindings are absent. |
| sof_fea_analysis | safe-rules | This shared DLL is used by FEABENCH. ERR terminology and records map to FEABENCH STEP, EIGE, DTC and MOVL schema and manual sections; numeric input-only restrictions are usable. Group damping needs automatic Rayleigh conversion and defaults, so it is deferred. |
| sof_fea_check | none-safe | The resource contains generic test failures and result-table text, not concrete input-only checks. |
| sof_fea_cs_analysis | none-safe | Most messages depend on computed axial capacities, work laws or available materials. The one-P-level restriction lacks an exact hinge-type condition in the ERR; the warning asking for a P-level explicitly falls back to a runtime default. |
| sof_fea_loadcopy | none-safe | Load-case limits are runtime-formatted integer placeholders, and missing loads are database-dependent. No fixed scalar bound is established by this resource. |
| sof_fea_member_design | none-safe | The resource concerns database-derived cross-section shapes, symmetry, materials, force results and member geometry. The AMXY/AMXZ recommendations depend on whether a member is a pendulum column; they cannot be inferred solely from those numeric fields. |
| sof_fea_performance_crit | safe-rules | CSA PCAT/PCRT and LIMS bindings are confirmed by the host ERR and manual. Signs of explicit compressive/tensile limit strains are local numeric checks; PCRT requires the preceding category within TASK PERF. Existence of stored categories/materials and strain hierarchy derived from runtime values remain deferred. |
| sof_fea_storeys | none-safe | Tower/storey association, extent and overlap checks operate on model objects stored in the database. No text record binding exists in this ERR. |
| sof_print | none-safe | The resource contains only generic abort/error/test diagnostics and output labels. |
| sofistik | safe-rules | This is the shared general runtime resource, not a PROG SOFISTIK grammar. NSTR/DEHN scalar KMIN/KMAX/ALPH constraints map precisely to these hosts. BEMESS NSTR has unrelated parameters and must be excluded. Generic runtime, geometry and material messages need separate host-specific mapping. |
| sofistik_leg | none-safe | This resource defines printing legend labels and explanatory result text. It has no CADINP record grammar or independently actionable input diagnostic. |
| template | none-safe | The demonstration grammar contains no diagnostic beyond the no-message sentinel. |
| fea_elements | none-safe | The only non-test messages require centres of rigidity already computed in the CDB. These may exist from earlier calculations; absence in current text does not prove missing prerequisite. |
| plbconverter_texts | safe-rules | Legacy DOCX/OPT/IMG schemas and both release-specific manuals establish explicit filename extensions and IMG placeholder constraints. Missing filenames and template paths have real defaults and are not errors. |
| comb_test_texts | none-safe | Contains only a generic test failure and module labels; no usable input grammar or parameter constraints. |
| sof_cs_analysis | none-safe | Matches the earlier shared CSA analysis resource: computed capacities, material/work-law availability and derived plastic-hinge response. The single-P-level message does not identify an exact triggering hinge type; the missing P-level message explicitly uses a runtime default. |

STAR NSTR bounds use the shared general rules instead of duplicate diagnostics.

SHEARWALL CHCK legacy safety fields remain deferred: the current manual documents only STAT, so their backend use is not confirmed.

ASE GRP2 native ERR 666/946 remain deferred: the 2026 manual combines these factors; the actual triggering modes are unverified.
