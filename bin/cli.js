#!/usr/bin/env node

const { startServer } = require("../lib/server");

if (process.argv.includes("--version")) {
  process.stdout.write(`${require("../package.json").version}\n`);
} else if (process.argv.includes("--help")) {
  process.stdout.write("Usage: sofistik-language-server --stdio\n");
} else {
  startServer();
}
