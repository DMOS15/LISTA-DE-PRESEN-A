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

// PIN da gestão: variável GESTAO_PIN no Vercel. Bloqueia o IP após 8 erros em 10 minutos.
async function checarPin(req, res, pin) {
  const esperado = process.env.GESTAO_PIN || '';
  if (!esperado) { enviar(res, 503, { erro: 'PIN da gestão ainda não foi configurado no servidor' }); return false; }
  const chave = 'falhas:' + ip(req);
  const n = parseInt(await redis(['GET', chave]) || '0', 10);
  if (n >= 8) { enviar(res, 429, { erro: 'Muitas tentativas. Aguarde alguns minutos.' }); return false; }
  const a = Buffer.from(String(pin || '')), e = Buffer.from(esperado);
  if (a.length === e.length && crypto.timingSafeEqual(a, e)) return true;
  await pipe([['INCR', chave], ['EXPIRE', chave, 600]]);
  await espera(600);
  enviar(res, 401, { erro: 'PIN incorreto' });
  return false;
}

// Nome sempre em MAIÚSCULAS, com espaços normalizados; precisa ter nome e sobrenome.
const nomeNorm = x => txt(x, 80).replace(/\s+/g, ' ').toUpperCase();
const nomeOk = x => nomeNorm(x).split(' ').filter(w => w.length >= 2).length >= 2;
function pessoa(p) {
  return { n: nomeNorm(p && p.nome), re: txt(p && p.re, 20), cc: txt(p && p.cc, 20), cargo: txt(p && p.cargo, 60) };
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

module.exports = { nomeNorm, nomeOk, redis, pipe, ID_OK, novoId, txt, corpo, enviar, checarPin, pessoa, metaLimpa, MAX_PART, parse, pares };
