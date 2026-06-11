'use strict';
/**
 * Minel Avvikssystem – server.js  v2.1
 * Krever Node.js 22+. Null npm-avhengigheter.
 * Lokalt:  node server.js
 * Sky/VPS: Sett miljøvariabler PORT, SMTP_*, DATA_DIR
 */

const http   = require('node:http');
const fs     = require('node:fs');
const path   = require('node:path');
const url    = require('node:url');
const crypto = require('node:crypto');
const net    = require('node:net');
const tls    = require('node:tls');
const os     = require('node:os');
const { DatabaseSync } = require('node:sqlite');

const PORT     = parseInt(process.env.PORT || '3000', 10);
const BASE     = __dirname;
const DATA_DIR = process.env.DATA_DIR || path.join(BASE, 'data');
const UPL_DIR  = process.env.UPL_DIR  || path.join(BASE, 'uploads');
const PUB_DIR  = path.join(BASE, 'public');

[DATA_DIR, UPL_DIR].forEach(d => fs.mkdirSync(d, { recursive: true }));

function getLocalIP() {
  for (const iface of Object.values(os.networkInterfaces())) {
    for (const addr of iface) {
      if (addr.family === 'IPv4' && !addr.internal) return addr.address;
    }
  }
  return 'localhost';
}

let CONFIG = {
  smtp: {
    host:     process.env.SMTP_HOST || '',
    port:     parseInt(process.env.SMTP_PORT || '587'),
    secure:   process.env.SMTP_SECURE === 'true',
    user:     process.env.SMTP_USER || '',
    password: process.env.SMTP_PASS || '',
    from:     process.env.SMTP_FROM || '',
    to:       process.env.SMTP_TO   || '',
  }
};
const cfgPath = path.join(BASE, 'config.json');
if (fs.existsSync(cfgPath)) {
  try {
    const file = JSON.parse(fs.readFileSync(cfgPath, 'utf8'));
    CONFIG = { ...CONFIG, smtp: { ...CONFIG.smtp, ...file.smtp } };
  } catch {}
}
function saveConfig() { fs.writeFileSync(cfgPath, JSON.stringify(CONFIG, null, 2)); }

const db = new DatabaseSync(path.join(DATA_DIR, 'avvik.db'));
db.exec(`PRAGMA journal_mode=WAL;
  CREATE TABLE IF NOT EXISTS projects (
    id TEXT PRIMARY KEY, name TEXT NOT NULL, number TEXT DEFAULT '',
    created_at TEXT DEFAULT (strftime('%Y-%m-%d %H:%M', 'now','localtime'))
  );
  CREATE TABLE IF NOT EXISTS reports (
    id TEXT PRIMARY KEY, project_id TEXT, project_name TEXT DEFAULT '',
    type TEXT NOT NULL, severity TEXT NOT NULL, description TEXT NOT NULL,
    immediate_action TEXT DEFAULT '', location TEXT DEFAULT '',
    image_path TEXT, reporter_name TEXT NOT NULL, reporter_company TEXT NOT NULL,
    reporter_phone TEXT DEFAULT '', status TEXT DEFAULT 'Ny',
    assigned_to TEXT DEFAULT '', follow_up_comment TEXT DEFAULT '',
    follow_up_by TEXT DEFAULT '',
    created_at TEXT DEFAULT (strftime('%Y-%m-%d %H:%M', 'now','localtime')),
    updated_at TEXT DEFAULT (strftime('%Y-%m-%d %H:%M', 'now','localtime'))
  );`);
if (!db.prepare('SELECT id FROM projects LIMIT 1').get())
  db.prepare('INSERT INTO projects (id,name,number) VALUES (?,?,?)').run(crypto.randomUUID(), 'Eksempelprosjekt', 'P001');

function parseMultipart(body, contentType) {
  const bm = contentType.match(/boundary=([^\s;]+)/);
  if (!bm) return [{}, {}];
  const boundary = Buffer.from(bm[1].replace(/"/g,''));
  const fields = {}, files = {};
  const parts = [];
  let pos = body.indexOf(Buffer.concat([Buffer.from('--'), boundary]));
  if (pos < 0) return [fields, files];
  pos += boundary.length + 2;
  while (pos < body.length) {
    if (body[pos]===45 && body[pos+1]===45) break;
    if (body[pos]===13) pos+=2;
    const nextDelim = body.indexOf(Buffer.concat([Buffer.from('\r\n--'), boundary]), pos);
    const partEnd = nextDelim < 0 ? body.length : nextDelim;
    parts.push(body.slice(pos, partEnd));
    if (nextDelim < 0) break;
    pos = nextDelim + 4 + boundary.length;
  }
  for (const part of parts) {
    const sep = part.indexOf('\r\n\r\n');
    if (sep < 0) continue;
    const hdrStr = part.slice(0, sep).toString('utf8');
    const content = part.slice(sep + 4);
    const nm = hdrStr.match(/name="([^"]+)"/);
    if (!nm) continue;
    const fn = hdrStr.match(/filename="([^"]*)"/);
    const ct = hdrStr.match(/Content-Type:\s*(\S+)/i);
    if (fn) {
      files[nm[1]] = { filename: fn[1], content, contentType: ct ? ct[1] : 'application/octet-stream' };
    } else {
      fields[nm[1]] = content.toString('utf8').replace(/\r\n$/, '');
    }
  }
  return [fields, files];
}

function sendEmail(subject, body) {
  return new Promise((resolve) => {
    const cfg = CONFIG.smtp;
    if (!cfg.host || !cfg.to) return resolve(false);
    const lines = [
      `EHLO avvik.minel.no`,
      `AUTH LOGIN`,
      Buffer.from(cfg.user).toString('base64'),
      Buffer.from(cfg.password).toString('base64'),
      `MAIL FROM:<${cfg.from || cfg.user}>`,
      `RCPT TO:<${cfg.to}>`,
      `DATA`,
      `From: Minel Avvikssystem <${cfg.from || cfg.user}>\r\nTo: ${cfg.to}\r\nSubject: ${subject}\r\nContent-Type: text/plain; charset=utf-8\r\n\r\n${body}\r\n.`,
      `QUIT`,
    ];
    let lineIdx = 0;
    const send = (sock) => {
      sock.on('data', (d) => {
        const resp = d.toString();
        if (resp.match(/^[45]/)) { sock.destroy(); return resolve(false); }
        if (lineIdx < lines.length) { sock.write(lines[lineIdx++] + '\r\n'); }
        else { sock.destroy(); resolve(true); }
      });
      sock.on('error', () => resolve(false));
    };
    if (cfg.secure) {
      tls.connect(cfg.port, cfg.host, { rejectUnauthorized: false }, function() { send(this); });
    } else {
      net.createConnection(cfg.port, cfg.host, function() { send(this); });
    }
  });
}

const uuid = () => crypto.randomUUID();
const MIME = {
  '.html':'text/html;charset=utf-8', '.css':'text/css', '.js':'application/javascript',
  '.png':'image/png', '.jpg':'image/jpeg', '.jpeg':'image/jpeg', '.svg':'image/svg+xml',
  '.gif':'image/gif', '.webp':'image/webp', '.ico':'image/x-icon'
};

async function readBody(req) {
  return new Promise((res, rej) => {
    const chunks = [];
    req.on('data', c => chunks.push(c));
    req.on('end', () => res(Buffer.concat(chunks)));
    req.on('error', rej);
  });
}

function jsonOut(res, data, status=200) {
  const body = JSON.stringify(data);
  res.writeHead(status, {
    'Content-Type': 'application/json;charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
    'Access-Control-Allow-Origin': '*'
  });
  res.end(body);
}

function parseQS(rawQuery) {
  if (!rawQuery) return {};
  return Object.fromEntries(new url.URLSearchParams(rawQuery));
}

function serveFile(res, filePath) {
  if (!fs.existsSync(filePath)) { res.writeHead(404); return res.end('Not found'); }
  const ext  = path.extname(filePath).toLowerCase();
  const data = fs.readFileSync(filePath);
  res.writeHead(200, { 'Content-Type': MIME[ext]||'application/octet-stream', 'Content-Length': data.length });
  res.end(data);
}

const server = http.createServer(async (req, res) => {
  const parsed = new URL(req.url, `http://localhost:${PORT}`);
  const p  = parsed.pathname;
  const qs = parseQS(parsed.search.slice(1));

  res.setHeader('Access-Control-Allow-Origin', '*');
  if (req.method === 'OPTIONS') { res.writeHead(204); return res.end(); }

  if (p === '/' || p === '/index.html') return serveFile(res, path.join(PUB_DIR, 'index.html'));
  if (p === '/dashboard.html')          return serveFile(res, path.join(PUB_DIR, 'dashboard.html'));
  if (p.startsWith('/uploads/'))        return serveFile(res, path.join(UPL_DIR, p.slice(9)));

  if (!p.startsWith('/api/')) { res.writeHead(404); return res.end('Not found'); }

  try {
    if (p === '/api/serverinfo') {
      const ip = getLocalIP();
      return jsonOut(res, { ip, port: PORT, url: `http://${ip}:${PORT}` });
    }

    if (p === '/api/projects' && req.method === 'GET') {
      return jsonOut(res, db.prepare('SELECT * FROM projects ORDER BY name').all());
    }
    if (p === '/api/projects' && req.method === 'POST') {
      const body = JSON.parse(await readBody(req));
      if (!body.name?.trim()) return jsonOut(res, { error: 'Navn påkrevd' }, 400);
      const id = uuid();
      db.prepare('INSERT INTO projects (id,name,number) VALUES (?,?,?)').run(id, body.name.trim(), (body.number||'').trim());
      return jsonOut(res, { id, name: body.name.trim(), number: body.number||'' });
    }
    const delProj = p.match(/^\/api\/projects\/([^/]+)$/);
    if (delProj && req.method === 'DELETE') {
      db.prepare('DELETE FROM projects WHERE id=?').run(delProj[1]);
      return jsonOut(res, { success: true });
    }

    if (p === '/api/reports' && req.method === 'GET') {
      const { project_id, type, status, severity, from, to, search } = qs;
      let q = 'SELECT * FROM reports WHERE 1=1', pr = [];
      if (project_id) { q+=' AND project_id=?'; pr.push(project_id); }
      if (type)       { q+=' AND type=?';       pr.push(type); }
      if (status)     { q+=' AND status=?';     pr.push(status); }
      if (severity)   { q+=' AND severity=?';   pr.push(severity); }
      if (from)       { q+=' AND date(created_at)>=?'; pr.push(from); }
      if (to)         { q+=' AND date(created_at)<=?'; pr.push(to); }
      if (search)     {
        const s = `%${search}%`;
        q += ' AND (description LIKE ? OR reporter_name LIKE ? OR location LIKE ?)';
        pr.push(s, s, s);
      }
      q += ' ORDER BY created_at DESC';
      return jsonOut(res, db.prepare(q).all(...pr));
    }

    const getReport = p.match(/^\/api\/reports\/([^/]+)$/);
    if (getReport && req.method === 'GET') {
      const r = db.prepare('SELECT * FROM reports WHERE id=?').get(getReport[1]);
      return r ? jsonOut(res, r) : jsonOut(res, { error: 'Ikke funnet' }, 404);
    }

    if (p === '/api/reports' && req.method === 'POST') {
      const ct = req.headers['content-type'] || '';
      let fields = {}, files = {};
      if (ct.includes('multipart/form-data')) {
        [fields, files] = parseMultipart(await readBody(req), ct);
      } else {
        fields = JSON.parse(await readBody(req));
      }
      for (const f of ['type','severity','description','reporter_name','reporter_company']) {
        if (!fields[f]?.trim()) return jsonOut(res, { error: `Mangler: ${f}` }, 400);
      }
      let imagePath = null;
      if (files.image?.content?.length) {
        const ext   = path.extname(files.image.filename).toLowerCase() || '.jpg';
        const fname = `${Date.now()}-${uuid().slice(0,8)}${ext}`;
        fs.writeFileSync(path.join(UPL_DIR, fname), files.image.content);
        imagePath = `/uploads/${fname}`;
      }
      const id = uuid();
      db.prepare(`INSERT INTO reports
        (id,project_id,project_name,type,severity,description,
         immediate_action,location,image_path,reporter_name,reporter_company,reporter_phone)
        VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`).run(
        id,
        fields.project_id||null, (fields.project_name||'').trim(),
        fields.type.trim(), fields.severity.trim(), fields.description.trim(),
        (fields.immediate_action||'').trim(), (fields.location||'').trim(), imagePath,
        fields.reporter_name.trim(), fields.reporter_company.trim(),
        (fields.reporter_phone||'').trim()
      );

      const ip = getLocalIP();
      sendEmail(
        `Nytt avvik: ${fields.type} – ${fields.severity}`,
        `Ny registrering i Minel Avvikssystem.\n\n` +
        `Type: ${fields.type}\nAlvorlighet: ${fields.severity}\n` +
        `Prosjekt: ${fields.project_name||'–'}\nBeskrivelse: ${fields.description}\n` +
        `Innmelder: ${fields.reporter_name} (${fields.reporter_company})\n` +
        `Sted: ${fields.location||'–'}\n\n` +
        `Åpne dashboard: http://${ip}:${PORT}/dashboard.html`
      ).catch(() => {});

      return jsonOut(res, { success: true, id });
    }

    const putReport = p.match(/^\/api\/reports\/([^/]+)$/);
    if (putReport && req.method === 'PUT') {
      const body = JSON.parse(await readBody(req));
      const { status, assigned_to, follow_up_comment, follow_up_by } = body;
      if (!db.prepare('SELECT id FROM reports WHERE id=?').get(putReport[1]))
        return jsonOut(res, { error: 'Ikke funnet' }, 404);
      const updates = [], vals = [];
      if (status !== undefined)            { updates.push('status=?');            vals.push(status); }
      if (assigned_to !== undefined)       { updates.push('assigned_to=?');       vals.push(assigned_to); }
      if (follow_up_comment !== undefined) { updates.push('follow_up_comment=?'); vals.push(follow_up_comment); }
      if (follow_up_by !== undefined)      { updates.push('follow_up_by=?');      vals.push(follow_up_by); }
      if (updates.length) {
        updates.push("updated_at=strftime('%Y-%m-%d %H:%M','now','localtime')");
        vals.push(putReport[1]);
        db.prepare(`UPDATE reports SET ${updates.join(',')} WHERE id=?`).run(...vals);
      }
      return jsonOut(res, { success: true });
    }

    if (p === '/api/stats' && req.method === 'GET') {
      const pid = qs.project_id;
      const w  = pid ? `WHERE project_id='${pid.replace(/'/g,"''")}'` : '';
      const aw = pid ? 'AND' : 'WHERE';
      return jsonOut(res, {
        total:      db.prepare(`SELECT COUNT(*) c FROM reports ${w}`).get().c,
        open:       db.prepare(`SELECT COUNT(*) c FROM reports ${w} ${aw} status!='Lukket'`).get().c,
        thisMonth:  db.prepare(`SELECT COUNT(*) c FROM reports ${w} ${aw} strftime('%Y-%m',created_at)=strftime('%Y-%m','now')`).get().c,
        byType:     db.prepare(`SELECT type,     COUNT(*) count FROM reports ${w} GROUP BY type`).all(),
        byStatus:   db.prepare(`SELECT status,   COUNT(*) count FROM reports ${w} GROUP BY status`).all(),
        bySeverity: db.prepare(`SELECT severity, COUNT(*) count FFROM reports ${w} GROUP BY severity`).all(),
      });
    }

    if (p === '/api/config' && req.method === 'GET')  return jsonOut(res, CONFIG);
    if (p === '/api/config' && req.method === 'POST') {
      const body = JSON.parse(await readBody(req));
      CONFIG = body;
      saveConfig();
      return jsonOut(res, { success: true });
    }

    res.writeHead(404); res.end('Not found');
  } catch (e) {
    console.error(e);
    jsonOut(res, { error: e.message }, 500);
  }
});

server.listen(PORT, '0.0.0.0', () => {
  const ip = getLocalIP();
  console.log(`\n✅  Minel Avvikssystem kjører`);
  console.log(`📱  Mobil (elektrikere):  http://${ip}:${PORT}/`);
  console.log(`🖥️   Dashboard (PL/DL):   http://${ip}:${PORT}/dashboard.html`);
  console.log(`\nLokalt:   http://localhost:${PORT}/dashboard.html`);
  console.log(`Trykk Ctrl+C for å stoppe.\n`);
});
