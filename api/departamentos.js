// Departamentos e PINs (Vercel Function + Upstash Redis).
// GET  /api/departamentos                         -> { ok, itens:[{id,nome,temPin}] }   (nunca devolve PIN nem hash)
// POST /api/departamentos {pin, acao, ...}
//   verificar                      (PIN mestre)
//   criar {nome, novoPin?}         (PIN mestre)
//   renomear {id, nome}            (PIN mestre)
//   definirPin {id, novoPin}       (PIN mestre OU o PIN atual do próprio departamento)
//   removerPin {id}                (PIN mestre) -> o departamento passa a abrir só com o PIN mestre
//   excluir {id}                   (PIN mestre) -> só se não houver treinamentos, instrutores ou listas nele
// PIN mestre = variável GESTAO_PIN do Vercel.
const L = require('./_lib');

const PIN_OK = p => typeof p === 'string' && p.length >= 4 && p.length <= 20 && !/[\u0000-\u001f]/.test(p);

module.exports = async (req, res) => {
  try {
    if (req.method === 'GET') {
      const deps = await L.getDeps();
      return L.enviar(res, 200, { ok: true, itens: deps.map(L.depPublico) });
    }
    if (req.method !== 'POST') { res.setHeader('Allow', 'GET, POST'); return L.enviar(res, 405, { erro: 'Método não permitido' }); }
    const b = L.corpo(req);
    const id = String(b.id || '');

    // definirPin aceita o PIN do próprio departamento; todo o resto exige o PIN mestre
    const auth = await L.autenticar(req, res, b.pin, b.acao === 'definirPin' ? id : '');
    if (!auth) return;
    if (b.acao !== 'definirPin' && !auth.mestre) return L.enviar(res, 403, { erro: 'Apenas o PIN mestre faz isso.' });

    const deps = await L.getDeps();
    const achar = () => deps.find(d => d.id === id);

    switch (b.acao) {
      case 'verificar':
        return L.enviar(res, 200, { ok: true, mestre: auth.mestre });

      case 'criar': {
        const nome = L.txt(b.nome, 30);
        if (!nome) return L.enviar(res, 400, { erro: 'Digite o nome do departamento.' });
        if (deps.length >= 40) return L.enviar(res, 400, { erro: 'Limite de 40 departamentos.' });
        if (deps.some(d => d.nome.toLowerCase() === nome.toLowerCase())) return L.enviar(res, 409, { erro: 'Já existe um departamento com esse nome.' });
        if (b.novoPin && !PIN_OK(String(b.novoPin))) return L.enviar(res, 400, { erro: 'O PIN precisa ter de 4 a 20 caracteres.' });
        let novo = L.slug(nome), k = 2;
        while (deps.some(d => d.id === novo)) novo = L.slug(nome).slice(0, 17) + '-' + k++;
        const d = { id: novo, nome };
        if (b.novoPin) Object.assign(d, L.novoHash(String(b.novoPin)));
        deps.push(d);
        await L.saveDeps(deps);
        return L.enviar(res, 200, { ok: true, id: novo });
      }

      case 'renomear': {
        const d = achar();
        if (!d) return L.enviar(res, 404, { erro: 'Departamento não encontrado.' });
        const nome = L.txt(b.nome, 30);
        if (!nome) return L.enviar(res, 400, { erro: 'O nome não pode ficar vazio.' });
        if (deps.some(x => x !== d && x.nome.toLowerCase() === nome.toLowerCase())) return L.enviar(res, 409, { erro: 'Já existe um departamento com esse nome.' });
        d.nome = nome;
        await L.saveDeps(deps);
        return L.enviar(res, 200, { ok: true });
      }

      case 'definirPin': {
        const d = achar();
        if (!d) return L.enviar(res, 404, { erro: 'Departamento não encontrado.' });
        const p = String(b.novoPin || '');
        if (!PIN_OK(p)) return L.enviar(res, 400, { erro: 'O PIN precisa ter de 4 a 20 caracteres.' });
        Object.assign(d, L.novoHash(p));
        await L.saveDeps(deps);
        return L.enviar(res, 200, { ok: true });
      }

      case 'removerPin': {
        const d = achar();
        if (!d) return L.enviar(res, 404, { erro: 'Departamento não encontrado.' });
        delete d.salt; delete d.hash;
        await L.saveDeps(deps);
        return L.enviar(res, 200, { ok: true });
      }

      case 'excluir': {
        const d = achar();
        if (!d) return L.enviar(res, 404, { erro: 'Departamento não encontrado.' });
        if (deps.length <= 1) return L.enviar(res, 400, { erro: 'Não dá para excluir o único departamento.' });
        const [cat, ins] = await L.pipe([['GET', 'catalogo-treinamentos'], ['GET', 'catalogo-instrutores']]);
        const usa = v => (L.parse(v) || []).filter(x => (x && x.dep || 'xi') === id).length;
        const nt = usa(cat), ni = usa(ins);
        const ids = (await L.redis(['ZRANGE', 'sessoes', 0, -1])) || [];
        let nl = 0;
        if (ids.length) {
          const ms = await L.pipe(ids.map(i => ['GET', `sess:${i}`]));
          nl = ms.filter(v => { const m = L.parse(v); return m && (m.dep || 'xi') === id; }).length;
        }
        if (nt || ni || nl) {
          const p = [nt && nt + ' treinamento(s)', ni && ni + ' instrutor(es)', nl && nl + ' lista(s) digital(is)'].filter(Boolean).join(', ');
          return L.enviar(res, 409, { erro: `Esse departamento ainda tem ${p}. Mude ou exclua antes.` });
        }
        await L.saveDeps(deps.filter(x => x !== d));
        return L.enviar(res, 200, { ok: true });
      }

      default:
        return L.enviar(res, 400, { erro: 'Ação inválida' });
    }
  } catch (err) {
    return L.enviar(res, 500, { erro: 'Falha ao acessar o armazenamento' });
  }
};
