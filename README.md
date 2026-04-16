# 🎬 ProwJack PRO

**Addon Stremio otimizado para Jackett/Prowlarr com suporte a Debrid e qBittorrent**

ProwJack PRO é um addon avançado para Stremio que integra indexadores Jackett/Prowlarr com serviços Debrid (Real-Debrid, TorBox) e qBittorrent, oferecendo streaming de alta qualidade com priorização inteligente de idioma PT-BR.

---

## ✨ Funcionalidades

### 🎯 Core
- **Integração Jackett/Prowlarr**: Busca em múltiplos indexadores públicos e privados
- **Suporte Debrid**: Real-Debrid e TorBox com cache automático
- **qBittorrent**: Streaming direto de torrents privados via HTTP
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

---

## 📦 Instalação

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
# Jackett/Prowlarr (OBRIGATÓRIO)
JACKETT_URL=http://localhost:9696
JACKETT_API_KEY=sua_api_key_aqui

# Redis (Recomendado)
REDIS_URL=redis://localhost:6379

# Real-Debrid / TorBox (Opcional - configurado via interface)
STREMTHRU_URL=https://st.omcx.ddns.net/v0/torznab/api
STREMTHRU_API_KEY=sua_key_aqui

# qBittorrent (Opcional - para torrents privados)
QBIT_URL=http://localhost:8080
QBIT_USER=admin
QBIT_PASS=sua_senha_aqui
QBIT_SAVE_DIR=/data/prowjack
QBIT_MIN_PROGRESS=0.01
QBIT_BUFFER_TIMEOUT=180

# Segurança (Opcional)
ALLOWED_ORIGINS=https://app.strem.io,https://web.stremio.com

# Porta do servidor
PORT=7014
```

### Configuração via Interface Web

1. Acesse `http://localhost:7014/configure`
2. Configure:
   - **Indexadores**: Selecione os indexadores desejados
   - **Categorias**: Filmes, Séries, Anime
   - **Idioma**: Prioridade PT-BR, Dublado, Multi-Audio
   - **Debrid**: Real-Debrid e/ou TorBox (modo dual suportado)
   - **qBittorrent**: URL, usuário e senha
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
- **Cache Instantâneo**: Streams prontos para reprodução
- **On-Demand**: Adiciona torrents automaticamente ao clicar
- **Dual Mode**: Usa RD + TB simultaneamente para máxima disponibilidade

#### ⚡ Modo qBittorrent
- **Torrents Privados**: Suporte completo via upload de .torrent
- **Streaming HTTP**: Reproduz enquanto baixa (buffer mínimo 1-2%)
- **Priorização**: Foca no arquivo do episódio específico

#### 🧲 Modo P2P (Fallback)
- **Magnet Links**: Envia magnets diretamente ao Stremio
- **Sem Debrid**: Funciona sem serviços externos

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
5. Cache Check (se Debrid ativo):
   ├─ Batch check nativo (RD/TB API)
   ├─ StremThru (cache externo)
   └─ Torznab sources (Zilean, Bitmagnet)
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
1. Verifique se o qBittorrent está acessível
2. Confirme que `QBIT_SAVE_DIR` existe e tem permissões
3. Aumente `QBIT_BUFFER_TIMEOUT` se a conexão for lenta
4. Verifique se o arquivo .torrent foi baixado corretamente

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
