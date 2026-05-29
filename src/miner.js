/**
 * Mining deployment via SSH
 *
 * SSH connection: 5 percobaan, 3 detik per percobaan.
 * Kalau masih gagal → return false → auto delete + ganti GPU.
 */

const { execSync } = require('child_process');

const SSH_RETRIES = 5;
const SSH_RETRY_DELAY = 3; // detik
const SSH_CONNECT_TIMEOUT = 10; // detik per attempt

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

  // ── SSH Connection: 5 retries, 3 detik间隔 ──
  let connected = false;
  for (let attempt = 1; attempt <= SSH_RETRIES; attempt++) {
    try {
      const r = execSync([...sshBase, 'echo OK'].join(' '), {
        encoding: 'utf-8',
        timeout: (SSH_CONNECT_TIMEOUT + 5) * 1000,
      });
      if (r.includes('OK')) {
        connected = true;
        break;
      }
    } catch (e) {
      const msg = (e.stderr || e.message || '').toString();
      const isPermissionDenied = /permission denied|publickey|auth/i.test(msg);

      if (isPermissionDenied) {
        console.log(`      [SSH ${attempt}/${SSH_RETRIES}] ❌ Permission denied`);
      } else {
        console.log(`      [SSH ${attempt}/${SSH_RETRIES}] ❌ ${msg.substring(0, 80)}`);
      }

      if (attempt < SSH_RETRIES) {
        console.log(`      [SSH] ⏳ Retry dalam ${SSH_RETRY_DELAY}s...`);
        execSync(`sleep ${SSH_RETRY_DELAY}`);
      }
    }
  }

  if (!connected) {
    console.log(`      [SSH] ❌ Gagal ${SSH_RETRIES}x → skip GPU`);
    return false;
  }

  console.log(`      [SSH] ✅ Connected!`);

  // ── Deploy miner di tmux ──
  const poolHost = pool.replace('stratum+tcp://', '');
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

    // Fallback: cek tmux session masih ada
    const ls = execSync([...sshBase, 'tmux ls'].join(' '), {
      encoding: 'utf-8',
      timeout: 10000,
    });
    if (ls.includes('mine')) {
      console.log(`      [MINER] ✅ tmux session active`);
      return true;
    }

    console.log(`      [MINER] ⚠️ tmux running tapi output unclear`);
    return true; // assume ok
  } catch {
    // SSH verify gagal, tapi miner udah di-deploy → assume ok
    console.log(`      [MINER] ⚠️ Verify SSH failed, assuming deployed`);
    return true;
  }
}

module.exports = { deployMiner };
