#!/usr/bin/env node
import { runVerifyCli } from './verify-cli.js';

process.exitCode = await runVerifyCli(process.argv.slice(2));
