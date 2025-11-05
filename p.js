const { ethers } = require('ethers');
const axios = require('axios');
const fs = require('fs-extra');
const { CookieJar } = require('tough-cookie');
const { SiweMessage } = require('siwe');
const { HttpsProxyAgent } = require('https-proxy-agent');

const API_BASE_URL = 'https://bff-root.superintent.ai/v1';
const PK_FILE = 'pk.txt';
const WALLETS_FILE = 'wallets.json';
const PROXY_FILE = 'proxies.txt';

const colors = {
  reset: "\x1b[0m", cyan: "\x1b[36m", green: "\x1b[32m",
  yellow: "\x1b[33m", red: "\x1b[31m", white: "\x1b[37m",
  bold: "\x1b[1m", magenta: "\x1b[35m",
};

const logger = {
  info: (msg) => console.log(`${colors.white}[✓] ${msg}${colors.reset}`),
  warn: (msg) => console.log(`${colors.yellow}[⚠] ${msg}${colors.reset}`),
  error: (msg) => console.log(`${colors.red}[✗] ${msg}${colors.reset}`),
  success: (msg) => console.log(`${colors.green}[✅] ${msg}${colors.reset}`),
  loading: (msg) => console.log(`${colors.cyan}[→] ${msg}${colors.reset}`),
  banner: () => {
    console.log(`${colors.cyan}${colors.bold}`);
    console.log(`--------------------------------------`);
    console.log(` Super Intent Daily Check-in Bot`);
    console.log(`--------------------------------------${colors.reset}`);
    console.log();
  }
};

const USER_AGENTS = [
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:125.0) Gecko/20100101 Firefox/125.0",
];

const getRandomUserAgent = () => {
  return USER_AGENTS[Math.floor(Math.random() * USER_AGENTS.length)];
};

const randomDelay = (minMs = 1000, maxMs = 3000) => {
  const ms = Math.floor(Math.random() * (maxMs - minMs + 1)) + minMs;
  return new Promise(resolve => setTimeout(resolve, ms));
};

const askQuestion = (query) => {
  const readline = require('readline');
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });
  return new Promise(resolve => rl.question(query, ans => {
    rl.close();
    resolve(ans);
  }));
};

// Load private keys from pk.txt
const loadPrivateKeys = async () => {
  try {
    const content = await fs.readFile(PK_FILE, 'utf8');
    const lines = content.split(/\r?\n/).map(line => line.trim()).filter(line => line && !line.startsWith('#'));
    
    if (lines.length === 0) {
      throw new Error('No private keys found in pk.txt');
    }
    
    logger.info(`Loaded ${lines.length} private key(s) from ${PK_FILE}`);
    return lines;
  } catch (err) {
    logger.error(`Failed to read ${PK_FILE}: ${err.message}`);
    throw err;
  }
};

// Load wallets from wallets.json
const loadWalletsJson = async () => {
  try {
    const wallets = await fs.readJson(WALLETS_FILE);
    
    if (!Array.isArray(wallets) || wallets.length === 0) {
      throw new Error('No wallets found in wallets.json');
    }
    
    const privateKeys = wallets.map(w => w.privateKey).filter(pk => pk);
    
    if (privateKeys.length === 0) {
      throw new Error('No valid private keys found in wallets.json');
    }
    
    logger.info(`Loaded ${privateKeys.length} private key(s) from ${WALLETS_FILE}`);
    return privateKeys;
  } catch (err) {
    logger.error(`Failed to read ${WALLETS_FILE}: ${err.message}`);
    throw err;
  }
};

// Choose source for private keys
const choosePrivateKeySource = async () => {
  console.log();
  console.log(`${colors.cyan}Select private key source:${colors.reset}`);
  console.log(`${colors.white}1.${colors.reset} Load from ${colors.magenta}pk.txt${colors.reset}`);
  console.log(`${colors.white}2.${colors.reset} Load from ${colors.magenta}wallets.json${colors.reset}`);
  console.log();
  
  const choice = await askQuestion(`${colors.yellow}[?] Enter your choice (1 or 2): ${colors.reset}`);
  
  if (choice === '1') {
    return await loadPrivateKeys();
  } else if (choice === '2') {
    return await loadWalletsJson();
  } else {
    logger.error('Invalid choice. Please enter 1 or 2.');
    process.exit(1);
  }
};

// Parse proxy line
function parseProxyLine(rawLine) {
  if (!rawLine) return null;
  let line = rawLine.trim();
  if (!line || line.startsWith('#') || line.startsWith('//')) return null;

  if (/^[a-zA-Z0-9]+:\/\//.test(line)) {
    return line;
  }

  const parts = line.split('@');
  let hostPortPart, authPart;

  if (parts.length === 1) {
    hostPortPart = parts[0];
    authPart = null;
  } else if (parts.length === 2) {
    const p0looksHostPort = /:\d+$/.test(parts[0]);
    const p1looksHostPort = /:\d+$/.test(parts[1]);

    if (p0looksHostPort && !p1looksHostPort) {
      hostPortPart = parts[0];
      authPart = parts[1];
    } else if (!p0looksHostPort && p1looksHostPort) {
      authPart = parts[0];
      hostPortPart = parts[1];
    } else {
      authPart = parts[0];
      hostPortPart = parts[1];
    }
  } else {
    return null;
  }

  if (!/:\d+$/.test(hostPortPart)) return null;

  const protocol = 'http://';
  if (authPart) {
    return `${protocol}${authPart}@${hostPortPart}`;
  } else {
    return `${protocol}${hostPortPart}`;
  }
}

// Load proxies
async function loadProxies() {
  let lines;
  try {
    const fileContent = await fs.readFile(PROXY_FILE, 'utf8');
    lines = fileContent.split(/\r?\n/);
  } catch (err) {
    logger.warn(`No ${PROXY_FILE} found. Continuing without proxies.`);
    return [];
  }

  const proxies = [];
  for (const rawLine of lines) {
    const url = parseProxyLine(rawLine);
    if (!url) continue;

    let noProto = url.replace(/^[a-zA-Z0-9]+:\/\//, '');
    const afterAt = noProto.split('@').pop();
    const hostMask = afterAt || 'unknown';

    proxies.push({ raw: rawLine.trim(), url, hostMask });
  }

  if (proxies.length === 0) {
    logger.warn(`No valid proxies found. Continuing without proxies.`);
  } else {
    logger.info(`Loaded ${proxies.length} proxy(ies) from ${PROXY_FILE}.`);
  }

  return proxies;
}

// Get proxy agent
function getProxyAgent(proxiesArr, index) {
  if (!Array.isArray(proxiesArr) || proxiesArr.length === 0) {
    return null;
  }

  const chosen = proxiesArr[index % proxiesArr.length];

  try {
    const agent = new HttpsProxyAgent(chosen.url);
    return {
      httpAgent: agent,
      httpsAgent: agent,
      usedProxy: chosen.hostMask,
    };
  } catch (err) {
    logger.warn(`Failed to create proxy agent: ${err.message}`);
    return null;
  }
}

// Create API client
function createApiClient(jar, proxyAgents) {
  const instance = axios.create({
    baseURL: API_BASE_URL,
    headers: {
      'Accept': 'application/json, text/plain, */*',
      'Accept-Language': 'en-US,en;q=0.6',
      'Origin': 'https://mission.superintent.ai',
      'Referer': 'https://mission.superintent.ai/',
      'User-Agent': getRandomUserAgent(),
      'Sec-Ch-Ua-Platform': '"Windows"',
      'Sec-Ch-Ua-Mobile': '?0',
      'Sec-Fetch-Dest': 'empty',
      'Sec-Fetch-Mode': 'cors',
      'Sec-Fetch-Site': 'same-site',
    },
    httpAgent: proxyAgents ? proxyAgents.httpAgent : undefined,
    httpsAgent: proxyAgents ? proxyAgents.httpsAgent : undefined,
    withCredentials: true,
    validateStatus: (s) => s >= 200 && s < 500,
  });

  instance.interceptors.request.use(async (config) => {
    try {
      const fullUrl = new URL(config.url, config.baseURL).toString();
      const cookieStr = await jar.getCookieString(fullUrl);
      if (cookieStr) {
        config.headers['Cookie'] = cookieStr;
      }
    } catch (err) {}
    return config;
  });

  instance.interceptors.response.use(async (response) => {
    const setCookie = response.headers['set-cookie'];
    if (setCookie && Array.isArray(setCookie)) {
      const fullUrl = new URL(response.config.url, response.config.baseURL).toString();
      for (const c of setCookie) {
        try {
          await jar.setCookie(c, fullUrl);
        } catch (err) {}
      }
    }
    return response;
  });

  return instance;
}

// Process wallet check-in
const processWalletCheckIn = async (wallet, proxyAgents) => {
  logger.info(`Processing wallet: ${wallet.address}`);

  const jar = new CookieJar();
  const client = createApiClient(jar, proxyAgents);

  if (proxyAgents) {
    logger.info(`Using proxy ${colors.magenta}${proxyAgents.usedProxy}${colors.reset}`);
  } else {
    logger.warn(`No proxy applied (direct connection).`);
  }

  try {
    // Step 1: Get nonce
    logger.loading('Getting nonce...');
    const nonceRes = await client.get('/auth/nonce');
    if (nonceRes.status >= 400) {
      throw new Error(`Nonce request failed: ${nonceRes.status}`);
    }
    const { nonce } = nonceRes.data || {};
    if (!nonce) throw new Error('Failed to get nonce');
    logger.success(`Got nonce: ${nonce}`);
    await randomDelay();

    // Step 2: Sign message with SIWE
    logger.loading('Signing message...');
    const siweMessage = new SiweMessage({
      domain: 'mission.superintent.ai',
      address: wallet.address,
      statement: "To securely sign in, please sign this message to verify you're the owner of this wallet.",
      uri: 'https://mission.superintent.ai',
      version: '1',
      chainId: 1,
      nonce: nonce,
      issuedAt: new Date().toISOString(),
    });

    const messageToSign = siweMessage.prepareMessage();
    const signature = await wallet.signMessage(messageToSign);

    // Step 3: Authenticate
    logger.loading('Authenticating...');
    const authPayload = {
      message: messageToSign,
      signature: signature
    };

    const authRes = await client.post('/auth/siwe', authPayload);
    if (authRes.status >= 400 || authRes.data?.success !== true) {
      throw new Error('Authentication failed');
    }

    const cookieStr = await jar.getCookieString(API_BASE_URL);
    if (!/si_token=/.test(cookieStr)) {
      throw new Error("Missing si_token cookie");
    }

    logger.success("Authentication successful!");
    await randomDelay();

    // Step 4: Check current status
    logger.loading('Checking check-in status...');
    const statusRes = await client.get('/check-in/status');
    if (statusRes.status >= 400) {
      throw new Error(`Failed to get check-in status: ${statusRes.status}`);
    }

    const { hasCheckedInToday, currentStreak, totalPoints } = statusRes.data || {};
    
    if (hasCheckedInToday) {
      logger.warn(`Already checked in today!`);
      logger.info(`Current Streak: ${colors.cyan}${currentStreak}${colors.reset}`);
      logger.info(`Total Check-in Points: ${colors.green}${totalPoints}${colors.reset}`);
    } else {
      // Step 5: Perform check-in
      logger.loading('Performing daily check-in...');
      const checkInRes = await client.post('/check-in');
      
      if (checkInRes.status >= 400 || checkInRes.data?.success !== true) {
        throw new Error('Check-in failed');
      }

      const pointsGranted = checkInRes.data?.pointsGranted || 0;
      logger.success(`Check-in successful! Points granted: ${colors.green}${pointsGranted}${colors.reset}`);
      await randomDelay();
    }

    // Step 6: Get final stats
    logger.loading('Fetching account stats...');
    const statsRes = await client.get('/me/stats');
    if (statsRes.status >= 400) {
      throw new Error('Failed to get stats');
    }

    const stats = statsRes.data || {};
    logger.success(`Wallet ${wallet.address} processed!`);
    logger.info(`Total Points: ${colors.green}${stats.totalPoints || 0}${colors.reset}`);
    logger.info(`Referral Code: ${colors.magenta}${stats.referralCode || 'N/A'}${colors.reset}`);
    logger.info(`Referred By: ${stats.referredBy || 'N/A'}`);
    logger.info(`Referral Count: ${stats.referralCount || 0}`);

  } catch (err) {
    logger.error(`Failed to process wallet ${wallet.address}: ${err.message}`);
    if (err.response?.data) {
      logger.error(`Response: ${JSON.stringify(err.response.data)}`);
    }
  }
};

// Main function
const main = async () => {
  logger.banner();

  try {
    // Choose and load private keys
    const privateKeys = await choosePrivateKeySource();
    
    // Load proxies
    const proxiesArr = await loadProxies();

    logger.info(`Will process ${privateKeys.length} wallet(s).`);
    console.log('--------------------------------------');

    for (let i = 0; i < privateKeys.length; i++) {
      logger.info(`${colors.bold}--- Wallet ${i + 1} of ${privateKeys.length} ---${colors.reset}`);

      try {
        // Create wallet from private key
        const wallet = new ethers.Wallet(privateKeys[i]);
        
        // Get proxy agent
        const proxyAgents = getProxyAgent(proxiesArr, i);

        // Process wallet
        await processWalletCheckIn(wallet, proxyAgents);

        logger.info(`${colors.bold}--- Finished Wallet ${i + 1} ---${colors.reset}`);

        // Delay between wallets
        if (i < privateKeys.length - 1) {
          const breakTime = Math.floor(Math.random() * 10) + 5;
          logger.loading(`Taking a ${breakTime} second break...`);
          await randomDelay(breakTime * 1000, breakTime * 1000);
        }
      } catch (err) {
        logger.error(`Error with wallet ${i + 1}: ${err.message}`);
      }
    }

    logger.success('All wallets have been processed!');
  } catch (err) {
    logger.error(`Critical error: ${err.message}`);
  }
};

main().catch(err => {
  logger.error(`Unexpected error: ${err.message}`);
});
