# V-Westlife forum archive

Read-only panel for the vBulletin 4 database of the V-Westlife forum (backup from 2012-12-11).
Node (Express) + React (Vite), deployed on Railway with the `Dockerfile`. The UI is in Vietnamese.

## Environment variables

- `DATABASE_URL` (required): set to `${{MySQL.MYSQL_URL}}` to use Railway's private network.
- `PANEL_PASSWORD` (optional): when set, the browser asks for a password before opening the panel.

Database connection check: open `/api/health/db`.

The panel only adds its own tables (`panel_post_search`, `panel_meta`, `panel_asset`, `panel_external_image`, `panel_external_blob`); vBulletin tables are never modified.

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

# Publish the rescued images; the panel then shows them instead of dead links (re-run after each rescue pass).
# B2 (same bucket as sonic-hub, folder v-west-forum/external/, served by the CDN):
$env:B2_KEY_ID = "<key id>"; $env:B2_APP_KEY = "<application key>"
node tools/publish-images.js --out "E:\FC Westlife\external-images" --target b2
# or keep the image bytes in MySQL instead:
node tools/publish-images.js --out "E:\FC Westlife\external-images" --target mysql
```

B2 defaults (override with environment variables): `B2_ENDPOINT=s3.us-east-005.backblazeb2.com`, `B2_REGION=us-east-005`,
`B2_BUCKET=sonic-hub`, `B2_PREFIX=v-west-forum`, `CDN_BASE=https://sonic-hub.b-cdn.net`.
The panel itself needs no B2 settings: it redirects to the CDN address stored with each image.
