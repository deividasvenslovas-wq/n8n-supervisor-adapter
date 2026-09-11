# n8n Supervisor MCP Adapter — diegimo instrukcija

Šis serveris yra tiltas tarp Claude ir jūsų n8n Supervisor. Jis turi vieną
įrankį `send_supervisor_command`, kuris komandą nusiunčia į jūsų Supervisor
webhook'ą ir grąžina atsakymą.

## 1 žingsnis — Hostinimas

Reikia bet kurios vietos, kur galima paleisti Node.js serverį su viešu HTTPS
adresu. Paprasčiausi variantai:

- **Railway** (railway.app) — sukurkite naują projektą, įkelkite šį aplanką
  (arba susiekite su Git repo), Railway automatiškai paleis `npm install &&
  npm start`.
- **Render** (render.com) — "New Web Service", įkelkite šį kodą, build
  command `npm install`, start command `npm start`.
- Arba bet kuris jūsų pačių VPS su Node.js 18+.

## 2 žingsnis — Aplinkos kintamieji

Hostinimo platformoje (NE kode, NE chat'e) nustatykite:

| Kintamasis | Reikšmė |
|---|---|
| `SUPERVISOR_WEBHOOK_URL` | jūsų n8n Supervisor webhook pilnas URL (pvz. `https://jusu-n8n.app/webhook/openai-supervisor-loop`) |
| `SUPERVISOR_AUTH_HEADER_NAME` | header'io pavadinimas, kurį naudoja „ChatGPT Bridge Auth" (dažniausiai `Authorization` arba custom, pvz. `X-Bridge-Auth`) |
| `SUPERVISOR_AUTH_HEADER_VALUE` | pats slaptas raktas (tik čia, niekur kitur) |

## 3 žingsnis — Paleidimas

```bash
npm install
npm start
```

Serveris klausysis `PORT` (numatyta 3000), MCP endpoint'as bus:
`https://jusu-adapteris.host/mcp`

Patikrinkite, ar veikia: `GET https://jusu-adapteris.host/health` turi
grąžinti `ok`.

## 4 žingsnis — Prijungimas prie Claude

1. Eikite į Claude nustatymus → **Connectors** (arba Settings → Connectors).
2. Pasirinkite „Add custom connector" (arba lygiavertę parinktį).
3. Įveskite MCP serverio URL: `https://jusu-adapteris.host/mcp`
4. Išsaugokite ir įjunkite connector'į šiam pokalbiui / paskyrai.

## 5 žingsnis — STATUS testas

Naujame pokalbyje su įjungtu connector'iu parašykite:

> Panaudok send_supervisor_command su command="STATUS"

Jei viskas sukonfigūruota teisingai, Claude turėtų grąžinti Supervisor
atsakymą (tą patį, kokį jau matėte per HTTP Request testą).

## Saugumo priminimas

- `SUPERVISOR_AUTH_HEADER_VALUE` niekada nerašomas kode, README, chat'e ar
  bet kuriame viešame dokumente — tik hostinimo platformos aplinkos
  kintamuosiuose.
- Serveris veikia stateless režimu (be sesijų) — kiekvienas MCP kvietimas
  sukuria naują serverio instanciją, tinka nedideliam naudojimui.
