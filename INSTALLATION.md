# Fiche de tâches — Installer, lancer, mettre à jour DIVE Turbinen (WSL / Ubuntu)

> Copier-coller les commandes **ligne par ligne** dans le terminal WSL ou Ubuntu, dans l'ordre.
> Les lignes qui commencent par `#` sont des commentaires : pas besoin de les copier.

---

## 0. Où se trouvent les dossiers (à lire une fois)

Dans cette fiche, l'application est installée dans le dossier **`~/dive-gui`**, c'est-à-dire :

```
/home/VOTRE_NOM/dive-gui          ← le dossier de l'application (VOTRE_NOM = votre utilisateur Linux, voir `whoami`)
├── apps/api/.env                 ← LE fichier de configuration (secrets, chemins, admin)
├── apps/api/dist/                ← l'API construite (créée par `npm run build`)
├── apps/web/dist/                ← le site web construit (créé par `npm run build`, servi par nginx en prod)
└── package.json
```

Autres emplacements importants (en prod) :

```
/var/lib/dive/prod.db             ← la base de données
/var/lib/dive/storage/            ← maillages + résultats de calcul (prend beaucoup de place)
/etc/systemd/system/dive-api.service   ← le fichier "service" qui démarre l'API tout seul
/etc/nginx/sites-available/dive   ← la config nginx qui sert le site
```

**Toutes les commandes `npm` et `git` se tapent depuis `~/dive-gui`.** Si vous rouvrez un terminal, commencez par :

```bash
cd ~/dive-gui
```

---

## 1. Installation initiale (une seule fois)

### 1.1 Installer Node.js 20 + git

```bash
sudo apt-get update
curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
sudo apt-get install -y nodejs git
node -v
```

→ `node -v` doit afficher `v20` ou plus.

### 1.2 Récupérer le code depuis GitHub

```bash
cd ~
git clone https://github.com/Bapteds/dive-gui.git
cd dive-gui
```

### 1.3 Installer les paquets + créer la config + la base de données

```bash
npm install
cp apps/api/.env.example apps/api/.env
npm run db:migrate
npm run db:seed
```

→ Les avertissements jaunes (`warn`) de `npm install` sont normaux. Seul `ERR!` en rouge est un problème.

### 1.4 Premier lancement (mode dev)

```bash
npm run dev
```

→ Ouvrir **http://localhost:5173** dans le navigateur (sous WSL ça marche directement depuis Windows).
→ Connexion par défaut : **admin@dive-turbinen.de** / **ChangeMe!2026**
→ Arrêter : `Ctrl+C` dans le terminal.

---

## 2. Outils de calcul CFD (une seule fois, obligatoire pour que les calculs marchent)

Sans cette partie, l'interface fonctionne mais toutes les actions maillage/solveur/export répondent « outil non trouvé ».

### 2.1 OpenFOAM v2406 (version ESI — openfoam.**com**, pas .org)

```bash
curl https://dl.openfoam.com/add-debian-repo.sh | sudo bash
sudo apt-get install -y openfoam2406-default
source /usr/lib/openfoam/openfoam2406/etc/bashrc
which simpleFoam checkMesh mergeMeshes mpirun
```

→ La dernière commande doit afficher 4 chemins (un par outil).

### 2.2 Python + modules (dans un dossier isolé — ne pas installer en global)

```bash
sudo apt-get install -y python3 python3-venv python3-pip
sudo python3 -m venv /opt/dive-venv
sudo /opt/dive-venv/bin/pip install --upgrade pip
sudo /opt/dive-venv/bin/pip install numpy vtk pyvista trimesh h5py
/opt/dive-venv/bin/python3 -c "import vtk, pyvista, numpy, trimesh, h5py; print('OK')"
```

→ Doit afficher `OK`.

### 2.3 ParaView + Xvfb (pour l'export CFD-Post)

```bash
sudo apt-get install -y paraview xvfb
which pvbatch
```

### 2.4 Déclarer ces outils dans la config

Ouvrir le fichier de configuration :

```bash
nano ~/dive-gui/apps/api/.env
```

(`nano` : flèches pour se déplacer, **Ctrl+O** puis **Entrée** pour enregistrer, **Ctrl+X** pour quitter.)

Vérifier / ajouter ces lignes :

```ini
OPENFOAM_BASHRC=/usr/lib/openfoam/openfoam2406/etc/bashrc
CGNS_PYTHON_BIN=/opt/dive-venv/bin/python3
MESH_PYTHON_BIN=/opt/dive-venv/bin/python3
```

---

## 3. Mettre à jour l'application depuis GitHub

À faire à chaque fois qu'une nouvelle version est publiée :

```bash
cd ~/dive-gui
git pull
npm install
npm run build
```

- `git pull` → télécharge la dernière version du code.
- `npm install` → met à jour les paquets si besoin (rapide s'il n'y a rien de nouveau).
- `npm run build` → reconstruit l'application (API + site web).

**Puis relancer :**

- En dev : `npm run dev`
- En prod (service installé, voir §5) : `sudo systemctl restart dive-api`

---

## 4. Lancer la version construite à la main (dev)

Après un `npm run build`, on peut lancer l'API seule :

```bash
cd ~/dive-gui
npm start -w @dive/api
```

→ L'API tourne sur **http://localhost:4000** (elle applique aussi les migrations de base toute seule).
→ ⚠️ Cette commande ne sert **que l'API**, pas les pages web. Pour avoir l'interface :
  - soit `npm run dev` (qui lance API + site ensemble sur :5173),
  - soit nginx qui sert `apps/web/dist` (c'est le montage prod, §5).
→ Arrêter : `Ctrl+C`.

---

## 5. Passer en production (l'application démarre toute seule, en permanence)

### 5.1 Préparer les dossiers de données

```bash
sudo mkdir -p /var/lib/dive/storage
sudo chown -R "$USER" /var/lib/dive
```

### 5.2 Configurer le mode production

```bash
nano ~/dive-gui/apps/api/.env
```

Modifier ces lignes (les autres peuvent rester telles quelles) :

```ini
NODE_ENV=production

# Générer DEUX clés différentes avec :  openssl rand -base64 48   (à lancer 2 fois)
JWT_ACCESS_SECRET=coller-la-première-clé
JWT_REFRESH_SECRET=coller-la-deuxième-clé

DATABASE_URL=file:/var/lib/dive/prod.db
STORAGE_DIR=/var/lib/dive/storage

# L'adresse exacte tapée dans le navigateur
CORS_ORIGIN=https://dive.votre-domaine.de
TRUST_PROXY=1

# Le premier compte administrateur (mettre un VRAI mot de passe)
SEED_ADMIN_EMAIL=admin@votre-entreprise.de
SEED_ADMIN_PASSWORD=UnVraiMotDePasseFort!2026
SEED_ADMIN_NAME=Administrateur
```

⚠️ En production l'application **refuse de démarrer** si les secrets sont courts, identiques, ou laissés en valeur d'exemple. C'est voulu.

Puis reconstruire et créer la base + l'admin :

```bash
cd ~/dive-gui
npm ci
npm run build
npm run db:migrate -w @dive/api
npm run db:seed -w @dive/api
```

### 5.3 Créer le fichier service (démarrage automatique)

**Cas WSL uniquement** — activer systemd une fois (inutile sur un vrai Ubuntu) :

```bash
sudo bash -c 'printf "[boot]\nsystemd=true\n" >> /etc/wsl.conf'
```

puis dans **PowerShell Windows** : `wsl --shutdown`, et rouvrir le terminal WSL.

Créer le fichier :

```bash
sudo nano /etc/systemd/system/dive-api.service
```

Coller ceci en remplaçant **VOTRE_NOM** (2 endroits) par le résultat de la commande `whoami` :

```ini
[Unit]
Description=DIVE Turbinen API
After=network.target

[Service]
Type=simple
User=VOTRE_NOM
WorkingDirectory=/home/VOTRE_NOM/dive-gui/apps/api
ExecStart=/bin/bash -lc 'source /usr/lib/openfoam/openfoam2406/etc/bashrc && npm start'
Restart=on-failure
Environment=NODE_ENV=production

[Install]
WantedBy=multi-user.target
```

> `WorkingDirectory` = le sous-dossier `apps/api` **dans le dossier où vous avez cloné le code**. Si vous avez cloné ailleurs que `~/dive-gui`, adaptez le chemin.

Activer :

```bash
sudo systemctl daemon-reload
sudo systemctl enable --now dive-api
sudo systemctl status dive-api
```

→ `status` doit afficher **active (running)**. En cas d'erreur, lire les logs (le message dit quelle ligne du `.env` corriger) :

```bash
sudo journalctl -u dive-api -f
```

(`Ctrl+C` pour quitter les logs.)

### 5.4 Servir le site avec nginx

```bash
sudo apt-get install -y nginx
sudo nano /etc/nginx/sites-available/dive
```

Coller (remplacer **VOTRE_NOM** et le domaine ; les 2 lignes `ssl_` viennent de votre certificat, ex. certbot/Let's Encrypt) :

```nginx
server {
    listen 443 ssl;
    server_name dive.votre-domaine.de;
    # ssl_certificate     /chemin/vers/certificat.pem;
    # ssl_certificate_key /chemin/vers/cle.pem;

    root /home/VOTRE_NOM/dive-gui/apps/web/dist;
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

Activer :

```bash
sudo ln -s /etc/nginx/sites-available/dive /etc/nginx/sites-enabled/
sudo nginx -t
sudo systemctl reload nginx
```

⚠️ Le site doit être en **HTTPS**, sinon la connexion des utilisateurs ne tient pas (cookie de session refusé en HTTP).

### 5.5 Vérifier

```bash
curl -k https://dive.votre-domaine.de/api/v1/health
```

→ Puis ouvrir le site dans le navigateur, se connecter avec l'admin du §5.2, et lancer une conversion de maillage test : chaque étape doit être verte.

---

## 6. Aide-mémoire quotidien

| Je veux… | Commande |
|---|---|
| Mettre à jour l'application | `cd ~/dive-gui && git pull && npm install && npm run build` |
| Redémarrer l'API (prod) | `sudo systemctl restart dive-api` |
| Voir si l'API tourne | `sudo systemctl status dive-api` |
| Lire les logs en direct | `sudo journalctl -u dive-api -f` |
| Lancer en dev (API + site) | `cd ~/dive-gui && npm run dev` → http://localhost:5173 |
| Lancer l'API seule (après build) | `cd ~/dive-gui && npm start -w @dive/api` → :4000 |
| Arrêter un lancement manuel | `Ctrl+C` dans le terminal |

## 7. Dépannage rapide

| Problème | Solution |
|---|---|
| `node : commande introuvable` | Refaire §1.1 puis fermer/rouvrir le terminal |
| L'appli refuse de démarrer, parle de `JWT_..._SECRET` | Générer 2 clés **différentes** : `openssl rand -base64 48` (§5.2) |
| Actions de calcul → « outil non trouvé » | Refaire les vérifications §2.1–2.3 et contrôler les 3 lignes du §2.4 dans `.env` |
| `EADDRINUSE` (port déjà utilisé) | L'appli tourne déjà ailleurs : fermer l'autre terminal ou `sudo systemctl stop dive-api` |
| Le service ne démarre pas | `sudo journalctl -u dive-api -f` → le message indique la ligne fautive |
| La connexion au site « ne tient pas » | Le site doit être servi en HTTPS (§5.4) |
| `systemctl` ne marche pas sous WSL | Activer systemd (§5.3, cas WSL) puis `wsl --shutdown` |
