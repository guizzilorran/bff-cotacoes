// bff-cotacoes/server.js
const express = require('express');
const axios = require('axios');
const cheerio = require('cheerio');
const cors = require('cors');

const app = express();
app.use(cors());

// ============================================================
// CACHE SIMPLES (evita muitas requisições)
// ============================================================
const cache = {};
function getCache(key) {
  const item = cache[key];
  if (item && Date.now() - item.timestamp < 30 * 60 * 1000) {
    return item.data;
  }
  return null;
}
function setCache(key, data) {
  cache[key] = { data, timestamp: Date.now() };
}

// ============================================================
// ROTA RAIZ (teste)
// ============================================================
app.get('/', (req, res) => {
  res.json({
    status: 'OK',
    servico: 'BFF de Cotações IortA',
    rotas: [
      '/api/cotacao?produto=soja',
      '/api/cotacao?produto=milho',
      '/api/cotacao?produto=boi_gordo',
      '/api/cotacao?produto=vaca_gorda',
      '/api/cotacao?produto=bezerro'
    ]
  });
});

// ============================================================
// 1. COTAÇÕES DE COMMODITIES (AgroDoc / CEPEA)
// ============================================================
app.get('/api/cotacao', async (req, res) => {
  const { produto } = req.query;

  if (!produto) {
    return res.status(400).json({ erro: 'O parâmetro "produto" é obrigatório.' });
  }

  const chave = `agrodoc_${produto}`;
  const cacheItem = getCache(chave);
  if (cacheItem) return res.json(cacheItem);

  try {
    const resposta = await axios.get('https://agrodocai.com.br/api/v1/cotacao', {
      timeout: 10000,
      headers: { 'User-Agent': 'IortA-BFF/1.0' }
    });

    const dados = resposta.data;

    // Mapeamento: nome amigável -> chave real na API AgroDoc
    const mapa = {
      'boi_gordo':  { nome: 'Boi Gordo',   chave: 'boi_gordo_cepea_sp',  unidade: 'por arroba' },
      'vaca_gorda': { nome: 'Vaca Gorda',  chave: 'vaca_gorda',          unidade: 'por arroba' },
      'bezerro':    { nome: 'Bezerro MS',  chave: 'bezerro_ms',          unidade: 'por cabeça' },
      'soja':       { nome: 'Soja',        chave: 'soja',                unidade: 'por saca 60kg' },
      'milho':      { nome: 'Milho',       chave: 'milho',               unidade: 'por saca 60kg' }
    };

    const info = mapa[produto.toLowerCase()];

    if (!info || dados[info.chave] === undefined) {
      return res.status(404).json({
        erro: `Produto "${produto}" não encontrado.`,
        disponiveis: Object.keys(mapa)
      });
    }

    const cotacao = {
      produto: info.nome,
      preco: dados[info.chave],
      unidade: info.unidade,
      data: new Date().toLocaleDateString('pt-BR'),
      fonte: 'CEPEA/ESALQ'
    };

    setCache(chave, cotacao);
    res.json(cotacao);

  } catch (erro) {
    console.error('Erro AgroDoc:', erro.message);
    res.status(500).json({ erro: 'Não foi possível obter a cotação no momento.' });
  }
});

// ============================================================
// 2. LISTA DE PRODUTOS DISPONÍVEIS
// ============================================================
app.get('/api/produtos', (req, res) => {
  res.json([
    { id: 'boi_gordo',  nome: 'Boi Gordo' },
    { id: 'vaca_gorda', nome: 'Vaca Gorda' },
    { id: 'bezerro',    nome: 'Bezerro MS' },
    { id: 'soja',       nome: 'Soja' },
    { id: 'milho',      nome: 'Milho' }
  ]);
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`BFF de cotações rodando na porta ${PORT}`);
  console.log(`Teste: http://localhost:${PORT}/api/cotacao?produto=soja`);
});