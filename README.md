# QuData Miner Bot 🖥️⛏️

Auto-rent GPU dari QuData.ai → attach SSH key → deploy miner → jalan sendiri.

## Install di VPS

```bash
# Clone repo
git clone https://github.com/Arybil/qudata-miner.git
cd qudata-miner

# Install dependencies
npm install
```

## Setup

### 1. Edit `config.json`

```json
{
  "wallet": "wallet-address-lo",
  "pool": "stratum+tcp://pool:port",
  "sshKeyName": "mining-rig",
  "sshPublicKey": "ssh-ed25519 AAAA... key-lo",
  "priceMin": 0.30,
  "priceMax": 2.50,
  "balanceMin": 0.10,
  "pendingTimeout": 90,
  "sshTimeout": 45,
  "instanceDelay": 5,
  "activeLog": "./active-instances.txt",
  "accountsFile": "./accounts.txt"
}
```

**Penjelasan:**
- `wallet` — Address wallet buat mining
- `pool` — Pool mining (format: `stratum+tcp://host:port`)
- `sshPublicKey` — SSH public key lo (bikin kalau belum: `ssh-keygen -t ed25519`)
- `priceMin` / `priceMax` — Range harga GPU per jam ($0.30 - $2.50)
- `balanceMin` — Minimum balance buat coba rent
- `pendingTimeout` — Detik tunggu instance jadi "running" (default 90s)
- `sshTimeout` — Detik tunggu SSH siap setelah running (default 45s)
- `instanceDelay` — Detik jeda antar percobaan rent (default 5s)

### 2. Tambah akun di `accounts.txt`

Format:
```
=== [tanggal] ===
Username: nama_user
Email: email@domain.com
Password: password

=== [tanggal] ===
Username: user2
Email: email2@domain.com
Password: password2
```

Bisa banyak akun, pisahkan dengan blank line.

### 3. Generate SSH Key (kalau belum punya)

```bash
ssh-keygen -t ed25519 -N "" -f ~/.ssh/id_ed25519
cat ~/.ssh/id_ed25519.pub
```

Copy output-nya, paste ke `config.json` → `sshPublicKey`

## Cara Pakai

### Mode 1: Single Akun (1 akun aja)

```bash
# Rent + mine
node src/index.js --email user@wshu.net --password pw123

# Cek balance aja
node src/index.js --check --email user@wshu.net --password pw123
```

### Mode 2: Bulk (banyak akun dari file)

```bash
# Rent + mine semua akun di accounts.txt
npm start
# atau
node src/index.js

# Pakai file custom
node src/index.js /path/to/other-accounts.txt

# Cek balance semua akun
npm run check
# atau
node src/index.js --check
```

## Cara Kerja

```
1. Login ke akun QuData
2. Cek balance (USDT)
3. Fetch GPU offers ($0.30-$2.50/hr)
4. Buat instance (jupyter, billing per jam)
5. Tunggu status "running" (max 90 detik)
6. Tunggu SSH ready (max 45 detik)
7. Attach SSH key
8. Deploy miner via tmux
9. Log ke active-instances.txt
10. Lanjut akun berikutnya
```

## Timer Real-Time

Setiap tahap ada timer akurat:
```
[0s]  [pending] pending
[10s] [pending] pending
[20s] [pending] Successfully loaded image
[0s]  [ssh] running ✅ Ready!
[3s]  [ssh] running ✅ Ready!
✅ SSH: root@ssh3.qudata.ai -p 12353 (25s total)
```

## File Output

### `active-instances.txt`

Format: `email|password|username|instance_id|ssh_host|ssh_port|gpu|worker|timestamp`

Contoh:
```
user@wshu.net|pw123|user|6a195...|ssh3.qudata.ai|12353|GTX 1060|rig01|2026-05-29T10:00:00
```

## Auto-Run dengan PM2 (biar jalan terus)

```bash
# Install PM2
npm install -g pm2

# Jalankan
pm2 start src/index.js --name qudata-miner

# Auto-start saat VPS reboot
pm2 save
pm2 startup

# Lihat log
pm2 logs qudata-miner

# Stop
pm2 stop qudata-miner
```

## Auto-Run dengan Crontab

```bash
# Edit crontab
crontab -e

# Tambahin (jalan setiap 30 menit)
*/30 * * * * cd /root/qudata-miner && node src/index.js >> /tmp/qudata.log 2>&1
```

## Troubleshooting

| Masalah | Solusi |
|---------|--------|
| Login failed | Cek email/password di accounts.txt |
| Balance too low | Top up USDT di QuData |
| Pending timeout | GPU provider lagi down, coba lagi nanti |
| SSH timeout | Instance provision lambat, normal |
| Miner deploy failed | Cek SSH key benar, coba manual SSH |
