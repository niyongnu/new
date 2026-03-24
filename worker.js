/**
 * Domain Manager v4
 */

export default {
  async fetch(request, env, ctx) {
    try {
      const url = new URL(request.url);
      const path = url.pathname;

      if (path === '/api/health') {
        return ok({ kv: !!env.KV });
      }

      if (path === '/' || path === '/index.html') {
        return html(getHTML());
      }

      if (path === '/api/telegram/webhook' && request.method === 'POST') {
        return handleWebhook(request, env);
      }

      if (!path.startsWith('/api/')) {
        return new Response('Not Found', { status: 404 });
      }

      if (path === '/api/login' && request.method === 'POST') {
        return doLogin(request, env);
      }

      const authed = await checkAuth(request, env);
      if (!authed) return ok({ error: 'Unauthorized' }, 401);

      return route(request, env, path);
    } catch (e) {
      return ok({ error: e.message }, 500);
    }
  },
  async scheduled(e, env) {
    await dailyCheck(env);
  },
};

// ── AUTH ─────────────────────────────────────────────────────────────────────

async function doLogin(request, env) {
  let body;
  try { body = await request.json(); } catch { return ok({ error: '请求格式错误' }, 400); }
  const pw = env.ADMIN_PASSWORD || 'admin123';
  if (!body.password || body.password !== pw) return ok({ error: '密码错误' }, 401);
  const token = await makeToken(pw);
  return new Response(JSON.stringify({ ok: true }), {
    headers: {
      'Content-Type': 'application/json',
      'Set-Cookie': 'dm_auth=' + token + '; Path=/; HttpOnly; SameSite=Strict; Max-Age=604800',
    },
  });
}

async function checkAuth(request, env) {
  const cookie = request.headers.get('Cookie') || '';
  const token = (cookie.match(/dm_auth=([^;]+)/) || [])[1];
  if (!token) return false;
  try {
    const [p, s] = token.split('.');
    const expected = await sign(p, env.ADMIN_PASSWORD || 'admin123');
    return s === expected && Date.now() < JSON.parse(atob(p)).exp;
  } catch { return false; }
}

async function makeToken(pw) {
  const p = btoa(JSON.stringify({ exp: Date.now() + 86400000 * 7 }));
  return p + '.' + await sign(p, pw);
}

async function sign(data, key) {
  const enc = new TextEncoder();
  const k = await crypto.subtle.importKey('raw', enc.encode(key), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const s = await crypto.subtle.sign('HMAC', k, enc.encode(data));
  return btoa(String.fromCharCode(...new Uint8Array(s)));
}

// ── ROUTER ───────────────────────────────────────────────────────────────────

async function route(request, env, path) {
  const m = request.method;
  const json = () => request.json().catch(() => ({}));

  if (path === '/api/logout' && m === 'POST')
    return new Response(JSON.stringify({ ok: true }), {
      headers: { 'Content-Type': 'application/json', 'Set-Cookie': 'dm_auth=; Path=/; Max-Age=0' },
    });

  if (path === '/api/stats') return ok(await getStats(env));

  if (path === '/api/domains') {
    if (m === 'GET') return ok(await getDomains(env));
    if (m === 'POST') return ok(await addDomain(await json(), env));
  }
  const did = (path.match(/^\/api\/domains\/(.+)$/) || [])[1];
  if (did) {
    if (m === 'PUT') return ok(await updDomain(did, await json(), env));
    if (m === 'DELETE') return ok(await delById(env, 'domains', did));
  }

  if (path === '/api/accounts') {
    if (m === 'GET') return ok(await kget(env, 'accounts'));
    if (m === 'POST') return ok(await addAcc(await json(), env));
  }
  const aid = (path.match(/^\/api\/accounts\/(.+)$/) || [])[1];
  if (aid) {
    if (m === 'PUT') return ok(await updAcc(aid, await json(), env));
    if (m === 'DELETE') return ok(await delById(env, 'accounts', aid));
  }

  if (path === '/api/cf-accounts') {
    if (m === 'GET') return ok((await kget(env, 'cf_accounts')).map(a => ({ ...a, apiToken: '***' })));
    if (m === 'POST') return addCF(await json(), env);
  }
  const cid = (path.match(/^\/api\/cf-accounts\/(.+)$/) || [])[1];
  if (cid && m === 'DELETE') return ok(await delById(env, 'cf_accounts', cid));

  if (path === '/api/cf-preview' && m === 'POST') return previewCF(await json(), env);
  if (path === '/api/cf-sync' && m === 'POST') return syncCF(await json(), env);

  if (path === '/api/telegram') {
    if (m === 'GET') { const c = await tgCfg(env); return ok({ chatId: c.chatId || '', botToken: c.botToken ? '***' : '' }); }
    if (m === 'POST') return saveTg(await json(), env);
  }

  if (path === '/api/check' && m === 'POST') {
    await dailyCheck(env);
    return ok({ ok: true, msg: '检查完成' });
  }

  return ok({ error: 'Not Found' }, 404);
}

// ── KV ───────────────────────────────────────────────────────────────────────

async function kget(env, key) {
  if (!env.KV) return [];
  try { return JSON.parse(await env.KV.get(key) || '[]'); } catch { return []; }
}
async function kput(env, key, val) {
  if (!env.KV) throw new Error('KV 未绑定：请在 Worker Settings → Bindings 添加 KV，变量名填 KV');
  await env.KV.put(key, JSON.stringify(val));
}
async function kgetStr(env, key, def = '') {
  if (!env.KV) return def;
  try { return await env.KV.get(key) || def; } catch { return def; }
}

// ── DOMAINS ──────────────────────────────────────────────────────────────────

async function getDomains(env) {
  const [domains, accs, cfAccs] = await Promise.all([kget(env, 'domains'), kget(env, 'accounts'), kget(env, 'cf_accounts')]);
  const nm = {};
  [...accs, ...cfAccs].forEach(a => { nm[a.id] = a.name; });
  return domains.map(d => ({ ...d, accountName: nm[d.accountId] || '—', daysLeft: days(d.expiryDate) }))
    .sort((a, b) => a.daysLeft - b.daysLeft);
}

async function addDomain(b, env) {
  if (!b.name) throw new Error('域名为必填项');
  if (!b.expiryDate) throw new Error('到期日期为必填项');
  const list = await kget(env, 'domains');
  const d = { id: uid(), name: b.name.trim().toLowerCase(), accountId: b.accountId || '', registrar: b.registrar || '', registrarUrl: b.registrarUrl || '', registeredAt: b.registeredAt || '', expiryDate: b.expiryDate, autoRenew: !!b.autoRenew, reminderDays: b.reminderDays || [1, 7, 30], notes: b.notes || '', source: b.source || 'manual', createdAt: now() };
  list.push(d); await kput(env, 'domains', list); return d;
}

async function updDomain(id, b, env) {
  const list = await kget(env, 'domains');
  const i = list.findIndex(d => d.id === id);
  if (i < 0) throw new Error('域名不存在');
  list[i] = { ...list[i], ...b, id, updatedAt: now() };
  await kput(env, 'domains', list); return list[i];
}

async function delById(env, key, id) {
  const list = await kget(env, key);
  await kput(env, key, list.filter(x => x.id !== id));
  return { ok: true };
}

// ── ACCOUNTS ─────────────────────────────────────────────────────────────────

async function addAcc(b, env) {
  if (!b.name) throw new Error('名称为必填项');
  const list = await kget(env, 'accounts');
  const a = { id: uid(), name: b.name.trim(), registrar: b.registrar || '', email: b.email || '', loginUrl: b.loginUrl || '', notes: b.notes || '', createdAt: now() };
  list.push(a); await kput(env, 'accounts', list); return a;
}

async function updAcc(id, b, env) {
  const list = await kget(env, 'accounts');
  const i = list.findIndex(a => a.id === id);
  if (i < 0) throw new Error('账号不存在');
  list[i] = { ...list[i], ...b, id };
  await kput(env, 'accounts', list); return list[i];
}

// ── CLOUDFLARE ───────────────────────────────────────────────────────────────

async function addCF(b, env) {
  if (!b.name || !b.apiToken) return ok({ error: '名称和 Token 为必填项' }, 400);
  const v = await cfApi('/accounts?per_page=1', b.apiToken);
  if (!v.success) return ok({ error: 'Token 无效: ' + (v.errors?.[0]?.message || '验证失败') }, 400);
  const list = await kget(env, 'cf_accounts');
  const a = { id: uid(), name: b.name.trim(), apiToken: b.apiToken.trim(), cfAccountId: v.result?.[0]?.id || '', cfAccountName: v.result?.[0]?.name || '', type: 'cloudflare', createdAt: now() };
  list.push(a); await kput(env, 'cf_accounts', list);
  return ok({ ...a, apiToken: '***' });
}

async function previewCF(b, env) {
  const cf = (await kget(env, 'cf_accounts')).find(a => a.id === b.cfAccountId);
  if (!cf) return ok({ error: '账号不存在' }, 404);
  const r = await fetchCFDomains(cf);
  if (!r.ok) return ok({ error: r.error }, 400);
  const existing = new Set((await kget(env, 'domains')).map(d => d.name));
  const out = r.domains.map(d => ({ ...d, exists: existing.has(d.name) }));
  return ok({ domains: out, total: out.length, newCount: out.filter(d => !d.exists).length });
}

async function syncCF(b, env) {
  const cf = (await kget(env, 'cf_accounts')).find(a => a.id === b.cfAccountId);
  if (!cf) return ok({ error: '账号不存在' }, 404);
  const r = await fetchCFDomains(cf);
  if (!r.ok) return ok({ error: r.error }, 400);
  const domains = await kget(env, 'domains');
  const nm = new Map(domains.map((d, i) => [d.name, i]));
  let added = 0, updated = 0, skipped = 0;
  for (const d of r.domains) {
    if (nm.has(d.name)) {
      if (b.mode === 'all') { const i = nm.get(d.name); domains[i] = { ...domains[i], expiryDate: d.expiryDate || domains[i].expiryDate, autoRenew: d.autoRenew, source: d.source, updatedAt: now() }; updated++; }
      else skipped++;
    } else {
      domains.push({ id: uid(), name: d.name, accountId: cf.id, registrar: 'Cloudflare', registrarUrl: 'https://dash.cloudflare.com/' + cf.cfAccountId + '/domains', registeredAt: d.registeredAt, expiryDate: d.expiryDate, autoRenew: d.autoRenew, reminderDays: [1, 7, 30], notes: '', source: d.source, createdAt: now() });
      added++;
    }
  }
  await kput(env, 'domains', domains);
  return ok({ ok: true, added, updated, skipped, total: r.domains.length });
}

async function fetchCFDomains(cf) {
  try {
    const out = [];
    if (cf.cfAccountId) {
      const reg = await cfApi('/accounts/' + cf.cfAccountId + '/registrar/domains?per_page=200', cf.apiToken);
      if (reg.success) for (const d of reg.result || []) out.push({ name: d.name, registeredAt: (d.created_at || '').split('T')[0], expiryDate: (d.expires_at || '').split('T')[0], autoRenew: !!d.auto_renew, source: 'cf_registrar' });
    }
    const zones = await cfApi('/zones?per_page=200', cf.apiToken);
    if (zones.success) {
      const s = new Set(out.map(d => d.name));
      for (const z of zones.result || []) if (!s.has(z.name)) out.push({ name: z.name, registeredAt: (z.created_on || '').split('T')[0], expiryDate: '', autoRenew: false, source: 'cf_zone' });
    }
    if (!out.length) return { ok: false, error: '未找到域名，请确认 Token 有 Zone:Read 权限' };
    return { ok: true, domains: out };
  } catch (e) { return { ok: false, error: e.message }; }
}

async function cfApi(path, token) {
  const r = await fetch('https://api.cloudflare.com/client/v4' + path, { headers: { Authorization: 'Bearer ' + token } });
  return r.json();
}

// ── STATS ─────────────────────────────────────────────────────────────────────

async function getStats(env) {
  const [d, a, c] = await Promise.all([kget(env, 'domains'), kget(env, 'accounts'), kget(env, 'cf_accounts')]);
  return { ok: true, kvBound: !!env.KV, total: d.length, accounts: a.length + c.length, cfDomains: d.filter(x => x.source && x.source.startsWith('cf')).length, expired: d.filter(x => days(x.expiryDate) < 0).length, expiring7: d.filter(x => { const v = days(x.expiryDate); return v >= 0 && v <= 7; }).length, expiring30: d.filter(x => { const v = days(x.expiryDate); return v >= 0 && v <= 30; }).length, autoRenew: d.filter(x => x.autoRenew).length };
}

// ── TELEGRAM ─────────────────────────────────────────────────────────────────

async function tgCfg(env) { return JSON.parse(await kgetStr(env, 'telegram_config', '{}')); }

async function saveTg(b, env) {
  const c = await tgCfg(env);
  if (b.chatId !== undefined) c.chatId = b.chatId;
  if (b.botToken && b.botToken !== '***') c.botToken = b.botToken;
  await kput(env, 'telegram_config', c);
  return ok({ ok: true });
}

async function handleWebhook(request, env) {
  const u = await request.json().catch(() => ({}));
  const msg = u.message; if (!msg) return ok({ ok: true });
  const cid = msg.chat.id, txt = (msg.text || '').trim();
  const c = await tgCfg(env);
  if (txt === '/start') await tg(c.botToken, cid, '🌐 *域名管理机器人*\n\n你的 Chat ID: `' + cid + '`\n\n/domains — 所有域名\n/expiring — 即将到期\n/check — 立即检查');
  else if (txt === '/domains') {
    const list = await kget(env, 'domains');
    const lines = list.sort((a, b) => days(a.expiryDate) - days(b.expiryDate)).map(d => emoji(days(d.expiryDate)) + ' `' + d.name + '` — ' + dstr(d.expiryDate)).join('\n');
    await tg(c.botToken, cid, '🌐 *所有域名*\n\n' + (lines || '暂无'));
  } else if (txt === '/expiring') {
    const exp = (await kget(env, 'domains')).filter(d => days(d.expiryDate) <= 30).sort((a, b) => days(a.expiryDate) - days(b.expiryDate));
    await tg(c.botToken, cid, exp.length ? '⏰ *30天内到期*\n\n' + exp.map(d => emoji(days(d.expiryDate)) + ' `' + d.name + '` — ' + dstr(d.expiryDate)).join('\n') : '✅ 30天内无到期');
  } else if (txt === '/check') { await dailyCheck(env); await tg(c.botToken, cid, '✅ 检查完成'); }
  return ok({ ok: true });
}

async function dailyCheck(env) {
  const c = await tgCfg(env);
  if (!c.botToken || !c.chatId) return;
  const today = new Date().toDateString();
  if (await kgetStr(env, 'last_check', '') === today) return;
  await env.KV.put('last_check', today);
  const notify = (await kget(env, 'domains')).filter(d => { const v = days(d.expiryDate); return (d.reminderDays || [1, 7, 30]).includes(v) || v < 0; });
  if (!notify.length) return;
  const lines = notify.map(d => { const v = days(d.expiryDate); return (v < 0 ? '🔴' : v <= 1 ? '🆘' : v <= 7 ? '🟠' : '🟡') + ' `' + d.name + '` — ' + dstr(d.expiryDate) + '\n   ' + (d.registrar || ''); }).join('\n\n');
  await tg(c.botToken, c.chatId, '⚠️ *域名续约提醒*\n\n' + lines);
}

async function tg(token, chatId, text) {
  if (!token) return;
  await fetch('https://api.telegram.org/bot' + token + '/sendMessage', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ chat_id: chatId, text, parse_mode: 'Markdown' }) });
}

// ── HELPERS ───────────────────────────────────────────────────────────────────

function days(s) { if (!s) return 9999; const e = new Date(s), n = new Date(); e.setHours(0,0,0,0); n.setHours(0,0,0,0); return Math.round((e-n)/86400000); }
function dstr(s) { const d = days(s); return d === 9999 ? '未填写' : d < 0 ? '已过期' + Math.abs(d) + '天' : d + '天后'; }
function emoji(d) { return d < 0 ? '🔴' : d <= 7 ? '🟠' : d <= 30 ? '🟡' : '🟢'; }
function uid() { return crypto.randomUUID(); }
function now() { return new Date().toISOString(); }
function ok(data, status = 200) { return new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json' } }); }
function html(body) { return new Response(body, { headers: { 'Content-Type': 'text/html; charset=utf-8' } }); }

// ── HTML ─────────────────────────────────────────────────────────────────────

function getHTML() { return String.raw`<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>域名管理</title>
<style>
*{box-sizing:border-box;margin:0;padding:0}
:root{--bg:#0d0f12;--s1:#141720;--s2:#1c2028;--bd:#252b35;--ac:#00e5a0;--bl:#3b8eea;--cf:#f6821f;--wa:#ff9500;--da:#ff4d6d;--tx:#dde3ec;--t2:#6c7a8d;--t3:#343d4a;--mo:monospace;--fn:system-ui,sans-serif}
body{background:var(--bg);color:var(--tx);font-family:var(--fn);font-size:14px;line-height:1.5}

/* ─ LOGIN ─ */
#login{position:fixed;inset:0;background:var(--bg);display:flex;align-items:center;justify-content:center;z-index:100}
.lbox{background:var(--s1);border:1px solid var(--bd);border-radius:16px;padding:44px 40px;width:340px;text-align:center}
.llogo{font-family:var(--mo);font-size:22px;color:var(--ac);letter-spacing:2px;margin-bottom:6px}
.lsub{color:var(--t2);font-size:13px;margin-bottom:28px}
#lpw{width:100%;padding:11px 14px;background:var(--s2);border:1px solid var(--bd);border-radius:8px;color:var(--tx);font-size:14px;outline:none;margin-bottom:10px;font-family:var(--fn)}
#lpw:focus{border-color:var(--ac)}
#lbtn{width:100%;padding:11px;background:var(--ac);border:none;border-radius:8px;color:#000;font-size:14px;font-weight:700;cursor:pointer}
#lbtn:disabled{opacity:.6;cursor:default}
#lerr{color:var(--da);font-size:12px;margin-top:8px;min-height:16px}
#kwarn{background:rgba(255,149,0,.1);border:1px solid rgba(255,149,0,.25);border-radius:8px;padding:10px;color:var(--wa);font-size:12px;text-align:left;line-height:1.6;margin-bottom:14px;display:none}

/* ─ APP ─ */
#app{display:none;min-height:100vh;flex-direction:column}
header{height:56px;background:var(--s1);border-bottom:1px solid var(--bd);display:flex;align-items:center;justify-content:space-between;padding:0 24px;position:sticky;top:0;z-index:50}
.logo{font-family:var(--mo);color:var(--ac);font-size:16px;letter-spacing:1px}
.logo em{color:var(--t2);font-style:normal}
nav{display:flex;gap:2px}
.nb{background:none;border:none;color:var(--t2);cursor:pointer;padding:5px 14px;border-radius:6px;font-size:13px;font-family:var(--fn)}
.nb:hover,.nb.a{background:var(--s2);color:var(--tx)}
.nb.a{color:var(--ac)}
.hbts{display:flex;gap:8px}
main{flex:1;padding:24px;max-width:1200px;margin:0 auto;width:100%}
.page{display:none}.page.a{display:block}

/* ─ STATS ─ */
.stats{display:grid;grid-template-columns:repeat(auto-fill,minmax(130px,1fr));gap:12px;margin-bottom:24px}
.sc{background:var(--s1);border:1px solid var(--bd);border-radius:10px;padding:16px}
.sn{font-family:var(--mo);font-size:30px;font-weight:700;line-height:1}
.sl{font-size:11px;color:var(--t2);margin-top:4px}
.ca{color:var(--ac)}.cb{color:var(--bl)}.cc{color:var(--cf)}.cw{color:var(--wa)}.cr{color:var(--da)}

/* ─ TABLE ─ */
.sh{display:flex;align-items:center;justify-content:space-between;margin-bottom:16px;flex-wrap:wrap;gap:8px}
.stl{font-size:15px;font-weight:500}
.stl small{color:var(--t2);font-weight:400;font-size:13px;margin-left:6px}
.tb{display:flex;gap:8px;margin-bottom:16px;flex-wrap:wrap;align-items:center}
.sr{position:relative}
.sr input{padding:7px 10px 7px 30px;background:var(--s1);border:1px solid var(--bd);border-radius:8px;color:var(--tx);font-size:13px;outline:none;width:180px;font-family:var(--fn)}
.sr input:focus{border-color:var(--ac)}
.sr span{position:absolute;left:9px;top:50%;transform:translateY(-50%);color:var(--t3);pointer-events:none}
select{padding:7px 10px;background:var(--s1);border:1px solid var(--bd);border-radius:8px;color:var(--tx);font-size:13px;outline:none;cursor:pointer;font-family:var(--fn)}
.tw{background:var(--s1);border:1px solid var(--bd);border-radius:12px;overflow:hidden}
table{width:100%;border-collapse:collapse}
th{padding:10px 14px;text-align:left;font-size:11px;color:var(--t2);text-transform:uppercase;letter-spacing:.07em;background:var(--s2);border-bottom:1px solid var(--bd);font-family:var(--mo);font-weight:400}
td{padding:12px 14px;border-bottom:1px solid var(--bd);font-size:13px;vertical-align:middle}
tr:last-child td{border-bottom:none}
tr:hover td{background:rgba(255,255,255,.02)}
.dn{font-family:var(--mo);font-weight:700}
.tld{color:var(--ac)}
.emp{text-align:center;padding:56px;color:var(--t2)}
.emp .ei{font-size:36px;margin-bottom:12px}
.emp p{font-size:13px}

/* ─ BADGES ─ */
.b{display:inline-flex;align-items:center;padding:2px 8px;border-radius:20px;font-size:11px;font-weight:500;font-family:var(--mo)}
.bg{background:rgba(0,229,160,.1);color:var(--ac);border:1px solid rgba(0,229,160,.2)}
.bw{background:rgba(255,149,0,.1);color:var(--wa);border:1px solid rgba(255,149,0,.2)}
.br{background:rgba(255,77,109,.1);color:var(--da);border:1px solid rgba(255,77,109,.2)}
.bb{background:rgba(59,142,234,.1);color:var(--bl);border:1px solid rgba(59,142,234,.2)}
.bc{background:rgba(246,130,31,.1);color:var(--cf);border:1px solid rgba(246,130,31,.2)}
.bx{background:rgba(255,255,255,.05);color:var(--t2);border:1px solid var(--bd)}

/* ─ BUTTONS ─ */
.btn{display:inline-flex;align-items:center;gap:4px;padding:7px 14px;border-radius:8px;border:none;cursor:pointer;font-size:13px;font-family:var(--fn);font-weight:500;transition:opacity .15s;white-space:nowrap}
.bp{background:var(--ac);color:#000}.bp:hover{opacity:.85}
.bcf{background:var(--cf);color:#000}.bcf:hover{opacity:.85}
.bs{background:var(--s2);color:var(--tx);border:1px solid var(--bd)}.bs:hover{border-color:var(--t3)}
.bd{background:rgba(255,77,109,.1);color:var(--da);border:1px solid rgba(255,77,109,.2)}.bd:hover{background:rgba(255,77,109,.2)}
.sm{padding:4px 9px;font-size:12px}

/* ─ BAR ─ */
.dw{display:flex;flex-direction:column;gap:3px}
.bb2{height:3px;background:var(--bd);border-radius:2px;width:68px}
.bb3{height:3px;border-radius:2px}

/* ─ CARDS ─ */
.ag{display:grid;grid-template-columns:repeat(auto-fill,minmax(240px,1fr));gap:14px}
.ac{background:var(--s1);border:1px solid var(--bd);border-radius:12px;padding:18px}
.ac.cf{border-color:rgba(246,130,31,.2)}
.an{font-size:14px;font-weight:600;margin-bottom:4px}
.am{font-size:12px;color:var(--t2);margin-bottom:12px;line-height:1.7}

/* ─ MODAL ─ */
.mo{position:fixed;inset:0;background:rgba(0,0,0,.8);z-index:200;display:flex;align-items:center;justify-content:center;padding:20px;opacity:0;pointer-events:none;transition:opacity .15s}
.mo.on{opacity:1;pointer-events:auto}
.md{background:var(--s1);border:1px solid var(--bd);border-radius:14px;width:100%;max-width:500px;max-height:88vh;overflow-y:auto;transform:translateY(12px);transition:transform .15s}
.mo.on .md{transform:translateY(0)}
.mh{display:flex;align-items:center;justify-content:space-between;padding:16px 20px;border-bottom:1px solid var(--bd)}
.mt{font-size:15px;font-weight:500}
.mc{background:none;border:none;color:var(--t2);cursor:pointer;font-size:20px;line-height:1;padding:2px 6px}
.mc:hover{color:var(--tx)}
.mb{padding:20px}
.mf{padding:14px 20px;border-top:1px solid var(--bd);display:flex;justify-content:flex-end;gap:8px}
.fg{margin-bottom:14px}
.fl{display:block;font-size:11px;color:var(--t2);margin-bottom:5px;text-transform:uppercase;letter-spacing:.06em;font-weight:500}
.fi,.fsel,.fta{width:100%;padding:9px 11px;background:var(--s2);border:1px solid var(--bd);border-radius:8px;color:var(--tx);font-size:13px;font-family:var(--fn);outline:none;transition:border-color .15s}
.fi:focus,.fsel:focus,.fta:focus{border-color:var(--ac)}
.fsel{cursor:pointer}
.fta{resize:vertical;min-height:64px}
.fr{display:grid;grid-template-columns:1fr 1fr;gap:10px}
.fck{display:flex;align-items:center;gap:6px;cursor:pointer;font-size:13px}
.fck input{accent-color:var(--ac);width:14px;height:14px}
.fh{color:var(--t2);font-size:11px;margin-top:3px}

/* ─ RTAGS ─ */
.rts{display:flex;flex-wrap:wrap;gap:5px;margin-top:5px}
.rt{background:var(--s2);border:1px solid var(--bd);border-radius:6px;padding:3px 9px;font-size:12px;color:var(--t2);cursor:pointer}
.rt.on{background:rgba(0,229,160,.1);border-color:var(--ac);color:var(--ac)}

/* ─ SYNC ─ */
.sp{border:1px solid var(--bd);border-radius:8px;overflow:hidden;max-height:260px;overflow-y:auto;margin-top:12px}
.sph{padding:8px 14px;background:var(--s2);font-size:11px;color:var(--t2);display:flex;justify-content:space-between;position:sticky;top:0}
.spr{display:flex;justify-content:space-between;padding:8px 14px;border-top:1px solid var(--bd);font-size:12px}
.ib{background:rgba(246,130,31,.07);border:1px solid rgba(246,130,31,.18);border-radius:8px;padding:12px;font-size:12px;color:var(--t2);line-height:1.7;margin-bottom:14px}
.ib strong{color:var(--cf)}

/* ─ TG ─ */
.tgst{display:flex;align-items:center;gap:8px;padding:10px 14px;background:var(--s2);border-radius:8px;border:1px solid var(--bd);margin-bottom:16px}
.tgd{width:7px;height:7px;border-radius:50%;background:var(--t3)}
.tgd.on{background:var(--ac);box-shadow:0 0 8px var(--ac)}

/* ─ TOAST ─ */
#toast{position:fixed;bottom:20px;right:20px;z-index:999;display:flex;flex-direction:column;gap:6px;pointer-events:none}
.ti{background:var(--s1);border:1px solid var(--bd);border-radius:8px;padding:10px 14px;font-size:13px;box-shadow:0 4px 16px rgba(0,0,0,.5);animation:sli .15s ease;display:flex;align-items:center;gap:6px}
.ti.s{border-left:3px solid var(--ac)}.ti.e{border-left:3px solid var(--da)}.ti.i{border-left:3px solid var(--bl)}
@keyframes sli{from{opacity:0;transform:translateX(10px)}to{opacity:1;transform:translateX(0)}}
@keyframes fdo{from{opacity:1}to{opacity:0}}

/* ─ KV ALERT ─ */
#kval{display:none;background:rgba(255,149,0,.08);border:1px solid rgba(255,149,0,.22);border-radius:10px;padding:14px;font-size:13px;color:var(--wa);line-height:1.7;margin-bottom:20px}
#kval strong{display:block;margin-bottom:2px}
code{background:rgba(255,255,255,.07);padding:1px 5px;border-radius:4px;font-family:var(--mo);font-size:12px}

@media(max-width:700px){.fr{grid-template-columns:1fr}td:nth-child(n+4){display:none}main{padding:14px}header{padding:0 14px}}
</style>
</head>
<body>

<!-- LOGIN -->
<div id="login">
  <div class="lbox">
    <div class="llogo">DOMAIN MGR</div>
    <div class="lsub">域名管理中心</div>
    <div id="kwarn">⚠️ KV 未绑定，数据无法保存<br>请去 Worker Settings → Bindings 绑定 KV</div>
    <input type="password" id="lpw" placeholder="输入管理员密码">
    <button id="lbtn">登 录</button>
    <div id="lerr"></div>
  </div>
</div>

<!-- APP -->
<div id="app">
<header>
  <div class="logo">DOMAIN<em>MGR</em></div>
  <nav>
    <button class="nb a" id="nb0" onclick="goto(0)">域名</button>
    <button class="nb" id="nb1" onclick="goto(1)">账号</button>
    <button class="nb" id="nb2" onclick="goto(2)">设置</button>
  </nav>
  <div class="hbts">
    <button class="btn bcf sm" onclick="goto(1)">☁ CF同步</button>
    <button class="btn bs sm" onclick="check()">🔔 检查</button>
    <button class="btn bs sm" onclick="logout()">退出</button>
  </div>
</header>
<main>

<div id="kval"><strong>⚠️ KV Namespace 未绑定</strong>域名数据无法持久保存。前往 Workers &amp; Pages → 你的Worker → Settings → Bindings → Add → KV Namespace，Variable name 填 <code>KV</code>，保存后重新部署。</div>

<!-- STATS -->
<div class="stats">
  <div class="sc"><div class="sn cb" id="st">0</div><div class="sl">总域名</div></div>
  <div class="sc"><div class="sn cc" id="sc">0</div><div class="sl">CF同步</div></div>
  <div class="sc"><div class="sn cr" id="se">0</div><div class="sl">已过期</div></div>
  <div class="sc"><div class="sn cw" id="s7">0</div><div class="sl">7天内</div></div>
  <div class="sc"><div class="sn cw" id="s3">0</div><div class="sl">30天内</div></div>
  <div class="sc"><div class="sn ca" id="sa">0</div><div class="sl">自动续约</div></div>
</div>

<!-- DOMAINS -->
<div id="p0" class="page a">
  <div class="sh">
    <div class="stl">域名列表 <small id="dcnt"></small></div>
    <button class="btn bp" onclick="openDM()">+ 添加域名</button>
  </div>
  <div class="tb">
    <div class="sr"><span>🔍</span><input id="dsq" placeholder="搜索..." oninput="filterD()"></div>
    <select id="dff" onchange="filterD()"><option value="">全部状态</option><option value="expired">已过期</option><option value="7">7天内</option><option value="30">30天内</option><option value="ok">正常</option></select>
    <select id="aff" onchange="filterD()"><option value="">全部账号</option></select>
    <select id="sff" onchange="filterD()"><option value="">全部来源</option><option value="cf">CF同步</option><option value="m">手动</option></select>
  </div>
  <div class="tw">
    <table><thead><tr><th>域名</th><th>注册商</th><th>到期状态</th><th>到期日期</th><th>账号</th><th>来源</th><th>操作</th></tr></thead>
    <tbody id="dtb"></tbody></table>
    <div class="emp" id="demp" style="display:none"><div class="ei">🌐</div><p>暂无域名，点右上角添加</p></div>
  </div>
</div>

<!-- ACCOUNTS -->
<div id="p1" class="page">
  <div class="sh"><div class="stl">☁ Cloudflare 账号 <small>自动读取域名</small></div><button class="btn bcf" onclick="openCFM()">+ 添加 CF 账号</button></div>
  <div class="ib"><strong>获取 API Token：</strong>登录 Cloudflare → 右上角头像 → My Profile → API Tokens → Create Token → 选 <strong>Read All Resources</strong> → Create Token → 复制（只显示一次）</div>
  <div class="ag" id="cfg"></div>
  <div class="emp" id="cfe" style="display:none"><div class="ei">☁️</div><p>未添加 CF 账号</p></div>
  <div style="height:32px"></div>
  <div class="sh"><div class="stl">其他注册商账号</div><button class="btn bp" onclick="openAM()">+ 添加账号</button></div>
  <div class="ag" id="acg"></div>
  <div class="emp" id="ace" style="display:none"><div class="ei">👤</div><p>暂无账号</p></div>
</div>

<!-- SETTINGS -->
<div id="p2" class="page">
  <div class="stl" style="margin-bottom:20px">Telegram 通知设置</div>
  <div style="background:var(--s1);border:1px solid var(--bd);border-radius:12px;padding:20px;max-width:500px">
    <div class="tgst"><div class="tgd" id="tgd"></div><span id="tgt">加载中...</span></div>
    <div class="fg"><label class="fl">Bot Token</label><input class="fi" id="tgtok" placeholder="从 @BotFather 获取"><div class="fh">向 @BotFather 发送 /newbot 创建机器人</div></div>
    <div class="fg"><label class="fl">Chat ID</label><input class="fi" id="tgcid" placeholder="向机器人发送 /start 获取"><div class="fh">启动机器人后发 /start，机器人会回复你的 Chat ID</div></div>
    <div style="display:flex;gap:8px"><button class="btn bp" onclick="saveTg()">保存</button><button class="btn bs" onclick="check()">测试发送</button></div>
    <div style="margin-top:18px;padding-top:18px;border-top:1px solid var(--bd);font-size:13px;color:var(--t2);line-height:2">
      <code>/start</code> 获取 Chat ID &nbsp;·&nbsp; <code>/domains</code> 所有域名 &nbsp;·&nbsp; <code>/expiring</code> 即将到期 &nbsp;·&nbsp; <code>/check</code> 立即检查
    </div>
  </div>
</div>

</main>
</div>

<!-- DOMAIN MODAL -->
<div class="mo" id="dm"><div class="md">
  <div class="mh"><div class="mt" id="dmt">添加域名</div><button class="mc" onclick="closeM('dm')">×</button></div>
  <div class="mb">
    <input type="hidden" id="did">
    <div class="fg"><label class="fl">域名 *</label><input class="fi" id="dname" placeholder="example.com"></div>
    <div class="fr">
      <div class="fg"><label class="fl">注册商</label><input class="fi" id="dreg" placeholder="Namecheap"></div>
      <div class="fg"><label class="fl">控制台链接</label><input class="fi" id="durl" placeholder="https://..."></div>
    </div>
    <div class="fg"><label class="fl">所属账号</label><select class="fsel" id="dacc"><option value="">不关联</option></select></div>
    <div class="fr">
      <div class="fg"><label class="fl">注册日期</label><input class="fi" type="date" id="dreg2"></div>
      <div class="fg"><label class="fl">到期日期 *</label><input class="fi" type="date" id="dexp"></div>
    </div>
    <div class="fg"><label class="fl">到期提醒</label>
      <div class="rts" id="rts"><div class="rt on" data-d="1">1天</div><div class="rt on" data-d="7">7天</div><div class="rt on" data-d="14">14天</div><div class="rt on" data-d="30">30天</div><div class="rt" data-d="60">60天</div><div class="rt" data-d="90">90天</div></div>
    </div>
    <div class="fg"><label class="fck"><input type="checkbox" id="dar"> 自动续约</label></div>
    <div class="fg"><label class="fl">备注</label><textarea class="fta" id="dnotes" placeholder="可选..."></textarea></div>
  </div>
  <div class="mf"><button class="btn bs" onclick="closeM('dm')">取消</button><button class="btn bp" onclick="saveD()">保存</button></div>
</div></div>

<!-- CF MODAL -->
<div class="mo" id="cfm"><div class="md">
  <div class="mh"><div class="mt">添加 Cloudflare 账号</div><button class="mc" onclick="closeM('cfm')">×</button></div>
  <div class="mb">
    <div class="ib"><strong>步骤：</strong>1. <a href="https://dash.cloudflare.com/profile/api-tokens" target="_blank" style="color:var(--cf)">前往 API Tokens ↗</a><br>2. Create Token → Read All Resources → Create Token<br>3. 复制 Token（只显示一次，立即保存）</div>
    <div class="fg"><label class="fl">账号名称</label><input class="fi" id="cfn" placeholder="我的 Cloudflare 账号"></div>
    <div class="fg"><label class="fl">API Token</label><input class="fi" id="cft" placeholder="粘贴 Token"><div class="fh">Token 加密存储</div></div>
  </div>
  <div class="mf"><button class="btn bs" onclick="closeM('cfm')">取消</button><button class="btn bcf" id="cfbtn" onclick="saveCF()">验证并添加</button></div>
</div></div>

<!-- SYNC MODAL -->
<div class="mo" id="sm"><div class="md" style="max-width:560px">
  <div class="mh"><div class="mt" id="smt">同步域名</div><button class="mc" onclick="closeM('sm')">×</button></div>
  <div class="mb">
    <div id="slding" style="text-align:center;padding:32px;color:var(--t2)">⏳ 读取中...</div>
    <div id="sbody" style="display:none">
      <div id="ssum" style="padding:10px 14px;background:var(--s2);border-radius:8px;font-size:13px;margin-bottom:12px"></div>
      <div class="sp" id="slist"></div>
      <div class="fg" style="margin-top:12px"><label class="fl">同步模式</label>
        <select class="fsel" id="smod"><option value="new">仅导入新域名</option><option value="all">全部同步（同时更新到期时间）</option></select>
      </div>
    </div>
    <div id="serr" style="display:none;color:var(--da);padding:14px;text-align:center;font-size:13px"></div>
  </div>
  <div class="mf" id="sftr" style="display:none"><button class="btn bs" onclick="closeM('sm')">取消</button><button class="btn bcf" id="sbtn" onclick="doSync()">确认同步</button></div>
</div></div>

<!-- ACC MODAL -->
<div class="mo" id="acm"><div class="md">
  <div class="mh"><div class="mt" id="amt">添加账号</div><button class="mc" onclick="closeM('acm')">×</button></div>
  <div class="mb">
    <input type="hidden" id="aid">
    <div class="fg"><label class="fl">账号名称 *</label><input class="fi" id="aname" placeholder="个人 Namecheap 账号"></div>
    <div class="fr">
      <div class="fg"><label class="fl">注册商</label><input class="fi" id="areg" placeholder="Namecheap"></div>
      <div class="fg"><label class="fl">邮箱</label><input class="fi" id="aemail" placeholder="user@example.com"></div>
    </div>
    <div class="fg"><label class="fl">控制台 URL</label><input class="fi" id="aurl" placeholder="https://..."></div>
    <div class="fg"><label class="fl">备注</label><textarea class="fta" id="anotes"></textarea></div>
  </div>
  <div class="mf"><button class="btn bs" onclick="closeM('acm')">取消</button><button class="btn bp" onclick="saveA()">保存</button></div>
</div></div>

<div id="toast"></div>

<script>
// ── STATE ────────────────────────────────────────────────────────────────────
var D=[], A=[], CF=[], curCFId=null;

// ── LOGIN ────────────────────────────────────────────────────────────────────
function setErr(msg){ document.getElementById('lerr').textContent = msg || ''; }
function setBtn(txt, dis){ var b=document.getElementById('lbtn'); b.textContent=txt; b.disabled=!!dis; }

document.getElementById('lbtn').onclick = function() {
  var pw = document.getElementById('lpw').value;
  if (!pw) { setErr('请输入密码'); return; }
  setBtn('登录中...', true);
  fetch('/api/login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ password: pw })
  }).then(function(r) {
    return r.json().then(function(d) { return { ok: r.ok, d: d }; });
  }).then(function(res) {
    if (res.ok) {
      document.getElementById('login').style.display = 'none';
      document.getElementById('app').style.display = 'flex';
      init();
    } else {
      setErr(res.d.error || '登录失败');
      setBtn('登 录', false);
    }
  }).catch(function(e) {
    setErr('连接失败: ' + e.message);
    setBtn('登 录', false);
  });
};

document.getElementById('lpw').onkeydown = function(e) {
  if (e.key === 'Enter') document.getElementById('lbtn').click();
};

function logout() {
  fetch('/api/logout', { method: 'POST' }).finally(function() { location.reload(); });
}

// ── INIT ─────────────────────────────────────────────────────────────────────
function init() {
  loadAll();
  fetch('/api/health').then(function(r){ return r.json(); }).then(function(d){
    if (!d.kv) {
      document.getElementById('kwarn').style.display = 'block';
      document.getElementById('kval').style.display = 'block';
    }
  }).catch(function(){});
}

function loadAll() {
  loadStats();
  loadD();
  loadA();
  loadCF();
  loadTg();
}

function loadStats() {
  get('/api/stats').then(function(r) {
    if (!r) return;
    setText('st', r.total); setText('sc', r.cfDomains); setText('se', r.expired);
    setText('s7', r.expiring7); setText('s3', r.expiring30); setText('sa', r.autoRenew);
  });
}

function loadD() {
  get('/api/domains').then(function(r) {
    D = r || []; renderD(D); updateFilters();
  });
}
function loadA() {
  get('/api/accounts').then(function(r) { A = r || []; renderA(); updateAccSel(); });
}
function loadCF() {
  get('/api/cf-accounts').then(function(r) { CF = r || []; renderCF(); updateAccSel(); });
}
function loadTg() {
  get('/api/telegram').then(function(r) {
    if (!r) return;
    document.getElementById('tgcid').value = r.chatId || '';
    if (r.botToken) document.getElementById('tgtok').placeholder = r.botToken;
    var ok = r.chatId && r.botToken === '***';
    document.getElementById('tgd').className = 'tgd' + (ok ? ' on' : '');
    document.getElementById('tgt').textContent = ok ? '已启用通知' : '未配置';
  });
}

// ── NAV ──────────────────────────────────────────────────────────────────────
function goto(n) {
  for (var i=0;i<3;i++) {
    document.getElementById('p'+i).className = 'page' + (i===n ? ' a' : '');
    document.getElementById('nb'+i).className = 'nb' + (i===n ? ' a' : '');
  }
}

// ── DOMAINS ──────────────────────────────────────────────────────────────────
function renderD(list) {
  var tb = document.getElementById('dtb');
  setText('dcnt', list.length ? '(' + list.length + ')' : '');
  if (!list.length) { tb.innerHTML = ''; show('demp'); return; }
  hide('demp');
  tb.innerHTML = list.map(function(d) {
    var dl = d.daysLeft;
    var bc = dl < 0 ? 'br' : dl <= 7 ? 'bw' : dl <= 30 ? 'bw' : 'bg';
    var bt = dl < 0 ? '已过期' + Math.abs(dl) + 'd' : dl === 9999 ? '未填写' : dl + '天';
    var bclr = dl < 0 ? 'var(--da)' : dl <= 7 ? 'var(--da)' : dl <= 30 ? 'var(--wa)' : 'var(--ac)';
    var bw = dl === 9999 ? 0 : Math.min(100, Math.max(0, dl / 365 * 100));
    var parts = d.name.split('.');
    var dn = parts.length > 1 ? parts.slice(0,-1).join('.') + '<span class="tld">.' + parts[parts.length-1] + '</span>' : d.name;
    var reg = d.registrarUrl
      ? '<a href="' + esc(d.registrarUrl) + '" target="_blank" style="color:var(--bl);font-size:12px">' + (d.registrar || '控制台') + ' ↗</a>'
      : '<span style="color:var(--t2)">' + (d.registrar || '—') + '</span>';
    var src = d.source === 'cf_registrar' ? '<span class="b bc">☁CF注册</span>'
      : d.source === 'cf_zone' ? '<span class="b bc" style="opacity:.6">☁CF托管</span>'
      : '<span class="b bx">手动</span>';
    return '<tr>'
      + '<td><div class="dn">' + dn + '</div></td>'
      + '<td style="font-size:12px">' + reg + '</td>'
      + '<td><div class="dw"><span class="b ' + bc + '">' + bt + '</span>'
      + '<div class="bb2"><div class="bb3" style="width:' + bw + '%;background:' + bclr + '"></div></div></div></td>'
      + '<td style="color:var(--t2);font-size:12px;font-family:var(--mo)">' + (d.expiryDate || '—') + '</td>'
      + '<td><span class="b bx" style="font-family:var(--fn)">' + (d.accountName || '—') + '</span></td>'
      + '<td>' + src + '</td>'
      + '<td><span style="display:flex;gap:4px">'
      + '<button class="btn bs sm" onclick="editD(\'' + d.id + '\')">✏️</button>'
      + '<button class="btn bd sm" onclick="delD(\'' + d.id + '\')">🗑️</button>'
      + '</span></td></tr>';
  }).join('');
}

function filterD() {
  var q = document.getElementById('dsq').value.toLowerCase();
  var f = document.getElementById('dff').value;
  var af = document.getElementById('aff').value;
  var sf = document.getElementById('sff').value;
  renderD(D.filter(function(d) {
    if (q && d.name.indexOf(q) < 0) return false;
    if (af && d.accountId !== af) return false;
    if (sf === 'cf' && (!d.source || !d.source.startsWith('cf'))) return false;
    if (sf === 'm' && d.source && d.source.startsWith('cf')) return false;
    var dl = d.daysLeft;
    if (f === 'expired') return dl < 0;
    if (f === '7') return dl >= 0 && dl <= 7;
    if (f === '30') return dl >= 0 && dl <= 30;
    if (f === 'ok') return dl > 30;
    return true;
  }));
}

function updateFilters() {
  var sel = document.getElementById('aff'), cur = sel.value;
  sel.innerHTML = '<option value="">全部账号</option>' + A.concat(CF).map(function(a) {
    return '<option value="' + a.id + '">' + a.name + '</option>';
  }).join('');
  sel.value = cur;
}

function openDM(d) {
  setText2('dmt', d ? '编辑域名' : '添加域名');
  val('did', d ? d.id : ''); val('dname', d ? d.name : ''); val('dreg', d ? d.registrar||'' : '');
  val('durl', d ? d.registrarUrl||'' : ''); val('dreg2', d ? d.registeredAt||'' : '');
  val('dexp', d ? d.expiryDate||'' : ''); val('dacc', d ? d.accountId||'' : '');
  document.getElementById('dar').checked = d ? !!d.autoRenew : false;
  val('dnotes', d ? d.notes||'' : '');
  var rem = d ? (d.reminderDays || [1,7,30]) : [1,7,30];
  document.querySelectorAll('.rt').forEach(function(t) { t.className = 'rt' + (rem.indexOf(+t.dataset.d) >= 0 ? ' on' : ''); });
  openM('dm');
}

function editD(id) { var d = D.find(function(x){return x.id===id;}); if(d) openDM(d); }

function saveD() {
  var id = gval('did');
  var rem = []; document.querySelectorAll('.rt.on').forEach(function(t){ rem.push(+t.dataset.d); });
  var body = { name: gval('dname'), registrar: gval('dreg'), registrarUrl: gval('durl'), accountId: gval('dacc'), registeredAt: gval('dreg2'), expiryDate: gval('dexp'), autoRenew: document.getElementById('dar').checked, notes: gval('dnotes'), reminderDays: rem };
  post(id ? '/api/domains/'+id : '/api/domains', body, id ? 'PUT' : 'POST').then(function(r) {
    if (r) { closeM('dm'); toast('保存成功'); loadD(); loadStats(); }
  });
}

function delD(id) {
  if (!confirm('确认删除？')) return;
  post('/api/domains/'+id, null, 'DELETE').then(function(r){ if(r){ toast('已删除'); loadD(); loadStats(); } });
}

// ── CF ACCOUNTS ──────────────────────────────────────────────────────────────
function renderCF() {
  var g = document.getElementById('cfg');
  if (!CF.length) { g.innerHTML = ''; show('cfe'); return; }
  hide('cfe');
  var cnt = {}; D.forEach(function(d){ cnt[d.accountId] = (cnt[d.accountId]||0)+1; });
  g.innerHTML = CF.map(function(a) {
    return '<div class="ac cf">'
      + '<div class="an">☁ ' + a.name + '</div>'
      + '<div class="am">Cloudflare' + (a.cfAccountName ? ' · ' + a.cfAccountName : '') + '<br><span class="b bc">' + (cnt[a.id]||0) + ' 个域名</span></div>'
      + '<div style="display:flex;gap:6px"><button class="btn bcf sm" onclick="openSync(\'' + a.id + '\')">↻ 同步</button>'
      + '<button class="btn bd sm" onclick="delCF(\'' + a.id + '\')">删除</button></div></div>';
  }).join('');
}

function openCFM() { val('cfn',''); val('cft',''); openM('cfm'); }

function saveCF() {
  var btn = document.getElementById('cfbtn');
  btn.textContent = '验证中...'; btn.disabled = true;
  post('/api/cf-accounts', { name: gval('cfn'), apiToken: gval('cft') }).then(function(r) {
    btn.textContent = '验证并添加'; btn.disabled = false;
    if (r) { closeM('cfm'); toast('添加成功'); loadCF(); }
  });
}

function delCF(id) {
  if (!confirm('删除该 CF 账号？已同步的域名不会删除')) return;
  post('/api/cf-accounts/'+id, null, 'DELETE').then(function(r){ if(r){ toast('已删除'); loadCF(); } });
}

function openSync(cfId) {
  curCFId = cfId;
  var cf = CF.find(function(a){return a.id===cfId;});
  setText2('smt', '同步: ' + (cf ? cf.name : ''));
  show('slding'); hide('sbody'); hide('serr');
  document.getElementById('sftr').style.display = 'none';
  openM('sm');
  post('/api/cf-preview', { cfAccountId: cfId }).then(function(r) {
    hide('slding');
    if (!r || r.error) {
      document.getElementById('serr').textContent = (r && r.error) || '请求失败';
      show('serr'); return;
    }
    document.getElementById('ssum').innerHTML = '找到 <strong style="color:var(--cf)">' + r.total + '</strong> 个域名，<strong style="color:var(--ac)">' + r.newCount + '</strong> 个新域名';
    document.getElementById('slist').innerHTML = '<div class="sph"><span>域名</span><span>到期日期</span></div>'
      + r.domains.map(function(d){
        return '<div class="spr"><span style="font-family:var(--mo)">' + d.name
          + (d.exists ? ' <span class="b bx" style="font-size:10px">已有</span>' : '')
          + (d.source==='cf_zone' ? ' <span class="b bw" style="font-size:10px">无到期日</span>' : '')
          + '</span><span style="color:var(--t2)">' + (d.expiryDate||'需手动填') + '</span></div>';
      }).join('');
    show('sbody');
    document.getElementById('sftr').style.display = 'flex';
  });
}

function doSync() {
  var btn = document.getElementById('sbtn');
  btn.textContent = '同步中...'; btn.disabled = true;
  post('/api/cf-sync', { cfAccountId: curCFId, mode: gval('smod') }).then(function(r) {
    btn.textContent = '确认同步'; btn.disabled = false;
    if (r) { closeM('sm'); toast('新增' + r.added + '个，更新' + r.updated + '个'); loadD(); loadStats(); }
  });
}

// ── MANUAL ACCOUNTS ──────────────────────────────────────────────────────────
function renderA() {
  var g = document.getElementById('acg');
  if (!A.length) { g.innerHTML = ''; show('ace'); return; }
  hide('ace');
  var cnt = {}; D.forEach(function(d){ cnt[d.accountId]=(cnt[d.accountId]||0)+1; });
  g.innerHTML = A.map(function(a){
    return '<div class="ac"><div class="an">' + a.name + '</div>'
      + '<div class="am">' + (a.registrar||'') + (a.email ? ' · ' + a.email : '') + '<br><span class="b bb">' + (cnt[a.id]||0) + ' 个域名</span></div>'
      + (a.loginUrl ? '<a href="' + esc(a.loginUrl) + '" target="_blank" style="font-size:12px;color:var(--bl)">🔗 控制台</a>' : '')
      + '<div style="display:flex;gap:6px;margin-top:10px"><button class="btn bs sm" onclick="editA(\'' + a.id + '\')">编辑</button><button class="btn bd sm" onclick="delA(\'' + a.id + '\')">删除</button></div></div>';
  }).join('');
}

function updateAccSel() {
  document.getElementById('dacc').innerHTML = '<option value="">不关联</option>' + A.concat(CF).map(function(a){
    return '<option value="' + a.id + '">' + a.name + '</option>';
  }).join('');
  updateFilters();
}

function openAM(a) {
  setText2('amt', a ? '编辑账号' : '添加账号');
  val('aid', a?a.id:''); val('aname', a?a.name:''); val('areg', a?a.registrar||'':'');
  val('aemail', a?a.email||'':''); val('aurl', a?a.loginUrl||'':''); val('anotes', a?a.notes||'':'');
  openM('acm');
}
function editA(id){ var a=A.find(function(x){return x.id===id;}); if(a) openAM(a); }
function saveA() {
  var id=gval('aid');
  var body={name:gval('aname'),registrar:gval('areg'),email:gval('aemail'),loginUrl:gval('aurl'),notes:gval('anotes')};
  post(id?'/api/accounts/'+id:'/api/accounts',body,id?'PUT':'POST').then(function(r){if(r){closeM('acm');toast('保存成功');loadA();}});
}
function delA(id){if(!confirm('确认删除？'))return;post('/api/accounts/'+id,null,'DELETE').then(function(r){if(r){toast('已删除');loadA();}});}

// ── TELEGRAM ────────────────────────────────────────────────────────────────
function saveTg() {
  post('/api/telegram', { botToken: gval('tgtok'), chatId: gval('tgcid') }).then(function(r){ if(r){ toast('设置已保存'); loadTg(); } });
}
function check() {
  post('/api/check').then(function(r){ if(r) toast(r.msg||'检查完成'); });
}

// ── MODAL ────────────────────────────────────────────────────────────────────
document.getElementById('rts').onclick = function(e) { var t=e.target.closest('.rt'); if(t) t.className='rt'+(t.className.indexOf(' on')>=0?'':' on'); };
function openM(id){ document.getElementById(id).classList.add('on'); }
function closeM(id){ document.getElementById(id).classList.remove('on'); }
document.querySelectorAll('.mo').forEach(function(m){ m.onclick=function(e){ if(e.target===m) m.classList.remove('on'); }; });

// ── TOAST ────────────────────────────────────────────────────────────────────
function toast(msg, type) {
  var el=document.createElement('div');
  el.className='ti '+(type||'s');
  el.textContent=(type==='e'?'✗ ':type==='i'?'ℹ ':'✓ ')+msg;
  document.getElementById('toast').appendChild(el);
  setTimeout(function(){ el.style.animation='fdo .25s forwards'; setTimeout(function(){ el.remove(); },250); }, 3000);
}

// ── API ──────────────────────────────────────────────────────────────────────
function get(url) {
  return fetch(url, { headers: { 'Content-Type': 'application/json' } })
    .then(function(r) { if (r.status===401){location.reload();return null;} return r.json(); })
    .catch(function(e){ toast('请求失败','e'); return null; });
}
function post(url, body, method) {
  return fetch(url, { method: method||'POST', headers: {'Content-Type':'application/json'}, body: body ? JSON.stringify(body) : undefined })
    .then(function(r) {
      return r.json().then(function(d) {
        if (r.status===401){location.reload();return null;}
        if (!r.ok){ toast(d.error||'操作失败','e'); return null; }
        return d;
      });
    })
    .catch(function(e){ toast('请求失败: '+e.message,'e'); return null; });
}

// ── UTILS ────────────────────────────────────────────────────────────────────
function gval(id){ return document.getElementById(id).value; }
function val(id,v){ document.getElementById(id).value=v||''; }
function setText(id,v){ document.getElementById(id).textContent=v; }
function setText2(id,v){ document.getElementById(id).textContent=v; }
function show(id){ document.getElementById(id).style.display='block'; }
function hide(id){ document.getElementById(id).style.display='none'; }
function esc(s){ return String(s||'').replace(/"/g,'&quot;').replace(/'/g,'&#39;').replace(/</g,'&lt;'); }

// ── AUTO LOGIN CHECK ─────────────────────────────────────────────────────────
fetch('/api/stats').then(function(r) {
  if (r.ok) {
    document.getElementById('login').style.display = 'none';
    document.getElementById('app').style.display = 'flex';
    init();
  }
}).catch(function(){});
</script>
</body>
</html>`; }
