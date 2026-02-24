/**
 * import_a360_stats.js
 *
 * Parses SendPulse A360 flow CSV exports and pushes per-email stats
 * to the Snov.io Deliverability Dashboard.
 *
 * Usage:
 *   node import_a360_stats.js [folder] [dashboard-url]
 *
 * Defaults:
 *   folder:        ./a360-exports
 *   dashboard-url: http://localhost:3000
 *
 * The script auto-detects the date range from filenames (e.g., 2026-01-25_...).
 * Each import is stored as a dated snapshot. Repeated imports for the same
 * period replace the previous snapshot. Different periods accumulate, enabling
 * the dashboard to show 30d / 90d / 6m / 1y / all-time views.
 *
 * Workflow:
 *   1. Export per-flow CSV reports from SendPulse A360 UI
 *   2. Drop them all into the a360-exports/ folder
 *   3. Run this script
 *   4. Dashboard shows the engagement stats
 */

const fs = require('fs');
const path = require('path');
const http = require('http');
const https = require('https');

const FOLDER = process.argv[2] || path.join(__dirname, 'a360-exports');
const BASE_URL = process.argv[3] || 'http://localhost:3000';
const PASSWORD = process.env.DASHBOARD_PASS || 'snovio360';

// --- Semicolon-delimited CSV parser ---
// Handles two SendPulse formats:
//   Format A (raw):   ;Title;Sent;Delivered;...
//   Format B (quoted): ";Title;Sent;Delivered;..."  (each line wrapped in outer quotes)
function parseSemicolonCSV(text) {
  // Strip BOM
  if (text.charCodeAt(0) === 0xFEFF) text = text.substring(1);

  const rows = [];
  const lines = text.split(/\r?\n/);

  for (let rawLine of lines) {
    rawLine = rawLine.trim();
    if (!rawLine) continue;

    // Format B: entire line is wrapped in outer quotes — strip them
    if (rawLine.startsWith('"') && rawLine.endsWith('"')) {
      // Check if it's truly a whole-line wrapper (not just a quoted first field)
      // Heuristic: if removing outer quotes gives us a valid semicolon-delimited line, use it
      const inner = rawLine.substring(1, rawLine.length - 1);
      // Replace escaped "" with a placeholder, then check if there are unmatched quotes
      const testStr = inner.replace(/""/g, '\x00');
      if (!testStr.includes('"')) {
        // It's a whole-line wrapper. Restore escaped quotes and parse the inner string
        rawLine = inner.replace(/""/g, '"');
      }
    }

    const fields = [];
    let i = 0;
    const line = rawLine;
    while (i <= line.length) {
      if (i === line.length) {
        fields.push('');
        break;
      }
      if (line[i] === '"') {
        // Quoted field
        let val = '';
        i++;
        while (i < line.length) {
          if (line[i] === '"') {
            if (line[i + 1] === '"') {
              val += '"';
              i += 2;
            } else {
              i++;
              break;
            }
          } else {
            val += line[i];
            i++;
          }
        }
        fields.push(val);
        if (i < line.length && line[i] === ';') i++;
      } else {
        const next = line.indexOf(';', i);
        if (next === -1) {
          fields.push(line.substring(i));
          break;
        } else {
          fields.push(line.substring(i, next));
          i = next + 1;
        }
      }
    }
    rows.push(fields);
  }
  return rows;
}

// --- Extract flow name from filename ---
function flowNameFromFile(filename) {
  let name = filename.replace(/\.csv$/i, '');

  // Strip date prefix(es) like 2026-01-25_ or 2026-01-25_2026-02-24_
  name = name.replace(/^\d{4}-\d{2}-\d{2}_(\d{4}-\d{2}-\d{2}_)?/, '');

  // Strip common test prefixes
  name = name.replace(/^testt\s*-\s*/i, '');

  // Strip trailing " (1)" etc from duplicate filenames
  name = name.replace(/\s*\(\d+\)$/, '');

  // Clean up underscores and multiple spaces
  name = name.replace(/_/g, ' ').replace(/\s+/g, ' ').trim();

  return name;
}

// --- Detect period from filenames ---
function detectPeriod(filenames) {
  // Look for date patterns in filenames
  const dates = [];
  for (const f of filenames) {
    // Match YYYY-MM-DD at start
    const m = f.match(/^(\d{4}-\d{2}-\d{2})/);
    if (m) dates.push(m[1]);
    // Match second date if present: 2026-01-25_2026-02-24_...
    const m2 = f.match(/^\d{4}-\d{2}-\d{2}_(\d{4}-\d{2}-\d{2})_/);
    if (m2) dates.push(m2[1]);
  }
  if (dates.length === 0) return { periodStart: null, periodEnd: null };

  dates.sort();
  const earliest = dates[0];
  const latest = dates[dates.length - 1];

  // If we found an explicit end date (from double-date filename), use it
  // Otherwise, assume 30-day window from the start date
  const starts = new Set();
  const ends = new Set();
  for (const f of filenames) {
    const m2 = f.match(/^(\d{4}-\d{2}-\d{2})_(\d{4}-\d{2}-\d{2})_/);
    if (m2) { starts.add(m2[1]); ends.add(m2[2]); }
    else {
      const m1 = f.match(/^(\d{4}-\d{2}-\d{2})_/);
      if (m1) starts.add(m1[1]);
    }
  }

  const periodStart = [...starts].sort()[0] || earliest;
  let periodEnd;
  if (ends.size > 0) {
    periodEnd = [...ends].sort().pop();
  } else {
    // Default: 30 days after start
    const d = new Date(periodStart);
    d.setDate(d.getDate() + 30);
    periodEnd = d.toISOString().substring(0, 10);
  }

  return { periodStart, periodEnd };
}

// --- Parse one CSV file ---
function parseFlowCSV(filePath) {
  const text = fs.readFileSync(filePath, 'utf8');
  const rows = parseSemicolonCSV(text);

  if (rows.length === 0) return null;

  // First row is header
  const header = rows[0];
  const headerLower = header.map(h => h.toLowerCase().trim());
  const colIdx = {
    type: 0,
    title: headerLower.indexOf('title'),
    sent: headerLower.indexOf('sent'),
    delivered: headerLower.indexOf('delivered'),
    read: headerLower.indexOf('read'),
    redirects: headerLower.indexOf('redirects'),
    unsubscribed: headerLower.indexOf('unsubscribed'),
    spam: headerLower.indexOf('marked as spam'),
    errors: headerLower.indexOf('errors'),
  };

  if (colIdx.sent === -1 || colIdx.delivered === -1 || colIdx.read === -1) {
    console.warn(`  ⚠ Skipping ${path.basename(filePath)}: couldn't find Sent/Delivered/Read columns`);
    return null;
  }

  let flowStartLabel = null;
  let flowStarts = 0;
  const emails = [];

  for (let r = 1; r < rows.length; r++) {
    const row = rows[r];
    const rowType = (row[colIdx.type] || '').trim();

    if (rowType === 'Flow start') {
      flowStartLabel = (row[colIdx.title] || '').trim();
      const startVal = (row[colIdx.sent] || '').trim();
      flowStarts = (startVal !== 'NULL' && startVal !== '') ? parseInt(startVal, 10) || 0 : 0;
      continue;
    }

    if (rowType !== 'Email') continue;

    const num = (idx) => {
      if (idx === -1) return 0;
      const v = (row[idx] || '').trim();
      if (v === 'NULL' || v === '' || v === '-') return 0;
      return parseInt(v, 10) || 0;
    };

    const sent = num(colIdx.sent);
    const delivered = num(colIdx.delivered);
    const opens = num(colIdx.read);
    const clicks = num(colIdx.redirects);
    const unsubscribes = num(colIdx.unsubscribed);
    const spam = num(colIdx.spam);
    const errors = num(colIdx.errors);

    emails.push({
      subject: (row[colIdx.title] || '').trim(),
      sent,
      delivered,
      opens,
      clicks,
      unsubscribes,
      spam,
      errors,
      openRate: delivered > 0 ? parseFloat(((opens / delivered) * 100).toFixed(2)) : 0,
      clickRate: delivered > 0 ? parseFloat(((clicks / delivered) * 100).toFixed(2)) : 0,
      bounceRate: sent > 0 ? parseFloat(((errors / sent) * 100).toFixed(2)) : 0,
      unsubRate: delivered > 0 ? parseFloat(((unsubscribes / delivered) * 100).toFixed(2)) : 0,
      spamRate: delivered > 0 ? parseFloat(((spam / delivered) * 100).toFixed(3)) : 0,
    });
  }

  if (emails.length === 0) return null;

  // Flow-level aggregates
  const totalSent = emails.reduce((s, e) => s + e.sent, 0);
  const totalDelivered = emails.reduce((s, e) => s + e.delivered, 0);
  const totalOpens = emails.reduce((s, e) => s + e.opens, 0);
  const totalClicks = emails.reduce((s, e) => s + e.clicks, 0);
  const totalUnsubs = emails.reduce((s, e) => s + e.unsubscribes, 0);
  const totalSpam = emails.reduce((s, e) => s + e.spam, 0);
  const totalErrors = emails.reduce((s, e) => s + e.errors, 0);

  return {
    flowName: flowNameFromFile(path.basename(filePath)),
    flowStartLabel: flowStartLabel || '',
    flowStarts,
    emailCount: emails.length,
    emails,
    totalSent,
    totalDelivered,
    totalOpens,
    totalClicks,
    totalUnsubs,
    totalSpam,
    totalErrors,
    overallOpenRate: totalDelivered > 0 ? parseFloat(((totalOpens / totalDelivered) * 100).toFixed(2)) : 0,
    overallClickRate: totalDelivered > 0 ? parseFloat(((totalClicks / totalDelivered) * 100).toFixed(2)) : 0,
    overallBounceRate: totalSent > 0 ? parseFloat(((totalErrors / totalSent) * 100).toFixed(2)) : 0,
    overallUnsubRate: totalDelivered > 0 ? parseFloat(((totalUnsubs / totalDelivered) * 100).toFixed(2)) : 0,
    overallSpamRate: totalDelivered > 0 ? parseFloat(((totalSpam / totalDelivered) * 100).toFixed(3)) : 0,
  };
}

// --- HTTP helper ---
function httpRequest(url, method, body, headers = {}) {
  return new Promise((resolve, reject) => {
    const parsed = new URL(url);
    const mod = parsed.protocol === 'https:' ? https : http;
    const data = body ? JSON.stringify(body) : null;
    const opts = {
      hostname: parsed.hostname,
      port: parsed.port,
      path: parsed.pathname + parsed.search,
      method,
      headers: {
        'Content-Type': 'application/json',
        ...(data ? { 'Content-Length': Buffer.byteLength(data) } : {}),
        ...headers,
      },
    };
    const req = mod.request(opts, (res) => {
      let body = '';
      res.on('data', c => body += c);
      res.on('end', () => {
        try { resolve({ status: res.statusCode, data: JSON.parse(body) }); }
        catch { resolve({ status: res.statusCode, data: body }); }
      });
    });
    req.on('error', reject);
    if (data) req.write(data);
    req.end();
  });
}

// --- Main ---
async function main() {
  console.log('\n  Snov.io A360 Stats Importer\n');

  if (!fs.existsSync(FOLDER)) {
    console.error(`  ✗ Folder not found: ${FOLDER}`);
    console.error(`    Create it and drop your SendPulse CSV exports there.\n`);
    process.exit(1);
  }

  const csvFiles = fs.readdirSync(FOLDER).filter(f => f.toLowerCase().endsWith('.csv'));
  if (csvFiles.length === 0) {
    console.error(`  ✗ No .csv files found in ${FOLDER}\n`);
    process.exit(1);
  }

  console.log(`  Found ${csvFiles.length} CSV file(s) in ${FOLDER}\n`);

  // Detect period from filenames
  const { periodStart, periodEnd } = detectPeriod(csvFiles);
  if (periodStart) {
    console.log(`  Period detected: ${periodStart} → ${periodEnd}\n`);
  }

  // Parse all files
  const flows = [];
  let totalEmails = 0;
  let skipped = 0;
  let zeroSendFlows = 0;

  for (const file of csvFiles) {
    const filePath = path.join(FOLDER, file);
    try {
      const result = parseFlowCSV(filePath);
      if (result) {
        flows.push(result);
        totalEmails += result.emailCount;
        if (result.totalSent === 0) {
          zeroSendFlows++;
          console.log(`  ○ ${result.flowName} — ${result.emailCount} emails, 0 sent (no triggers this period)`);
        } else {
          console.log(`  ✓ ${result.flowName} — ${result.emailCount} emails, ${result.totalSent.toLocaleString()} sent, ${result.overallOpenRate}% open`);
        }
      } else {
        skipped++;
        console.log(`  - ${file} — no email rows found, skipped`);
      }
    } catch (err) {
      skipped++;
      console.error(`  ✗ ${file} — parse error: ${err.message}`);
    }
  }

  const activeSendFlows = flows.filter(f => f.totalSent > 0).length;
  console.log(`\n  Summary: ${flows.length} flows parsed (${activeSendFlows} with sends, ${zeroSendFlows} dormant), ${totalEmails} emails total${skipped ? `, ${skipped} skipped` : ''}\n`);

  if (flows.length === 0) {
    console.log('  Nothing to import.\n');
    process.exit(0);
  }

  // Authenticate and push
  console.log(`  Pushing to ${BASE_URL}...`);
  try {
    const authRes = await httpRequest(`${BASE_URL}/api/auth`, 'POST', { password: PASSWORD });
    if (authRes.status !== 200 || !authRes.data.token) {
      console.error(`  ✗ Authentication failed. Check DASHBOARD_PASS.\n`);
      process.exit(1);
    }

    const token = authRes.data.token;
    const snapshot = {
      importDate: new Date().toISOString(),
      periodStart: periodStart || null,
      periodEnd: periodEnd || null,
      periodDays: 30,
      flows,
    };

    const res = await httpRequest(
      `${BASE_URL}/api/a360-stats`,
      'POST',
      snapshot,
      { 'x-auth-token': token }
    );

    if (res.status === 200) {
      console.log(`  ✓ Imported ${flows.length} flows (${totalEmails} emails) for period ${periodStart} → ${periodEnd}`);
      console.log(`  ${res.data.totalSnapshots || 1} snapshot(s) stored in dashboard\n`);
    } else {
      console.error(`  ✗ Server error ${res.status}: ${JSON.stringify(res.data)}\n`);
    }
  } catch (err) {
    console.error(`  ✗ Connection error: ${err.message}`);
    console.error(`    Make sure the dashboard server is running at ${BASE_URL}\n`);
    process.exit(1);
  }
}

main();
