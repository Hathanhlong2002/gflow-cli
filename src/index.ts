#!/usr/bin/env node
import { runCli } from "./cli.js";

try {
  process.loadEnvFile();
} catch {
  // .env is optional if environment variables are already set in process.env
}

const exitCode = await runCli(process.argv);
process.exitCode = exitCode;
