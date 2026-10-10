'use strict';

// Small dependency-free ticket server. Keep this service behind HTTPS in production.
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const ROOT = __dirname;
const DATA_DIR = path.join(ROOT, 'data');
const DATA_FILE = path.join(DATA_DIR, 'tickets.json');
const PRODUCTS_FILE = path.join(DATA_DIR, 'products.json');
const COUPONS_FILE = path.join(DATA_DIR, 'coupons.json');
const UPLOADS_DIR = path.join(ROOT, 'uploads');
const PORT = Number(process.env.PORT || 8080);
const ADMIN_USER = process.env.ADMIN_USER;
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD;
const COOKIE_SECURE = process.env.SECURE_COOKIE === 'true';
const SESSION_MS = 8 * 60 * 60 * 1000;
const sessions = new Map();
const attempts = new Map();
const statuses = new Set(['Novo', 'Em análise', 'Aguardando cliente', 'Em atendimento', 'Concluído']);

if (!ADMIN_USER || !ADMIN_PASSWORD || ADMIN_PASSWORD.length < 12) {
  console.error('Configure ADMIN_USER e ADMIN_PASSWORD (mínimo de 12 caracteres) antes de iniciar.');
  process.exit(1);
}
fs.mkdirSync(DATA_DIR, { recursive: true });
fs.mkdirSync(UPLOADS_DIR, { recursive: true });
for (const file of [DATA_FILE, PRODUCTS_FILE, COUPONS_FILE]) if (!fs.existsSync(file)) fs.writeFileSync(file, '[]\n', { mode: 0o600 });

function readTickets() {
  try { return JSON.parse(fs.readFileSync(DATA_FILE, 'utf8')); }
  catch { throw new Error('Não foi possível ler o arquivo de chamados.'); }
}
function saveTickets(items) {
  saveJson(DATA_FILE, items);
}
function readJson(file) {
  try { const value = JSON.parse(fs.readFileSync(file, 'utf8')); return Array.isArray(value) ? value : []; }
  catch { throw new Error('Não foi possível ler os dados do site.'); }
}
function saveJson(file, items) {
  const tmp = file + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(items, null, 2) + '\n', { mode: 0o600 });
  fs.renameSync(tmp, file);
}
function send(res, status, payload, headers = {}) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', ...headers });
  res.end(JSON.stringify(payload));
}
function cookie(res, value, maxAge) {
  const flags = [`jandson_admin=${value}`, 'Path=/', 'HttpOnly', 'SameSite=Strict', `Max-Age=${maxAge}`];
  if (COOKIE_SECURE) flags.push('Secure');
  res.setHeader('Set-Cookie', flags.join('; '));
}
function sessionFor(req) {
  const raw = (req.headers.cookie || '').split(';').map(x => x.trim()).find(x => x.startsWith('jandson_admin='));
  if (!raw) return null;
  const sid = raw.slice('jandson_admin='.length);
  const expires = sessions.get(sid);
  if (!expires || expires < Date.now()) { sessions.delete(sid); return null; }
  sessions.set(sid, Date.now() + SESSION_MS);
  return sid;
}
function sameOrigin(req) {
  const origin = req.headers.origin;
  if (!origin) return true;
  try { return new URL(origin).host === req.headers.host; } catch { return false; }
}
function body(req, max = 32000) {
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', chunk => {
      data += chunk;
      if (Buffer.byteLength(data) > max) { reject(Object.assign(new Error('Requisição muito grande.'), { status: 413 })); req.destroy(); }
    });
    req.on('end', () => {
      try { resolve(JSON.parse(data || '{}')); }
      catch { reject(Object.assign(new Error('Formato de dados inválido.'), { status: 400 })); }
    });
    req.on('error', reject);
  });
}
function clean(value, max) { return typeof value === 'string' ? value.trim().slice(0, max) : ''; }
function emailOk(email) { return !email || /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email); }
function rateLimited(req) {
  const ip = req.socket.remoteAddress || 'unknown';
  const now = Date.now();
  const record = (attempts.get(ip) || []).filter(t => now - t < 15 * 60 * 1000);
  if (record.length >= 8) { attempts.set(ip, record); return true; }
  record.push(now); attempts.set(ip, record); return false;
}
function secureHeaders(res) {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');
  res.setHeader('Content-Security-Policy', "default-src 'self'; img-src 'self' data:; style-src 'self' 'unsafe-inline'; script-src 'self' 'unsafe-inline'; connect-src 'self'; base-uri 'self'; form-action 'self'; frame-ancestors 'none'");
}
const mime = { '.html':'text/html; charset=utf-8', '.css':'text/css; charset=utf-8', '.js':'text/javascript; charset=utf-8', '.json':'application/json; charset=utf-8', '.svg':'image/svg+xml', '.png':'image/png', '.jpg':'image/jpeg', '.jpeg':'image/jpeg', '.webp':'image/webp', '.ico':'image/x-icon' };
const categories = new Set(['iphone', 'apple', 'xiaomi', 'jbl', 'acessorios']);
function productInput(data, current = {}) {
  const name = clean(data.name, 120), category = clean(data.category, 30);
  const description = clean(data.description, 1200), specs = clean(data.specs, 1600);
  const price = data.price === '' || data.price == null ? null : Number(data.price);
  const salePrice = data.salePrice === '' || data.salePrice == null ? null : Number(data.salePrice);
  const stock = clean(data.stock, 60), status = ['rascunho','publicado','desativado'].includes(data.status) ? data.status : 'rascunho';
  const images = Array.isArray(data.images) ? [...new Set(data.images.filter(x => typeof x === 'string' && /^\/uploads\/[a-f0-9-]+\.(?:jpg|png|webp)$/.test(x)))].slice(0, 5) : (current.images || []);
  if (name.length < 2 || !categories.has(category) || !description) throw Object.assign(new Error('Informe nome, categoria e descrição do produto.'), { status: 400 });
  if (price !== null && (!Number.isFinite(price) || price < 0)) throw Object.assign(new Error('Preço inválido.'), { status: 400 });
  if (salePrice !== null && (!Number.isFinite(salePrice) || salePrice < 0 || price === null || salePrice >= price)) throw Object.assign(new Error('Informe o preço normal e um preço promocional menor que ele.'), { status: 400 });
  return { name, category, description, specs, price, salePrice, stock, images, status, active: status === 'publicado' };
}
function couponInput(data) {
  const code = clean(data.code, 32).toUpperCase();
  const type = ['percent','fixed'].includes(data.type) ? data.type : '';
  const amount = Number(data.amount);
  const minOrder = data.minOrder === '' || data.minOrder == null ? null : Number(data.minOrder);
  const dateValue = value => {
    if (!value) return null;
    const parsed = new Date(value);
    if (!Number.isFinite(parsed.getTime())) throw Object.assign(new Error('Informe uma data válida para o cupom.'), { status: 400 });
    return parsed.toISOString();
  };
  const startAt = dateValue(data.startAt);
  const endAt = dateValue(data.endAt);
  const maxUses = data.maxUses === '' || data.maxUses == null ? null : Number(data.maxUses);
  const products = Array.isArray(data.productIds) ? data.productIds.filter(x => typeof x === 'string').slice(0,100) : [];
  const status = ['rascunho','ativo','desativado'].includes(data.status) ? data.status : 'rascunho';
  if (!/^[A-Z0-9_-]{3,32}$/.test(code)) throw Object.assign(new Error('Use um código de 3 a 32 caracteres: letras, números, hífen ou sublinhado.'), { status: 400 });
  if (!type || !Number.isFinite(amount) || amount <= 0 || (type === 'percent' && amount > 100)) throw Object.assign(new Error('Informe um tipo e valor de desconto válidos.'), { status: 400 });
  if (minOrder !== null && (!Number.isFinite(minOrder) || minOrder < 0)) throw Object.assign(new Error('Valor mínimo de compra inválido.'), { status: 400 });
  if (maxUses !== null && (!Number.isInteger(maxUses) || maxUses < 1)) throw Object.assign(new Error('Limite total de usos inválido.'), { status: 400 });
  if (startAt && endAt && new Date(startAt) >= new Date(endAt)) throw Object.assign(new Error('A data final deve ser posterior à inicial.'), { status: 400 });
  return { code, description: clean(data.description, 300), type, amount, minOrder, startAt, endAt, maxUses, productIds: products, status };
}

const server = http.createServer(async (req, res) => {
  secureHeaders(res);
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  try {
    if (url.pathname.startsWith('/api/')) {
      if (!sameOrigin(req)) return send(res, 403, { error: 'Origem não permitida.' });
      if (req.method === 'GET' && url.pathname === '/api/products') {
        const category = url.searchParams.get('category');
        return send(res, 200, { products: readJson(PRODUCTS_FILE).filter(p => p.category === category && p.status === 'publicado') });
      }
      if (req.method === 'GET' && url.pathname === '/api/coupons') {
        const now = Date.now(), code = clean(url.searchParams.get('code'), 32).toUpperCase(), category = clean(url.searchParams.get('category'), 30);
        const products = readJson(PRODUCTS_FILE);
        const coupons = readJson(COUPONS_FILE).filter(c => c.status === 'ativo' && (!c.startAt || Date.parse(c.startAt) <= now) && (!c.endAt || Date.parse(c.endAt) >= now) && (!code || c.code === code) && (!c.productIds?.length || (category && c.productIds.some(id => products.some(p => p.id === id && p.category === category && p.status === 'publicado')))));
        return send(res, 200, { coupons: coupons.map(c => ({ id:c.id, code:c.code, description:c.description, type:c.type, amount:c.amount, minOrder:c.minOrder, startAt:c.startAt, endAt:c.endAt, maxUses:c.maxUses, productIds:c.productIds, applicableProducts:(c.productIds || []).map(id => products.find(p => p.id === id)?.name).filter(Boolean) })) });
      }
      if (req.method === 'POST' && url.pathname === '/api/tickets') {
        const data = await body(req);
        const name = clean(data.name, 100), phone = clean(data.phone, 30), email = clean(data.email, 160);
        const device = clean(data.device, 100), description = clean(data.description, 3000);
        const contactPreference = ['WhatsApp', 'Ligação', 'E-mail'].includes(data.contact) ? data.contact : 'WhatsApp';
        if (name.length < 2 || phone.length < 7 || description.length < 10) return send(res, 400, { error: 'Informe nome, contato e uma descrição com pelo menos 10 caracteres.' });
        if (!emailOk(email)) return send(res, 400, { error: 'Informe um e-mail válido ou deixe o campo em branco.' });
        const items = readTickets();
        const protocol = `JI-${new Date().getFullYear()}-${crypto.randomBytes(3).toString('hex').toUpperCase()}`;
        const now = new Date().toISOString();
        items.unshift({ id: crypto.randomUUID(), protocol, createdAt: now, name, phone, email, device, description, contactPreference, status: 'Novo', statusHistory: [{ status: 'Novo', at: now }] });
        saveTickets(items);
        return send(res, 201, { protocol });
      }
      if (req.method === 'POST' && url.pathname === '/api/admin/login') {
        if (rateLimited(req)) return send(res, 429, { error: 'Muitas tentativas. Aguarde alguns minutos antes de tentar novamente.' });
        const data = await body(req, 4000);
        const u = Buffer.from(String(data.username || ''));
        const v = Buffer.from(ADMIN_USER);
        const p = Buffer.from(String(data.password || ''));
        const q = Buffer.from(ADMIN_PASSWORD);
        const userOk = u.length === v.length && crypto.timingSafeEqual(u, v);
        const passOk = p.length === q.length && crypto.timingSafeEqual(p, q);
        if (!userOk || !passOk) return send(res, 401, { error: 'Usuário ou senha incorretos.' });
        const sid = crypto.randomBytes(32).toString('hex'); sessions.set(sid, Date.now() + SESSION_MS); cookie(res, sid, SESSION_MS / 1000);
        return send(res, 200, { ok: true });
      }
      if (req.method === 'POST' && url.pathname === '/api/admin/logout') {
        const sid = sessionFor(req); if (sid) sessions.delete(sid); cookie(res, '', 0); return send(res, 200, { ok: true });
      }
      if (url.pathname.startsWith('/api/admin/')) {
        if (!sessionFor(req)) return send(res, 401, { error: 'Acesso administrativo necessário.' });
        if (req.method === 'GET' && url.pathname === '/api/admin/tickets') return send(res, 200, { tickets: readTickets() });
        const match = url.pathname.match(/^\/api\/admin\/tickets\/([0-9a-f-]{36})$/i);
        if (req.method === 'PATCH' && match) {
          const data = await body(req, 2000);
          if (!statuses.has(data.status)) return send(res, 400, { error: 'Status inválido.' });
          const items = readTickets(), ticket = items.find(x => x.id === match[1]);
          if (!ticket) return send(res, 404, { error: 'Chamado não encontrado.' });
          const now = new Date().toISOString();
          if (ticket.status !== data.status) (ticket.statusHistory ||= []).push({ status: data.status, at: now });
          ticket.status = data.status; ticket.updatedAt = now; saveTickets(items);
          return send(res, 200, { ok: true });
        }
        if (req.method === 'GET' && url.pathname === '/api/admin/products') return send(res, 200, { products: readJson(PRODUCTS_FILE) });
        if (req.method === 'POST' && url.pathname === '/api/admin/products') {
          const data = await body(req), products = readJson(PRODUCTS_FILE);
          const product = { id: crypto.randomUUID(), ...productInput(data), createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() };
          products.unshift(product); saveJson(PRODUCTS_FILE, products); return send(res, 201, { product });
        }
        const productRoute = url.pathname.match(/^\/api\/admin\/products\/([0-9a-f-]{36})$/i);
        if (productRoute) {
          const products = readJson(PRODUCTS_FILE), index = products.findIndex(x => x.id === productRoute[1]);
          if (index < 0) return send(res, 404, { error: 'Produto não encontrado.' });
          if (req.method === 'PUT') {
            const data = await body(req), old = products[index];
            products[index] = { ...old, ...productInput(data, old), updatedAt: new Date().toISOString() };
            saveJson(PRODUCTS_FILE, products);
            for (const src of (old.images || [])) if (!(products[index].images || []).includes(src) && !products.some((p, i) => i !== index && (p.images || []).includes(src))) {
              const name = path.basename(src); if (/^[a-f0-9-]+\.(jpg|png|webp)$/.test(name)) fs.rmSync(path.join(UPLOADS_DIR, name), { force: true });
            }
            return send(res, 200, { product: products[index] });
          }
          if (req.method === 'DELETE') {
            const [removed] = products.splice(index, 1); saveJson(PRODUCTS_FILE, products);
            for (const src of (removed.images || [])) {
              if (!products.some(p => (p.images || []).includes(src))) { const name = path.basename(src); if (/^[a-f0-9-]+\.(jpg|png|webp)$/.test(name)) fs.rmSync(path.join(UPLOADS_DIR, name), { force: true }); }
            }
            return send(res, 200, { ok: true });
          }
        }
        if (req.method === 'POST' && url.pathname === '/api/admin/images') {
          const data = await body(req, 4_500_000);
          const match = typeof data.dataUrl === 'string' && data.dataUrl.match(/^data:image\/(jpeg|png|webp);base64,([A-Za-z0-9+/=]+)$/);
          if (!match) return send(res, 400, { error: 'Envie uma imagem JPEG, PNG ou WebP válida.' });
          const bytes = Buffer.from(match[2], 'base64');
          if (bytes.length < 16 || bytes.length > 3 * 1024 * 1024 || bytes.toString('base64') !== match[2]) return send(res, 400, { error: 'A imagem deve ter no máximo 3 MB e estar em base64 válido.' });
          const kind = bytes.subarray(0, 8).toString('hex');
          const actual = kind.startsWith('ffd8ff') ? 'jpeg' : (kind === '89504e470d0a1a0a' ? 'png' : (bytes.toString('ascii', 0, 4) === 'RIFF' && bytes.toString('ascii', 8, 12) === 'WEBP' ? 'webp' : ''));
          if (!actual || actual !== match[1]) return send(res, 400, { error: 'O conteúdo do arquivo não corresponde ao formato informado.' });
          const filename = crypto.randomUUID() + (actual === 'jpeg' ? '.jpg' : `.${actual}`);
          fs.writeFileSync(path.join(UPLOADS_DIR, filename), bytes, { flag: 'wx', mode: 0o644 });
          return send(res, 201, { url: `/uploads/${filename}` });
        }
        const imageRoute = url.pathname.match(/^\/api\/admin\/images\/([a-f0-9-]+\.(?:jpg|png|webp))$/i);
        if (req.method === 'DELETE' && imageRoute) {
          const filename = imageRoute[1], src = `/uploads/${filename}`;
          if (readJson(PRODUCTS_FILE).some(p => (p.images || []).includes(src))) return send(res, 409, { error: 'Esta imagem ainda está vinculada a um produto.' });
          fs.rmSync(path.join(UPLOADS_DIR, filename), { force: true }); return send(res, 200, { ok: true });
        }
        if (req.method === 'GET' && url.pathname === '/api/admin/coupons') return send(res, 200, { coupons: readJson(COUPONS_FILE) });
        if (req.method === 'POST' && url.pathname === '/api/admin/coupons') {
          const data = await body(req), coupons = readJson(COUPONS_FILE), cleanCoupon = couponInput(data);
          if (coupons.some(c => c.code === cleanCoupon.code)) return send(res, 409, { error: 'Já existe um cupom com esse código.' });
          const coupon = { id: crypto.randomUUID(), ...cleanCoupon, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() };
          coupons.unshift(coupon); saveJson(COUPONS_FILE, coupons); return send(res, 201, { coupon });
        }
        const couponRoute = url.pathname.match(/^\/api\/admin\/coupons\/([0-9a-f-]{36})$/i);
        if (couponRoute) {
          const coupons = readJson(COUPONS_FILE), index = coupons.findIndex(x => x.id === couponRoute[1]);
          if (index < 0) return send(res, 404, { error: 'Cupom não encontrado.' });
          if (req.method === 'PUT') {
            const cleanCoupon = couponInput(await body(req));
            if (coupons.some((c, i) => i !== index && c.code === cleanCoupon.code)) return send(res, 409, { error: 'Já existe um cupom com esse código.' });
            coupons[index] = { ...coupons[index], ...cleanCoupon, updatedAt: new Date().toISOString() };
            saveJson(COUPONS_FILE, coupons); return send(res, 200, { coupon: coupons[index] });
          }
          if (req.method === 'DELETE') { coupons.splice(index, 1); saveJson(COUPONS_FILE, coupons); return send(res, 200, { ok: true }); }
        }
        return send(res, 404, { error: 'Rota administrativa não encontrada.' });
      }
      return send(res, 404, { error: 'Rota não encontrada.' });
    }

    const pathname = decodeURIComponent(url.pathname === '/' ? '/index.html' : url.pathname);
    const file = path.resolve(ROOT, '.' + pathname);
    if (!file.startsWith(ROOT + path.sep) || file.startsWith(DATA_DIR + path.sep) || (file.startsWith(UPLOADS_DIR + path.sep) && !/^[a-f0-9-]+\.(?:jpg|png|webp)$/i.test(path.basename(file)))) return send(res, 404, { error: 'Página não encontrada.' });
    fs.readFile(file, (err, content) => {
      if (err) { res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' }); return res.end('Página não encontrada.'); }
      res.writeHead(200, { 'Content-Type': mime[path.extname(file).toLowerCase()] || 'application/octet-stream', 'Cache-Control': 'no-cache' });
      res.end(content);
    });
  } catch (error) {
    if (!res.headersSent) send(res, error.status || 500, { error: error.status ? error.message : 'Erro interno ao processar a solicitação.' });
    else res.destroy();
  }
});

server.listen(PORT, process.env.HOST || '127.0.0.1', () => console.log(`Jandson iPhone disponível em http://${process.env.HOST || '127.0.0.1'}:${PORT}.`));
