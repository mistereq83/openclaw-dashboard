# OpenClaw Admin Dashboard

Panel administracyjny dla systemu OpenClaw multi-agent. Pokazuje statystyki, historię rozmów i pozwala porównywać aktywność agentów.

## Szybki start

```bash
# Zainstaluj zależności
npm install

# Skopiuj i skonfiguruj env
cp .env.example .env
# Edytuj .env — ustaw ścieżki i token

# Uruchom
npm start
# lub w trybie dev (auto-restart):
npm run dev
```

Dashboard będzie dostępny pod `http://localhost:3333/?token=TWOJ_TOKEN`

## Konfiguracja (.env)

| Zmienna | Opis | Domyślna |
|---------|------|----------|
| `PORT` | Port serwera | `3333` |
| `DASHBOARD_TOKEN` | Token autoryzacji (query param lub header) | — |
| `AGENTS_DIR` | Ścieżka do katalogów roboczych agentów | `/home/openclaw/agents` |
| `OPENCLAW_STATE_DIR` | Ścieżka do stanów sesji JSONL | `/home/openclaw/.openclaw/agents` |
| `AGENT_NAMES` | Lista ID agentów (oddzielone przecinkami) | — |

## API Endpoints

```
GET /api/agents                          — lista agentów + basic stats
GET /api/agents/:name                    — szczegółowe statystyki agenta
GET /api/agents/:name/sessions           — lista sesji agenta
GET /api/agents/:name/sessions/:id       — treść sesji (wiadomości)
GET /api/agents/:name/search?q=...       — szukaj w sesjach agenta
GET /api/stats/overview                  — zagregowane statystyki wszystkich agentów
GET /api/stats/export?agent=...&from=...&to=... — eksport CSV
```

Każdy endpoint wymaga `?token=...` lub nagłówka `X-Dashboard-Token`.

## Deployment (PM2)

```bash
npm install -g pm2
pm2 start ecosystem.config.js
pm2 save
pm2 startup
```

## Deployment (Docker / Coolify)

```bash
docker build -t openclaw-dashboard .
docker run -d -p 3333:3333 \
  -e DASHBOARD_TOKEN=tajny-token \
  -e OPENCLAW_STATE_DIR=/data/.openclaw/agents \
  -v /home/openclaw/.openclaw:/data/.openclaw:ro \
  openclaw-dashboard
```

## Dane testowe

```bash
npm run generate-test-data
# Tworzy katalog test-data/ z przykładowymi sesjami JSONL
```

## Stack

- **Backend:** Node.js + Express
- **Frontend:** Vanilla JS + Chart.js
- **Auth:** Token w query param / header
- **Baza danych:** brak — pliki JSONL czytane na żywo
