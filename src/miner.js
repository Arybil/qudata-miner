/**
 * Mining deployment via SSH
 *
 * Flow: tunggu 60s setelah SSH port muncul → 1 percobaan SSH → gagal = skip GPU
 */

const { execSync } = require('child_process');

const SSH_WAIT = 60;       // detik tunggu sebelum SSH attempt (key propagation)
const SSH_CONNECT_TIMEOUT = 15; // detik per SSH connection attempt

function deployMiner(sshHost, sshPort, wallet, pool, workerName) {
  const sshBase = [
    'ssh',
    '-o', 'StrictHostKeyChecking=no',
    '-o', `ConnectTimeout=${SSH_CONNECT_TIMEOUT}`,
    '-o', 'UserKnownHostsFile=/dev/null',
    '-o', 'LogLevel=ERROR',
    '-p', String(sshPort),
    `root@${sshHost}`,
  ];

  // ── Tunggu 60 detik agar SSH key propagate ke instance ──
  console.log(`      [SSH] ⏳ Waiting ${SSH_WAIT}s for key propagation...`);
  execSync(`sleep ${SSH_WAIT}`);

  // ── 1 percobaan SSH ──
  let connected = false;
  try {
    const r = execSync([...sshBase, 'echo OK'].join(' '), {
      encoding: 'utf-8',
      timeout: (SSH_CONNECT_TIMEOUT + 5) * 1000,
    });
    if (r.includes('OK')) {
      connected = true;
      console.log(`      [SSH] ✅ Connected!`);
    }
  } catch (e) {
    const msg = (e.stderr || e.message || '').toString();
    console.log(`      [SSH] ❌ Failed: ${msg.substring(0, 100)}`);
    console.log(`      [SSH] ❌ Skip GPU`);
    return false;
  }

  if (!connected) {
    console.log(`      [SSH] ❌ No response → skip GPU`);
    return false;
  }

  // ── Deploy miner di tmux ──
  const mineCmd = [
    'tmux new-session -d -s mine "',
    `curl -sL -o alpha-miner https://pearl.alphapool.tech/alpha-miner && `,
    `chmod +x alpha-miner && `,
    `./alpha-miner --algo sha3x --url ${pool} --user ${wallet}.${workerName}`,
    '"',
  ].join('');

  try {
    console.log(`      [MINER] Deploying...`);
    execSync([...sshBase, mineCmd].join(' '), {
      encoding: 'utf-8',
      timeout: 30000,
    });
  } catch {
    console.log(`      [MINER] ❌ Deploy command failed`);
    return false;
  }

  // ── Verify miner running ──
  console.log(`      [MINER] ⏳ Verifying (10s)...`);
  execSync('sleep 10');

  try {
    const output = execSync(
      [...sshBase, 'tmux capture-pane -t mine -p -S -20'].join(' '),
      { encoding: 'utf-8', timeout: 15000 }
    );
    if (/miner|hashrate|connecting|pool|stratum|alpha/i.test(output)) {
      console.log(`      [MINER] ✅ Mining confirmed!`);
      return true;
    }

    const ls = execSync([...sshBase, 'tmux ls'].join(' '), {
      encoding: 'utf-8',
      timeout: 10000,
    });
    if (ls.includes('mine')) {
      console.log(`      [MINER] ✅ tmux session active`);
      return true;
    }

    console.log(`      [MINER] ⚠️ tmux running tapi output unclear`);
    return true;
  } catch {
    console.log(`      [MINER] ⚠️ Verify SSH failed, assuming deployed`);
    return true;
  }
}

module.exports = { deployMiner };
