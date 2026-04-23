require('dotenv').config();
const express = require('express');
const cors = require('cors');
const fetch = require('node-fetch');
const path = require('path');

const app = express();
app.use(cors());
app.use(express.json({ limit: '20mb' })); // allow base64 image payloads
app.use(express.static(path.join(__dirname, 'public')));

const AIRTABLE_TOKEN = process.env.AIRTABLE_TOKEN;
const BASE_ID = process.env.AIRTABLE_BASE_ID;
const XAI_API_KEY = process.env.XAI_API_KEY;

// ── Health check ─────────────────────────────────────────────────────────────
app.get('/api/health', (req, res) => res.json({ status: 'ok' }));

// ── Airtable: search a table ──────────────────────────────────────────────────
// GET /api/airtable/:table?query=...
app.get('/api/airtable/:table', async (req, res) => {
  const { table } = req.params;
  const { query } = req.query;

  try {
    const url = `https://api.airtable.com/v0/${BASE_ID}/${encodeURIComponent(table)}`;
    const response = await fetch(url, {
      headers: { Authorization: `Bearer ${AIRTABLE_TOKEN}` },
    });

    if (!response.ok) {
      const text = await response.text();
      return res.status(response.status).json({ error: text });
    }

    const data = await response.json();
    const records = data.records || [];

    if (!query) return res.json({ records });

    // Filter records by query string
    const queryLower = query.toLowerCase();
    const matched = records
      .map((record) => {
        let score = 0;
        Object.keys(record.fields).forEach((key) => {
          const value = String(record.fields[key]).toLowerCase();
          if (value.includes(queryLower)) {
            score += key === 'Name' ? 10 : 5;
          }
        });
        return { ...record, score, confidence: Math.min(95, score * 10) };
      })
      .filter((r) => r.score > 0)
      .sort((a, b) => b.score - a.score);

    res.json({ records: matched });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── xAI: analyze photo for Re-Discover mode ───────────────────────────────────
// POST /api/xai/describe  { base64: "data:image/...;base64,..." }
app.post('/api/xai/describe', async (req, res) => {
  const { base64 } = req.body;
  if (!base64) return res.status(400).json({ error: 'base64 image required' });

  try {
    const response = await fetch('https://api.x.ai/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${XAI_API_KEY}`,
      },
      body: JSON.stringify({
        model: 'grok-2-vision-1212',
        messages: [
          {
            role: 'user',
            content: [
              { type: 'image_url', image_url: { url: base64 } },
              {
                type: 'text',
                text: 'Analyze this archaeological artifact or fragment. Provide a concise description including: material, time period, cultural origin, and distinctive features. Focus on searchable keywords.',
              },
            ],
          },
        ],
        max_tokens: 300,
      }),
    });

    const data = await response.json();
    if (!response.ok) return res.status(response.status).json({ error: data });
    res.json({ result: data.choices[0].message.content });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── xAI: full artifact analysis for Discover mode ────────────────────────────
// POST /api/xai/analyze  { base64: "...", outputMode: "detailed"|"concise"|"kids" }
app.post('/api/xai/analyze', async (req, res) => {
  const { base64, outputMode = 'detailed' } = req.body;
  if (!base64) return res.status(400).json({ error: 'base64 image required' });

  const systemPrompts = {
    detailed:
      'You are an expert archaeological analyst specializing in artifact identification. When analyzing pottery fragments or archaeological items, focus on: material composition, manufacturing technique, historical period, cultural attribution, and archaeological significance. Provide detailed technical analysis suitable for professional archaeologists. For fragmentary material, work with 70% confidence thresholds as acceptable for field identification.',
    concise:
      'You are an archaeological consultant. Provide clear, accurate artifact identification focusing on: what it is, when it was made, who made it, and why it matters. Keep responses concise but informative.',
    kids: 'You are a friendly museum guide helping students learn about ancient artifacts. Explain what the artifact is, when people made it, and why it was important to them. Use simple language and make it interesting!',
  };

  try {
    const response = await fetch('https://api.x.ai/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${XAI_API_KEY}`,
      },
      body: JSON.stringify({
        model: 'grok-2-vision-1212',
        messages: [
          { role: 'system', content: systemPrompts[outputMode] || systemPrompts.detailed },
          {
            role: 'user',
            content: [
              { type: 'image_url', image_url: { url: base64 } },
              { type: 'text', text: 'Analyze this archaeological artifact or fragment.' },
            ],
          },
        ],
        max_tokens: 1000,
      }),
    });

    const data = await response.json();
    if (!response.ok) return res.status(response.status).json({ error: data });
    res.json({ result: data.choices[0].message.content });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`ArchPAL backend running on http://localhost:${PORT}`));
