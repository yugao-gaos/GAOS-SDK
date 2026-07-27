#!/usr/bin/env node
import { runVerifyCli } from './verify-cli.js';
import { runBenchmarkCli } from './benchmark-cli.js';
import { runVerifierKitCli } from './verifier-kit-cli.js';

const args = process.argv.slice(2);
process.exitCode = args[0] === 'benchmark'
  ? await runBenchmarkCli(args)
  : args[0] === 'verifier'
    ? await runVerifierKitCli(args)
  : await runVerifyCli(args);
