// Utilidades compartilhadas pelas funções do Vercel (arquivos com "_" não viram rotas).
const crypto = require('crypto');

async function chamar(caminho, corpo) {
  const base = process.env.KV_REST_API_URL || process.env.UPSTASH_REDIS_REST_URL;
  const tok = process.env.KV_REST_API_TOKEN || process.env.UPSTASH_REDIS_REST_TOKEN;
  if (!base || !tok) throw new Error('sem-armazenamento');
  const r = await fetch(base + caminho, {
    method: 'POST',
    headers: { Authorization: 'Bearer ' + tok, 'Content-Type': 'application/json' },
    body: JSON.stringify(corpo)
  });
  if (!r.ok) throw new Error('redis ' + r.status);
  return r.json();
}
const redis = async cmd => (await chamar('', cmd)).result;
async function pipe(cmds) {
  const out = await chamar('/pipeline', cmds);
  return out.map(x => { if (x.error) throw new Error(x.error); return x.result; });
}

const ID_OK = /^[a-z2-7]{16}$/;
function novoId() {
  const al = 'abcdefghijklmnopqrstuvwxyz234567', b = crypto.randomBytes(16);
  let s = '';
  for (let i = 0; i < 16; i++) s += al[b[i] % 32];
  return s;
}
const txt = (x, max) => String(x == null ? '' : x).replace(/[\u0000-\u001f]/g, ' ').trim().slice(0, max);

function corpo(req) {
  if (req.body && typeof req.body === 'object') return req.body;
  try { return JSON.parse(req.body || '{}'); } catch (e) { return {}; }
}
const enviar = (res, st, obj) => { res.setHeader('Cache-Control', 'no-store'); return res.status(st).json(obj); };

function ip(req) {
  return String((req.headers && (req.headers['x-forwarded-for'] || req.headers['x-real-ip'])) || 'x').split(',')[0].trim();
}
const espera = ms => new Promise(r => setTimeout(r, ms));

// ---------- Departamentos e PINs ----------
// Departamentos ficam no Redis (chave "departamentos"): [{id,nome,salt,hash}]. O PIN de cada um é guardado só como hash (scrypt).
// PIN MESTRE = variável GESTAO_PIN do Vercel: abre qualquer departamento e é o único que cria/exclui departamentos e define PINs.
const DEP_KEY = 'departamentos';
const DEP_PADRAO = [{ id: 'xi', nome: 'XI' }];
const DEP_ID = /^[a-z0-9-]{1,20}$/;
async function getDeps() {
  const a = parse(await redis(['GET', DEP_KEY]));
  return Array.isArray(a) && a.length ? a : DEP_PADRAO.map(d => ({ ...d }));
}
const saveDeps = deps => redis(['SET', DEP_KEY, JSON.stringify(deps)]);
const depPublico = d => ({ id: d.id, nome: d.nome, temPin: !!d.hash });
const hashPin = (pin, salt) => crypto.scryptSync(String(pin), salt, 32).toString('hex');
function novoHash(pin) { const salt = crypto.randomBytes(16).toString('hex'); return { salt, hash: hashPin(pin, salt) }; }
const igualTxt = (a, b) => { const x = Buffer.from(String(a)), y = Buffer.from(String(b)); return x.length === y.length && crypto.timingSafeEqual(x, y); };
function pinDepOk(d, pin) {
  if (!d || !d.hash || !d.salt) return false;
  const a = Buffer.from(hashPin(pin, d.salt), 'hex'), e = Buffer.from(d.hash, 'hex');
  return a.length === e.length && crypto.timingSafeEqual(a, e);
}
function slug(nome) {
  return String(nome || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 20) || 'dep';
}

// Confere o PIN (mestre ou do departamento depId). Devolve {mestre, dep} ou false (já respondeu o erro).
// Bloqueia o IP após 8 erros em 10 minutos.
async function autenticar(req, res, pin, depId) {
  const mestre = process.env.GESTAO_PIN || '';
  const deps = await getDeps();
  const d = deps.find(x => x.id === depId) || null;
  if (!mestre && !deps.some(x => x.hash)) { enviar(res, 503, { erro: 'PIN da gestão ainda não foi configurado no servidor' }); return false; }
  const chave = 'falhas:' + ip(req);
  const n = parseInt(await redis(['GET', chave]) || '0', 10);
  if (n >= 8) { enviar(res, 429, { erro: 'Muitas tentativas. Aguarde alguns minutos.' }); return false; }
  const p = String(pin || '');
  if (mestre && igualTxt(p, mestre)) return { mestre: true, dep: d ? d.id : null };
  if (d && pinDepOk(d, p)) return { mestre: false, dep: d.id };
  await pipe([['INCR', chave], ['EXPIRE', chave, 600]]);
  await espera(600);
  enviar(res, 401, { erro: 'PIN incorreto' });
  return false;
}

// Nome sempre em MAIÚSCULAS, com espaços normalizados; precisa ter nome e sobrenome.
const nomeNorm = x => txt(x, 80).replace(/\s+/g, ' ').toUpperCase();
const nomeOk = x => nomeNorm(x).split(' ').filter(w => w.length >= 2).length >= 2;
function pessoa(p) {
  return { n: nomeNorm(p && p.nome), re: txt(p && p.re, 20).toUpperCase(), cc: txt(p && p.cc, 20).toUpperCase(), cargo: txt(p && p.cargo, 60).toUpperCase() };
}
function metaLimpa(m) {
  m = m || {};
  return {
    treinamento: txt(m.treinamento, 120), data: txt(m.data, 10), turma: txt(m.turma, 30), local: txt(m.local, 80),
    horario: txt(m.horario, 30), carga: txt(m.carga, 12), instrutor: txt(m.instrutor, 80), extra: txt(m.extra, 200),
    encerrada: !!m.encerrada
  };
}
const MAX_PART = 200;
const parse = v => { try { return JSON.parse(v); } catch (e) { return null; } };
// HGETALL do Upstash volta [campo, valor, campo, valor...]
function pares(arr) { const o = {}; for (let i = 0; i + 1 < (arr || []).length; i += 2) o[arr[i]] = arr[i + 1]; return o; }

module.exports = { getDeps, saveDeps, depPublico, novoHash, slug, DEP_ID, autenticar, nomeNorm, nomeOk, redis, pipe, ID_OK, novoId, txt, corpo, enviar, pessoa, metaLimpa, MAX_PART, parse, pares };
