# V-Westlife forum archive

Read-only panel for the vBulletin 4 database of the V-Westlife forum (backup from 2012-12-11).
Node (Express) + React (Vite), deployed on Railway with the `Dockerfile`. The UI is in Vietnamese.

## Environment variables

- `DATABASE_URL` (required): set to `${{MySQL.MYSQL_URL}}` to use Railway's private network.
- `PANEL_PASSWORD` (optional): when set, the browser asks for a password before opening the panel.

Database connection check: open `/api/health/db`.

The panel only adds its own tables (`panel_post_search`, `panel_meta`, `panel_asset`); vBulletin tables are never modified.

## Tools (run locally, PowerShell, inside `server/`)

The MySQL TCP proxy must be enabled while a tool reads or writes the database.

```powershell
npm install
$env:DATABASE_URL = "mysql://root:<password>@<host>:<port>/railway"

# Avatars, profile pictures, signature pictures, smilies (rabbit, onion, ...) and stock avatars
node tools/import-assets.js "E:\FC Westlife\4rum VW\forum\forum"

# Rescue hotlinked images (Photobucket, ...) into a local folder grouped by provider
node tools/rescue-images.js --out "E:\FC Westlife\external-images"
node tools/rescue-images.js --out "E:\FC Westlife\external-images" --wayback
```
