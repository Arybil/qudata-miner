/**
 * QuData GPU Sniper v3 — Bulk Mode
 *
 * Monitor & rent untuk SEMUA akun di accounts.txt.
 * Monitor status tiap 1 detik.
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
async function pollStatus(api, instanceId, conditionFn, timeoutSec, label) {
  const start = Date.now();
  while ((Date.now() - start) / 1000 < timeoutSec) {
    const sec = ((Date.now() - start) / 1000).toFixed(0);
    try {
      const instances = await api.getInstances();
      const inst = instances.find(i => i.id === instanceId);

      if (!inst) {
        process.stdout.write(`\r      [${sec}s] [${label}] Instance gone!          `);
        return null;
      }

      const status = inst.status || '';
      const msg = (inst.message || '').substring(0, 40);
      const ssh = inst.ssh_enabled ? 'SSH:OK' : 'SSH:-';

      process.stdout.write(`\r      [${sec}s] [${label}] ${status} ${ssh} ${msg}      `);

      if (conditionFn(inst)) {
        console.log(`\n      [${sec}s] [${label}] ✅ Ready!`);
        return inst;
      }

      if (['error', 'failed', 'cancelled'].includes(status)) {
        console.log(`\n      [${sec}s] [${label}] ❌ ${status} ${msg}`);
        return null;
      }

      if (msg.includes('vast') || msg.includes('vastai')) {
        console.log(`\n      [${sec}s] [${label}] ⏭️ Vast.ai detected`);
        return 'vast_detected';
      }
    } catch {}

    await sleep(1);
  }

  console.log(`\n      [${((Date.now() - start) / 1000).toFixed(0)}s] [${label}] ⏰ Timeout ${timeoutSec}s`);
  return null;
}

// ─── RENT + MINE SATU AKUN ────────────────────────────────────────
async function tryRentForAccount(account, offers, workerCounter) {
  log(`\n${'─'.repeat(45)}`);
  log(`👤 ${account.email}`);

  const api = new QuDataAPI();
  const loggedIn = await api.login(account.email, account.password);
  if (!loggedIn) { log('   ❌ Login failed'); return { success: false, workerCounter }; }

  const balance = await api.getBalance();
  log(`   💰 $${balance.toFixed(3)} USDT`);

  if (balance < 0.05) { log('   ⏭️ Too low'); return { success: false, workerCounter }; }

  const keyId = await api.ensureSSHKey(sshKeyName, sshPublicKey);
  if (!keyId) { log('   ❌ SSH key failed'); return { success: false, workerCounter }; }

  // Clean existing instances
  const existing = await api.getInstances();
  if (existing.length) {
    log(`   🧹 Cleaning ${existing.length} instance(s)...`);
    for (const inst of existing) {
      await api.deleteInstance(inst.id);
    }
  }

  // Try offers
  for (const offer of offers) {
    const price = offer.prices?.[0]?.amount || 0;
    const gpu = offer.gpu_name || '?';
    const mins = price > 0 ? (balance / price * 60).toFixed(0) : '?';

    log(`   🎯 ${gpu} @ $${price}/hr (~${mins}min)`);

    const timerStart = Date.now();
    const instData = await api.createInstance(offer.id, deploymentType, storageGb, image);
    if (!instData || instData.error) {
      log(`      ❌ Create failed`);
      continue;
    }

    const instId = instData.id;
    log(`      📦 ${instId.substring(0, 16)}...`);

    let isVast = false;
    const instInfo = JSON.stringify(instData).toLowerCase();
    if (instInfo.includes('vast') || instInfo.includes('vastai')) {
      isVast = true;
      log(`      ⏭️ Vast.ai detected`);
    }

    await api.attachSSHKey(instId, keyId);
    log(`      🔑 SSH key attached`);

    // Monitor pending (1s interval)
    const running = await pollStatus(api, instId, i => i.status === 'running', 120, 'pending');

    if (running === 'vast_detected') {
      isVast = true;
      const running2 = await pollStatus(api, instId, i => i.status === 'running', 60, 'pending');
      if (!running2 || running2 === 'vast_detected') {
        log(`      ⏰ Not running → delete`);
        await api.deleteInstance(instId);
        continue;
      }
    } else if (!running) {
      log(`      ⏰ Timeout → delete`);
      await api.deleteInstance(instId);
      continue;
    }

    // Monitor SSH (1s interval)
    const sshReady = await pollStatus(api, instId, i => i.ssh_enabled && i.ssh_host && i.ssh_port, 30, 'ssh');

    if (sshReady === 'vast_detected') {
      isVast = true;
      const sshReady2 = await pollStatus(api, instId, i => i.ssh_enabled && i.ssh_host && i.ssh_port, 30, 'ssh');
      if (!sshReady2 || sshReady2 === 'vast_detected') {
        log(`      ⏰ SSH not ready → delete`);
        await api.deleteInstance(instId);
        continue;
      }
    } else if (!sshReady) {
      log(`      ⏰ SSH timeout → delete`);
      await api.deleteInstance(instId);
      continue;
    }

    const sshHost = sshReady.ssh_host;
    const sshPort = sshReady.ssh_port;
    const totalTime = ((Date.now() - timerStart) / 1000).toFixed(0);
    log(`      ✅ SSH: root@${sshHost} -p ${sshPort} (${totalTime}s)`);

    const worker = `rig${String(workerCounter).padStart(2, '0')}`;
    log(`      ⛏️ Mining as ${worker}...`);

    const mined = deployMiner(sshHost, sshPort, wallet, pool, worker, isVast);
    if (mined) {
      log(`      🔥 MINING! ${gpu} → ${worker}`);
      logActive(account.email, account.password, instId, sshHost, sshPort, gpu, worker);
      return { success: true, workerCounter: workerCounter + 1 };
    }

    log(`      ❌ Miner failed → delete`);
    await api.deleteInstance(instId);
  }

  log(`   ❌ No GPU started`);
  return { success: false, workerCounter };
}

// ─── MAIN ─────────────────────────────────────────────────────────
async function main() {
  const accountFile = path.resolve(accountsFile);
  const accounts = parseAccounts(accountFile);

  log('='.repeat(55));
  log('🎯 QuData GPU Sniper v3 (bulk)');
  log('='.repeat(55));
  log(`Accounts: ${accounts.length}`);
  log(`Wallet:   ${wallet.substring(0, 20)}...`);
  log(`Price:    $${priceMin}-$${priceMax}/hr`);
  log('='.repeat(55));

  let workerCounter = 1;
  let round = 0;

  while (true) {
    round++;
    log(`\n${'='.repeat(55)}`);
    log(`Round ${round} [${ts()}]`);
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

    // Try setiap akun
    for (const account of accounts) {
      const result = await tryRentForAccount(account, offers, workerCounter);
      if (result.success) {
        workerCounter = result.workerCounter;
        log(`🎉 Total miners: ${workerCounter - 1}`);
      }
    }

    log(`\n⏳ Round selesai. Tunggu 10s...`);
    await sleep(10);
  }
}

main().catch(console.error);
