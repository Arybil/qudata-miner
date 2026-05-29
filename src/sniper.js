/**
 * QuData GPU Sniper
 *
 * Monitor marketplace terus-menerus. Kalau ada offer baru di range harga,
 * langsung beli + deploy miner.
 *
 * Usage:
 *   node src/sniper.js --email user@x.com --password pw123
 *   node src/sniper.js --email user@x.com --password pw123 --interval 5
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
  const result = { email: null, password: null, interval: 10 };
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--email' && args[i + 1]) result.email = args[++i];
    if (args[i] === '--password' && args[i + 1]) result.password = args[++i];
    if (args[i] === '--interval' && args[i + 1]) result.interval = parseInt(args[++i]);
  }
  return result;
}

// ─── POLL WITH TIMER ───────────────────────────────────────────────
async function pollUntil(api, instanceId, conditionFn, timeoutSec, label) {
  const start = Date.now();
  while ((Date.now() - start) / 1000 < timeoutSec) {
    const sec = ((Date.now() - start) / 1000).toFixed(0);
    try {
      const instances = await api.getInstances();
      const inst = instances.find(i => i.id === instanceId);
      if (!inst) { log(`      [${sec}s] [${label}] Instance gone!`); return null; }
      const status = inst.status || '';
      const msg = (inst.message || '').substring(0, 60);
      if (conditionFn(inst)) { log(`      [${sec}s] [${label}] ✅ Ready!`); return inst; }
      if (['error', 'failed', 'cancelled'].includes(status)) { log(`      [${sec}s] [${label}] ❌ ${status} ${msg}`); return null; }
      if (msg.includes('vast') || msg.includes('vastai')) { log(`      [${sec}s] [${label}] ⏭️ Vast.ai detected`); return 'vast_detected'; }
      log(`      [${sec}s] [${label}] ${status} ${msg}`);
    } catch (e) { log(`      [${sec}s] [${label}] Poll error: ${e.message}`); }
    await sleep(5);
  }
  log(`      [${((Date.now() - start) / 1000).toFixed(0)}s] [${label}] ⏰ Timeout ${timeoutSec}s`);
  return null;
}

// ─── SNIPER: BUY ONE OFFER ────────────────────────────────────────
async function snipeOffer(api, offer, keyId, workerCounter) {
  const price = offer.prices?.[0]?.amount || 0;
  const gpu = offer.gpu_name || '?';
  const offerId = offer.id;

  log(`\n🎯 SNIPE: ${gpu} @ $${price}/hr [${offerId.substring(0, 8)}]`);

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
    log(`   ⏭️  Vast.ai detected (will use extra SSH wait)`);
  }

  await api.attachSSHKey(instId, keyId);
  log(`   🔑 SSH key attached`);

  // Phase 1: Wait for running
  const running = await pollUntil(api, instId, i => i.status === 'running', 120, 'pending');
  if (running === 'vast_detected') {
    isVast = true;
    const running2 = await pollUntil(api, instId, i => i.status === 'running', 60, 'pending');
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

  // Phase 2: Wait for SSH
  const sshReady = await pollUntil(api, instId, i => i.ssh_enabled && i.ssh_host && i.ssh_port, sshTimeout, 'ssh');
  if (sshReady === 'vast_detected') {
    isVast = true;
    const sshReady2 = await pollUntil(api, instId, i => i.ssh_enabled && i.ssh_host && i.ssh_port, sshTimeout, 'ssh');
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

// ─── MAIN SNIPER LOOP ─────────────────────────────────────────────
async function main() {
  const args = parseArgs();
  if (!args.email || !args.password) {
    console.log('Usage: node src/sniper.js --email user@x.com --password pw123 [--interval 10]');
    return;
  }

  const interval = args.interval; // detik antar poll

  log('='.repeat(55));
  log('🎯 QuData GPU Sniper');
  log('='.repeat(55));
  log(`Account:  ${args.email}`);
  log(`Wallet:   ${wallet.substring(0, 20)}...`);
  log(`Price:    $${priceMin}-$${priceMax}/hr`);
  log(`Interval: ${interval}s`);
  log('='.repeat(55));

  const api = new QuDataAPI();
  const loggedIn = await api.login(args.email, args.password);
  if (!loggedIn) { log('❌ Login failed'); return; }

  const balance = await api.getBalance();
  log(`💰 Balance: $${balance.toFixed(3)} USDT`);

  const keyId = await api.ensureSSHKey(sshKeyName, sshPublicKey);
  if (!keyId) { log('❌ SSH key failed'); return; }

  let workerCounter = 1;
  const seenOffers = new Set(); // track offer udah pernah dicoba
  let round = 0;

  while (true) {
    round++;
    log(`\n--- Round ${round} [${ts()}] ---`);

    const balanceNow = await api.getBalance();
    log(`💰 Balance: $${balanceNow.toFixed(3)} USDT`);

    if (balanceNow < 0.05) {
      log('⚠️ Balance too low (< $0.05). Stopping.');
      break;
    }

    const offers = await api.getOffersAll(priceMin, priceMax);
    const newOffers = offers.filter(o => !seenOffers.has(o.id));

    log(`📦 ${offers.length} offers (${newOffers.length} new)`);

    if (!newOffers.length) {
      log(`⏳ No new offers. Next check in ${interval}s...`);
      await sleep(interval);
      continue;
    }

    // Coba beli offer baru
    for (const offer of newOffers) {
      seenOffers.add(offer.id);

      const price = offer.prices?.[0]?.amount || 0;
      const gpu = offer.gpu_name || '?';

      const result = await snipeOffer(api, offer, keyId, workerCounter);
      if (result.success) {
        workerCounter++;
        log(`🎉 Sniped! Total miners: ${workerCounter - 1}`);
      }

      // Refresh balance setelah beli
      const newBal = await api.getBalance();
      log(`💰 Balance after: $${newBal.toFixed(3)} USDT`);

      if (newBal < 0.05) {
        log('⚠️ Balance too low (< $0.05). Stopping.');
        return;
      }
    }

    log(`⏳ Next check in ${interval}s...`);
    await sleep(interval);
  }
}

main().catch(console.error);
