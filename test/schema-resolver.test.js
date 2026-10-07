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
