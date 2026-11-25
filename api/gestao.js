// Rotas da GESTÃO (exigem o PIN do departamento ou o PIN mestre): criar/listar/abrir/editar listas e ver assinaturas.
// POST /api/gestao {pin, dep, acao, ...}  — cada departamento só enxerga e mexe nas próprias listas.
const L = require('./_lib');

function montarPartes(lista, existentes) {
  // Reaproveita o id de quem já está na lista (mesmo id ou mesmo nome) para não perder a assinatura.
  const porNome = {};
  Object.entries(existentes || {}).forEach(([pid, v]) => { const p = L.parse(v); if (p) porNome[(p.n || '').toUpperCase()] = pid; });
  const usados = new Set(), saida = [];
  (lista || []).slice(0, L.MAX_PART).forEach((raw, i) => {
    const p = L.pessoa(raw);
    if (!p.n || !L.nomeOk(p.n)) return;
    let pid = raw && raw.id && existentes && existentes[raw.id] !== undefined ? raw.id : porNome[p.n.toUpperCase()];
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
    const auth = await L.autenticar(req, res, b.pin, String(b.dep || ''));
    if (!auth) return;
    if (!auth.dep) return L.enviar(res, 400, { erro: 'Departamento inválido' });
    const dep = auth.dep;
    const id = String(b.id || '');
    const comId = () => { if (!L.ID_OK.test(id)) { L.enviar(res, 404, { erro: 'Lista não encontrada' }); return false; } return true; };
    // listas antigas (sem departamento) pertencem ao XI
    const depDe = m => (m && m.dep) || 'xi';
    if (['abrir', 'salvar', 'zerar', 'encerrar', 'excluir'].includes(b.acao)) {
      if (!comId()) return;
      const m0 = L.parse(await L.redis(['GET', `sess:${id}`]));
      if (!m0) return L.enviar(res, 404, { erro: 'Lista não encontrada' });
      if (depDe(m0) !== dep) return L.enviar(res, 403, { erro: 'Esta lista pertence a outro departamento.' });
    }

    switch (b.acao) {
      case 'verificar':
        return L.enviar(res, 200, { ok: true, mestre: auth.mestre, dep });

      case 'criar': {
        const novo = L.novoId(), meta = L.metaLimpa(b.meta), partes = montarPartes(b.participantes, {});
        const cmds = [['SET', `sess:${novo}`, JSON.stringify({ ...meta, dep, criada: Date.now() })], ['ZADD', 'sessoes', Date.now(), novo]];
        if (partes.length) cmds.push(['HSET', `sess:${novo}:pt`, ...partes.flat()]);
        await L.pipe(cmds);
        return L.enviar(res, 200, { ok: true, id: novo });
      }

      case 'listar': {
        const todos = (await L.redis(['ZREVRANGE', 'sessoes', 0, 299])) || [];
        if (!todos.length) return L.enviar(res, 200, { ok: true, listas: [] });
        const metas = await L.pipe(todos.map(i => ['GET', `sess:${i}`]));
        const ids = [], ms = [];
        todos.forEach((i, k) => { const m = L.parse(metas[k]); if (m && depDe(m) === dep && ids.length < 60) { ids.push(i); ms.push(m); } });
        if (!ids.length) return L.enviar(res, 200, { ok: true, listas: [] });
        const r = await L.pipe(ids.flatMap(i => [['HLEN', `sess:${i}:pt`], ['HLEN', `sess:${i}:sg`]]));
        return L.enviar(res, 200, { ok: true, listas: ids.map((i, k) => ({ id: i, meta: ms[k], total: r[k * 2], assinaram: r[k * 2 + 1] })) });
      }

      case 'abrir': {
        const [meta, pt, sg] = await L.pipe([['GET', `sess:${id}`], ['HGETALL', `sess:${id}:pt`], ['HGETALL', `sess:${id}:sg`]]);
        const m = L.parse(meta);
        if (!m) return L.enviar(res, 404, { erro: 'Lista não encontrada' });
        const ass = L.pares(sg);
        const participantes = Object.entries(L.pares(pt)).map(([pid, v]) => ({ id: pid, ...L.parse(v) }))
          .sort((a, c) => (a.o || 0) - (c.o || 0))
          .map(p => ({ id: p.id, nome: String(p.n || '').toUpperCase(), re: String(p.re || '').toUpperCase(), cc: String(p.cc || '').toUpperCase(), cargo: String(p.cargo || '').toUpperCase(), extra: !!p.x, assinatura: ass[p.id] ? L.parse(ass[p.id]) : null }));
        return L.enviar(res, 200, { ok: true, id, meta: m, participantes });
      }

      case 'salvar': {
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
        await L.pipe([['HDEL', `sess:${id}:sg`, String(b.pid || '')]]);
        return L.enviar(res, 200, { ok: true });
      }

      case 'encerrar': {
        const m = L.parse(await L.redis(['GET', `sess:${id}`]));
        if (!m) return L.enviar(res, 404, { erro: 'Lista não encontrada' });
        m.encerrada = !!b.valor;
        await L.redis(['SET', `sess:${id}`, JSON.stringify(m)]);
        return L.enviar(res, 200, { ok: true });
      }

      case 'excluir': {
        await L.pipe([['DEL', `sess:${id}`, `sess:${id}:pt`, `sess:${id}:sg`, `sess:${id}:rs`], ['ZREM', 'sessoes', id]]);
        return L.enviar(res, 200, { ok: true });
      }

      default:
        return L.enviar(res, 400, { erro: 'Ação inválida' });
    }
  } catch (err) {
    return L.enviar(res, 500, { erro: 'Falha ao acessar o armazenamento' });
  }
};
