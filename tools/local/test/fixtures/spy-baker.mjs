// Records that it was started (SPY_MARKER file), then behaves like a failing baker.
import { appendFileSync } from 'node:fs';
appendFileSync(process.env.SPY_MARKER, JSON.stringify({ t: Date.now(), argv: process.argv.slice(2) }) + '\n');
process.stdout.write(JSON.stringify({ event: 'error', code: 'internal', exitCode: 1, message: 'spy baker' }) + '\n');
process.exit(1);
