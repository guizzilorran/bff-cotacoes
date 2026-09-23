// bff-cotacoes/server.js
const express = require('express');
const axios = require('axios');
const cheerio = require('cheerio');
const cors = require('cors');

const app = express();
app.use(cors());

// ============================================================
// CACHE
// ============================================================
const cache = {};
function getCache(key) {
  const item = cache[key];
  if (item && Date.now() - item.timestamp < 30 * 60 * 1000) return item.data;
  return null;
}
function setCache(key, data) {
  cache[key] = { data, timestamp: Date.now() };
}

// ============================================================
// ROTA RAIZ
// ============================================================
app.get('/', (req, res) => {
  res.json({
    status: 'OK',
    servico: 'BFF de Cotações IortA',
    rotas: [
      '/api/cotacao?produto=soja (AgroDoc)',
      '/api/cotacao?produto=milho (AgroDoc)',
      '/api/cotacao?produto=boi_gordo (AgroDoc)',
      '/api/cotacao-cafe (CCCV)'
    ]
  });
});

// ============================================================
// 1. COMMODITIES (AgroDoc / CEPEA)
// ============================================================
app.get('/api/cotacao', async (req, res) => {
  const { produto } = req.query;
  if (!produto) return res.status(400).json({ erro: 'Parâmetro "produto" é obrigatório.' });

  const chave = `agrodoc_${produto}`;
  const cacheItem = getCache(chave);
  if (cacheItem) return res.json(cacheItem);

  try {
    const resposta = await axios.get('https://agrodocai.com.br/api/v1/cotacao', {
      timeout: 10000,
      headers: { 'User-Agent': 'IortA-BFF/1.0' }
    });
    const dados = resposta.data;

    const mapa = {
      'boi_gordo':  { nome: 'Boi Gordo',   chave: 'boi_gordo_cepea_sp',  unidade: 'por arroba' },
      'vaca_gorda': { nome: 'Vaca Gorda',  chave: 'vaca_gorda',          unidade: 'por arroba' },
      'bezerro':    { nome: 'Bezerro MS',  chave: 'bezerro_ms',          unidade: 'por cabeça' },
      'soja':       { nome: 'Soja',        chave: 'soja',                unidade: 'por saca 60kg' },
      'milho':      { nome: 'Milho',       chave: 'milho',               unidade: 'por saca 60kg' }
    };

    const info = mapa[produto.toLowerCase()];
    if (!info || dados[info.chave] === undefined) {
      return res.status(404).json({ erro: `Produto "${produto}" não encontrado.`, disponiveis: Object.keys(mapa) });
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
// 2. CAFÉ (CCCV - scraping)
// ============================================================
app.get('/api/cotacao-cafe', async (req, res) => {
  const chave = 'cccv_cafe';
  const cacheItem = getCache(chave);
  if (cacheItem) return res.json(cacheItem);

  try {
    const resposta = await axios.get('https://www.cccv.org.br/cotacao/', {
      timeout: 15000,
      headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36' }
    });

    const $ = cheerio.load(resposta.data);
    const linhas = $('table.tabela tbody tr.linha');

    // Encontra a última linha com valores cotados (não "-")
    let ultimaCotacao = null;

    linhas.each((i, linha) => {
      const colunas = $(linha).find('td.vlinha');
      if (colunas.length >= 4) {
        const dia = $(colunas[0]).text().trim();
        const arabicaDura = $(colunas[1]).text().trim();
        const arabicaRio = $(colunas[2]).text().trim();
        const conilon = $(colunas[3]).text().trim();

        // Se tem valor numérico (não "-" nem vazio)
        if (arabicaDura !== '-' && arabicaDura !== '' && !isNaN(parseFloat(arabicaDura.replace('.', '').replace(',', '.')))) {
          ultimaCotacao = {
            dia: dia,
            arabicaDura: parseFloat(arabicaDura.replace('.', '').replace(',', '.')),
            arabicaRio: parseFloat(arabicaRio.replace('.', '').replace(',', '.')),
            conilon: parseFloat(conilon.replace('.', '').replace(',', '.')),
            data: new Date().toLocaleDateString('pt-BR')
          };
        }
      }
    });

    if (!ultimaCotacao) {
      return res.status(404).json({ erro: 'Não foi possível encontrar cotação do café no CCCV.' });
    }

    const resultado = {
      produto: 'Café',
      arabicaDura: ultimaCotacao.arabicaDura,
      arabicaRio: ultimaCotacao.arabicaRio,
      conilon: ultimaCotacao.conilon,
      unidade: 'por saca 60kg',
      data: ultimaCotacao.data,
      diaReferencia: ultimaCotacao.dia,
      fonte: 'CCCV'
    };

    setCache(chave, resultado);
    res.json(resultado);

  } catch (erro) {
    console.error('Erro CCCV:', erro.message);
    res.status(500).json({ erro: 'Não foi possível obter a cotação do café no momento.' });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`BFF de cotações rodando na porta ${PORT}`);
  console.log(`Teste café: http://localhost:${PORT}/api/cotacao-cafe`);
});