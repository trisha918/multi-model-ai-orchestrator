#!/usr/bin/env node
import process from 'node:process';
import { main } from '../src/cli.mjs';

const code = await main(process.argv.slice(2));
if (typeof code === 'number' && code !== 0) process.exit(code);
