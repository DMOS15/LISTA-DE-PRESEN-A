// Rotas da GESTÃO (exigem o PIN em GESTAO_PIN): criar/listar/abrir/editar listas e ver assinaturas.
// POST /api/gestao {pin, acao, ...}
const L = require('./_lib');

function montarPartes(lista, existentes) {
  // Reaproveita o id de quem já está na lista (mesmo id ou mesmo nome) para não perder a assinatura.
  const porNome = {};
  Object.entries(existentes || {}).forEach(([pid, v]) => { const p = L.parse(v); if (p) porNome[(p.n || '').toLowerCase()] = pid; });
  const usados = new Set(), saida = [];
  (lista || []).slice(0, L.MAX_PART).forEach((raw, i) => {
    const p = L.pessoa(raw);
    if (!p.n) return;
    let pid = raw && raw.id && existentes && existentes[raw.id] !== undefined ? raw.id : porNome[p.n.toLowerCase()];
    if (!pid || usados.has(pid)) pid = 'p' + Date.now().toString(36) + i.toString(36) + Math.floor(Math.random() * 1296).toString(36);
    usados.add(pid);
    saida.push([pid, JSON.stringify({ ...p, o: i + 1 })]);
  });
  return saida;
}

module.exports = async (req, res) => {
  try {
    if (req.method !== 'POST') { res.setHeader('Allow', 'POST'); return L.enviar(res, 405, { erro: 'Método não permitido' }); }
    const b = L.corpo(req);
    if (!(await L.checarPin(req, res, b.pin))) return;
    const id = String(b.id || '');
    const comId = () => { if (!L.ID_OK.test(id)) { L.enviar(res, 404, { erro: 'Lista não encontrada' }); return false; } return true; };

    switch (b.acao) {
      case 'verificar':
        return L.enviar(res, 200, { ok: true });

      case 'criar': {
        const novo = L.novoId(), meta = L.metaLimpa(b.meta), partes = montarPartes(b.participantes, {});
        const cmds = [['SET', `sess:${novo}`, JSON.stringify({ ...meta, criada: Date.now() })], ['ZADD', 'sessoes', Date.now(), novo]];
        if (partes.length) cmds.push(['HSET', `sess:${novo}:pt`, ...partes.flat()]);
        await L.pipe(cmds);
        return L.enviar(res, 200, { ok: true, id: novo });
      }

      case 'listar': {
        const ids = (await L.redis(['ZREVRANGE', 'sessoes', 0, 59])) || [];
        if (!ids.length) return L.enviar(res, 200, { ok: true, listas: [] });
        const r = await L.pipe(ids.flatMap(i => [['GET', `sess:${i}`], ['HLEN', `sess:${i}:pt`], ['HLEN', `sess:${i}:sg`]]));
        const listas = [];
        ids.forEach((i, k) => { const m = L.parse(r[k * 3]); if (m) listas.push({ id: i, meta: m, total: r[k * 3 + 1], assinaram: r[k * 3 + 2] }); });
        return L.enviar(res, 200, { ok: true, listas });
      }

      case 'abrir': {
        if (!comId()) return;
        const [meta, pt, sg] = await L.pipe([['GET', `sess:${id}`], ['HGETALL', `sess:${id}:pt`], ['HGETALL', `sess:${id}:sg`]]);
        const m = L.parse(meta);
        if (!m) return L.enviar(res, 404, { erro: 'Lista não encontrada' });
        const ass = L.pares(sg);
        const participantes = Object.entries(L.pares(pt)).map(([pid, v]) => ({ id: pid, ...L.parse(v) }))
          .sort((a, c) => (a.o || 0) - (c.o || 0))
          .map(p => ({ id: p.id, nome: p.n, re: p.re, cc: p.cc, cargo: p.cargo, extra: !!p.x, assinatura: ass[p.id] ? L.parse(ass[p.id]) : null }));
        return L.enviar(res, 200, { ok: true, id, meta: m, participantes });
      }

      case 'salvar': {
        if (!comId()) return;
        const [meta, pt] = await L.pipe([['GET', `sess:${id}`], ['HGETALL', `sess:${id}:pt`]]);
        const atual = L.parse(meta);
        if (!atual) return L.enviar(res, 404, { erro: 'Lista não encontrada' });
        const existentes = L.pares(pt);
        const nova = { ...atual, ...L.metaLimpa({ ...b.meta, encerrada: atual.encerrada }) };
        const partes = b.participantes ? montarPartes(b.participantes, existentes) : null;
        const cmds = [['SET', `sess:${id}`, JSON.stringify(nova)]];
        if (partes) {
          const manter = new Set(partes.map(p => p[0]));
          // quem entrou na hora ("meu nome não está na lista") continua, a menos que seja o mesmo nome de alguém da lista
          Object.entries(existentes).forEach(([pid, v]) => { const p = L.parse(v); if (p && p.x) manter.add(pid); });
          const sai = Object.keys(existentes).filter(pid => !manter.has(pid));
          if (sai.length) cmds.push(['HDEL', `sess:${id}:pt`, ...sai], ['HDEL', `sess:${id}:sg`, ...sai]);
          if (partes.length) cmds.push(['HSET', `sess:${id}:pt`, ...partes.flat()]);
        }
        await L.pipe(cmds);
        return L.enviar(res, 200, { ok: true });
      }

      case 'zerar': {
        if (!comId()) return;
        await L.pipe([['HDEL', `sess:${id}:sg`, String(b.pid || '')]]);
        return L.enviar(res, 200, { ok: true });
      }

      case 'encerrar': {
        if (!comId()) return;
        const m = L.parse(await L.redis(['GET', `sess:${id}`]));
        if (!m) return L.enviar(res, 404, { erro: 'Lista não encontrada' });
        m.encerrada = !!b.valor;
        await L.redis(['SET', `sess:${id}`, JSON.stringify(m)]);
        return L.enviar(res, 200, { ok: true });
      }

      case 'excluir': {
        if (!comId()) return;
        await L.pipe([['DEL', `sess:${id}`, `sess:${id}:pt`, `sess:${id}:sg`], ['ZREM', 'sessoes', id]]);
        return L.enviar(res, 200, { ok: true });
      }

      default:
        return L.enviar(res, 400, { erro: 'Ação inválida' });
    }
  } catch (err) {
    return L.enviar(res, 500, { erro: 'Falha ao acessar o armazenamento' });
  }
};
