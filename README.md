---
title: ProwJack
emoji: 🎬
colorFrom: indigo
colorTo: purple
sdk: docker
app_port: 7860
---

# 🎬 ProwJack

**ProwJack** é um addon para Stremio que integra indexadores do **Jackett** e **Prowlarr** com serviços Debrid (**Real-Debrid**, **TorBox**), **StremThru** e **qBittorrent** nativo, com cache inteligente e priorização de conteúdo PT-BR.

---

## ✨ Funcionalidades Principais

* **Busca Universal:** Integra-se com Prowlarr e Jackett para consultar múltiplos indexadores simultaneamente.
* **Múltiplos Motores de Streaming:**
  * **Debrid Nativo:** Real-Debrid e TorBox.
  * **StremThru:** proxy debrid via API StremThru.
  * **qBittorrent HTTP:** streaming nativo usando seu próprio qBittorrent (trackers privados). *Gated pela feature flag `ENABLE_QBITTORRENT`.*
  * **P2P:** magnet links diretos quando não há serviço premium ativo.
* **Identificação da fonte:** o nome do stream permanece com o addon (`ProwJack`) no topo; quando Debrid está ativo, a sigla do provedor e o emoji ⚡ (cacheado) aparecem. A fonte real do resultado (indexador) é exibida na linha ⚙️ — inclusive para streams vindos de scrapers externos configurados em `SCRAP_MANIFEST_URLS`, que seguem o indexador marcado pelo addon de origem (e, na falta de marca, exibem o nome do addon que enviou a fonte via 📡).
* **Catálogo RSS Automático:** últimos lançamentos na home do Stremio. *Gated pela feature flag `ENABLE_RSS_CATALOG`.*
* **Priorização Inteligente:** ranking priorizando dublagem (PT-BR), resolução e keywords.

---

## 🚀 Como Iniciar (Quick Start)

### 1. Requisitos
* Node.js 18+ (ou Docker).
* Uma instância do **Prowlarr** ou **Jackett** acessível via HTTP(S).
* (Opcional) Conta Debrid (TorBox, Real-Debrid) ou StremThru.

### 2. Execução local

```bash
cd prowjack
npm install
cp .env.example .env   # preencha JACKETT_URL / JACKETT_API_KEY
npm start              # http://localhost:7014/configure
```

Para desenvolvimento com reload automático: `npm run dev`.

### 3. Variáveis de ambiente

Veja [`.env.example`](.env.example) — comentado e completo.

As mais importantes:

| Variável | Obrigatória | Descrição |
|---|---|---|
| `JACKETT_URL` | Sim | URL base do Prowlarr/Jackett. Em serverless deve ser pública. |
| `JACKETT_API_KEY` | Sim | API key do Prowlarr/Jackett. |
| `ACCESS_TOKEN` | Recomendado | Protege a configuração e os endpoints de admin (SSRF). |
| `ADDON_PUBLIC_URL` | Serverless | URL pública final do addon (HF Spaces, Vercel, túnel). |
| `REDIS_URL` | Opcional | Cache distribuído. Omita + `PROJACK_REDIS_DISABLED=1` para memória pura. |
| `CONFIG_DATABASE_URL` | Serverless | Postgres para persistir `cfg_...`. Alternativas aceitas: `POSTGRES_URL`, `DATABASE_URL`. |
| `LOG_LEVEL` | `info` | `info` (básico, padrão) · `debug` (detalhado) · `warn`/`error`/`silent`. |

### 4. Feature flags

| Variável | Padrão | Efeito |
|---|---|---|
| `ENABLE_QBITTORRENT` | herdado da config | `false` = UI oculta e backend retorna 404 para qBittorrent. |
| `ENABLE_RSS_CATALOG` | herdado de `RSS_CATALOG_INDEXERS` | `false` = sem catálogo RSS, sem poller. |
| `ENABLE_PURE_P2P` | `true` | `false` = esconde stream P2P do Stremio (só debrid). |
| `P2P_MIN_SEEDERS` | `5` | seeders mínimos para stream P2P não-cacheado. |
| `RSS_CATALOG_INDEXERS` | vazio | IDs/nomes dos indexadores do catálogo RSS. |

Estas flags são aplicadas **na UI e no backend** — desabilitar não depende apenas de ocultar o botão.

---

## 🎮 Como Usar no Stremio

1. Acesse `http://IP_OU_DOMINIO:7014/configure`.
2. Selecione indexadores, idioma de preferência e configure Debrid / StremThru / qBit.
3. Clique em **Gerar URL** e **Instalar no Stremio** (ou copie o link do manifest).

---

## 🔐 Privacidade e Segurança

* Chaves de API são usadas somente no servidor (nunca enviadas ao frontend).
* `ACCESS_TOKEN` protege os endpoints de administração.
* Headers de segurança (`nosniff`, `DENY`, `no-referrer`) em todas as respostas.
* Proteções contra **Path Traversal** (files do torrent), **ReDoS** (keywords) e validação de URLs externas.
* Rate limit por IP para mitigar abuso.
* **Importante:** em instância pública, `ACCESS_TOKEN` deve estar definido — o `/api/config` permite criar configurações com URLs arbitrárias (Prowlarr próprio de cada usuário) e sem token qualquer pessoa pode persistir configs.

---

## ☁️ Hospedagem Pública

### Vercel (serverless)
* `vercel.json` já existe (rota `/(.*)` → `addon.js`).
* **Sem Redis?** Defina `PROJACK_REDIS_DISABLED=1` (cache em memória p/ processo).
* **Sem filesystem?** Use `CONFIG_DATABASE_URL` (Postgres Marketplace) ou envio do manifest com prefs codificadas.
* Sem processos em background: o catálogo RSS/poller e o enriquecimento de trackers rodam apenas em VPS/Docker (processo persistente).
* Não use `SCRAP_MANIFEST_URLS` com hosts que bloqueiam datacenters sem testes prévios.

### Hugging Face Spaces (Docker)
* O `Dockerfile` inicia o addon na porta `7860` com `CONFIG_DATA_DIR=/data`.
* Anexe um **Storage Bucket** gravável em `/data` para persistir `prowjack_configs.json`.
* O HF bloqueia saída para portas comuns (`9117`, `9696`, `6379`, `5432`): `JACKETT_URL` deve ser HTTPS pública.
* Defina `ADDON_PUBLIC_URL=https://SEU-SPACE.hf.space`.
* Plano gratuito hiberna quando ocioso.

### Diferenças dev × produção
| Recurso | Local (VPS/Docker) | Pública (Vercel/HF) |
|---|---|---|
| Redis | recomendado | `PROJACK_REDIS_DISABLED=1` ou Postgres+Redis externo |
| Config `cfg_...` | arquivo `/data` | Postgres |
| Catálogo RSS / poller | funciona | requer processo persistente |
| qBittorrent | funciona | geralmente indisponível (sem rede p/ 8080) |
| `ENABLE_QBITTORRENT` | `true` p/ testes | `false` |
| `ENABLE_RSS_CATALOG` | `true` se quiser | `false` |

---

## 🔧 Troubleshooting

**"Prowlarr não retorna resultados / indexadores falhando"**
* Confirme que `JACKETT_URL` aponta para o **IP/domínio certo** e é HTTP(S).
* Teste direto: `curl "JACKETT_URL/api/v1/search?apikey=KEY&query=test&type=search"`.
* O addon envia `query` (título) + IDs de metadado na busca estruturada. Servidores antigos que ignoram `query` vazia estão cobertos.
* Verifique se o indexador em questão existe de fato no catálogo do próprio indexador — alguns sites/catálogos podem não conter o título procurado.

**Indexador aparece com nome errado / "ProwJack"**
* O topo do nome do stream é sempre o addon (`ProwJack`) + sigla do Debrid (⚡ quando cacheado). A fonte real (indexador) fica na linha ⚙️ da descrição. Para addons de scrap configurados em `SCRAP_MANIFEST_URLS`, o indexador marcado pelo addon externo (⚙️) tem prioridade; sem marca, o nome do addon que enviou a fonte aparece via 📡.

**Logs silenciosos demais / detalhados demais**
* Ajuste `LOG_LEVEL`: `info` (padrão) mostra buscas, resultados e erros; `debug` adiciona detalhes de cache, perf e indexadores.

**Configs não persistem no Vercel**
* Configure `CONFIG_DATABASE_URL`/`POSTGRES_URL` ou reenvie a config.

---

## 🧪 Desenvolvimento

```bash
npm run lint   # eslint (flat config)
npm test       # node:test (parser Torznab/Prowlarr, BUG 1, BUG 2, feature flags, falha parcial)
npm run build  # checagem de sintaxe de todos os módulos
```

*Developed pela comunidade, para a comunidade.* 🍿