# Task sheet — Install, run and update DIVE Turbinen (WSL / Ubuntu, root user)

> Copy the commands **line by line** into your WSL or Ubuntu terminal, in order.
> This sheet assumes you are logged in as **root** (so no `sudo` is needed).
> Lines starting with `#` are comments: you don't need to copy them.

---

## 0. Where the folders live (read once)

In this sheet the application is installed in **`/root/dive-gui`** (root's home is `/root`):

```
/root/dive-gui                    ← the application folder
├── apps/api/.env                 ← THE config file (secrets, paths, admin account)
├── apps/api/dist/                ← the built API (created by `npm run build`)
├── apps/web/dist/                ← the built website (created by `npm run build`, served by nginx in prod)
└── package.json
```

Other important locations (in production):

```
/var/lib/dive/prod.db             ← the database
/var/lib/dive/storage/            ← meshes + solver results (uses a lot of disk)
/etc/systemd/system/dive-api.service   ← the "service" that starts the API on its own
/etc/nginx/sites-available/dive   ← the nginx config that serves the site
```

**Every `npm` and `git` command is run from `/root/dive-gui`.** If you open a new terminal, start with:

```bash
cd /root/dive-gui
```

---

## 1. First-time install (once)

### 1.1 Install Node.js 20 + git

```bash
apt-get update
curl -fsSL https://deb.nodesource.com/setup_20.x | bash -
apt-get install -y nodejs git
node -v
```

→ `node -v` must print `v20` or higher.

### 1.2 Get the code from GitHub

```bash
cd /root
git clone https://github.com/Bapteds/dive-gui.git
cd dive-gui
```

### 1.3 Install packages + create config + database

```bash
npm install
cp apps/api/.env.example apps/api/.env
npm run db:migrate
npm run db:seed
```

→ The yellow `warn` lines from `npm install` are normal. Only red `ERR!` lines are a real problem.

### 1.4 First run (dev mode)

```bash
npm run dev
```

→ Open **http://localhost:5173** in your browser (under WSL this works straight from Windows).
→ Default login: **admin@dive-turbinen.de** / **ChangeMe!2026**
→ Stop it: `Ctrl+C` in the terminal.

---

## 2. CFD compute tools (once, required for the calculations to work)

Without this section the interface works but every mesh/solver/export action reports "tool not found".

### 2.1 OpenFOAM v2406 (ESI edition — openfoam.**com**, not .org)

```bash
curl https://dl.openfoam.com/add-debian-repo.sh | bash
apt-get install -y openfoam2406-default
source /usr/lib/openfoam/openfoam2406/etc/bashrc
which simpleFoam checkMesh mergeMeshes mpirun
```

→ The last command must print 4 paths (one per tool).

### 2.2 Python + modules (in an isolated folder — do not install globally)

```bash
apt-get install -y python3 python3-venv python3-pip
python3 -m venv /opt/dive-venv
/opt/dive-venv/bin/pip install --upgrade pip
/opt/dive-venv/bin/pip install numpy vtk pyvista trimesh h5py
/opt/dive-venv/bin/python3 -c "import vtk, pyvista, numpy, trimesh, h5py; print('OK')"
```

→ Must print `OK`.

### 2.3 ParaView + Xvfb (for the CFD-Post export)

```bash
apt-get install -y paraview xvfb
which pvbatch
```

### 2.4 Declare these tools in the config

Open the config file:

```bash
nano /root/dive-gui/apps/api/.env
```

(`nano`: arrow keys to move, **Ctrl+O** then **Enter** to save, **Ctrl+X** to quit.)

Check / add these lines:

```ini
OPENFOAM_BASHRC=/usr/lib/openfoam/openfoam2406/etc/bashrc
CGNS_PYTHON_BIN=/opt/dive-venv/bin/python3
MESH_PYTHON_BIN=/opt/dive-venv/bin/python3
```

---

## 3. Update the app from GitHub

Do this whenever a new version is published:

```bash
cd /root/dive-gui
git pull
npm install
npm run build
```

- `git pull` → downloads the latest code.
- `npm install` → updates packages if needed (fast when nothing changed).
- `npm run build` → rebuilds the app (API + website).

**Then restart:**

- In dev: `npm run dev`
- In prod (service installed, see §5): `systemctl restart dive-api`

---

## 4. Run the built version by hand (dev)

After a `npm run build`, you can run the API alone:

```bash
cd /root/dive-gui
npm start -w @dive/api
```

→ The API runs on **http://localhost:4000** (it also applies database migrations on its own).
→ ⚠️ This command serves **only the API**, not the web pages. To get the interface:
  - either `npm run dev` (runs API + site together on :5173),
  - or nginx serving `apps/web/dist` (the prod setup, §5).
→ Stop it: `Ctrl+C`.

---

## 5. Go to production (the app starts on its own, always on)

### 5.1 Prepare the data folders

```bash
mkdir -p /var/lib/dive/storage
```

### 5.2 Configure production mode

```bash
nano /root/dive-gui/apps/api/.env
```

Edit these lines (the others can stay as they are):

```ini
NODE_ENV=production

# Generate TWO different keys with:  openssl rand -base64 48   (run it twice)
JWT_ACCESS_SECRET=paste-the-first-key
JWT_REFRESH_SECRET=paste-the-second-key

DATABASE_URL=file:/var/lib/dive/prod.db
STORAGE_DIR=/var/lib/dive/storage

# The exact address typed in the browser
CORS_ORIGIN=https://dive.your-domain.de
TRUST_PROXY=1

# The first admin account (use a REAL password)
SEED_ADMIN_EMAIL=admin@your-company.de
SEED_ADMIN_PASSWORD=AReallyStrongPassword!2026
SEED_ADMIN_NAME=Administrator
```

⚠️ In production the app **refuses to start** if the secrets are short, identical, or left at their example value. This is intentional.

Then rebuild and create the database + admin:

```bash
cd /root/dive-gui
npm ci
npm run build
npm run db:migrate -w @dive/api
npm run db:seed -w @dive/api
```

### 5.3 Create the service file (automatic start)

**WSL only** — enable systemd once (not needed on a real Ubuntu server):

```bash
printf "[boot]\nsystemd=true\n" >> /etc/wsl.conf
```

then in **Windows PowerShell**: `wsl --shutdown`, and reopen the WSL terminal.

Create the file:

```bash
nano /etc/systemd/system/dive-api.service
```

Paste this as-is (running as root, working dir is `/root/dive-gui/apps/api`):

```ini
[Unit]
Description=DIVE Turbinen API
After=network.target

[Service]
Type=simple
User=root
WorkingDirectory=/root/dive-gui/apps/api
ExecStart=/bin/bash -lc 'source /usr/lib/openfoam/openfoam2406/etc/bashrc && npm start'
Restart=on-failure
Environment=NODE_ENV=production

[Install]
WantedBy=multi-user.target
```

> If you cloned somewhere other than `/root/dive-gui`, adjust the `WorkingDirectory` path (it points at the `apps/api` subfolder inside your clone).

Enable it:

```bash
systemctl daemon-reload
systemctl enable --now dive-api
systemctl status dive-api
```

→ `status` must show **active (running)**. On error, read the logs (the message says which `.env` line to fix):

```bash
journalctl -u dive-api -f
```

(`Ctrl+C` to leave the logs.)

### 5.4 Serve the site with nginx

```bash
apt-get install -y nginx
nano /etc/nginx/sites-available/dive
```

Paste this (adjust `server_name` to your domain; the two `ssl_` lines come from your certificate, e.g. certbot / Let's Encrypt):

```nginx
server {
    listen 443 ssl;
    server_name dive.your-domain.de;
    # ssl_certificate     /path/to/certificate.pem;
    # ssl_certificate_key /path/to/key.pem;

    root /root/dive-gui/apps/web/dist;
    index index.html;

    location / {
        try_files $uri $uri/ /index.html;
    }

    location /api/ {
        proxy_pass http://127.0.0.1:4000;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection "upgrade";
        proxy_set_header Host $host;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_read_timeout 3600s;
    }
}
```

> Note: nginx (as root) must be able to read `/root/dive-gui/apps/web/dist`. If you later run the site under a non-root user and hit a 403, move the clone to a shared path such as `/opt/dive` and point `root`/`WorkingDirectory` there.

Enable it:

```bash
ln -s /etc/nginx/sites-available/dive /etc/nginx/sites-enabled/
nginx -t
systemctl reload nginx
```

⚠️ The site must be served over **HTTPS**, otherwise user logins won't persist (the session cookie is rejected over plain HTTP).

### 5.5 Verify

```bash
curl -k https://dive.your-domain.de/api/v1/health
```

→ Then open the site in a browser, log in with the admin from §5.2, and run a test mesh conversion: every step should turn green. That proves OpenFOAM and Python are wired up correctly.

---

## 6. Daily cheat sheet

| I want to… | Command |
|---|---|
| Update the app | `cd /root/dive-gui && git pull && npm install && npm run build` |
| Restart the API (prod) | `systemctl restart dive-api` |
| Check the API is running | `systemctl status dive-api` |
| Watch the logs live | `journalctl -u dive-api -f` |
| Run in dev (API + site) | `cd /root/dive-gui && npm run dev` → http://localhost:5173 |
| Run the API alone (after build) | `cd /root/dive-gui && npm start -w @dive/api` → :4000 |
| Stop a manual run | `Ctrl+C` in the terminal |

## 7. Quick troubleshooting

| Problem | Fix |
|---|---|
| `node: command not found` | Redo §1.1, then close/reopen the terminal |
| App refuses to start, mentions `JWT_..._SECRET` | Generate 2 **different** keys: `openssl rand -base64 48` (§5.2) |
| Compute actions say "tool not found" | Redo the checks in §2.1–2.3 and confirm the 3 lines in §2.4 of `.env` |
| `EADDRINUSE` (port already in use) | The app is already running elsewhere: close the other terminal or `systemctl stop dive-api` |
| The service won't start | `journalctl -u dive-api -f` → the message points at the offending line |
| Login to the site "doesn't stick" | The site must be served over HTTPS (§5.4) |
| `systemctl` doesn't work under WSL | Enable systemd (§5.3, WSL case) then `wsl --shutdown` |
