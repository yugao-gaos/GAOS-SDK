#!/usr/bin/env node
import { runVerifyCli } from './verify-cli.js';
import { runBenchmarkCli } from './benchmark-cli.js';

const args = process.argv.slice(2);
process.exitCode = args[0] === 'benchmark'
  ? await runBenchmarkCli(args)
  : await runVerifyCli(args);
