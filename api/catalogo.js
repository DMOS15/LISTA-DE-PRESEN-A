// Cadastro de treinamentos compartilhado (Vercel Function + Upstash Redis via REST).
// GET  /api/catalogo            -> { ok:true, itens:[...]|null }
// POST /api/catalogo {itens}               -> grava; se EDIT_PASSWORD existir, exige {senha}
// POST /api/catalogo {acao:'restaurar'}      -> desfaz a última publicação (guarda 10 versões)
const crypto = require('crypto');
const KEY = 'catalogo-treinamentos';
const HIST = 'catalogo-treinamentos-historico';
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
  if (!Array.isArray(itens) || itens.length > 500) return null;
  const out = [];
  for (const x of itens) {
    const nome = String((x && x.nome) || '').trim().slice(0, 120);
    const carga = Number(x && x.carga);
    const id = Number.isInteger(x && x.id) ? x.id : out.length + 1;
    if (!nome || !isFinite(carga) || carga <= 0 || carga > 24) return null;
    out.push({ id, nome, carga });
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
        const ok = a.length === e.length && crypto.timingSafeEqual(a, e);
        if (!ok) { await espera(700); return res.status(401).json({ erro: 'Senha incorreta' }); }
      }
      if (b.acao === 'restaurar') {
        const anterior = await redis(['LPOP', HIST]);
        if (!anterior) return res.status(404).json({ erro: 'Não há versão anterior' });
        await redis(['SET', KEY, anterior]);
        return res.status(200).json({ ok: true, itens: JSON.parse(anterior) });
      }
      const itens = validar(b.itens);
      if (!itens) return res.status(400).json({ erro: 'Dados inválidos' });
      const novo = JSON.stringify(itens);
      const atual = await redis(['GET', KEY]);
      if (atual && atual !== novo) {
        await redis(['LPUSH', HIST, atual]);
        await redis(['LTRIM', HIST, 0, 9]);
      }
      await redis(['SET', KEY, novo]);
      return res.status(200).json({ ok: true });
    }
    res.setHeader('Allow', 'GET, POST');
    return res.status(405).json({ erro: 'Método não permitido' });
  } catch (err) {
    return res.status(500).json({ erro: 'Falha ao acessar o armazenamento' });
  }
};
