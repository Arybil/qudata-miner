/**
 * QuData Miner Bot — Main Entry
 *
 * Usage:
 *   node src/index.js                                    # bulk: semua akun di accounts.txt
 *   node src/index.js --email user@x.com --password pw   # single akun
 *   node src/index.js --check                            # cek balance semua akun
 *   node src/index.js --check --email user@x.com         # cek balance 1 akun
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
  deploymentType, storageGb,
  priceMin, priceMax, balanceMin,
  pendingTimeout, sshTimeout, instanceDelay,
  activeLog, accountsFile,
} = config;

// ─── HELPERS ───────────────────────────────────────────────────────
function ts() {
  return new Date().toLocaleTimeString('en-GB', { hour12: false });
}

function log(msg) {
  console.log(`[${ts()}] ${msg}`);
}

function elapsed(startMs) {
  return ((Date.now() - startMs) / 1000).toFixed(0);
}

function parseAccounts(filePath) {
  const content = fs.readFileSync(filePath, 'utf-8');
  const accounts = [];
  for (const line of content.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#') || trimmed.startsWith('===') || trimmed.startsWith('Username:') || trimmed.startsWith('Email:') || trimmed.startsWith('Password:')) continue;
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

function loadProcessed() {
  const processed = new Set();
  try {
    const lines = fs.readFileSync(activeLog, 'utf-8').split('\n');
    for (const line of lines) {
      const parts = line.trim().split('|');
      if (parts[0]) processed.add(parts[0]);
    }
  } catch {}
  return processed;
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

function sleep(seconds) {
  return new Promise(resolve => setTimeout(resolve, seconds * 1000));
}

// ─── PARSE CLI ARGS ────────────────────────────────────────────────
function parseArgs() {
  const args = process.argv.slice(2);
  const result = {
    check: args.includes('--check'),
    email: null,
    password: null,
    accountFile: null,
  };

  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--email' && args[i + 1]) result.email = args[++i];
    if (args[i] === '--password' && args[i + 1]) result.password = args[++i];
    if (!args[i].startsWith('--') && fs.existsSync(args[i])) {
      result.accountFile = args[i];
    }
  }

  return result;
}

// ─── POLL WITH REAL-TIME TIMER ─────────────────────────────────────
async function pollUntil(api, instanceId, conditionFn, timeoutSec, label) {
  const start = Date.now();

  while ((Date.now() - start) / 1000 < timeoutSec) {
    const sec = elapsed(start);

    try {
      const instances = await api.getInstances();
      const inst = instances.find(i => i.id === instanceId);

      if (!inst) {
        log(`      [${sec}s] [${label}] Instance gone!`);
        return null;
      }

      const status = inst.status || '';
      const msg = (inst.message || '').substring(0, 60);

      if (conditionFn(inst)) {
        log(`      [${sec}s] [${label}] ✅ Ready!`);
        return inst;
      }

      if (['error', 'failed', 'cancelled'].includes(status)) {
        log(`      [${sec}s] [${label}] ❌ ${status} ${msg}`);
        return null;
      }

      log(`      [${sec}s] [${label}] ${status} ${msg}`);
    } catch (e) {
      log(`      [${sec}s] [${label}] Poll error: ${e.message}`);
    }

    await sleep(10);
  }

  log(`      [${elapsed(start)}s] [${label}] ⏰ Timeout ${timeoutSec}s`);
  return null;
}

// ─── RENT + MINE ONE ACCOUNT ───────────────────────────────────────
async function processAccount(account, offers, workerCounter) {
  log(`\n${'─'.repeat(55)}`);
  log(`Account: ${account.email}`);

  const api = new QuDataAPI();
  const loggedIn = await api.login(account.email, account.password);
  if (!loggedIn) {
    log('   ❌ Login failed');
    return { success: false, workerCounter };
  }

  const balance = await api.getBalance();
  log(`   💰 Balance: $${balance.toFixed(3)} USDT`);
  if (balance < balanceMin) {
    log(`   ⏭️  Balance too low (need $${balanceMin})`);
    return { success: false, workerCounter };
  }

  const keyId = await api.ensureSSHKey(sshKeyName, sshPublicKey);
  if (!keyId) {
    log('   ❌ SSH key failed');
    return { success: false, workerCounter };
  }

  // Filter offers by balance
  const affordable = offers.filter(o => (o.prices?.[0]?.amount || 0) <= balance);
  const skipped = offers.length - affordable.length;
  if (skipped > 0) log(`   ⏭️  ${skipped} offers skipped (price > balance)`);

  if (!affordable.length) {
    log('   ❌ No affordable offers');
    return { success: false, workerCounter };
  }

  let attempt = 0;
  for (const offer of affordable) {
    attempt++;
    const price = offer.prices?.[0]?.amount || 0;
    const gpu = offer.gpu_name || '?';
    const offerId = offer.id;
    const durationMin = price > 0 ? (balance / price) * 60 : 0;

    log(`\n   [${attempt}/${affordable.length}] 🎮 ${gpu} @ $${price}/hr (~${durationMin.toFixed(0)}min)`);

    await sleep(instanceDelay);

    const timerStart = Date.now();
    const instData = await api.createInstance(offerId, deploymentType, storageGb);
    if (!instData) {
      log(`      ❌ Create failed → next GPU`);
      continue;
    }

    const instId = instData.id;
    log(`      📦 ${instId.substring(0, 16)}...`);

    await api.attachSSHKey(instId, keyId);
    log(`      🔑 SSH key attached`);

    // Phase 1: Wait for running
    const running = await pollUntil(
      api, instId,
      i => i.status === 'running',
      pendingTimeout, 'pending'
    );
    if (!running) {
      log(`      ⏰ Pending timeout → cancel`);
      await api.deleteInstance(instId);
      continue;
    }

    // Phase 2: Wait for SSH
    const sshReady = await pollUntil(
      api, instId,
      i => i.ssh_enabled && i.ssh_host && i.ssh_port,
      sshTimeout, 'ssh'
    );
    if (!sshReady) {
      log(`      ⏰ SSH timeout → cancel`);
      await api.deleteInstance(instId);
      continue;
    }

    const sshHost = sshReady.ssh_host;
    const sshPort = sshReady.ssh_port;
    const totalTime = ((Date.now() - timerStart) / 1000).toFixed(0);
    log(`      ✅ SSH: root@${sshHost} -p ${sshPort} (${totalTime}s total)`);

    // Deploy miner
    const worker = `rig${String(workerCounter).padStart(2, '0')}`;
    log(`      ⛏️  Mining as ${worker}...`);

    const mined = deployMiner(sshHost, sshPort, wallet, pool, worker);
    if (mined) {
      log(`      🔥 MINING ACTIVE! ${gpu} → ${worker}`);
      logActive(
        account.email, account.password,
        instId, sshHost, sshPort, gpu, worker
      );
      return { success: true, workerCounter: workerCounter + 1 };
    }

    log(`      ❌ Miner deploy failed → cancel`);
    await api.deleteInstance(instId);
  }

  log('   ❌ No GPU started');
  return { success: false, workerCounter };
}

// ─── CHECK BALANCES ────────────────────────────────────────────────
async function checkBalances(accounts) {
  log(`Checking balances for ${accounts.length} accounts...`);
  const funded = [];

  for (let i = 0; i < accounts.length; i++) {
    const acc = accounts[i];
    const api = new QuDataAPI();
    const ok = await api.login(acc.email, acc.password);

    if (!ok) {
      console.log(`  [${i + 1}] ${acc.email.padEnd(40)} LOGIN FAILED`);
      continue;
    }

    const bal = await api.getBalance();
    const status = bal >= balanceMin ? '✅ FUNDED' : '❌ low';
    console.log(`  [${i + 1}] ${acc.email.padEnd(40)} $${bal.toFixed(3)}  ${status}`);

    if (bal >= balanceMin) funded.push({ acc, bal });
    await sleep(1);
  }

  console.log(`\nFunded: ${funded.length}/${accounts.length}`);
}

// ─── MAIN ──────────────────────────────────────────────────────────
async function main() {
  const args = parseArgs();

  // ── Single account mode ──
  if (args.email && args.password) {
    const account = {
      email: args.email,
      password: args.password,
    };

    log('='.repeat(55));
    log('QuData Auto-Rent + Mining Bot (single account)');
    log('='.repeat(55));
    log(`Account:    ${account.email}`);
    log(`Wallet:     ${wallet.substring(0, 20)}...`);
    log(`Pool:       ${pool}`);
    log(`Price:      $${priceMin}-$${priceMax}/hr`);
    log('='.repeat(55));

    if (args.check) {
      await checkBalances([account]);
      return;
    }

    // Fetch offers
    log('Fetching GPU offers...');
    const sampleApi = new QuDataAPI();
    await sampleApi.login(account.email, account.password);
    const allOffers = await sampleApi.getOffersAll(priceMin, priceMax);
    const offers = allOffers.filter(o => {
      const price = o.prices?.[0]?.amount || 0;
      return price <= balance;
    });

    log(`Found ${allOffers.length} offers in range $${priceMin}-$${priceMax}`);
    log(`${offers.length} affordable with $${balance.toFixed(2)} balance`);
    for (const o of allOffers) {
      const gpu = o.gpu_name || '?';
      const price = o.prices?.[0]?.amount || 0;
      const affordable = price <= balance ? '✅' : '⏭️';
      log(`   ${affordable} ${gpu.padEnd(25)} $${price.toFixed(2)}/hr`);
    }

    const result = await processAccount(account, offers, 1);

    log(`\n${'='.repeat(55)}`);
    if (result.success) {
      log('🎉 SUCCESS! Miner is running.');
    } else {
      log('❌ Failed to start mining.');
    }
    log('='.repeat(55));
    return;
  }

  // ── Bulk mode (accounts.txt) ──
  const accountFile = path.resolve(args.accountFile || accountsFile);
  const accounts = parseAccounts(accountFile);

  if (!accounts.length) {
    log(`No accounts found in ${accountFile}`);
    return;
  }

  if (args.check) {
    await checkBalances(accounts);
    return;
  }

  const processed = loadProcessed();
  const pending = accounts.filter(a => !processed.has(a.email));

  log('='.repeat(55));
  log('QuData Auto-Rent + Mining Bot (bulk mode)');
  log('='.repeat(55));
  log(`Total accounts:  ${accounts.length}`);
  log(`Already active:  ${processed.size}`);
  log(`Pending:         ${pending.length}`);
  log(`Wallet:          ${wallet.substring(0, 20)}...`);
  log(`Pool:            ${pool}`);
  log(`Price:           $${priceMin}-$${priceMax}/hr`);
  log('='.repeat(55));

  if (!pending.length) {
    log('Nothing to do!');
    return;
  }

  // Fetch offers
  log('Fetching GPU offers...');
  const sampleApi = new QuDataAPI();
  await sampleApi.login(pending[0].email, pending[0].password);
  const allOffers = await sampleApi.getOffersAll(priceMin, priceMax);

  log(`Found ${allOffers.length} rentable offers ($${priceMin}-$${priceMax}/hr):`);
  for (const o of allOffers) {
    const gpu = o.gpu_name || '?';
    const price = o.prices?.[0]?.amount || 0;
    const provider = o.provider?.name || '?';
    log(`   ${gpu.padEnd(25)} $${price.toFixed(2)}/hr  (${provider})`);
  }

  if (!allOffers.length) {
    log('No rentable offers found!');
    return;
  }

  let workerCounter = processed.size + 1;
  let success = 0;
  let failed = 0;

  for (let i = 0; i < pending.length; i++) {
    log(`\n[${i + 1}/${pending.length}] Processing...`);
    const result = await processAccount(pending[i], allOffers, workerCounter);
    if (result.success) {
      success++;
      workerCounter = result.workerCounter;
    } else {
      failed++;
    }
  }

  log(`\n${'='.repeat(55)}`);
  log(`Done! Success: ${success} | Failed: ${failed} | Total: ${pending.length}`);
  log(`Active log: ${activeLog}`);
  log('='.repeat(55));
}

main().catch(console.error);
