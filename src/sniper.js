/**
 * QuData GPU Sniper v2
 *
 * Monitor RENT status tiap 1 detik. Bukan marketplace.
 * Terus coba create instance dari offers yang ada, monitor status real-time.
 *
 * Usage:
 *   node src/sniper.js --email user@x.com --password pw123
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
  priceMin, priceMax, balanceMin,
  sshTimeout, activeLog,
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

// ─── PARSE ARGS ────────────────────────────────────────────────────
function parseArgs() {
  const args = process.argv.slice(2);
  const result = { email: null, password: null };
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--email' && args[i + 1]) result.email = args[++i];
    if (args[i] === '--password' && args[i + 1]) result.password = args[++i];
  }
  return result;
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
        process.stdout.write(`\r      [${sec}s] [${label}] Instance gone!`);
        return null;
      }

      const status = inst.status || '';
      const msg = (inst.message || '').substring(0, 50);
      const ssh = inst.ssh_enabled ? 'SSH:OK' : 'SSH:-';

      process.stdout.write(`\r      [${sec}s] [${label}] ${status} ${ssh} ${msg}    `);

      if (conditionFn(inst)) {
        console.log(`\n      [${sec}s] [${label}] ✅ Ready!`);
        return inst;
      }

      if (['error', 'failed', 'cancelled'].includes(status)) {
        console.log(`\n      [${sec}s] [${label}] ❌ ${status} ${msg}`);
        return null;
      }

      // Cek vast.ai di message
      if (msg.includes('vast') || msg.includes('vastai')) {
        console.log(`\n      [${sec}s] [${label}] ⏭️ Vast.ai detected`);
        return 'vast_detected';
      }
    } catch (e) {
      // silent retry
    }

    await sleep(1); // tiap 1 detik
  }

  console.log(`\n      [${((Date.now() - start) / 1000).toFixed(0)}s] [${label}] ⏰ Timeout ${timeoutSec}s`);
  return null;
}

// ─── RENT + MINE SATU OFFER ───────────────────────────────────────
async function tryRent(api, offer, keyId, workerCounter) {
  const price = offer.prices?.[0]?.amount || 0;
  const gpu = offer.gpu_name || '?';
  const offerId = offer.id;
  const mins = price > 0 ? (0.30 / price * 60).toFixed(0) : '?';

  log(`\n🎯 ${gpu} @ $${price}/hr (~${mins}min) [${offerId.substring(0, 8)}]`);

  const timerStart = Date.now();
  const instData = await api.createInstance(offerId, deploymentType, storageGb, image);
  if (!instData || instData.error) {
    log(`   ❌ Create failed`);
    return { success: false };
  }

  const instId = instData.id;
  log(`   📦 ${instId.substring(0, 16)}...`);

  // Cek vast.ai
  let isVast = false;
  const instInfo = JSON.stringify(instData).toLowerCase();
  if (instInfo.includes('vast') || instInfo.includes('vastai')) {
    isVast = true;
    log(`   ⏭️  Vast.ai detected`);
  }

  await api.attachSSHKey(instId, keyId);
  log(`   🔑 SSH key attached`);

  // Phase 1: Monitor running (tiap 1 detik)
  const running = await pollStatus(api, instId, i => i.status === 'running', 120, 'pending');

  if (running === 'vast_detected') {
    isVast = true;
    log(`   ⏭️  Vast.ai - tunggu running...`);
    const running2 = await pollStatus(api, instId, i => i.status === 'running', 60, 'pending');
    if (!running2 || running2 === 'vast_detected') {
      log(`   ⏰ Still not running → delete`);
      await api.deleteInstance(instId);
      return { success: false };
    }
  } else if (!running) {
    log(`   ⏰ Pending timeout → delete`);
    await api.deleteInstance(instId);
    return { success: false };
  }

  // Phase 2: Monitor SSH port (tiap 1 detik)
  const sshReady = await pollStatus(api, instId, i => i.ssh_enabled && i.ssh_host && i.ssh_port, sshTimeout, 'ssh');

  if (sshReady === 'vast_detected') {
    isVast = true;
    const sshReady2 = await pollStatus(api, instId, i => i.ssh_enabled && i.ssh_host && i.ssh_port, sshTimeout, 'ssh');
    if (!sshReady2 || sshReady2 === 'vast_detected') {
      log(`   ⏰ SSH not ready → delete`);
      await api.deleteInstance(instId);
      return { success: false };
    }
  } else if (!sshReady) {
    log(`   ⏰ SSH timeout → delete`);
    await api.deleteInstance(instId);
    return { success: false };
  }

  const sshHost = sshReady.ssh_host;
  const sshPort = sshReady.ssh_port;
  const totalTime = ((Date.now() - timerStart) / 1000).toFixed(0);
  log(`   ✅ SSH: root@${sshHost} -p ${sshPort} (${totalTime}s total)`);

  // Deploy miner
  const worker = `rig${String(workerCounter).padStart(2, '0')}`;
  log(`   ⛏️  Mining as ${worker}${isVast ? ' (vast.ai)' : ''}...`);

  const mined = deployMiner(sshHost, sshPort, wallet, pool, worker, isVast);
  if (mined) {
    log(`   🔥 MINING ACTIVE! ${gpu} → ${worker}`);
    logActive(null, null, instId, sshHost, sshPort, gpu, worker);
    return { success: true };
  }

  log(`   ❌ Miner deploy failed → delete`);
  await api.deleteInstance(instId);
  return { success: false };
}

// ─── MAIN LOOP ────────────────────────────────────────────────────
async function main() {
  const args = parseArgs();
  if (!args.email || !args.password) {
    console.log('Usage: node src/sniper.js --email user@x.com --password pw123');
    return;
  }

  log('='.repeat(55));
  log('🎯 QuData GPU Sniper v2 (rent monitor 1s)');
  log('='.repeat(55));
  log(`Account:  ${args.email}`);
  log(`Wallet:   ${wallet.substring(0, 20)}...`);
  log(`Price:    $${priceMin}-$${priceMax}/hr`);
  log('='.repeat(55));

  const api = new QuDataAPI();
  const loggedIn = await api.login(args.email, args.password);
  if (!loggedIn) { log('❌ Login failed'); return; }

  const balance = await api.getBalance();
  log(`💰 Balance: $${balance.toFixed(3)} USDT`);

  const keyId = await api.ensureSSHKey(sshKeyName, sshPublicKey);
  if (!keyId) { log('❌ SSH key failed'); return; }

  // Clean existing instances
  log('🧹 Cleaning existing instances...');
  const existing = await api.getInstances();
  for (const inst of existing) {
    log(`   🗑️ Delete ${inst.id?.substring(0, 12)}... (${inst.status})`);
    await api.deleteInstance(inst.id);
  }

  let workerCounter = 1;
  let round = 0;

  while (true) {
    round++;
    log(`\n--- Round ${round} [${ts()}] ---`);

    const balanceNow = await api.getBalance();
    log(`💰 Balance: $${balanceNow.toFixed(3)} USDT`);

    if (balanceNow < 0.05) {
      log('⚠️ Balance too low (< $0.05). Tunggu 60s...');
      await sleep(60);
      continue;
    }

    // Fetch offers
    const offers = await api.getOffersAll(priceMin, priceMax);
    log(`📦 ${offers.length} offers available`);

    if (!offers.length) {
      log('⏳ No offers. Tunggu 30s...');
      await sleep(30);
      continue;
    }

    // Coba semua offers
    for (const offer of offers) {
      const price = offer.prices?.[0]?.amount || 0;

      // Cek balance cukup (minimal 1 menit billing)
      const minCost = price / 60; // cost per menit
      if (balanceNow < minCost) {
        continue; // skip, balance nggak cukup bahkan 1 menit
      }

      const result = await tryRent(api, offer, keyId, workerCounter);
      if (result.success) {
        workerCounter++;
        log(`🎉 Total miners: ${workerCounter - 1}`);

        // Refresh balance
        const newBal = await api.getBalance();
        log(`💰 Balance: $${newBal.toFixed(3)} USDT`);
        break; // keluar dari loop offers, mulai round baru
      }
    }

    log(`⏳ Next round in 5s...`);
    await sleep(5);
  }
}

main().catch(console.error);
