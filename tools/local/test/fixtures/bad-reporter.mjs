// A "browser" that sends malformed / wrong-token reports to the probe URL's
// report endpoint, then a valid-looking but schema-invalid profile, then stops.
const page = new URL(process.argv[2]);
const report = page.searchParams.get('report');
const token = page.searchParams.get('token');
const post = (body) => fetch(report, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body });
const results = [];
results.push((await post('not json')).status);
results.push((await post(JSON.stringify({ type: 'profile', token: 'wrong', profile: {} }))).status);
results.push((await post(JSON.stringify({ type: 'profile', token, profile: { schema: 'wgm-device-profile', version: 1 } }))).status);
if (process.env.STANDIN_LOG) (await import('node:fs')).appendFileSync(process.env.STANDIN_LOG, JSON.stringify({ statuses: results }) + '\n');
setTimeout(() => {}, 600_000);
