// Cadastro de instrutores compartilhado (Vercel Function + Upstash Redis via REST).
// GET  /api/instrutores           -> { ok:true, itens:[{id,nome}]|null }
// POST /api/instrutores {itens}   -> grava; se EDIT_PASSWORD existir, exige {senha}
const crypto = require('crypto');
const KEY = 'catalogo-instrutores';
const espera = ms => new Promise(r => setTimeout(r, ms));

async function redis(cmd) {
  const url = process.env.KV_REST_API_URL || process.env.UPSTASH_REDIS_REST_URL;
  const tok = process.env.KV_REST_API_TOKEN || process.env.UPSTASH_REDIS_REST_TOKEN;
  if (!url || !tok) throw new Error('sem-armazenamento');
  const r = await fetch(url, {
    method: 'POST',
    headers: { Authorization: 'Bearer ' + tok, 'Content-Type': 'application/json' },
    body: JSON.stringify(cmd)
  });
  if (!r.ok) throw new Error('redis ' + r.status);
  return (await r.json()).result;
}

function validar(itens) {
  if (!Array.isArray(itens) || itens.length > 300) return null;
  const out = [];
  for (const x of itens) {
    const nome = String((x && x.nome) || '').replace(/[\u0000-\u001f]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 80);
    const id = Number.isInteger(x && x.id) ? x.id : out.length + 1;
    if (!nome) return null;
    out.push({ id, nome });
  }
  return out;
}

module.exports = async (req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  try {
    if (req.method === 'GET') {
      const v = await redis(['GET', KEY]);
      let itens = null;
      try { itens = v ? JSON.parse(v) : null; } catch (e) {}
      return res.status(200).json({ ok: true, itens, protegido: !!process.env.EDIT_PASSWORD });
    }
    if (req.method === 'POST') {
      const b = typeof req.body === 'string' ? JSON.parse(req.body || '{}') : (req.body || {});
      const esperado = process.env.EDIT_PASSWORD || '';
      if (esperado) {
        const a = Buffer.from(String(b.senha || '')), e = Buffer.from(esperado);
        if (!(a.length === e.length && crypto.timingSafeEqual(a, e))) { await espera(700); return res.status(401).json({ erro: 'Senha incorreta' }); }
      }
      const itens = validar(b.itens);
      if (!itens) return res.status(400).json({ erro: 'Dados inválidos' });
      await redis(['SET', KEY, JSON.stringify(itens)]);
      return res.status(200).json({ ok: true });
    }
    res.setHeader('Allow', 'GET, POST');
    return res.status(405).json({ erro: 'Método não permitido' });
  } catch (err) {
    return res.status(500).json({ erro: 'Falha ao acessar o armazenamento' });
  }
};
