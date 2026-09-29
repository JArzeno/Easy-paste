# Easy Paste

Share text or a file with a link. Paste it, get a link, send it to anyone (or to yourself). Everything is deleted after 24 hours.

No database and no dependencies. It is a single Node.js server that stores items on disk.

## Run locally

Requires Node 18 or newer.

```
npm start
```

Open http://localhost:3000. Run the tests with `npm test`.

## Settings

All optional, set as environment variables.

| Variable | Default | What it does |
| --- | --- | --- |
| `PORT` | `3000` | Port to listen on |
| `DATA_DIR` | `./data` | Where shared items are stored |
| `EXPIRE_HOURS` | `24` | How long a link works |
| `MAX_FILE_MB` | `25` | Largest file allowed |
| `MAX_TEXT_KB` | `1024` | Largest text allowed |
| `RATE_LIMIT_PER_HOUR` | `60` | Uploads allowed per IP per hour (`0` turns it off) |
| `TRUST_PROXY` | off | Set to `1` when running behind a proxy or a host like Railway, so the rate limit uses the real visitor IP |

## Deploy (Railway or any Node host)

1. Create a service from this repo. The start command is `npm start`.
2. Add a volume mounted at `/data` and set `DATA_DIR=/data`, so shared items survive restarts and deploys.
3. Set `TRUST_PROXY=1`.

Health check path: `/healthz`.

## How it works

- Each item gets a random 10 character link, like `/n7g2uPsEfX`.
- Expired items are removed when someone opens them, and by a cleanup that runs every 10 minutes.
- Uploaded files are always downloaded, never run as a page on the site. Only common image types (PNG, JPEG, GIF, WebP, AVIF) show a preview.
- Shared pages are marked `noindex` so search engines do not list them.

## API

```
# Share text
curl --data-binary @notes.txt -H "Content-Type: text/plain" https://your-host/api/text

# Share a file
curl --data-binary @photo.jpg -H "Content-Type: image/jpeg" -H "X-File-Name: photo.jpg" https://your-host/api/file
```

Both return JSON with `id`, `path`, `size` and `expiresAt`. Add `/raw` or `/download` to a link to get the content directly.
