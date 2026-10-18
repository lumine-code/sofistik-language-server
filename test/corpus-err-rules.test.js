"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");
const { LintEngine } = require("../lib/lint-engine");
const { preprocess } = require("../lib/preprocessor");
const { codeFor } = require("../lib/lint-codes");
const registry = require("../lib/err-rules.json");

const uri = "file:///corpus-module-regression.dat";

async function findings(body, module, language, version) {
  const end = language === "de" ? "ENDE" : "END";
  const head = language === "de" ? "KOPF" : "HEAD";
  const text = `+PROG ${module}\n${head} Corpus regression\n${body}\n${end}\n`;
  const expanded = await preprocess({ uri, text });
  return new LintEngine().analyze({ ...expanded, uri, language, version }).diagnostics;
}

test("ASE multi-step LCST storage follows the documented time-step sequence", async () => {
  assert.equal(codeFor("ase-step-storage-single-step"), "AS001");
  for (const version of registry.releases) {
    for (const language of ["en", "de"]) {
      const storage = language === "de" ? "LFSP" : "LCST";
      const maxima = language === "de" ? "LFSM" : "LCSM";
      for (const body of [
        `STEP N 100 DT 0.01 ${storage} 1001`,
        `STEP N 50 DT 0.02 ${storage} 1002 SELE 1+4+8+64 ${maxima} 9900 THE 0.70`,
        `STEP N 40 DT 0.05 THE 0.70 ${storage} CONT SELE 1+4+8+64 ${maxima} 9900`,
      ]) {
        const result = await findings(body, "ASE", language, version);
        assert.equal(
          result.some(({ code }) => code === "ase-step-storage-single-step"),
          false,
        );
      }
    }
  }
});

test("RESULTS bare JOIN is valid while a specified column still needs its counterpart", async () => {
  for (const version of registry.releases) {
    for (const language of ["en", "de"]) {
      const first = language === "de" ? "SPA1" : "COL1";
      const second = language === "de" ? "SPA2" : "COL2";
      for (const body of ["JOIN", `JOIN ${first} 'n_disp.kwl' ${second} 'lc_ctrl._enr'\nJOIN`]) {
        const result = await findings(body, "RESULTS", language, version);
        assert.equal(
          result.some(({ code }) => code === "results-join-columns"),
          false,
        );
      }
      for (const body of [`JOIN ${first} 'n_disp.kwl'`, `JOIN ${second} 'lc_ctrl._enr'`]) {
        const result = await findings(body, "RESULTS", language, version);
        assert.ok(result.some(({ code }) => code === "results-join-columns"));
      }
    }
  }
});

test("CSM EQIT allows the documented positive acceleration factor above one", async () => {
  assert.equal(codeFor("csm-equilibrium-max-factor"), "CM002");
  for (const version of ["2022", "2023", "2024", "2025", "2026"]) {
    for (const language of ["en", "de"]) {
      for (const body of ["EQIT 20 FMAX 1.5", "EQIT 5 COPY 80000 FMAX 2.0", "EQIT 20 FMAX -0.7"]) {
        const result = await findings(body, "CSM", language, version);
        assert.equal(
          result.some(({ code }) => code === "csm-equilibrium-max-factor"),
          false,
        );
      }
    }
  }
});

test("TEXTILE E1/E2 identify rows, whereas S1/S2 specify the matrix size", async () => {
  for (const version of registry.releases) {
    for (const language of ["en", "de"]) {
      for (const type of ["E1", "E2"]) {
        const result = await findings(
          `COMP ${type} 1 3.0 4.0 4.5 5.0`,
          "TEXTILE",
          language,
          version,
        );
        assert.equal(
          result.some(({ code }) => code === "textile-comp-matrix-count"),
          false,
        );
      }
      for (const type of ["S1", "S2"]) {
        for (const count of [1, 11]) {
          const result = await findings(`COMP ${type} ${count} 0.0`, "TEXTILE", language, version);
          assert.ok(result.some(({ code }) => code === "textile-comp-matrix-count"));
        }
        for (const count of [2, 10]) {
          const result = await findings(`COMP ${type} ${count} 0.0`, "TEXTILE", language, version);
          assert.equal(
            result.some(({ code }) => code === "textile-comp-matrix-count"),
            false,
          );
        }
      }
    }
  }
});

test("SOFiMSHC negative GDIV permits group bases in automatic numbering mode", async () => {
  for (const version of registry.releases) {
    for (const language of ["en", "de"]) {
      const group = language === "de" ? "GRUP NR" : "GRP NO";
      for (const divisor of [-10000, 0]) {
        const result = await findings(
          `SYST SPAC GDIV ${divisor}\n${group} 1 BASE 10000`,
          "SOFIMSHC",
          language,
          version,
        );
        assert.equal(
          result.some(({ code }) => code === "sofimshc-grp-base-gdiv"),
          false,
        );
      }
      const result = await findings(
        `SYST SPAC GDIV 1000\n${group} 1 BASE 100`,
        "SOFIMSHC",
        language,
        version,
      );
      assert.ok(result.some(({ code }) => code === "sofimshc-grp-base-gdiv"));
    }
  }
});

test("SOFiMSHC properties can reference a stored axis by ID, including table defaults", async () => {
  for (const version of registry.releases) {
    for (const language of ["en", "de"]) {
      const type = language === "de" ? "TYP" : "TYPE";
      for (const body of [
        "GAXS A1 IDS A Y 4.0 Z VAR1 SPT 10",
        `GAXP 'A1' S 0.0 ${type} 'S'`,
        `GAXV S V ${type} ID='AX_1' NAME='HEIGHT'\n0 1.20 -\n20 1.20 D+`,
      ]) {
        const result = await findings(body, "SOFIMSHC", language, version);
        assert.equal(
          result.some(({ code }) => code === "sof-gax-property-context"),
          false,
        );
      }
      const implicit = await findings("GAXA S 0 X 0 Y 0", "SOFIMSHC", language, version);
      assert.ok(implicit.some(({ code }) => code === "sof-gax-property-context"));
    }
  }
});
