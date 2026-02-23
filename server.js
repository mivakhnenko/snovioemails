const express = require('express');
const https = require('https');
const fs = require('fs');
const path = require('path');

const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

const PORT = process.env.PORT || 3000;
const DATA_FILE = path.join(__dirname, 'data.json');

// SendPulse credentials (from environment variables or fallback for local dev)
const SP_CLIENT_ID = process.env.SP_CLIENT_ID || '11aac0b4113b6f096c419464573da363';
const SP_CLIENT_SECRET = process.env.SP_CLIENT_SECRET || '7f81749453948cda9469449576f43637';

// --- Data persistence ---
function loadData() {
  try {
    return JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
  } catch {
    return { postmaster: [], campaigns: [], automations: [], lastSyncDate: null, lastA360SyncDate: null };
  }
}

function saveData(data) {
  fs.writeFileSync(DATA_FILE, JSON.stringify(data, null, 2));
}

// --- SendPulse API helpers ---
let spToken = null;
let spTokenExpiry = 0;

function spRequest(options, postData) {
  return new Promise((resolve, reject) => {
    const req = https.request(options, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try { resolve({ status: res.statusCode, data: JSON.parse(data) }); }
        catch { resolve({ status: res.statusCode, data }); }
      });
    });
    req.on('error', reject);
    if (postData) req.write(postData);
    req.end();
  });
}

async function getToken() {
  if (spToken && Date.now() < spTokenExpiry) return spToken;
  const body = JSON.stringify({
    grant_type: 'client_credentials',
    client_id: SP_CLIENT_ID,
    client_secret: SP_CLIENT_SECRET
  });
  const res = await spRequest({
    hostname: 'api.sendpulse.com',
    path: '/oauth/access_token',
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) }
  }, body);
  if (res.status !== 200) throw new Error('SendPulse auth failed');
  spToken = res.data.access_token;
  spTokenExpiry = Date.now() + (res.data.expires_in - 60) * 1000;
  return spToken;
}

async function spGet(apiPath) {
  const token = await getToken();
  return spRequest({
    hostname: 'api.sendpulse.com',
    path: apiPath,
    method: 'GET',
    headers: { 'Authorization': `Bearer ${token}` }
  });
}

// --- API Routes ---

// Sync campaigns from SendPulse
app.post('/api/sync-campaigns', async (req, res) => {
  try {
    const data = loadData();
    let allCampaigns = [];
    let offset = 0;
    const limit = 100;

    while (true) {
      const result = await spGet(`/campaigns?limit=${limit}&offset=${offset}`);
      if (!Array.isArray(result.data) || result.data.length === 0) break;
      allCampaigns = allCampaigns.concat(result.data);
      if (result.data.length < limit) break;
      offset += limit;
    }

    // Process campaigns
    const processed = allCampaigns
      .filter(c => c.statistics && c.statistics.sent > 0)
      .map(c => {
        const s = c.statistics;
        const sent = s.sent || 0;
        const delivered = s.delivered || 0;
        const bounced = s.error || 0;
        return {
          id: c.id,
          source: 'campaign',
          name: c.name,
          sendDate: c.send_date,
          senderEmail: c.message?.sender_email || '',
          subject: c.message?.subject || c.name,
          sent,
          delivered,
          opens: s.opening || 0,
          clicks: s.link_redirected || 0,
          unsubscribes: s.unsubscribe || 0,
          bounced,
          openRate: delivered > 0 ? ((s.opening / delivered) * 100) : 0,
          clickRate: delivered > 0 ? ((s.link_redirected / delivered) * 100) : 0,
          bounceRate: sent > 0 ? ((bounced / sent) * 100) : 0,
          unsubRate: delivered > 0 ? ((s.unsubscribe / delivered) * 100) : 0,
        };
      })
      .sort((a, b) => b.sendDate.localeCompare(a.sendDate));

    data.campaigns = processed;
    data.lastSyncDate = new Date().toISOString();
    saveData(data);

    res.json({
      success: true,
      totalCampaigns: processed.length,
      lastSync: data.lastSyncDate
    });
  } catch (err) {
    console.error('Sync error:', err);
    res.status(500).json({ error: err.message });
  }
});

// Sync Automation 360 flows from SendPulse
app.post('/api/sync-automations', async (req, res) => {
  try {
    const data = loadData();

    // Get all A360 flows
    const a360List = await spGet('/a360/autoresponders/list');
    const flows = a360List.data?.data || [];

    // Get details for each flow (has starts, send_messages, email steps)
    const automations = [];
    for (const flow of flows) {
      try {
        const detail = await spGet(`/a360/autoresponders/${flow.id}`);
        const d = detail.data;
        const emailSteps = (d.flows || []).filter(f => f.af_type === 'email');
        automations.push({
          id: flow.id,
          name: d.autoresponder?.name || flow.main_data?.automation_name || flow.name || `Flow ${flow.id}`,
          status: flow.status === 1 ? 'active' : flow.status === 3 ? 'stopped' : 'draft',
          statusCode: flow.status,
          senderEmail: flow.main_data?.sender_email_address || '',
          senderName: flow.main_data?.sender_email_name || '',
          created: d.autoresponder?.created || flow.created,
          starts: d.starts || 0,
          inQueue: d.in_queue || 0,
          endCount: d.end_count || 0,
          sendMessages: d.send_messages || 0,
          conversions: d.conversions || 0,
          emailStepCount: emailSteps.length,
          emailSteps: emailSteps.map(s => ({
            id: s.id,
            subject: s.task?.message_title || '',
            lastSend: s.last_send,
            sender: s.task?.sender_mail_address || '',
          })),
          lastActivity: emailSteps.reduce((latest, s) => {
            if (s.last_send && (!latest || s.last_send > latest)) return s.last_send;
            return latest;
          }, null),
        });
      } catch (e) {
        console.error(`Failed to fetch flow ${flow.id}:`, e.message);
      }
    }

    automations.sort((a, b) => (b.lastActivity || '').localeCompare(a.lastActivity || ''));
    data.automations = automations;
    data.lastA360SyncDate = new Date().toISOString();
    saveData(data);

    const activeCount = automations.filter(a => a.status === 'active').length;
    res.json({
      success: true,
      totalFlows: automations.length,
      activeFlows: activeCount,
      lastSync: data.lastA360SyncDate
    });
  } catch (err) {
    console.error('A360 sync error:', err);
    res.status(500).json({ error: err.message });
  }
});

// Get all data
app.get('/api/data', (req, res) => {
  res.json(loadData());
});

// Save postmaster weekly entry
app.post('/api/postmaster', (req, res) => {
  const data = loadData();
  const entry = req.body;
  // Use weekEnding as the key
  const idx = data.postmaster.findIndex(p => p.weekEnding === entry.weekEnding);
  if (idx >= 0) {
    data.postmaster[idx] = entry;
  } else {
    data.postmaster.push(entry);
  }
  data.postmaster.sort((a, b) => b.weekEnding.localeCompare(a.weekEnding));
  saveData(data);
  res.json({ success: true });
});

// Bulk import postmaster entries (replaces all)
app.post('/api/postmaster/bulk', (req, res) => {
  try {
    const entries = req.body;
    if (!Array.isArray(entries)) return res.status(400).json({ error: 'Expected array of entries' });
    const data = loadData();
    entries.forEach(entry => {
      const idx = data.postmaster.findIndex(p => p.weekEnding === entry.weekEnding);
      if (idx >= 0) data.postmaster[idx] = entry;
      else data.postmaster.push(entry);
    });
    data.postmaster.sort((a, b) => b.weekEnding.localeCompare(a.weekEnding));
    saveData(data);
    res.json({ success: true, count: data.postmaster.length });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Delete postmaster entry
app.delete('/api/postmaster/:weekEnding', (req, res) => {
  const data = loadData();
  data.postmaster = data.postmaster.filter(p => p.weekEnding !== req.params.weekEnding);
  saveData(data);
  res.json({ success: true });
});

app.listen(PORT, () => {
  console.log(`\n  Snov.io Deliverability Dashboard running at:\n`);
  console.log(`  http://localhost:${PORT}\n`);
});
