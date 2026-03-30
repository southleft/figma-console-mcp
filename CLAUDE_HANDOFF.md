# Figma Desktop Bridge Handoff (for Claude)

## Muc tieu dang lam
- Tinh chinh UI plugin `Figma Desktop Bridge` theo Figma design.
- Them luong account/token trong plugin (`Add Account`, `Setting`, `New Account`).
- Tranh tinh trang plugin tu "revert" ve UI compact cu.

## Repo va branch
- Repo: `/Users/Sang/Claude Code/figma/figma-console-mcp`
- Branch: `codex/bridge-ui-context-copy-link`

## File source chinh da sua
- `/Users/Sang/Claude Code/figma/figma-console-mcp/figma-desktop-bridge/ui.html`
- `/Users/Sang/Claude Code/figma/figma-console-mcp/figma-desktop-bridge/ui-full.html`
- `/Users/Sang/Claude Code/figma/figma-console-mcp/figma-desktop-bridge/code.js`
- `/Users/Sang/Claude Code/figma/figma-console-mcp/src/local.ts`
- `/Users/Sang/Claude Code/figma/figma-console-mcp/src/core/websocket-server.ts`

## Runtime plugin path can dung (dev-isolated)
- Manifest de import trong Figma:
  - `/Users/Sang/.figma-console-mcp-dev/plugin/manifest.json`
- Runtime files:
  - `/Users/Sang/.figma-console-mcp-dev/plugin/ui.html`
  - `/Users/Sang/.figma-console-mcp-dev/plugin/ui-full.html`
  - `/Users/Sang/.figma-console-mcp-dev/plugin/code.js`

## Nguyen nhan "UI cu bi quay lai"
- Plugin UI bi reset do nhieu process `figma-console-mcp` cung chay tren may:
  - process `npx figma-console-mcp@latest` (cu) va process local repo (moi).
- UI trong plugin scan port range `9223-9232`, nen co the ket noi nham server cu (thuong 9224).
- Khi ket noi nham, state/UI compact cu xuat hien.

## Fix da lam de chan reset
1. **Khoa port scan trong UI ve 1 cong duy nhat 9223**
   - Da sua trong:
     - `figma-desktop-bridge/ui.html`
     - `figma-desktop-bridge/ui-full.html`
   - Hien tai:
     - `WS_PORT_RANGE_START = 9223`
     - `WS_PORT_RANGE_END = 9223`

2. **Tach stable plugin dir rieng cho ban dev**
   - Da them env override trong `src/local.ts`:
     - `FIGMA_CONSOLE_STABLE_PLUGIN_DIR`
   - Muc dich: tranh va cham voi path mac dinh bi process khac ghi de.

3. **Build lai local server**
   - Da chay: `npm run build:local`

## Cac thay doi logic UI account da co
- New Account screen:
  - `Add Account` da doi sang optimistic UX:
    - add xong thi back ve `Setting` ngay (khong cho save xong moi back).
    - save storage chay ngầm (`catch` bo qua) de tranh cam giac "nut khong an".
- Main empty state:
  - Hien form `Email` + `Personal access tokens` + `Add Account`.
- Fallback ten account:
  - Co token/profile nhung chua resolve email thi hien `Unknown account`.

## Shared account store (server-side)
- File:
  - `/Users/Sang/.figma-console-mcp/accounts.json`
- Luu y:
  - Neu account khong sync duoc, check file nay co account hay van rong.

## Cach chay dung de test
1. Start local server tu repo nay, voi path plugin dev rieng:

```bash
cd "/Users/Sang/Claude Code/figma/figma-console-mcp"
FIGMA_CONSOLE_STABLE_PLUGIN_DIR="/Users/Sang/.figma-console-mcp-dev/plugin" node dist/local.js
```

2. Trong Figma Desktop:
- Remove development plugin cu.
- Import lai manifest:
  - `/Users/Sang/.figma-console-mcp-dev/plugin/manifest.json`
- Reload plugin roi mo lai `Figma Desktop Bridge`.

## Kiem tra nhanh sau khi mo plugin
- UI phai co cac text moi:
  - `Copy Link`
  - `Email`
  - `Personal access tokens`
  - `Current account`
  - `New Account`
- Khong con UI compact chi co:
  - `MCP ready`
  - `Cloud Mode`

## Lenh debug huu ich
### Xem process dang chay
```bash
ps -ef | rg 'figma-console-mcp|dist/local.js' | rg -v rg
```

### Xem port dang nghe
```bash
lsof -nP -iTCP -sTCP:LISTEN | rg '9223|9224|9225|9226|9227'
```

### Xac minh runtime plugin dang dung UI moi
```bash
rg -n "main-account-email|Personal access tokens|Current account|New Account|Copy Link" \
  "/Users/Sang/.figma-console-mcp-dev/plugin/ui.html"
```

## Viec con lai cho Claude tiep tuc
1. Xac nhan user dang import dung manifest dev-isolated (khong phai path cu).
2. Neu van thay UI cu:
   - Kiem tra process nao dang chiem 9223/9224.
   - Dam bao chi 1 server target duoc plugin ket noi.
3. Retest flow:
   - `Setting -> New Account -> Add Account -> quay ve Setting`.
4. Retest write action (ve hinh tron do) sau khi transport local on dinh.

