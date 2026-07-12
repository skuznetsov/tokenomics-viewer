#!/usr/bin/env node
"use strict";

const { runLauncher } = require("./lib/launcher");

runLauncher(process.argv.slice(2)).then(
  (code) => { process.exitCode = code; },
  (error) => {
    console.error(error.message);
    process.exitCode = 1;
  },
);
