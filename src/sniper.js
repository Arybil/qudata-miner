/**
 * QuData GPU Sniper v4 — FULL PARALLEL
 * 
 * Semua akun jalan BARENGAN — gak ada yang nunggu.
 * Auto-cleanup pending instances tiap 30 detik.
 * 
 * Usage:
 *   node src/sniper.js
 */

const fs = require('fs');
const path = require('path');
const QuDataAPI = require('./api');
const { deployMiner } = require('./miner');

// ─── CONFIG ────────────────────────────────────────────────────────
const config = JSON.parse(
  fs.readFileSync(path.join(__dirname, '..', 'config.json'), 'utf-8')
);

const {
  wallet, pool, sshKeyName, sshPublicKey,
  deploymentType, image, storageGb,
  priceMin, priceMax, activeLog, accountsFile,
} = config;

// ─── HELPERS ───────────────────────────────────────────────────────
function ts() {
  return new Date().toLocaleTimeString('en-GB', { hour12: false });
}

function log(msg) {
  console.log(`[${ts()}] ${msg}`);
}

function logTag(tag, msg) {
  console.log(`[${ts()}] [${tag}] ${msg}`);
}

function sleep(seconds) {
  return new Promise(resolve => setTimeout(resolve, seconds * 1000));
}

function logActive(email, password, instId, sshHost, sshPort, gpu, worker) {
  const dir = path.dirname(activeLog);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  const line = [
    email, password, instId,
    sshHost, sshPort, gpu, worker,
    new Date().toISOString(),
  ].join('|') + '\n';
  fs.appendFileSync(activeLog, line);
}

function parseAccounts(filePath) {
  const content = fs.readFileSync(filePath, 'utf-8');
  const accounts = [];
  for (const line of content.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#') || trimmed.startsWith('===')) continue;
    const sep = trimmed.indexOf(':');
    if (sep === -1) continue;
    const email = trimmed.substring(0, sep).trim();
    const password = trimmed.substring(sep + 1).trim();
    if (email && password && email.includes('@')) {
      accounts.push({ email, password });
    }
  }
  return accounts;
}

// ─── POLL STATUS TIAP 1 DETIK ─────────────────────────────────────
async function pollStatus(api, instanceId, conditionFn, timeoutSec, label, tag) {
  const start = Date.now();
  while ((Date.now() - start) / 1000 < timeoutSec) {
    const sec = ((Date.now() - start) / 1000).toFixed(0);
    try {
      const instances = await api.getInstances();
      const inst = instances.find(i => i.id === instanceId);

      if (!inst) {
        logTag(tag, `[${sec}s] [${label}] Instance gone!`);
        return null;
      }

      const status = inst.status || '';
      const msg = (inst.message || '').substring(0, 40);
      const ssh = inst.ssh_enabled ? 'SSH:OK' : 'SSH:-';

      if (sec % 5 === 0) { // Log tiap 5 detik biar gak spam
        logTag(tag, `[${sec}s] ${status} ${ssh} ${msg}`);
      }

      if (conditionFn(inst)) {
        logTag(tag, `[${sec}s] ✅ Ready!`);
        return inst;
      }

      if (['error', 'failed', 'cancelled'].includes(status)) {
        logTag(tag, `[${sec}s] ❌ ${status} ${msg}`);
        return null;
      }

      if (msg.includes('vast') || msg.includes('vastai')) {
        logTag(tag, `[${sec}s] ⏭️ Vast.ai detected`);
        return 'vast_detected';
      }
    } catch {}

    await sleep(1);
  }

  logTag(tag, `[${timeoutSec}s] ⏰ Timeout`);
  return null;
}

// ─── RENT + MINE SATU AKUN ────────────────────────────────────────
async function tryRentForAccount(account, offers, workerCounter) {
  const tag = account.email.substring(0, 12);
  
  logTag(tag, '─────────────────────────────────');
  logTag(tag, `👤 Starting...`);

  const api = new QuDataAPI();
  const loggedIn = await api.login(account.email, account.password);
  if (!loggedIn) { logTag(tag, '❌ Login failed'); return { success: false, workerCounter }; }

  const balance = await api.getBalance();
  logTag(tag, `💰 $${balance.toFixed(3)} USDT`);

  if (balance < 0.05) {
    const running = await api.getInstances();
    if (running.length) {
      logTag(tag, `⚠️ Balance rendah, hapus ${running.length} instance...`);
      for (const inst of running) {
        await api.deleteInstance(inst.id);
      }
      const newBal = await api.getBalance();
      logTag(tag, `💰 After cleanup: $${newBal.toFixed(3)} USDT`);
      if (newBal < 0.05) {
        logTag(tag, '⏭️ Still too low');
        return { success: false, workerCounter };
      }
    } else {
      logTag(tag, '⏭️ Balance too low');
      return { success: false, workerCounter };
    }
  }

  const keyId = await api.ensureSSHKey(sshKeyName, sshPublicKey);
  if (!keyId) { logTag(tag, '❌ SSH key failed'); return { success: false, workerCounter }; }

  // Clean existing instances
  const existing = await api.getInstances();
  if (existing.length) {
    logTag(tag, `🧹 Cleaning ${existing.length} instance(s)...`);
    for (const inst of existing) {
      await api.deleteInstance(inst.id);
    }
  }

  // Try offers
  for (const offer of offers) {
    const price = offer.prices?.[0]?.amount || 0;
    const gpu = offer.gpu_name || '?';
    const mins = price > 0 ? (balance / price * 60).toFixed(0) : '?';

    logTag(tag, `🎯 ${gpu} @ $${price}/hr (~${mins}min)`);

    const timerStart = Date.now();
    const instData = await api.createInstance(offer.id, deploymentType, storageGb, image);
    if (!instData || instData.error) {
      logTag(tag, `❌ Create failed`);
      continue;
    }

    const instId = instData.id;
    logTag(tag, `📦 ${instId.substring(0, 16)}...`);

    let isVast = false;
    const instInfo = JSON.stringify(instData).toLowerCase();
    if (instInfo.includes('vast') || instInfo.includes('vastai')) {
      isVast = true;
      logTag(tag, `⏭️ Vast.ai detected`);
    }

    await api.attachSSHKey(instId, keyId);
    logTag(tag, `🔑 SSH key attached`);

    // Monitor pending (1s interval)
    const running = await pollStatus(api, instId, i => i.status === 'running', 120, 'pending', tag);

    if (running === 'vast_detected') {
      isVast = true;
      const running2 = await pollStatus(api, instId, i => i.status === 'running', 60, 'pending', tag);
      if (!running2 || running2 === 'vast_detected') {
        logTag(tag, `⏰ Not running → delete`);
        await api.deleteInstance(instId);
        continue;
      }
    } else if (!running) {
      logTag(tag, `⏰ Timeout → delete`);
      await api.deleteInstance(instId);
      continue;
    }

    // Monitor SSH (1s interval)
    const sshReady = await pollStatus(api, instId, i => i.ssh_enabled && i.ssh_host && i.ssh_port, 30, 'ssh', tag);

    if (sshReady === 'vast_detected') {
      isVast = true;
      const sshReady2 = await pollStatus(api, instId, i => i.ssh_enabled && i.ssh_host && i.ssh_port, 30, 'ssh', tag);
      if (!sshReady2 || sshReady2 === 'vast_detected') {
        logTag(tag, `⏰ SSH not ready → delete`);
        await api.deleteInstance(instId);
        continue;
      }
    } else if (!sshReady) {
      logTag(tag, `⏰ SSH timeout → delete`);
      await api.deleteInstance(instId);
      continue;
    }

    const sshHost = sshReady.ssh_host;
    const sshPort = sshReady.ssh_port;
    const totalTime = ((Date.now() - timerStart) / 1000).toFixed(0);
    logTag(tag, `✅ SSH: root@${sshHost} -p ${sshPort} (${totalTime}s)`);

    const worker = `rig${String(workerCounter).padStart(2, '0')}`;
    logTag(tag, `⛏️ Mining as ${worker}...`);

    const mined = deployMiner(sshHost, sshPort, wallet, pool, worker, isVast);
    if (mined) {
      logTag(tag, `🔥 MINING! ${gpu} → ${worker}`);
      logActive(account.email, account.password, instId, sshHost, sshPort, gpu, worker);
      return { success: true, workerCounter: workerCounter + 1 };
    }

    logTag(tag, `❌ Miner failed → delete`);
    await api.deleteInstance(instId);
  }

  logTag(tag, `❌ No GPU started`);
  return { success: false, workerCounter };
}

// ─── AUTO-DELETE PENDING INSTANCES (BACKGROUND) ────────────────
let cleanupRunning = false;
async function cleanupPendingInstances(accounts) {
  if (cleanupRunning) return;
  cleanupRunning = true;
  try {
    for (const account of accounts) {
      try {
        const api = new QuDataAPI();
        const ok = await api.login(account.email, account.password);
        if (!ok) continue;
        const instances = await api.getInstances();
        for (const inst of instances) {
          if (inst.status === 'pending') {
            const age = inst.created_at ? (Date.now() - new Date(inst.created_at).getTime()) / 1000 : 0;
            if (age > 30) {
              log(`🧹 [cleanup] ${account.email.substring(0,12)}.. pending ${age.toFixed(0)}s → delete`);
              await api.deleteInstance(inst.id);
            }
          }
        }
      } catch {}
    }
  } catch {}
  cleanupRunning = false;
}

// ─── MAIN ─────────────────────────────────────────────────────────
async function main() {
  const accountFile = path.resolve(accountsFile);
  const accounts = parseAccounts(accountFile);

  log('='.repeat(55));
  log('🎯 QuData GPU Sniper v4 (FULL PARALLEL)');
  log('='.repeat(55));
  log(`Accounts: ${accounts.length}`);
  log(`Wallet:   ${wallet.substring(0, 20)}...`);
  log(`Price:    $${priceMin}-$${priceMax}/hr`);
  log('='.repeat(55));

  let workerCounter = 1;
  let round = 0;

  // Background cleanup setiap 30 detik
  setInterval(() => cleanupPendingInstances(accounts), 30 * 1000);
  log('🧹 Auto-cleanup pending: aktif (tiap 30s)');

  while (true) {
    round++;
    log(`\n${'='.repeat(55)}`);
    log(`🚀 Round ${round} [${ts()}] — ${accounts.length} akun paralel!`);
    log('='.repeat(55));

    // Fetch offers sekali per round
    const sampleApi = new QuDataAPI();
    await sampleApi.login(accounts[0].email, accounts[0].password);
    const offers = await sampleApi.getOffersAll(priceMin, priceMax);
    log(`📦 ${offers.length} offers available`);

    if (!offers.length) {
      log('⏳ No offers. Tunggu 30s...');
      await sleep(30);
      continue;
    }

    // SEMUA AKUN BARENGAN — Promise.all!
    const tasks = accounts.map(account => 
      tryRentForAccount(account, offers, workerCounter)
        .then(result => {
          if (result.success) {
            workerCounter = result.workerCounter;
            log(`🎉 Mining aktif! Total: ${workerCounter - 1}`);
          }
          return result;
        })
        .catch(err => {
          log(`❌ ${account.email.substring(0,12)}.. error: ${err.message}`);
          return { success: false, workerCounter };
        })
    );

    await Promise.all(tasks);

    log(`\n⏳ Round ${round} selesai. Tunggu 10s...`);
    await sleep(10);
  }
}

main().catch(console.error);
