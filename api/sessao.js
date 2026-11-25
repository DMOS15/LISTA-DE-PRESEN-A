// Rotas PÚBLICAS da tela de assinatura (quem tem o link da lista).
// GET  /api/sessao?id=ID                          -> cabeçalho + nomes (sem assinaturas)
// POST /api/sessao {acao:'assinar', id, pid, img}  -> registra a assinatura de um participante
// POST /api/sessao {acao:'incluir', id, nome, img} -> inclui quem não estava na lista e assina
// POST /api/sessao {acao:'reservar'|'liberar', id, pid, tok} -> trava/destrava o nome enquanto a pessoa assina
const L = require('./_lib');

const PNG = /^data:image\/png;base64,[A-Za-z0-9+/=]+$/;
// Reserva do nome enquanto alguém assina: vale por RESERVA_MS e é renovada pela tela de assinatura.
// Tudo atômico no Redis (script Lua): só a primeira pessoa que clicar consegue.
const RESERVA_MS = 120000;
const TOKEN_OK = /^[a-z0-9]{8,40}$/;
const LUA_RESERVAR = "local v=redis.call('HGET',KEYS[1],ARGV[1]) " +
  "if v then local k,t=string.match(v,'^([^|]*)|(%d+)$') " +
  "if k and k~=ARGV[2] and (tonumber(ARGV[3])-tonumber(t))<tonumber(ARGV[4]) then return 0 end end " +
  "redis.call('HSET',KEYS[1],ARGV[1],ARGV[2]..'|'..ARGV[3]) return 1";
const LUA_LIBERAR = "local v=redis.call('HGET',KEYS[1],ARGV[1]) " +
  "if v then local k=string.match(v,'^([^|]*)|') if k==ARGV[2] then redis.call('HDEL',KEYS[1],ARGV[1]) return 1 end end return 0";
const reservar = async (id, pid, tok) => (await L.redis(['EVAL', LUA_RESERVAR, '1', `sess:${id}:rs`, pid, tok, String(Date.now()), String(RESERVA_MS)])) === 1;
const liberar = (id, pid, tok) => L.redis(['EVAL', LUA_LIBERAR, '1', `sess:${id}:rs`, pid, tok]);
const imgOk = img => typeof img === 'string' && img.length <= 90000 && PNG.test(img);

module.exports = async (req, res) => {
  try {
    if (req.method === 'GET') {
      const id = String((req.query && req.query.id) || '');
      if (!L.ID_OK.test(id)) return L.enviar(res, 404, { erro: 'Lista não encontrada' });
      const tok = String((req.query && req.query.tok) || '');
      const [meta, pt, sg, rs] = await L.pipe([['GET', `sess:${id}`], ['HGETALL', `sess:${id}:pt`], ['HKEYS', `sess:${id}:sg`], ['HGETALL', `sess:${id}:rs`]]);
      const m = L.parse(meta);
      if (!m) return L.enviar(res, 404, { erro: 'Lista não encontrada' });
      const assinou = new Set(sg || []);
      const agora = Date.now(), ocupados = new Set();
      Object.entries(L.pares(rs)).forEach(([pid, v]) => { const [k, t] = String(v).split('|'); if (k !== tok && agora - Number(t) < RESERVA_MS) ocupados.add(pid); });
      const partes = Object.entries(L.pares(pt)).map(([pid, v]) => ({ pid, ...L.parse(v) }))
        .sort((a, b) => (a.o || 0) - (b.o || 0))
        .map(p => ({ id: p.pid, nome: String(p.n || '').toUpperCase(), assinou: assinou.has(p.pid), ocupado: !assinou.has(p.pid) && ocupados.has(p.pid) }));
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
      if (b.acao === 'reservar' || b.acao === 'liberar') {
        const pid = String(b.pid || ''), tok = String(b.tok || '');
        if (!/^[a-z0-9]{1,24}$/.test(pid) || !TOKEN_OK.test(tok)) return L.enviar(res, 400, { erro: 'Pedido inválido' });
        if (b.acao === 'liberar') { await liberar(id, pid, tok); return L.enviar(res, 200, { ok: true }); }
        const [existe, jaAssinou] = await L.pipe([['HEXISTS', `sess:${id}:pt`, pid], ['HEXISTS', `sess:${id}:sg`, pid]]);
        if (!existe) return L.enviar(res, 404, { erro: 'Participante não encontrado' });
        if (jaAssinou) return L.enviar(res, 409, { erro: 'Este nome já assinou.' });
        if (!(await reservar(id, pid, tok))) return L.enviar(res, 409, { erro: 'Alguém já está assinando este nome.', ocupado: true });
        return L.enviar(res, 200, { ok: true });
      }
      if (!imgOk(b.img)) return L.enviar(res, 400, { erro: 'Assinatura inválida' });
      const reg = JSON.stringify({ img: b.img, t: Date.now() });
      if (b.acao === 'assinar') {
        const pid = String(b.pid || '');
        if (!/^[a-z0-9]{1,24}$/.test(pid)) return L.enviar(res, 400, { erro: 'Participante inválido' });
        const tok = String(b.tok || '');
        if (!TOKEN_OK.test(tok)) return L.enviar(res, 400, { erro: 'Pedido inválido' });
        const [existe] = await L.pipe([['HEXISTS', `sess:${id}:pt`, pid]]);
        if (!existe) return L.enviar(res, 404, { erro: 'Participante não encontrado' });
        // só assina quem está com o nome reservado (ou se ninguém mais o reservou nesse meio tempo)
        if (!(await reservar(id, pid, tok))) return L.enviar(res, 409, { erro: 'Alguém já está assinando este nome.' });
        const [novo] = await L.pipe([['HSETNX', `sess:${id}:sg`, pid, reg]]);
        await L.redis(['HDEL', `sess:${id}:rs`, pid]);
        if (!novo) return L.enviar(res, 409, { erro: 'Este nome já assinou.' });
        return L.enviar(res, 200, { ok: true });
      }
      if (b.acao === 'incluir') {
        const nome = L.nomeNorm(b.nome);
        if (!L.nomeOk(nome)) return L.enviar(res, 400, { erro: 'Digite nome e sobrenome' });
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
