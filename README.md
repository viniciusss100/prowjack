# 🎬 ProwJack PRO

**Addon Stremio v3.12 otimizado para Jackett/Prowlarr com suporte a Debrid, StremThru, P2P e qBittorrent HTTP**

ProwJack PRO é um addon avançado para Stremio que integra indexadores Jackett/Prowlarr com serviços Debrid (Real-Debrid, TorBox), StremThru, P2P nativo e qBittorrent HTTP opcional, oferecendo streaming de alta qualidade com priorização inteligente de idioma PT-BR.

---

## ✨ Funcionalidades

### 🎯 Core
- **Integração Prowlarr**: Busca em múltiplos indexadores públicos e privados
- **Catálogo RSS**: Polling automático de indexers do Prowlarr/Jackett com catálogo de lançamentos recentes no Stremio
- **Suporte Debrid**: Real-Debrid, TorBox e StremThru
- **P2P nativo**: Magnet/infoHash direto no Stremio quando Debrid não está ativo
- **qBittorrent HTTP**: Streaming direto de torrents via HTTP em instâncias auto-hospedadas
- **Priorização PT-BR**: Sistema inteligente de ranking por idioma
- **Cache Distribuído**: Redis + fallback em memória
- **Anime Support**: Detecção automática e indexadores especializados

### 🔍 Busca Inteligente
- **Busca Estruturada**: Torznab com IMDb ID para precisão máxima
- **Fallback Texto**: Busca por título quando estruturada falha
- **Deduplicação**: Remove releases duplicados por hash e título
- **Filtros Avançados**: Qualidade, resolução, idioma, keywords
- **Match Score**: Algoritmo de relevância por tokens e aliases

### 🚀 Performance
- **Busca Paralela**: Consulta múltiplos indexadores simultaneamente
- **Cache Inteligente**: 30min para resultados, 30min para rate limits
- **Background Polling**: Continua buscas lentas em segundo plano
- **Rate Limit**: Proteção automática contra sobrecarga

### 🔒 Segurança
- **CORS Configurável**: Controle de origens permitidas
- **Rate Limiting**: Proteção contra abuso (100 req/min por IP)
- **Path Traversal Protection**: Validação de caminhos de arquivo
- **ReDoS Prevention**: Timeout em regex complexas
- **Input Validation**: Sanitização de todos os parâmetros
- **Buffer Overflow Protection**: Validação de tamanho de buffers
- **Configuração opaca**: URLs novas usam `cfg_...` salvo no backend, evitando chaves Debrid/qBit diretamente na URL

---

## 📡 Catálogo RSS

O ProwJack PRO inclui um sistema de catálogo automático baseado no feed RSS dos indexers configurados no **Prowlarr/Jackett**. Isso permite visualizar lançamentos recentes diretamente no Stremio, sem precisar buscar manualmente.

### Como funciona

1. A cada 45 minutos, o addon consulta o feed RSS de todos os indexers marcados como `private` ou `semiPrivate` no Prowlarr
2. Os itens são salvos no Redis com TTL de 24h
3. Os metadados (poster, descrição, nota) são resolvidos via Cinemeta e salvos em catálogo separado
4. O catálogo aparece no Stremio como **"[Nome do Addon] — Lançamentos"** para filmes e séries
5. Ao clicar num item, o stream handler busca diretamente no cache RSS filtrado pelos indexers da configuração atual
6. Os buffers dos arquivos `.torrent` são cacheados no Redis (TTL 7 dias) para evitar re-downloads

### Requisitos

- **Prowlarr** (recomendado) — suporta filtro por `privacy: private/semiPrivate`
- Jackett pode ser usado, mas não distingue indexers públicos de privados (todos aparecem no catálogo)
- Processo Node persistente. Em plataformas serverless como Vercel, o poller em memória/setInterval não é confiável; use VPS/Docker ou um worker/cron externo para alimentar o Redis.

> **Importante sobre Vercel/serverless:** Redis configurado não basta para o catálogo RSS funcionar. O Redis só armazena os dados; quem popula esses dados é o poller RSS (`startRssPoller`) rodando em processo persistente. Em Vercel, a função pode ser encerrada antes do intervalo rodar ou não ficar viva para manter o catálogo atualizado. Streams sob demanda funcionam melhor em serverless; catálogo RSS exige VPS/Docker ou um job externo chamando uma rotina de polling.

### Configuração

No `.env`:
```bash
# URL do Prowlarr (deve ser acessível de dentro do container)
JACKETT_URL=http://prowlarr:9696

# API Key do Prowlarr (Settings → General → API Key)
JACKETT_API_KEY=sua_api_key_aqui

# Token de acesso ao addon (opcional — protege streams contra uso não autorizado)
# Deve ser preenchido também no campo "Token de Acesso" na UI de configuração
ACCESS_TOKEN=
```

> **Nota sobre rede Docker:** Se o Prowlarr não estiver na mesma rede Docker, use o IP do gateway (ex: `http://172.18.0.1:9696`). Verifique com `docker inspect prowjack | grep Gateway`.

### Proteção por Token

Quando `ACCESS_TOKEN` está definido no `.env`:
- Streams e debrid-add exigem que o manifest tenha sido gerado com o mesmo token
- Catálogo e meta são públicos (necessário para o Stremio Web/Android funcionar)
- Configure o token na UI antes de gerar o manifest

### Seletividade de Indexers

Na UI de configuração, a seleção de indexers também limita o que aparece no catálogo RSS daquela instalação. Deixe `Todos` para usar tudo que o poller salvou no Redis.

### Chaves Redis

| Chave | Conteúdo | TTL |
|-------|----------|-----|
| `rss:v12-native-debrid:{indexerId}:{type}:*` | Itens do feed por indexer e tipo | 24h |
| `rss:catalog:movie` | Catálogo de filmes (metadados Cinemeta) | 6h |
| `rss:catalog:series` | Catálogo de séries (metadados Cinemeta) | 6h |
| `torrent:{hash}` | Buffer do arquivo `.torrent` | 7 dias |

Para limpar o catálogo manualmente:
```bash
docker exec prowjack node -e "
const Redis = require('ioredis');
const r = new Redis(process.env.REDIS_URL);
r.keys('rss:catalog:*').then(async k => { if(k.length) await r.del(...k); r.disconnect(); });
"
```

---

### Docker Compose (Recomendado)

```yaml
version: '3.8'
services:
  prowjack:
    image: node:20-alpine
    container_name: prowjack-pro
    working_dir: /app
    volumes:
      - ./:/app
      - /path/to/downloads:/data/prowjack
    ports:
      - "7014:7014"
    environment:
      - NODE_ENV=production
    env_file:
      - .env
    command: npm start
    restart: unless-stopped
```

### Manual

```bash
# Clone o repositório
git clone https://github.com/seu-usuario/prowjack-pro.git
cd prowjack-pro

# Instale as dependências
npm install

# Configure as variáveis de ambiente
cp .env.example .env
nano .env

# Inicie o servidor
npm start
```

---

## ⚙️ Configuração

### Variáveis de Ambiente

Edite o arquivo `.env`:

```bash
# Prowlarr (recomendado) ou Jackett
# Use o nome do serviço Docker ou IP do gateway se não estiver na mesma rede
JACKETT_URL=http://prowlarr:9696
JACKETT_API_KEY=sua_api_key_aqui

# Token de acesso ao addon (opcional — protege streams contra uso não autorizado)
ACCESS_TOKEN=

# Redis (Recomendado)
REDIS_URL=redis://localhost:6379

# RSS Catalog — Indexers que terão catálogo gerado (IDs ou nomes separados por vírgula)
# Deixe vazio para incluir todos os indexers privados no catálogo
# Exemplo: RSS_CATALOG_INDEXERS=5,11,CapybaraBR
RSS_CATALOG_INDEXERS=
# Scrap — Manifests de addons externos para busca adicional (separados por vírgula)
# Streams desses addons têm prioridade sobre trackers privados, mas não sobre debrid
# Exemplo: SCRAP_MANIFEST_URLS=https://torrentio.strem.fun/manifest.json,https://outro.addon/manifest.json
SCRAP_MANIFEST_URLS=

# qBittorrent (Opcional - para torrents privados)
QBIT_URL=http://localhost:8080
QBIT_USER=admin
QBIT_PASS=sua_senha_aqui
QBIT_SAVE_DIR=/data/prowjack
QBIT_MIN_PROGRESS=0.02
QBIT_BUFFER_TIMEOUT=120

# Porta do servidor
PORT=7014
```

### Configuração via Interface Web

1. Acesse `http://localhost:7014/configure`
2. Configure:
   - **Indexadores**: Selecione os indexadores desejados
   - **Categorias**: Filmes, Séries, Anime
   - **Idioma**: Prioridade PT-BR, Dublado, Multi-Audio
   - **Debrid**: Real-Debrid/TorBox nativo ou StremThru
- **qBittorrent HTTP**: opcional, somente em instância auto-hospedada com variáveis no `.env`
   - **Filtros**: Qualidade mínima, keywords, pesos
3. Copie a URL gerada e adicione no Stremio

---

## 🎮 Uso

### Adicionar ao Stremio

1. Abra o Stremio
2. Vá em **Addons** → **Community Addons**
3. Cole a URL configurada: `http://localhost:7014/{config}/manifest.json`
4. Clique em **Install**

### Modos de Operação

#### 🔥 Modo Debrid (Recomendado)
- **Nativo**: Real-Debrid e/ou TorBox direto pelo ProwJack
- **StremThru**: o ProwJack mantém URL própria e consulta o manifest proxy em tempo de execução
- **Cache/On-demand**: links prontos quando cacheados; torrents não cacheados são enviados ao serviço conforme suporte do provedor

#### ⚡ Modo qBittorrent
- **Torrents Privados**: Suporte completo via upload de .torrent
- **Streaming HTTP**: Reproduz enquanto baixa (buffer mínimo 1-2%)
- **Priorização**: Foca no arquivo do episódio específico
- **Configuração server-side**: usa apenas `QBIT_URL`, `QBIT_USER` e `QBIT_PASS` do `.env`; não é configurado pela URL do usuário
- **Hospedagem**: não funciona em Vercel/serverless, porque precisa alcançar seu qBittorrent e servir arquivos locais por HTTP

#### 🧲 Modo P2P
- **Magnet Links**: Envia magnets diretamente ao Stremio
- **Sem Debrid**: funciona nativamente no Stremio
- **Com Debrid/StremThru**: os magnets são usados como entrada para conversão em links Debrid
- **Formatação**: streams P2P não exibem mais uma tag `P2P` na descrição para evitar confusão quando Debrid/StremThru está ativo

---

## 🏗️ Arquitetura

### Fluxo de Busca

```
1. Stremio solicita streams → ProwJack
2. ProwJack consulta Cinemeta → Metadados (título, ano, IMDb)
3. Busca paralela em indexadores:
   ├─ Busca estruturada (Torznab + IMDb)
   └─ Fallback texto (título + ano)
4. Extração de InfoHash:
   ├─ Magnet → Parse direto
   ├─ .torrent → Download + SHA1 do dict info
   └─ Fallback → InfoHash do Jackett
5. Cache/Proxy:
   ├─ Debrid nativo: batch check RD/TB
   ├─ StremThru: manifest proxy gerado sem qBit e consumido pelo ProwJack
   └─ Sem Debrid: magnets/infoHash nativos
6. Ranking e Deduplicação:
   ├─ Cache > Uncached
   ├─ Idioma > Resolução > Qualidade
   └─ Remove duplicatas por hash + título
7. Resolução de Streams:
   ├─ Debrid: URL direta ou on-demand
   ├─ qBit: Job token → HTTP stream
   └─ P2P: Magnet link
8. Retorna streams ao Stremio
```

### Componentes

```
prowjack/
├── addon.js              # Core do addon (rotas, busca, cache)
├── debrid.js             # Integração RD/TB (batch check, resolve)
├── providers/
│   └── qbittorrent.js    # Backend qBittorrent (add, stream, buffer)
├── torrentEnrich.js      # Injeção de trackers em .torrent
├── config.js             # Configurações estáticas
├── public/
│   └── configure.html    # Interface de configuração
└── .env                  # Variáveis de ambiente
```

---

## 🔧 API Endpoints

### Públicos

- `GET /` → Redireciona para `/configure`
- `GET /configure` → Interface de configuração
- `GET /manifest.json` → Manifest base (sem config)
- `GET /:config/manifest.json` → Manifest configurado
- `GET /:config/stream/:type/:id.json` → Busca streams

### Administrativos

- `GET /api/env` → Status do ambiente (Redis, qBit, Jackett)
- `GET /api/indexers` → Lista indexadores disponíveis
- `GET /api/test` → Testa conexão com Jackett
- `GET /api/metrics` → Métricas de performance por indexador
- `DELETE /api/metrics/:indexer` → Limpa métricas de um indexer
- `GET /api/debrid/test/:provider` → Testa credenciais Debrid
- `POST /api/config` → Salva configuração validada e retorna `cfg_...`

Quando `ACCESS_TOKEN` está definido, rotas administrativas exigem `X-Access-Token` ou token válido na configuração.

### Internos

- `GET /:config/debrid-add/:provider/:hash` → Adiciona torrent ao Debrid
- `GET /:config/qbit/:jobToken` → Stream via qBittorrent
- `GET /qbit/stream/:jobToken` → Stream direto (sem config)

---

## 📊 Métricas e Monitoramento

### Logs

```bash
# Logs em tempo real
docker logs -f prowjack-pro

# Buscar erros
docker logs prowjack-pro 2>&1 | grep ERROR
```

### Métricas por Indexador

Acesse `http://localhost:7014/api/metrics` para ver:
- Número de chamadas
- Tempo médio de resposta
- Taxa de sucesso
- Total de resultados

### Redis

```bash
# Conectar ao Redis
redis-cli -h localhost -p 6379

# Ver chaves de cache
KEYS search:*
KEYS rl:*
KEYS qbitjob:*

# Limpar cache
FLUSHDB
```

---

## 🐛 Troubleshooting

### Problema: Nenhum resultado aparece

**Solução:**
1. Verifique se o Jackett/Prowlarr está acessível
2. Teste a API: `http://localhost:7014/api/test`
3. Verifique os logs: `docker logs prowjack-pro`
4. Confirme que os indexadores estão configurados

### Problema: Debrid não funciona

**Solução:**
1. Teste as credenciais: `http://localhost:7014/api/debrid/test/realdebrid?key=SUA_KEY`
2. Verifique se o modo está correto (realdebrid/torbox/dual)
3. Confirme que o StremThru está configurado (opcional mas recomendado)

### Problema: qBittorrent não inicia stream

**Solução:**
1. Use VPS/Docker ou outra instância auto-hospedada; qBittorrent HTTP não funciona corretamente em Vercel/serverless
2. Verifique se o qBittorrent está acessível a partir do servidor do ProwJack
3. Confirme `QBIT_URL`, `QBIT_USER` e `QBIT_PASS` no `.env`
4. Verifique se `QBIT_SAVE_DIR` existe e tem permissões
5. Aumente `QBIT_BUFFER_TIMEOUT` se a conexão for lenta

### Problema: Catálogo RSS vazio no Vercel

**Causa:** o catálogo depende de um poller em processo persistente. Em Vercel/serverless, `setInterval` e processos longos não são confiáveis.

**Solução:**
1. Rode o ProwJack em VPS/Docker para que o poller RSS permaneça ativo
2. Ou crie um worker/cron externo que execute o polling e alimente as chaves `rss:*` e `rss:catalog:*` no Redis
3. Mantenha Redis persistente configurado; ele é necessário, mas não substitui o processo que popula o catálogo

### Problema: Rate limit atingido

**Solução:**
1. Aguarde o tempo indicado no header `Retry-After`
2. Reduza o número de indexadores simultâneos
3. Aumente o cache TTL no Redis
4. Use menos buscas em paralelo

---

## 🔐 Segurança

### Boas Práticas

1. **Nunca commite o arquivo `.env`** com credenciais reais
2. **Use HTTPS** em produção (reverse proxy com Nginx/Caddy)
3. **Configure ALLOWED_ORIGINS** para restringir CORS
4. **Mantenha o Redis protegido** (não exponha a porta 6379)
5. **Use senhas fortes** para qBittorrent e Debrid
6. **Atualize regularmente** as dependências: `npm audit fix`

### Proteções Implementadas

- ✅ Rate limiting (100 req/min por IP)
- ✅ CORS configurável
- ✅ Path traversal protection
- ✅ ReDoS prevention (timeout em regex)
- ✅ Input validation (tamanho, tipo, formato)
- ✅ Buffer overflow protection
- ✅ Sanitização de logs (sem exposição de credenciais)

---

## 🚀 Performance

### Otimizações

- **Cache em 2 camadas**: Redis (persistente) + Memória (fallback)
- **Busca paralela**: Todos os indexadores consultados simultaneamente
- **Background polling**: Buscas lentas continuam após resposta rápida
- **Deduplicação eficiente**: Hash + título normalizado
- **Batch check**: Verifica cache de múltiplos hashes em uma chamada
- **Limpeza automática**: Memória limpa a cada 60s, qBit a cada 24h

### Benchmarks

| Operação | Tempo Médio |
|----------|-------------|
| Busca rápida (cache hit) | 50-200ms |
| Busca completa (10 indexers) | 2-8s |
| Batch check (100 hashes) | 1-3s |
| Stream qBit (buffer 2%) | 5-15s |
| On-demand Debrid | 10-30s |

---

## 🤝 Contribuindo

Contribuições são bem-vindas! Por favor:

1. Fork o projeto
2. Crie uma branch para sua feature (`git checkout -b feature/MinhaFeature`)
3. Commit suas mudanças (`git commit -m 'Adiciona MinhaFeature'`)
4. Push para a branch (`git push origin feature/MinhaFeature`)
5. Abra um Pull Request

### Diretrizes

- Mantenha o código limpo e documentado
- Adicione testes para novas funcionalidades
- Siga o estilo de código existente
- Atualize o README se necessário

---

## 📝 Changelog

### v3.12.0 (2026-05-01)
- ✨ **Configuração segura**: URLs de instalação novas usam `cfg_...` salvo no backend; chaves Debrid/qBit deixam de ir diretamente na URL
- 🔒 **Validação server-side**: `/api/config` sanitiza campos, limita números, valida serviços Debrid/StremThru e aceita apenas opções conhecidas
- 🔒 **Rotas administrativas protegidas**: indexers, métricas, teste Debrid e teste Jackett exigem token quando `ACCESS_TOKEN` está ativo
- ✨ **StremThru integrado ao ProwJack**: mantém URL própria do addon, gera upstream sem qBit, consulta o proxy com timeout maior e retorna streams Debrid ordenados
- ✨ **qBittorrent HTTP opcional**: UI separa qBit de P2P nativo e deixa claro que qBit só funciona via `.env` em auto-hospedagem
- ✨ **P2P nativo**: magnets/infoHash ficam ativos quando não há Debrid; Debrid/StremThru usam P2P como entrada de conversão
- 🐛 **Real-Debrid**: cache check ficou read-only e não usa `addMagnet`; torrents existentes passam por `selectFiles` antes de unrestrict
- 🐛 **Catálogo RSS**: catálogo retornado é filtrado pelos indexers da configuração atual, evitando dados de indexers anteriores
- 🧹 **Formatação**: removida a tag visual `P2P` dos streams para evitar confusão quando Debrid/StremThru está ativo

### v3.11.0 (2026-04-24)
- ✨ **Catálogo RSS**: Polling automático de indexers privados do Prowlarr com catálogo de lançamentos no Stremio
- ✨ **Cache de .torrent**: Buffers cacheados no Redis (TTL 7 dias) para evitar re-downloads
- ✨ **Token de acesso**: Proteção opcional contra uso não autorizado do addon
- 🚀 **Fast-path RSS**: Streams de itens do catálogo buscam diretamente no cache Redis
- 🐛 **Bugfix**: Compatibilidade com Stremio Web/Android para catálogo de séries

### v3.10.1 (2024-04-15)
- 🔒 **Segurança**: CORS configurável, rate limiting, validação de entrada
- 🐛 **Bugfix**: Path traversal, ReDoS, buffer overflow, memory leak
- ✨ **Feature**: Limpeza automática de memória, logging seguro
- 📚 **Docs**: README completo, .env.example, .gitignore

### v3.10.0
- ✨ Suporte a qBittorrent para torrents privados
- ✨ Modo dual Debrid (RD + TB simultâneo)
- ✨ Cache via StremThru, Zilean, Bitmagnet
- 🚀 Batch check otimizado (5x mais rápido)
- 🎯 Deduplicação inteligente por provedor

### v3.0.0
- 🎉 Lançamento inicial
- ✨ Integração Jackett/Prowlarr
- ✨ Suporte Real-Debrid e TorBox
- ✨ Priorização PT-BR
- ✨ Cache Redis

---

## 📄 Licença

Este projeto é distribuído sob a licença MIT. Veja o arquivo `LICENSE` para mais detalhes.

---

## 🙏 Créditos

- **Stremio**: Plataforma de streaming
- **Jackett/Prowlarr**: Agregadores de indexadores
- **Real-Debrid/TorBox**: Serviços de debrid
- **qBittorrent**: Cliente torrent
- **Comunidade**: Todos os contribuidores e usuários

---

## 📞 Suporte

- **Issues**: [GitHub Issues](https://github.com/seu-usuario/prowjack-pro/issues)
- **Discussões**: [GitHub Discussions](https://github.com/seu-usuario/prowjack-pro/discussions)
- **Discord**: [Link do servidor](https://discord.gg/seu-servidor)

---

**Desenvolvido com ❤️ para a comunidade Stremio**
