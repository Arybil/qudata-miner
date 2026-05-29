/**
 * Mining deployment via SSH
 */

const { execSync } = require('child_process');

function deployMiner(sshHost, sshPort, wallet, pool, workerName) {
  const sshBase = [
    'ssh',
    '-o', 'StrictHostKeyChecking=no',
    '-o', 'ConnectTimeout=15',
    '-o', 'UserKnownHostsFile=/dev/null',
    '-o', 'LogLevel=ERROR',
    '-p', String(sshPort),
    `root@${sshHost}`,
  ];

  // Test SSH (3 retries)
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const r = execSync([...sshBase, 'echo OK'].join(' '), {
        encoding: 'utf-8', timeout: 20000,
      });
      if (r.includes('OK')) break;
    } catch {
      if (attempt === 2) return false;
      execSync('sleep 5');
    }
  }

  // Deploy miner in tmux
  const poolHost = pool.replace('stratum+tcp://', '');
  const mineCmd = [
    'tmux new-session -d -s mine "',
    `curl -sL -o pearl-miner https://pearlhash.xyz/downloads/pearl-miner-v7 && `,
    `chmod +x pearl-miner && `,
    `./pearl-miner --host ${poolHost} --user ${wallet} --worker ${workerName}`,
    '"',
  ].join('');

  try {
    execSync([...sshBase, mineCmd].join(' '), {
      encoding: 'utf-8', timeout: 30000,
    });
  } catch { return false; }

  // Verify
  execSync('sleep 10');
  try {
    const output = execSync(
      [...sshBase, 'tmux capture-pane -t mine -p -S -20'].join(' '),
      { encoding: 'utf-8', timeout: 15000 }
    );
    if (/miner|hashrate|connecting|pool|AlphaMiner/i.test(output)) return true;
    const ls = execSync([...sshBase, 'tmux ls'].join(' '), {
      encoding: 'utf-8', timeout: 10000,
    });
    return ls.includes('mine');
  } catch { return true; }
}

module.exports = { deployMiner };
