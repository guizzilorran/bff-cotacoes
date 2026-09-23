// bff-cotacoes/server.js
const express = require('express');
const axios = require('axios');
const cheerio = require('cheerio');
const cors = require('cors');
const fs = require('fs');
const path = require('path');

const app = express();
app.use(cors());

const HISTORY_FILE = path.join(__dirname, 'history.json');

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
// HISTÓRICO (persistido em arquivo JSON)
// ============================================================
function carregarHistorico() {
  try {
    if (!fs.existsSync(HISTORY_FILE)) return {};
    return JSON.parse(fs.readFileSync(HISTORY_FILE, 'utf8'));
  } catch (e) {
    return {};
  }
}
function salvarHistorico(h) {
  try {
    fs.writeFileSync(HISTORY_FILE, JSON.stringify(h, null, 2));
  } catch (e) {
    console.error('Erro ao salvar histórico:', e.message);
  }
}
function registrarPreco(produto, preco) {
  if (!preco || isNaN(preco)) return;
  const hist = carregarHistorico();
  if (!hist[produto]) hist[produto] = [];

  const hoje = new Date().toISOString().split('T')[0];
  const jaTem = hist[produto].some(h => h.data === hoje);

  if (!jaTem) {
    hist[produto].push({ data: hoje, preco });
    // Mantém só os últimos 365 dias
    if (hist[produto].length > 365) hist[produto].shift();
    salvarHistorico(hist);
    console.log(`[HIST] ${produto}: registrado ${preco} em ${hoje}`);
  }
}

// ============================================================
// ESTATÍSTICAS (variação, médias, previsão)
// ============================================================
function calcularEstatisticas(produto, precoAtual) {
  const hist = carregarHistorico()[produto] || [];

  // Registra o preço de hoje
  registrarPreco(produto, precoAtual);

  // Recarrega após registrar
  const histAtualizado = carregarHistorico()[produto] || [];

  // ===== Variação vs ontem =====
  let variacao = null;
  const hoje = new Date();
  for (let i = 1; i <= 7; i++) {
    const dataAnterior = new Date(hoje.getTime() - i * 24 * 60 * 60 * 1000).toISOString().split('T')[0];
    const registro = histAtualizado.find(h => h.data === dataAnterior);
    if (registro && registro.preco > 0) {
      variacao = ((precoAtual - registro.preco) / registro.preco) * 100;
      break;
    }
  }

  // ===== Média dos últimos 7 registros =====
  const ult7 = histAtualizado.slice(-7);
  const mediaSemana = ult7.length >= 2
    ? ult7.reduce((s, h) => s + h.preco, 0) / ult7.length
    : null;

  // ===== Média dos últimos 30 registros =====
  const ult30 = histAtualizado.slice(-30);
  const mediaMes = ult30.length >= 2
    ? ult30.reduce((s, h) => s + h.preco, 0) / ult30.length
    : null;

  // ===== Previsão: regressão linear simples (últimos 14 pontos) =====
  let previsao = null;
  const ult14 = histAtualizado.slice(-14);
  if (ult14.length >= 3) {
    // y = a*x + b
    const n = ult14.length;
    let sumX = 0, sumY = 0, sumXY = 0, sumXX = 0;
    ult14.forEach((p, i) => {
      sumX += i;
      sumY += p.preco;
      sumXY += i * p.preco;
      sumXX += i * i;
    });
    const a = (n * sumXY - sumX * sumY) / (n * sumXX - sumX * sumX);
    const b = (sumY - a * sumX) / n;

    // Projeta para os próximos 3 dias
    previsao = {
      amanha:     a * (n)     + b,
      depois:     a * (n + 1) + b,
      tresDias:   a * (n + 2) + b,
      tendencia:  a > 0.5 ? 'alta' : (a < -0.5 ? 'baixa' : 'estavel')
    };
  }

  return {
    variacao,
    mediaSemana,
    mediaMes,
    previsao,
    amostras: histAtualizado.length
  };
}

// ============================================================
// ROTA RAIZ
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
      '/api/cotacao-cafe'
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
      'soja':       { nome: 'Soja',        chave: 'soja',                unidade: 'por saca 60kg' },
      'milho':      { nome: 'Milho',       chave: 'milho',               unidade: 'por saca 60kg' }
    };

    const info = mapa[produto.toLowerCase()];
    if (!info || dados[info.chave] === undefined) {
      return res.status(404).json({ erro: `Produto "${produto}" não encontrado.`, disponiveis: Object.keys(mapa) });
    }

    const preco = Number(dados[info.chave]);
    const stats = calcularEstatisticas(produto.toLowerCase(), preco);

    const cotacao = {
      produto: info.nome,
      preco: preco,
      unidade: info.unidade,
      data: new Date().toLocaleDateString('pt-BR'),
      fonte: 'CEPEA/ESALQ',
      ...stats
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

    let ultimaCotacao = null;

    linhas.each((i, linha) => {
      const colunas = $(linha).find('td.vlinha');
      if (colunas.length >= 4) {
        const dia = $(colunas[0]).text().trim();
        const arabicaDura = $(colunas[1]).text().trim();
        const arabicaRio = $(colunas[2]).text().trim();
        const conilon = $(colunas[3]).text().trim();

        if (arabicaDura !== '-' && arabicaDura !== '' && !isNaN(parseFloat(arabicaDura.replace('.', '').replace(',', '.')))) {
          ultimaCotacao = {
            dia: dia,
            arabicaDura: parseFloat(arabicaDura.replace('.', '').replace(',', '.')),
            arabicaRio: parseFloat(arabicaRio.replace('.', '').replace(',', '.')),
            conilon: parseFloat(conilon.replace('.', '').replace(',', '.'))
          };
        }
      }
    });

    if (!ultimaCotacao) {
      return res.status(404).json({ erro: 'Não foi possível encontrar cotação do café no CCCV.' });
    }

    // Estatísticas para cada tipo de café
    const statsDura = calcularEstatisticas('cafe_arabica_dura', ultimaCotacao.arabicaDura);
    const statsRio  = calcularEstatisticas('cafe_arabica_rio',  ultimaCotacao.arabicaRio);
    const statsCon  = calcularEstatisticas('cafe_conilon',      ultimaCotacao.conilon);

    const resultado = {
      produto: 'Café',
      arabicaDura: ultimaCotacao.arabicaDura,
      arabicaRio: ultimaCotacao.arabicaRio,
      conilon: ultimaCotacao.conilon,
      unidade: 'por saca 60kg',
      data: new Date().toLocaleDateString('pt-BR'),
      diaReferencia: ultimaCotacao.dia,
      fonte: 'CCCV',
      stats: {
        arabicaDura: statsDura,
        arabicaRio: statsRio,
        conilon: statsCon
      }
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
});