// Rotas PÚBLICAS da tela de assinatura (quem tem o link da lista).
// GET  /api/sessao?id=ID                          -> cabeçalho + nomes (sem assinaturas)
// POST /api/sessao {acao:'assinar', id, pid, img}  -> registra a assinatura de um participante
// POST /api/sessao {acao:'incluir', id, nome, img} -> inclui quem não estava na lista e assina
const L = require('./_lib');

const PNG = /^data:image\/png;base64,[A-Za-z0-9+/=]+$/;
const imgOk = img => typeof img === 'string' && img.length <= 90000 && PNG.test(img);

module.exports = async (req, res) => {
  try {
    if (req.method === 'GET') {
      const id = String((req.query && req.query.id) || '');
      if (!L.ID_OK.test(id)) return L.enviar(res, 404, { erro: 'Lista não encontrada' });
      const [meta, pt, sg] = await L.pipe([['GET', `sess:${id}`], ['HGETALL', `sess:${id}:pt`], ['HKEYS', `sess:${id}:sg`]]);
      const m = L.parse(meta);
      if (!m) return L.enviar(res, 404, { erro: 'Lista não encontrada' });
      const assinou = new Set(sg || []);
      const partes = Object.entries(L.pares(pt)).map(([pid, v]) => ({ pid, ...L.parse(v) }))
        .sort((a, b) => (a.o || 0) - (b.o || 0))
        .map(p => ({ id: p.pid, nome: p.n, assinou: assinou.has(p.pid) }));
      const { treinamento, data, turma, local, horario, instrutor, encerrada } = m;
      return L.enviar(res, 200, { ok: true, meta: { treinamento, data, turma, local, horario, instrutor, encerrada: !!encerrada }, participantes: partes });
    }
    if (req.method === 'POST') {
      const b = L.corpo(req);
      const id = String(b.id || '');
      if (!L.ID_OK.test(id)) return L.enviar(res, 404, { erro: 'Lista não encontrada' });
      const m = L.parse(await L.redis(['GET', `sess:${id}`]));
      if (!m) return L.enviar(res, 404, { erro: 'Lista não encontrada' });
      if (m.encerrada) return L.enviar(res, 403, { erro: 'Esta lista já foi encerrada' });
      if (!imgOk(b.img)) return L.enviar(res, 400, { erro: 'Assinatura inválida' });
      const reg = JSON.stringify({ img: b.img, t: Date.now() });
      if (b.acao === 'assinar') {
        const pid = String(b.pid || '');
        if (!/^[a-z0-9]{1,24}$/.test(pid)) return L.enviar(res, 400, { erro: 'Participante inválido' });
        const [existe] = await L.pipe([['HEXISTS', `sess:${id}:pt`, pid]]);
        if (!existe) return L.enviar(res, 404, { erro: 'Participante não encontrado' });
        const [novo] = await L.pipe([['HSETNX', `sess:${id}:sg`, pid, reg]]);
        if (!novo) return L.enviar(res, 409, { erro: 'Este nome já assinou' });
        return L.enviar(res, 200, { ok: true });
      }
      if (b.acao === 'incluir') {
        const nome = L.txt(b.nome, 80);
        if (nome.length < 3) return L.enviar(res, 400, { erro: 'Digite o nome completo' });
        const [qtd] = await L.pipe([['HLEN', `sess:${id}:pt`]]);
        if (qtd >= L.MAX_PART) return L.enviar(res, 400, { erro: 'Lista cheia' });
        const pid = 'x' + Date.now().toString(36) + Math.floor(Math.random() * 1296).toString(36);
        await L.pipe([
          ['HSET', `sess:${id}:pt`, pid, JSON.stringify({ n: nome, re: '', cc: '', cargo: '', o: Date.now(), x: 1 })],
          ['HSET', `sess:${id}:sg`, pid, reg]
        ]);
        return L.enviar(res, 200, { ok: true });
      }
      return L.enviar(res, 400, { erro: 'Ação inválida' });
    }
    res.setHeader('Allow', 'GET, POST');
    return L.enviar(res, 405, { erro: 'Método não permitido' });
  } catch (err) {
    return L.enviar(res, 500, { erro: 'Falha ao acessar o armazenamento' });
  }
};
