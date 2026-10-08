"use strict";

const assert = require("node:assert/strict");
const { test } = require("node:test");
const { SchemaResolver } = require("../lib/schema-resolver");
const { provider } = require("@lumine-code/sofistik-schema");

test("uses aliases and exact module override before BASIC fallback", () => {
  const resolver = new SchemaResolver(provider().forRelease("2026", "en"));
  assert.ok(resolver.lookup("STAR2", "CTRL"));
  assert.equal(resolver.lookup("ASE", "PAGE").owner, "BASIC");
  assert.equal(resolver.lookup("AQB", "CTRL").owner, "AQB");
  assert.equal(resolver.lookup(null, "PAGE"), null);
  assert.equal(resolver.lookup("AQUA", "not-a-command"), null);
});

test("conservatively leaves enum/item collisions unclassified", () => {
  const schema = {
    forms: [
      {
        slots: [
          { name: "TYPE", enumValues: ["OTHER"] },
          { name: "OTHER", enumValues: [] },
        ],
      },
    ],
  };
  const resolver = new SchemaResolver({ getCommandSchema: () => schema });
  const tokens = [
    { type: "word", value: "TYPE", start: 0, end: 4, depth: 0 },
    { type: "word", value: "OTHER", start: 5, end: 10, depth: 0 },
    { type: "word", value: "1", start: 11, end: 12, depth: 0 },
  ];
  const resolved = resolver.resolve(tokens, { module: "M", command: "C" });
  assert.equal(resolved.confidence, false);
  assert.equal(resolved.assignments[1].ambiguous, true);
  assert.equal(resolved.assignments[2].param, null);
  assert.equal(resolved.assignments[2].activeParameter, null);
});

test("a named parameter recovers after a dangling comma without consuming another list value", () => {
  const resolver = new SchemaResolver(provider().forRelease("2026", "en"));
  for (const record of ["QGRP 51, TYPE DTXY 2", "QGRP 51,TYPE DTXY 2", "QGRP 51,\tTYPE=DTXY 2"]) {
    const tokens = [...record.matchAll(/[A-Za-z0-9_]+|[,=]/g)].map((match) => ({
      type: match[0] === "," ? "comma" : match[0] === "=" ? "equals" : "word",
      value: match[0],
      start: match.index,
      end: match.index + match[0].length,
      depth: 0,
    }));
    const resolved = resolver.resolve(tokens, { module: "SOFILOAD", command: "AREA" });
    const assignment = (value) => resolved.assignments.find((item) => item.token.value === value);
    assert.equal(assignment(",").param, "NO", record);
    assert.equal(assignment("TYPE").role, "param", record);
    assert.equal(assignment("DTXY").param, "TYPE", record);
    assert.equal(assignment("DTXY").activeParameter, 10, record);
    assert.equal(assignment("2").param, "P1", record);
    assert.equal(resolved.awaitingListValue, false, record);
  }
});
