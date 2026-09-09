# mcp-chat-bridge_Natakorn

ให้ AI แชต (เช่น ChatGPT Chat / Custom GPT Actions) เข้าถึง **MCP server แบบ stdio บนเครื่องคุณ** ผ่านอินเทอร์เน็ตชั่วคราว — ใช้กับ MCP server ตัวไหนก็ได้ (filesystem, git, sqlite, …) และ reuse ได้ทุกโปรเจคโดยแก้แค่ config

Let chat AIs (ChatGPT Chat / Custom GPT Actions) reach **local stdio MCP servers** through a temporary internet URL. Works with any stdio MCP server; configure per project with one `.env`.

[English](#english) · [ไทย](#ไทย)

---

## English

### Two modes

```
Mode A (default): Streamable HTTP gateway          Mode B: REST + OpenAPI bridge
ChatGPT Connectors / any MCP HTTP client           Custom GPT Actions (OpenAPI)
        │ HTTPS                                             │ HTTPS
        ▼                                                   ▼
Cloudflare quick tunnel (new URL each start)       Cloudflare tunnel or LAN only
        ▼                                                   ▼
supergateway localhost:8791  (stdio → Streamable HTTP)  node src/server.mjs localhost:8792
        ▼                                                   ▼
any MCP stdio server (default: @modelcontextprotocol/server-filesystem)
```

| | Mode A — gateway (`scripts/start.sh`) | Mode B — REST bridge (`src/server.mjs`) |
|---|---|---|
| Client | ChatGPT Chat connectors, MCP Inspector, Claude | Custom GPT Actions (OpenAPI) |
| Protocol | MCP Streamable HTTP | REST `POST /call/<tool>` + `/openapi.json` |
| Auth | URL secrecy only (tunnel) | Bearer token (`BRIDGE_TOKEN`, mandatory) |
| Use when | you want the native connector flow | you need schema-validated Actions |

### Setup

```bash
npm i -g cloudflared   # or install cloudflared any way you like
cp .env.example .env   # set ROOTS, MCP_COMMAND, BRIDGE_TOKEN

# Mode A
bash scripts/start.sh   # prints https://xxxx.trycloudflare.com/mcp — paste into ChatGPT
bash scripts/stop.sh    # ALWAYS stop when done: the tunnel has no auth

# Mode B
BRIDGE_TOKEN=$(openssl rand -hex 32) node src/server.mjs
# then expose :8792 via your own tunnel and import /openapi.json into GPT Actions
```

### Configure which server to expose

`MCP_COMMAND` is any stdio MCP server launcher; `ROOTS` (or extra args) are appended:

```env
MCP_COMMAND=npx -y @modelcontextprotocol/server-filesystem
ROOTS=F:/MyWork/project-a C:/Users/me/docs

# another example: expose a git MCP server instead
# MCP_COMMAND=npx -y @modelcontextprotocol/server-git
```

### Security (read this!)

- The quick tunnel URL is the **only** protection in Mode A — anyone with the URL can
  read/write the allowed directories. **Run `stop.sh` when done.**
- Never add sensitive folders to `ROOTS`.
- Mode B requires `BRIDGE_TOKEN` (refuses to start without one) and binds to 127.0.0.1.
- URLs die permanently when the tunnel stops; each restart gives a new URL.

### What chat AIs can / cannot do via filesystem MCP

| Can | Cannot |
|---|---|
| read / write / edit / delete files within `ROOTS` | run commands, build, test |
| search file contents, list directories | git commit / push |
| move / copy files | browse the internet, call other APIs |

---

## ไทย

### โหมดมี 2 แบบ

- **โหมด A — gateway** (`bash scripts/start.sh`): เปิด MCP stdio เป็น Streamable HTTP
  ผ่าน supergateway + Cloudflare quick tunnel แล้วเอา URL `/mcp` ไปวางใน
  ChatGPT → Settings → Connectors ใช้โหมด Chat ปกติ ไม่กินโควตา Codex/Work
- **โหมด B — REST bridge** (`node src/server.mjs`): แปลง MCP stdio เป็น REST + OpenAPI
  สำหรับ Custom GPT Actions ต้องตั้ง `BRIDGE_TOKEN` (ไม่ตั้งจะไม่ยอมรัน)

### ตั้งค่า

```bash
cp .env.example .env    # แก้ ROOTS = โฟลเดอร์ที่อนุญาต, MCP_COMMAND = MCP server ที่จะเปิด
bash scripts/start.sh   # ได้ URL ใหม่ทุกครั้ง → เอาไปแก้ Server URL ใน ChatGPT
bash scripts/stop.sh    # ปิดทุกครั้งที่เลิกใช้!
```

### ความปลอดภัย (อ่าน!)

- tunnel โหมด A **ไม่มีรหัส** — ใครรู้ URL ก็อ่าน/เขียนไฟล์ใน ROOTS ได้ → เลิกใช้แล้วปิดทุกครั้ง
- อย่าเพิ่มโฟลเดอร์สำคัญลง ROOTS
- โหมด B bind 127.0.0.1 และบังคับ Bearer token
- ปิด/restart tunnel แล้ว URL เก่าตายทันที

### เคล็ดลับใช้งานในแชต

เริ่มคำสั่งด้วย "ใช้เครื่องมือ list_allowed_directories เพื่อดูพาธที่อนุญาต แล้วทำงานภายในพาธเหล่านั้น"
เพื่อกัน model มั่ว path — แล้วค่อยสั่งอ่าน/สรุป/ค้นหา/แก้ไข/สร้างไฟล์ตามต้องการ

### ไฟล์ใน repo

- `scripts/start.sh` / `scripts/stop.sh` — เริ่ม/ปิดระบบ (โหมด A)
- `src/server.mjs` — REST+OpenAPI bridge (โหมด B)
- `.env.example` — ค่าตั้งทั้งหมด
